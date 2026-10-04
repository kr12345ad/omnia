import { evaluateApproval } from "./approval"
import { classifyDanger } from "./dangerous"
import { evaluatePathAccess, isPathWithin } from "./path"
import { makeProvenance } from "./provenance"
import type {
  AccessMode,
  ApprovalEvaluation,
  ApprovalGrant,
  ApprovalPolicy,
  OperationInput,
  PathDecision,
  PathScope,
  PermissionDecision,
  PermissionEffect,
  PermissionOutcome,
  PermissionRequest,
  PermissionRule,
  Provenance,
  ProvenanceInput,
  ScopeIdentifier,
} from "./types"

export type PermissionRuleInput = Omit<PermissionRule, "effect"> & { readonly effect?: PermissionEffect }

export interface PermissionPolicy {
  readonly rules?: readonly PermissionRule[]
  readonly allow?: readonly PermissionRuleInput[]
  readonly deny?: readonly PermissionRuleInput[]
  readonly defaultOutcome?: PermissionOutcome
  readonly approval?: ApprovalPolicy
  readonly approvalGrant?: ApprovalGrant
  readonly scope?: ScopeIdentifier
  readonly pathScope?: PathScope
}

export interface PermissionEvaluationOptions {
  readonly rules?: readonly PermissionRule[]
  readonly approval?: ApprovalPolicy
  readonly approvalGrant?: ApprovalGrant
  readonly provenance?: ProvenanceInput
  readonly pathScope?: PathScope
  readonly defaultOutcome?: PermissionOutcome
}

export class PermissionDeniedError extends Error {
  readonly code = "permission_denied"

  constructor(readonly decision: PermissionDecision) {
    super(decision.reason)
    this.name = "PermissionDeniedError"
  }
}

export class PermissionBlockedError extends Error {
  readonly code = "permission_blocked"

  constructor(readonly decision: PermissionDecision) {
    super(decision.reason)
    this.name = "PermissionBlockedError"
  }
}

export class PermissionRequiredError extends Error {
  readonly code = "permission_required"

  constructor(readonly decision: PermissionDecision) {
    super(decision.reason)
    this.name = "PermissionRequiredError"
  }
}

const normalize = (value: string) => value.trim().toLowerCase().replaceAll("\\", "/")
const hasControlCharacters = (value: string) =>
  Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0
    return code < 32 || code === 127
  })
const scopeKey = (scope: ScopeIdentifier | undefined) => {
  if (scope === undefined) return ""
  if (typeof scope === "string") return normalize(scope)
  const kind = normalize(scope.kind)
  if (scope.resource !== undefined) return `${kind}:${normalize(scope.resource)}`
  const resources = [...(scope.resources ?? []), ...(scope.paths ?? []), ...(scope.origins ?? [])].map(normalize).sort()
  return resources.length === 0 ? kind : `${kind}:${resources.join("|")}`
}
const isResourceList = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && (value as readonly unknown[]).every((item) => typeof item === "string")
const isRuleList = (value: unknown): value is readonly PermissionRule[] =>
  Array.isArray(value) && (value as readonly unknown[]).every((item) => typeof item === "object" && item !== null)
const compatibilityEffect = (outcome: PermissionOutcome): PermissionDecision["effect"] =>
  outcome === "allowed" ? "allow" : outcome === "permission_required" ? "ask" : "deny"

// wildcardMatch runs for every rule/resource pair, so compiled patterns are
// cached. The cache is bounded; the oldest pattern is evicted past the limit.
const WILDCARD_CACHE_LIMIT = 1000
const wildcardCache = new Map<string, RegExp>()
const wildcardPattern = (pattern: string) => {
  const cached = wildcardCache.get(pattern)
  if (cached !== undefined) return cached
  const escaped = normalize(pattern).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replaceAll("\\*", ".*").replaceAll("\\?", ".")
  const compiled = new RegExp(`^${escaped}$`, "s")
  if (wildcardCache.size >= WILDCARD_CACHE_LIMIT) {
    const oldest = wildcardCache.keys().next().value
    if (oldest !== undefined) wildcardCache.delete(oldest)
  }
  wildcardCache.set(pattern, compiled)
  return compiled
}

export function wildcardMatch(input: string, pattern: string): boolean {
  return wildcardPattern(pattern).test(normalize(input))
}

export function normalizePermissionEffect(effect: PermissionEffect | string): PermissionOutcome {
  if (effect === "allow") return "allowed"
  if (effect === "ask" || effect === "permission_required") return "permission_required"
  if (effect === "blocked") return "blocked"
  return "denied"
}

const trustedRuleSource = (source: string | undefined) => {
  // A rule without an explicit source is not trusted: rules assembled from
  // retrieved content, tool output, or memory may omit the source field, and
  // treating that as trusted would turn data into authorization.
  if (source === undefined) return false
  const normalized = normalize(source)
  if (["webpage", "web", "file", "application", "app", "tool", "retrieved", "memory", "environment"].includes(normalized)) {
    return false
  }
  return ["config", "operator", "user", "system", "policy", "admin", "host"].includes(normalized)
}

export function ruleMatches(
  rule: PermissionRule,
  action: string,
  resource: string,
  scope?: ScopeIdentifier,
): boolean {
  if (!trustedRuleSource(rule.source)) return false
  const normalizedAction = normalize(action)
  const normalizedRuleAction = normalize(rule.action)
  if (!wildcardMatch(normalizedAction, normalizedRuleAction) && !normalizedAction.endsWith(`.${normalizedRuleAction}`)) return false
  if (rule.scope !== undefined && scopeKey(rule.scope) !== scopeKey(scope)) return false
  return wildcardMatch(resource, rule.resource ?? "*")
}

const ruleSpecificity = (rule: PermissionRule) => ({
  priority: rule.priority ?? 0,
  action: rule.action.replaceAll("*", "").replaceAll("?", "").length,
  resource: (rule.resource ?? "*").replaceAll("*", "").replaceAll("?", "").length,
})

const outcomeRank = (outcome: PermissionOutcome) =>
  outcome === "blocked" ? 3 : outcome === "denied" ? 2 : outcome === "permission_required" ? 1 : 0

const selectRule = (rules: readonly PermissionRule[], action: string, resource: string, scope?: ScopeIdentifier) => {
  const matches = rules.filter((rule) => ruleMatches(rule, action, resource, scope))
  return matches.sort((left, right) => {
    const effect = outcomeRank(normalizePermissionEffect(right.effect)) - outcomeRank(normalizePermissionEffect(left.effect))
    if (effect !== 0) return effect
    const leftSpecificity = ruleSpecificity(left)
    const rightSpecificity = ruleSpecificity(right)
    return (
      rightSpecificity.priority - leftSpecificity.priority ||
      rightSpecificity.action - leftSpecificity.action ||
      rightSpecificity.resource - leftSpecificity.resource
    )
  })[0]
}

const requestResources = (input: OperationInput) => [
  ...new Set([
    ...(input.resources ?? []),
    ...(input.paths ?? []),
    ...(input.resource === undefined ? [] : [input.resource]),
  ].map(normalize).filter((resource) => resource.length > 0)),
]

const requestProvenance = (input: OperationInput, override?: ProvenanceInput): Provenance => {
  if (override !== undefined) return makeProvenance(override)
  if (input.provenance !== undefined) return makeProvenance(input.provenance)
  return makeProvenance("operator")
}

const pathDecisions = (
  input: OperationInput,
  scope: PathScope | undefined,
  access: AccessMode,
): readonly PathDecision[] => {
  if (scope === undefined) return []
  const paths = [...(input.paths ?? []), ...(input.resources ?? []), ...(input.resource === undefined ? [] : [input.resource])]
  return paths.map((path) =>
    evaluatePathAccess(scope, {
      path,
      access,
      ...(input.followSymlinks === undefined ? {} : { followSymlinks: input.followSymlinks }),
      ...(input.realpath === undefined ? {} : { realpath: input.realpath }),
    }),
  )
}

const aggregate = (outcomes: readonly PermissionOutcome[]): PermissionOutcome => {
  if (outcomes.includes("blocked")) return "blocked"
  if (outcomes.includes("denied")) return "denied"
  if (outcomes.includes("permission_required")) return "permission_required"
  return "allowed"
}

const decision = (
  outcome: PermissionOutcome,
  input: OperationInput,
  danger: ReturnType<typeof classifyDanger>,
  provenance: Provenance,
  reason: string,
  extras: {
    readonly rule?: PermissionRule | undefined
    readonly approval?: ApprovalEvaluation | undefined
    readonly path?: PathDecision | undefined
  } = {},
): PermissionDecision => Object.freeze({
  outcome,
  status: outcome,
  effect: compatibilityEffect(outcome),
  allowed: outcome === "allowed",
  requiresApproval: outcome === "permission_required",
  action: normalize(input.action ?? ""),
  resources: requestResources(input),
  reason,
  danger,
  provenance,
  ...(extras.rule === undefined ? {} : { rule: extras.rule }),
  ...(extras.approval === undefined ? {} : { approval: extras.approval }),
  ...(extras.path === undefined ? {} : { path: extras.path }),
})

export function evaluatePermission(
  request: PermissionRequest,
  policy?: PermissionPolicy,
): PermissionDecision
export function evaluatePermission(
  action: string,
  resources: readonly string[],
  rules?: readonly PermissionRule[],
  options?: PermissionEvaluationOptions,
): PermissionDecision
export function evaluatePermission(
  action: string,
  resource: string,
  rules?: readonly PermissionRule[],
  options?: PermissionEvaluationOptions,
): PermissionDecision
export function evaluatePermission(
  input: PermissionRequest | string,
  resourcesOrPolicy: readonly string[] | PermissionPolicy | string = {},
  rulesOrOptions: readonly PermissionRule[] | PermissionEvaluationOptions = {},
  maybeOptions: PermissionEvaluationOptions = {},
): PermissionDecision {
  const positionalResources = typeof resourcesOrPolicy === "string"
    ? [resourcesOrPolicy]
    : isResourceList(resourcesOrPolicy)
      ? resourcesOrPolicy
      : undefined
  const request: PermissionRequest =
    typeof input === "string"
      ? { action: input, ...(positionalResources === undefined ? {} : { resources: positionalResources }) }
      : input ?? { action: "" }
  const policy: PermissionPolicy =
    typeof resourcesOrPolicy === "object" && !isResourceList(resourcesOrPolicy)
      ? (resourcesOrPolicy as PermissionPolicy)
      : {}
  const options: PermissionEvaluationOptions =
    typeof rulesOrOptions === "object" && !isRuleList(rulesOrOptions)
      ? (rulesOrOptions as PermissionEvaluationOptions)
      : maybeOptions
  const rules = isRuleList(rulesOrOptions)
    ? rulesOrOptions
    : [
        ...(policy.rules ?? []),
        ...(policy.allow ?? []).map((rule) => ({ ...rule, effect: "allow" as const })),
        ...(policy.deny ?? []).map((rule) => ({ ...rule, effect: "deny" as const })),
        ...(options.rules ?? []),
      ]
  const approvalPolicy = options.approval ?? policy.approval ?? {}
  const approvalGrant = options.approvalGrant ?? policy.approvalGrant
  const provenance = requestProvenance(request, options.provenance)
  const danger = classifyDanger(request)
  const action = normalize(request.action ?? "")
  const resources = requestResources(request)
  if (!action) return decision("blocked", request, danger, provenance, "operation action is required")
  if (hasControlCharacters(action) || resources.some((resource) => hasControlCharacters(resource))) {
    return decision("blocked", request, danger, provenance, "operation contains control characters")
  }
  if (resources.length === 0 && (request.resources !== undefined || request.paths !== undefined || request.resource !== undefined)) {
    return decision("blocked", request, danger, provenance, "operation resources are invalid")
  }
  // Resource-less operations must default-deny rather than match the "*"
  // wildcard: a broad allow rule would otherwise authorize an unconstrained
  // operation that the caller never named.
  if (resources.length === 0) {
    return decision("permission_required", request, danger, provenance, "operation must name at least one resource")
  }
  const pathScope = options.pathScope ?? policy.pathScope
  const paths = pathDecisions(request, pathScope, request.access ?? request.mode ?? "read")
  if (paths.some((item) => item.outcome === "blocked")) {
    const blocked = paths.find((item) => item.outcome === "blocked")
    return decision("blocked", request, danger, provenance, blocked?.reason ?? "path is outside scope", { path: blocked })
  }
  if (paths.some((item) => item.outcome === "denied")) {
    const denied = paths.find((item) => item.outcome === "denied")
    return decision("denied", request, danger, provenance, denied?.reason ?? "path is denied", { path: denied })
  }
  if (paths.some((item) => item.outcome === "permission_required")) {
    const path = paths.find((item) => item.outcome === "permission_required")
    return decision("permission_required", request, danger, provenance, path?.reason ?? "path access requires permission", { path })
  }
  const effectiveResources = resources
  const effectiveScope = request.scope ?? request.permissionScope ?? policy.scope
  const evaluations = effectiveResources.map((resource) => {
    const matches = rules.filter((rule) => ruleMatches(rule, action, resource, effectiveScope))
    const outcome = matches.length === 0 ? "permission_required" : aggregate(matches.map((rule) => normalizePermissionEffect(rule.effect)))
    const rule = selectRule(matches, action, resource, effectiveScope)
    return { resource, rule, outcome }
  })
  const ruleOutcome = aggregate(evaluations.map((item) => item.outcome))
  const selectedRule = evaluations.find((item) => item.outcome === ruleOutcome)?.rule
  if (ruleOutcome === "blocked" || ruleOutcome === "denied") {
    return decision(ruleOutcome, request, danger, provenance, "an explicit permission rule blocks this operation", { rule: selectedRule })
  }
  const noRule = ruleOutcome === "permission_required" && selectedRule === undefined
  if (noRule && (options.defaultOutcome ?? policy.defaultOutcome) !== undefined) {
    const defaultOutcome = options.defaultOutcome ?? policy.defaultOutcome
    if (defaultOutcome === "blocked" || defaultOutcome === "denied") {
      return decision(defaultOutcome, request, danger, provenance, "the permission policy denies unmatched operations")
    }
  }
  const needsApproval =
    request.requiresApproval === true ||
    danger.requiresApproval ||
    approvalPolicy.requireApproval === true ||
    (noRule && approvalGrant !== undefined) ||
    (ruleOutcome === "permission_required" && (selectedRule?.effect === "ask" || selectedRule?.effect === "permission_required"))
  if (needsApproval) {
    const approval = evaluateApproval(request, approvalPolicy, approvalGrant)
    if (!approval.approved) {
      const approvalOutcome = approval.outcome === "approved" ? "allowed" : approval.outcome
      return decision(approvalOutcome, request, danger, provenance, approval.reason, { rule: selectedRule, approval })
    }
    if (noRule && approvalGrant === undefined) {
      return decision("permission_required", request, danger, provenance, "no explicit permission rule grants this operation", {
        rule: selectedRule,
        approval,
      })
    }
    return decision("allowed", request, danger, provenance, approval.reason, { rule: selectedRule, approval })
  }
  if (ruleOutcome === "permission_required") {
    return decision("permission_required", request, danger, provenance, "no explicit permission rule grants this operation", {
      rule: selectedRule,
    })
  }
  return decision("allowed", request, danger, provenance, "permission rule allows this operation", { rule: selectedRule })
}

export function evaluate(request: PermissionRequest, policy?: PermissionPolicy): PermissionDecision
export function evaluate(
  action: string,
  resources: readonly string[],
  rules?: readonly PermissionRule[],
  options?: PermissionEvaluationOptions,
): PermissionDecision
export function evaluate(
  action: string,
  resource: string,
  ...rulesets: readonly (readonly PermissionRule[])[]
): PermissionDecision
export function evaluate(
  input: PermissionRequest | string,
  resourcesOrPolicy: string | readonly string[] | PermissionPolicy | undefined = {},
  ...rest: readonly ((readonly PermissionRule[] | PermissionEvaluationOptions) | undefined)[]
): PermissionDecision {
  if (typeof input !== "string") return evaluatePermission(input, resourcesOrPolicy as PermissionPolicy)
  if (typeof resourcesOrPolicy === "string") {
    return evaluatePermission(input, resourcesOrPolicy, rest.filter(isRuleList).flat())
  }
  if (isResourceList(resourcesOrPolicy)) {
    const options = rest.find((item) => !isRuleList(item)) as PermissionEvaluationOptions | undefined
    return evaluatePermission(input, resourcesOrPolicy, rest.filter(isRuleList).flat(), options)
  }
  return evaluatePermission({ action: input }, resourcesOrPolicy as PermissionPolicy)
}

export const evaluateRules = evaluate

export class PermissionEvaluator {
  readonly policy: PermissionPolicy

  constructor(policy: PermissionPolicy = {}) {
    this.policy = createPermissionPolicy(policy)
  }

  evaluate(request: PermissionRequest): PermissionDecision {
    return evaluatePermission(request, this.policy)
  }

  assert(request: PermissionRequest): PermissionDecision {
    return assertPermission(request, this.policy)
  }

  check(request: PermissionRequest): PermissionDecision {
    return this.evaluate(request)
  }
}

export const createPermissionEvaluator = (policy: PermissionPolicy = {}) => new PermissionEvaluator(policy)
export const denyByDefault = Object.freeze({ defaultOutcome: "permission_required" as const })
export const PermissionEngine = PermissionEvaluator

export function mergeRules(...rulesets: readonly (readonly PermissionRule[])[]): readonly PermissionRule[] {
  return Object.freeze(rulesets.flat())
}

export const merge = mergeRules

export function assertPermission(request: PermissionRequest, policy?: PermissionPolicy): PermissionDecision
export function assertPermission(
  action: string,
  resources: readonly string[],
  policy?: PermissionPolicy,
): PermissionDecision
export function assertPermission(
  input: PermissionRequest | string,
  resourcesOrPolicy: readonly string[] | PermissionPolicy = {},
  maybePolicy: PermissionPolicy = {},
): PermissionDecision {
  const request: PermissionRequest =
    typeof input === "string"
      ? { action: input, resources: isResourceList(resourcesOrPolicy) ? resourcesOrPolicy : [] }
      : input
  const policy: PermissionPolicy =
    typeof resourcesOrPolicy === "object" && !isResourceList(resourcesOrPolicy)
      ? (resourcesOrPolicy as PermissionPolicy)
      : maybePolicy
  const result = evaluatePermission(request, policy)
  if (result.outcome === "allowed") return result
  if (result.outcome === "blocked") throw new PermissionBlockedError(result)
  if (result.outcome === "denied") throw new PermissionDeniedError(result)
  throw new PermissionRequiredError(result)
}

export function canAccess(
  action: string,
  resources: readonly string[],
  policy: PermissionPolicy = {},
): boolean {
  return evaluatePermission({ action, resources }, policy).allowed
}

export function permissionDecisionEffect(outcome: PermissionOutcome): PermissionEffect {
  return outcome === "allowed" ? "allow" : outcome === "permission_required" ? "ask" : "deny"
}

export const DeniedError = PermissionDeniedError
export const BlockedError = PermissionBlockedError
export const ApprovalRequiredError = PermissionRequiredError
export const evaluatePermissionRequest = evaluatePermission
export const checkPermission = evaluatePermission
export const evaluateAccess = evaluatePermission
export const assertAllowed = assertPermission

export function isWithinPermissionScope(path: string, root: string): boolean {
  return isPathWithin(root, path)
}

export function isUntrustedRule(rule: PermissionRule): boolean {
  return !trustedRuleSource(rule.source)
}

export function createPermissionPolicy(input: PermissionPolicy = {}): PermissionPolicy {
  return Object.freeze({
    ...input,
    ...(input.rules === undefined ? {} : { rules: Object.freeze(input.rules.map((rule) => Object.freeze({ ...rule }))) }),
    ...(input.allow === undefined ? {} : { allow: Object.freeze(input.allow.map((rule) => Object.freeze({ ...rule }))) }),
    ...(input.deny === undefined ? {} : { deny: Object.freeze(input.deny.map((rule) => Object.freeze({ ...rule }))) }),
  })
}

export const matchPermissionRule = ruleMatches
export const hasMatchingPermissionRule = (rules: readonly PermissionRule[], action: string, resource: string, scope?: ScopeIdentifier) =>
  rules.some((rule) => ruleMatches(rule, action, resource, scope))
