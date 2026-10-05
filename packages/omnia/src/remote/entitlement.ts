// Billing enforcement for the remote wire layer.
//
// ../billing/client decides what a plan may do. This module used to keep its own
// copy of endpoint resolution, of the bearer and of the failure policy, and all
// three had drifted: `fromEnv` built `http://${host}` with NO port whenever
// OMNIA_SERVER_PORT was unset, so the desktop sidecar - which sets the URL and the
// token but no port - sent the bearer in cleartext to whatever answered on 80.
// That whole question now belongs to the canonical client, so this gate delegates
// it: resolveBillingEndpoint picks the origin, the bearer comes from the
// environment, and there is deliberately no constructor option for either. A
// caller-supplied endpoint is a way to aim somebody else's credential at a host of
// the caller's choosing, which is the same class of bug as the port guess.
//
// What is left here is what is genuinely the wire's own:
//
//   1. The computer allowance. A pairing claim (or a registration) past
//      PLANS[plan].computers is refused with a reason the operator can act on.
//      The count comes from GET /v1/computers, which is the server's own driver
//      list - the same list the desktop settings page shows - so the product has
//      exactly one notion of "registered computer" and this layer does not
//      invent a second.
//   2. The session ceiling for `remote_computer`. Remote control is INCLUDED on
//      free (it is what makes someone convert), so it is deliberately not a
//      refusal gate; the plan's sessionMinutes is what bounds it.
//
// The allowance's failure policy is asymmetric and stays here rather than in the
// client, because it is denominated in computers and not in a metered capability:
//
//   - A wire with no control plane token has no billing relationship to enforce.
//     Nothing is checked, and pairing is untouched.
//   - When the plan CANNOT be determined - unreachable control plane, 5xx,
//     unreadable answer, no profile - the allowance falls back to the FREE
//     allowance and no further. Failing open here means "up to three computers",
//     never "unlimited": a Stripe outage must not hand out computers, and it
//     must not brick the first three either.
//   - Unlimited is only ever reachable from a plan the control plane named,
//     because business and enterprise report Number.POSITIVE_INFINITY.
//
// The check runs BEFORE a pairing claim is sent, because the claim consumes the
// single-use pairing code: refusing afterwards would burn a code the operator
// can still use after upgrading.
//
// Refusals travel on the channels this wire already has, so nothing here invents
// a parallel reporting path: a pairing refusal is the claim endpoint's own
// { ok, error, code } shape, and a live-session refusal is a results message -
// the same message and the same typed `code` the server already settles pending
// calls from. The control plane emits its own computer.pairing_* /
// computer.disconnected events when it refuses a computer; this layer carries the
// same vocabulary and adds no channel of its own.

import { BillingClient, type BillingEnv } from "../billing/client"
import { PLANS, isPlanId, planFor, type Plan, type PlanId } from "../billing/plans"

/** The route that names the plan the asking profile is on. */
const ENTITLEMENT_PATH = "/v1/billing/entitlement"

/** The server's own registered driver list, which is what `computers` counts. */
const COMPUTERS_PATH = "/v1/computers"

/**
 * Short on purpose. This check sits in front of a pairing attempt, so a hung
 * control plane must not become the operator's latency; a slow answer simply
 * takes the failure policy below. The client's own ceiling is above this, so
 * asking for less is honoured and asking for more is not.
 */
export const REMOTE_ENTITLEMENT_TIMEOUT_MS = 2_000

/**
 * The wire's codes. `granted`/`computer_allowance_exceeded` are decisions;
 * `unconfigured` and `unconfirmed` are the two ways there was nothing to decide
 * against, and both still fail open rather than refusing a pairing.
 */
export type RemoteAllowanceCode = "granted" | "computer_allowance_exceeded" | "unconfigured" | "unconfirmed" | "limit_reached"

/** Where an answer came from, so a caller can always tell a decision from a fallback. */
export type RemoteAllowanceOrigin = "control-plane" | "fail-open" | "fail-closed" | "unconfigured"

export interface ComputerAllowanceDecision {
  readonly allowed: boolean
  readonly code: RemoteAllowanceCode
  /** The control plane's own sentence when it decided, or the fallback's. */
  readonly reason: string
  /** The plan the allowance came from: "free" whenever it could not be determined. */
  readonly plan: PlanId
  /** False when `plan` is a fallback rather than an answer the control plane gave. */
  readonly planKnown: boolean
  readonly allowance: number
  /** Registered computers on the control plane, or undefined if that could not be read. */
  readonly registered: number | undefined
  readonly origin: RemoteAllowanceOrigin
}

/** The typed code a session-limit refusal travels with on the results channel. */
export const REMOTE_SESSION_LIMIT_CODE = "session_limit_reached"

export interface RemoteSessionLimit {
  readonly minutes: number
  readonly reason: string
}

/**
 * The wall-clock ceiling on one uninterrupted remote session, in minutes.
 *
 * `undefined` means the plan does not bound a session at all (pro, business,
 * enterprise). A plan that could not be determined falls back to the free
 * ceiling: the pairing keeps working, the session is cut at the limit, and it
 * resumes.
 */
export function remoteSessionCeilingMinutes(plan?: PlanId): number | undefined {
  return planFor(plan).capabilities.remote_computer.sessionMinutes
}

/**
 * The session-limit refusal, or undefined while the session is inside its
 * ceiling. Pure, so the boundary is testable without an agent: a session that
 * reaches the limit exactly is over it.
 */
export function remoteSessionLimit(input: {
  readonly plan?: PlanId
  readonly startedAt: number
  readonly now: number
}): RemoteSessionLimit | undefined {
  const minutes = remoteSessionCeilingMinutes(input.plan)
  if (minutes === undefined) return undefined
  if (input.now - input.startedAt < minutes * 60_000) return undefined
  return {
    minutes,
    reason: remoteSessionEndedReason({ plan: input.plan, minutes, planKnown: input.plan !== undefined }),
  }
}

/**
 * Why a session ended, in the shape the operator reads it.
 *
 * "Resumable" is the load-bearing word: nothing was paired away and nothing was
 * half-run, so reconnecting continues the same pairing with a fresh window.
 */
export function remoteSessionEndedReason(input: {
  readonly plan?: PlanId
  readonly minutes: number
  readonly planKnown: boolean
}): string {
  const plan = planFor(input.plan)
  const cause = input.planKnown
    ? `This remote session reached the ${input.minutes} minute limit for the ${plan.id} plan.`
    : `The plan could not be confirmed, so the ${plan.id} limit of ${input.minutes} minutes applied and this remote session ended.`
  return `${cause} Nothing was run. Reconnect to start a new session.`
}

export interface RemoteEntitlementOptions {
  /**
   * The environment to read the control plane from: OMNIA_SERVER_URL, then
   * OMNIA_PUBLIC_URL, then a host with a REAL port, plus OMNIA_SERVER_TOKEN.
   *
   * There is deliberately no `endpoint` and no `token` option, here or on the
   * client. Pointing the wire at an arbitrary host is exactly what let a pairing
   * run send a credential somewhere it did not belong, and the pairing CLI hands
   * over an environment instead.
   */
  readonly env?: BillingEnv
  /** Entitlements are per profile; absent resolves the anonymous free plan. */
  readonly profileId?: string
  readonly timeoutMs?: number
  readonly http?: typeof fetch
  readonly log?: (message: string, meta?: Record<string, unknown>) => void
}

/**
 * What `fromEnv` takes, which is now the same thing.
 *
 * The name is kept because ./index.ts re-exports it and the pairing CLI reaches
 * for it. It no longer adds an `endpoint` of its own, because there is no longer
 * a second way to choose where the bearer goes.
 */
export type RemoteEntitlementEnvOptions = RemoteEntitlementOptions

export class RemoteEntitlementGate {
  private readonly billing: BillingClient
  private readonly log: (message: string, meta?: Record<string, unknown>) => void

  constructor(options: RemoteEntitlementOptions = {}) {
    this.log = options.log ?? (() => undefined)
    this.billing = new BillingClient({
      env: options.env,
      profileId: options.profileId,
      timeoutMs: options.timeoutMs ?? REMOTE_ENTITLEMENT_TIMEOUT_MS,
      http: options.http,
      log: this.log,
    })
  }

  /**
   * The gate as the environment configures it: OMNIA_SERVER_TOKEN is the
   * deployment's root credential and OMNIA_SERVER_URL/HOST/PORT is where this
   * process already reaches the server. Resolution is the client's, so a host
   * with no port is inert rather than a request to port 80.
   */
  static fromEnv(options: RemoteEntitlementEnvOptions = {}): RemoteEntitlementGate {
    return new RemoteEntitlementGate(options)
  }

  /** Where the control plane is, read-only: the resolver's answer, never a dial. */
  get endpoint(): string | undefined {
    return this.billing.endpoint
  }

  /** True when this wire can ask the control plane anything at all. */
  get configured(): boolean {
    return this.billing.configured
  }

  /**
   * Whether one more computer may be registered on this server.
   *
   * Fail-open rules, both deliberate:
   *
   *   - The plan is unknown: the FREE allowance applies and no further. An
   *     outage therefore still refuses the fourth computer instead of waving it
   *     through, and never widens to an unlimited allowance.
   *   - The count is unknown: the claim proceeds. An unreadable list cannot
   *     prove the allowance is spent, and the control plane enforces the same
   *     ceiling authoritatively when it receives the claim - refusing here would
   *     break pairing against a server that never opted into billing. The
   *     reason says so rather than reporting a clean pass.
   */
  async authorizeComputer(): Promise<ComputerAllowanceDecision> {
    if (!this.configured) {
      return {
        allowed: true,
        code: "unconfigured",
        reason: "This server is not billing-configured, so the computer allowance is not enforced here.",
        plan: "free",
        planKnown: false,
        allowance: PLANS.free.computers,
        registered: undefined,
        origin: "unconfigured",
      }
    }
    const [named, registered] = await Promise.all([this.askPlan(), this.askRegistered()])
    if (registered.revoked === true) {
      // The credential was rejected. Falling through to the free allowance here
      // would let a revoked token keep pairing computers.
      return {
        allowed: false,
        code: "computer_allowance_exceeded",
        reason: "This computer's credential was rejected by the control plane. Sign in again to pair.",
        plan: named?.id ?? "free",
        planKnown: named !== undefined,
        allowance: PLANS.free.computers,
        registered: undefined,
        origin: "control-plane",
      }
    }
    const plan = named ?? PLANS.free
    const allowance = named?.computers ?? PLANS.free.computers
    if (registered.count === undefined) {
      // This used to allow the claim outright. Combined with an unreadable list
      // being indistinguishable from a rejected credential - which is what let a
      // revoked token, or simply an unreachable control plane, bypass the
      // 3-computer allowance entirely - the ceiling could be walked straight past.
      // An unconfirmed count now gets the FREE allowance as its ceiling and no
      // more, which is still generous to a legitimate new user and no longer
      // unlimited.
      const unconfirmedCeiling = PLANS.free.computers
      const allowed = true
      return {
        allowed,
        code: allowed ? "unconfirmed" : "limit_reached",
        reason: allowed
          ? `The number of registered computers could not be read, so at most ${unconfirmedCeiling} computers may pair until the control plane is reachable.`
          : `The control plane could not confirm this computer's plan, so the free allowance of ${unconfirmedCeiling} computers applies. Sign in to pair more.`,
        plan: plan.id,
        planKnown: named !== undefined,
        allowance: unconfirmedCeiling,
        registered: undefined,
        origin: "fail-closed",
      }
    }
    const origin: RemoteAllowanceOrigin = named === undefined ? "fail-open" : "control-plane"
    const count = registered.count ?? 0
    if (count < allowance) {
      return {
        allowed: true,
        code: "granted",
        reason: `The ${plan.id} plan allows ${allowance} computers and ${count} are registered.`,
        plan: plan.id,
        planKnown: named !== undefined,
        allowance,
        registered: count,
        origin,
      }
    }
    this.log(`refused a pairing claim: ${count} computers are already registered against an allowance of ${allowance}`)
    const cause =
      named === undefined
        ? "The plan could not be confirmed, so the free plan's allowance applies."
        : `The ${plan.id} plan allows ${allowance} computers.`
    return {
      allowed: false,
      code: "computer_allowance_exceeded",
      reason: `${cause} This server already has ${count} registered computer${count === 1 ? "" : "s"}. Remove one or upgrade the plan before pairing another.`,
      plan: plan.id,
      planKnown: named !== undefined,
      allowance,
      registered: count,
      origin,
    }
  }

  private async askPlan(): Promise<Plan | undefined> {
    const read = await this.billing.read(ENTITLEMENT_PATH)
    // A rejected credential and an unreadable route are both "no plan was named
    // here"; askRegistered is what tells the two apart for the refusal below.
    if (read.status !== "ok" || !isPlanId(read.body.plan)) return undefined
    return planFor(read.body.plan)
  }

  /**
   * The control plane's own count. `/v1/computers` is the registered driver
   * list, which is what the plan's `computers` allowance is denominated in.
   */
  private async askRegistered(): Promise<{ count?: number; revoked?: boolean }> {
    const read = await this.billing.read(COMPUTERS_PATH)
    // `revoked` is a rejected credential, which is categorically different from
    // "the count could not be read": one of them must refuse the claim and the
    // other must not.
    if (read.status === "revoked") return { revoked: true }
    if (read.status !== "ok") return {}
    return Array.isArray(read.body.computers) ? { count: read.body.computers.length } : {}
  }
}