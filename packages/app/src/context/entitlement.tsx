import { type Accessor, createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import type { PaywallDecision, PaywallOffer } from "@opencode-ai/ui/paywall"
import { useLanguage } from "./language"
import { usePlatform } from "./platform"
import { friendlyErrorMessage } from "@/utils/error-message"
import { showToast } from "@/utils/toast"

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

/** What the entitlement read answered about one capability of the account. */
export interface EntitlementCapability {
  readonly allowed: boolean
  readonly code: PaywallDecision["code"] | "unknown"
  readonly used: number
  /**
   * The allowance, or undefined when there is no ceiling.
   *
   * Undefined is the honest reading of an unlimited plan: the server serialises
   * `Infinity` as null, and reading that as 0 would tell a Business subscriber
   * they have no allowance left on every capability they bought without limit.
   */
  readonly limit: number | undefined
}

/** What the entitlement read answered about the account itself. */
export interface Entitlement {
  /**
   * Whether the server can take a payment at all.
   *
   * The response also names the plan the account is on and that plan's monthly
   * price. Both are carried here so a notice can quote a real figure: nothing
   * below hardcodes a plan or a price, because a rename or a price change is a
   * server-side edit and a component that invents one is simply wrong.
   */
  readonly billingConfigured: boolean
  /** Plan id the server resolved for this profile, or undefined when it named none. */
  readonly plan: string | undefined
  /** What that plan costs a month, or 0 for a plan sold at no price. */
  readonly monthlyUsd: number
  /** Computers the plan covers, or undefined for unlimited. See `EntitlementCapability`. */
  readonly computers: number | undefined
  readonly capabilities: Readonly<Record<string, EntitlementCapability>>
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
 *
 * Checkout and the portal are both here because the CTA has to reach one of
 * them: a bridge that can only manage a subscription cannot sell one.
 */
type BillingBridge = {
  entitlement(): Promise<unknown>
  check(capability: string): Promise<unknown>
  checkout(plan: string): Promise<unknown>
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
  const { entitlement, check, checkout, portal } = billing
  if (typeof entitlement !== "function") return undefined
  if (typeof check !== "function") return undefined
  if (typeof checkout !== "function") return undefined
  if (typeof portal !== "function") return undefined
  return { entitlement, check, checkout, portal }
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
  return {
    billingConfigured: value.billingConfigured === true,
    plan: typeof value.plan === "string" && value.plan.length > 0 ? value.plan : undefined,
    monthlyUsd: num(value.monthlyUsd) ?? 0,
    computers: num(value.computers),
    capabilities: capabilityStates(value.capabilities),
  }
}

/** The plan the server resolved to nobody's subscription. */
const FREE_PLAN = "free"

/**
 * Whether this account has a subscription to manage.
 *
 * The portal route answers 404 for a profile with no subscription, because a
 * free profile has no Stripe customer. Sending a free profile there is what
 * made the Upgrade button do nothing at all for the one population that sees a
 * paywall, so the plan id - not the response's shape - decides which of the two
 * billing routes the CTA can actually use.
 */
function subscribed(account: Entitlement) {
  return account.plan !== undefined && account.plan !== FREE_PLAN
}

/**
 * One capability as the account-wide read answered it.
 *
 * `limit` keeps the null an unlimited plan arrives as rather than flattening it
 * to zero, for the reason in `EntitlementCapability`.
 */
function capabilityState(value: unknown): EntitlementCapability {
  const decision = decisionState(value)
  return {
    allowed: record(value) && value.allowed === true,
    code: decision?.code ?? "unknown",
    used: decision?.used ?? 0,
    limit: decision?.limit,
  }
}

function capabilityStates(value: unknown): Readonly<Record<string, EntitlementCapability>> {
  if (!record(value)) return {}
  return Object.fromEntries(Object.entries(value).map(([capability, state]) => [capability, capabilityState(state)]))
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
  const language = useLanguage()
  loadAccount()

  const offer = createMemo<PaywallOffer | undefined>(() => {
    // Nothing is offered without a confirmed entitlement: a signed-out profile,
    // an unconfigured server and an unreachable one all mean the checkout would
    // be refused, and an upgrade button that quietly does nothing is worse than
    // an explanation on its own.
    const account = state.account
    if (!account?.billingConfigured) return undefined
    return {
      // Quoted from the response rather than named here, so a plan rename or a
      // price change is a server-side edit. A plan the server prices at nothing
      // is not quoted at all: "$0" or "free" beside an Upgrade button is a figure
      // nobody can act on, and `Paywall` already has honest wording for an offer
      // that names no plan.
      plan: subscribed(account) ? account.plan : undefined,
      price: account.monthlyUsd > 0 ? formatUsd(account.monthlyUsd, language.locale()) : undefined,
      onUpgrade: () =>
        subscribed(account)
          ? openBilling(platform, language, (billing) => billing.portal())
          : openBilling(platform, language, (billing) => billing.checkout(CHECKOUT_PLAN)),
    }
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
 * The paid plan a single Upgrade button buys.
 *
 * A protocol value and not copy: `POST /billing/checkout` accepts only the paid
 * plan ids, and the desktop Account menu offers them in this same order. The
 * name and the price shown beside the button are the server's, never this.
 */
const CHECKOUT_PLAN = "pro"

/** What the plan costs, in the user's own locale and currency. */
function formatUsd(amount: number, locale: string) {
  return new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(amount)
}

/**
 * Runs a billing route and opens what it hands back.
 *
 * Billing returns a URL rather than opening a tab itself, so the renderer
 * decides where it goes. Both outcomes are reported: a URL that never arrives
 * and a request that is refused are the same thing to the person who clicked,
 * and swallowing either is what made this button do nothing at all.
 */
function openBilling(
  platform: ReturnType<typeof usePlatform>,
  language: ReturnType<typeof useLanguage>,
  request: (billing: BillingBridge) => Promise<unknown>,
) {
  const billing = bridge()
  if (!billing) return
  void request(billing).then(
    (url) => {
      if (typeof url === "string" && url.length > 0) {
        platform.openExternal(url)
        return
      }
      reportBillingFailure(language)
    },
    (error) => reportBillingFailure(language, error),
  )
}

/**
 * What a user is told when billing will not start.
 *
 * The server's own refusal is already a sentence somebody can act on, so it is
 * what gets shown; a transport failure is not, and `friendlyErrorMessage` maps
 * that to designed copy rather than a stack. Either way the notice stays
 * standing, because the explanation it gave is still true.
 */
function reportBillingFailure(language: ReturnType<typeof useLanguage>, error?: unknown) {
  showToast({
    variant: "error",
    title: language.t("desktop.billing.title"),
    description: friendlyErrorMessage(error, language.t, "desktop.billing.unreachable"),
  })
}

/**
 * Starts checkout for the plan a menu names.
 *
 * The paywall's own CTA uses `offer` because it offers one thing; a menu names
 * two plans, so it needs the direct form. Same request, same error reporting.
 */
export function checkoutPlan(
  platform: ReturnType<typeof usePlatform>,
  language: ReturnType<typeof useLanguage>,
  plan: "pro" | "business",
): void {
  openBilling(platform, language, (billing) => billing.checkout(plan))
}

/** Opens the billing portal for the current subscriber. */
export function openBillingPortal(
  platform: ReturnType<typeof usePlatform>,
  language: ReturnType<typeof useLanguage>,
): void {
  openBilling(platform, language, (billing) => billing.portal())
}
