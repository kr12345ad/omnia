import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { randomUUID } from "node:crypto"
import {
  MEMORY_SCOPES,
  type MemoryQuery,
  type MemoryRecord,
  type MemoryScope,
  type MemoryStats,
  type MemoryWriteInput,
} from "./types"

export const MEMORY_TEXT_LIMIT = 2000
export const MEMORY_MAX_RECORDS = 5000
export const MEMORY_FILE_VERSION = 1

const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*\S+/gi,
]

export function defaultMemoryFile(): string {
  return join(homedir(), ".local", "share", "omnia", "memories.json")
}

// Memories are the agent's durable notes: application quirks, procedures, and
// user preferences. Secrets are redacted before storage and every record
// carries scope, provenance, confidence, and optional expiry.
export function redactMemoryText(text: string): { text: string; redacted: boolean } {
  let redacted = false
  let value = text
  for (const pattern of SECRET_PATTERNS) {
    value = value.replace(pattern, () => {
      redacted = true
      return "[redacted]"
    })
  }
  return { text: value.slice(0, MEMORY_TEXT_LIMIT), redacted }
}

export function isMemoryScope(value: unknown): value is MemoryScope {
  return typeof value === "string" && (MEMORY_SCOPES as readonly string[]).includes(value)
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
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as { memories?: unknown }
      if (!Array.isArray(parsed.memories)) return
      this.records = parsed.memories.flatMap((item): MemoryRecord[] => {
        if (typeof item !== "object" || item === null) return []
        const record = item as MemoryRecord
        if (typeof record.id !== "string" || typeof record.text !== "string" || !isMemoryScope(record.scope)) return []
        return [record]
      })
    } catch {
      // A malformed file never takes the server down; it is replaced on next write.
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify({ version: MEMORY_FILE_VERSION, memories: this.records }, null, 2))
  }

  private prune(): void {
    if (this.records.length <= this.maxRecords) return
    this.records = [...this.records]
      .sort((a, b) => b.confidence - a.confidence || b.updatedAt - a.updatedAt)
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
      confidence: Math.max(0, Math.min(1, input.confidence ?? 0.8)),
      sensitivity: redacted ? "private" : (input.sensitivity ?? "internal"),
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
      ...(input.expiresInDays === undefined ? {} : { expiresAt: at + input.expiresInDays * 86400000 }),
      ...(input.metadata === undefined && !redacted
        ? {}
        : { metadata: { ...(input.metadata ?? {}), ...(redacted ? { redacted: true } : {}) } }),
    }
    this.records = [...this.records.filter((candidate) => candidate.id !== record.id), record]
    this.prune()
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
      .filter((record) => (tags.length === 0 ? true : tags.every((tag) => (record.tags ?? []).includes(tag))))
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
    const matching = new Set(this.search({ ...query, limit: 100 }).map((record) => record.id))
    if (matching.size === 0) return 0
    this.records = this.records.filter((record) => !matching.has(record.id))
    this.persist()
    return matching.size
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
