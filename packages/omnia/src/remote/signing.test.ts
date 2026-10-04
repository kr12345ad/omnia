import { describe, expect, test } from "bun:test"
import { createPrivateKey, createPublicKey } from "node:crypto"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { RemoteKeyPair } from "./keys"
import { createRemoteKeyPair, fileRemoteKeyStorage, loadOrCreateRemoteKeyPair } from "./keys"
import {
  REMOTE_KEY_ID_HEADER,
  REMOTE_SIGNATURE_HEADER,
  REMOTE_TIMESTAMP_HEADER,
  hashRemoteBody,
  remoteAuthHeaders,
  remoteRequestDigest,
  remoteRequestPath,
  signRemoteRequest,
  verifyRemoteSignature,
} from "./signing"

const request = {
  method: "POST",
  path: "/v1/computers/remote-1/remote/results?wait=0",
  timestampMs: 1_000,
  body: JSON.stringify({ id: "cmd-1", ok: true }),
}

describe("remote request signing", () => {
  test("signs a canonical digest and verifies it", () => {
    const keys = createRemoteKeyPair()
    const signature = signRemoteRequest(keys.privateKey, request)
    expect(remoteRequestDigest(request)).toBe(
      `POST\n/v1/computers/remote-1/remote/results?wait=0\n1000\n${hashRemoteBody(request.body)}`,
    )
    expect(verifyRemoteSignature(keys.publicKey, { ...request, signature })).toBe(true)
  })

  test("rejects a tampered method, path, timestamp, body, or signature", () => {
    const keys = createRemoteKeyPair()
    const signature = signRemoteRequest(keys.privateKey, request)
    expect(verifyRemoteSignature(keys.publicKey, { ...request, method: "GET", signature })).toBe(false)
    expect(verifyRemoteSignature(keys.publicKey, { ...request, path: "/v1/computers/remote-1/remote/bye", signature })).toBe(false)
    expect(verifyRemoteSignature(keys.publicKey, { ...request, timestampMs: 1_001, signature })).toBe(false)
    expect(verifyRemoteSignature(keys.publicKey, { ...request, body: JSON.stringify({ id: "cmd-2" }), signature })).toBe(false)
    const tampered = Buffer.from(signature, "base64")
    tampered[0] = (tampered[0] ?? 0) ^ 0xff
    expect(verifyRemoteSignature(keys.publicKey, { ...request, signature: tampered.toString("base64") })).toBe(false)
    expect(verifyRemoteSignature(keys.publicKey, { ...request, signature: "not-base64" })).toBe(false)
  })

  test("rejects a signature made by another key", () => {
    const keys = createRemoteKeyPair()
    const other = createRemoteKeyPair()
    const signature = signRemoteRequest(other.privateKey, request)
    expect(verifyRemoteSignature(keys.publicKey, { ...request, signature })).toBe(false)
  })

  test("accepts KeyObject keys and empty bodies", () => {
    const keys = createRemoteKeyPair()
    const privateKey = createPrivateKey({ key: keys.privateKey, format: "jwk" })
    const publicKey = createPublicKey({ key: keys.publicKey, format: "jwk" })
    const empty = { method: "GET", path: "/v1/computers/remote-1/remote/commands?wait=0", timestampMs: 2_000 }
    const signature = signRemoteRequest(privateKey, empty)
    expect(verifyRemoteSignature(publicKey, { ...empty, signature })).toBe(true)
    expect(hashRemoteBody(undefined)).toBe(hashRemoteBody(""))
  })

  test("keeps the query string in the signed path", () => {
    expect(remoteRequestPath("http://127.0.0.1:4123/v1/computers/remote-1/remote/commands?wait=25000")).toBe(
      "/v1/computers/remote-1/remote/commands?wait=25000",
    )
  })

  test("builds headers that verify as a request", () => {
    const keys = createRemoteKeyPair()
    const headers = remoteAuthHeaders({
      token: "token-1",
      computerId: "remote-1",
      method: "POST",
      url: "http://127.0.0.1:4123/v1/computers/remote-1/remote/results",
      timestampMs: 3_000,
      keys: keys.privateKey,
      body: request.body,
    })
    expect(headers.authorization).toBe("Bearer token-1")
    expect(headers[REMOTE_KEY_ID_HEADER]).toBe("remote-1")
    expect(headers[REMOTE_TIMESTAMP_HEADER]).toBe("3000")
    expect(
      verifyRemoteSignature(keys.publicKey, {
        method: "POST",
        path: "/v1/computers/remote-1/remote/results",
        timestampMs: 3_000,
        body: request.body,
        signature: headers[REMOTE_SIGNATURE_HEADER]!,
      }),
    ).toBe(true)
  })
})

describe("remote key storage", () => {
  test("creates a pair on first use and reuses it later", async () => {
    let stored: RemoteKeyPair | undefined
    const storage = {
      load: () => stored,
      save: (keys: RemoteKeyPair) => {
        stored = keys
      },
    }
    const first = await loadOrCreateRemoteKeyPair(storage)
    const second = await loadOrCreateRemoteKeyPair(storage)
    expect(first.privateKey.d).toBeString()
    expect(second).toEqual(first)
    expect(stored).toEqual(first)
  })

  test("round-trips a pair through a key file", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "omnia-remote-key-")), "remote-key.json")
    const keys = await loadOrCreateRemoteKeyPair(fileRemoteKeyStorage(file))
    expect(await fileRemoteKeyStorage(file).load()).toEqual(keys)
  })

  test("refuses to rotate a corrupt key file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnia-remote-key-"))
    const file = join(dir, "remote-key.json")
    await Bun.write(file, "{ not json")
    const storage = fileRemoteKeyStorage(file)
    // Regenerating here would hand the computer a new key that every already
    // paired server still pins the old one of, so the damage is refused.
    expect(() => storage.load()).toThrow()
    await expect(loadOrCreateRemoteKeyPair(storage)).rejects.toThrow()
    expect(await Bun.file(file).text()).toBe("{ not json")
  })
})
