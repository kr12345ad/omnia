// Billing enforcement for the remote wire layer.
//
// ../billing/plans is the only source of truth for what a plan may do, and the
// control plane is the only authority that can answer it. This module is the
// wire's side of that contract, and it enforces exactly two things:
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
// The failure policy is asymmetric and is inherited from the plan table rather
// than re-decided at each call site:
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

import { PLANS, isPlanId, planFor, type Plan, type PlanId } from "../billing/plans"

/**
 * Short on purpose. This check sits in front of a pairing attempt, so a hung
 * control plane must not become the operator's latency; a slow answer simply
 * takes the failure policy below.
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
  /** Control plane origin, e.g. http://127.0.0.1:4096. */
  readonly endpoint: string
  /**
   * A bearer the control plane accepts: the server token or a desktop client
   * token. Without one there is nothing to ask, and nothing is enforced here.
   */
  readonly token?: string
  /** Entitlements are per profile; absent resolves the anonymous free plan. */
  readonly profileId?: string
  readonly timeoutMs?: number
  readonly http?: typeof fetch
  readonly log?: (message: string) => void
}

export interface RemoteEntitlementEnvOptions extends Omit<RemoteEntitlementOptions, "endpoint"> {
  /** Overrides the endpoint the environment resolves. */
  readonly endpoint?: string
  readonly env?: Record<string, string | undefined>
}

export class RemoteEntitlementGate {
  private readonly endpoint: string
  private readonly token: string
  private readonly profile: string | undefined
  private readonly timeoutMs: number
  private readonly http: typeof fetch
  private readonly log: (message: string) => void

  constructor(options: RemoteEntitlementOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, "")
    this.token = options.token ?? ""
    // The control plane ignores a profile id that is not the numeric id it wrote
    // the subscription against, so an unusable one is dropped here rather than
    // spent on a request that could only ever answer 401.
    this.profile = isProfileId(options.profileId) ? options.profileId : undefined
    this.timeoutMs = options.timeoutMs ?? REMOTE_ENTITLEMENT_TIMEOUT_MS
    this.http = options.http ?? fetch
    this.log = options.log ?? (() => {})
  }

  /**
   * The gate as the environment configures it: OMNIA_SERVER_TOKEN is the
   * deployment's root credential, and OMNIA_SERVER_HOST/PORT is where this
   * process already reaches the server.
   */
  static fromEnv(options: RemoteEntitlementEnvOptions = {}): RemoteEntitlementGate {
    const env = options.env ?? process.env
    const token = options.token ?? env.OMNIA_SERVER_TOKEN
    const configured = options.endpoint ?? env.OMNIA_SERVER_URL
    if (configured !== undefined && configured.length > 0) {
      return new RemoteEntitlementGate({ ...stripEndpoint(options), endpoint: configured, token })
    }
    const port = env.OMNIA_SERVER_PORT
    const host = env.OMNIA_SERVER_HOST ?? "127.0.0.1"
    const number = Number(port)
    const resolved = port === undefined || port.length === 0 ? `http://${host}` : `http://${host}:${port}`
    return new RemoteEntitlementGate({
      ...stripEndpoint(options),
      endpoint: Number.isInteger(number) && number > 0 ? resolved : "",
      token,
    })
  }

  /** True when this wire can ask the control plane anything at all. */
  get configured(): boolean {
    return this.endpoint.length > 0 && this.token.length > 0
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
      // This used to allow the claim outright. Combined with askRegistered()
      // returning undefined for ANY non-2xx - including the 401 a revoked token
      // produces and the 402 a real refusal produces - the 3-computer allowance
      // could be bypassed entirely by making the control plane unreachable or by
      // revoking the token. An unconfirmed count now gets the FREE allowance as
      // its ceiling and no more, which is still generous to a legitimate new
      // user and no longer unlimited.
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
    const payload = await this.ask("/v1/billing/entitlement")
    if (payload === undefined) return undefined
    return isPlanId(payload.plan) ? planFor(payload.plan) : undefined
  }

  /**
   * The control plane's own count. `/v1/computers` is the registered driver
   * list, which is what the plan's `computers` allowance is denominated in.
   */
  private async askRegistered(): Promise<{ count?: number; revoked?: boolean }> {
    const payload = await this.ask("/v1/computers")
    if (payload === undefined) return {}
    // `ask` reports a rejected credential as {revoked:true}; that is categorically
    // different from "the count could not be read".
    if ("revoked" in payload) return { revoked: true }
    return Array.isArray(payload.computers) ? { count: payload.computers.length } : {}
  }

  // A 5xx, a 401 or an unreadable body are all "the control plane did not
  // decide", never a decision about this computer. A 402 would be a decision,
  // but neither route answers it here, so it falls through as unknown too.
  private async ask(path: string): Promise<Record<string, unknown> | undefined> {
    try {
      const response = await this.http(`${this.endpoint}${path}`, {
        method: "GET",
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(this.profile === undefined ? {} : { "x-omnia-profile": this.profile }),
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      // A 402 is a decision and a 401 means the credential is no longer valid;
      // neither is "the count is unknown", and collapsing them into undefined is
      // what let a revoked token bypass the allowance.
      if (response.status === 401 || response.status === 403) return { revoked: true }
      if (!response.ok) return undefined
      const payload: unknown = await response.json().catch(() => undefined)
      return isRecord(payload) ? payload : undefined
    } catch {
      return undefined
    }
  }
}

function stripEndpoint(options: RemoteEntitlementEnvOptions): Omit<RemoteEntitlementOptions, "endpoint"> {
  const { endpoint: _endpoint, env: _env, ...rest } = options
  return rest
}

function isProfileId(value: string | undefined): value is string {
  return value !== undefined && /^[0-9]{1,32}$/.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
