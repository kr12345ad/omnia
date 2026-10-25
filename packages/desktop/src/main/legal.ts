import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto"
import {
  chmodSync,
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs"
import { homedir, hostname, userInfo } from "node:os"
import { basename, dirname, join } from "node:path"
import { pipeline } from "node:stream/promises"
import { LEGAL_ACCEPTANCE_KEY } from "./store-keys"

// The version of the Terms of Service the interface enforces. It must match
// `TERMS_VERSION` in packages/app/src/legal/terms.ts; a parity test in this
// package fails when the two drift, and the renderer refuses to display a
// different version than the one this process records.
export const TERMS_VERSION = "2026-10-20"

export type LegalStatus = {
  readonly termsVersion: string
  readonly acceptedVersion: string | null
  readonly acceptedAt: number | null
  readonly accepted: boolean
  readonly banned: boolean
  readonly reason: string | null
  readonly bannedAt: number | null
  readonly fingerprint: string
  readonly sealed: boolean
  readonly source: "local" | "remote" | null
}

export type Acceptance = { readonly version: string; readonly acceptedAt: number }

export type Fuse = {
  readonly version: 1
  readonly fingerprint: string
  /** Base64 AES-256 key that seals the session database. */
  readonly key: string
  readonly banned: boolean
  readonly reason?: string
  readonly bannedAt?: number
  readonly updatedAt: number
}

export type RemoteBan = { readonly banned: boolean; readonly reason?: string; readonly bannedAt?: number }

export type AcceptanceStore = {
  read(): Promise<Acceptance | undefined>
  write(value: Acceptance): Promise<void>
}

export type LegalOptions = {
  readonly userDataPath: string
  /** Operator endpoint answering `{ banned, reason, bannedAt }` for a fingerprint. */
  readonly banUrl?: string
  /**
   * The signed-in account email, sent with each ban check so an account ban
   * follows the person to any machine instead of only this fingerprint.
   */
  readonly account?: () => string | undefined
  /** Fuse locations; defaults to the OS locations listed in `fusePaths`. */
  readonly fusePaths?: string[]
  /** Overrides the computed installation fingerprint (tests and managed builds). */
  readonly fingerprint?: string
  readonly now?: () => number
  readonly fetch?: typeof fetch
  /** Overrides how acceptance is stored (the default reads the app settings store). */
  readonly acceptance?: AcceptanceStore
  /** Runs before the session database is sealed, so the local server can stop. */
  readonly beforeSeal?: () => Promise<void>
  readonly log?: (message: string, meta?: unknown) => void
}

const SEAL_MAGIC = "OMNIASL1"
const SEAL_HEADER = 8 + 16 + 12 + 16
const SEALED_NAME = "OMNIA.db.sealed"
const KEY_BYTES = 32

// The fuse lives outside the application's data folder on purpose: uninstalling
// the app, deleting userData, reinstalling a different version, or creating a
// new OS user data directory must not clear a ban. Every path is tried on read;
// a record at any of them is an active fuse.
export function fusePaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = homedir()
  const paths = [
    join(env.XDG_CONFIG_HOME || join(home, ".config"), "omnia", "legal", "fuse.json"),
    join(env.XDG_DATA_HOME || join(home, ".local", "share"), "omnia", "legal", "fuse.json"),
    join(home, ".omnia", "legal", "fuse.json"),
  ]
  if (process.platform === "darwin") {
    paths.push(join(home, "Library", "Application Support", "Omnia", "legal", "fuse.json"))
  }
  if (process.platform === "win32") {
    paths.push(join(env.APPDATA || join(home, "AppData", "Roaming"), "Omnia", "legal", "fuse.json"))
  }
  return paths
}

export function computeFingerprint(input: {
  readonly machineId?: string
  readonly host?: string
  readonly user?: string
} = {}): string {
  const machineId = input.machineId ?? readMachineId() ?? ""
  const hash = createHash("sha256")
  hash.update(["omnia-legal-v1", process.platform, process.arch, input.host ?? hostname(), input.user ?? userInfo().username, machineId].join("\0"))
  return hash.digest("hex").slice(0, 32)
}

function readMachineId(): string | undefined {
  for (const file of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    try {
      const value = readFileSync(file, "utf8").trim()
      if (value.length > 0) return value
    } catch {
      // Not this platform, or not readable; fall through to the next source.
    }
  }
  return undefined
}

function readFuseFile(path: string): Fuse | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Fuse>
    if (typeof parsed !== "object" || parsed === null) return undefined
    if (typeof parsed.fingerprint !== "string" || typeof parsed.key !== "string") return undefined
    return {
      version: 1,
      fingerprint: parsed.fingerprint,
      key: parsed.key,
      banned: parsed.banned === true,
      reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
      bannedAt: typeof parsed.bannedAt === "number" ? parsed.bannedAt : undefined,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
    }
  } catch {
    return undefined
  }
}

export function readFuse(paths: string[]): Fuse | undefined {
  const records = paths.flatMap((path) => {
    const record = readFuseFile(path)
    return record === undefined ? [] : [record]
  })
  if (records.length === 0) return undefined
  // Any banned marker wins: a user cannot clear a ban by deleting one of the
  // copies. Otherwise the newest record supplies the key and fingerprint.
  return records.find((record) => record.banned) ?? records.toSorted((a, b) => b.updatedAt - a.updatedAt)[0]
}

// The fuse is written through a fresh 0600 file renamed into place so a crash
// never leaves a half-written marker (which would read as "no ban").
export function writeFuse(paths: string[], record: Fuse): void {
  for (const path of paths) {
    try {
      const directory = dirname(path)
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      const temporary = join(directory, `.${basename(path)}.${randomUUID()}.tmp`)
      writeFileSync(temporary, JSON.stringify(record, null, 2), { mode: 0o600 })
      renameSync(temporary, path)
      chmodSync(path, 0o600)
    } catch {
      // One unwritable location must not stop the others; at least one record
      // is enough for the fuse to hold.
    }
  }
}

export function clearFuse(paths: string[]): void {
  for (const path of paths) rmSync(path, { force: true })
}

export function isBannedFuse(paths: string[]): boolean {
  return readFuse(paths)?.banned === true
}

// Encrypts the session database in place. `OMNIA.db` holds the whole database
// once its WAL has been checkpointed, so the sealed container is a single file
// that can be restored byte for byte. Returns false when there is nothing to do.
export async function sealSessions(userDataPath: string, key: Buffer): Promise<boolean> {
  const database = join(userDataPath, "OMNIA.db")
  if (!existsSync(database)) return false
  await checkpoint(database)
  const sealed = join(userDataPath, SEALED_NAME)
  const temporary = join(userDataPath, `.${SEALED_NAME}.${randomUUID()}.tmp`)
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const header = Buffer.alloc(SEAL_HEADER)
  header.write(SEAL_MAGIC, 0, "utf8")
  createHash("sha256").update(key).digest().copy(header, 8, 0, 16)
  iv.copy(header, 24)
  // The GCM tag is only known after the stream ends; reserve its bytes now and
  // fill them in at the fixed offset once the ciphertext is written.
  const output = createWriteStream(temporary, { mode: 0o600 })
  try {
    output.write(header)
    await pipeline(createReadStream(database), cipher, output)
    const handle = openSync(temporary, "r+")
    try {
      writeSync(handle, cipher.getAuthTag(), 0, 16, 24 + 12)
    } finally {
      closeSync(handle)
    }
    chmodSync(temporary, 0o600)
    renameSync(temporary, sealed)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
  // Only now is the plaintext removable: the sealed copy is complete and
  // authenticated, so a crash before this point leaves the database intact.
  rmSync(database, { force: true })
  rmSync(`${database}-wal`, { force: true })
  rmSync(`${database}-shm`, { force: true })
  return true
}

export function hasSealedSessions(userDataPath: string): boolean {
  return existsSync(join(userDataPath, SEALED_NAME))
}

// Decrypts a sealed database back into place. Authenticated encryption means a
// corrupted or wrong-key container fails before the plaintext is published.
export async function unsealSessions(userDataPath: string, key: Buffer): Promise<boolean> {
  const sealed = join(userDataPath, SEALED_NAME)
  if (!existsSync(sealed)) return false
  const handle = openSync(sealed, "r")
  const header = Buffer.alloc(SEAL_HEADER)
  try {
    if (readSync(handle, header, 0, SEAL_HEADER, 0) !== SEAL_HEADER) throw new Error("Sealed session database is truncated")
  } finally {
    closeSync(handle)
  }
  if (header.toString("utf8", 0, 8) !== SEAL_MAGIC) throw new Error("Sealed session database has an unknown format")
  const keyId = createHash("sha256").update(key).digest()
  if (!keyId.subarray(0, 16).equals(header.subarray(8, 24))) throw new Error("Sealed session database was sealed with a different key")
  const decipher = createDecipheriv("aes-256-gcm", key, header.subarray(24, 36))
  decipher.setAuthTag(header.subarray(36, 52))
  const database = join(userDataPath, "OMNIA.db")
  const temporary = join(userDataPath, `.OMNIA.db.${randomUUID()}.tmp`)
  try {
    await pipeline(createReadStream(sealed, { start: SEAL_HEADER }), decipher, createWriteStream(temporary, { mode: 0o600 }))
    chmodSync(temporary, 0o600)
    renameSync(temporary, database)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
  rmSync(sealed, { force: true })
  return true
}

async function checkpoint(database: string) {
  try {
    const { DatabaseSync } = await import("node:sqlite")
    const db = new DatabaseSync(database)
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
    } finally {
      db.close()
    }
  } catch {
    // A database that cannot be opened (or a build without node:sqlite) is
    // sealed as-is; a stray WAL is removed with the plaintext below.
  }
}

export function sealKey(record: Fuse | undefined): Buffer {
  if (record !== undefined) {
    const stored = Buffer.from(record.key, "base64")
    if (stored.length === KEY_BYTES) return stored
  }
  return randomBytes(KEY_BYTES)
}

export function parseRemoteBan(value: unknown): RemoteBan | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const body = value as { banned?: unknown; reason?: unknown; bannedAt?: unknown }
  if (typeof body.banned !== "boolean") return undefined
  return {
    banned: body.banned,
    reason: typeof body.reason === "string" ? body.reason : undefined,
    bannedAt: typeof body.bannedAt === "number" ? body.bannedAt : undefined,
  }
}

// The endpoint may answer for the caller directly (`{ banned }`), or serve a
// list the client matches against (`{ bans: [{ fingerprint | email, reason }] }`
// or `{ bans: { "<fingerprint or email>": { reason } } }`). The list form is what
// lets an operator publish bans as a static JSON file with no server behind it,
// and an account entry matches on the signed-in email rather than the machine.
export function parseBanResponse(
  value: unknown,
  fingerprint: string,
  email?: string,
): RemoteBan | undefined {
  const direct = parseRemoteBan(value)
  if (direct !== undefined) return direct
  if (typeof value !== "object" || value === null) return undefined
  type Entry = { fingerprint?: unknown; email?: unknown; reason?: unknown; bannedAt?: unknown }
  const raw = (value as { bans?: unknown }).bans
  const entries: Entry[] = Array.isArray(raw)
    ? (raw as Entry[])
    : typeof raw === "object" && raw !== null
      ? Object.entries(raw as Record<string, { reason?: unknown; bannedAt?: unknown }>).map(([key, entry]) => ({
          // A keyed map does not say which kind of subject the key is; an email
          // key is recognized by its shape, everything else as a fingerprint.
          ...(key.includes("@") ? { email: key } : { fingerprint: key }),
          reason: typeof entry === "object" && entry !== null ? entry.reason : undefined,
          bannedAt: typeof entry === "object" && entry !== null ? entry.bannedAt : undefined,
        }))
      : []
  if (raw === undefined) return undefined
  const wanted = email?.trim().toLowerCase()
  const match = entries.find(
    (entry) =>
      entry.fingerprint === fingerprint ||
      (wanted !== undefined && typeof entry.email === "string" && entry.email.toLowerCase() === wanted),
  )
  if (match === undefined) return { banned: false }
  return {
    banned: true,
    reason: typeof match.reason === "string" ? match.reason : "Banned by the operator",
    bannedAt: typeof match.bannedAt === "number" ? match.bannedAt : undefined,
  }
}

export type LegalController = ReturnType<typeof createLegalController>

export function createLegalController(options: LegalOptions) {
  const now = options.now ?? Date.now
  const paths = options.fusePaths ?? fusePaths()
  const fetchImpl = options.fetch ?? fetch
  const log = options.log ?? (() => undefined)
  const stopBeforeSeal = async () => {
    try {
      await options.beforeSeal?.()
    } catch (error) {
      log("failed to stop the local server before sealing", error)
    }
  }
  const recordPath = join(options.userDataPath, "legal")

  const fingerprint = () => {
    const existing = readFuse(paths)
    return options.fingerprint ?? existing?.fingerprint ?? computeFingerprint()
  }

  // The settings store imports Electron, so it is loaded lazily: this module is
  // also exercised by plain Bun tests and in the packaged main process alike.
  const acceptanceStore: AcceptanceStore =
    options.acceptance ??
    {
      read: async () => {
        const { getStore } = await import("./store")
        const value = getStore().get(LEGAL_ACCEPTANCE_KEY) as Partial<Acceptance> | undefined
        if (value === undefined || typeof value.version !== "string" || typeof value.acceptedAt !== "number") {
          return undefined
        }
        return { version: value.version, acceptedAt: value.acceptedAt }
      },
      write: async (value) => {
        const { getStore } = await import("./store")
        getStore().set(LEGAL_ACCEPTANCE_KEY, value)
      },
    }

  const remote = async (): Promise<RemoteBan | undefined> => {
    if (options.banUrl === undefined || options.banUrl.length === 0) return undefined
    const url = new URL(options.banUrl)
    url.searchParams.set("fingerprint", fingerprint())
    url.searchParams.set("version", TERMS_VERSION)
    const account = options.account?.()?.trim()
    if (account !== undefined && account.length > 0) url.searchParams.set("email", account)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 2500)
    try {
      const response = await fetchImpl(url, { signal: controller.signal, headers: { accept: "application/json" } })
      if (!response.ok) return undefined
      return parseBanResponse(await response.json(), fingerprint(), account)
    } catch (error) {
      log("ban check failed", error)
      return undefined
    } finally {
      clearTimeout(timer)
    }
  }

  const status = async (): Promise<LegalStatus> => {
    const local = readFuse(paths)
    const online = await remote()
    const banned = local?.banned === true || online?.banned === true
    const accepted = await acceptanceStore.read()
    return {
      termsVersion: TERMS_VERSION,
      acceptedVersion: accepted?.version ?? null,
      acceptedAt: accepted?.acceptedAt ?? null,
      accepted: accepted?.version === TERMS_VERSION,
      banned,
      reason: (local?.reason ?? online?.reason) ?? null,
      bannedAt: (local?.bannedAt ?? online?.bannedAt) ?? null,
      fingerprint: fingerprint(),
      sealed: hasSealedSessions(options.userDataPath),
      source: local?.banned === true ? "local" : online?.banned === true ? "remote" : null,
    }
  }

  // Runs before the local server starts. A ban is recorded in every fuse
  // location and the session database is sealed while nothing holds it open.
  const startup = async (): Promise<LegalStatus> => {
    const current = await status()
    if (!current.banned) {
      if (current.sealed) log("sealed sessions found with no ban marker; leaving them sealed")
      return current
    }
    const existing = readFuse(paths)
    const key = sealKey(existing)
    const record: Fuse = {
      version: 1,
      fingerprint: current.fingerprint,
      key: key.toString("base64"),
      banned: true,
      reason: current.reason ?? undefined,
      bannedAt: current.bannedAt ?? now(),
      updatedAt: now(),
    }
    writeFuse([...paths, join(recordPath, "fuse.json")], record)
    await stopBeforeSeal()
    try {
      if (await sealSessions(options.userDataPath, key)) log("session database sealed after ban", { fingerprint: current.fingerprint })
    } catch (error) {
      log("failed to seal session database", error)
    }
    return { ...current, sealed: hasSealedSessions(options.userDataPath) }
  }

  const accept = async (version: string): Promise<LegalStatus> => {
    if (version !== TERMS_VERSION) throw new Error("Terms version mismatch")
    if (isBannedFuse(paths)) throw new Error("A banned installation cannot accept the terms")
    await acceptanceStore.write({ version, acceptedAt: now() })
    return status()
  }

  // Re-checks the operator and, when the ban is gone, restores the sealed
  // database. Returns `restored` so the caller can relaunch the app: the server
  // must start after the database exists again.
  const refresh = async (): Promise<{ status: LegalStatus; restored: boolean }> => {
    const local = readFuse(paths)
    const online = await remote()
    const localBanned = local?.banned === true
    if (online?.banned === true) {
      if (!localBanned) {
        const key = sealKey(local)
        writeFuse([...paths, join(recordPath, "fuse.json")], {
          version: 1,
          fingerprint: fingerprint(),
          key: key.toString("base64"),
          banned: true,
          reason: online.reason,
          bannedAt: online.bannedAt ?? now(),
          updatedAt: now(),
        })
        await stopBeforeSeal()
        try {
          await sealSessions(options.userDataPath, key)
        } catch (error) {
          log("failed to seal session database", error)
        }
      }
      return { status: await status(), restored: false }
    }
    // An unreachable endpoint answers nothing, so it can neither apply nor lift
    // enforcement. Only an explicit "not banned" from the operator clears a
    // local ban; this is what stops an appeal from being skipped by going
    // offline.
    if (localBanned && online === undefined) return { status: await status(), restored: false }
    if (!localBanned) return { status: await status(), restored: false }
    try {
      if (await unsealSessions(options.userDataPath, sealKey(local))) log("session database restored after unban")
    } catch (error) {
      log("failed to restore sealed session database", error)
      return { status: await status(), restored: false }
    }
    clearFuse([...paths, join(recordPath, "fuse.json")])
    return { status: await status(), restored: true }
  }

  const ban = async (reason: string): Promise<LegalStatus> => {
    const key = sealKey(readFuse(paths))
    writeFuse([...paths, join(recordPath, "fuse.json")], {
      version: 1,
      fingerprint: fingerprint(),
      key: key.toString("base64"),
      banned: true,
      reason,
      bannedAt: now(),
      updatedAt: now(),
    })
    await stopBeforeSeal()
    try {
      await sealSessions(options.userDataPath, key)
    } catch (error) {
      log("failed to seal session database", error)
    }
    return status()
  }

  const unban = async (): Promise<{ status: LegalStatus; restored: boolean }> => {
    const local = readFuse(paths)
    if (local?.banned === true) {
      try {
        await unsealSessions(options.userDataPath, sealKey(local))
      } catch (error) {
        log("failed to restore sealed session database", error)
      }
    }
    clearFuse([...paths, join(recordPath, "fuse.json")])
    return { status: await status(), restored: true }
  }

  return { status, startup, accept, refresh, ban, unban }
}
