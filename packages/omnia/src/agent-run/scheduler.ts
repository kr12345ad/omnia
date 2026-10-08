// The scheduler loop: fires due scheduled runs through runHeadless and records
// each outcome back on the run. One tick at a time, one run at a time — an
// overdue queue drains in order rather than bursting every overdue run at once.
//
// Entitlement is NOT decided here: the caller passes a gate that must answer
// for every single execution, so a lapsed plan stops firing even if the entry
// was created while it was paid.

import { runHeadless, type HeadlessRunResult } from "./runner.js"
import { ScheduledRunStore, type ScheduledRun } from "./store.js"
import type { OpenCodeRunnerConfig } from "./client.js"

export interface SchedulerOptions {
  readonly config: OpenCodeRunnerConfig
  readonly store: ScheduledRunStore
  readonly tickMs?: number
  readonly timeoutMs?: number
  readonly now?: () => number
  readonly gate?: (run: ScheduledRun) => Promise<{ allowed: boolean; reason?: string }>
}

const DEFAULT_TICK_MS = 60_000
const DEFAULT_RUN_TIMEOUT_MS = 20 * 60 * 1000

export class RunScheduler {
  private timer: ReturnType<typeof setInterval> | undefined
  private ticking = false
  private readonly options: Required<Omit<SchedulerOptions, "gate">> & Pick<SchedulerOptions, "gate">

  constructor(options: SchedulerOptions) {
    this.options = {
      config: options.config,
      store: options.store,
      tickMs: options.tickMs ?? DEFAULT_TICK_MS,
      timeoutMs: options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
      now: options.now ?? Date.now,
      ...(options.gate === undefined ? {} : { gate: options.gate }),
    }
  }

  start(): void {
    if (this.timer !== undefined) return
    this.timer = setInterval(() => void this.tick().catch(() => undefined), this.options.tickMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer === undefined) return
    clearInterval(this.timer)
    this.timer = undefined
  }

  async tick(): Promise<number> {
    if (this.ticking) return 0
    this.ticking = true
    try {
      const due = this.options.store.due(this.options.now())
      let fired = 0
      for (const run of due) {
        // Refetch each run right before it fires: an entry disabled while the
        // previous one ran must not execute.
        const current = this.options.store.get(run.id)
        if (current === undefined || !current.enabled) continue
        const firedAt = this.options.now()
        const gate = this.options.gate === undefined ? { allowed: true } : await this.options.gate(current)
        let result: HeadlessRunResult
        if (gate.allowed !== true) {
          result = {
            ok: false,
            sessionId: "",
            error: gate.reason ?? "The plan does not include scheduled runs.",
            timedOut: false,
            elapsedMs: 0,
          }
        } else {
          result = await runHeadless(this.options.config, {
            prompt: current.prompt,
            title: current.name,
            timeoutMs: this.options.timeoutMs,
          }).catch((error: unknown) => ({
            ok: false as const,
            sessionId: "",
            error: error instanceof Error ? error.message : String(error),
            timedOut: false,
            elapsedMs: 0,
          }))
        }
        this.options.store.update(current.id, {
          lastFiredAt: firedAt,
          lastResult: {
            ok: result.ok,
            ...(result.sessionId.length > 0 ? { sessionId: result.sessionId } : {}),
            ...(result.ok ? {} : { error: result.error }),
            at: this.options.now(),
          },
        })
        fired += 1
      }
      return fired
    } finally {
      this.ticking = false
    }
  }
}
