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
import { PLANS, planFor, failsClosed, type Capability, type Plan, type PlanId } from "./plans.js"
import { entitles, type StripeSubscription, type SubscriptionStatus } from "./stripe.js"

export interface SubscriptionRecord {
  readonly customerId: string
  readonly subscriptionId: string
  readonly status: SubscriptionStatus
  readonly plan: PlanId
  readonly profileId: string
  readonly currentPeriodEnd: number
}

export interface UsageRecord {
  /** Requests consumed per capability, keyed `capability:YYYY-MM`. */
  readonly counters: Readonly<Record<string, number>>
  /** Consecutive seconds of the longest session seen today, per capability. */
  readonly sessionSeconds: Readonly<Record<string, number>>
  readonly updatedAt: number
}

export interface BillingState {
  readonly subscriptions: readonly SubscriptionRecord[]
  readonly usage: Readonly<Record<string, UsageRecord>>
  /** Stripe event ids already folded in, so a replay cannot double count. */
  readonly processedEvents: readonly string[]
}

export const EMPTY_STATE: BillingState = { subscriptions: [], usage: {}, processedEvents: [] }

const MAX_PROCESSED_EVENTS = 1000
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

export function currentPeriod(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 7)
}

function counterKey(capability: Capability, period: string): string {
  return `${capability}:${period}`
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
      const sessionSeconds: Record<string, number> = {}
      if (isRecord(value.sessionSeconds)) {
        for (const [key, seconds] of Object.entries(value.sessionSeconds)) {
          if (key.length > 128) continue
          sessionSeconds[key] = Math.min(boundedCount(seconds), 7 * 24 * 3600)
        }
      }
      // A crafted state file must not be able to reach Object.prototype through
      // a profile id, or decide() would read inherited counters.
      if (profileId === "__proto__" || profileId === "constructor" || profileId === "prototype") continue
      usage[profileId] = { counters, sessionSeconds, updatedAt: boundedCount(value.updatedAt) }
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
  // The most generous live subscription wins, so two subscriptions on one
  // profile cannot downgrade each other by expiring.
  let best = PLANS.free
  for (const subscription of state.subscriptions) {
    if (subscription.profileId !== profileId) continue
    if (!entitles(subscription.status)) continue
    // 0 means "unknown period", not "eternal": an unknown period must not
    // entitle. Only a real future timestamp counts.
    if (!Number.isFinite(subscription.currentPeriodEnd) || subscription.currentPeriodEnd <= now) continue
    const candidate = planFor(subscription.plan)
    if (candidate.monthlyUsd >= best.monthlyUsd || rank(candidate) > rank(best)) best = candidate
  }
  return best
}

function rank(plan: Plan): number {
  return plan.monthlyUsd === 0 ? (plan.id === "free" ? 0 : 3) : plan.monthlyUsd
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
  const period = currentPeriod(now)
  const record = usageFor(state, profileId)
  const used = record === undefined ? 0 : (record.counters[counterKey(capability, period)] ?? 0)

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
        ? `${capability} is past its fair-use allowance (${used}/${rule.limit}); it still works on ${plan.id}.`
        : `${capability} has used its ${plan.id} allowance (${used}/${rule.limit}).`,
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
  const period = currentPeriod(now)
  const key = counterKey(capability, period)
  const previous = usageFor(state, profileId)
  const counters = { ...(previous?.counters ?? {}) }
  counters[key] = (counters[key] ?? 0) + 1
  if (profileId === "__proto__" || profileId === "constructor" || profileId === "prototype") return state
  const usage = {
    ...state.usage,
    [profileId]: { counters, sessionSeconds: previous?.sessionSeconds ?? {}, updatedAt: now },
  }
  return { ...state, usage }
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
    state: { ...state, subscriptions: [...others, next].slice(0, MAX_SUBSCRIPTIONS), processedEvents },
    changed: true,
    duplicate: false,
  }
}