// The durable half of client usage reporting, with no Electron in it.
//
// What leaves the machine, and what must not, is decided here: a turn is queued
// once per message id, a refused batch stays queued for the next attempt, and a
// build whose telemetry is turned off deletes its queue rather than sitting on
// it. `usage-report.ts` supplies the network call and the policy answer, which
// keeps this file testable without an app, a keychain or a server.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

export interface UsageEvent {
  /** Stable per-turn key, normally the assistant message id. */
  readonly key: string
  readonly model: string
  readonly provider?: string
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly costUsd?: number
  readonly durationMs?: number
  readonly sessionId?: string
  readonly tool?: string
  readonly computerId?: string
}

interface OutboxState {
  pending: UsageEvent[]
  seen: string[]
}

export interface UsageOutboxOptions {
  readonly file: string
  /** Deliver a batch. False means "not accepted, keep the queue". */
  send(events: UsageEvent[]): Promise<boolean>
  /** False means telemetry is off for this build: the queue is discarded. */
  allowed(): Promise<boolean>
  readonly batchSize?: number
  readonly maxPending?: number
  readonly maxSeen?: number
  readonly retryDelayMs?: number
  /** Injectable so a test can drive retries without waiting. */
  readonly schedule?: (task: () => void, delayMs: number) => void
}

export function createUsageOutbox(options: UsageOutboxOptions) {
  const batchSize = options.batchSize ?? 100
  const maxPending = options.maxPending ?? 1_000
  const maxSeen = options.maxSeen ?? 2_000
  const retryDelayMs = options.retryDelayMs ?? 60_000
  const schedule = options.schedule ?? ((task, delay) => void setTimeout(task, delay).unref?.())
  let state: OutboxState | undefined
  let flushing: Promise<void> | undefined
  let retryScheduled = false

  function load(): OutboxState {
    if (state !== undefined) return state
    if (!existsSync(options.file)) {
      state = { pending: [], seen: [] }
      return state
    }
    try {
      const parsed: unknown = JSON.parse(readFileSync(options.file, "utf8"))
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        const record = parsed as { pending?: unknown; seen?: unknown }
        state = {
          pending: Array.isArray(record.pending) ? record.pending.flatMap((entry) => normalize(entry) ?? []) : [],
          seen: Array.isArray(record.seen)
            ? record.seen.filter((entry): entry is string => typeof entry === "string")
            : [],
        }
        return state
      }
    } catch {
      // A damaged outbox is not worth failing a turn over; start clean.
    }
    state = { pending: [], seen: [] }
    return state
  }

  function save(): void {
    mkdirSync(dirname(options.file), { recursive: true })
    const temporary = `${options.file}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify(load()), { mode: 0o600 })
    renameSync(temporary, options.file)
    try {
      chmodSync(options.file, 0o600)
    } catch {
      // Best effort; the file was created 0600 anyway.
    }
  }

  function retry(): void {
    if (retryScheduled) return
    retryScheduled = true
    schedule(() => {
      retryScheduled = false
      void flush()
    }, retryDelayMs)
  }

  /**
   * Queue one turn. `queued: false` is the ordinary answer for a replay or a
   * turn this build has already reported.
   */
  function report(input: unknown): { queued: boolean; pending: number } {
    const event = normalize(input)
    const current = load()
    if (event === undefined || current.seen.includes(event.key)) {
      return { queued: false, pending: current.pending.length }
    }
    current.pending = [...current.pending, event].slice(-maxPending)
    current.seen = [...current.seen, event.key].slice(-maxSeen)
    save()
    return { queued: true, pending: current.pending.length }
  }

  async function flush(): Promise<void> {
    if (flushing !== undefined) return flushing
    flushing = run().finally(() => {
      flushing = undefined
    })
    return flushing
  }

  async function run(): Promise<void> {
    const current = load()
    if (current.pending.length === 0) return
    if (!(await options.allowed().catch(() => false))) {
      // Off is a deletion, not a deferral: withholding a turn the admin forbade
      // is the entire meaning of the switch.
      current.pending = []
      save()
      return
    }
    while (current.pending.length > 0) {
      const batch = current.pending.slice(0, batchSize)
      const accepted = await options.send(batch).catch(() => false)
      if (!accepted) {
        save()
        retry()
        return
      }
      const sent = new Set(batch.map((event) => event.key))
      current.pending = current.pending.filter((event) => !sent.has(event.key))
      save()
    }
  }

  return {
    report,
    flush,
    pending: () => load().pending.length,
  }
}

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed.slice(0, max)
}

function count(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined
  return Math.min(Math.floor(value), 100_000_000)
}

function money(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined
  return Math.min(value, 1_000_000)
}

/** Everything off the wire is data: keep the fields the server accepts, nothing else. */
function normalize(value: unknown): UsageEvent | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const key = text(record.key, 160)
  const model = text(record.model, 160)
  if (key === undefined || model === undefined) return undefined
  const provider = text(record.provider, 64)
  const durationMs = count(record.durationMs)
  const sessionId = text(record.sessionId, 128)
  const tool = text(record.tool, 64)
  const computerId = text(record.computerId, 128)
  return {
    key,
    model,
    ...(provider === undefined ? {} : { provider }),
    ...(count(record.inputTokens) === undefined ? {} : { inputTokens: count(record.inputTokens)! }),
    ...(count(record.outputTokens) === undefined ? {} : { outputTokens: count(record.outputTokens)! }),
    ...(money(record.costUsd) === undefined ? {} : { costUsd: money(record.costUsd)! }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(tool === undefined ? {} : { tool }),
    ...(computerId === undefined ? {} : { computerId }),
  }
}
