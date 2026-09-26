import { CAPABILITIES, type Capability, type CapabilityState, type CapabilityStates } from "./model"
import { normalizeCapabilityState, normalizeCapabilityStates } from "./normalize"

export type CoverageThreshold = "available" | "degraded"

export interface CapabilityRequirement {
  readonly capability: Capability
  readonly minimum?: CoverageThreshold
  readonly weight?: number
}

export interface CapabilityRequirementCoverage {
  readonly capability: Capability
  readonly required: CoverageThreshold
  readonly actual: CapabilityState
  readonly weight: number
  readonly score: number
  readonly satisfied: boolean
}

export interface CapabilityCoverage {
  readonly score: number
  readonly status: "covered" | "partial" | "uncovered" | "unknown"
  readonly covered: number
  readonly missing: readonly Capability[]
  readonly degraded: readonly Capability[]
  readonly unknown: readonly Capability[]
  readonly requirements: readonly CapabilityRequirementCoverage[]
}

export function scoreCapabilityCoverage(
  states: CapabilityStates | unknown,
  requirements: readonly CapabilityRequirement[] = CAPABILITIES.map((capability) => ({ capability })),
): CapabilityCoverage {
  const normalized = normalizeCapabilityStates(states)
  const duplicates = requirements.filter(
    (requirement, index) =>
      requirements.findIndex((candidate) => candidate.capability === requirement.capability) !== index,
  )
  if (duplicates.length > 0)
    throw new TypeError(`Duplicate capability requirement: ${duplicates[0]?.capability ?? "unknown"}`)
  const results = requirements.map((requirement) => scoreRequirement(normalized, requirement))
  const totalWeight = results.reduce((total, result) => total + result.weight, 0)
  const score = round(
    totalWeight === 0 ? 1 : results.reduce((total, result) => total + result.weight * result.score, 0) / totalWeight,
  )
  const missing = results
    .filter((result) => !result.satisfied && result.actual !== "unknown")
    .map((result) => result.capability)
  const degraded = results
    .filter((result) => result.actual === "degraded" && !result.satisfied)
    .map((result) => result.capability)
  const unknown = results.filter((result) => result.actual === "unknown").map((result) => result.capability)
  const covered = results.filter((result) => result.satisfied).length
  return {
    score,
    status: results.every((result) => result.satisfied)
      ? "covered"
      : score === 0 && unknown.length > 0
        ? "unknown"
        : score > 0
          ? "partial"
          : "uncovered",
    covered,
    missing,
    degraded,
    unknown,
    requirements: results,
  }
}

export function coverageForCapability(input: unknown): CapabilityState {
  return normalizeCapabilityState(input)
}

function scoreRequirement(states: CapabilityStates, requirement: CapabilityRequirement): CapabilityRequirementCoverage {
  const required = requirement.minimum ?? "available"
  const weight = requirement.weight ?? 1
  if (!CAPABILITIES.includes(requirement.capability))
    throw new TypeError(`Unknown capability: ${requirement.capability}`)
  if (!Number.isFinite(weight) || weight <= 0) throw new TypeError("Capability weight must be a positive finite number")
  const actual = states[requirement.capability]
  const stateScore = stateFactor(actual)
  const satisfied = actual !== "unknown" && stateScore >= stateFactor(required)
  return { capability: requirement.capability, required, actual, weight, score: stateScore, satisfied }
}

function stateFactor(value: CoverageThreshold | CapabilityState) {
  if (value === "available") return 1
  if (value === "degraded") return 0.5
  return 0
}

function round(value: number) {
  return Math.round(value * 10_000) / 10_000
}
