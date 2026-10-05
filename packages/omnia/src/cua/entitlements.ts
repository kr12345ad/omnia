// Entitlement enforcement for the CUA / computer-use layer.
//
// The plan matrix in ../billing/plans is the only source of truth for what a
// plan may do. Nothing here prices anything or knows what a plan costs; this
// file is only the call-site discipline around POST /v1/billing/check:
//
//   - ONE charge per user-initiated action. A decision is NEVER cached: each
//     action asks the control plane exactly once, so a metered allowance cannot
//     be quietly under-spent by a burst of actions. What keeps a hot loop out of
//     the money path is that the check sits on the ACTION boundary and the
//     metered thing a loop iterates over (a live-view frame) carries the
//     decision as a lease rather than asking again.
//   - A refusal is typed and specific: it names the capability and carries the
//     control plane's reason, so callers degrade deliberately instead of
//     returning a silent empty result.
//   - A transport failure is not a decision. When a control plane IS configured,
//     the plan matrix's own failure policy decides: a PAID capability
//     (hard-metered on free, so its usage counter cannot be trusted when
//     billing is unreachable) fails CLOSED, and a FREE capability fails OPEN so
//     a Stripe outage can never brick local observation. Those fallback answers
//     are the only thing cached, so an outage adds no latency storm and
//     recovers within the outage window. An install with no control plane at all
//     has no billing relationship to enforce, so there is nothing to enforce
//     against and observation keeps working.
import { readFileSync } from "node:fs"
import { defaultGitHubAuthFile } from "../auth/github"
import { failsClosed, type Capability } from "../billing/plans"

/**
 * How long a fallback answer is reused.
 *
 * Only degraded (failure-policy) answers are cached, so this cannot under-spend
 * an allowance; it just keeps a billing outage from adding a failed round trip
 * to every single action while it lasts.
 */
export const ENTITLEMENT_OUTAGE_TTL_MS = 5_000

/**
 * Short on purpose. An enforcement call sits in front of a user action, so a
 * hung control plane must not become the user's latency; a slow answer simply
 * falls back to the failure policy below.
 */
export const ENTITLEMENT_TIMEOUT_MS = 2_000

/** Where an answer came from. A caller can always tell a decision from a fallback. */
export type EntitlementOrigin = "control-plane" | "fail-open" | "fail-closed"

export interface EntitlementDecision {
  readonly capability: Capability
  readonly allowed: boolean
  /** The control plane's code, or the failure policy's own code. */
  readonly code: string
  readonly reason: string
  readonly origin: EntitlementOrigin
  /** True when this is the failure policy rather than a control-plane decision. */
  readonly degraded: boolean
  readonly plan?: string
  readonly metering?: "hard" | "soft"
  readonly used?: number
  readonly limit?: number
}

export class EntitlementRefusedError extends Error {
  readonly capability: Capability
  readonly decision: EntitlementDecision

  constructor(decision: EntitlementDecision) {
    super(`${decision.capability} was refused: ${decision.reason}`)
    this.name = "EntitlementRefusedError"
    this.capability = decision.capability
    this.decision = decision
  }
}

export function isEntitlementRefusedError(value: unknown): value is EntitlementRefusedError {
  return value instanceof EntitlementRefusedError
}

export interface EntitlementGateOptions {
  /** Control-plane base URL. Defaults to the origin this server is reachable at. */
  readonly endpoint?: string
  /** The server bearer token, when the control plane needs one. */
  readonly token?: string
  /** Entitlements are per profile; without one the control plane answers for free. */
  readonly profileId?: string
  readonly timeoutMs?: number
  readonly outageTtlMs?: number
  readonly http?: typeof fetch
  readonly now?: () => number
  readonly env?: NodeJS.ProcessEnv
  /** Where the signed-in profile is read from when profileId is not supplied. */
  readonly authFile?: string
}

interface CachedFallback {
  readonly at: number
  readonly decision: EntitlementDecision
}

export class EntitlementGate {
  private readonly options: EntitlementGateOptions
  private readonly http: typeof fetch
  private readonly now: () => number
  private readonly outageTtlMs: number
  private readonly profile: string | undefined
  private readonly fallbacks = new Map<Capability, CachedFallback>()

  constructor(options: EntitlementGateOptions = {}) {
    this.options = options
    this.http = options.http ?? fetch
    this.now = options.now ?? Date.now
    this.outageTtlMs = options.outageTtlMs ?? ENTITLEMENT_OUTAGE_TTL_MS
    this.profile = options.profileId ?? signedInProfileId(options.authFile ?? defaultGitHubAuthFile())
  }

  /**
 * One control-plane answer for one action.
 *
 * A real decision is never reused: every call outside a metered lease asks, so a
 * burst of actions spends its own units and cannot quietly under-count an
 * allowance. The only thing cached is a degraded answer (see
 * ENTITLEMENT_OUTAGE_TTL_MS).
 */
  async check(capability: Capability): Promise<EntitlementDecision> {
    const fallback = this.cachedFallback(capability)
    if (fallback !== undefined) return fallback
    const decision = await this.ask(capability)
    if (decision.degraded) this.fallbacks.set(capability, { at: this.now(), decision })
    return decision
  }

  /** Throws EntitlementRefusedError instead of returning a refusal. */
  async authorize(capability: Capability): Promise<EntitlementDecision> {
    const decision = await this.check(capability)
    if (!decision.allowed) throw new EntitlementRefusedError(decision)
    return decision
  }

  /** Drops cached fallback answers; a real decision was never cached. */
  reset(): void {
    this.fallbacks.clear()
  }

  private cachedFallback(capability: Capability): EntitlementDecision | undefined {
    const cached = this.fallbacks.get(capability)
    if (cached === undefined) return undefined
    if (this.now() - cached.at >= this.outageTtlMs) return undefined
    return cached.decision
  }

  private async ask(capability: Capability): Promise<EntitlementDecision> {
    const endpoint = this.endpoint()
    // No control plane to ask is not a billing outage: this install never opted
    // into billing, so there is no allowance to spend and nothing to enforce.
    if (endpoint === undefined) return unconfigured(capability)
    const env = this.options.env ?? process.env
    const token = this.options.token ?? env.OMNIA_SERVER_TOKEN
    try {
      const response = await this.http(`${endpoint}/v1/billing/check`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // The billing routes are behind the same credential as every other
          // route, so a check without one is refused by the control plane rather
          // than silently answered for the anonymous free plan.
          ...(token === undefined || token.length === 0 ? {} : { authorization: `Bearer ${token}` }),
          ...(this.profile === undefined ? {} : { "x-omnia-profile": this.profile }),
        },
        body: JSON.stringify({ capability, ...(this.profile === undefined ? {} : { profileId: this.profile }) }),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? ENTITLEMENT_TIMEOUT_MS),
      })
      // 402 is a refusal, not a transport failure: the route answers a refused
      // decision with Payment Required and a full decision body. A 5xx is the
      // control plane failing rather than deciding, and takes the policy below.
      if (response.status >= 500 || (!response.ok && response.status !== 402)) {
        return failurePolicy(capability, `the control plane answered HTTP ${response.status}`)
      }
      const parsed = parseDecision(capability, await response.json().catch(() => undefined))
      if (parsed === undefined) return failurePolicy(capability, "the control plane returned an unreadable decision")
      return parsed
    } catch (error) {
      return failurePolicy(capability, error instanceof Error ? error.message : "the control plane is unreachable")
    }
  }

  // The control plane is whoever this process already talks to: an explicit URL,
  // the public origin billing already uses for its own redirects, or the
  // loopback origin the server was started on.
  private endpoint(): string | undefined {
    const env = this.options.env ?? process.env
    const configured = this.options.endpoint ?? env.OMNIA_SERVER_URL ?? env.OMNIA_PUBLIC_URL
    if (configured !== undefined && configured.length > 0) return configured.replace(/\/+$/, "")
    const port = env.OMNIA_SERVER_PORT
    if (port === undefined || port.length === 0) return undefined
    const host = env.OMNIA_SERVER_HOST ?? "127.0.0.1"
    const number = Number(port)
    return Number.isInteger(number) && number > 0 ? `http://${host}:${number}` : undefined
  }
}

export function createEntitlementGate(options: EntitlementGateOptions = {}): EntitlementGate {
  return new EntitlementGate(options)
}

let sharedGate: EntitlementGate | undefined

/**
 * The process-wide gate used when a call site was not handed one.
 *
 * Enforcement must not depend on a wiring change in the server entrypoint, so
 * this resolves from the environment on first use. The lead can inject a
 * configured gate instead; the scope cache stays inside whichever gate is used.
 */
export function defaultEntitlementGate(): EntitlementGate {
  sharedGate ??= new EntitlementGate()
  return sharedGate
}

export function setDefaultEntitlementGate(gate: EntitlementGate | undefined): void {
  sharedGate = gate
}

function parseDecision(capability: Capability, body: unknown): EntitlementDecision | undefined {
  if (!isRecord(body) || typeof body.allowed !== "boolean") return undefined
  // The answer must be about the capability we asked about. Without this check a
  // single granted answer could be replayed for any capability, which matters
  // because the gate falls back to the plaintext http://host:port default.
  if (typeof body.capability === "string" && body.capability !== capability) return undefined
  return {
    capability,
    allowed: body.allowed,
    code:
      typeof body.code === "string" && body.code.length > 0 ? body.code : body.allowed ? "granted" : "not_entitled",
    reason:
      typeof body.reason === "string" && body.reason.length > 0
        ? body.reason
        : `${capability} was ${body.allowed ? "granted" : "refused"}.`,
    origin: "control-plane",
    degraded: false,
    ...(typeof body.plan === "string" ? { plan: body.plan } : {}),
    ...(body.metering === "hard" || body.metering === "soft" ? { metering: body.metering } : {}),
    ...(typeof body.used === "number" && Number.isFinite(body.used) ? { used: body.used } : {}),
    ...(typeof body.limit === "number" && Number.isFinite(body.limit) ? { limit: body.limit } : {}),
  }
}

/**
 * The failure policy, straight from the plan matrix.
 *
 * `failsClosed` is keyed off hard metering rather than off "is it paid": an
 * unreachable control plane means the usage counters are unknown, so a hard
 * allowance cannot be enforced and handing the request out would make an outage
 * an unlimited-usage bug. Soft allowances keep working on purpose.
 */
function failurePolicy(capability: Capability, cause: string): EntitlementDecision {
  if (failsClosed(capability)) {
    return {
      capability,
      allowed: false,
      code: "unknown",
      reason: `${capability} cannot be confirmed because ${cause}.`,
      origin: "fail-closed",
      degraded: true,
    }
  }
  return {
    capability,
    allowed: true,
    code: "unreachable",
    reason: `${capability} is allowed without a billing answer because ${cause}.`,
    origin: "fail-open",
    degraded: true,
  }
}

/**
 * An install with no billing behind it.
 *
 * There is no plan to resolve and no allowance to spend, so refusing would only
 * break a self-hosted or embedded install that never opted into billing. This is
 * the one answer that is not the plan matrix's failure policy, because there is
 * no enforcement call to apply it to.
 */
function unconfigured(capability: Capability): EntitlementDecision {
  return {
    capability,
    allowed: true,
    code: "unconfigured",
    reason: `${capability} was not checked because this install has no control plane.`,
    origin: "fail-open",
    degraded: true,
  }
}

/**
 * The numeric profile id from the signed-in auth file.
 *
 * Entitlements are resolved per profile, and the control plane ignores anything
 * that is not the id it wrote the subscription against, so an absent or
 * unreadable auth file means "no profile" (which resolves to the free plan)
 * rather than an error. Read once per gate: sign-in does not change inside one
 * process in any way that matters here.
 */
function signedInProfileId(file: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"))
    if (!isRecord(parsed) || !isRecord(parsed.profile)) return undefined
    return typeof parsed.profile.id === "number" && Number.isInteger(parsed.profile.id)
      ? String(parsed.profile.id)
      : undefined
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
