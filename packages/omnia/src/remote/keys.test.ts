import { chmodSync } from "node:fs"
import { describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRemoteKeyPair, defaultRemoteKeyFile, fileRemoteKeyStorage, loadOrCreateRemoteKeyPair } from "./keys"

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "omnia-remote-keys-"))
}

describe("file remote key storage", () => {
  test("creates the key file and its directory owner-only, with no leftovers", async () => {
    const directory = scratch()
    const file = join(directory, "nested", "remote-key.json")
    const storage = fileRemoteKeyStorage(file)
    expect(storage.load()).toBeUndefined()
    const keys = await loadOrCreateRemoteKeyPair(storage)
    expect(storage.load()).toEqual(keys)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(join(directory, "nested")).mode & 0o777).toBe(0o700)
    expect(readdirSync(join(directory, "nested"))).toEqual(["remote-key.json"])
  })

  test("tightens an already-loose key file and leaves no temporary files", () => {
    const directory = scratch()
    const file = join(directory, "remote-key.json")
    writeFileSync(file, JSON.stringify(createRemoteKeyPair()), { mode: 0o644 })
    chmodSync(file, 0o644) // Establish the fixture even under a restrictive umask.
    expect(statSync(file).mode & 0o777).toBe(0o644)
    const replaced = createRemoteKeyPair()
    fileRemoteKeyStorage(file).save(replaced)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readdirSync(directory)).toEqual(["remote-key.json"])
    expect(fileRemoteKeyStorage(file).load()).toEqual(replaced)
  })

  test("refuses to rotate a key file it cannot read", () => {
    const file = join(scratch(), "remote-key.json")
    // A torn write, not a missing file: rotating here would strand every
    // already-paired server with a key this computer no longer holds.
    writeFileSync(file, '{"publicKey":{"kty":"OKP"')
    expect(() => fileRemoteKeyStorage(file).load()).toThrow()
    writeFileSync(file, JSON.stringify({ publicKey: { kty: "RSA" }, privateKey: {} }))
    expect(() => fileRemoteKeyStorage(file).load()).toThrow(/not an Omnia remote key/)
  })

  test("keeps the key across reloads", async () => {
    const file = join(scratch(), "remote-key.json")
    const first = await loadOrCreateRemoteKeyPair(fileRemoteKeyStorage(file))
    const second = await loadOrCreateRemoteKeyPair(fileRemoteKeyStorage(file))
    expect(second).toEqual(first)
    expect(second.publicKey.kty).toBe("OKP")
    expect(first.privateKey.d).toBeString()
  })

  test("defaults to the per-user config directory", () => {
    expect(defaultRemoteKeyFile()).toContain(join("omnia", "remote-key.json"))
  })
})