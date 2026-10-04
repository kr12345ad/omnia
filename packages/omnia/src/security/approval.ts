import { classifyDanger } from "./dangerous"
import { isTrustedProvenance, makeProvenance } from "./provenance"
import type {
  ApprovalEvaluation,
  ApprovalGrant,
  ApprovalPolicy,
  ApprovalReply,
  OperationInput,
  PermissionOutcome,
  Provenance,
  ProvenanceInput,
  ScopeIdentifier,
} from "./types"

export class ApprovalError extends Error {
  readonly code = "approval_error"

  constructor(message: string) {
    super(message)
    this.name = "ApprovalError"
  }
}

const normalize = (value: string) => value.trim().toLowerCase().replaceAll("\\", "/")
const scopeKey = (scope: ScopeIdentifier | undefined) => {
  if (scope === undefined) return ""
  if (typeof scope === "string") return normalize(scope)
  const kind = normalize(scope.kind)
  if (scope.resource !== undefined) return `${kind}:${normalize(scope.resource)}`
  const resources = [...(scope.resources ?? []), ...(scope.paths ?? []), ...(scope.origins ?? [])].map(normalize).sort()
  return resources.length === 0 ? kind : `${kind}:${resources.join("|")}`
}
const immutableScope = (scope: ScopeIdentifier) => {
  if (typeof scope === "string") return scope
  return Object.freeze({
    ...scope,
    ...(scope.resources === undefined ? {} : { resources: Object.freeze([...scope.resources]) }),
    ...(scope.paths === undefined ? {} : { paths: Object.freeze([...scope.paths]) }),
    ...(scope.origins === undefined ? {} : { origins: Object.freeze([...scope.origins]) }),
  })
}
const normalizeResources = (resources: readonly string[]) => [...new Set(resources.map(normalize))].sort()
const operationResources = (input: OperationInput) => normalizeResources([...(input.resources ?? []), ...(input.paths ?? []), ...(input.resource === undefined ? [] : [input.resource])])
const operationProvenance = (input: OperationInput): Provenance =>
  input.provenance === undefined ? makeProvenance("operator") : makeProvenance(input.provenance)

let approvalSequence = 0
const issuedApprovalSnapshots = new Map<string, string>()

const nextApprovalId = (now: number) => {
  const random = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : (approvalSequence += 1).toString(36)
  return `approval_${now.toString(36)}_${random}`
}

const stableValue = (value: unknown, seen = new Set<object>()): string => {
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[Circular]"
    seen.add(value)
    const result = `[${value.map((entry) => stableValue(entry, seen)).join(",")}]`
    seen.delete(value)
    return result
  }
  if (value !== null && typeof value === "object") {
    if (seen.has(value)) return "[Circular]"
    seen.add(value)
    const result = `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableValue((value as Record<string, unknown>)[key], seen)}`)
      .join(",")}}`
    seen.delete(value)
    return result
  }
  return JSON.stringify(value)
}

const fingerprintHash = (value: string) => {
  let hash = 2166136261
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

export function operationFingerprint(input: OperationInput): string {
  const danger = classifyDanger(input)
  const provenance = operationProvenance(input)
  return fingerprintHash(
    stableValue({
      action: normalize(input.action),
      resources: operationResources(input),
      access: input.access ?? input.mode ?? "read",
      command: normalize(input.command ?? ""),
      recursive: input.recursive === true,
      explicitDangerous: input.explicitDangerous === true,
      dangerous: input.dangerous === true,
      destructive: input.destructive === true,
      requiresApproval: input.requiresApproval === true,
      scope: scopeKey(input.scope ?? input.permissionScope),
      danger: `${danger.kind}:${danger.level}`,
      provenance: `${provenance.source}:${provenance.trust}:${provenance.authority}`,
      metadata: input.metadata ?? null,
    }),
  )
}

const approvalSnapshot = (grant: ApprovalGrant) =>
  stableValue({
    id: grant.id,
    action: grant.action,
    resources: grant.resources,
    approvedBy: grant.approvedBy,
    issuedAt: grant.issuedAt,
    expiresAt: grant.expiresAt,
    usesRemaining: grant.usesRemaining,
    persistent: grant.persistent,
    scope: grant.scope,
    dangerLevel: grant.dangerLevel,
    fingerprint: grant.fingerprint,
    provenance: grant.provenance
      ? { source: grant.provenance.source, trust: grant.provenance.trust, authority: grant.provenance.authority }
      : null,
  })

const MAX_APPROVAL_SNAPSHOTS = 1000
const MAX_APPROVAL_GRANTS = 1000

// A grant with neither an explicit expiry nor a use limit must not live
// forever; non-dangerous approvals fall back to this TTL.
export const DEFAULT_APPROVAL_TTL_MS = 15 * 60 * 1000

const rememberApproval = (grant: ApprovalGrant) => {
  if (issuedApprovalSnapshots.size >= MAX_APPROVAL_SNAPSHOTS) {
    const oldest = issuedApprovalSnapshots.keys().next().value
    if (oldest !== undefined) issuedApprovalSnapshots.delete(oldest)
  }
  issuedApprovalSnapshots.set(grant.id, approvalSnapshot(grant))
  return grant
}

const trustedApprover = (value: string) => {
  const source = normalize(value)
  return source === "user" || source === "operator" || source === "admin" || source === "human" || source === "system"
}

const isIssuedApprovalActive = (grant: ApprovalGrant, now: number) =>
  issuedApprovalSnapshots.get(grant.id) === approvalSnapshot(grant) &&
  trustedApprover(grant.approvedBy) &&
  isTrustedProvenance(grant.provenance ?? "operator") &&
  (grant.expiresAt === undefined || grant.expiresAt > now) &&
  (grant.usesRemaining === undefined || grant.usesRemaining > 0)

const approvalOutcome = (
  outcome: ApprovalEvaluation["outcome"],
  reason: string,
  input: OperationInput,
  grant?: ApprovalGrant,
): ApprovalEvaluation => Object.freeze({
  outcome,
  status: outcome,
  approved: outcome === "approved",
  requiresApproval: outcome === "permission_required",
  reason,
  ...(grant === undefined ? {} : { grant }),
  dangerous: classifyDanger(input).dangerous,
})

export function isApprovalGrantValid(
  grant: ApprovalGrant | undefined,
  input: OperationInput,
  now = Date.now(),
): boolean {
  if (grant === undefined) return false
  if (!isIssuedApprovalActive(grant, now)) return false
  if (classifyDanger(input).requiresApproval && grant.expiresAt === undefined && grant.usesRemaining === undefined) return false
  if (normalize(grant.action) !== normalize(input.action)) return false
  const requestedResources = operationResources(input)
  const grantedResources = normalizeResources(grant.resources)
  if (requestedResources.length === 0 || grantedResources.length === 0) return false
  if (grantedResources.some((resource) => resource === "*" || resource === "**")) {
    const danger = classifyDanger(input)
    if (danger.dangerous || requestedResources.length !== 1 || requestedResources[0] !== "*") return false
  }
  if (requestedResources.length !== grantedResources.length || requestedResources.some((resource, index) => resource !== grantedResources[index])) return false
  if (grant.scope !== undefined && scopeKey(grant.scope) !== scopeKey(input.scope ?? input.permissionScope)) return false
  const danger = classifyDanger(input)
  if (grant.dangerLevel !== undefined && grant.dangerLevel !== danger.level) return false
  if (grant.fingerprint !== undefined && grant.fingerprint !== operationFingerprint(input)) return false
  return true
}

export function makeApprovalGrant(
  input: OperationInput,
  approvedBy: string,
  options: { readonly now?: number; readonly expiresInMs?: number; readonly maxUses?: number; readonly persistent?: boolean; readonly scope?: ScopeIdentifier; readonly provenance?: ProvenanceInput } = {},
): ApprovalGrant {
  if (!trustedApprover(approvedBy)) throw new ApprovalError("approval requires a trusted user or operator")
  if (operationResources(input).length === 0) throw new ApprovalError("approval requires explicit resources")
  if (options.provenance !== undefined && !isTrustedProvenance(options.provenance)) {
    throw new ApprovalError("approval provenance must be trusted")
  }
  if (options.maxUses !== undefined && (!Number.isInteger(options.maxUses) || options.maxUses <= 0)) {
    throw new ApprovalError("approval maxUses must be a positive integer")
  }
  if (options.expiresInMs !== undefined && (!Number.isFinite(options.expiresInMs) || options.expiresInMs <= 0)) {
    throw new ApprovalError("approval expiration must be positive")
  }
  const now = options.now ?? Date.now()
  const scopedInput = options.scope === undefined ? input : { ...input, scope: options.scope }
  const danger = classifyDanger(scopedInput)
  const maxUses = options.maxUses ?? (danger.requiresApproval ? 1 : undefined)
  // Every grant is bounded: an explicit expiry wins, a use limit bounds
  // single-action grants, and everything else gets the default TTL.
  const expiresAt =
    options.expiresInMs !== undefined
      ? now + options.expiresInMs
      : maxUses === undefined
        ? now + DEFAULT_APPROVAL_TTL_MS
        : undefined
  if (danger.requiresApproval && expiresAt === undefined && maxUses === undefined) {
    throw new ApprovalError("dangerous approvals require an expiration or use limit")
  }
  const grant: ApprovalGrant = {
    id: nextApprovalId(now),
    action: normalize(input.action),
    resources: Object.freeze(operationResources(input)),
    approvedBy: normalize(approvedBy),
    issuedAt: now,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(maxUses === undefined ? {} : { usesRemaining: maxUses }),
    ...(options.persistent === undefined ? {} : { persistent: options.persistent }),
    ...(options.scope === undefined ? {} : { scope: immutableScope(options.scope) }),
    dangerLevel: danger.level,
    fingerprint: operationFingerprint(scopedInput),
    provenance: options.provenance === undefined
      ? makeProvenance(approvedBy === "user" ? "user" : "operator")
      : makeProvenance(options.provenance),
  }
  return rememberApproval(Object.freeze(grant))
}

export const createApprovalGrant = makeApprovalGrant
export const grantApproval = makeApprovalGrant

export function evaluateApproval(
  input: OperationInput,
  policy: ApprovalPolicy = {},
  grant?: ApprovalGrant,
): ApprovalEvaluation {
  const danger = classifyDanger(input)
  const configuredMode = policy.mode ?? "ask"
  const mode = configuredMode === "never" ? "deny" : configuredMode === "always_ask" ? "ask" : configuredMode === "auto" ? "allow" : configuredMode
  if (mode === "deny") return approvalOutcome("denied", "approval policy denies this operation", input, grant)
  if (mode === "block") return approvalOutcome("blocked", "approval policy blocks this operation", input, grant)
  const provenance = operationProvenance(input)
  if (provenance.trust === "untrusted" && grant === undefined) {
    return approvalOutcome("permission_required", "untrusted provenance cannot self-authorize an operation", input, grant)
  }
  if (isApprovalGrantValid(grant, input)) return approvalOutcome("approved", "a matching trusted approval was supplied", input, grant)
  if (danger.requiresApproval) {
    if (policy.allowDangerous === true && !danger.irreversible && mode === "allow") {
      return approvalOutcome("approved", "policy explicitly allows this dangerous operation", input, grant)
    }
    return approvalOutcome("permission_required", "dangerous operations require explicit approval", input, grant)
  }
  if (policy.requireApproval === true || mode === "ask") {
    return approvalOutcome("permission_required", "operation requires explicit approval", input, grant)
  }
  return approvalOutcome("approved", "approval policy allows this operation", input, grant)
}

export function applyApprovalReply(
  input: OperationInput,
  reply: ApprovalReply,
  approvedBy: string,
  options: { readonly now?: number; readonly expiresInMs?: number; readonly maxUses?: number; readonly persistent?: boolean; readonly scope?: ScopeIdentifier; readonly provenance?: ProvenanceInput } = {},
): ApprovalEvaluation {
  if (!trustedApprover(approvedBy)) throw new ApprovalError("approval reply requires a trusted user or operator")
  if (reply === "reject") return approvalOutcome("denied", "approval was rejected", input)
  if (reply === "always" && classifyDanger(input).requiresApproval && options.expiresInMs === undefined && options.maxUses === undefined) {
    throw new ApprovalError("persistent dangerous approvals require an expiration or use limit")
  }
  const grant = makeApprovalGrant(input, approvedBy, {
    ...options,
    maxUses: reply === "once" ? 1 : options.maxUses,
    persistent: reply === "always",
  })
  return approvalOutcome("approved", reply === "once" ? "one-time approval granted" : "approval policy granted", input, grant)
}

export const resolveApprovalReply = applyApprovalReply
export const evaluateApprovalPolicy = evaluateApproval
export const validateApproval = isApprovalGrantValid

export function approvalRequired(input: OperationInput, policy: ApprovalPolicy = {}): boolean {
  return evaluateApproval(input, policy).requiresApproval
}

export const requiresApproval = approvalRequired

export class ApprovalRegistry {
  readonly #grants = new Map<string, ApprovalGrant>()

  constructor(initial: readonly ApprovalGrant[] = []) {
    initial.forEach((grant) => {
      if (isIssuedApprovalActive(grant, Date.now())) {
        this.add(grant)
      }
    })
  }

  add(grant: ApprovalGrant): ApprovalGrant {
    if (!isIssuedApprovalActive(grant, Date.now())) {
      throw new ApprovalError("approval grant is invalid or expired")
    }
    // A registry lives for the whole server process, so it is bounded like the
    // issued-grant snapshot cache instead of retaining every grant ever issued.
    if (this.#grants.size >= MAX_APPROVAL_GRANTS) {
      const oldest = this.#grants.keys().next().value
      if (oldest !== undefined) this.#grants.delete(oldest)
    }
    this.#grants.set(grant.id, grant)
    return grant
  }

  get(id: string): ApprovalGrant | undefined {
    return this.#grants.get(id)
  }

  issue(
    input: OperationInput,
    approvedBy: string,
    options: { readonly now?: number; readonly expiresInMs?: number; readonly maxUses?: number; readonly persistent?: boolean; readonly scope?: ScopeIdentifier; readonly provenance?: ProvenanceInput } = {},
  ): ApprovalGrant {
    return this.add(makeApprovalGrant(input, approvedBy, options))
  }

  approve(
    input: OperationInput,
    approvedBy: string,
    options: { readonly now?: number; readonly expiresInMs?: number; readonly maxUses?: number; readonly persistent?: boolean; readonly scope?: ScopeIdentifier; readonly provenance?: ProvenanceInput } = {},
  ): ApprovalGrant {
    return this.issue(input, approvedBy, options)
  }

  reply(
    input: OperationInput,
    reply: ApprovalReply,
    approvedBy: string,
    options: { readonly now?: number; readonly expiresInMs?: number; readonly maxUses?: number; readonly persistent?: boolean; readonly scope?: ScopeIdentifier; readonly provenance?: ProvenanceInput } = {},
  ): ApprovalEvaluation {
    if (reply === "reject") {
      for (const grant of this.list()) {
        if (isApprovalGrantValid(grant, input)) this.revoke(grant.id)
      }
      return approvalOutcome("denied", "approval was rejected", input)
    }
    const result = applyApprovalReply(input, reply, approvedBy, options)
    if (result.grant) this.add(result.grant)
    return result
  }

  reject(input: OperationInput, approvedBy: string): ApprovalEvaluation {
    return this.reply(input, "reject", approvedBy)
  }

  evaluate(input: OperationInput, policy: ApprovalPolicy = {}): ApprovalEvaluation {
    const grants = Array.from(this.#grants.values()).filter((grant) => isApprovalGrantValid(grant, input))
    return evaluateApproval(input, policy, grants.at(-1))
  }

  consume(id: string, input: OperationInput, now = Date.now()): ApprovalEvaluation {
    const grant = this.#grants.get(id)
    if (grant === undefined || !isApprovalGrantValid(grant, input, now)) return evaluateApproval(input, {}, grant)
    const remaining = grant?.usesRemaining
    if (remaining === undefined) {
      if (grant?.persistent !== true) {
        this.#grants.delete(id)
        issuedApprovalSnapshots.delete(id)
      }
    } else {
      const updated = rememberApproval(Object.freeze({ ...grant, usesRemaining: remaining - 1 }))
      this.#grants.set(id, updated)
    }
    return approvalOutcome("approved", "approval was consumed for the exact operation", input, grant)
  }

  revoke(id: string): boolean {
    issuedApprovalSnapshots.delete(id)
    return this.#grants.delete(id)
  }

  list(): readonly ApprovalGrant[] {
    return Object.freeze(Array.from(this.#grants.values()))
  }

  pending(): readonly ApprovalGrant[] {
    return this.list()
  }
}

export const approvals = ApprovalRegistry
export const ApprovalStore = ApprovalRegistry

export function blockedApprovalOutcome(reason: string): ApprovalEvaluation {
  return Object.freeze({
    outcome: "blocked",
    status: "blocked",
    approved: false,
    requiresApproval: false,
    reason,
    dangerous: true,
  })
}

export function approvalOutcomeFor(
  outcome: PermissionOutcome,
  reason: string,
  input: OperationInput,
): ApprovalEvaluation {
  if (outcome === "allowed") return approvalOutcome("approved", reason, input)
  if (outcome === "permission_required") return approvalOutcome("permission_required", reason, input)
  if (outcome === "blocked") return approvalOutcome("blocked", reason, input)
  return approvalOutcome("denied", reason, input)
}
