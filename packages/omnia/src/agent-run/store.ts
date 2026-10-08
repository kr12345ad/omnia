// Scheduled headless runs: the AI-employee loop. Each entry is a prompt the
// control plane fires on an interval against the paired opencode server, with
// no app window. Storage is a single JSON document like the other Omnia stores:
// atomic, owner-only, symlink-refusing, corrupt-tolerant.
//
// Schedules are deliberately intervals, not cron: an AI employee's cadence is
// "every N minutes/hours/days", and a cron parser is a second language to audit
// for no product value.

import { chmodSync, existsSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import { randomUUID } from "node:crypto"

export const RUN_LIMITS = {
  maxRuns: 20,
  maxPromptLength: 4_000,
  maxNameLength: 80,
  minIntervalMinutes: 15,
  maxIntervalMinutes: 7 * 24 * 60,
  maxTitleLength: 120,
} as const

export interface ScheduledRun {
  readonly id: string
  readonly profileId: string
  readonly name: string
  readonly prompt: string
  readonly intervalMinutes: number
  readonly enabled: boolean
  readonly createdAt: number
  readonly updatedAt: number
  readonly lastFiredAt?: number
  readonly lastResult?: {
    readonly ok: boolean
    readonly sessionId?: string
    readonly error?: string
    readonly at: number
  }
}

interface RunFile {
  readonly version: 1
  readonly runs: readonly ScheduledRun[]
}

export function defaultRunsFile(): string {
  return join(homedir(), ".local", "share", "omnia", "scheduled-runs.json")
}

export class ScheduledRunStore {
  readonly file: string

  constructor(options: { file?: string } = {}) {
    this.file = options.file ?? defaultRunsFile()
  }

  list(): ScheduledRun[] {
    const parsed = this.read()
    return [...(parsed?.runs ?? [])].sort((left, right) => left.createdAt - right.createdAt)
  }

  get(id: string): ScheduledRun | undefined {
    return this.list().find((run) => run.id === id)
  }

  save(input: {
    profileId: string
    name: string
    prompt: string
    intervalMinutes: number
    enabled?: boolean
  }): { ok: true; run: ScheduledRun } | { ok: false; error: string } {
    const error = validate(input)
    if (error !== undefined) return { ok: false, error }
    const parsed = this.read() ?? { version: 1 as const, runs: [] }
    if (parsed.runs.length >= RUN_LIMITS.maxRuns) {
      return { ok: false, error: `At most ${RUN_LIMITS.maxRuns} scheduled runs can exist.` }
    }
    const now = Date.now()
    const run: ScheduledRun = {
      id: randomUUID(),
      profileId: input.profileId,
      name: input.name.trim(),
      prompt: input.prompt.trim(),
      intervalMinutes: input.intervalMinutes,
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    }
    this.write({ version: 1, runs: [...parsed.runs, run] })
    return { ok: true, run }
  }

  update(
    id: string,
    patch: Partial<
      Pick<ScheduledRun, "name" | "prompt" | "intervalMinutes" | "enabled" | "lastFiredAt" | "lastResult">
    >,
  ): { ok: true; run: ScheduledRun } | { ok: false; error: string } {
    const parsed = this.read()
    if (parsed === undefined) return { ok: false, error: `Unknown scheduled run ${id}.` }
    const index = parsed.runs.findIndex((run) => run.id === id)
    if (index < 0) return { ok: false, error: `Unknown scheduled run ${id}.` }
    const current = parsed.runs[index]!
    const next: ScheduledRun = {
      ...current,
      ...patch,
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: Date.now(),
    }
    const error = validate(next)
    if (error !== undefined) return { ok: false, error }
    const runs = [...parsed.runs]
    runs[index] = next
    this.write({ version: 1, runs })
    return { ok: true, run: next }
  }

  remove(id: string): boolean {
    const parsed = this.read()
    if (parsed === undefined) return false
    const runs = parsed.runs.filter((run) => run.id !== id)
    if (runs.length === parsed.runs.length) return false
    this.write({ version: 1, runs })
    return true
  }

  /** Runs whose interval has elapsed since lastFiredAt (or creation). */
  due(now: number): ScheduledRun[] {
    return this.list().filter((run) => {
      if (!run.enabled) return false
      const since = run.lastFiredAt ?? run.createdAt
      return now - since >= run.intervalMinutes * 60_000
    })
  }

  private read(): RunFile | undefined {
    let stat: ReturnType<typeof lstatSync> | undefined
    try {
      stat = lstatSync(this.file)
    } catch {
      return undefined
    }
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.file, "utf8"))
    } catch {
      return undefined
    }
    if (typeof parsed !== "object" || parsed === null || (parsed as { version?: unknown }).version !== 1) return undefined
    const runs = (parsed as { runs?: unknown }).runs
    if (!Array.isArray(runs)) return undefined
    const valid = runs.filter(isRun)
    return { version: 1, runs: valid }
  }

  private write(file: RunFile): void {
    const existing = lstatSync(this.file, { throwIfNoEntry: false })
    if (existing?.isSymbolicLink()) throw new Error(`Refusing to write ${this.file} through a symlink`)
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    const temporary = join(dirname(this.file), `.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`)
    try {
      writeFileSync(temporary, JSON.stringify(file, null, 2), { mode: 0o600, flag: "wx" })
      chmodSync(temporary, 0o600)
      renameSync(temporary, this.file)
    } finally {
      rmSync(temporary, { force: true })
    }
  }
}

function isRun(value: unknown): value is ScheduledRun {
  if (typeof value !== "object" || value === null) return false
  const run = value as Record<string, unknown>
  return (
    typeof run.id === "string" &&
    typeof run.profileId === "string" &&
    run.profileId.length > 0 &&
    typeof run.name === "string" &&
    typeof run.prompt === "string" &&
    typeof run.intervalMinutes === "number" &&
    Number.isFinite(run.intervalMinutes) &&
    typeof run.enabled === "boolean" &&
    typeof run.createdAt === "number" &&
    typeof run.updatedAt === "number"
  )
}

function validate(input: {
  profileId?: string
  name?: string
  prompt?: string
  intervalMinutes?: number
}): string | undefined {
  const profileId = input.profileId?.trim() ?? ""
  if (profileId.length === 0) return "A scheduled run needs an owner."
  const name = input.name?.trim() ?? ""
  if (name.length === 0) return "A scheduled run needs a name."
  if (name.length > RUN_LIMITS.maxNameLength) return `The name is longer than ${RUN_LIMITS.maxNameLength} characters.`
  const prompt = input.prompt?.trim() ?? ""
  if (prompt.length === 0) return "A scheduled run needs a prompt."
  if (prompt.length > RUN_LIMITS.maxPromptLength) {
    return `The prompt is longer than ${RUN_LIMITS.maxPromptLength} characters.`
  }
  const interval = input.intervalMinutes
  if (typeof interval !== "number" || !Number.isFinite(interval)) return "The interval must be minutes as a number."
  if (interval < RUN_LIMITS.minIntervalMinutes || interval > RUN_LIMITS.maxIntervalMinutes) {
    return `The interval must be between ${RUN_LIMITS.minIntervalMinutes} and ${RUN_LIMITS.maxIntervalMinutes} minutes.`
  }
  return undefined
}

export function storeExistsSync(file: string): boolean {
  return existsSync(file)
}
