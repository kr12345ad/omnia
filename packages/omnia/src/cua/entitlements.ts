// Entitlement enforcement for the CUA / computer-use layer.
//
// This gate decides nothing about billing. It used to decide three things, and
// all three had their own answer here that disagreed with ../billing/client:
//
//   - WHERE the control plane is, resolved from the SHAPE of the environment: a
//     missing or unusable OMNIA_SERVER_PORT meant "this install is unconfigured",
//     so whether self-hosting enforced anything depended on which unrelated var
//     an operator happened to have set. It is the resolver's answer now.
//   - WHAT a status code means. 402 is the control plane's decision; a 5xx, a
//     timeout and an unreadable body are failures. The client's answer now.
//   - WHETHER a hard-metered capability is refused when billing cannot be
//     reached. The plan matrix's policy, evaluated against the plan the control
//     plane last named rather than against `free` - so a Pro customer's paid
//     feature is not stripped by our own disk error. The client's answer now.
//
// What is left here is the call-site discipline around that one client:
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
//   - Only a DEGRADED answer is cached, and only briefly, so a billing outage
//     adds no latency storm and recovers within the outage window. An install
//     with no control plane at all has no billing relationship to enforce, so
//     there is nothing to enforce against and observation keeps working.
//   - What may be metered at all is a fixed, named list (METERED_CAPABILITIES),
//     because the reliability contract keeps honest verification, ref
//     resolution, aim computation, stale-ref refusal and the centre-of-bounds
//     guess warning on every tier including free. A gate that could refuse
//     those would be the entitlement layer turning a safety feature off, so a
//     capability outside that list is refused here rather than answered.
//
// One client per SIGNED-IN PROFILE, resolved on every check rather than read once
// at construction. Entitlements are per profile, so a process that resolved the
// profile when it was built kept asking about whoever happened to be signed in
// then: after a sign-out and a sign-in the same process carried on charging the
// previous profile, and its outage cache - keyed by capability alone - served the
// new profile the previous one's refusal. Keying the client by the profile that is
// signed in right now fixes both, because the cache belongs to the client and the
// client belongs to the profile.

import { readFileSync } from "node:fs"
import { defaultGitHubAuthFile } from "../auth/github"
import { BillingClient, type BillingEntitlement, type BillingEnv, type BillingOrigin } from "../billing/client"
import type { Capability } from "../billing/plans"

/**
 * The capabilities this gate is allowed to meter: paid CAPACITY.
 *
 * `cloud_vision` is remote vision inference and `live_view` is a stream of
 * frames off a computer. Both have a per-unit cost, so both are metered.
 *
 * What is deliberately NOT on this list is the whole point. The reliability
 * contract (docs/computer-use-reliability.md) keeps honest verification, ref
 * resolution, aim computation, stale-ref refusal and the bounds-centre guess
 * warning on every tier including free, because a safety behaviour a refund can
 * switch off is not a safety behaviour. A capability that is not on this list
 * cannot be asked about here, so no call site can turn one of them into an
 * entitlement: `check` and `authorize` refuse the question instead of answering
 * it. Adding a capability to the plan matrix is therefore not enough to meter
 * it through this gate — promoting one is a decision somebody makes here, in
 * the open.
 */
export const METERED_CAPABILITIES: readonly Capability[] = ["cloud_vision", "live_view"]

/**
 * The reliability behaviours the contract keeps on every tier, including free.
 *
 * Named so the claim is checkable rather than assumed. Every one of them is
 * decided by the CUA engine and the computer-use service from what the screen
 * actually showed; none of them asks this gate anything, and
 * METERED_CAPABILITIES is what keeps it that way.
 */
export const ALWAYS_ON_RELIABILITY: readonly string[] = [
  "honest-verification",
  "ref-resolution",
  "aim-computation",
  "stale-ref-refusal",
  "center-guess-warning",
]

/**
 * Thrown when a call site tries to meter something that is not metered capacity.
 *
 * This is a bug at the call site rather than a billing outcome, so it is loud:
 * a silent `allowed: false` here would be exactly the entitlement layer
 * switching a safety feature off.
 */
export class UnmeteredCapabilityError extends Error {
  readonly capability: Capability

  constructor(capability: Capability) {
    super(`${capability} is not metered capacity, so the entitlement gate cannot refuse it.`)
    this.name = "UnmeteredCapabilityError"
    this.capability = capability
  }
}

export function isMeteredCapability(capability: Capability): boolean {
  return METERED_CAPABILITIES.includes(capability)
}

/**
 * How long a fallback answer is reused, handed to the client as its degraded TTL.
 *
 * Only degraded (failure-policy) answers are cached, so this cannot under-spend
 * an allowance; it just keeps a billing outage from adding a failed round trip
 * to every single action while it lasts.
 */
export const ENTITLEMENT_OUTAGE_TTL_MS = 5_000

/**
 * Short on purpose. An enforcement call sits in front of a user action, so a
 * hung control plane must not become the user's latency; a slow answer simply
 * falls back to the failure policy.
 */
export const ENTITLEMENT_TIMEOUT_MS = 2_000

/** Where an answer came from. A caller can always tell a decision from a fallback. */
export type EntitlementOrigin = BillingOrigin

/** One answer about one capability, exactly as the canonical client resolved it. */
export type EntitlementDecision = BillingEntitlement

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

export function isUnmeteredCapabilityError(value: unknown): value is UnmeteredCapabilityError {
  return value instanceof UnmeteredCapabilityError
}

export interface EntitlementGateOptions {
  /**
   * The environment to read the control plane from: OMNIA_SERVER_URL, then
   * OMNIA_PUBLIC_URL, then a host with a REAL port, plus OMNIA_SERVER_TOKEN.
   *
   * There is deliberately no `endpoint` and no `token` option, here or on the
   * client: an endpoint a caller chooses is a way to aim somebody else's bearer
   * at a host of the caller's choosing. A test or an embedding points this at a
   * different control plane by handing over an environment, as production does.
   */
  readonly env?: BillingEnv
  /** Entitlements are per profile; without one the control plane answers for free. */
  readonly profileId?: string
  readonly timeoutMs?: number
  readonly outageTtlMs?: number
  readonly http?: typeof fetch
  readonly now?: () => number
  /** Where the signed-in profile is read from when profileId is not supplied. */
  readonly authFile?: string
}

export class EntitlementGate {
  private readonly options: EntitlementGateOptions
  private readonly clients = new Map<string | undefined, BillingClient>()

  constructor(options: EntitlementGateOptions = {}) {
    this.options = options
  }

  /**
   * One control-plane answer for one action.
   *
   * A real decision is never reused: every call outside a metered lease asks, so a
   * burst of actions spends its own units and cannot quietly under-count an
   * allowance. The only thing cached is a degraded answer (see
   * ENTITLEMENT_OUTAGE_TTL_MS), and only for the profile it was resolved for.
   *
   * Only metered capacity reaches the control plane. Anything else is refused
   * here, loudly, rather than answered: see METERED_CAPABILITIES.
   */
  async check(capability: Capability): Promise<EntitlementDecision> {
    requireMeteredCapability(capability)
    return this.billing().check(capability)
  }

  /** Throws EntitlementRefusedError instead of returning a refusal. */
  async authorize(capability: Capability): Promise<EntitlementDecision> {
    const decision = await this.check(capability)
    if (!decision.allowed) throw new EntitlementRefusedError(decision)
    return decision
  }

  /** Drops every cached fallback answer; a real decision was never cached. */
  reset(): void {
    for (const client of this.clients.values()) client.reset()
  }

  /**
   * The client for whoever is signed in right now.
   *
   * Resolved per check, not per process: sign-in does not change inside one
   * process in a way that matters for anything else, and it matters enormously
   * for this. The remembered plan and the degraded-answer cache both live on the
   * client, so a client per profile keeps a previous profile's refusal from being
   * served to the next one.
   */
  private billing(): BillingClient {
    const profile = this.options.profileId ?? signedInProfileId(this.options.authFile ?? defaultGitHubAuthFile())
    const existing = this.clients.get(profile)
    if (existing !== undefined) return existing
    const client = new BillingClient({
      env: this.options.env,
      profileId: profile,
      timeoutMs: this.options.timeoutMs ?? ENTITLEMENT_TIMEOUT_MS,
      degradedTtlMs: this.options.outageTtlMs ?? ENTITLEMENT_OUTAGE_TTL_MS,
      http: this.options.http,
      now: this.options.now,
    })
    this.clients.set(profile, client)
    return client
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
 * this resolves from the environment on first use. Sharing the gate shares
 * nothing that is per profile: the gate reads the signed-in profile on every
 * check, so a sign-in after a sign-out is picked up even though the instance is
 * process-wide. The lead can still inject a configured gate instead.
 */
export function defaultEntitlementGate(): EntitlementGate {
  sharedGate ??= new EntitlementGate()
  return sharedGate
}

export function setDefaultEntitlementGate(gate: EntitlementGate | undefined): void {
  sharedGate = gate
}

/**
 * The numeric profile id from the signed-in auth file.
 *
 * Entitlements are resolved per profile, and the control plane ignores anything
 * that is not the id it wrote the subscription against, so an absent or
 * unreadable auth file means "no profile" (which resolves to the free plan)
 * rather than an error. Read per check rather than once per gate: the file is
 * rewritten on sign-in and sign-out, and a gate that read it at construction kept
 * billing whoever was signed in at the time.
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

/**
 * Refuses the question rather than answering it.
 *
 * A gate that answered for a non-metered capability would be the entitlement
 * layer switching a safety behaviour off — the one thing the reliability
 * contract forbids. It throws rather than returning a refusal so the bug is at
 * the call site, in development, instead of in front of a user.
 */
function requireMeteredCapability(capability: Capability): void {
  if (isMeteredCapability(capability)) return
  throw new UnmeteredCapabilityError(capability)
}