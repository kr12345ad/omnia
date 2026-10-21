// The console's view of the enterprise API. These mirror the server payloads;
// the console never imports server code, so the browser bundle stays small and
// the client cannot accidentally depend on Node-only modules.

export type Role = "owner" | "admin" | "manager" | "member" | "auditor" | "billing"
export type UserStatus = "invited" | "active" | "suspended"
export type Capability =
  | "org:read"
  | "org:write"
  | "org:security"
  | "users:read"
  | "users:write"
  | "users:invite"
  | "groups:read"
  | "groups:write"
  | "distributions:read"
  | "distributions:write"
  | "distributions:publish"
  | "policies:read"
  | "policies:write"
  | "usage:read"
  | "audit:read"
  | "audit:export"
  | "license:read"
  | "license:write"
  | "integrations:read"
  | "integrations:write"
  | "scim:write"

export interface User {
  id: string
  email: string
  employeeId?: string
  name: string
  role: Role
  status: UserStatus
  groupIds: string[]
  createdAt: number
  updatedAt: number
  lastActiveAt?: number
  mfaEnabled: boolean
  seat: boolean
  title?: string
  department?: string
  externalId?: string
  passwordSet: boolean
}

export interface Invite {
  id: string
  email: string
  role: Role
  groupIds: string[]
  purpose?: "invite" | "reset"
  userId?: string
  createdAt: number
  expiresAt: number
  createdBy: string
  acceptedAt?: number
  revokedAt?: number
}

export interface Group {
  id: string
  name: string
  description: string
  role: Exclude<Role, "owner">
  createdAt: number
  updatedAt: number
  modelAllowlist: string[]
  monthlyTokenLimit?: number
  monthlySpendLimitUsd?: number
  maxComputers?: number
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
  showOmniaBranding: boolean
}

export type AuthMethod = "password" | "oidc" | "saml"
export type Platform = "macos-arm64" | "macos-x64" | "windows-x64" | "linux-x64" | "linux-arm64"
export type NetworkMode = "lan" | "public"

export interface ClientAuth {
  mode: "sso"
  methods: AuthMethod[]
  sessionHours: number
  requireMfa: boolean
  allowedEmailDomains: string[]
  oidc?: { issuer: string; clientId: string; scopes: string; emailClaim: string; nameClaim: string; autoCreate: boolean }
  saml?: { entityId: string; ssoUrl: string; certificate: string; autoCreate: boolean }
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

export type PermissionMode = "allow" | "ask" | "deny"

/** Tool-level access shipped to the client; `deny` removes the tool. */
export interface ClientPermissions {
  read: PermissionMode
  edit: PermissionMode
  bash: PermissionMode
  task: PermissionMode
  network: PermissionMode
  externalDirectory: PermissionMode
  skill: PermissionMode
  computer: PermissionMode
}

export interface ClientExperience {
  theme: "system" | "light" | "dark"
  density: "comfortable" | "compact"
  locale: "system" | "en" | "de" | "ar"
  homeSurface: "sessions" | "projects"
  defaultMode: "build" | "plan"
  instructions: string
  showTips: boolean
  showUsageMeter: boolean
}

export interface ClientLimits {
  monthlyTokensPerUser: number
  monthlySpendPerUserUsd: number
  maxComputersPerUser: number
  maxConcurrentSessions: number
  contextWindowTokens: number
  dailyScheduledRuns: number
  storageGb: number
  maxFileUploadMb: number
}

export interface ModelAccess {
  defaultModel: string
  allowed: string[]
  blocked: string[]
  allowCustomProviders: boolean
  allowByok: boolean
}

export interface Distribution {
  id: string
  slug: string
  name: string
  description: string
  status: "draft" | "published" | "archived"
  version: string
  createdAt: number
  updatedAt: number
  publishedAt?: number
  branding: Branding
  auth: ClientAuth
  features: ClientFeatures
  permissions: ClientPermissions
  experience: ClientExperience
  limits: ClientLimits
  models: ModelAccess
  telemetry: { enabled: boolean; includePrompts: boolean; includeFilePaths: boolean; retentionDays: number; endpoint?: string }
  update: { channel: "stable" | "beta" | "pinned"; pinnedVersion?: string; autoUpdate: boolean; allowDowngrade: boolean; minimumVersion?: string }
  deployment: {
    platforms: Platform[]
    mode: NetworkMode
    installerBaseUrl?: string
    offlineBundle: boolean
    proxyUrl?: string
    customCaCertificate?: string
  }
  releaseNotes: string
}

export type ReleaseStatus = "queued" | "building" | "ready" | "failed"

export interface ClientRelease {
  id: string
  distributionId: string
  distributionSlug: string
  version: string
  platform: Platform
  status: ReleaseStatus
  startedAt: number
  finishedAt?: number
  filename?: string
  bytes?: number
  sha256?: string
  error?: string
  log: string[]
}

export interface ReleaseTarget {
  platform: Platform
  supported: boolean
  reason?: string
  artifact: string
}

export interface ReleaseHost {
  platform: string
  arch: string
  root?: string
  ready: boolean
  reason?: string
}

export interface ReleaseOverview {
  ok: true
  build: boolean
  releases: ClientRelease[]
  host: ReleaseHost
  targets: ReleaseTarget[]
}

export interface ModelPolicy {
  mode: "allowlist" | "denylist"
  models: string[]
  requireApprovalForNewModels: boolean
}

export interface Policies {
  requireMfa: boolean
  sessionHours: number
  idleTimeoutMinutes: number
  ipAllowlist: string[]
  model: ModelPolicy
  tools: {
    allowShell: boolean
    allowFileWrite: boolean
    allowNetwork: boolean
    allowComputerUse: boolean
    allowBrowser: boolean
    allowSecrets: boolean
    requireApprovalFor: string[]
  }
  data: {
    retentionDays: number
    allowTraining: boolean
    redactSecrets: boolean
    blockPiiExport: boolean
    residency: "us" | "eu" | "apac" | "self-hosted"
    encryptionAtRest: boolean
    byok: boolean
  }
  audit: { retentionDays: number; exportFormat: "json" | "csv"; siemWebhook?: string }
  network: { egressAllowlist: string[]; blockPublicEgress: boolean }
}

export interface Integrations {
  slackWebhook?: string
  teamsWebhook?: string
  gchatWebhook?: string
  siemWebhook?: string
  genericWebhook?: string
  scimEnabled: boolean
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

export interface Organization {
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
  license: { token?: string; claims?: LicenseClaims; verifiedAt?: number; error?: string }
  scimEnabled: boolean
  integrations: Integrations
  smtp?: { host: string; port: number; username?: string; passwordSet: boolean; from: string; secure: boolean }
}

export interface OrganizationSummary {
  name: string
  slug: string
  region: string
  plan: "business" | "enterprise" | "trial" | "expired"
  trialEndsAt: number
  license: { valid: boolean; plan: "business" | "enterprise" | null; seats: number; publicKeyConfigured: boolean; expiresAt?: number; error?: string }
  branding: Branding
  policies: Policies
}

export interface SessionPayload {
  ok: true
  user: User
  capabilities: Capability[]
  organization: OrganizationSummary
  session: { kind: "admin" | "client"; expiresAt: number }
}

export interface AuditEvent {
  id: string
  at: number
  action: string
  actorId?: string
  actorEmail?: string
  target?: string
  ip?: string
  userAgent?: string
  metadata?: Record<string, string | number | boolean>
}

export interface UsageBucket {
  key: string
  requests: number
  inputTokens: number
  outputTokens: number
  costUsd: number
}

export interface UsageEvent {
  id: string
  at: number
  userId: string
  model: string
  provider?: string
  inputTokens: number
  outputTokens: number
  costUsd: number
  tool?: string
  computerId?: string
  sessionId?: string
  distributionId?: string
}

export interface UsageInsightRow extends UsageBucket {
  label: string
  share: number
  averageCostUsd: number
  tokensPerRequest: number
}

export interface UsageInsights {
  ok: true
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
  forecast: { dailyAverageUsd: number; next30DaysUsd: number; monthToDateUsd: number }
  concentration: { topFiveShare: number; topDecileShare: number }
  anomalies: { day: string; costUsd: number; multiple: number }[]
}

export interface Summary {
  users: { total: number; active: number; invited: number; suspended: number }
  seats: { used: number; licensed: number; available: number | null }
  distributions: { total: number; published: number }
  usage: { requests: number; inputTokens: number; outputTokens: number; costUsd: number; activeUsers: number }
  spendByDay: UsageBucket[]
  usageByModel: UsageBucket[]
  usageByUser: UsageBucket[]
  topTools: UsageBucket[]
  recentAudit: AuditEvent[]
  trial: { active: boolean; endsAt: number; daysLeft: number }
  license: { valid: boolean; plan: string; seats: number; expiresAt?: number; error?: string }
  health: { storeWritable: boolean; auditBacklog: number; lastWriteAt?: number }
}

export interface UsageResponse {
  ok: true
  days: number
  groupBy: "day" | "user" | "model" | "tool"
  buckets: UsageBucket[]
  total: { requests: number; inputTokens: number; outputTokens: number; costUsd: number }
  events: UsageEvent[]
  models: string[]
  users: { id: string; email: string; name: string }[]
}

export interface LicenseStatus {
  ok: true
  license: {
    plan: "business" | "enterprise" | "trial" | "expired"
    publicKeyConfigured: boolean
    license: { token?: string; claims?: LicenseClaims; verifiedAt?: number; error?: string }
    trialEndsAt: number
    seats: { used: number; licensed: number; available: number | null }
  }
}

export interface PublicConfig {
  ok: true
  version: string
  setupRequired: boolean
  organization: { name: string; slug: string }
  branding: Branding
  plan: string
  trialEndsAt: number
  licenseValid: boolean
}

export const ROLE_LABELS: Record<Role, string> = {
  owner: "Owner",
  admin: "Admin",
  manager: "Manager",
  member: "Member",
  auditor: "Auditor",
  billing: "Billing",
}

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  owner: "Full control, including ownership, licensing and security.",
  admin: "Manages people, distributions, policies and integrations.",
  manager: "Invites and manages team members, groups and usage reports.",
  member: "Uses the client. No console administration.",
  auditor: "Read-only access to the console, audit trail and reports.",
  billing: "Sees usage and manages the license. No people or policy changes.",
}

export function can(capabilities: readonly Capability[], capability: Capability): boolean {
  return capabilities.includes(capability)
}
