// What the free OpenCode Zen tier has left, as far as this client can honestly say.
//
// The free tier is metered per IP by the Zen gateway. The gateway publishes no
// usage endpoint and no remaining count, so the only number this client ever
// receives from it is the one attached to a refusal: nothing is left. Recording
// that refusal - and the instant the daily counter resets - is the difference
// between "usage is unknown" and "usage is zero".
//
// Nothing here invents a ceiling. A limit the gateway never sent would be a
// number this client made up, and a made-up allowance is worse than no
// allowance: it would advertise a free tier as something it is not.
import { createStore } from "solid-js/store"

export interface FreeZenLimit {
  /** When the gateway refused a free request. */
  readonly at: number
  /** UTC millis the daily free allowance resets. */
  readonly resetsAt: number
  /** The provider the refusal came from, as the session reported it. */
  readonly provider?: string
  /** The server's own sentence about the refusal, when it sent one. */
  readonly message?: string
}

const KEY = "opencode.free-zen.limit"

/**
 * The free limiter's daily counter resets at 00:00 UTC.
 *
 * `getRetryAfterDay` in the gateway is exactly the time until the next UTC
 * midnight, so this is the same instant its `retry-after` header names.
 */
export function freeZenResetsAt(at: number): number {
  const date = new Date(at)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1)
}

/**
 * The refusal carried by a session status, or undefined for every other status.
 *
 * The gateway answers a spent free allowance with a 429 whose body names
 * `FreeUsageLimitError`; the server turns that into a retry whose action names
 * `free_tier_limit`. That action is the only place the free tier's exhaustion is
 * stated as a value rather than as prose this client would have to parse.
 */
export function freeZenLimitFromStatus(status: unknown, now = Date.now()): FreeZenLimit | undefined {
  if (!record(status) || status.type !== "retry") return undefined
  // A status whose next retry is already in the past is a leftover from an
  // earlier run, not a refusal happening now. Treating it as current would date
  // the reset from today and hide a budget that has already come back.
  if (typeof status.next !== "number" || status.next <= now) return undefined
  const action = record(status.action) ? status.action : undefined
  if (action?.reason !== "free_tier_limit") return undefined
  return {
    at: now,
    resetsAt: freeZenResetsAt(now),
    ...(typeof action.provider === "string" && action.provider.length > 0 ? { provider: action.provider } : {}),
    ...(typeof action.message === "string" && action.message.length > 0 ? { message: action.message } : {}),
  }
}

const [state, setState] = createStore<{ limit: FreeZenLimit | undefined }>({ limit: load() })

/**
 * The refusal that still applies, or undefined once its day has reset.
 *
 * A spent allowance is not permanent: showing yesterday's refusal today would
 * tell someone they are out of requests they can make again.
 */
export function activeFreeZenLimit(now = Date.now()): FreeZenLimit | undefined {
  const limit = state.limit
  return limit !== undefined && limit.resetsAt > now ? limit : undefined
}

/** Records a refusal, replacing an older one, and keeps it across restarts. */
export function recordFreeZenLimit(limit: FreeZenLimit | undefined): void {
  if (limit === undefined) return
  setState("limit", limit)
  save(limit)
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function load(): FreeZenLimit | undefined {
  if (typeof localStorage === "undefined") return undefined
  try {
    const raw = localStorage.getItem(KEY)
    if (raw === null) return undefined
    const value: unknown = JSON.parse(raw)
    if (!record(value)) return undefined
    if (typeof value.at !== "number" || !Number.isFinite(value.at)) return undefined
    if (typeof value.resetsAt !== "number" || !Number.isFinite(value.resetsAt)) return undefined
    return {
      at: value.at,
      resetsAt: value.resetsAt,
      ...(typeof value.provider === "string" ? { provider: value.provider } : {}),
      ...(typeof value.message === "string" ? { message: value.message } : {}),
    }
  } catch {
    return undefined
  }
}

function save(limit: FreeZenLimit): void {
  if (typeof localStorage === "undefined") return
  try {
    localStorage.setItem(KEY, JSON.stringify(limit))
  } catch {
    // Storage can be unavailable or full; the in-memory record still applies to
    // this window, which is enough for the refusal to be shown while it lasts.
  }
}
