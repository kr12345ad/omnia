import {
  CAPABILITIES,
  type BackendDescriptor,
  type Capability,
  type CapabilityProfile,
  type CapabilityStatus,
  type CapabilitySupport,
  type ComputerPlatform,
  type DisplayServer,
  type Limitation,
  type LimitationSeverity,
  type PermissionRequirement,
  type PermissionStatus,
  type ProfileStatus,
  type QualityScore,
  type ApplicationProfile,
  normalizeComputerPlatform,
  resolveCapability,
} from "./contracts"

export const PERMISSION_IDS = {
  accessibility: "accessibility",
  screenRecording: "screen-recording",
  input: "input",
  waylandPortal: "wayland-portal",
  browser: "browser",
} as const

export const DEFAULT_QUALITY_WEIGHTS = {
  coverage: 0.35,
  reliability: 0.2,
  fidelity: 0.2,
  responsiveness: 0.1,
  permissionReadiness: 0.15,
} as const

export type QualityWeights = {
  readonly coverage: number
  readonly reliability: number
  readonly fidelity: number
  readonly responsiveness: number
  readonly permissionReadiness: number
}

export type QualityScoreOptions = {
  readonly requestedCapabilities?: readonly Capability[]
  readonly weights?: Partial<QualityWeights>
}

export type CapabilitySupportInput = {
  readonly capability: Capability
  readonly status?: CapabilityStatus
  readonly score?: number
  readonly reason?: string
  readonly permissions?: readonly PermissionRequirement[]
  readonly limitations?: readonly Limitation[]
}

export type CapabilityValue = CapabilitySupport | CapabilitySupportInput | CapabilityStatus | boolean

export type CapabilityProfileInput = {
  readonly backend: BackendDescriptor
  readonly capabilities: Readonly<Record<string, CapabilityValue>>
  readonly status?: ProfileStatus
  readonly permissions?: readonly PermissionRequirement[]
  readonly limitations?: readonly Limitation[]
  readonly displayServer?: DisplayServer
  readonly observedAt?: number
}

export type ApplicationProfileInput = {
  readonly id: string
  readonly applicationId?: string
  readonly name: string
  readonly kind?: ApplicationProfile["kind"]
  readonly backend: string
  readonly capabilities?: Readonly<Record<string, CapabilityValue>>
  readonly status?: ProfileStatus
  readonly permissions?: readonly PermissionRequirement[]
  readonly limitations?: readonly Limitation[]
  readonly displayServer?: DisplayServer
  readonly processName?: string
  readonly bundleID?: string
  readonly bundleId?: string
  readonly metadata?: Readonly<Record<string, string>>
}

const statusScores: Record<CapabilityStatus, number> = {
  available: 1,
  degraded: 0.5,
  partial: 0.5,
  unknown: 0.25,
  unavailable: 0,
}

const permissionScores: Record<PermissionStatus, number> = {
  granted: 1,
  "not-required": 1,
  prompt: 0.35,
  unknown: 0.25,
  denied: 0,
  restricted: 0,
}

function clamp(value: number) {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

function average(values: readonly number[], fallback = 0) {
  if (!values.length) return fallback
  return values.reduce((total, value) => total + value, 0) / values.length
}

function uniqueLimitations(limitations: readonly Limitation[]) {
  const seen = new Set<string>()
  return limitations.filter((limitation) => {
    const key = `${limitation.code}:${limitation.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function isCapabilitySupportObject(input: CapabilitySupport | CapabilitySupportInput): input is CapabilitySupport {
  return (
    input.status !== undefined &&
    input.score !== undefined &&
    input.permissions !== undefined &&
    input.limitations !== undefined
  )
}

function supportFromInput(input: CapabilityValue, capabilityKey?: string): CapabilitySupport {
  if (typeof input === "boolean") {
    return {
      capability: capabilityKey ?? "",
      status: input ? "available" : "unavailable",
      score: input ? 1 : 0,
      permissions: [],
      limitations: [],
    }
  }
  if (typeof input === "string") {
    const status = Object.hasOwn(statusScores, input) ? input : "unknown"
    return {
      capability: capabilityKey ?? "",
      status,
      score: statusScores[status],
      permissions: [],
      limitations: [],
    }
  }
  if (isCapabilitySupportObject(input)) {
    return {
      capability: input.capability,
      status: input.status,
      score: clamp(input.score),
      reason: input.reason,
      permissions: input.permissions,
      limitations: uniqueLimitations(input.limitations),
    }
  }
  const status = input.status ?? "unknown"
  return {
    capability: input.capability,
    status,
    score: clamp(input.score ?? statusScores[status]),
    reason: input.reason,
    permissions: input.permissions ?? [],
    limitations: uniqueLimitations(input.limitations ?? []),
  }
}

function profileStatus(
  capabilities: Readonly<Record<string, CapabilitySupport>>,
  requested?: ProfileStatus,
): ProfileStatus {
  if (requested) return requested
  const values = Object.values(capabilities)
  if (!values.length) return "unavailable"
  if (values.every((support) => support.status === "available")) return "ready"
  if (values.every((support) => support.status === "unavailable")) return "unavailable"
  return "partial"
}

function permissionReadiness(permissions: readonly PermissionRequirement[]) {
  if (!permissions.length) return 1
  return average(permissions.map((permission) => permissionScores[permission.status]))
}

function zeroQualityScore(): QualityScore {
  return {
    overall: 0,
    coverage: 0,
    reliability: 0,
    fidelity: 0,
    responsiveness: 0,
    permissionReadiness: 0,
  }
}

function supportScore(
  capabilities: Readonly<Record<string, CapabilitySupport>>,
  requestedCapabilities: readonly Capability[],
  weights: QualityWeights,
  responsiveness: number,
  permissions: readonly PermissionRequirement[],
): QualityScore {
  const selected = requestedCapabilities.length ? requestedCapabilities : Object.keys(capabilities).sort()
  const supports = selected.map((capability) => {
    const resolved = resolveCapability(capability)
    return capabilities[capability] ?? capabilities[resolved] ?? unavailableSupport(capability)
  })
  if (!supports.length || supports.every((support) => support.status === "unavailable")) return zeroQualityScore()
  const coverage = average(supports.map((support) => support.score * 0.65 + statusScores[support.status] * 0.35))
  const reliability = average(supports.map((support) => support.score))
  const fidelity = average(supports.map((support) => statusScores[support.status]))
  const readiness = permissionReadiness(permissions)
  const score = {
    coverage,
    reliability,
    fidelity,
    responsiveness: clamp(responsiveness),
    permissionReadiness: readiness,
  }
  return {
    ...score,
    overall: clamp(
      score.coverage * weights.coverage +
        score.reliability * weights.reliability +
        score.fidelity * weights.fidelity +
        score.responsiveness * weights.responsiveness +
        score.permissionReadiness * weights.permissionReadiness,
    ),
  }
}

function normalizeWeights(weights?: Partial<QualityWeights>): QualityWeights {
  if (!weights) return DEFAULT_QUALITY_WEIGHTS
  return {
    coverage: clamp(weights.coverage ?? DEFAULT_QUALITY_WEIGHTS.coverage),
    reliability: clamp(weights.reliability ?? DEFAULT_QUALITY_WEIGHTS.reliability),
    fidelity: clamp(weights.fidelity ?? DEFAULT_QUALITY_WEIGHTS.fidelity),
    responsiveness: clamp(weights.responsiveness ?? DEFAULT_QUALITY_WEIGHTS.responsiveness),
    permissionReadiness: clamp(weights.permissionReadiness ?? DEFAULT_QUALITY_WEIGHTS.permissionReadiness),
  }
}

function unavailableSupport(capability: Capability, reason = "Capability was not reported."): CapabilitySupport {
  return {
    capability,
    status: "unavailable",
    score: 0,
    reason,
    permissions: [],
    limitations: [],
  }
}

export function createCapabilitySupport(input: CapabilitySupportInput): CapabilitySupport {
  return supportFromInput(input)
}

export type ReportedCapabilitySupport = {
  readonly capability: string
  readonly status: CapabilityStatus
  readonly score?: number
  readonly reason?: string
  readonly permissions?: readonly {
    readonly id: string
    readonly description: string
    readonly status: PermissionStatus
    readonly capabilities?: readonly string[]
    readonly promptable?: boolean
    readonly reason?: string
  }[]
  readonly limitations?: readonly {
    readonly code: string
    readonly kind: Limitation["kind"]
    readonly severity: LimitationSeverity
    readonly message: string
    readonly affects?: readonly string[]
  }[]
}

export function createCapabilityProfileFromReport(input: {
  readonly backend: BackendDescriptor
  readonly capabilities: readonly ReportedCapabilitySupport[]
  readonly status?: ProfileStatus
  readonly permissions?: readonly PermissionRequirement[]
  readonly limitations?: readonly Limitation[]
  readonly displayServer?: DisplayServer
  readonly observedAt?: number
}): CapabilityProfile {
  return createCapabilityProfile({
    backend: input.backend,
    status: input.status,
    permissions: input.permissions,
    limitations: input.limitations,
    displayServer: input.displayServer,
    observedAt: input.observedAt,
    capabilities: Object.fromEntries(
      input.capabilities.map((reported) => [
        reported.capability,
        createCapabilitySupport({
          capability: reported.capability,
          status: reported.status,
          score: reported.score,
          reason: reported.reason,
          permissions: reported.permissions?.map((permission) => ({
            ...permission,
            capabilities: permission.capabilities ?? [],
            promptable: permission.promptable ?? false,
          })),
          limitations: reported.limitations?.map((limitation) => ({
            ...limitation,
            affects: limitation.affects ?? [],
          })),
        }),
      ]),
    ),
  })
}

export function scoreCapabilityProfile(profile: CapabilityProfile, options: QualityScoreOptions = {}): QualityScore {
  if (profile.status === "unavailable") return zeroQualityScore()
  return supportScore(
    profile.capabilities,
    options.requestedCapabilities ?? [],
    normalizeWeights(options.weights),
    profile.backend.responsiveness,
    profile.permissions,
  )
}

export const calculateCapabilityQuality = scoreCapabilityProfile

export function capabilityQualityScore(profile: CapabilityProfile, options: QualityScoreOptions = {}) {
  return scoreCapabilityProfile(profile, options).overall
}

export const qualityScore = capabilityQualityScore

export function createCapabilityProfile(input: CapabilityProfileInput): CapabilityProfile {
  const capabilities = Object.fromEntries(
    Object.entries(input.capabilities).map(([key, value]) => {
      const support = supportFromInput(value, key)
      return [key, { ...support, capability: key }]
    }),
  ) as Record<string, CapabilitySupport>
  const permissions = uniquePermissions(input.permissions ?? [])
  const profile = {
    backend: input.backend,
    status: profileStatus(capabilities, input.status),
    capabilities,
    permissions,
    limitations: uniqueLimitations(input.limitations ?? []),
    displayServer: input.displayServer,
    observedAt: input.observedAt,
  } satisfies Omit<CapabilityProfile, "quality">
  const evaluated = applyPermissionStatus(
    {
      ...profile,
      quality: supportScore(capabilities, [], DEFAULT_QUALITY_WEIGHTS, input.backend.responsiveness, permissions),
    },
    {},
  )
  return evaluated.displayServer === "wayland" ? applyWaylandLimitations(evaluated) : evaluated
}

function uniquePermissions(permissions: readonly PermissionRequirement[]) {
  const seen = new Set<string>()
  return permissions.filter((permission) => {
    if (seen.has(permission.id)) return false
    seen.add(permission.id)
    return true
  })
}

export function createUnavailableCapabilityProfile(input: {
  readonly backend: BackendDescriptor
  readonly reason: string
  readonly displayServer?: DisplayServer
  readonly capabilities?: readonly Capability[]
  readonly permissions?: readonly PermissionRequirement[]
  readonly limitations?: readonly Limitation[]
  readonly observedAt?: number
}): CapabilityProfile {
  const capabilities = Object.fromEntries(
    (input.capabilities ?? CAPABILITIES).map((capability) => [
      capability,
      unavailableSupport(capability, input.reason),
    ]),
  ) as Record<string, CapabilitySupport>
  const permissions = uniquePermissions(input.permissions ?? [])
  const evaluated = applyPermissionStatus(
    {
      backend: input.backend,
      status: "unavailable",
      capabilities,
      permissions,
      limitations: uniqueLimitations([
        ...(input.limitations ?? []),
        {
          code: "adapter-unavailable",
          kind: "compatibility",
          severity: "error",
          message: input.reason,
          affects: input.capabilities ?? CAPABILITIES,
        },
      ]),
      quality: supportScore(capabilities, [], DEFAULT_QUALITY_WEIGHTS, input.backend.responsiveness, permissions),
      displayServer: input.displayServer,
      observedAt: input.observedAt,
    },
    {},
  )
  return evaluated.displayServer === "wayland" ? applyWaylandLimitations(evaluated) : evaluated
}

export function createPartialCapabilityProfile(input: CapabilityProfileInput): CapabilityProfile {
  return createCapabilityProfile({ ...input, status: input.status ?? "partial" })
}

export function applyPermissionStatus(
  profile: CapabilityProfile,
  overrides: Readonly<Record<string, PermissionStatus>>,
): CapabilityProfile {
  const permissions = profile.permissions.map((permission) => ({
    ...permission,
    status: overrides[permission.id] ?? permission.status,
  }))
  const limitations = permissions.flatMap((permission) => {
    if (
      permission.status !== "denied" &&
      permission.status !== "restricted" &&
      permission.status !== "prompt" &&
      permission.status !== "unknown"
    )
      return []
    return [
      {
        code: `permission-${permission.status}`,
        kind: "permission" as const,
        severity:
          permission.status === "prompt" || permission.status === "unknown" ? ("warning" as const) : ("error" as const),
        message: permission.reason ?? permission.description,
        affects: permission.capabilities,
      },
    ]
  })
  const capabilities = Object.fromEntries(
    Object.entries(profile.capabilities).map(([capability, support]) => {
      const blocked = permissions.some(
        (permission) =>
          (permission.capabilities ?? []).includes(capability) &&
          (permission.status === "denied" || permission.status === "restricted"),
      )
      const needsPrompt = permissions.some(
        (permission) =>
          (permission.capabilities ?? []).includes(capability) &&
          (permission.status === "prompt" || permission.status === "unknown"),
      )
      if (blocked)
        return [
          capability,
          { ...support, status: "unavailable" as const, score: 0, reason: "Permission is unavailable." },
        ]
      if (needsPrompt && support.status === "available")
        return [capability, { ...support, status: "partial" as const, score: Math.min(support.score, 0.5) }]
      return [capability, support]
    }),
  ) as Record<string, CapabilitySupport>
  const values = Object.values(capabilities)
  const status =
    values.every((support) => support.status === "unavailable") || profile.status === "unavailable"
      ? "unavailable"
      : values.some((support) => support.status !== "available") ||
          limitations.length ||
          profile.limitations.length ||
          profile.status === "partial" ||
          profile.status === "degraded"
        ? profile.status === "degraded"
          ? "degraded"
          : "partial"
        : "ready"
  return {
    ...profile,
    status,
    capabilities,
    permissions,
    limitations: uniqueLimitations([...profile.limitations, ...limitations]),
    quality: supportScore(capabilities, [], DEFAULT_QUALITY_WEIGHTS, profile.backend.responsiveness, permissions),
  }
}

export function permissionLimitations(permissions: readonly PermissionRequirement[]) {
  return permissions.flatMap((permission) => {
    if (permission.status === "granted" || permission.status === "not-required") return []
    return [
      {
        code: `permission-${permission.status}`,
        kind: "permission" as const,
        severity:
          permission.status === "prompt" || permission.status === "unknown" ? ("warning" as const) : ("error" as const),
        message: permission.reason ?? permission.description,
        affects: permission.capabilities,
      },
    ]
  })
}

const waylandLimitedCapabilities = new Set<Capability>([
  "screen-read",
  "screen_read",
  "screen-capture",
  "screen_capture",
  "screenshot",
  "mouse",
  "pointer",
  "keyboard",
  "text-input",
  "drag-and-drop",
  "multi-monitor",
])

export function withDisplayServer(profile: CapabilityProfile, displayServer: DisplayServer): CapabilityProfile {
  if (profile.displayServer === displayServer) return profile
  return applyWaylandLimitations({ ...profile, displayServer })
}

export function applyWaylandLimitations(profile: CapabilityProfile): CapabilityProfile {
  if (profile.displayServer !== "wayland") return profile
  const portalPermission: PermissionRequirement = {
    id: PERMISSION_IDS.waylandPortal,
    description: "A desktop portal may be required for screen capture or input synthesis.",
    status: "prompt",
    capabilities: [...waylandLimitedCapabilities],
    promptable: true,
    reason: "Wayland does not provide unrestricted global input or screen capture to ordinary clients.",
  }
  const permissions = uniquePermissions([...profile.permissions, portalPermission])
  const capabilities = Object.fromEntries(
    Object.entries(profile.capabilities).map(([capability, support]) => {
      if (
        (!waylandLimitedCapabilities.has(capability) &&
          !waylandLimitedCapabilities.has(resolveCapability(capability))) ||
        support.status === "unavailable"
      )
        return [capability, support]
      return [
        capability,
        {
          ...support,
          status: "partial" as const,
          score: Math.min(support.score, 0.5),
          reason: support.reason ?? "Availability depends on a Wayland portal and compositor policy.",
          limitations: uniqueLimitations([
            ...support.limitations,
            {
              code: "wayland-portal-dependency",
              kind: "display-server",
              severity: "warning",
              message:
                "Wayland limits global input and screen capture unless a portal or compositor-specific path is available.",
              affects: [capability],
            },
          ]),
        },
      ]
    }),
  ) as Record<string, CapabilitySupport>
  return {
    ...profile,
    status: profile.status === "unavailable" ? "unavailable" : profile.status === "degraded" ? "degraded" : "partial",
    capabilities,
    permissions,
    limitations: uniqueLimitations([
      ...profile.limitations,
      {
        code: "wayland-security-model",
        kind: "display-server",
        severity: "warning",
        message: "Wayland security boundaries prevent assuming unrestricted desktop-wide input or capture.",
        affects: [...waylandLimitedCapabilities],
      },
    ]),
    quality: supportScore(capabilities, [], DEFAULT_QUALITY_WEIGHTS, profile.backend.responsiveness, permissions),
  }
}

export function applyWaylandLimitationsToApplication(application: ApplicationProfile): ApplicationProfile {
  if (application.displayServer !== "wayland") return application
  const portalPermission: PermissionRequirement = {
    id: PERMISSION_IDS.waylandPortal,
    description: "A desktop portal may be required for screen capture or input synthesis.",
    status: "prompt",
    capabilities: [...waylandLimitedCapabilities],
    promptable: true,
    reason: "Wayland does not provide unrestricted global input or screen capture to ordinary clients.",
  }
  const permissions = uniquePermissions([...application.permissions, portalPermission])
  const capabilities = Object.fromEntries(
    Object.entries(application.capabilities).map(([capability, support]) => {
      if (
        (!waylandLimitedCapabilities.has(capability) &&
          !waylandLimitedCapabilities.has(resolveCapability(capability))) ||
        support.status === "unavailable"
      )
        return [capability, support]
      return [
        capability,
        {
          ...support,
          status: "partial" as const,
          score: Math.min(support.score, 0.5),
          limitations: uniqueLimitations([
            ...support.limitations,
            {
              code: "wayland-portal-dependency",
              kind: "display-server",
              severity: "warning",
              message:
                "Wayland limits global input and screen capture unless a portal or compositor-specific path is available.",
              affects: [capability],
            },
          ]),
        },
      ]
    }),
  ) as Record<string, CapabilitySupport>
  return {
    ...application,
    status: application.status === "unavailable" ? "unavailable" : "partial",
    capabilities,
    permissions,
    limitations: uniqueLimitations([
      ...application.limitations,
      {
        code: "wayland-security-model",
        kind: "display-server",
        severity: "warning",
        message: "Wayland security boundaries prevent assuming unrestricted desktop-wide input or capture.",
        affects: [...waylandLimitedCapabilities],
      },
    ]),
    quality: supportScore(capabilities, [], DEFAULT_QUALITY_WEIGHTS, 0.5, permissions),
  }
}

export function createApplicationProfile(input: ApplicationProfileInput): ApplicationProfile {
  const capabilities = Object.fromEntries(
    Object.entries(input.capabilities ?? {}).map(([key, value]) => {
      const support = supportFromInput(value, key)
      return [key, { ...support, capability: key }]
    }),
  ) as Record<string, CapabilitySupport>
  const permissions = uniquePermissions(input.permissions ?? [])
  const limitations = uniqueLimitations([...(input.limitations ?? []), ...permissionLimitations(permissions)])
  const adjusted = Object.fromEntries(
    Object.entries(capabilities).map(([capability, support]) => {
      const blocked = permissions.some(
        (permission) =>
          (permission.capabilities ?? []).includes(capability) &&
          (permission.status === "denied" || permission.status === "restricted"),
      )
      const needsPrompt = permissions.some(
        (permission) =>
          (permission.capabilities ?? []).includes(capability) &&
          (permission.status === "prompt" || permission.status === "unknown"),
      )
      if (blocked) return [capability, { ...support, status: "unavailable" as const, score: 0 }]
      if (needsPrompt && support.status === "available")
        return [capability, { ...support, status: "partial" as const, score: Math.min(support.score, 0.5) }]
      return [capability, support]
    }),
  ) as Record<string, CapabilitySupport>
  const values = Object.values(adjusted)
  const status =
    input.status === "unavailable" || values.every((support) => support.status === "unavailable")
      ? "unavailable"
      : input.status === "partial" ||
          input.status === "degraded" ||
          values.some((support) => support.status !== "available") ||
          limitations.length
        ? input.status === "degraded"
          ? "degraded"
          : "partial"
        : "ready"
  const application = {
    id: input.id,
    applicationId: input.applicationId ?? input.id,
    name: input.name,
    kind: input.kind ?? "unknown",
    backend: input.backend,
    status,
    capabilities: adjusted,
    permissions,
    limitations,
    quality: supportScore(adjusted, [], DEFAULT_QUALITY_WEIGHTS, 0.5, permissions),
    displayServer: input.displayServer,
    processName: input.processName,
    bundleID: input.bundleID ?? input.bundleId,
    bundleId: input.bundleId ?? input.bundleID,
    metadata: input.metadata ?? {},
  } satisfies ApplicationProfile
  return input.displayServer === "wayland" ? applyWaylandLimitationsToApplication(application) : application
}

export const createApplicationCapabilityProfile = createApplicationProfile

export function filterApplicationProfiles(
  applications: readonly ApplicationProfile[],
  query: { readonly applicationId?: string; readonly name?: string; readonly kind?: ApplicationProfile["kind"] } = {},
) {
  return applications.filter((application) => {
    if (
      query.applicationId &&
      application.id !== query.applicationId &&
      application.applicationId !== query.applicationId
    )
      return false
    if (query.name && application.name !== query.name) return false
    if (query.kind && application.kind !== query.kind) return false
    return true
  })
}

export function unavailableApplicationProfile(input: {
  readonly id: string
  readonly name: string
  readonly backend: string
  readonly reason: string
  readonly kind?: ApplicationProfile["kind"]
  readonly permissions?: readonly PermissionRequirement[]
  readonly limitations?: readonly Limitation[]
}): ApplicationProfile {
  return createApplicationProfile({
    id: input.id,
    name: input.name,
    kind: input.kind,
    backend: input.backend,
    status: "unavailable",
    capabilities: Object.fromEntries(
      CAPABILITIES.map((capability) => [capability, unavailableSupport(capability, input.reason)]),
    ),
    permissions: input.permissions,
    limitations: [
      ...(input.limitations ?? []),
      {
        code: "application-unavailable",
        kind: "application",
        severity: "error",
        message: input.reason,
        affects: CAPABILITIES,
      },
    ],
  })
}

export function applicationSupports(
  application: ApplicationProfile,
  requestedCapabilities: readonly Capability[],
  allowPartial = true,
) {
  return requestedCapabilities.every((capability) => {
    const status =
      (application.capabilities[capability] ?? application.capabilities[resolveCapability(capability)])?.status ??
      "unavailable"
    if (status === "available") return true
    return allowPartial && (status === "partial" || status === "degraded" || status === "unknown")
  })
}

export function platformSupports(profile: CapabilityProfile, platform?: ComputerPlatform, allowFuture = false) {
  return (
    !platform ||
    normalizeComputerPlatform(profile.backend.platform) === normalizeComputerPlatform(platform) ||
    (allowFuture && profile.backend.platform === "future")
  )
}
