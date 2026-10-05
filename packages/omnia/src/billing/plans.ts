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

export interface CapabilityRule {
  /** `hard` means the request is refused once the limit is spent. */
  readonly metering: Metered
  /** Requests allowed per billing period. Infinity for "fair use". */
  readonly limit: number
  /** Wall-clock ceiling for one uninterrupted session, in minutes. */
  readonly sessionMinutes?: number
}

export interface Plan {
  readonly id: PlanId
  readonly monthlyUsd: number
  readonly computers: number
  readonly capabilities: Readonly<Record<Capability, CapabilityRule>>
}

const UNLIMITED: CapabilityRule = { metering: "soft", limit: Number.POSITIVE_INFINITY }
const HARD = (limit: number): CapabilityRule => ({ metering: "hard", limit })
const SOFT = (limit: number): CapabilityRule => ({ metering: "soft", limit })
const NEVER: CapabilityRule = { metering: "hard", limit: 0 }

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
}

/**
 * The resolved tiers.
 *
 * Free deliberately sits between a hard demo mode and a generous free tier: it
 * includes remote control because that is what makes someone convert, and it is
 * bounded by the two limits people cannot script around cheaply - a two hour
 * session ceiling and 250 browser actions a day.
 */
export const PLANS: Readonly<Record<PlanId, Plan>> = {
  free: {
    id: "free",
    monthlyUsd: 0,
    computers: 3,
    capabilities: {
      local_computer: { metering: "soft", limit: Number.POSITIVE_INFINITY },
      // Included on free, but the session ceiling and the daily action budget
      // are what keep it a trial rather than a free hosted bot platform.
      remote_computer: { metering: "soft", limit: Number.POSITIVE_INFINITY, sessionMinutes: 120 },
      input_freeze: NEVER,
      remote_shell: NEVER,
      clipboard: NEVER,
      browser_automation: HARD(250),
      credential_vault: SOFT(1),
      // The vault itself is visible on free so the feature is discoverable, but
      // actually logging in is what gets metered, and hard: this is the
      // bot-as-a-service primitive.
      vault_login: HARD(3),
      cloud_vision: NEVER,
      scheduled_runs: NEVER,
      live_view: SOFT(20),
      api_access: NEVER,
      webhooks: NEVER,
      subagents: SOFT(2),
      audit_export: NEVER,
      rbac: NEVER,
      sso: NEVER,
      self_hosted: NEVER,
    },
  },
  pro: {
    id: "pro",
    monthlyUsd: 15,
    computers: 5,
    capabilities: {
      local_computer: UNLIMITED,
      remote_computer: UNLIMITED,
      input_freeze: SOFT(Number.POSITIVE_INFINITY),
      remote_shell: SOFT(Number.POSITIVE_INFINITY),
      clipboard: SOFT(Number.POSITIVE_INFINITY),
      browser_automation: SOFT(2_000),
      credential_vault: UNLIMITED,
      vault_login: SOFT(300),
      cloud_vision: SOFT(2_000),
      scheduled_runs: SOFT(50),
      live_view: SOFT(500),
      api_access: UNLIMITED,
      webhooks: UNLIMITED,
      subagents: SOFT(10),
      audit_export: NEVER,
      rbac: NEVER,
      sso: NEVER,
      self_hosted: NEVER,
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

// Ordered so an unknown or future plan id can never widen access.
const PLAN_ORDER: readonly PlanId[] = ["free", "pro", "business", "enterprise"]

export function isPlanId(value: unknown): value is PlanId {
  return typeof value === "string" && (PLAN_ORDER as readonly string[]).includes(value)
}

export function planFor(value: unknown): Plan {
  return isPlanId(value) ? PLANS[value] : PLANS.free
}

/**
 * Whether a capability must be refused when the billing store cannot be read.
 *
 * Keyed off `hard` metering rather than off whether the free plan includes it:
 * an unreadable store means the usage counters are unknown, so a hard allowance
 * cannot be enforced, and handing the request out anyway would make a disk error
 * an unlimited-usage bug. Soft allowances keep working on purpose, because
 * "past its fair-use allowance" is still a working product.
 */
export function failsClosed(capability: Capability): boolean {
  return PLANS.free.capabilities[capability].metering === "hard"
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