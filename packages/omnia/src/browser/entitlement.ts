// Billing enforcement for the browser layer.
//
// This gate does NOT decide anything about billing. It used to: it resolved its
// own endpoint, kept its own copy of the plan matrix's failure policy, and grew
// a third opinion on what a status code means - and it disagreed with the CUA
// gate, the remote wire and the canonical client in ../billing/client on all
// three. Every one of those questions has exactly one answer now, and that answer
// belongs to BillingClient, so this module delegates all of them: the endpoint
// comes from resolveBillingEndpoint, the bearer comes from the environment, 402 is
// a decision and a 5xx is a failure, and the failure policy is evaluated against
// the plan the control plane last named rather than against `free`.
//
// What is left here is what is genuinely the browser's own:
//
//   1. Counted per operation, not per node. A read that returns four hundred DOM
//      nodes, or a find that returns forty candidates, is one browser action.
//      Metering is attached to the operation boundary (navigate, click, type,
//      read, find, upload, download, ...) and never to the size of what an
//      operation returns - see OPERATION_SPAN.
//   2. vault_login is checked before the credential store is touched at all.
//      `vaultLogin` takes the reader as a thunk precisely so a refusal cannot
//      have already pulled a secret out of the vault: the only way to reach the
//      reader is through the gate, and the gate throws first. This is the gate
//      that stops the product being resold as a bot-as-a-service.
//   3. A refusal is an Error a transport can map, because a call site has to
//      distinguish "upgrade" (402) from "retry" (503). See BrowserEntitlementError.
//
// Nothing here ever sees a credential value, and it cannot: there is no option to
// supply an endpoint or a token, so the only credential in play is the one the
// client reads from the environment and sends to the host the environment names.

import { AsyncLocalStorage } from "node:async_hooks"
import { BillingClient, type BillingCode, type BillingEntitlement, type BillingEnv } from "../billing/client"
import type { Capability, PlanId } from "../billing/plans"

/** The control plane's answer, re-exported so browser call sites import it from here. */
export type EntitlementCode = BillingCode

/** One answer about one capability, as the canonical client resolved it. */
export type Entitlement = BillingEntitlement

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
  /**
   * The environment to read the control plane from.
   *
   * There is deliberately no `endpoint` and no `token` option, here or on the
   * client: a caller-supplied endpoint is a way to aim somebody else's bearer at
   * a host of the caller's choosing, which is the same class of bug as guessing
   * port 80. A test or an embedding points this at a different control plane by
   * handing over an environment, exactly as production does.
   */
  readonly env?: BillingEnv
  /** Entitlements are per profile; absent resolves to the anonymous free plan. */
  readonly profileId?: string
  /** The plan this gate is known to be on, for wiring that already resolved it. */
  readonly plan?: PlanId
  readonly timeoutMs?: number
  readonly log?: (message: string, meta?: Record<string, unknown>) => void
}

/**
 * The gate every browser capability check goes through.
 *
 * A composite action (a login reads the page, finds two fields, types twice,
 * submits) is one request as far as the plan is concerned, so `operation` charges
 * the capability once for the whole span - see OPERATION_SPAN.
 *
 * One BillingClient per gate, because the plan it last saw is shared state: that
 * remembered plan is what makes the failure policy follow the CURRENT plan rather
 * than keying itself off `free`, and a second client per call would forget it.
 */
export class BrowserEntitlementGate {
  private readonly billing: BillingClient

  constructor(options: BrowserEntitlementOptions = {}) {
    this.billing = new BillingClient(options)
  }

  /**
   * The gate as the environment configures it.
   *
   * Resolution is the client's: OMNIA_SERVER_URL, then OMNIA_PUBLIC_URL, then
   * host with a REAL port, and no guessing. An install with no token or no usable
   * endpoint has no control plane to ask, so the client answers `unconfigured`
   * and is inert - there is nothing to enforce against, and refusing every
   * browser action would break an install that never opted into billing.
   */
  static fromEnv(env: BillingEnv = process.env): BrowserEntitlementGate {
    return new BrowserEntitlementGate({ env })
  }

  /**
   * Where the control plane is, read-only.
   *
   * This is the resolver's answer for display and diagnosis, not a dial: there is
   * no setter and no option that sets it, so the only way to change where a bearer
   * goes is to change the environment.
   */
  get endpoint(): string | undefined {
    return this.billing.endpoint
  }

  /** True when this install has a control plane it can actually ask. */
  get configured(): boolean {
    return this.billing.configured
  }

  /**
   * One answer about one capability.
   *
   * The span check comes first and is the browser's own contribution: a nested
   * charge inside an operation returns the decision already made, which is what
   * keeps a 400-node read or a five-step login at one request. Everything after
   * that point - the request, the deadline, the status-code policy, the echo
   * check, the failure policy and its plan - belongs to the client.
   */
  async check(capability: Capability): Promise<Entitlement> {
    const span = OPERATION_SPAN.getStore()
    if (span !== undefined && span.capability === capability) return span.entitlement
    return this.billing.check(capability)
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