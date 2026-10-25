// The enterprise control plane's domain model.
//
// These types are the contract between the admin console, the HTTP API and the
// durable store. They are deliberately plain data: every field is JSON, every
// collection is bounded by the store, and nothing here reaches the filesystem.
//
// The shape is versioned. `EnterpriseState.version` is checked on load, so a
// future migration can refuse an unknown file instead of guessing at it.

export const ENTERPRISE_STATE_VERSION = 1

export const ROLES = ["owner", "admin", "manager", "member", "auditor", "billing"] as const
export type Role = (typeof ROLES)[number]

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value)
}

export const CAPABILITIES = [
  "org:read",
  "org:write",
  "org:security",
  "users:read",
  "users:write",
  "users:invite",
  "groups:read",
  "groups:write",
  "distributions:read",
  "distributions:write",
  "distributions:publish",
  "policies:read",
  "policies:write",
  "usage:read",
  "audit:read",
  "audit:export",
  "license:read",
  "license:write",
  "integrations:read",
  "integrations:write",
  "scim:write",
] as const
export type Capability = (typeof CAPABILITIES)[number]

const READ_ONLY: readonly Capability[] = [
  "org:read",
  "users:read",
  "groups:read",
  "distributions:read",
  "policies:read",
  "usage:read",
  "audit:read",
  "license:read",
  "integrations:read",
]

// Who may do what. `owner` is the only role that can hand out ownership, and
// ownership is never granted through a group.
export const ROLE_CAPABILITIES: Readonly<Record<Role, readonly Capability[]>> = {
  owner: CAPABILITIES,
  admin: [
    "org:read",
    "org:write",
    "org:security",
    "users:read",
    "users:write",
    "users:invite",
    "groups:read",
    "groups:write",
    "distributions:read",
    "distributions:write",
    "distributions:publish",
    "policies:read",
    "policies:write",
    "usage:read",
    "audit:read",
    "audit:export",
    "license:read",
    "integrations:read",
    "integrations:write",
    "scim:write",
  ],
  manager: [
    "org:read",
    "users:read",
    "users:write",
    "users:invite",
    "groups:read",
    "groups:write",
    "distributions:read",
    "policies:read",
    "usage:read",
    "audit:read",
  ],
  member: [],
  auditor: READ_ONLY,
  billing: ["org:read", "usage:read", "license:read", "license:write"],
}

export function can(role: Role, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role].includes(capability)
}

export function capabilitiesOf(role: Role): readonly Capability[] {
  return ROLE_CAPABILITIES[role]
}

export type UserStatus = "invited" | "active" | "suspended"

export interface EnterpriseUser {
  readonly id: string
  readonly email: string
  readonly employeeId?: string
  name: string
  role: Role
  status: UserStatus
  readonly groupIds: string[]
  /** scrypt$N$r$p$salt$hash, never a plaintext password. */
  passwordHash?: string
  passwordUpdatedAt?: number
  readonly createdAt: number
  updatedAt: number
  lastActiveAt?: number
  readonly mfaEnabled: boolean
  title?: string
  department?: string
  /** Whether this user consumes a paid seat. Invited users do not. */
  seat: boolean
  /** Stable identifier from a customer's IdP, used by SCIM. */
  externalId?: string
  /** A failed-login counter that is reset by a success. */
  failedLogins?: number
  lockedUntil?: number
}

export interface EnterpriseGroup {
  readonly id: string
  name: string
  description: string
  role: Exclude<Role, "owner">
  readonly createdAt: number
  updatedAt: number
  /** Empty means the organization's default model access applies. */
  modelAllowlist: string[]
  monthlyTokenLimit?: number
  monthlySpendLimitUsd?: number
  maxComputers?: number
}

export type InvitePurpose = "invite" | "reset"

export interface EnterpriseInvite {
  readonly id: string
  readonly email: string
  readonly role: Role
  readonly groupIds: string[]
  /** A reset token targets an existing user instead of creating one. */
  readonly purpose?: InvitePurpose
  readonly userId?: string
  readonly tokenHash: string
  readonly createdAt: number
  readonly expiresAt: number
  readonly createdBy: string
  acceptedAt?: number
  revokedAt?: number
}

export type SessionKind = "admin" | "client"

export interface EnterpriseSession {
  readonly id: string
  readonly userId: string
  readonly kind: SessionKind
  readonly tokenHash: string
  readonly createdAt: number
  readonly expiresAt: number
  lastSeenAt: number
  readonly userAgent?: string
  readonly ip?: string
}

export interface Branding {
  productName: string
  shortName: string
  tagline: string
  primaryColor: string
  accentColor: string
  logoUrl?: string
  iconUrl?: string
  signInHeadline: string
  signInSubheadline: string
  supportUrl?: string
  docsUrl?: string
  footerText?: string
  /** Enterprise customers on a white-label plan can drop Omnia branding. */
  showOmniaBranding: boolean
}

/**
 * Asset paths are stored as the operator uploaded them. A manifest is read by a
 * client that reached this server at some address, so a same-server path must be
 * rebased onto that address: a laptop that fetched the manifest from
 * http://10.0.0.4:8787 cannot load an image served from the console's loopback.
 */
export function absoluteBranding(baseUrl: string, branding: Branding): Branding {
  const base = baseUrl.replace(/\/+$/, "")
  const asset = (value: string | undefined) => {
    const text = value?.trim()
    // A blank field means "no asset". Keeping it would ship an empty URL that a
    // client resolves against its own origin and then fails to load.
    if (text === undefined || text.length === 0) return undefined
    if (text.startsWith("/")) return base.length === 0 ? text : `${base}${text}`
    if (!URL.canParse(text)) return text
    const url = new URL(text)
    // Uploads are stored under the console's configured address, which can be
    // loopback while a LAN client reached the same server elsewhere.
    if (!url.pathname.startsWith("/v1/enterprise/public/assets/")) return value
    const path = `${url.pathname}${url.search}`
    return base.length === 0 ? path : `${base}${path}`
  }
  return {
    ...structuredClone(branding),
    ...(branding.logoUrl === undefined ? {} : { logoUrl: asset(branding.logoUrl) }),
    ...(branding.iconUrl === undefined ? {} : { iconUrl: asset(branding.iconUrl) }),
  }
}

export type AuthMethod = "password" | "oidc" | "saml"

export interface OidcConfig {
  issuer: string
  clientId: string
  scopes: string
  emailClaim: string
  nameClaim: string
  autoCreate: boolean
}

export interface SamlConfig {
  entityId: string
  ssoUrl: string
  certificate: string
  autoCreate: boolean
}

export interface ClientAuth {
  /** Enterprise builds are SSO-only. Social sign-in is not a supported value. */
  mode: "sso"
  methods: AuthMethod[]
  sessionHours: number
  requireMfa: boolean
  allowedEmailDomains: string[]
  oidc?: OidcConfig
  saml?: SamlConfig
}

export interface ClientFeatures {
  computerUse: boolean
  browserAutomation: boolean
  cloudVision: boolean
  liveView: boolean
  scheduledRuns: boolean
  chatChannels: boolean
  memory: boolean
  superskills: boolean
  subagents: boolean
  mcpMarketplace: boolean
  fileAttachments: boolean
  shellTool: boolean
  networkAccess: boolean
  credentialVault: boolean
  telemetry: boolean
}

/**
 * Tool-level access. `ask` keeps the tool available but requires an approval
 * for every call; `deny` removes the tool from the agent's registry entirely.
 * A feature switch that is off always wins, so the two controls can never
 * disagree about whether a capability exists.
 */
export const PERMISSION_MODES = ["allow", "ask", "deny"] as const
export type PermissionMode = (typeof PERMISSION_MODES)[number]

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === "string" && (PERMISSION_MODES as readonly string[]).includes(value)
}

export interface ClientPermissions {
  /** Read files inside the workspace. */
  read: PermissionMode
  /** Create, edit, or delete files. */
  edit: PermissionMode
  /** Run shell commands. */
  bash: PermissionMode
  /** Delegate work to subagents. */
  task: PermissionMode
  /** Fetch web pages and search the web. */
  network: PermissionMode
  /** Touch paths outside the workspace. */
  externalDirectory: PermissionMode
  /** Load and use skills. */
  skill: PermissionMode
  /** Control the desktop with the computer tools. */
  computer: PermissionMode
}

/**
 * Defaults derive from the capability switches so older manifests keep the
 * behaviour they already advertise: a disabled feature is denied, everything
 * else is allowed without a prompt.
 */
export function defaultPermissions(features: Partial<ClientFeatures> = {}): ClientPermissions {
  return {
    read: "allow",
    edit: "allow",
    bash: features.shellTool === false ? "deny" : "allow",
    task: features.subagents === false ? "deny" : "allow",
    network: features.networkAccess === false ? "deny" : "allow",
    externalDirectory: "allow",
    skill: "allow",
    computer: features.computerUse === false ? "deny" : "allow",
  }
}

/** Merge a stored or served policy over the feature-derived defaults. */
export function normalizePermissions(value: unknown, features: Partial<ClientFeatures> = {}): ClientPermissions {
  const record =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  const defaults = defaultPermissions(features)
  const pick = (key: keyof ClientPermissions) => (isPermissionMode(record[key]) ? record[key] : defaults[key])
  // A capability that does not exist cannot be granted by a stale policy.
  return {
    read: pick("read"),
    edit: pick("edit"),
    bash: features.shellTool === false ? "deny" : pick("bash"),
    task: features.subagents === false ? "deny" : pick("task"),
    network: features.networkAccess === false ? "deny" : pick("network"),
    externalDirectory: pick("externalDirectory"),
    skill: pick("skill"),
    computer: features.computerUse === false ? "deny" : pick("computer"),
  }
}

export interface ClientExperience {
  /** `system` follows the operating system appearance. */
  theme: "system" | "light" | "dark"
  density: "comfortable" | "compact"
  locale: "system" | "en" | "de" | "ar"
  homeSurface: "sessions" | "projects"
  defaultMode: "build" | "plan"
  /** Organization-wide instructions prepended to every session. */
  instructions: string
  showTips: boolean
  showUsageMeter: boolean
}

export function defaultExperience(): ClientExperience {
  return {
    theme: "system",
    density: "comfortable",
    locale: "system",
    homeSurface: "sessions",
    defaultMode: "build",
    instructions: "",
    showTips: true,
    showUsageMeter: true,
  }
}

export interface ClientLimits {
  monthlyTokensPerUser: number
  monthlySpendPerUserUsd: number
  maxComputersPerUser: number
  maxConcurrentSessions: number
  contextWindowTokens: number
  dailyScheduledRuns: number
  storageGb: number
  /** 0 means unlimited. */
  maxFileUploadMb: number
}

export interface ModelAccess {
  defaultModel: string
  allowed: string[]
  blocked: string[]
  allowCustomProviders: boolean
  allowByok: boolean
}

export interface ClientTelemetry {
  enabled: boolean
  includePrompts: boolean
  includeFilePaths: boolean
  retentionDays: number
  endpoint?: string
}

export interface ClientUpdate {
  channel: "stable" | "beta" | "pinned"
  pinnedVersion?: string
  autoUpdate: boolean
  allowDowngrade: boolean
  minimumVersion?: string
}

export const PLATFORMS = ["macos-arm64", "macos-x64", "windows-x64", "linux-x64", "linux-arm64"] as const
export type Platform = (typeof PLATFORMS)[number]

/**
 * How a deployment is reached. `lan` serves installers and the manifest from
 * whatever address the client used, so a server on a private network needs no
 * public DNS or certificate. `public` pins one URL and requires client
 * telemetry, because the build can be installed anywhere once it is published.
 */
export const NETWORK_MODES = ["lan", "public"] as const
export type NetworkMode = (typeof NETWORK_MODES)[number]

export function isNetworkMode(value: unknown): value is NetworkMode {
  return typeof value === "string" && (NETWORK_MODES as readonly string[]).includes(value)
}

export interface ClientDeployment {
  platforms: Platform[]
  mode: NetworkMode
  /** Where installers are hosted. Falls back to this server's download route. */
  installerBaseUrl?: string
  offlineBundle: boolean
  proxyUrl?: string
  customCaCertificate?: string
}

export type DistributionStatus = "draft" | "published" | "archived"

export interface ClientDistribution {
  readonly id: string
  slug: string
  name: string
  description: string
  status: DistributionStatus
  version: string
  readonly createdAt: number
  updatedAt: number
  publishedAt?: number
  branding: Branding
  auth: ClientAuth
  features: ClientFeatures
  /** Tool-level rules; defaults derive from the feature switches. */
  permissions: ClientPermissions
  experience: ClientExperience
  limits: ClientLimits
  models: ModelAccess
  telemetry: ClientTelemetry
  update: ClientUpdate
  deployment: ClientDeployment
  /** Release notes shown in the console and the client's update prompt. */
  releaseNotes: string
}

export interface ModelPolicy {
  mode: "allowlist" | "denylist"
  models: string[]
  requireApprovalForNewModels: boolean
}

export interface ToolPolicy {
  allowShell: boolean
  allowFileWrite: boolean
  allowNetwork: boolean
  allowComputerUse: boolean
  allowBrowser: boolean
  allowSecrets: boolean
  requireApprovalFor: string[]
}

export interface DataPolicy {
  retentionDays: number
  allowTraining: boolean
  redactSecrets: boolean
  blockPiiExport: boolean
  residency: "us" | "eu" | "apac" | "self-hosted"
  encryptionAtRest: boolean
  byok: boolean
}

export interface AuditPolicy {
  retentionDays: number
  exportFormat: "json" | "csv"
  siemWebhook?: string
}

export interface NetworkPolicy {
  egressAllowlist: string[]
  blockPublicEgress: boolean
}

export interface Policies {
  requireMfa: boolean
  sessionHours: number
  idleTimeoutMinutes: number
  ipAllowlist: string[]
  model: ModelPolicy
  tools: ToolPolicy
  data: DataPolicy
  audit: AuditPolicy
  network: NetworkPolicy
}

export interface LicenseClaims {
  version: 1
  id: string
  org: string
  plan: "business" | "enterprise"
  seats: number
  issuedAt: number
  expiresAt: number
  features?: string[]
}

export interface LicenseState {
  token?: string
  claims?: LicenseClaims
  verifiedAt?: number
  /** Why verification failed, if it did. Never a signature or a secret. */
  error?: string
}

export interface OrganizationSettings {
  id: string
  name: string
  slug: string
  region: string
  adminEmail: string
  supportEmail?: string
  website?: string
  logoUrl?: string
  createdAt: number
  updatedAt: number
  policies: Policies
  branding: Branding
  trialStartedAt: number
  trialEndsAt: number
  license: LicenseState
  /** SHA-256 of the SCIM bearer token; the raw token is shown once. */
  scimTokenHash?: string
  scimEnabled: boolean
  integrations: Integrations
  smtp?: SmtpSettings
}

export interface SmtpSettings {
  host: string
  port: number
  username?: string
  password?: string
  from: string
  secure: boolean
}

export interface Integrations {
  slackWebhook?: string
  teamsWebhook?: string
  gchatWebhook?: string
  siemWebhook?: string
  genericWebhook?: string
  scimEnabled: boolean
}

export type AuditAction =
  | "org.updated"
  | "org.asset_uploaded"
  | "org.asset_deleted"
  | "org.setup"
  | "user.invited"
  | "user.created"
  | "user.updated"
  | "user.suspended"
  | "user.reactivated"
  | "user.deleted"
  | "user.password_reset"
  | "user.login"
  | "user.login_failed"
  | "user.logout"
  | "group.created"
  | "group.updated"
  | "group.deleted"
  | "distribution.created"
  | "distribution.updated"
  | "distribution.published"
  | "distribution.deleted"
  | "distribution.build_started"
  | "distribution.built"
  | "distribution.build_failed"
  | "client.download"
  | "policy.updated"
  | "license.activated"
  | "license.rejected"
  | "scim.token_rotated"
  | "integration.updated"
  | "client.login"
  | "client.login_failed"
  | "scim.user_created"
  | "scim.user_updated"
  | "export.downloaded"
  | "legal.ban_applied"
  | "legal.ban_lifted"
  | "legal.login_blocked"

export interface AuditEvent {
  readonly id: string
  readonly at: number
  readonly action: AuditAction
  actorId?: string
  actorEmail?: string
  target?: string
  ip?: string
  userAgent?: string
  metadata?: Record<string, string | number | boolean>
}

export interface UsageEvent {
  readonly id: string
  readonly at: number
  userId: string
  model: string
  provider?: string
  inputTokens: number
  outputTokens: number
  costUsd: number
  tool?: string
  computerId?: string
  sessionId?: string
  durationMs?: number
  distributionId?: string
}

export type LegalBanKind = "account" | "installation"

/**
 * One Terms of Service ban, kept next to the accounts it applies to.
 *
 * A ban is never deleted: lifting it records who lifted it and when, so an
 * appeal can be answered from the same record that enforced it. An account ban
 * applies to every installation signed into that email, which is what makes it
 * survive a reinstall on the same machine and a fresh machine alike.
 */
export interface LegalBan {
  readonly id: string
  readonly kind: LegalBanKind
  /** A lowercased email for `account`, a lowercased fingerprint for `installation`. */
  readonly value: string
  readonly reason: string
  readonly bannedAt: number
  readonly createdBy: string
  liftedAt?: number
  liftedBy?: string
}

export interface LegalDecision {
  readonly banned: boolean
  readonly reason?: string
  readonly bannedAt?: number
}

export interface EnterpriseState {
  version: typeof ENTERPRISE_STATE_VERSION
  organization: OrganizationSettings
  users: EnterpriseUser[]
  groups: EnterpriseGroup[]
  invites: EnterpriseInvite[]
  sessions: EnterpriseSession[]
  distributions: ClientDistribution[]
  /** One record per platform build, including failed attempts. */
  releases: ClientRelease[]
  audit: AuditEvent[]
  usage: UsageEvent[]
  /** Active and lifted bans; older files have no field and read as none. */
  legalBans?: LegalBan[]
  /** Operators set this once during `init`; it is cleared after setup. */
  bootstrapTokenHash?: string
  bootstrapExpiresAt?: number
}

export interface UsageBucket {
  key: string
  requests: number
  inputTokens: number
  outputTokens: number
  costUsd: number
}

export interface UsageInsightRow extends UsageBucket {
  label: string
  share: number
  averageCostUsd: number
  tokensPerRequest: number
}

export interface UsageInsights {
  days: number
  daily: UsageBucket[]
  models: UsageInsightRow[]
  people: UsageInsightRow[]
  departments: UsageInsightRow[]
  tools: UsageInsightRow[]
  efficiency: {
    tokensPerRequest: number
    costPer1kTokens: number
    inputShare: number
    costPerActiveUser: number
    requestsPerActiveUser: number
    averageDurationMs: number
  }
  forecast: {
    dailyAverageUsd: number
    next30DaysUsd: number
    monthToDateUsd: number
  }
  concentration: { topFiveShare: number; topDecileShare: number }
  anomalies: { day: string; costUsd: number; multiple: number }[]
}

export interface Summary {
  users: { total: number; active: number; invited: number; suspended: number }
  seats: { used: number; licensed: number; available: number | null }
  distributions: { total: number; published: number }
  usage: {
    requests: number
    inputTokens: number
    outputTokens: number
    costUsd: number
    activeUsers: number
  }
  spendByDay: UsageBucket[]
  usageByModel: UsageBucket[]
  usageByUser: UsageBucket[]
  topTools: UsageBucket[]
  recentAudit: AuditEvent[]
  trial: { active: boolean; endsAt: number; daysLeft: number }
  license: { valid: boolean; plan: string; seats: number; expiresAt?: number; error?: string }
  health: { storeWritable: boolean; auditBacklog: number; lastWriteAt?: number }
}

export function defaultBranding(orgName: string): Branding {
  return {
    productName: orgName,
    shortName: orgName,
    tagline: "Your AI workforce, under your control.",
    primaryColor: "#0a0a0a",
    accentColor: "#2563eb",
    signInHeadline: `Sign in to ${orgName}`,
    signInSubheadline: "Use your work email address and password.",
    showOmniaBranding: true,
  }
}

export function defaultPolicies(): Policies {
  return {
    requireMfa: false,
    sessionHours: 12,
    idleTimeoutMinutes: 120,
    ipAllowlist: [],
    model: { mode: "denylist", models: [], requireApprovalForNewModels: false },
    tools: {
      allowShell: true,
      allowFileWrite: true,
      allowNetwork: true,
      allowComputerUse: true,
      allowBrowser: true,
      allowSecrets: true,
      requireApprovalFor: ["shell", "credentials"],
    },
    data: {
      retentionDays: 365,
      allowTraining: false,
      redactSecrets: true,
      blockPiiExport: true,
      residency: "self-hosted",
      encryptionAtRest: true,
      byok: false,
    },
    audit: { retentionDays: 365, exportFormat: "json" },
    network: { egressAllowlist: [], blockPublicEgress: false },
  }
}

export function defaultDistribution(slug: string, name: string, now: number): ClientDistribution {
  return {
    id: `dist_${slug}`,
    slug,
    name,
    description: "",
    status: "draft",
    version: "1.0.0",
    createdAt: now,
    updatedAt: now,
    branding: { ...defaultBranding(name), shortName: name },
    auth: {
      mode: "sso",
      methods: ["password"],
      sessionHours: 12,
      requireMfa: false,
      allowedEmailDomains: [],
    },
    features: {
      computerUse: true,
      browserAutomation: true,
      cloudVision: true,
      liveView: true,
      scheduledRuns: true,
      // Chat channels stay off until the admin opts in: the surface is a set of
      // connected workspaces, not something a build should ship silently.
      chatChannels: false,
      memory: true,
      superskills: true,
      subagents: true,
      mcpMarketplace: true,
      fileAttachments: true,
      shellTool: true,
      networkAccess: true,
      credentialVault: true,
      telemetry: false,
    },
    permissions: defaultPermissions(),
    experience: defaultExperience(),
    limits: {
      monthlyTokensPerUser: 5_000_000,
      monthlySpendPerUserUsd: 150,
      maxComputersPerUser: 5,
      maxConcurrentSessions: 4,
      contextWindowTokens: 200_000,
      dailyScheduledRuns: 50,
      storageGb: 50,
      maxFileUploadMb: 100,
    },
    models: {
      defaultModel: "opencode/big",
      allowed: [],
      blocked: [],
      allowCustomProviders: false,
      allowByok: false,
    },
    telemetry: {
      enabled: false,
      includePrompts: false,
      includeFilePaths: false,
      retentionDays: 30,
    },
    update: { channel: "stable", autoUpdate: true, allowDowngrade: false },
    deployment: {
      platforms: ["macos-arm64", "macos-x64", "windows-x64", "linux-x64", "linux-arm64"],
      mode: "lan",
      offlineBundle: true,
    },
    releaseNotes: "",
  }
}

/**
 * The manifest a shipped client reads at startup. It contains no secrets: the
 * client still has to authenticate, and the login only mints a per-user token.
 */
export interface ClientManifest {
  schema: 1
  distribution: string
  name: string
  version: string
  publishedAt?: number
  org: { name: string; slug: string }
  branding: Branding
  auth: Omit<ClientAuth, "oidc" | "saml"> & { mode: "sso"; allowSocialLogin: false }
  features: ClientFeatures
  permissions: ClientPermissions
  experience: ClientExperience
  limits: ClientLimits
  models: ModelAccess
  telemetry: ClientTelemetry
  update: ClientUpdate
  deployment: Omit<ClientDeployment, "customCaCertificate"> & { installers: InstallerLink[] }
}

export interface InstallerLink {
  platform: Platform
  url: string
  available: boolean
  /** `installer` is a real package built by this server or an external feed. */
  kind: "installer" | "enrollment"
  bytes?: number
  sha256?: string
}

export const RELEASE_STATUSES = ["queued", "building", "ready", "failed"] as const
export type ReleaseStatus = (typeof RELEASE_STATUSES)[number]

/**
 * One platform build of a distribution. The artifact itself lives on disk under
 * the deployment's release directory; the record is the durable ledger the
 * console and the public manifest read.
 */
export interface ClientRelease {
  readonly id: string
  readonly distributionId: string
  distributionSlug: string
  version: string
  platform: Platform
  status: ReleaseStatus
  startedAt: number
  finishedAt?: number
  filename?: string
  bytes?: number
  sha256?: string
  /** Why a build failed, or the host limitation that stopped it starting. */
  error?: string
  /** Bounded tail of the build log, oldest first. */
  log: string[]
}
