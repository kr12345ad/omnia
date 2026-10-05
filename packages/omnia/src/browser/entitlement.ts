// Billing enforcement for the browser layer.
//
// Entitlements are resolved on the control plane (POST /v1/billing/check)
// because that is the only shared authority: the desktop app and the sidecar
// both ask it, and it is the only place that can count against a plan. This
// module is the browser's side of that contract - it asks before the work and
// refuses before the work, never after.
//
// Three properties matter here, and they are the reason this is not a single
// `if` at each call site:
//
//   1. Counted per operation, not per node. A read that returns four hundred
//      DOM nodes, or a find that returns forty candidates, is one browser
//      action. Metering is attached to the operation boundary (navigate, click,
//      type, read, find, upload, download, ...) and never to the size of what an
//      operation returns.
//   2. vault_login is checked before the credential store is touched at all.
//      `vaultLogin` takes the reader as a thunk precisely so a refusal cannot
//      have already pulled a secret out of the vault: the only way to reach the
//      reader is through the gate, and the gate throws first. This is the gate
//      that stops the product being resold as a bot-as-a-service.
//   3. The failure policy is asymmetric and is inherited from the plan table
//      rather than re-decided here. `failsClosed()` says a hard allowance cannot
//      be honoured when the counter is unknown, so a billing outage refuses a
//      hard-metered capability and lets a soft-metered one through. Getting this
//      backwards is a bug either way: one direction bricks the app, the other is
//      an unmetered-usage hole.
//
// Nothing here ever sees a credential value. Requests carry a capability name
// and nothing else, and a refusal is reported with the server's reason for that
// capability, so there is no code path that could put a secret in a log line or
// an error message - no secret is ever an argument.

import { AsyncLocalStorage } from "node:async_hooks"
import { failsClosed, isPlanId, planFor, type Capability, type Metered, type PlanId } from "../billing/plans"

/** The control plane's answer, narrowed to what a call site may branch on. */
export type EntitlementCode = "granted" | "not_entitled" | "limit_reached" | "unknown" | "unreachable" | "unconfigured"

export interface Entitlement {
  readonly allowed: boolean
  readonly code: EntitlementCode
  readonly capability: Capability
  readonly plan: PlanId
  readonly used: number
  readonly limit: number
  readonly metering: Metered
  readonly reason: string
}

/**
 * A refusal, carrying the decision that produced it.
 *
 * The code is what the transport layer maps to a status: an exhausted or
 * unentitled capability is 402 (the caller can fix it by upgrading) while an
 * unreadable billing store on a hard-metered capability is 503 (the caller can
 * fix it by retrying). The two must not collapse into one code, because "you
 * are out of allowance" and "we could not check" call for different responses.
 */
export class BrowserEntitlementError extends Error {
  readonly code: string
  readonly entitlement: Entitlement

  constructor(entitlement: Entitlement) {
    super(refusalMessage(entitlement))
    this.name = "BrowserEntitlementError"
    this.code =
      entitlement.code === "unknown" || entitlement.code === "unreachable" ? "billing_unavailable" : "billing_required"
    this.entitlement = entitlement
  }
}

function refusalMessage(entitlement: Entitlement): string {
  if (entitlement.code === "limit_reached") {
    return `${label(entitlement.capability)} has used its ${entitlement.plan} allowance (${entitlement.used}/${entitlement.limit}). Nothing was performed and no credential was read.`
  }
  if (entitlement.code === "unknown" || entitlement.code === "unreachable") {
    return `${label(entitlement.capability)} could not be confirmed because billing state is unavailable, so it is refused rather than served unmetered. Nothing was performed and no credential was read.`
  }
  if (entitlement.code === "not_entitled") {
    return `${label(entitlement.capability)} is not included in the ${entitlement.plan} plan. Nothing was performed and no credential was read.`
  }
  return `${label(entitlement.capability)} was refused. Nothing was performed and no credential was read.`
}

function label(capability: Capability): string {
  switch (capability) {
    case "browser_automation":
      return "Browser automation"
    case "vault_login":
      return "Signing in with a stored credential"
    case "credential_vault":
      return "Reading the credential vault"
    default:
      return capability
  }
}

/**
 * The span a composite action is running inside, if any.
 *
 * Module-scoped rather than per gate because the gate is not always the same
 * instance on both sides of an operation - the runtime holds one, the caller
 * holds another - and the span has to be visible to both or the internal calls
 * would each be charged again. Async-local rather than an instance field
 * because an instance field would let a second, unrelated action running
 * concurrently inherit the first one's free ride and go unmetered.
 */
const OPERATION_SPAN = new AsyncLocalStorage<{
  readonly capability: Capability
  readonly entitlement: Entitlement
}>()

export interface BrowserEntitlementOptions {
  /** Control plane origin, e.g. http://127.0.0.1:4096. Empty means unconfigured. */
  readonly endpoint?: string
  /** The server bearer token. Without it a check cannot be authenticated. */
  readonly token?: string
  /** Entitlements are per profile; absent resolves to the anonymous free plan. */
  readonly profileId?: string
  readonly timeoutMs?: number
  readonly log?: (message: string, meta?: Record<string, unknown>) => void
}

/**
 * The gate every browser capability check goes through.
 *
 * A composite action (a login reads the page, finds two fields, types twice,
 * submits) is one request as far as the plan is concerned, so `operation` charges
 * the capability once for the whole span - see OPERATION_SPAN.
 */
export class BrowserEntitlementGate {
  private readonly endpoint: string
  private readonly token: string
  private readonly profileId: string | undefined
  private readonly timeoutMs: number
  private readonly log: (message: string, meta?: Record<string, unknown>) => void

  constructor(options: BrowserEntitlementOptions = {}) {
    this.endpoint = (options.endpoint ?? "").replace(/\/+$/, "")
    this.token = options.token ?? ""
    this.profileId = options.profileId
    this.timeoutMs = options.timeoutMs ?? 5_000
    this.log = options.log ?? (() => undefined)
  }

  /**
   * The gate as the environment configures it.
   *
   * An install with no server token has no control plane to ask, so the gate is
   * `unconfigured` and inert: there is nothing to enforce against, and refusing
   * every browser action would break an install that never opted into billing.
   */
  static fromEnv(env: Record<string, string | undefined> = process.env): BrowserEntitlementGate {
    const token = env.OMNIA_SERVER_TOKEN ?? ""
    if (token.length === 0) return new BrowserEntitlementGate()
    // OMNIA_SERVER_URL wins, exactly as the CUA, remote and driver gates do.
    //
    // This used to build the endpoint from OMNIA_SERVER_HOST and only append a
    // port when OMNIA_SERVER_PORT was set. The desktop sidecar sets URL and
    // TOKEN but no PORT, so the gate POSTed to http://127.0.0.1 - port 80 - and
    // sent the bearer in cleartext to whatever happened to be listening there,
    // while every hard-metered capability came back "unreachable" and was
    // refused. A host:port guess must never be the fallback for a configured
    // URL, and an unset port must never silently mean port 80.
    const configured = env.OMNIA_SERVER_URL ?? env.OMNIA_PUBLIC_URL
    if (configured !== undefined && configured.length > 0) {
      return new BrowserEntitlementGate({ token, endpoint: configured })
    }
    const host = env.OMNIA_SERVER_HOST ?? "127.0.0.1"
    const port = env.OMNIA_SERVER_PORT
    if (port === undefined || port.length === 0 || !/^\d{1,5}$/.test(port)) {
      // No URL and no usable port: there is no control plane to ask. Inert beats
      // guessing a port and shipping the bearer somewhere unintended.
      return new BrowserEntitlementGate()
    }
    return new BrowserEntitlementGate({ token, endpoint: `http://${host}:${port}` })
  }

  /** True when a control plane was configured at all. */
  get configured(): boolean {
    return this.endpoint.length > 0 && this.token.length > 0
  }

  /** Asks the control plane, applying the plan's failure policy to transport errors. */
  async check(capability: Capability): Promise<Entitlement> {
    const span = OPERATION_SPAN.getStore()
    if (span !== undefined && span.capability === capability) return span.entitlement
    if (!this.configured) return unconfigured(capability)
    return this.ask(capability)
  }

  /** Throws a BrowserEntitlementError when the capability is refused. */
  async authorize(capability: Capability): Promise<Entitlement> {
    const entitlement = await this.check(capability)
    if (!entitlement.allowed) throw new BrowserEntitlementError(entitlement)
    return entitlement
  }

  /**
   * Charges one capability for a whole span of work.
   *
   * Nested charges for the same capability inside the span return the decision
   * already made, which is what keeps a 400-node read or a five-step login at
   * one request. A nested charge for a *different* capability is still charged:
   * vault_login must never ride along on a browser_automation span.
   */
  async operation<T>(capability: Capability, run: () => Promise<T>): Promise<T> {
    const outer = OPERATION_SPAN.getStore() === undefined
    const entitlement = await this.authorize(capability)
    if (!outer) return run()
    return OPERATION_SPAN.run({ capability, entitlement }, run)
  }

  /**
   * Signs in with a stored credential, reading the vault only once allowed.
   *
   * The reader is a thunk on purpose. A refusal throws before it is invoked, so
   * the credential store is provably untouched on the denied path: there is no
   * ordering for a caller to get wrong, and no window in which a secret is in
   * memory for a request that was never entitled to use it.
   */
  async vaultLogin<T>(read: () => T | Promise<T>): Promise<T> {
    await this.authorize("vault_login")
    return read()
  }

  /** The vault listing is metered separately from the logins it enables. */
  async vaultListing<T>(list: () => T | Promise<T>): Promise<T> {
    await this.authorize("credential_vault")
    return list()
  }

  private async ask(capability: Capability): Promise<Entitlement> {
    let response: Response
    try {
      response = await fetch(`${this.endpoint}/v1/billing/check`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
          // Entitlements are per profile; the header is what binds this check to
          // a subscription rather than to the anonymous free plan.
          ...(this.profileId === undefined ? {} : { "x-omnia-profile": this.profileId }),
        },
        // The body is the capability and nothing else: no credential, no tab id,
        // nothing that would need redacting before it is sent or logged.
        body: JSON.stringify({ capability }),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch {
      return this.unreachable(capability, "The billing service could not be reached.")
    }
    // A 5xx is the control plane failing, not a decision about this capability,
    // so it takes the same path as an unreachable socket rather than being read
    // as an answer. 402 is a real decision and is parsed below.
    if (response.status >= 500) {
      return this.unreachable(capability, "The billing service returned an error.")
    }
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      return this.unreachable(capability, "The billing service returned an unreadable answer.")
    }
    const decision = readDecision(payload, capability)
    if (decision === undefined) return this.unreachable(capability, "The billing service returned an unrecognized answer.")
    return decision
  }

  /**
   * A control plane we could not reach.
   *
   * The asymmetry is the whole point and it is not a judgement call made here:
   * `failsClosed` comes from the plan table, so a capability whose allowance is
   * hard cannot be honoured with an unknown counter and is refused, while a soft
   * (fair-use) allowance degrades to "still works".
   */
  private unreachable(capability: Capability, reason: string): Entitlement {
    const rule = planFor("free").capabilities[capability]
    const closed = failsClosed(capability)
    if (closed) this.log("refused a metered capability because billing state is unavailable", { capability })
    return {
      allowed: !closed,
      code: "unreachable",
      capability,
      plan: "free",
      used: 0,
      limit: rule.limit,
      metering: rule.metering,
      reason: closed ? reason : `${reason} Failing open to the free plan.`,
    }
  }
}

function unconfigured(capability: Capability): Entitlement {
  const rule = planFor("free").capabilities[capability]
  return {
    allowed: true,
    code: "unconfigured",
    capability,
    plan: "free",
    used: 0,
    limit: rule.limit,
    metering: rule.metering,
    reason: "Billing is not configured on this install.",
  }
}

/**
 * Reads a decision out of the control plane's reply.
 *
 * The reply is untrusted: an `allowed: true` is honoured only when the shape
 * also agrees about which capability it is talking about, so a stale or proxied
 * answer for a different capability cannot grant this one.
 */
function readDecision(payload: unknown, capability: Capability): Entitlement | undefined {
  if (typeof payload !== "object" || payload === null) return undefined
  const record = payload as Record<string, unknown>
  if (record.capability !== capability) return undefined
  if (typeof record.allowed !== "boolean") return undefined
  const code = record.code
  if (code !== "granted" && code !== "not_entitled" && code !== "limit_reached" && code !== "unknown") return undefined
  const rule = planFor("free").capabilities[capability]
  return {
    allowed: record.allowed,
    code,
    capability,
    // An unknown plan id resolves to free rather than to whatever was claimed,
    // so a bogus `plan` cannot widen the message a caller is shown.
    plan: isPlanId(record.plan) ? record.plan : "free",
    used: typeof record.used === "number" ? record.used : 0,
    limit: typeof record.limit === "number" ? record.limit : rule.limit,
    metering: record.metering === "soft" ? "soft" : "hard",
    // The reason is the server's own sentence about a capability. It cannot
    // contain a credential: the server never had one.
    reason: typeof record.reason === "string" && record.reason.length > 0 ? record.reason : "Refused by billing.",
  }
}

/**
 * The operations that count against the browser automation allowance.
 *
 * Page-driving and page-reading work is metered; tab lifecycle and readiness
 * introspection are not, because the UI polls those without the user having
 * driven anything and charging for a status read would spend an allowance on
 * work nobody asked for.
 */
export const METERED_BROWSER_OPERATIONS = [
  "open",
  "navigate",
  "back",
  "forward",
  "reload",
  "read",
  "find",
  "click",
  "hover",
  "select",
  "drag",
  "type",
  "value",
  "key",
  "scroll",
  "screenshot",
  "images",
  "saveImage",
  "upload",
  "downloads",
  "handleDialog",
  "answerAuth",
] as const

export type MeteredBrowserOperation = (typeof METERED_BROWSER_OPERATIONS)[number]