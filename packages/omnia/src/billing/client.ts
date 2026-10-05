// The one place an Omnia client asks the control plane what it is allowed to do.
//
// The question used to have four independent implementations - the browser gate,
// the CUA gate, the remote wire and an inline copy in the driver - and they did
// not agree with each other. One of them guessed port 80, one evaluated the
// failure policy against the free plan rather than the plan the customer paid
// for, one read a 500 as a decision, and one cached a refusal. This module is the
// single implementation all four delegate to, so the invariants below are stated
// once and hold everywhere:
//
//   1. ENDPOINT. OMNIA_SERVER_URL wins, then OMNIA_PUBLIC_URL, then host:port - and
//      the host:port form requires a real port. See resolveBillingEndpoint, which
//      is exported on its own because it is the logic that had the bug.
//   2. ENDPOINT AND TOKEN COME FROM THE ENVIRONMENT ONLY. There is deliberately no
//      constructor option for either. A caller-supplied endpoint is a way to aim
//      somebody else's bearer at a host of the caller's choosing, which is the
//      same class of bug as guessing port 80.
//   3. THE FAILURE POLICY IS THE PLAN MATRIX'S, EVALUATED AGAINST THE CURRENT
//      PLAN. `failsClosed(capability, plan)` decides, and `plan` is the one the
//      control plane last named - never `free` by default when we know better. A
//      hard allowance cannot be honoured with unknown counters and is refused; a
//      soft (fair-use) allowance is allowed. One direction bricks the app for a
//      paying customer, the other is an unmetered-usage hole.
//   4. A DECISION IS NOT A FAILURE. 2xx and 402 carry the control plane's actual
//      answer and are parsed as one. 5xx, a timeout, an unreadable body, and every
//      other status are failures and take the policy above.
//   5. THE REPLY MUST BE ABOUT THE CAPABILITY THAT WAS ASKED ABOUT. `allowed: true`
//      is honoured only when the body names the same capability, so a stale,
//      cached or proxied answer cannot grant a different one.
//   6. EVERY REQUEST IS TIME-BOUND. Every exchange, headers and body both, gets a
//      deadline the caller cannot raise past the ceiling - and the deadline is
//      raced against the transport as well as signalled to it, so even an
//      injected transport that ignores AbortSignal cannot hang a caller.
//   7. NO CREDENTIAL EVER APPEARS IN A RESULT, A REASON OR A LOG LINE. The body of
//      a request is the capability and the asking profile and nothing else, and
//      `log` is only ever handed a capability, a plan and a code.
//
// An install with no control plane is `unconfigured` and INERT, which is
// categorically different from a control plane that is configured but unreachable.
// Someone running Omnia locally with no billing has nothing to enforce against,
// and refusing every action would break an install that never opted in. Someone
// whose endpoint is unreachable or whose port is a typo does have a billing
// relationship, so the policy applies rather than an exemption.

import { failsClosed, isPlanId, planFor, type Capability, type Metered, type PlanId } from "./plans"

/** The environment this client reads. Only ever the environment - never a caller. */
export type BillingEnv = Record<string, string | undefined>

/** The one route every capability check goes to. */
export const BILLING_CHECK_PATH = "/v1/billing/check"

/**
 * Short on purpose: a check sits in front of a user action, so a hung control
 * plane must not become the user's latency. A slow answer takes the failure
 * policy instead.
 */
export const BILLING_TIMEOUT_MS = 2_000

/**
 * The ceiling on that deadline. A caller may ask for less, never for more: an
 * unbounded request is how one slow control plane becomes every user's hang.
 */
export const BILLING_MAX_TIMEOUT_MS = 30_000

/**
 * `granted`/`not_entitled`/`limit_reached` are the control plane's decisions.
 * `unreachable` is the failure policy's own code, and `unconfigured` is an
 * install with no control plane at all - three different things that must never
 * collapse into one, because "you are out of allowance", "we could not check"
 * and "you have not set billing up" call for three different responses.
 */
export type BillingCode = "granted" | "not_entitled" | "limit_reached" | "unknown" | "unreachable" | "unconfigured"

/** Where an answer came from, so a caller can always tell a decision from a fallback. */
export type BillingOrigin = "control-plane" | "fail-open" | "fail-closed" | "unconfigured"

export interface BillingEntitlement {
  readonly allowed: boolean
  readonly code: BillingCode
  readonly capability: Capability
  /** The plan this answer was resolved against. */
  readonly plan: PlanId
  /** False when `plan` is a fallback rather than one the control plane named. */
  readonly planKnown: boolean
  readonly used: number
  readonly limit: number
  /** Derived from the plan matrix, never taken from the wire. */
  readonly metering: Metered
  /** The control plane's own sentence, so a refusal is explicable in the UI. */
  readonly reason: string
  readonly origin: BillingOrigin
  /** True for the failure policy and for inertness; false only for a decision. */
  readonly degraded: boolean
}

export interface BillingClientOptions {
  readonly env?: BillingEnv
  /**
   * The signed-in profile the answer is about. The control plane only honours a
   * numeric id, so an unusable one is dropped rather than spent on a request that
   * could only ever answer for the anonymous free plan.
   */
  readonly profileId?: string
  /** The plan this client is known to be on, for wiring that already resolved it. */
  readonly plan?: PlanId
  readonly timeoutMs?: number
  readonly http?: typeof fetch
  readonly now?: () => number
  /** Receives capability, plan and code. Never the token, the endpoint or a body. */
  readonly log?: (message: string, meta?: Record<string, unknown>) => void
  /**
   * How long a DEGRADED answer is reused. 0 (the default) disables the cache.
   *
   * Only degraded answers are ever cached, so this cannot under-spend an
   * allowance; it keeps a billing outage from adding a failed round trip to every
   * single action for as long as the outage lasts. A real decision is never
   * cached, so a burst of actions always spends its own units.
   */
  readonly degradedTtlMs?: number
}

/** The result of an authenticated read of another billing route, for the remote wire. */
export type BillingRead =
  | { readonly status: "ok"; readonly body: Record<string, unknown> }
  /** 401/403: the credential is no longer valid. Not the same as "unreadable". */
  | { readonly status: "revoked" }
  | { readonly status: "failed" }
  | { readonly status: "unconfigured" }

/**
 * Where the control plane is, from the environment only.
 *
 * Precedence is OMNIA_SERVER_URL, then OMNIA_PUBLIC_URL (the origin billing already
 * uses for its own redirects), then host:port - and the host:port form requires a
 * real port. An empty value is skipped in the same way an absent one is.
 *
 * `undefined` means "no control plane", which callers must treat as inert rather
 * than as a failure. An unset, empty, non-numeric, zero or out-of-range port is
 * NEVER a request to use port 80: the desktop sidecar sets URL and TOKEN but no
 * PORT, so a guess here POSTed the bearer in cleartext to whatever answered on 80
 * and then reported every hard-metered capability as unreachable. A bug in this
 * function sends a credential to the wrong host, so it is exported on its own and
 * unit-tested directly rather than only through a gate.
 */
export function resolveBillingEndpoint(env: BillingEnv = process.env): string | undefined {
  for (const candidate of [env.OMNIA_SERVER_URL, env.OMNIA_PUBLIC_URL]) {
    const trimmed = candidate?.trim()
    if (trimmed !== undefined && trimmed.length > 0) return asOrigin(trimmed)
  }
  const port = env.OMNIA_SERVER_PORT?.trim()
  if (port === undefined || !/^\d{1,5}$/.test(port)) return undefined
  const number = Number(port)
  if (!Number.isInteger(number) || number < 1 || number > 65535) return undefined
  const host = env.OMNIA_SERVER_HOST?.trim()
  return asOrigin(`http://${host !== undefined && host.length > 0 ? host : "127.0.0.1"}:${number}`)
}

/**
 * The canonical entitlement client.
 *
 * One instance per process is the norm: the remembered plan is shared state, and
 * a second instance would not see what the first one learned.
 */
export class BillingClient {
  private readonly env: BillingEnv
  private readonly profile: string | undefined
  private readonly hint: PlanId | undefined
  private readonly timeoutMs: number
  private readonly http: typeof fetch
  private readonly now: () => number
  private readonly log: (message: string, meta?: Record<string, unknown>) => void
  private readonly degradedTtlMs: number
  private readonly degraded = new Map<Capability, { readonly at: number; readonly answer: BillingEntitlement }>()
  private observed: PlanId | undefined

  constructor(options: BillingClientOptions = {}) {
    this.env = options.env ?? process.env
    this.profile = profileId(options.profileId)
    this.hint = isPlanId(options.plan) ? options.plan : undefined
    this.timeoutMs = clampTimeout(options.timeoutMs ?? BILLING_TIMEOUT_MS)
    this.http = options.http ?? fetch
    this.now = options.now ?? Date.now
    this.log = options.log ?? (() => undefined)
    this.degradedTtlMs = Math.max(0, options.degradedTtlMs ?? 0)
  }

  get endpoint(): string | undefined {
    return resolveBillingEndpoint(this.env)
  }

  /** True when this client has a control plane it can actually ask. */
  get configured(): boolean {
    return this.credential() !== undefined && this.endpoint !== undefined
  }

  /**
   * The plan the failure policy is evaluated against.
   *
   * The control plane's last word wins, because that is the closest thing to the
   * current plan this process has; a wiring-supplied hint is next; free is the
   * floor. Keying this off `free` regardless is what stripped paid features from
   * paying customers during our own disk errors.
   */
  knownPlan(): PlanId {
    return this.observed ?? this.hint ?? "free"
  }

  /** Lets a gate that already resolved a plan feed the failure policy directly. */
  rememberPlan(plan: unknown): void {
    if (isPlanId(plan)) this.observed = plan
  }

  /** Drops cached degraded answers. A remembered plan is not an answer, so it stays. */
  reset(): void {
    this.degraded.clear()
  }

  /** One answer about one capability, with the failure policy already applied. */
  async check(capability: Capability): Promise<BillingEntitlement> {
    const cached = this.cachedDegraded(capability)
    if (cached !== undefined) return cached
    const answer = await this.ask(capability)
    if (answer.degraded && this.degradedTtlMs > 0) this.degraded.set(capability, { at: this.now(), answer })
    return answer
  }

  /**
   * An authenticated read of another billing route on the same control plane.
   *
   * The remote wire needs /v1/billing/entitlement and /v1/computers, and it needs
   * the same deadline, the same bearer and the same "a rejected credential is not
   * an unreadable one" distinction - without re-implementing the transport.
   */
  async read(path: string): Promise<BillingRead> {
    const token = this.credential()
    const endpoint = this.endpoint
    if (token === undefined) return { status: "unconfigured" }
    if (endpoint === undefined) return { status: "failed" }
    // A path is caller-supplied and the bearer is not, so only a plain path on
    // this origin is ever fetched. A full URL, or a protocol-relative "//host",
    // would aim the token at somebody else's host.
    if (!/^\/[A-Za-z0-9._~\/-]*$/.test(path) || path.startsWith("//")) return { status: "failed" }
    try {
      return await this.within(async (signal) => {
        const response = await this.http(`${endpoint}${path}`, {
          method: "GET",
          headers: {
            authorization: `Bearer ${token}`,
            ...(this.profile === undefined ? {} : { "x-omnia-profile": this.profile }),
          },
          signal,
        })
        if (response.status === 401 || response.status === 403) return { status: "revoked" }
        if (!response.ok) return { status: "failed" }
        const payload: unknown = await response.json().catch(() => undefined)
        return isRecord(payload) ? { status: "ok", body: payload } : { status: "failed" }
      })
    } catch {
      return { status: "failed" }
    }
  }

  private credential(): string | undefined {
    const token = this.env.OMNIA_SERVER_TOKEN
    return token === undefined || token.length === 0 ? undefined : token
  }

  private cachedDegraded(capability: Capability): BillingEntitlement | undefined {
    if (this.degradedTtlMs === 0) return undefined
    const cached = this.degraded.get(capability)
    if (cached === undefined) return undefined
    if (this.now() - cached.at >= this.degradedTtlMs) return undefined
    return cached.answer
  }

  private async ask(capability: Capability): Promise<BillingEntitlement> {
    const token = this.credential()
    const endpoint = this.endpoint
    // No token, or no usable endpoint, is not an outage. This install has no
    // control plane to ask, so there is no allowance to spend and nothing to
    // enforce: inert beats breaking an install that never opted into billing,
    // and inert beats guessing a port and shipping the bearer somewhere
    // unintended. A CONFIGURED control plane being unreachable is the failure
    // path below, and it is a different thing.
    if (token === undefined || endpoint === undefined) return inert(capability)
    let exchange: Exchange
    try {
      exchange = await this.within(async (signal) => {
        const response = await this.http(`${endpoint}${BILLING_CHECK_PATH}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            // Entitlements are per profile; the header and the body field are both
            // sent because the control plane reads whichever its credential allows.
            ...(this.profile === undefined ? {} : { "x-omnia-profile": this.profile }),
          },
          // The body is the capability and the asking profile, and nothing else:
          // no credential, no tab id, no computer id - nothing that would need
          // redacting before it is sent, logged or replayed.
          body: JSON.stringify({
            capability,
            ...(this.profile === undefined ? {} : { profileId: this.profile }),
          }),
          signal,
        })
        // 402 is a DECISION: the route answers a refused capability with Payment
        // Required and the full decision body, and that body is what the UI needs
        // to explain the refusal. A 5xx is the control plane failing rather than
        // deciding. So is every other unexpected status - a 400 for a capability it
        // does not check, a 401 from a revoked token, a proxy's 502 - and reading
        // any of those as "not entitled" lies to the customer about a limit they
        // never hit.
        if (response.status !== 402 && !response.ok) {
          return { kind: "failed" as const, cause: `the billing service answered HTTP ${response.status}` }
        }
        return { kind: "answered" as const, payload: await response.json().catch(() => undefined) }
      })
    } catch (error) {
      return this.failure(capability, transportCause(error, this.timeoutMs))
    }
    if (exchange.kind === "failed") return this.failure(capability, exchange.cause)
    const parsed = parseDecision(capability, exchange.payload)
    if (parsed.kind === "unrecognized") {
      return this.failure(capability, "the billing service returned an unreadable answer, or one about another capability")
    }
    if (parsed.kind === "server-unknown") {
      // The control plane could not read its own store. That is its failure policy
      // answering, and re-deriving it here keeps exactly one policy - this
      // client's - evaluated against the plan it just named.
      return this.failure(capability, "the billing service could not read its own billing store", parsed.plan)
    }
    this.observed = parsed.answer.plan
    return parsed.answer
  }

  /**
   * The failure policy, straight from the plan matrix.
   *
   * `failsClosed` is keyed off hard metering rather than off "is it paid": an
   * unreachable control plane means the usage counters are unknown, so a hard
   * allowance cannot be enforced and handing the request out would turn an outage
   * into unlimited usage. Soft allowances keep working on purpose.
   */
  private failure(capability: Capability, cause: string, plan?: PlanId): BillingEntitlement {
    const effective = plan ?? this.knownPlan()
    const rule = planFor(effective).capabilities[capability]
    const closed = failsClosed(capability, effective)
    if (closed) {
      this.log("refused a metered capability because billing state could not be confirmed", {
        capability,
        plan: effective,
      })
    }
    return {
      allowed: !closed,
      code: "unreachable",
      capability,
      plan: effective,
      // The plan here came from the control plane's own mouth at some point, which
      // is the whole reason the policy can be evaluated against it at all.
      planKnown: true,
      used: 0,
      limit: rule.limit,
      metering: rule.metering,
      reason: closed
        ? `${capability} could not be confirmed because ${cause}, so it is refused rather than served unmetered.`
        : `${capability} is allowed without a billing answer because ${cause}.`,
      origin: closed ? "fail-closed" : "fail-open",
      degraded: true,
    }
  }

  /**
   * Runs one exchange under a deadline the caller cannot raise.
   *
   * The signal goes to the transport AND the timeout is raced against it, because
   * an injected or exotic transport is not obliged to honour AbortSignal and a
   * hung control plane must never become a hung action.
   */
  private async within<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const signal = AbortSignal.timeout(this.timeoutMs)
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(timeoutError(this.timeoutMs)), this.timeoutMs)
    })
    try {
      return await Promise.race([run(signal), expired])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}

type Exchange = { readonly kind: "answered"; readonly payload: unknown } | { readonly kind: "failed"; readonly cause: string }

type ParsedAnswer =
  | { readonly kind: "decision"; readonly answer: BillingEntitlement }
  | { readonly kind: "server-unknown"; readonly plan: PlanId | undefined }
  | { readonly kind: "unrecognized" }

/**
 * Reads a decision out of the control plane's reply, treating the reply as
 * untrusted until it has been shown to be about this capability.
 */
function parseDecision(capability: Capability, payload: unknown): ParsedAnswer {
  if (!isRecord(payload)) return { kind: "unrecognized" }
  // The echo check, and it is REQUIRED rather than optional: an `allowed: true`
  // whose body does not name this capability could be a stale, cached or proxied
  // answer about a different one, and accepting it is how one grant leaks across
  // capabilities - including a hard-metered one.
  if (payload.capability !== capability) return { kind: "unrecognized" }
  if (typeof payload.allowed !== "boolean") return { kind: "unrecognized" }
  const code = payload.code
  if (code !== "granted" && code !== "not_entitled" && code !== "limit_reached" && code !== "unknown") {
    return { kind: "unrecognized" }
  }
  const allowed = payload.allowed
  // An unknown or future plan id resolves to free rather than to whatever was
  // claimed, so a bogus `plan` can neither widen the message shown to a user nor
  // widen the policy applied to them.
  const plan = isPlanId(payload.plan) ? payload.plan : undefined
  if (code === "unknown") return { kind: "server-unknown", plan }
  const effective = plan ?? "free"
  return {
    kind: "decision",
    answer: {
      allowed,
      code,
      capability,
      plan: effective,
      planKnown: plan !== undefined,
      used: typeof payload.used === "number" && Number.isFinite(payload.used) ? payload.used : 0,
      limit: typeof payload.limit === "number" && Number.isFinite(payload.limit) ? payload.limit : planFor(effective).capabilities[capability].limit,
      // Derived locally from the plan matrix, never taken from the wire. The plan
      // table is the only definition of what is hard-metered, so a reply claiming
      // "soft" cannot soften a capability the plan does not actually grant.
      metering: planFor(effective).capabilities[capability].metering,
      // The server's own sentence about this capability, carried through so a
      // refusal is explicable in the UI without re-deriving the wording. It cannot
      // contain a credential: the server never had one.
      reason:
        typeof payload.reason === "string" && payload.reason.length > 0
          ? payload.reason
          : `${capability} was ${allowed ? "granted" : "refused"}.`,
      origin: "control-plane",
      degraded: false,
    },
  }
}

/**
 * An install with no billing behind it.
 *
 * There is no plan to resolve and no allowance to spend, so refusing would only
 * break a self-hosted or embedded install that never opted into billing. This is
 * the one answer that is not the plan matrix's failure policy, because there is no
 * enforcement call to apply it to.
 */
function inert(capability: Capability): BillingEntitlement {
  const rule = planFor("free").capabilities[capability]
  return {
    allowed: true,
    code: "unconfigured",
    capability,
    plan: "free",
    planKnown: false,
    used: 0,
    limit: rule.limit,
    metering: rule.metering,
    reason: "Billing is not configured on this install, so there is nothing to enforce.",
    origin: "unconfigured",
    degraded: true,
  }
}

/** A parseable http/https origin, without trailing slashes. */
function asOrigin(value: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return undefined
  }
  // A non-http scheme, a query, a fragment or an embedded credential is never a
  // legitimate control-plane origin, and the value ends up in a request line.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined
  if (parsed.search.length > 0 || parsed.hash.length > 0 || parsed.username.length > 0 || parsed.password.length > 0) {
    return undefined
  }
  return value.replace(/\/+$/, "")
}

function clampTimeout(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return BILLING_TIMEOUT_MS
  return Math.min(Math.floor(value), BILLING_MAX_TIMEOUT_MS)
}

/**
 * The numeric profile id, or nothing.
 *
 * The control plane accepts a profile id only from the signed-in session or - for
 * the server token - from the header or body, and only if it is numeric. Sending
 * anything else buys the anonymous free plan, so it is dropped here instead.
 */
function profileId(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed !== undefined && /^[0-9]{1,32}$/.test(trimmed) ? trimmed : undefined
}

function timeoutError(timeoutMs: number): Error {
  const error = new Error(`the billing service did not answer within ${timeoutMs}ms`)
  error.name = "TimeoutError"
  return error
}

/**
 * What to tell the user about a transport failure.
 *
 * Only the deadline is worth naming. A transport error's own text is whatever the
 * platform said about a URL we would rather not put in a user-visible string, so
 * everything else gets one fixed sentence.
 */
function transportCause(error: unknown, timeoutMs: number): string {
  if (error instanceof Error && error.name === "TimeoutError") return timeoutError(timeoutMs).message
  return "the billing service could not be reached"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}