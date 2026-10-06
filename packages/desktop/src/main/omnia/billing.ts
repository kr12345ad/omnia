// The desktop side of billing.
//
// Every call goes through the control-plane client, so the signed-in session's
// client token and control-plane URL are the ones billing is read and written
// with. There is no second fetch path here: a client that asked Stripe or a
// local server directly would be answering a question about a different
// account than the one the user signed in to.
//
// Entitlements are the control plane's answer, never a local guess. The plan id,
// whether Stripe is configured at all, and whether an upgrade is even worth
// offering all come from GET /v1/billing/entitlement, the one call that can
// answer them.
import { ipcMain } from "electron"
import { PLANS, isPlanId, type Capability, type PlanId } from "@opencode-ai/omnia/billing/plans"
import type { DecisionCode } from "@opencode-ai/omnia/billing/store"
import { ControlPlaneRequestError, controlPlaneAuth, controlPlaneRequest } from "./control-plane"
import { readSessionProfileId } from "./auth-session"

export const BILLING_CHANNELS = {
  entitlement: "billing-entitlement",
  check: "billing-check",
  checkout: "billing-checkout",
  portal: "billing-portal",
} as const

/** The plans a checkout session can be created for. */
export type CheckoutPlan = "pro" | "business"

export interface BillingCapabilityState {
  readonly allowed: boolean
  readonly code: DecisionCode
  readonly used: number
  /**
   * null is unlimited, not zero.
   *
   * A plan's fair-use allowances are `Infinity`, which JSON cannot express, so
   * the server sends null for them. Reading that null as 0 reported "nothing
   * left" for the one case that has no ceiling at all, which is how an
   * unlimited allowance ends up displayed as a spent one.
   */
  readonly limit: number | null
  readonly metering?: "hard" | "soft"
  readonly period?: "day" | "month"
  readonly resetsAt?: number
  readonly sessionMinutes?: number
}

export interface BillingEntitlement {
  /** Server-supplied price so the UI never hardcodes one. */
  readonly plan: PlanId
  /** null is unlimited, for the same reason `limit` is. */
  readonly computers: number | null
  readonly capabilities: Readonly<Record<string, BillingCapabilityState>>
  readonly billingConfigured: boolean
  readonly monthlyUsd: number
  readonly computersUsed?: number
  readonly profile?: { readonly login: string; readonly avatarUrl?: string }
  readonly offers?: readonly { readonly id: "pro" | "business"; readonly monthlyUsd: number; readonly computers: number | null }[]
}

/** The metered decision. A refusal is an answer, not a failure. */
export interface BillingCheck extends BillingCapabilityState {
  readonly plan: PlanId
  readonly capability: Capability
  readonly metering: "hard" | "soft"
  readonly reason: string
}

/**
 * Why the account menu cannot act, as a value rather than a sentence.
 *
 * Copy belongs to the surface that renders it, so the menu and the renderer
 * each resolve this in their own locale instead of receiving English from here.
 */
export type BillingAccountNotice = "signed_out" | "unconfigured" | "unreachable"

export interface BillingAccount {
  readonly plan: PlanId | undefined
  readonly billingConfigured: boolean
  readonly notice: BillingAccountNotice | undefined
}

// plans.ts ranks enterprise above the paid tiers even though it carries no
// monthly price, so an upgrade compares tier order and never compares money.
const PLAN_RANK: Record<PlanId, number> = { free: 0, pro: 1, business: 2, enterprise: 3 }

/**
 * Whether the account surface may offer this upgrade.
 *
 * Nothing is offered without a confirmed entitlement: an unconfigured server, a
 * signed-out profile, and an unreachable server all mean the upgrade would be
 * refused, and offering it anyway is how a menu ends up doing nothing quietly.
 */
export function canUpgradeTo(account: BillingAccount, plan: CheckoutPlan): boolean {
  if (account.notice !== undefined || account.plan === undefined) return false
  return PLAN_RANK[account.plan] < PLAN_RANK[plan]
}

/**
 * Whether the billing portal can be opened for this account.
 *
 * The portal exists for a subscriber. A free profile has no Stripe customer, and
 * the control plane answers the portal route for one with "This profile has no
 * subscription to manage yet", so offering it there would be an item that opens
 * a refusal. An account that has not been resolved yet is in the same position:
 * there may be no subscription to manage at all.
 */
export function canManageBilling(account: BillingAccount): boolean {
  return account.notice === undefined && account.plan !== undefined && account.plan !== "free"
}

export async function readBillingEntitlement(): Promise<BillingEntitlement> {
  const { json } = await billingRequest("GET", "/v1/billing/entitlement")
  return {
    // An unrecognised plan id must not be rendered as if it were a plan: fall
    // back the same way the server's own resolver does.
    plan: isPlanId(json.plan) ? json.plan : "free",
    computers: typeof json.computers === "number" ? json.computers : null,
    capabilities: capabilityStates(json.capabilities),
    billingConfigured: json.billingConfigured === true,
    // Carried so the UI can show what the plan costs instead of hardcoding it.
    monthlyUsd: typeof json.monthlyUsd === "number" ? json.monthlyUsd : 0,
    ...(typeof json.computersUsed === "number" ? { computersUsed: json.computersUsed } : {}),
    ...(isRecord(json.profile) && typeof json.profile.login === "string" ? {
      profile: { login: json.profile.login, ...(typeof json.profile.avatarUrl === "string" ? { avatarUrl: json.profile.avatarUrl } : {}) },
    } : {}),
    ...(Array.isArray(json.offers) ? { offers: json.offers.flatMap((offer) =>
      isRecord(offer) && (offer.id === "pro" || offer.id === "business") && typeof offer.monthlyUsd === "number"
        ? [{ id: offer.id, monthlyUsd: offer.monthlyUsd, computers: typeof offer.computers === "number" ? offer.computers : null }]
        : []
    ) } : {}),
  }
}

export async function checkBillingCapability(capability: Capability, preview = false): Promise<BillingCheck> {
  // 402 is the server's way of answering a refusal, so it is accepted here and
  // returned as a decision; only a genuine failure throws.
  // A refusal is a 402 and must come back as a DECISION, not a thrown error. The
  // accept predicate used to be `status === 402`, which REPLACED the default
  // ok-check rather than adding to it - so a granted 200 threw
  // ControlPlaneRequestError("HTTP 200") and every soft or free capability was
  // reported as a failure in the desktop app.
  const { json } = await billingRequest(
    "POST",
    "/v1/billing/check",
    { capability },
    (status: number, ok: boolean) => ok || status === 402,
  )
  return {
    ...capabilityState(json),
    plan: isPlanId(json.plan) ? json.plan : "free",
    capability,
    // Default to "hard" when the server does not say: a refusal must never be
    // rendered as a soft fair-use notice, because that tells the user a feature
    // still works when it does not.
    metering: json.metering === "soft" ? "soft" : "hard",
    reason: typeof json.reason === "string" ? json.reason : "",
  }
}

/** Starts a checkout session and returns the URL to send the user to. */
export async function startBillingCheckout(plan: CheckoutPlan): Promise<string> {
  const { json } = await billingRequest("POST", "/v1/billing/checkout", { plan })
  if (typeof json.url !== "string") throw new Error("The billing server did not return a checkout URL.")
  return json.url
}

/** Opens the Stripe billing portal and returns the URL to send the user to. */
export async function startBillingPortal(): Promise<string> {
  const { json } = await billingRequest("POST", "/v1/billing/portal")
  if (typeof json.url !== "string") throw new Error("The billing server did not return a billing portal URL.")
  return json.url
}

/**
 * The account as the menu and settings surfaces need it.
 *
 * Never rejects: an unreachable server has to leave the menu showing a plain
 * reason rather than throwing inside a menu rebuild.
 */
export async function readBillingAccount(): Promise<BillingAccount> {
  if (controlPlaneAuth() === undefined) return { plan: undefined, billingConfigured: false, notice: "signed_out" }
  try {
    const entitlement = await readBillingEntitlement()
    return {
      plan: entitlement.plan,
      billingConfigured: entitlement.billingConfigured,
      notice: entitlement.billingConfigured ? undefined : "unconfigured",
    }
  } catch (error) {
    if (error instanceof ControlPlaneRequestError && error.status === 401)
      return { plan: undefined, billingConfigured: false, notice: "signed_out" }
    return { plan: undefined, billingConfigured: false, notice: "unreachable" }
  }
}

export function registerBillingIpcHandlers(): void {
  ipcMain.handle(BILLING_CHANNELS.entitlement, async () => readBillingEntitlement())
  ipcMain.handle(BILLING_CHANNELS.check, async (_event, capability: unknown) => {
    if (!isCapability(capability))
      throw new Error(`Unknown billing capability: ${typeof capability === "string" ? capability : typeof capability}`)
    return checkBillingCapability(capability)
  })
  ipcMain.handle(BILLING_CHANNELS.checkout, async (_event, plan: unknown) => {
    if (plan !== "pro" && plan !== "business") throw new Error("Choose the pro or business plan.")
    return startBillingCheckout(plan)
  })
  ipcMain.handle(BILLING_CHANNELS.portal, async () => startBillingPortal())
}

/**
 * The profile the control plane bills, sent on every route.
 *
 * Entitlements are per profile and the server does not infer the profile from
 * the client token, so a call made without it is answered as signed out.
 */
function profileHeaders(): Record<string, string> {
  const profileId = readSessionProfileId()
  return profileId === undefined ? {} : { "x-omnia-profile": profileId }
}

function billingRequest(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  accept?: (status: number, ok: boolean) => boolean,
) {
  return controlPlaneRequest(path, method, { body, headers: profileHeaders(), accept })
}

function isCapability(value: unknown): value is Capability {
  return typeof value === "string" && value in PLANS.free.capabilities
}

function decisionCode(value: unknown): DecisionCode {
  return value === "granted" || value === "limit_reached" || value === "not_entitled" ? value : "unknown"
}

function capabilityStates(value: unknown): Readonly<Record<string, BillingCapabilityState>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).map(([capability, state]) => [capability, capabilityState(state)]))
}

function capabilityState(value: unknown): BillingCapabilityState {
  const state = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
  return {
    allowed: state.allowed === true,
    code: decisionCode(state.code),
    used: typeof state.used === "number" ? state.used : 0,
    // Anything that is not a finite number is left as null - unlimited - rather
    // than becoming a 0, because a 0 is a refusal the UI would then have to
    // explain and an absent ceiling has nothing to refuse.
    limit: typeof state.limit === "number" && Number.isFinite(state.limit) ? state.limit : null,
    ...(state.metering === "hard" || state.metering === "soft" ? { metering: state.metering } : {}),
    ...(state.period === "day" || state.period === "month" ? { period: state.period } : {}),
    ...(typeof state.resetsAt === "number" && Number.isFinite(state.resetsAt) ? { resetsAt: state.resetsAt } : {}),
    ...(typeof state.sessionMinutes === "number" && Number.isFinite(state.sessionMinutes) ? { sessionMinutes: state.sessionMinutes } : {}),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
