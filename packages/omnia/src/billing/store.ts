// Entitlement resolution and its on-disk record.
//
// Persistence follows the same rules the rest of the codebase uses for secrets:
// refuse to write through a symlink, write a private temp file, fsync it, rename
// it into place, and quarantine a file we cannot parse instead of overwriting
// somebody's data with an empty object.
//
// The failure policy is the important part, and it is deliberately asymmetric:
//
//   - A PAID capability with an unreadable store is refused. A disk error must
//     not become a revenue leak.
//   - A FREE capability with an unreadable store is allowed. A Stripe outage or
//     a missing file must not brick the app someone is already using.
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import { randomBytes } from "node:crypto"
import { PLANS, planFor, planTier, failsClosed, type Capability, type MeteringPeriod, type Plan, type PlanId } from "./plans.js"
import { entitles, type StripeSubscription, type SubscriptionStatus } from "./stripe.js"

export interface SubscriptionRecord {
  readonly customerId: string
  readonly subscriptionId: string
  readonly status: SubscriptionStatus
  readonly plan: PlanId
  readonly profileId: string
  readonly currentPeriodEnd: number
}

/**
 * A profile's usage.
 *
 * Request counters only. The free plan's two hour session ceiling is deliberately
 * NOT persisted here: it is enforced in remote/entitlement.ts from the wall clock
 * of the one live session (startedAt vs now), which needs no durable counter and
 * cannot be un-spent by editing a file. A `sessionSeconds` map used to sit here,
 * read by nothing and written by nothing, which read as enforcement that did not
 * exist - and a second mechanism would have been worse than none, because two
 * disagreeing answers to "is this session over" is how a ceiling gets bypassed.
 */
export interface UsageRecord {
  /**
   * Requests consumed per capability, keyed `capability:YYYY-MM` for a monthly
   * allowance and `capability:YYYY-MM-DD` for a daily one, per the rule's own
   * `period`.
   */
  readonly counters: Readonly<Record<string, number>>
  readonly updatedAt: number
}

export interface BillingState {
  readonly subscriptions: readonly SubscriptionRecord[]
  readonly usage: Readonly<Record<string, UsageRecord>>
  /** Stripe event ids already folded in, so a replay cannot double count. */
  readonly processedEvents: readonly string[]
}

export const EMPTY_STATE: BillingState = { subscriptions: [], usage: {}, processedEvents: [] }

/**
 * Stripe event ids remembered as already folded, newest kept.
 *
 * A captured (body, signature) pair is only replayable inside
 * SIGNATURE_TOLERANCE_SECONDS - 300s - so this set only has to outlive that
 * window; everything beyond it is kept out of caution, not because it is
 * reachable. Evicting an id needs 1000 NEW events folded into this same file
 * inside that same 300s, which is 3.3 events per second sustained on one billing
 * file, and each of them must carry a valid Stripe signature. That is not
 * something a replaying caller can arrange - only a deployment already folding
 * faster than Stripe emits events ever gets there - so the count stands rather
 * than being widened: every extra id is up to 255 bytes rewritten on every
 * single event, and a bigger number would not move a threshold nothing reaches.
 *
 * The 300s tolerance is NOT what stops Stripe's own redeliveries. Those arrive
 * hours apart and are signed with a fresh timestamp on each attempt, so they
 * verify and are stopped by this set instead - which is why it is a ring buffer
 * of ids rather than a timestamp comparison.
 */
const MAX_PROCESSED_EVENTS = 1000

/**
 * Subscription records per file. A parse-bomb guard on a file we did not write,
 * not a business limit.
 *
 * Which end each path trims from is deliberate and is NOT symmetric:
 *
 *   - Folding keeps the NEWEST. applySubscription appends the record it is
 *     folding, so trimming from the front (as this did) discarded the very event
 *     being applied whenever the cap bit, and a paid upgrade silently did not
 *     land. That was the bug worth fixing here.
 *   - Reading keeps the OLDEST, because the parse stops at the cap and the file
 *     is read in order. A file over the cap can therefore only reach that shape
 *     by hand, and it is self-healing: the next fold trims to the newest end.
 */
const MAX_SUBSCRIPTIONS = 5000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function boundedCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), 1e12) : 0
}

/**
 * Whether a billing file exists AND parsed.
 *
 * Callers need this because returning EMPTY_STATE for a corrupt file is
 * indistinguishable from "no subscriptions" - which made a corrupt file report
 * itself readable, so the fail-closed path never armed and the very next usage
 * write replaced the quarantined data with an empty store, destroying every
 * paid subscription with no alarm.
 */
export function billingStateReadable(file: string | undefined): boolean {
  // A missing file is not "unreadable": there is no subscription data, which is a
  // perfectly well understood state meaning the free plan. Treating it as a read
  // failure armed fail-closed on every fresh install and refused the very first
  // vault login for every new user.
  if (file === undefined || !existsSync(file)) return true
  // A symlink is refused outright, same as on the write path.
  if (lstatIsSymlink(file)) return false
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"))
    return isRecord(parsed)
  } catch {
    return false
  }
}

/**
 * The UTC calendar day a daily allowance resets on, `YYYY-MM-DD`.
 *
 * UTC on purpose, and the same clock as `currentPeriod`: a day that rolled over
 * on local time would let somebody move their budget window by changing timezone,
 * and it would put the daily and monthly keys on different calendars.
 */
export function currentDay(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10)
}

/** The billing month an allowance resets on, `YYYY-MM`. */
export function currentPeriod(now: number = Date.now()): string {
  return currentDay(now).slice(0, 7)
}

/**
 * The counter a capability is drawn from, which follows the rule's own period.
 *
 * The two shapes cannot collide: `capability:2026-01` (monthly) and
 * `capability:2026-01-15` (daily) are distinct keys, so switching a capability
 * between periods cannot read the other period's spend as this one's.
 */
function counterKey(capability: Capability, period: MeteringPeriod, now: number): string {
  return `${capability}:${period === "day" ? currentDay(now) : currentPeriod(now)}`
}

/**
 * Reads the billing state, treating anything unreadable as absent.
 *
 * A file that exists but does not parse is moved aside rather than deleted: a
 * half-written or hand-edited file should be recoverable, not destroyed.
 */
export function readBillingState(file: string | undefined, now: number = Date.now()): BillingState {
  if (file === undefined || !existsSync(file)) return EMPTY_STATE
  // Refuse to follow a symlink on read as well as on write. Reading through a
  // link would let anything that can write into the directory choose which file
  // becomes the billing state.
  if (lstatIsSymlink(file)) return EMPTY_STATE
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"))
  } catch {
    quarantine(file, now)
    return EMPTY_STATE
  }
  if (!isRecord(parsed)) {
    quarantine(file, now)
    return EMPTY_STATE
  }
  const subscriptions: SubscriptionRecord[] = []
  if (Array.isArray(parsed.subscriptions)) {
    for (const value of parsed.subscriptions) {
      if (!isRecord(value)) continue
      const { customerId, subscriptionId, status, profileId, currentPeriodEnd } = value
      if (
        typeof customerId !== "string" ||
        typeof subscriptionId !== "string" ||
        typeof status !== "string" ||
        typeof profileId !== "string" ||
        typeof currentPeriodEnd !== "number"
      ) {
        continue
      }
      subscriptions.push({
        customerId,
        subscriptionId,
        status: status as SubscriptionStatus,
        plan: planFor(value.plan).id,
        profileId,
        currentPeriodEnd,
      })
      if (subscriptions.length >= MAX_SUBSCRIPTIONS) break
    }
  }
  const usage: Record<string, UsageRecord> = {}
  if (isRecord(parsed.usage)) {
    for (const [profileId, value] of Object.entries(parsed.usage)) {
      if (!isRecord(value)) continue
      const counters: Record<string, number> = {}
      if (isRecord(value.counters)) {
        for (const [key, count] of Object.entries(value.counters)) {
          if (key.length > 128) continue
          counters[key] = boundedCount(count)
        }
      }
      // A crafted state file must not be able to reach Object.prototype through
      // a profile id, or decide() would read inherited counters.
      if (profileId === "__proto__" || profileId === "constructor" || profileId === "prototype") continue
      usage[profileId] = { counters, updatedAt: boundedCount(value.updatedAt) }
    }
  }
  const processedEvents = Array.isArray(parsed.processedEvents)
    ? parsed.processedEvents.filter((value): value is string => typeof value === "string" && value.length <= 255).slice(-MAX_PROCESSED_EVENTS)
    : []
  return { subscriptions, usage, processedEvents }
}

function quarantine(file: string, now: number): void {
  try {
    renameSync(file, `${file}.corrupt.${now}`)
  } catch {
    try {
      rmSync(file, { force: true })
    } catch {
      // Nothing further to try; the caller already treats this as absent.
    }
  }
}

/** Atomic, owner-only, symlink-refusing write. */
export function writeBillingState(file: string, state: BillingState): void {
  if (lstatIsSymlink(file)) throw new Error(`Refusing to write ${file} through a symlink.`)
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temp = join(dirname(file), `.${Date.now()}.${randomBytes(6).toString("hex")}.billing.tmp`)
  const handle = openSync(temp, "wx", 0o600)
  try {
    writeFileSync(handle, JSON.stringify(state))
    // Durability before the rename: a crash must leave either the old state or
    // the new one, never a truncated file that reads as "no subscriptions".
    try {
      fsyncSync(handle)
    } catch {
      // Not every filesystem supports fsync on a regular file; the rename is
      // still atomic, so this is durability, not correctness.
    }
  } finally {
    try {
      closeSync(handle)
    } catch {
      // The write already succeeded; a failed close must not mask it.
    }
  }
  chmodSync(temp, 0o600)
  renameSync(temp, file)
  chmodSync(file, 0o600)
}

function lstatIsSymlink(file: string): boolean {
  try {
    return lstatSync(file).isSymbolicLink()
  } catch {
    return false
  }
}

export type DecisionCode = "granted" | "limit_reached" | "not_entitled" | "unknown"

export interface Decision {
  readonly allowed: boolean
  readonly code: DecisionCode
  readonly plan: PlanId
  readonly capability: Capability
  readonly used: number
  readonly limit: number
  readonly metering: "hard" | "soft"
  readonly reason: string
}

export function resolvePlan(state: BillingState, profileId: string | undefined, now: number = Date.now()): Plan {
  if (profileId === undefined) return PLANS.free
  // The most generous live subscription wins, so two subscriptions on one profile
  // cannot downgrade each other by expiring. "Most generous" is the plan's tier
  // (plans.ts planTier), never its price and never the order the events arrived
  // in: this is a max over a total order, so folding the same subscriptions in
  // either order resolves to the same plan.
  let best = PLANS.free
  for (const subscription of state.subscriptions) {
    if (subscription.profileId !== profileId) continue
    if (!entitles(subscription.status)) continue
    // 0 means "unknown period", not "eternal": an unknown period must not
    // entitle. Only a real future timestamp counts.
    if (!Number.isFinite(subscription.currentPeriodEnd) || subscription.currentPeriodEnd <= now) continue
    const candidate = planFor(subscription.plan)
    if (planTier(candidate) > planTier(best)) best = candidate
  }
  return best
}

/**
 * The one function enforcement calls.
 *
 * `storeReadable` is passed in rather than inferred so a caller that hit an I/O
 * error can say so; that is what separates fail-closed from fail-open here.
 */
/**
 * Reads a profile's usage without ever walking the prototype chain.
 *
 * `usage["__proto__"]` on a plain object returns Object.prototype, whose
 * `counters` is undefined - so a caller-supplied profile id of "__proto__" threw
 * a TypeError inside decide() instead of being treated as no usage. Both lookups
 * go through here.
 */
function usageFor(state: BillingState, profileId: string | undefined): UsageRecord | undefined {
  if (profileId === undefined || profileId.length === 0) return undefined
  if (!Object.hasOwn(state.usage, profileId)) return undefined
  const record = state.usage[profileId]
  return record === undefined || record === null ? undefined : record
}

export function decide(
  state: BillingState,
  profileId: string | undefined,
  capability: Capability,
  options: { readonly now?: number; readonly storeReadable?: boolean } = {},
): Decision {
  const now = options.now ?? Date.now()
  const storeReadable = options.storeReadable ?? true
  const plan = resolvePlan(state, profileId, now)
  const rule = plan.capabilities[capability]
  const record = usageFor(state, profileId)
  const used = record === undefined ? 0 : (record.counters[counterKey(capability, rule.period, now)] ?? 0)
  // The refusal has to say which budget is spent, because on a daily rule it
  // comes back at midnight UTC and on a monthly one at the end of the period.
  const when = rule.period === "day" ? " today" : ""

  if (rule.limit === 0) {
    return {
      allowed: false,
      code: "not_entitled",
      plan: plan.id,
      capability,
      used,
      limit: 0,
      metering: rule.metering,
      reason: `${capability} is not included in the ${plan.id} plan.`,
    }
  }
  if (!storeReadable && failsClosed(capability, plan.id)) {
    return {
      allowed: false,
      code: "unknown",
      plan: plan.id,
      capability,
      used,
      limit: rule.limit,
      metering: rule.metering,
      reason: `Billing state is unavailable, so ${capability} cannot be confirmed on the ${plan.id} plan.`,
    }
  }
  if (used >= rule.limit && Number.isFinite(rule.limit)) {
    const allowed = rule.metering === "soft"
    return {
      allowed,
      code: allowed ? "limit_reached" : "limit_reached",
      plan: plan.id,
      capability,
      used,
      limit: rule.limit,
      metering: rule.metering,
      reason: allowed
        ? `${capability} is past its fair-use allowance${when} (${used}/${rule.limit}); it still works on ${plan.id}.`
        : `${capability} has used its ${plan.id} allowance${when} (${used}/${rule.limit}).`,
    }
  }
  return {
    allowed: true,
    code: "granted",
    plan: plan.id,
    capability,
    used,
    limit: rule.limit,
    metering: rule.metering,
    reason: `${capability} is included in the ${plan.id} plan.`,
  }
}

/** Records consumption. Returns a new state; the caller persists it. */
export function consume(
  state: BillingState,
  profileId: string | undefined,
  capability: Capability,
  options: { readonly now?: number } = {},
): BillingState {
  if (profileId === undefined) return state
  const now = options.now ?? Date.now()
  // Metered from the rule the plan actually has, so a spend is always recorded
  // against the counter the next decide() will read it from.
  const rule = resolvePlan(state, profileId, now).capabilities[capability]
  const key = counterKey(capability, rule.period, now)
  const previous = usageFor(state, profileId)
  const counters = Object.fromEntries(
    Object.entries(previous?.counters ?? {}).filter(([existing]) => !isElapsed(existing, capability, key)),
  )
  counters[key] = (counters[key] ?? 0) + 1
  if (profileId === "__proto__" || profileId === "constructor" || profileId === "prototype") return state
  const usage = {
    ...state.usage,
    [profileId]: { counters, updatedAt: now },
  }
  return { ...state, usage }
}

/**
 * True for a counter of `capability` from a period that has already ended.
 *
 * Period suffixes sort lexicographically within a shape, so a string compare is a
 * period compare (`browser_automation:2026-01` ends before
 * `browser_automation:2026-01-15`). Dropping elapsed keys matters more now that a
 * daily rule exists: the daily budget would otherwise leave one dead key per day
 * in the state file forever, and the first daily spend after the counter period
 * change is what clears the old monthly browser key.
 */
function isElapsed(key: string, capability: Capability, current: string): boolean {
  return key.startsWith(`${capability}:`) && key < current
}

/** Folds a subscription in, ignoring an event id that was already applied. */
export function applySubscription(
  state: BillingState,
  subscription: StripeSubscription,
  plan: PlanId,
  eventId: string,
): { state: BillingState; changed: boolean; duplicate: boolean } {
  if (state.processedEvents.includes(eventId)) return { state, changed: false, duplicate: true }
  // Keyed ONLY on subscriptionId. Evicting by profileId as well meant that when
  // Stripe sent an upgrade (sub_B) and then the cancellation of the old
  // subscription (sub_A), the late cancellation deleted sub_B and the customer
  // fell back to free while still being charged. Stripe does not guarantee
  // ordering, so the record for a subscription id is updated in place and every
  // other subscription is left alone.
  const others = state.subscriptions.filter((entry) => entry.subscriptionId !== subscription.subscriptionId)
  const next: SubscriptionRecord = {
    customerId: subscription.customerId,
    subscriptionId: subscription.subscriptionId,
    status: subscription.status,
    plan,
    profileId: subscription.profileId,
    currentPeriodEnd: subscription.currentPeriodEnd,
  }
  const processedEvents = [...state.processedEvents, eventId].slice(-MAX_PROCESSED_EVENTS)
  return {
    // Trimmed from the tail so the record being folded survives the cap; see
    // MAX_SUBSCRIPTIONS.
    state: { ...state, subscriptions: [...others, next].slice(-MAX_SUBSCRIPTIONS), processedEvents },
    changed: true,
    duplicate: false,
  }
}