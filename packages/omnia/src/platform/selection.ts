import {
  type ApplicationProfile,
  type BackendId,
  type Capability,
  type CapabilityProfile,
  type CapabilityStatus,
  type ComputerPlatform,
  type DisplayServer,
  type Limitation,
  normalizeComputerPlatform,
  normalizeDisplayServer,
  resolveCapability,
} from "./contracts"
import { applicationSupports, scoreCapabilityProfile, withDisplayServer } from "./capabilities"

export type BackendSelectionRequest = {
  readonly platform?: ComputerPlatform
  readonly displayServer?: DisplayServer
  readonly requestedCapabilities?: readonly Capability[]
  readonly application?: ApplicationProfile
  readonly allowPartial?: boolean
  readonly allowFuture?: boolean
  readonly preferredBackendIds?: readonly BackendId[]
}

export type RankedBackend = {
  readonly profile: CapabilityProfile
  readonly score: number
  readonly eligible: boolean
  readonly rank?: number
  readonly rejectionReasons: readonly string[]
  readonly limitations: readonly Limitation[]
}

export type BackendSelection =
  | {
      readonly status: "selected"
      readonly profile: CapabilityProfile
      readonly ranked: readonly RankedBackend[]
      readonly score: number
      readonly limitations: readonly Limitation[]
    }
  | {
      readonly status: "partial"
      readonly profile: CapabilityProfile
      readonly ranked: readonly RankedBackend[]
      readonly score: number
      readonly reason: string
      readonly limitations: readonly Limitation[]
    }
  | {
      readonly status: "unavailable"
      readonly ranked: readonly RankedBackend[]
      readonly reason: string
    }

type ProfileInput = CapabilityProfile | { readonly profile: CapabilityProfile }

function profileOf(input: ProfileInput) {
  return "profile" in input ? input.profile : input
}

function isPartialStatus(status: CapabilityStatus) {
  return status === "partial" || status === "degraded" || status === "unknown"
}

function statusAllows(status: CapabilityStatus, allowPartial: boolean) {
  return status === "available" || (allowPartial && isPartialStatus(status))
}

function platformAllows(profile: CapabilityProfile, request: BackendSelectionRequest) {
  if (profile.backend.platform === "future") return request.allowFuture === true
  if (!request.platform) return true
  return normalizeComputerPlatform(profile.backend.platform) === normalizeComputerPlatform(request.platform)
}

function displayAllows(profile: CapabilityProfile, request: BackendSelectionRequest) {
  if (!request.displayServer) return true
  const displayServer = normalizeDisplayServer(request.displayServer)
  if (profile.displayServer && normalizeDisplayServer(profile.displayServer) !== displayServer) return false
  return profile.backend.displayServers.map(normalizeDisplayServer).includes(displayServer)
}

function capabilityRejections(
  profile: CapabilityProfile,
  requestedCapabilities: readonly Capability[],
  allowPartial: boolean,
) {
  return requestedCapabilities.flatMap((capability) => {
    const support = profile.capabilities[capability] ?? profile.capabilities[resolveCapability(capability)]
    if (!support) return [`${capability} is not reported`]
    if (statusAllows(support.status, allowPartial)) return []
    return [`${capability} is ${support.status}`]
  })
}

function permissionRejections(
  profile: CapabilityProfile,
  requestedCapabilities: readonly Capability[],
  allowPartial: boolean,
) {
  return profile.permissions.flatMap((permission) => {
    if (!(permission.capabilities ?? []).some((capability) => requestedCapabilities.includes(capability))) return []
    if (permission.status === "denied" || permission.status === "restricted")
      return [`${permission.id} is ${permission.status}`]
    if ((permission.status === "prompt" || permission.status === "unknown") && !allowPartial)
      return [`${permission.id} requires approval`]
    return []
  })
}

function applicationScore(profile: CapabilityProfile, request: BackendSelectionRequest) {
  if (!request.application)
    return scoreCapabilityProfile(profile, { requestedCapabilities: request.requestedCapabilities }).overall
  const profileScore = scoreCapabilityProfile(profile, { requestedCapabilities: request.requestedCapabilities }).overall
  const applicationQuality = request.application.quality.overall
  return profileScore * 0.75 + applicationQuality * 0.25
}

function applicationLimitations(request: BackendSelectionRequest) {
  return request.application?.limitations ?? []
}

function hasPartialCapability(profile: CapabilityProfile, requestedCapabilities: readonly Capability[]) {
  const selected = requestedCapabilities.length ? requestedCapabilities : Object.keys(profile.capabilities)
  return selected.some((capability) => {
    const status = (profile.capabilities[capability] ?? profile.capabilities[resolveCapability(capability)])?.status
    return status !== undefined && isPartialStatus(status)
  })
}

function hasPendingPermission(profile: CapabilityProfile) {
  return profile.permissions.some((permission) => permission.status === "prompt" || permission.status === "unknown")
}

function rankOne(input: ProfileInput, request: BackendSelectionRequest): RankedBackend {
  const source = profileOf(input)
  const profile =
    request.displayServer && !source.displayServer ? withDisplayServer(source, request.displayServer) : source
  const allowPartial = request.allowPartial ?? true
  const requestedCapabilities = request.requestedCapabilities ?? []
  const rejectionReasons = [
    ...(platformAllows(profile, request)
      ? []
      : [`platform ${profile.backend.platform} does not match ${request.platform}`]),
    ...(displayAllows(profile, request) ? [] : [`display server ${request.displayServer} is not supported`]),
    ...(profile.status === "unavailable" ? ["adapter is unavailable"] : []),
    ...capabilityRejections(profile, requestedCapabilities, allowPartial),
    ...permissionRejections(profile, requestedCapabilities, allowPartial),
    ...(request.application && request.application.status === "unavailable" ? ["application is unavailable"] : []),
    ...(request.application && request.application.backend !== profile.backend.id
      ? [`application belongs to ${request.application.backend}`]
      : []),
    ...(request.application && !applicationSupports(request.application, requestedCapabilities, allowPartial)
      ? ["application does not provide the requested capabilities"]
      : []),
  ]
  const baseScore = applicationScore(profile, request)
  const preferred = request.preferredBackendIds?.includes(profile.backend.id) ? 0.05 : 0
  return {
    profile,
    score: Math.min(1, baseScore + preferred),
    eligible: rejectionReasons.length === 0,
    rejectionReasons,
    limitations: [...profile.limitations, ...applicationLimitations(request)],
  }
}

function compare(left: RankedBackend, right: RankedBackend, preferred: readonly BackendId[]) {
  if (left.eligible !== right.eligible) return left.eligible ? -1 : 1
  const leftPreferred = preferred.includes(left.profile.backend.id) ? 1 : 0
  const rightPreferred = preferred.includes(right.profile.backend.id) ? 1 : 0
  if (leftPreferred !== rightPreferred) return rightPreferred - leftPreferred
  if (left.score !== right.score) return right.score - left.score
  if (left.profile.backend.priority !== right.profile.backend.priority) {
    return right.profile.backend.priority - left.profile.backend.priority
  }
  return left.profile.backend.id.localeCompare(right.profile.backend.id)
}

export function rankBackends(
  inputs: readonly ProfileInput[],
  request: BackendSelectionRequest = {},
): readonly RankedBackend[] {
  const preferred = request.preferredBackendIds ?? []
  const ranked = inputs.map((input) => rankOne(input, request)).sort((left, right) => compare(left, right, preferred))
  return ranked.map((entry, index) =>
    entry.eligible
      ? { ...entry, rank: ranked.slice(0, index).filter((candidate) => candidate.eligible).length + 1 }
      : entry,
  )
}

export const rankComputerBackends = rankBackends

export function rankEligibleBackends(inputs: readonly ProfileInput[], request: BackendSelectionRequest = {}) {
  return rankBackends(inputs, request).filter((entry) => entry.eligible)
}

export function selectBackend(
  inputs: readonly ProfileInput[],
  request: BackendSelectionRequest = {},
): BackendSelection {
  const ranked = rankBackends(inputs, request)
  const candidate = ranked.find((entry) => entry.eligible)
  if (!candidate) {
    const reasons = [...new Set(ranked.flatMap((entry) => entry.rejectionReasons))]
    return {
      status: "unavailable",
      ranked,
      reason: reasons.length ? reasons.join("; ") : "No compatible computer backend is available.",
    }
  }
  const applicationPartial =
    request.application?.status === "partial" ||
    request.application?.status === "degraded" ||
    request.application?.permissions.some(
      (permission) => permission.status === "prompt" || permission.status === "unknown",
    ) === true
  const partial =
    candidate.profile.status === "partial" ||
    candidate.profile.status === "degraded" ||
    hasPartialCapability(candidate.profile, request.requestedCapabilities ?? []) ||
    hasPendingPermission(candidate.profile) ||
    applicationPartial
  if (!partial) {
    return {
      status: "selected",
      profile: candidate.profile,
      ranked,
      score: candidate.score,
      limitations: candidate.limitations,
    }
  }
  return {
    status: "partial",
    profile: candidate.profile,
    ranked,
    score: candidate.score,
    reason: "The selected backend can perform only part of the requested work.",
    limitations: candidate.limitations,
  }
}

export const selectComputerBackend = selectBackend
export const chooseBackend = selectBackend

export function unavailableSelection(reason: string, ranked: readonly RankedBackend[] = []): BackendSelection {
  return { status: "unavailable", ranked, reason }
}
