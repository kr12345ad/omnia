import type { Environment, ProtocolLocation, RunContext, RunLimits } from "./contracts"
import { DEFAULT_RUN_LIMITS } from "./contracts"
import { deepFreeze, freezeClone } from "./events"

export interface RunContextInput {
  readonly runID: string
  readonly agentID: string
  readonly parentRunID?: string
  readonly sessionID?: string
  readonly location?: ProtocolLocation
  readonly environment: Environment
  readonly limits?: Partial<RunLimits>
  readonly createdAt?: number
  readonly metadata?: Readonly<Record<string, string>>
}

export function createRunContext(input: RunContextInput): RunContext {
  if (input.runID.trim().length === 0) throw new TypeError("runID must not be empty")
  if (input.agentID.trim().length === 0) throw new TypeError("agentID must not be empty")
  if (input.createdAt !== undefined && (!Number.isFinite(input.createdAt) || input.createdAt < 0)) {
    throw new TypeError("createdAt must be a non-negative finite number")
  }
  const limits = normalizeLimits(input.limits)
  return deepFreeze({
    runID: input.runID,
    agentID: input.agentID,
    parentRunID: input.parentRunID,
    sessionID: input.sessionID,
    location: input.location === undefined ? undefined : freezeClone(input.location),
    environment: normalizeEnvironment(input.environment),
    limits,
    createdAt: input.createdAt ?? Date.now(),
    metadata: { ...input.metadata },
  })
}

export function normalizeLimits(limits: Partial<RunLimits> = {}): RunLimits {
  const result = {
    maxSteps: limits.maxSteps ?? DEFAULT_RUN_LIMITS.maxSteps,
    maxToolCalls: limits.maxToolCalls ?? DEFAULT_RUN_LIMITS.maxToolCalls,
    maxRetries: limits.maxRetries ?? DEFAULT_RUN_LIMITS.maxRetries,
    maxDurationMs: limits.maxDurationMs ?? DEFAULT_RUN_LIMITS.maxDurationMs,
    maxSubagents: limits.maxSubagents ?? DEFAULT_RUN_LIMITS.maxSubagents,
  }
  for (const [key, value] of Object.entries(result)) {
    if (!Number.isFinite(value) || value < 0) throw new RangeError(`${key} must be a non-negative finite number`)
  }
  return Object.freeze(result)
}

export function normalizeEnvironment(environment: Environment): Environment {
  if (environment.cwd.trim().length === 0) throw new TypeError("environment cwd must not be empty")
  return deepFreeze({
    ...environment,
    cwd: environment.cwd,
    platform: environment.platform,
    shell: environment.shell,
    ci: environment.ci,
    tools: [...new Set(environment.tools)].toSorted(),
    variables: { ...environment.variables },
  })
}
