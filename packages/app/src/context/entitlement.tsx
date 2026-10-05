import { type Accessor, createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import type { PaywallDecision, PaywallOffer } from "@opencode-ai/ui/paywall"
import { usePlatform } from "./platform"

// The renderer's one view of what the signed-in account may do.
//
// The paywall component renders nothing without a decision, so a surface that
// reads its own is a surface that renders nothing when the read is slow, fails,
// or is simply forgotten. Every capability notice reads from here instead: one
// entitlement read per window, one metered read per capability, both cached, so
// mounting a notice cannot become a request storm.
//
// Every answer is optional on purpose. A signed-out profile, a server with no
// billing configured, and an unreachable control plane all read as "no answer",
// and no answer means no notice and no gate: enforcement is the server's job,
// and the UI must never bill somebody for our outage.

/** What the entitlement read answered about the account itself. */
export interface Entitlement {
  /**
   * Whether the server can take a payment at all.
   *
   * The response also names the plan the account is on and that plan's monthly
   * price. Neither is surfaced: a notice may only quote the plan being OFFERED
   * and what that plan costs, and the entitlement never names those.
   */
  readonly billingConfigured: boolean
}

export interface EntitlementSnapshot {
  /** What the account can be charged for, or undefined when it could not be read. */
  readonly account: Accessor<Entitlement | undefined>
  /** What to offer next to a refusal, or undefined when nothing can be offered. */
  readonly offer: Accessor<PaywallOffer | undefined>
  /**
   * Reads the metered decision for one capability, or returns the answer this
   * window already has. Never rejects: a failure resolves to undefined.
   */
  readonly check: (capability: string) => Promise<PaywallDecision | undefined>
  /** The last answer for one capability. */
  readonly decision: (capability: string) => PaywallDecision | undefined
  /** Whether the user closed this capability's notice. */
  readonly dismissed: (capability: string) => boolean
  /** Closes a capability's notice for the rest of the window. */
  readonly dismiss: (capability: string) => void
}

/**
 * The desktop preload owns the only billing path the renderer has. Everywhere
 * else - the browser build, a test, a server render - there is no bridge, which
 * is not a failure: there is simply nothing to say about the account.
 */
type BillingBridge = {
  entitlement(): Promise<unknown>
  check(capability: string): Promise<unknown>
  portal(): Promise<unknown>
}

/**
 * `window.api` is the desktop preload's shape, which the app package does not
 * own, so the billing half is narrowed here rather than assumed. The cast is
 * the one place the renderer names that bridge.
 */
function bridge(): BillingBridge | undefined {
  if (typeof window === "undefined") return undefined
  const billing = (window as unknown as { api?: { billing?: Partial<BillingBridge> } }).api?.billing
  if (!billing) return undefined
  const { entitlement, check, portal } = billing
  if (typeof entitlement !== "function") return undefined
  if (typeof check !== "function") return undefined
  if (typeof portal !== "function") return undefined
  return { entitlement, check, portal }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function num(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/**
 * The window-wide snapshot. Module scope on purpose: the point of this owner is
 * that no surface can start a second read, and a provider would have to be
 * mounted above every route to promise that.
 */
const [state, setState] = createStore({
  account: undefined as Entitlement | undefined,
  decisions: {} as Record<string, PaywallDecision>,
  dismissed: {} as Record<string, boolean>,
})

/** In-flight and answered metered reads, so a capability is asked once. */
const requested = new Map<string, Promise<PaywallDecision | undefined>>()
let accountRead: Promise<void> | undefined

/**
 * The metered decision, exactly as `POST /billing/check` answered it.
 *
 * A refusal is a decision and not a failure: the desktop side turns the 402 into
 * a value, so a refused capability still arrives here with the server's own
 * sentence. Anything that is not one of the three codes is treated as no answer
 * at all, because a code nobody recognises cannot be explained to anybody.
 */
function decisionState(value: unknown): PaywallDecision | undefined {
  if (!record(value)) return undefined
  const code = value.code
  if (code !== "granted" && code !== "limit_reached" && code !== "not_entitled") return undefined
  return {
    code,
    // Default to "hard" when the server does not say: a refusal must never be
    // dressed up as a soft fair-use notice, because that claims the feature
    // still works when it does not.
    metering: value.metering === "soft" ? "soft" : "hard",
    used: num(value.used),
    limit: num(value.limit),
    reason: typeof value.reason === "string" && value.reason.length > 0 ? value.reason : undefined,
  }
}

function entitlementState(value: unknown): Entitlement | undefined {
  if (!record(value)) return undefined
  return { billingConfigured: value.billingConfigured === true }
}

async function readEntitlement() {
  const billing = bridge()
  if (!billing) return undefined
  return entitlementState(await billing.entitlement().catch(() => undefined))
}

async function readDecision(capability: string) {
  const billing = bridge()
  if (!billing) return undefined
  return decisionState(await billing.check(capability).catch(() => undefined))
}

/**
 * Starts the single entitlement read, and re-arms it when the read failed so a
 * transient outage costs one missing notice rather than the whole window.
 */
function loadAccount() {
  if (accountRead) return
  accountRead = readEntitlement().then((value) => {
    if (value === undefined) accountRead = undefined
    setState("account", value)
  })
}

export function useEntitlement(): EntitlementSnapshot {
  const platform = usePlatform()
  loadAccount()

  const offer = createMemo<PaywallOffer | undefined>(() => {
    // Nothing is offered without a confirmed entitlement: a signed-out profile,
    // an unconfigured server and an unreachable one all mean the checkout would
    // be refused, and an upgrade button that quietly does nothing is worse than
    // an explanation on its own.
    if (!state.account?.billingConfigured) return undefined
    return { onUpgrade: () => openBillingPortal(platform) }
  })

  return {
    account: () => state.account,
    offer,
    check: (capability) => {
      const existing = requested.get(capability)
      if (existing) return existing
      const read = readDecision(capability)
      requested.set(capability, read)
      void read.then((value) => {
        // A failed read is forgotten rather than cached: nothing is gated on it,
        // so the next surface to ask is free to try again.
        if (value === undefined) requested.delete(capability)
        if (value !== undefined) setState("decisions", { [capability]: value })
      })
      return read
    },
    decision: (capability) => state.decisions[capability],
    dismissed: (capability) => state.dismissed[capability] ?? false,
    dismiss: (capability) => setState("dismissed", { [capability]: true }),
  }
}

/**
 * The decision for one capability, kept current for the life of the window.
 *
 * Asking is what starts the read, and the store is what a component renders, so
 * an answer that arrives after the first render simply appears. Undefined means
 * "not answered yet" or "could not be read"; both render nothing.
 */
export function useEntitlementDecision(capability: string): Accessor<PaywallDecision | undefined> {
  const entitlement = useEntitlement()
  void entitlement.check(capability)
  return () => entitlement.decision(capability)
}

/**
 * Billing hands back a URL rather than opening a tab itself, so the renderer
 * decides where it goes. A portal that cannot be reached leaves the notice
 * standing: the explanation is still true, and it is not the surface's job to
 * report the failure.
 */
function openBillingPortal(platform: ReturnType<typeof usePlatform>) {
  const billing = bridge()
  if (!billing) return
  void billing.portal().then(
    (url) => {
      if (typeof url !== "string" || url.length === 0) return
      platform.openExternal(url)
    },
    // A portal that cannot be reached leaves the notice standing: the
    // explanation is still true, and reporting the failure is the menu's job,
    // not this surface's.
    () => {},
  )
}
