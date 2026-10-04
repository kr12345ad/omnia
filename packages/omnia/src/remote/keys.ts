import { generateKeyPairSync, randomBytes } from "node:crypto"
import type { JsonWebKey } from "node:crypto"
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export interface RemoteKeyPair {
  readonly publicKey: JsonWebKey
  readonly privateKey: JsonWebKey
}

export interface RemoteKeyStorage {
  load(): RemoteKeyPair | undefined | Promise<RemoteKeyPair | undefined>
  save(keys: RemoteKeyPair): void | Promise<void>
}

export function createRemoteKeyPair(): RemoteKeyPair {
  const keyPair = generateKeyPairSync("ed25519")
  return {
    publicKey: keyPair.publicKey.export({ format: "jwk" }),
    privateKey: keyPair.privateKey.export({ format: "jwk" }),
  }
}

export async function loadOrCreateRemoteKeyPair(storage?: RemoteKeyStorage): Promise<RemoteKeyPair> {
  const existing = await storage?.load()
  if (existing !== undefined) return existing
  const keys = createRemoteKeyPair()
  await storage?.save(keys)
  return keys
}

export function defaultRemoteKeyFile(): string {
  const configHome = process.env.XDG_CONFIG_HOME
  const base = configHome !== undefined && configHome.length > 0 ? configHome : join(homedir(), ".config")
  return join(base, "omnia", "remote-key.json")
}

export function fileRemoteKeyStorage(file = defaultRemoteKeyFile()): RemoteKeyStorage {
  return {
    // A missing file means "create one"; a corrupt, truncated, or unreadable
    // file throws instead of silently rotating the key, which would strand
    // every already-paired server with a key the computer no longer holds.
    load: () => {
      if (!existsSync(file)) return undefined
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"))
      if (!isRemoteKeyPair(parsed)) throw new Error(`${file} is not an Omnia remote key; refusing to replace it.`)
      return parsed
    },
    save: (keys) => {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      // mode 0600 only applies when the file is created, so the private key is
      // written to its own fresh file, flushed, then renamed over the target:
      // a crash leaves either the old key or the new one, never a torn one.
      const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`
      const handle = openSync(temporary, "wx", 0o600)
      try {
        writeSync(handle, JSON.stringify(keys))
        fsyncSync(handle)
      } finally {
        closeSync(handle)
      }
      renameSync(temporary, file)
      // Rename keeps the temp file's mode, but an already-present key file may
      // predate this call with looser permissions.
      chmodSync(file, 0o600)
    },
  }
}

function isRemoteKeyPair(value: unknown): value is RemoteKeyPair {
  if (typeof value !== "object" || value === null) return false
  const record = value as Record<string, unknown>
  return isJwk(record.publicKey) && isJwk(record.privateKey) && typeof (record.privateKey as Record<string, unknown>).d === "string"
}

function isJwk(value: unknown): value is JsonWebKey {
  if (typeof value !== "object" || value === null) return false
  const jwk = value as Record<string, unknown>
  return jwk.kty === "OKP" && jwk.crv === "Ed25519" && typeof jwk.x === "string"
}
