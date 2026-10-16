// The single source of truth for what each plan may do and how much of it.
//
// Entitlements are resolved on the control plane because it is the only shared
// authority: the desktop app and the sidecar both ask it. Nothing here is a
// secret and nothing here is a credential.
//
// Two failure policies matter and are encoded in `access`, not left to callers:
//
//   - Paid capabilities fail CLOSED. If the billing store cannot be read, or a
//     capability's status is unknown, the answer is "not entitled". Handing out
//     a paid capability on an unreadable store would make a disk error a
//     revenue leak.
//   - Free capabilities fail OPEN. A Stripe outage or an unreachable billing
//     store must never brick the local app someone is already using, so a
//     missing subscription degrades to the free plan instead of an error.
import type { OmniaScope } from "../server/permissions.js"

export type PlanId = "free" | "pro" | "business" | "enterprise"

export type Metered = "hard" | "soft"

/**
 * What a `limit` is denominated in.
 *
 * `month` is the billing period. `day` is a calendar-day budget that resets at
 * 00:00 UTC. There is no default and no inference: every rule in the matrix
 * names one, because the counter key is derived from it.
 *
 * This is part of the rule rather than a comment beside it because the counter
 * key is derived from it: a capability whose period was only implied in a comment
 * was metered monthly while the product described it as a daily budget.
 */
export type MeteringPeriod = "day" | "month"

export type Capability =
  | "local_computer"
  | "remote_computer"
  | "input_freeze"
  | "remote_shell"
  | "clipboard"
  | "browser_automation"
  | "credential_vault"
  | "vault_login"
  | "cloud_vision"
  | "scheduled_runs"
  | "live_view"
  | "api_access"
  | "webhooks"
  | "subagents"
  | "audit_export"
  | "rbac"
  | "sso"
  | "self_hosted"
  | "custom_specialists"
  | "chat_channels"

export interface CapabilityRule {
  /** `hard` means the request is refused once the limit is spent. */
  readonly metering: Metered
  /** Requests allowed per `period`. Infinity for "fair use". */
  readonly limit: number
  /** Which counter this allowance is drawn from. Never inferred. */
  readonly period: MeteringPeriod
  /** Wall-clock ceiling for one uninterrupted session, in minutes. */
  readonly sessionMinutes?: number
}

export interface Plan {
  readonly id: PlanId
  readonly monthlyUsd: number
  readonly computers: number
  readonly capabilities: Readonly<Record<Capability, CapabilityRule>>
}

const UNLIMITED: CapabilityRule = { metering: "soft", limit: Number.POSITIVE_INFINITY, period: "month" }
// The period is a REQUIRED argument, not a default. A default is an implicit
// period wearing a type signature: it is how `browser_automation` ended up
// metered on a monthly counter while every human-readable description of it said
// "250 a day". Every allowance in the matrix now names its own period at the line
// that writes it, so the matrix can be read as data and a new capability cannot
// be added without deciding what its budget resets on.
const HARD = (limit: number, period: MeteringPeriod): CapabilityRule => ({ metering: "hard", limit, period })
const SOFT = (limit: number, period: MeteringPeriod): CapabilityRule => ({ metering: "soft", limit, period })
const NEVER: CapabilityRule = { metering: "hard", limit: 0, period: "month" }

/**
 * Business is pro with its ceilings lifted, plus the two controls that only make
 * sense once more than one person can see a workspace.
 */
const BUSINESS: Readonly<Record<Capability, CapabilityRule>> = {
  local_computer: UNLIMITED,
  remote_computer: UNLIMITED,
  input_freeze: UNLIMITED,
  remote_shell: UNLIMITED,
  clipboard: UNLIMITED,
  browser_automation: UNLIMITED,
  credential_vault: UNLIMITED,
  vault_login: UNLIMITED,
  cloud_vision: UNLIMITED,
  scheduled_runs: UNLIMITED,
  live_view: UNLIMITED,
  api_access: UNLIMITED,
  webhooks: UNLIMITED,
  subagents: UNLIMITED,
  audit_export: UNLIMITED,
  rbac: UNLIMITED,
  sso: UNLIMITED,
  self_hosted: NEVER,
  custom_specialists: UNLIMITED,
  chat_channels: UNLIMITED,
}

/**
 * The resolved tiers.
 *
 * Free deliberately sits between a hard demo mode and a generous free tier: it
 * includes remote control because that is what makes someone convert, and it is
 * bounded by the two limits people cannot script around cheaply - a two hour
 * session ceiling and 250 browser actions a day.
 *
 * Both of those bounds are stated as data. `sessionMinutes` is enforced against
 * the live session's own clock (see remote/entitlement.ts) and `browser_automation`
 * declares `period: "day"`, so the daily budget is metered on a daily counter
 * rather than described as one.
 */
export const PLANS: Readonly<Record<PlanId, Plan>> = {
  free: {
    id: "free",
    monthlyUsd: 0,
    computers: 3,
    capabilities: {
      local_computer: { metering: "soft", limit: Number.POSITIVE_INFINITY, period: "month" },
      // Included on free, but the session ceiling and the daily action budget
      // are what keep it a trial rather than a free hosted bot platform.
      remote_computer: { metering: "soft", limit: Number.POSITIVE_INFINITY, period: "month", sessionMinutes: 120 },
      // Input freeze and the clipboard are safety and interoperability basics,
      // not premium features. Charging for them made the free tier feel hostile:
      // the agent could click but the human could not safely take the mouse back,
      // and could not paste what it had read. Both are now unlimited on free.
      input_freeze: UNLIMITED,
      clipboard: UNLIMITED,
      // Remote shell stays paid. Executing on someone ELSE's machine is the
      // capability with real blast radius rather than a basic one.
      remote_shell: NEVER,
      // The one daily allowance, and the free tier's real ceiling. Soft, so
      // ordinary use never hits a wall and a busy day is not a dead account.
      // Daily rather than monthly because a spent month leaves the account dead
      // until the first, which is the opposite of what a free tier is for.
      browser_automation: HARD(500, "day"),
      // Five stored credentials. HARD, so five means five: a soft limit keeps
      // working past its number, which would make the figure decorative.
      credential_vault: HARD(5, "month"),
      // The vault itself is visible on free so the feature is discoverable, but
      // actually logging in is what gets metered, and hard: this is the
      // bot-as-a-service primitive. Genuinely monthly - three logins is three for
      // the billing period, not three a day.
      vault_login: HARD(3, "month"),
      cloud_vision: NEVER,
      scheduled_runs: NEVER,
      live_view: HARD(500, "month"),
      api_access: NEVER,
      webhooks: NEVER,
      subagents: UNLIMITED,
      audit_export: NEVER,
      rbac: NEVER,
      sso: NEVER,
      self_hosted: NEVER,
      // Free keeps the four built-in discussion specialists; renaming and
      // refocusing them is what Pro adds.
      custom_specialists: NEVER,
      // Chat channels (Slack/Telegram/Teams/Google Chat) are a Pro capability.
      // Free users see the Accounts tab with an upgrade CTA only.
      chat_channels: NEVER,
    },
  },
  pro: {
    id: "pro",
    monthlyUsd: 15,
    computers: 5,
    capabilities: {
      local_computer: UNLIMITED,
      remote_computer: UNLIMITED,
      input_freeze: SOFT(Number.POSITIVE_INFINITY, "month"),
      remote_shell: SOFT(Number.POSITIVE_INFINITY, "month"),
      clipboard: SOFT(Number.POSITIVE_INFINITY, "month"),
      // Never below the free tier. Free is a soft 5,000 a day, so a "paid" 2,000
      // a month would be strictly worse than free - a matrix where upgrading
      // loses capability is worse than no matrix at all.
      browser_automation: UNLIMITED,
      credential_vault: UNLIMITED,
      vault_login: SOFT(300, "month"),
      cloud_vision: SOFT(2_000, "month"),
      scheduled_runs: SOFT(50, "month"),
      live_view: UNLIMITED,
      api_access: UNLIMITED,
      webhooks: UNLIMITED,
      subagents: UNLIMITED,
      audit_export: NEVER,
      rbac: NEVER,
      sso: NEVER,
      self_hosted: NEVER,
      custom_specialists: UNLIMITED,
      chat_channels: UNLIMITED,
    },
  },
  business: {
    id: "business",
    monthlyUsd: 49,
    computers: Number.POSITIVE_INFINITY,
    capabilities: BUSINESS,
  },
  enterprise: {
    id: "enterprise",
    monthlyUsd: 0,
    computers: Number.POSITIVE_INFINITY,
    // Everything unlocked, self hosting included: enterprise is sold by hand.
    capabilities: Object.fromEntries(
      (Object.keys(BUSINESS) as Capability[]).map((capability) => [capability, UNLIMITED]),
    ) as Readonly<Record<Capability, CapabilityRule>>,
  },
}

/**
 * How generous a plan is: its rank on the shipped ladder, free at 0.
 *
 * This is deliberately NOT the price. Ranking by `monthlyUsd` made a pricing
 * decision into an entitlement decision, and it resolved the wrong way twice
 * over: enterprise is priced at 0 because it is sold by hand, so an enterprise
 * subscriber sharing a profile with a pro one resolved to PRO, and any future
 * discount on business would have resolved a business subscriber to pro.
 *
 * It is also deliberately a `Record` and not a list. Every shipped plan is
 * ranked by name, so the ladder is a total order the typechecker enforces:
 * adding a plan without ranking it here fails the build instead of yielding a
 * silent -1 that loses every comparison against the free fallback. "The most
 * generous live subscription wins" is then order-independent - a max over a
 * total order - so neither a price nor the order the events arrived in can move
 * a customer between plans.
 */
const PLAN_TIER: Readonly<Record<PlanId, number>> = { free: 0, pro: 1, business: 2, enterprise: 3 }

export function planTier(plan: Plan): number {
  return PLAN_TIER[plan.id]
}

/** Own-property check, so an inherited name like "constructor" is not a plan. */
export function isPlanId(value: unknown): value is PlanId {
  return typeof value === "string" && Object.hasOwn(PLAN_TIER, value)
}

export function planFor(value: unknown): Plan {
  return isPlanId(value) ? PLANS[value] : PLANS.free
}

/**
 * Whether a capability must be refused when the billing store cannot be read.
 *
 * This MUST be evaluated against the plan the customer is actually on, not
 * against the free plan. Keying it off `free` meant a Pro or Business customer
 * whose store was unreadable had every paid capability refused, so our own disk
 * error silently stripped features from people who had paid for them - the exact
 * inverse of the policy, and the fastest way to lose a customer and a refund.
 *
 * On a paid plan an allowance is either unlimited or soft, so this returns false
 * and the feature keeps working. On free, a hard allowance is genuinely
 * unenforceable without the counters, so it is refused.
 */
export function failsClosed(capability: Capability, plan: PlanId = "free"): boolean {
  return planFor(plan).capabilities[capability].metering === "hard"
}

/** Scopes a capability implies, so enforcement can reuse the permission model. */
export function scopesFor(capability: Capability): readonly OmniaScope[] {
  switch (capability) {
    case "credential_vault":
    case "vault_login":
      return ["SECRETS"]
    case "remote_shell":
      return ["FILES_WRITE"]
    case "clipboard":
      return ["FILES_READ"]
    default:
      return []
  }
}