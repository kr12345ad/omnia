import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { RemoteKeyPair } from "../remote/keys"
import { createRemoteKeyPair } from "../remote/keys"
import {
  REMOTE_REPLAY_WINDOW_MS,
  remoteAuthHeaders,
  signRemoteRequest,
  verifyRemoteSignature,
} from "../remote/signing"
import { EventBus } from "./events"
import { parseRemotePublicKey, RemoteRegistry } from "./remote"
import { startOmniaServer } from "./server"
import type { ServerComputerDriver } from "./computers"
import type { ActionResult, Observation } from "../protocol"
import { browserFailureCode } from "../browser/errors"

function createLocalDriver(): ServerComputerDriver {
  return {
    id: "local",
    backend: "test",
    getInfo: async () => ({ id: "local", name: "Local", platform: "linux", connected: true }),
    capabilities: () => [],
    observe: async (): Promise<Observation> => ({ id: "local-obs", elements: [] }),
    find: async () => ({ matches: [] }),
    execute: async (): Promise<ActionResult> => ({ success: true, status: "success", message: "ok" }),
  }
}

async function withServer<T>(
  fn: (server: Awaited<ReturnType<typeof startOmniaServer>>) => Promise<T>,
  now?: () => number,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "omnia-remote-auth-"))
  const server = await startOmniaServer({
    drivers: [createLocalDriver()],
    ...(now === undefined ? {} : { now }),
    credentialsFile: join(dir, "credentials.json"),
    authFile: join(dir, "auth.json"),
    superskillFile: join(dir, "superskills.json"),
    memoryFile: join(dir, "memories.json"),
    computerUseFile: join(dir, "computer-use.json"),
  })
  try {
    return await fn(server)
  } finally {
    await server.stop()
  }
}

interface PairedRemote {
  readonly computerId: string
  readonly token: string
  readonly keys: RemoteKeyPair
}

const operatorAuth = (server: { token: string }) => ({
  authorization: `Bearer ${server.token}`,
  "content-type": "application/json",
})

async function pairRemote(
  server: Awaited<ReturnType<typeof startOmniaServer>>,
  keys = createRemoteKeyPair(),
): Promise<PairedRemote> {
  const created = await fetch(`${server.url}/v1/computers/pair`, {
    method: "POST",
    headers: operatorAuth(server),
    body: JSON.stringify({ name: "Signed PC" }),
  })
  const offer = (await created.json()) as { pairing: { code: string } }
  const claimed = await fetch(`${server.url}/v1/computers/pair/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: offer.pairing.code, name: "Signed PC", platform: "linux", publicKey: keys.publicKey }),
  })
  expect(claimed.status).toBe(200)
  const claim = (await claimed.json()) as { computerId: string; token: string }
  return { computerId: claim.computerId, token: claim.token, keys }
}

function remoteUrl(server: { url: string }, computerId: string, suffix: string): string {
  return `${server.url}/v1/computers/${computerId}/remote/${suffix}`
}

// The server refuses a timestamp this computer already spent, so tests have to
// sign with a clock that never repeats a millisecond.
let lastSignedAt = 0
function monotonicNow(): number {
  lastSignedAt = Math.max(Date.now(), lastSignedAt + 1)
  return lastSignedAt
}

function signedRequest(
  paired: PairedRemote,
  method: string,
  url: string,
  body?: string,
  timestampMs = monotonicNow(),
): RequestInit {
  return {
    method,
    headers: {
      ...remoteAuthHeaders({
        token: paired.token,
        computerId: paired.computerId,
        method,
        url,
        timestampMs,
        keys: paired.keys.privateKey,
        ...(body === undefined ? {} : { body }),
      }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body }),
  }
}

describe("remote request authentication", () => {
  test("accepts a signed command poll", async () => {
    await withServer(async (server) => {
      const paired = await pairRemote(server)
      const url = remoteUrl(server, paired.computerId, "commands?wait=0")
      const response = await fetch(url, signedRequest(paired, "GET", url))
      expect(response.status).toBe(200)
      expect(((await response.json()) as { command: unknown }).command).toBeNull()
    })
  })

  test("rejects unsigned and bearer-only requests with remote_unauthenticated", async () => {
    await withServer(async (server) => {
      const paired = await pairRemote(server)
      const response = await fetch(remoteUrl(server, paired.computerId, "commands?wait=0"), {
        headers: { authorization: `Bearer ${paired.token}` },
      })
      expect(response.status).toBe(401)
      expect(((await response.json()) as { error: string }).error).toBe("remote_unauthenticated")
    })
  })

  test("rejects a signature made by an unknown key", async () => {
    await withServer(async (server) => {
      const paired = await pairRemote(server)
      const unknown = createRemoteKeyPair()
      const url = remoteUrl(server, paired.computerId, "commands?wait=0")
      const response = await fetch(url, signedRequest({ ...paired, keys: unknown }, "GET", url))
      expect(response.status).toBe(401)
      expect(((await response.json()) as { error: string }).error).toBe("remote_unauthenticated")
    })
  })

  test("rejects a key id that does not match the request path", async () => {
    await withServer(async (server) => {
      const paired = await pairRemote(server)
      const url = remoteUrl(server, paired.computerId, "commands?wait=0")
      const headers = remoteAuthHeaders({
        token: paired.token,
        computerId: paired.computerId,
        method: "GET",
        url,
        timestampMs: Date.now(),
        keys: paired.keys.privateKey,
      })
      const response = await fetch(url, {
        method: "GET",
        headers: { ...headers, "x-omnia-key-id": "remote-someone-else" },
      })
      expect(response.status).toBe(401)
    })
  })

  test("rejects tampered query, signature, and body", async () => {
    await withServer(async (server) => {
      const paired = await pairRemote(server)
      const signedUrl = remoteUrl(server, paired.computerId, "commands?wait=0")
      const tamperedUrl = remoteUrl(server, paired.computerId, "commands?wait=1")
      const tamperedPath = await fetch(tamperedUrl, signedRequest(paired, "GET", signedUrl))
      expect(tamperedPath.status).toBe(401)

      const headers = remoteAuthHeaders({
        token: paired.token,
        computerId: paired.computerId,
        method: "GET",
        url: signedUrl,
        timestampMs: Date.now(),
        keys: paired.keys.privateKey,
      })
      const signature = Buffer.from(headers["x-omnia-signature"] ?? "", "base64")
      signature[0] = (signature[0] ?? 0) ^ 0xff
      const tamperedSignature = await fetch(signedUrl, {
        method: "GET",
        headers: { ...headers, "x-omnia-signature": signature.toString("base64") },
      })
      expect(tamperedSignature.status).toBe(401)

      const resultsUrl = remoteUrl(server, paired.computerId, "results")
      const signedBody = JSON.stringify({ id: "cmd-1", ok: true })
      // Replace the body after signing: the request now carries a different body.
      const forged = await fetch(resultsUrl, {
        method: "POST",
        headers: {
          ...remoteAuthHeaders({
            token: paired.token,
            computerId: paired.computerId,
            method: "POST",
            url: resultsUrl,
            timestampMs: Date.now(),
            keys: paired.keys.privateKey,
            body: signedBody,
          }),
          "content-type": "application/json",
        },
        body: JSON.stringify({ id: "cmd-2", ok: true }),
      })
      expect(forged.status).toBe(401)
      // The correctly signed body still authenticates, even though the command is unknown.
      const intact = await fetch(resultsUrl, signedRequest(paired, "POST", resultsUrl, signedBody))
      expect(intact.status).toBe(404)
    })
  })

  test("rejects timestamps outside the replay window", async () => {
    let clock = 1_000_000
    await withServer(async (server) => {
      const paired = await pairRemote(server)
      const url = remoteUrl(server, paired.computerId, "commands?wait=0")
      const inside = await fetch(url, signedRequest(paired, "GET", url, undefined, clock - REMOTE_REPLAY_WINDOW_MS + 1_000))
      expect(inside.status).toBe(200)
      const stale = await fetch(url, signedRequest(paired, "GET", url, undefined, clock - REMOTE_REPLAY_WINDOW_MS - 1))
      expect(stale.status).toBe(401)
      const future = await fetch(url, signedRequest(paired, "GET", url, undefined, clock + REMOTE_REPLAY_WINDOW_MS + 1))
      expect(future.status).toBe(401)
      const notANumber = await fetch(url, {
        method: "GET",
        headers: {
          ...remoteAuthHeaders({
            token: paired.token,
            computerId: paired.computerId,
            method: "GET",
            url,
            timestampMs: clock,
            keys: paired.keys.privateKey,
          }),
          "x-omnia-timestamp": "not-a-number",
        },
      })
      expect(notANumber.status).toBe(401)
    }, () => clock)
  })

  test("round-trips a command and its signed result", async () => {
    await withServer(async (server) => {
      const paired = await pairRemote(server)
      const computer = server.computers.get(paired.computerId)
      expect(computer).toBeDefined()
      const pending = computer!.driver.observe()
      const commandsUrl = remoteUrl(server, paired.computerId, "commands?wait=0")
      const polled = await fetch(commandsUrl, signedRequest(paired, "GET", commandsUrl))
      expect(polled.status).toBe(200)
      const command = ((await polled.json()) as { command: { id: string; method: string } }).command
      expect(command.method).toBe("observe")
      const resultsUrl = remoteUrl(server, paired.computerId, "results")
      const result = JSON.stringify({ id: command.id, ok: true, result: { id: "obs-1", elements: [] } })
      const posted = await fetch(resultsUrl, signedRequest(paired, "POST", resultsUrl, result))
      expect(posted.status).toBe(200)
      expect((await pending).id).toBe("obs-1")
    })
  })

  test("carries the typed error code of a result posted over HTTP", async () => {
    await withServer(async (server) => {
      const paired = await pairRemote(server)
      const computer = server.computers.get(paired.computerId)
      const pending = computer!.driver.browser!.status()
      const settled = pending.then(
        () => undefined,
        (reason: unknown) => reason as Error & { code?: string },
      )
      const commandsUrl = remoteUrl(server, paired.computerId, "commands?wait=0")
      const polled = await fetch(commandsUrl, signedRequest(paired, "GET", commandsUrl))
      const command = ((await polled.json()) as { command: { id: string } }).command
      const resultsUrl = remoteUrl(server, paired.computerId, "results")
      const result = JSON.stringify({
        id: command.id,
        ok: false,
        error: "The embedded browser did not open a tab in time.",
        code: "open_timeout",
      })
      const posted = await fetch(resultsUrl, signedRequest(paired, "POST", resultsUrl, result))
      expect(posted.status).toBe(200)
      const error = await settled
      expect(error?.message).toContain("did not open a tab")
      // Without the code crossing the route the caller only sees the generic
      // "Omnia Server request failed"/browser_error fallback.
      expect(error?.code).toBe("open_timeout")
      expect(browserFailureCode(error)).toBe("open_timeout")
    })
  })

  test("refuses a captured request that is replayed inside the window", async () => {
    await withServer(async (server) => {
      const paired = await pairRemote(server)
      const url = remoteUrl(server, paired.computerId, "commands?wait=0")
      const captured = signedRequest(paired, "GET", url)
      expect((await fetch(url, captured)).status).toBe(200)
      expect((await fetch(url, captured)).status).toBe(401)
    })
  })

  test("accepts a signed bye and revokes the pairing", async () => {
    await withServer(async (server) => {
      const paired = await pairRemote(server)
      const byeUrl = remoteUrl(server, paired.computerId, "bye")
      const bye = await fetch(byeUrl, signedRequest(paired, "POST", byeUrl))
      expect(bye.status).toBe(200)
      const after = await fetch(remoteUrl(server, paired.computerId, "commands?wait=0"), {
        headers: { authorization: `Bearer ${paired.token}` },
      })
      expect(after.status).toBe(401)
    })
  })
})

describe("remote registry signature policy", () => {
  test("requires signatures unless migration mode allows unsigned requests", () => {
    const options = {
      events: new EventBus({ serverId: "test" }),
      registerDriver: () => () => {},
      randomToken: () => "token-1",
    }
    const proof = { method: "GET", path: "/v1/computers/x/remote/commands", timestampMs: 1000, body: Buffer.alloc(0), signature: "" }
    const strict = new RemoteRegistry({ ...options, randomComputerId: () => "remote-strict" })
    const strictClaim = strict.claim({ name: "Strict", platform: "linux" })
    expect(strict.verifyRequest(strictClaim.computerId, proof)).toBe(false)
    strict.close()

    const legacy = new RemoteRegistry({
      ...options,
      randomComputerId: () => "remote-legacy",
      allowUnsigned: true,
    })
    const legacyClaim = legacy.claim({ name: "Legacy", platform: "linux" })
    expect(legacy.verifyRequest(legacyClaim.computerId, proof)).toBe(true)
    legacy.close()
  })

  test("enforces the replay window for signed requests", () => {
    const registry = new RemoteRegistry({
      events: new EventBus({ serverId: "test" }),
      registerDriver: () => () => {},
      now: () => 1_000_000,
      randomToken: () => "token-1",
      randomComputerId: () => "remote-clock",
    })
    const keys = createRemoteKeyPair()
    registry.claim({ name: "Clock", platform: "linux", publicKey: parseRemotePublicKey(keys.publicKey) })
    const input = {
      method: "GET",
      path: "/v1/computers/remote-clock/remote/commands",
      timestampMs: 1_000_000,
      body: Buffer.alloc(0),
    }
    expect(registry.verifyRequest("remote-clock", { ...input, signature: signRemoteRequest(keys.privateKey, input) })).toBe(true)
    const stale = { ...input, timestampMs: 1_000_000 - REMOTE_REPLAY_WINDOW_MS - 1 }
    expect(registry.verifyRequest("remote-clock", { ...stale, signature: signRemoteRequest(keys.privateKey, stale) })).toBe(false)
    registry.close()
  })

  test("normalizes JWK and raw base64 public keys at claim", () => {
    const keys = createRemoteKeyPair()
    const input = { method: "GET", path: "/v1/computers/x/remote/commands", timestampMs: 1000, body: Buffer.alloc(0) }
    const signature = signRemoteRequest(keys.privateKey, input)
    const jwk = parseRemotePublicKey(keys.publicKey)
    const raw = parseRemotePublicKey(Buffer.from(keys.publicKey.x ?? "", "base64url").toString("base64"))
    expect(jwk).toBeDefined()
    expect(raw).toBeDefined()
    expect(verifyRemoteSignature(jwk!, { ...input, signature })).toBe(true)
    expect(verifyRemoteSignature(raw!, { ...input, signature })).toBe(true)
    expect(parseRemotePublicKey("only-not-32-bytes")).toBeUndefined()
    expect(parseRemotePublicKey({ kty: "RSA", n: "abc" })).toBeUndefined()
    expect(parseRemotePublicKey(42)).toBeUndefined()
  })
})
