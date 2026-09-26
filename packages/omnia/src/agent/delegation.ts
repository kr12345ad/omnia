import type { LimitKind, ProtocolLocation, RunContext } from "./contracts"
import type { MemoryScope, MemorySensitivity } from "./memory"

export interface DelegationScope {
  readonly tools: readonly string[]
  readonly roots: readonly string[]
  readonly memoryScopes: readonly MemoryScope[]
  readonly maxSteps: number
  readonly maxToolCalls: number
  readonly maxRetries: number
  readonly maxDurationMs: number
  readonly maxSubagents: number
  readonly maxSensitivity: MemorySensitivity
  readonly permissions: readonly string[]
}

export interface DelegationRequest {
  readonly parent: RunContext
  readonly childAgentID: string
  readonly childRunID?: string
  readonly task: string
  readonly scope: DelegationScope
  readonly parentScope?: DelegationScope
  readonly location?: ProtocolLocation
  readonly expiresAt?: number
}

export interface DelegationContract {
  readonly parentRunID: string
  readonly childRunID: string
  readonly childAgentID: string
  readonly task: string
  readonly scope: DelegationScope
  readonly parentScope?: DelegationScope
  readonly location?: ProtocolLocation
  readonly expiresAt?: number
}

export class DelegationError extends Error {
  readonly code: "invalid" | "scope" | "limit" | "sensitivity"

  constructor(code: DelegationError["code"], message: string) {
    super(message)
    this.name = "DelegationError"
    this.code = code
  }
}

export function constrainScope(parent: DelegationScope, requested: DelegationScope): DelegationScope {
  const normalizedParent = freezeScope(parent)
  const normalizedRequested = freezeScope(requested)
  const tools = normalizedRequested.tools.filter(
    (tool) => normalizedParent.tools.includes("*") || normalizedParent.tools.includes(tool),
  )
  const roots = normalizedRequested.roots.filter((root) =>
    normalizedParent.roots.some((allowed) => allowed === "*" || isWithin(root, allowed)),
  )
  const memoryScopes = normalizedRequested.memoryScopes.filter(
    (scope) =>
      (normalizedParent.memoryScopes as readonly string[]).includes("*") ||
      normalizedParent.memoryScopes.includes(scope),
  )
  const permissions = normalizedRequested.permissions.filter(
    (permission) => normalizedParent.permissions.includes("*") || normalizedParent.permissions.includes(permission),
  )
  if (tools.length === 0) throw new DelegationError("scope", "delegation must retain at least one allowed tool")
  if (roots.length === 0) throw new DelegationError("scope", "delegation must retain at least one allowed root")
  if (memoryScopes.length === 0) throw new DelegationError("scope", "delegation must retain at least one memory scope")
  return freezeScope({
    tools: [...new Set(tools)],
    roots: [...new Set(roots)],
    memoryScopes: [...new Set(memoryScopes)],
    maxSteps: Math.min(normalizedParent.maxSteps, normalizedRequested.maxSteps),
    maxToolCalls: Math.min(normalizedParent.maxToolCalls, normalizedRequested.maxToolCalls),
    maxRetries: Math.min(normalizedParent.maxRetries, normalizedRequested.maxRetries),
    maxDurationMs: Math.min(normalizedParent.maxDurationMs, normalizedRequested.maxDurationMs),
    maxSubagents: Math.min(normalizedParent.maxSubagents, normalizedRequested.maxSubagents),
    maxSensitivity: lowerSensitivity(normalizedParent.maxSensitivity, normalizedRequested.maxSensitivity),
    permissions: [...new Set(permissions)],
  })
}

export function createDelegation(input: DelegationRequest): DelegationContract {
  if (input.task.trim().length === 0) throw new DelegationError("invalid", "delegation task must not be empty")
  if (input.childAgentID.trim().length === 0) {
    throw new DelegationError("invalid", "delegation agent ID must not be empty")
  }
  const parentScope = freezeScope(input.parentScope ?? defaultParentScope(input.parent))
  const scope = constrainScope(parentScope, input.scope)
  if (
    input.location &&
    !parentScope.roots.some((root) => root === "*" || isWithin(input.location?.directory ?? "", root))
  ) {
    throw new DelegationError("scope", "delegation location is outside the parent scope")
  }
  if (input.expiresAt !== undefined && !Number.isFinite(input.expiresAt)) {
    throw new DelegationError("invalid", "delegation expiration must be finite")
  }
  return Object.freeze({
    parentRunID: input.parent.runID,
    childRunID: input.childRunID ?? `${input.parent.runID}:subagent:${input.childAgentID}`,
    childAgentID: input.childAgentID,
    task: input.task,
    scope,
    parentScope,
    location: input.location ?? input.parent.location,
    expiresAt: input.expiresAt,
  })
}

export function validateDelegation(parent: RunContext, contract: DelegationContract): readonly string[] {
  const errors: string[] = []
  if (contract.parentRunID !== parent.runID) errors.push("parent run mismatch")
  if (contract.scope.maxSteps > parent.limits.maxSteps) errors.push("maxSteps exceeds parent")
  if (contract.scope.maxToolCalls > parent.limits.maxToolCalls) errors.push("maxToolCalls exceeds parent")
  if (contract.scope.maxRetries > parent.limits.maxRetries) errors.push("maxRetries exceeds parent")
  if (contract.scope.maxDurationMs > parent.limits.maxDurationMs) errors.push("maxDurationMs exceeds parent")
  if (contract.scope.maxSubagents > parent.limits.maxSubagents) errors.push("maxSubagents exceeds parent")
  if (contract.parentScope) {
    if (contract.scope.tools.some((tool) => !contains(contract.parentScope?.tools ?? [], tool))) {
      errors.push("tool scope exceeds parent")
    }
    if (contract.scope.roots.some((root) => !withinAny(contract.parentScope?.roots ?? [], root))) {
      errors.push("root scope exceeds parent")
    }
    if (contract.scope.memoryScopes.some((scope) => !contains(contract.parentScope?.memoryScopes ?? [], scope))) {
      errors.push("memory scope exceeds parent")
    }
    if (
      contract.scope.permissions.some((permission) => !contains(contract.parentScope?.permissions ?? [], permission))
    ) {
      errors.push("permission scope exceeds parent")
    }
    if (contract.location && !withinAny(contract.parentScope.roots, contract.location.directory)) {
      errors.push("location exceeds parent")
    }
    if (sensitivityRank(contract.scope.maxSensitivity) > sensitivityRank(contract.parentScope.maxSensitivity)) {
      errors.push("sensitivity exceeds parent")
    }
  }
  if (contract.expiresAt !== undefined && !Number.isFinite(contract.expiresAt)) errors.push("invalid expiration")
  return Object.freeze(errors)
}

export function assertDelegation(parent: RunContext, contract: DelegationContract): void {
  const errors = validateDelegation(parent, contract)
  if (errors.length > 0) throw new DelegationError("scope", errors.join(", "))
}

export function defaultParentScope(context: RunContext): DelegationScope {
  return Object.freeze({
    tools: Object.freeze([...context.environment.tools].toSorted()),
    roots: Object.freeze(context.location ? [context.location.directory] : [context.environment.cwd]),
    memoryScopes: Object.freeze(["run", "session"] as const),
    maxSteps: context.limits.maxSteps,
    maxToolCalls: context.limits.maxToolCalls,
    maxRetries: context.limits.maxRetries,
    maxDurationMs: context.limits.maxDurationMs,
    maxSubagents: context.limits.maxSubagents,
    maxSensitivity: "internal",
    permissions: Object.freeze(["*"]),
  })
}

export function scopeAllows(scope: DelegationScope, kind: LimitKind, value: number): boolean {
  if (kind === "steps") return value <= scope.maxSteps
  if (kind === "toolCalls") return value <= scope.maxToolCalls
  if (kind === "retries") return value <= scope.maxRetries
  if (kind === "duration") return value <= scope.maxDurationMs
  return value <= scope.maxSubagents
}

function contains(values: readonly string[], value: string): boolean {
  return values.includes("*") || values.includes(value)
}

function withinAny(roots: readonly string[], root: string): boolean {
  return roots.some((allowed) => allowed === "*" || isWithin(root, allowed))
}

function sensitivityRank(sensitivity: MemorySensitivity): number {
  return ["public", "internal", "sensitive", "secret"].indexOf(sensitivity)
}

function freezeScope(scope: DelegationScope): DelegationScope {
  const limits = [scope.maxSteps, scope.maxToolCalls, scope.maxRetries, scope.maxDurationMs, scope.maxSubagents]
  if (limits.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new DelegationError("limit", "delegation limits must be non-negative finite numbers")
  }
  if (sensitivityRank(scope.maxSensitivity) < 0) {
    throw new DelegationError("sensitivity", "delegation sensitivity is invalid")
  }
  return Object.freeze({
    tools: Object.freeze([...new Set(scope.tools)].toSorted()),
    roots: Object.freeze([...new Set(scope.roots)].toSorted()),
    memoryScopes: Object.freeze([...new Set(scope.memoryScopes)].toSorted()),
    maxSteps: scope.maxSteps,
    maxToolCalls: scope.maxToolCalls,
    maxRetries: scope.maxRetries,
    maxDurationMs: scope.maxDurationMs,
    maxSubagents: scope.maxSubagents,
    maxSensitivity: scope.maxSensitivity,
    permissions: Object.freeze([...new Set(scope.permissions)].toSorted()),
  })
}

function lowerSensitivity(left: MemorySensitivity, right: MemorySensitivity): MemorySensitivity {
  const order: readonly MemorySensitivity[] = ["public", "internal", "sensitive", "secret"]
  return order[Math.min(order.indexOf(left), order.indexOf(right))] ?? "public"
}

function isWithin(root: string, allowed: string): boolean {
  const normalizedRoot = normalizePath(root)
  const normalizedAllowed = normalizePath(allowed)
  if (normalizedRoot === normalizedAllowed) return true
  const prefix = normalizedAllowed.endsWith("/") ? normalizedAllowed : `${normalizedAllowed}/`
  return normalizedRoot.startsWith(prefix)
}

function normalizePath(value: string): string {
  const normalized = value.replaceAll("\\", "/")
  const prefix = normalized.startsWith("/") ? "/" : ""
  const segments: string[] = []
  for (const segment of normalized.split("/")) {
    if (segment.length === 0 || segment === ".") continue
    if (segment === "..") {
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return `${prefix}${segments.join("/")}` || (prefix ? "/" : ".")
}
