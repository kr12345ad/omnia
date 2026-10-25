// The tenant profile bundled into an enterprise installer.
//
// A managed build is not the public app: its identity, server, sign-in method
// and feature rules come from the distribution that produced it. The profile is
// written by the build farm and packaged as `resources/enterprise.json`, so it
// is available before the app is ready and cannot be edited by the user.

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { EnterprisePolicy } from "@opencode-ai/app/context/platform"

export interface EnterpriseBranding {
  productName?: string
  shortName?: string
  tagline?: string
  primaryColor?: string
  accentColor?: string
  signInHeadline?: string
  signInSubheadline?: string
  logoUrl?: string
  iconUrl?: string
  supportUrl?: string
  docsUrl?: string
  footerText?: string
  showOmniaBranding?: boolean
}

export interface EnterpriseAuthPolicy {
  mode?: "sso" | "password" | "oidc" | "saml"
  methods?: string[]
  sessionHours?: number
  requireMfa?: boolean
  allowedEmailDomains?: string[]
  allowSocialLogin?: boolean
}

export interface EnterpriseOrg {
  readonly name: string
  readonly slug: string
}

export interface EnterpriseExperience {
  theme?: "system" | "light" | "dark"
  density?: "comfortable" | "compact"
  locale?: string
  homeSurface?: "sessions" | "projects"
  /** Legacy manifest key kept readable so older deployments still apply it. */
  home?: string
  defaultMode?: string
  instructions?: string
  showTips?: boolean
  showUsageMeter?: boolean
}

export interface EnterpriseUpdate {
  channel?: "stable" | "beta" | "pinned"
  pinnedVersion?: string
  autoUpdate?: boolean
  allowDowngrade?: boolean
  minimumVersion?: string
}

export interface EnterpriseDeployment {
  platforms?: string[]
  mode?: "lan" | "public"
  offlineBundle?: boolean
  installerBaseUrl?: string
  proxyUrl?: string
}

export type PermissionMode = "allow" | "ask" | "deny"

/** Tool-level rules the client ships to its agent. */
export interface EnterprisePermissions {
  read: PermissionMode
  edit: PermissionMode
  bash: PermissionMode
  task: PermissionMode
  network: PermissionMode
  externalDirectory: PermissionMode
  skill: PermissionMode
  computer: PermissionMode
}

/** The baked profile is the served manifest plus the build's own identity. */
export interface EnterpriseProfile {
  readonly kind: "omnia-enterprise-client"
  readonly schema: 1
  readonly distribution: string
  readonly version: string
  readonly publishedAt?: number
  readonly name: string
  readonly appId: string
  readonly server: string
  readonly manifestUrl: string
  readonly loginUrl: string
  readonly org: EnterpriseOrg
  readonly branding: EnterpriseBranding
  readonly auth: EnterpriseAuthPolicy
  readonly features: Record<string, boolean>
  readonly permissions?: Partial<EnterprisePermissions>
  readonly experience: EnterpriseExperience
  readonly limits: Record<string, unknown>
  readonly models: Record<string, unknown>
  readonly telemetry: Record<string, unknown>
  readonly update: EnterpriseUpdate
  readonly deployment: EnterpriseDeployment
}

export interface EnterpriseManifest {
  readonly version: string
  readonly publishedAt?: number
  readonly org?: EnterpriseOrg
  readonly branding?: EnterpriseBranding
  readonly auth?: EnterpriseAuthPolicy
  readonly features?: Record<string, boolean>
  readonly permissions?: Partial<EnterprisePermissions>
  readonly experience?: EnterpriseExperience
  readonly limits?: Record<string, unknown>
  readonly models?: Record<string, unknown>
  readonly telemetry?: Record<string, unknown>
  readonly update?: EnterpriseUpdate
}

const MANIFEST_TTL_MS = 60 * 1000

let profileState: EnterpriseProfile | undefined | null = null
let manifestState: { value: EnterpriseManifest | undefined; at: number } | undefined

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function enterpriseProfileCandidates(): string[] {
  const configured = process.env.OMNIA_ENTERPRISE_PROFILE?.trim()
  return [
    ...(configured === undefined || configured.length === 0 ? [] : [configured]),
    join(process.resourcesPath ?? "", "enterprise.json"),
  ]
}

/**
 * True when this is a tenant installer, whether or not the bundled profile
 * parses. The sign-in surface must be decided by build identity, never by a
 * successful profile read: a managed client that fails to read its own
 * profile must still never offer GitHub or Google.
 */
export function isEnterpriseBuild(): boolean {
  return enterpriseProfileCandidates().some((file) => existsSync(file))
}

export function enterpriseProfile(): EnterpriseProfile | undefined {
  if (profileState !== null) return profileState
  for (const file of enterpriseProfileCandidates()) {
    const profile = readEnterpriseProfileFile(file)
    if (profile !== undefined) {
      profileState = profile
      return profile
    }
  }
  profileState = undefined
  return undefined
}

/** Read the profile file electron-builder packaged, or undefined when it cannot. */
export function readEnterpriseProfileFile(file: string): EnterpriseProfile | undefined {
  if (!existsSync(file)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return undefined
  }
  return readEnterpriseProfile(parsed)
}

/**
 * The profile follows the served manifest exactly, plus the build identity
 * (`kind`, `appId`, `server`, `manifestUrl`, `loginUrl`). Older installers baked
 * `org` as a string, so that one field is normalized instead of rejected.
 */
export function readEnterpriseProfile(value: unknown): EnterpriseProfile | undefined {
  if (!isRecord(value)) return undefined
  if (value.kind !== "omnia-enterprise-client" || value.schema !== 1) return undefined
  const distribution = text(value.distribution)
  const name = text(value.name)
  const appId = text(value.appId)
  const server = text(value.server)
  if (distribution === undefined || name === undefined || appId === undefined || server === undefined) return undefined
  const permissions = readPermissions(value.permissions)
  return {
    kind: "omnia-enterprise-client",
    schema: 1,
    distribution,
    version: text(value.version) ?? "",
    ...(value.publishedAt === undefined || typeof value.publishedAt !== "number" ? {} : { publishedAt: value.publishedAt }),
    name,
    appId,
    server: server.replace(/\/+$/, ""),
    manifestUrl: text(value.manifestUrl) ?? "",
    loginUrl: text(value.loginUrl) ?? "",
    org: readOrg(value.org) ?? { name, slug: "" },
    branding: isRecord(value.branding) ? (value.branding as EnterpriseBranding) : {},
    auth: isRecord(value.auth) ? (value.auth as EnterpriseAuthPolicy) : {},
    features: isRecord(value.features) ? (value.features as Record<string, boolean>) : {},
    ...(Object.keys(permissions).length === 0 ? {} : { permissions }),
    experience: isRecord(value.experience) ? (value.experience as EnterpriseExperience) : {},
    limits: isRecord(value.limits) ? value.limits : {},
    models: isRecord(value.models) ? value.models : {},
    telemetry: isRecord(value.telemetry) ? value.telemetry : {},
    update: isRecord(value.update) ? (value.update as EnterpriseUpdate) : {},
    deployment: isRecord(value.deployment) ? (value.deployment as EnterpriseDeployment) : {},
  }
}

function readOrg(value: unknown): EnterpriseOrg | undefined {
  if (typeof value === "string") {
    const legacy = text(value)
    return legacy === undefined ? undefined : { name: legacy, slug: "" }
  }
  if (!isRecord(value)) return undefined
  const name = text(value.name)
  if (name === undefined) return undefined
  return { name, slug: text(value.slug) ?? "" }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

export function enterpriseAppId(): string | undefined {
  return enterpriseProfile()?.appId
}

export function enterpriseProductName(): string | undefined {
  const profile = enterpriseProfile()
  if (profile === undefined) return undefined
  return profile.branding.productName?.trim() || profile.name
}

/** The server this build belongs to; installers for LAN deployments may bake none. */
export function enterpriseServerUrl(): string | undefined {
  const server = enterpriseProfile()?.server
  return server === undefined || server.length === 0 ? undefined : server
}

/**
 * A session minted by another control plane must never be reused by this build,
 * even if its userData was copied from the public app.
 */
export function isEnterpriseSessionUrl(url: string): boolean {
  const server = enterpriseServerUrl()
  if (server === undefined) return enterpriseProfile() === undefined
  return url.replace(/\/+$/, "") === server
}

export function enterpriseFeatures(): Record<string, boolean> {
  const profile = enterpriseProfile()
  if (profile === undefined) return {}
  return { ...profile.features, ...(manifestState?.value?.features ?? {}) }
}

export function enterpriseFeature(name: string): boolean {
  const profile = enterpriseProfile()
  if (profile === undefined) return true
  return enterpriseFeatures()[name] !== false
}

function permissionMode(value: unknown): PermissionMode | undefined {
  return value === "allow" || value === "ask" || value === "deny" ? value : undefined
}

/** Keep only the known keys and modes; an unknown rule is ignored, not trusted. */
function readPermissions(value: unknown): Partial<EnterprisePermissions> {
  if (!isRecord(value)) return {}
  const read: PermissionMode | undefined = permissionMode(value.read)
  const edit: PermissionMode | undefined = permissionMode(value.edit)
  const bash: PermissionMode | undefined = permissionMode(value.bash)
  const task: PermissionMode | undefined = permissionMode(value.task)
  const network: PermissionMode | undefined = permissionMode(value.network)
  const externalDirectory: PermissionMode | undefined = permissionMode(value.externalDirectory)
  const skill: PermissionMode | undefined = permissionMode(value.skill)
  const computer: PermissionMode | undefined = permissionMode(value.computer)
  return {
    ...(read === undefined ? {} : { read }),
    ...(edit === undefined ? {} : { edit }),
    ...(bash === undefined ? {} : { bash }),
    ...(task === undefined ? {} : { task }),
    ...(network === undefined ? {} : { network }),
    ...(externalDirectory === undefined ? {} : { externalDirectory }),
    ...(skill === undefined ? {} : { skill }),
    ...(computer === undefined ? {} : { computer }),
  }
}

/**
 * The rules this build actually applies. A capability switch that is off always
 * denies, so a stale manifest cannot re-enable a tool an admin turned off; the
 * live manifest refines the baked profile when it is reachable.
 */
export function enterprisePermissions(): EnterprisePermissions {
  const profile = enterpriseProfile()
  if (profile === undefined) {
    return {
      read: "allow",
      edit: "allow",
      bash: "allow",
      task: "allow",
      network: "allow",
      externalDirectory: "allow",
      skill: "allow",
      computer: "allow",
    }
  }
  const features = enterpriseFeatures()
  const served = { ...(profile.permissions ?? {}), ...(manifestState?.value?.permissions ?? {}) }
  return {
    read: served.read ?? "allow",
    edit: served.edit ?? "allow",
    bash: features.shellTool === false ? "deny" : (served.bash ?? "allow"),
    task: features.subagents === false ? "deny" : (served.task ?? "allow"),
    network: features.networkAccess === false ? "deny" : (served.network ?? "allow"),
    externalDirectory: served.externalDirectory ?? "allow",
    skill: served.skill ?? "allow",
    computer: features.computerUse === false ? "deny" : (served.computer ?? "allow"),
  }
}

/**
 * The engine's own permission vocabulary. Denying a tool here removes it before
 * the model can call it, which is stronger than hiding the matching UI.
 */
export function enterprisePermissionEnv(): string | undefined {
  if (enterpriseProfile() === undefined) return undefined
  const permissions = enterprisePermissions()
  return JSON.stringify({
    read: permissions.read,
    glob: permissions.read,
    grep: permissions.read,
    list: permissions.read,
    edit: permissions.edit,
    bash: permissions.bash,
    task: permissions.task,
    webfetch: permissions.network,
    websearch: permissions.network,
    external_directory: permissions.externalDirectory,
    skill: permissions.skill,
  })
}

/** Refuse a main-process capability the distribution disabled. */
export function requireEnterpriseFeature(feature: string, label: string): void {
  if (!enterpriseFeature(feature)) {
    throw new Error(`${label} is turned off for this organization's client.`)
  }
}

/** Wrap an IPC listener so a disabled feature fails closed in the main process. */
export function enterpriseGuard<Args extends unknown[], Result>(
  feature: string,
  label: string,
  handler: (...args: Args) => Result,
): (...args: Args) => Result {
  return (...args) => {
    requireEnterpriseFeature(feature, label)
    return handler(...args)
  }
}

/** Fetch the live manifest once per minute; the baked profile is the fallback. */
export async function enterpriseManifest(): Promise<EnterpriseManifest | undefined> {
  const profile = enterpriseProfile()
  if (profile === undefined || profile.manifestUrl.length === 0) return undefined
  if (manifestState !== undefined && Date.now() - manifestState.at < MANIFEST_TTL_MS) return manifestState.value
  let value: EnterpriseManifest | undefined
  try {
    const response = await fetch(profile.manifestUrl, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    })
    const body: unknown = await response.json()
    const manifest = isRecord(body) && isRecord(body.manifest) ? body.manifest : undefined
    if (response.ok && manifest !== undefined) value = readManifest(manifest)
  } catch {
    // The baked profile still carries the rules; a LAN launch may be offline.
  }
  manifestState = { value: value ?? manifestState?.value, at: Date.now() }
  return manifestState.value
}

function readManifest(value: Record<string, unknown>): EnterpriseManifest {
  const org = readOrg(value.org)
  const permissions = readPermissions(value.permissions)
  return {
    version: text(value.version) ?? "",
    ...(typeof value.publishedAt !== "number" ? {} : { publishedAt: value.publishedAt }),
    ...(org === undefined ? {} : { org }),
    ...(isRecord(value.branding) ? { branding: value.branding as EnterpriseBranding } : {}),
    ...(isRecord(value.auth) ? { auth: value.auth as EnterpriseAuthPolicy } : {}),
    ...(isRecord(value.features) ? { features: value.features as Record<string, boolean> } : {}),
    ...(Object.keys(permissions).length === 0 ? {} : { permissions }),
    ...(isRecord(value.limits) ? { limits: value.limits } : {}),
    ...(isRecord(value.models) ? { models: value.models } : {}),
    ...(isRecord(value.experience) ? { experience: value.experience as EnterpriseExperience } : {}),
    ...(isRecord(value.telemetry) ? { telemetry: value.telemetry } : {}),
    ...(isRecord(value.update) ? { update: value.update as EnterpriseUpdate } : {}),
  }
}

export function forgetEnterpriseManifest(): void {
  manifestState = undefined
}

/** Drop the cached profile and manifest; used when the build identity changes. */
export function forgetEnterpriseProfile(): void {
  profileState = null
  manifestState = undefined
}

/**
 * Everything the admin configured, resolved for the client: the baked profile
 * underneath, the live manifest over it. Social login is never an output no
 * matter what a payload claims; unknown sign-in methods are dropped because
 * this server only serves the work-account flow.
 */
// The renderer-facing shape lives with the platform contract; the main process
// only fills it.
const KNOWN_AUTH_METHODS = ["password"]

function number(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []
}

export async function enterprisePolicy(): Promise<EnterprisePolicy | undefined> {
  const profile = enterpriseProfile()
  if (profile === undefined) return undefined
  const manifest = await enterpriseManifest().catch(() => undefined)
  // The live manifest is the admin's current branding and the baked profile is
  // only the offline fallback. Merging the two would let a logo the admin has
  // since removed keep its baked URL, so the client would request a dead asset
  // forever while the manifest said nothing about it.
  const brand = manifest?.branding ?? profile.branding
  const auth = { ...profile.auth, ...(manifest?.auth ?? {}) }
  const productName = brand.productName ?? profile.name
  const limits = { ...(isRecord(profile.limits) ? profile.limits : {}), ...(manifest?.limits ?? {}) }
  const models = { ...(isRecord(profile.models) ? profile.models : {}), ...(manifest?.models ?? {}) }
  const telemetry = {
    ...(isRecord(profile.telemetry) ? profile.telemetry : {}),
    ...(manifest?.telemetry ?? {}),
  }
  // The baked profile carries the same experience and update fields as the
  // manifest, so a first launch on an offline LAN still gets the admin's theme,
  // density, locale and update floor before any manifest fetch succeeds.
  const experience = { ...profile.experience, ...(manifest?.experience ?? {}) }
  const update = { ...profile.update, ...(manifest?.update ?? {}) }
  return {
    org: profile.org.name,
    name: profile.name,
    branding: {
      productName,
      shortName: brand.shortName ?? productName,
      tagline: brand.tagline ?? "",
      primaryColor: brand.primaryColor ?? "#0a0a0a",
      accentColor: brand.accentColor ?? "#2563eb",
      signInHeadline: brand.signInHeadline ?? `Sign in to ${productName}`,
      signInSubheadline: brand.signInSubheadline ?? "Use your work email address and password.",
      ...(brand.logoUrl === undefined ? {} : { logoUrl: brand.logoUrl }),
      ...(text(brand.iconUrl) === undefined ? {} : { iconUrl: brand.iconUrl }),
      ...(text(brand.supportUrl) === undefined ? {} : { supportUrl: brand.supportUrl }),
      ...(text(brand.docsUrl) === undefined ? {} : { docsUrl: brand.docsUrl }),
      ...(text(brand.footerText) === undefined ? {} : { footerText: brand.footerText }),
      showOmniaBranding: brand.showOmniaBranding !== false,
    },
    auth: {
      mode: "sso",
      methods: strings(auth.methods).filter((method) => KNOWN_AUTH_METHODS.includes(method)),
      sessionHours: Math.max(1, Math.min(720, number(auth.sessionHours, 12))),
      requireMfa: auth.requireMfa === true,
      allowedEmailDomains: strings(auth.allowedEmailDomains)
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry.length > 0),
      allowSocialLogin: false,
    },
    features: { ...profile.features, ...(manifest?.features ?? {}) },
    permissions: enterprisePermissions(),
    experience: {
      theme: text(experience.theme) ?? "system",
      density: text(experience.density) ?? "comfortable",
      locale: text(experience.locale) ?? "system",
      homeSurface: text(experience.home) ?? text(experience.homeSurface) ?? "sessions",
      defaultMode: text(experience.defaultMode) ?? "build",
      instructions: text(experience.instructions) ?? "",
      showTips: experience.showTips !== false,
      showUsageMeter: experience.showUsageMeter !== false,
    },
    limits: {
      monthlyTokensPerUser: number(limits.monthlyTokensPerUser, 0),
      monthlySpendPerUserUsd: number(limits.monthlySpendPerUserUsd, 0),
      maxComputersPerUser: number(limits.maxComputersPerUser, 0),
      maxConcurrentSessions: number(limits.maxConcurrentSessions, 0),
      contextWindowTokens: number(limits.contextWindowTokens, 0),
      dailyScheduledRuns: number(limits.dailyScheduledRuns, 0),
      storageGb: number(limits.storageGb, 0),
      maxFileUploadMb: number(limits.maxFileUploadMb, 0),
    },
    models: {
      defaultModel: text(models.defaultModel) ?? "",
      allowed: strings(models.allowed),
      blocked: strings(models.blocked),
      allowCustomProviders: models.allowCustomProviders === true,
      allowByok: models.allowByok === true,
    },
    telemetry: {
      enabled: telemetry.enabled !== false,
      includePrompts: telemetry.includePrompts === true,
      includeFilePaths: telemetry.includeFilePaths === true,
      retentionDays: number(telemetry.retentionDays, 30),
    },
    update: {
      channel: text(update.channel) ?? "stable",
      ...(text(update.pinnedVersion) === undefined ? {} : { pinnedVersion: text(update.pinnedVersion) }),
      autoUpdate: update.autoUpdate !== false,
      allowDowngrade: update.allowDowngrade === true,
      ...(text(update.minimumVersion) === undefined ? {} : { minimumVersion: text(update.minimumVersion) }),
    },
  }
}
