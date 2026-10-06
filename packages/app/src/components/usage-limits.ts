// The one place the entitlement response becomes a list somebody can read.
//
// Every number here is the server's. The plan, the computer allowance and each
// capability's used counter and ceiling arrive from
// GET /v1/billing/entitlement, and the period a ceiling resets on is read from
// the plan matrix the server enforces from (`PLANS[plan]`), so the words on this
// list cannot drift away from the number they describe. A per-capability table
// written out here would be a second copy of the plan's numbers, and a limit
// edited in one place and displayed in another is how a free tier ends up
// advertised as something it is not.
//
// Reading the period off the plan rather than off the capability id is also the
// only correct answer: the same capability is a daily budget on one plan and a
// monthly one on another, so an id-keyed table would be wrong on half the plans
// it claims to describe.
import { isPlanId, PLANS, type CapabilityRule, type MeteringPeriod } from "@opencode-ai/omnia/billing/plans"

/** The one row that is not a capability: the allowance denominated in computers. */
export const COMPUTERS = "computers"

export interface UsageLimit {
  /** A capability id off the response, or `COMPUTERS`. */
  readonly id: string
  /**
   * What the server has counted against the allowance, when it counts anything.
   *
   * Undefined for the computer allowance: that is a ceiling on how many
   * computers may be registered and no counter is kept against it, so this
   * surface shows the ceiling rather than a used count it had to invent.
   */
  readonly used?: number
  /**
   * undefined is unlimited, and never 0: Infinity has no JSON form, so the
   * server sends null for it, while a 0 means the plan does not include the
   * capability at all rather than that an allowance has been spent.
   */
  readonly limit?: number
  /**
   * What the ceiling resets on.
   *
   * Only missing when the response named a plan this build cannot resolve, and
   * then no period may be claimed: calling a daily budget "this month" is the
   * mistake this surface exists to prevent.
   */
  readonly period?: MeteringPeriod
  /** Wall-clock ceiling for one uninterrupted remote session, in minutes. */
  readonly sessionMinutes?: number
}

/**
 * Every allowance worth showing, in the order the server sent them.
 *
 * undefined means the response was not one: a signed-out profile, a server with
 * no billing configured and an unreachable control plane all read as "no
 * answer", and none of them may be filled in with a guess about the free tier.
 */
export function usageLimits(entitlement: unknown): UsageLimit[] | undefined {
  if (!record(entitlement)) return undefined
  const computers = ceiling(entitlement.computers)
  const capabilities = record(entitlement.capabilities) ? entitlement.capabilities : {}
  const rows = [
    // The computer allowance leads, because it is the first ceiling a new
    // account meets.
    ...(computers === undefined || computers === 0 ? [] : [{ id: COMPUTERS, limit: computers ?? undefined }]),
    ...Object.entries(capabilities).flatMap(([id, state]) => {
      if (!record(state)) return []
      const limit = ceiling(state.limit)
      // A ceiling of 0 is a capability the plan does not include, not an
      // allowance that is spent. The paywall explains a refusal where it
      // happens, and a settings list of zeroes reads as a broken product.
      if (limit === undefined || limit === 0) return []
      const rule = ruleOf(entitlement.plan, id)
      return [
        {
          id,
          used: count(state.used),
          limit: limit ?? undefined,
          period: rule?.period,
          sessionMinutes: rule?.sessionMinutes,
        },
      ]
    }),
  ]
  return rows.length > 0 ? rows : undefined
}

/**
 * A ceiling off the wire, where null is how Infinity arrives.
 *
 * JSON has no Infinity, so an unlimited allowance is sent as null and a reader
 * that treats it as 0 turns "no ceiling" into "nothing left".
 */
function ceiling(value: unknown): number | null | undefined {
  if (value === null) return null
  if (typeof value === "number" && Number.isFinite(value)) return value
  return undefined
}

/** A used counter, or undefined when the response counted nothing. */
function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * The rule the server enforces for one capability on the plan the response named.
 *
 * Own-property only, because the id came off the wire: `PLANS[plan].capabilities`
 * inherits from Object.prototype, where "constructor" is a function that would
 * otherwise read as an allowance.
 */
function ruleOf(plan: unknown, capability: string): CapabilityRule | undefined {
  if (!isPlanId(plan)) return undefined
  const rules = PLANS[plan].capabilities as Record<string, CapabilityRule>
  return Object.hasOwn(rules, capability) ? rules[capability] : undefined
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
