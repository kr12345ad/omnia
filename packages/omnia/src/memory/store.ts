import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import { randomUUID } from "node:crypto"
import {
  MEMORY_SCOPES,
  MEMORY_SENSITIVITIES,
  MEMORY_SOURCES,
  type MemoryQuery,
  type MemoryRecord,
  type MemoryScope,
  type MemorySensitivity,
  type MemorySource,
  type MemoryStats,
  type MemoryWriteInput,
} from "./types"

export const MEMORY_TEXT_LIMIT = 2000
export const MEMORY_MAX_RECORDS = 5000
export const MEMORY_FILE_VERSION = 1
export const MEMORY_METADATA_DEPTH = 8

const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  // Short sk- keys (still secrets, just not the classic 48-char shape).
  /\bsk-[A-Za-z0-9_-]{8,15}\b/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /aws_?secret_?access_?key["']?\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}/gi,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  // Bearer tokens and `token: <value>` assignments.
  /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(?:auth|access|refresh|api|session)?[_-]?token["']?\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}/gi,
  // JWTs: three base64url segments.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(password|passwd|secret|api[_-]?key)\s*[:=]\s*\S+/gi,
]

export function defaultMemoryFile(): string {
  return join(homedir(), ".local", "share", "omnia", "memories.json")
}

function redactText(text: string): { text: string; redacted: boolean } {
  let redacted = false
  let value = text
  for (const pattern of SECRET_PATTERNS) {
    value = value.replace(pattern, () => {
      redacted = true
      return "[redacted]"
    })
  }
  return { text: value, redacted }
}

// Memories are the agent's durable notes: application quirks, procedures, and
// user preferences. Secrets are redacted before storage and every record
// carries scope, provenance, confidence, and optional expiry.
export function redactMemoryText(text: string): { text: string; redacted: boolean } {
  const result = redactText(text)
  return { text: result.text.slice(0, MEMORY_TEXT_LIMIT), redacted: result.redacted }
}

// Metadata is persisted too, so redact it deeply: a secret tucked into a
// nested metadata value must not survive just because it was not the text.
function redactStructure(value: unknown, depth = 0, seen = new Set<object>()): { value: unknown; redacted: boolean } {
  if (typeof value === "string") {
    const result = redactText(value)
    return { value: result.text, redacted: result.redacted }
  }
  if (value === null || typeof value !== "object") return { value, redacted: false }
  if (depth >= MEMORY_METADATA_DEPTH) return { value: "[truncated]", redacted: true }
  if (seen.has(value)) return { value: "[circular]", redacted: true }
  seen.add(value)
  if (Array.isArray(value)) {
    let redacted = false
    const items = value.map((item) => {
      const result = redactStructure(item, depth + 1, seen)
      if (result.redacted) redacted = true
      return result.value
    })
    seen.delete(value)
    return { value: items, redacted }
  }
  let redacted = false
  const entries = Object.entries(value as Record<string, unknown>).map(([key, item]) => {
    const result = redactStructure(item, depth + 1, seen)
    if (result.redacted) redacted = true
    return [key, result.value] as const
  })
  seen.delete(value)
  return { value: Object.fromEntries(entries), redacted }
}

export function isMemoryScope(value: unknown): value is MemoryScope {
  return typeof value === "string" && (MEMORY_SCOPES as readonly string[]).includes(value)
}

function isMemorySensitivity(value: unknown): value is MemorySensitivity {
  return typeof value === "string" && (MEMORY_SENSITIVITIES as readonly string[]).includes(value)
}

function isMemorySource(value: unknown): value is MemorySource {
  return typeof value === "string" && (MEMORY_SOURCES as readonly string[]).includes(value)
}

function score(record: MemoryRecord, query: string, tags: readonly string[]): number {
  const needle = query.toLowerCase().trim()
  const text = record.text.toLowerCase()
  let base = 0
  if (needle.length === 0) {
    base = 0.5
  } else if (record.key !== undefined && record.key.toLowerCase() === needle) {
    base = 1
  } else if (text === needle) {
    base = 0.95
  } else if (text.includes(needle)) {
    base = 0.8
  } else {
    const words = needle.split(/\s+/).filter((word) => word.length > 1)
    const hits = words.filter((word) => text.includes(word)).length
    if (hits > 0) base = 0.4 + (0.3 * hits) / words.length
  }
  if (base === 0) return 0
  for (const tag of tags) {
    if ((record.tags ?? []).some((candidate) => candidate.toLowerCase() === tag.toLowerCase())) base += 0.1
  }
  if (record.application !== undefined && needle.includes(record.application.toLowerCase())) base += 0.05
  return base * (0.6 + 0.4 * record.confidence)
}

export interface MemoryStoreOptions {
  readonly file?: string
  readonly now?: () => number
  readonly maxRecords?: number
}

export class MemoryStore {
  private readonly file: string
  private readonly now: () => number
  private readonly maxRecords: number
  private records: MemoryRecord[] = []

  constructor(options: MemoryStoreOptions = {}) {
    this.file = options.file ?? defaultMemoryFile()
    this.now = options.now ?? Date.now
    this.maxRecords = options.maxRecords ?? MEMORY_MAX_RECORDS
    this.load()
  }

  private load(): void {
    if (!existsSync(this.file)) return
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.file, "utf8")) as unknown
    } catch {
      parsed = undefined
    }
    // A bare `null`, a number, or a string all parse fine, so the shape has to be
    // checked before it is read: otherwise `parsed.memories` throws a raw TypeError
    // and the bytes are never preserved.
    const memories = isRecord(parsed) && Array.isArray(parsed.memories) ? (parsed.memories as unknown[]) : undefined
    if (memories === undefined) {
      // A torn or truncated write must never masquerade as an empty store: the
      // first save after a crash would otherwise discard every memory the user
      // ever made. Keep the bytes aside and refuse to start instead.
      try {
        renameSync(this.file, `${this.file}.corrupt`)
      } catch {
        // Nothing to preserve, or the directory is not writable.
      }
      throw new Error(`${this.file} is not a readable Omnia memory file; it was kept at ${this.file}.corrupt.`)
    }
    const at = this.now()
    this.records = memories.flatMap((item): MemoryRecord[] => {
      if (typeof item !== "object" || item === null) return []
      const record = item as Record<string, unknown>
      if (typeof record.id !== "string" || record.id.length === 0) return []
      if (typeof record.text !== "string" || !isMemoryScope(record.scope)) return []
      const createdAt = finiteNumber(record.createdAt) ?? at
      const updatedAt = finiteNumber(record.updatedAt) ?? createdAt
      const expiresAt = finiteNumber(record.expiresAt)
      return [
        {
          id: record.id,
          scope: record.scope,
          text: record.text.slice(0, MEMORY_TEXT_LIMIT),
          ...(typeof record.key === "string" ? { key: record.key } : {}),
          ...(isStringArray(record.tags) ? { tags: record.tags.slice(0, 12) } : {}),
          ...(typeof record.application === "string" ? { application: record.application } : {}),
          ...(typeof record.sessionId === "string" ? { sessionId: record.sessionId } : {}),
          ...(typeof record.workspace === "string" ? { workspace: record.workspace } : {}),
          source: isMemorySource(record.source) ? record.source : "agent",
          // NaN/Infinity confidence would poison prune/ranking; clamp it.
          confidence: clampConfidence(finiteNumber(record.confidence) ?? 0.8),
          sensitivity: isMemorySensitivity(record.sensitivity) ? record.sensitivity : "internal",
          createdAt,
          updatedAt,
          ...(expiresAt === undefined ? {} : { expiresAt }),
          ...(isRecord(record.metadata) ? { metadata: record.metadata } : {}),
        },
      ]
    })
  }

  private persist(): void {
    const directory = dirname(this.file)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const temporary = join(directory, `.${basename(this.file)}.${randomUUID()}.tmp`)
    try {
      // Private memories must not be world-readable: the store is written to its
      // own fresh 0600 file, and `wx` never follows a planted symlink the way a
      // fixed `<file>.tmp` name would.
      const handle = openSync(temporary, "wx", 0o600)
      try {
        writeFileSync(handle, JSON.stringify({ version: MEMORY_FILE_VERSION, memories: this.records }, null, 2))
        fsyncSync(handle)
      } finally {
        closeSync(handle)
      }
      // rename(2) inside one directory is atomic, so a crash or a full disk
      // leaves either the previous memories or these, never a torn mix.
      renameSync(temporary, this.file)
    } catch (error) {
      // A temp file left behind is dead weight holding private memories; never keep one.
      try {
        unlinkSync(temporary)
      } catch {
        // Already gone, or the directory is gone with it.
      }
      throw error
    }
    // Rename keeps the temp file's mode, but an existing store may predate this
    // call with looser permissions.
    chmodSync(this.file, 0o600)
    try {
      fsyncDirectory(directory)
    } catch {
      // The rename already landed; only its durability across a power loss is
      // weakened, which must not be reported as a failed save.
    }
  }

  private prune(retain?: string): void {
    const at = this.now()
    // Opportunistic purge: expired records otherwise grow the file forever.
    const live = this.records.filter((record) => record.expiresAt === undefined || record.expiresAt > at)
    if (live.length <= this.maxRecords) {
      this.records = live
      return
    }
    this.records = live
      .sort((a, b) => {
        // The record a write just created is never the one evicted: write() hands
        // it back as stored, so dropping it here would lose it silently.
        if (a.id === retain) return -1
        if (b.id === retain) return 1
        return b.confidence - a.confidence || b.updatedAt - a.updatedAt
      })
      .slice(0, this.maxRecords)
  }

  write(input: MemoryWriteInput): MemoryRecord {
    const { text, redacted } = redactMemoryText(input.text.trim())
    if (text.length === 0) throw new Error("Memory text is required.")
    const at = this.now()
    const existing =
      input.key === undefined
        ? undefined
        : this.records.find((record) => record.scope === input.scope && record.key === input.key)
    const metadata = input.metadata === undefined ? undefined : redactStructure(input.metadata)
    const metadataRedacted = metadata?.redacted === true
    const expiresInDays = finiteNumber(input.expiresInDays)
    // Upsert must not silently drop an existing expiry: omitting expiresInDays
    // inherits the stored expiresAt instead of going permanent. A lapsed expiry is
    // not inherited, or prune() would drop the record this write just created and
    // the caller would get back a memory that was never stored.
    const inheritedExpiresAt =
      existing?.expiresAt !== undefined && existing.expiresAt > at ? existing.expiresAt : undefined
    const record: MemoryRecord = {
      id: existing?.id ?? `mem_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
      scope: input.scope,
      text,
      ...(input.key === undefined ? {} : { key: input.key }),
      ...(input.tags === undefined ? {} : { tags: [...input.tags].slice(0, 12) }),
      ...(input.application === undefined ? {} : { application: input.application }),
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.workspace === undefined ? {} : { workspace: input.workspace }),
      source: input.source ?? "agent",
      confidence: clampConfidence(finiteNumber(input.confidence) ?? 0.8),
      sensitivity: redacted ? "private" : (input.sensitivity ?? "internal"),
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
      ...(expiresInDays === undefined
        ? inheritedExpiresAt === undefined
          ? {}
          : { expiresAt: inheritedExpiresAt }
        : { expiresAt: at + Math.max(0, expiresInDays) * 86400000 }),
      ...(input.metadata === undefined && !redacted
        ? {}
        : {
            metadata: {
              ...(metadata === undefined ? {} : (metadata.value as Readonly<Record<string, unknown>>)),
              ...(redacted || metadataRedacted ? { redacted: true } : {}),
            },
          }),
    }
    this.records = [...this.records.filter((candidate) => candidate.id !== record.id), record]
    this.prune(record.id)
    this.persist()
    return record
  }

  get(id: string): MemoryRecord | undefined {
    return this.records.find((record) => record.id === id)
  }

  list(limit = 50, includeExpired = false): MemoryRecord[] {
    const at = this.now()
    return this.records
      .filter((record) => includeExpired || record.expiresAt === undefined || record.expiresAt > at)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, Math.max(1, Math.min(limit, 500)))
  }

  search(query: MemoryQuery): MemoryRecord[] {
    const at = this.now()
    const limit = Math.max(1, Math.min(query.limit ?? 10, 100))
    const tags = query.tags ?? []
    return this.records
      .filter((record) => (query.includeExpired === true ? true : record.expiresAt === undefined || record.expiresAt > at))
      .filter((record) => (query.scope === undefined ? true : record.scope === query.scope))
      .filter((record) => (query.application === undefined ? true : record.application === query.application))
      .filter((record) => (query.key === undefined ? true : record.key === query.key))
      // Tag filtering is case-insensitive to match the scoring path.
      .filter((record) => (tags.length === 0 ? true : tags.every((tag) => (record.tags ?? []).some((candidate) => candidate.toLowerCase() === tag.toLowerCase()))))
      .map((record) => ({ record, value: score(record, query.query ?? "", tags) }))
      .filter((entry) => entry.value > 0)
      .sort((a, b) => b.value - a.value || b.record.updatedAt - a.record.updatedAt)
      .slice(0, limit)
      .map((entry) => entry.record)
  }

  remove(id: string): boolean {
    const next = this.records.filter((record) => record.id !== id)
    if (next.length === this.records.length) return false
    this.records = next
    this.persist()
    return true
  }

  forget(query: MemoryQuery): number {
    let removed = 0
    // Iterate instead of capping at the first 100 matches: a query can match
    // more records than one search page, and silently leaving them behind is
    // a privacy problem for "forget".
    for (;;) {
      const matching = new Set(this.search({ ...query, includeExpired: true, limit: 100 }).map((record) => record.id))
      if (matching.size === 0) break
      this.records = this.records.filter((record) => !matching.has(record.id))
      removed += matching.size
    }
    if (removed > 0) this.persist()
    return removed
  }

  stats(): MemoryStats {
    const at = this.now()
    const byScope: Record<string, number> = {}
    let expiringSoon = 0
    for (const record of this.records) {
      byScope[record.scope] = (byScope[record.scope] ?? 0) + 1
      if (record.expiresAt !== undefined && record.expiresAt > at && record.expiresAt - at < 7 * 86400000) {
        expiringSoon += 1
      }
    }
    return { total: this.records.length, byScope, expiringSoon }
  }

  get path(): string {
    return this.file
  }
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

// The rename that swapped the store in is only durable once the directory entry
// itself is on disk.
function fsyncDirectory(directory: string): void {
  const handle = openSync(directory, "r")
  try {
    fsyncSync(handle)
  } finally {
    closeSync(handle)
  }
}
