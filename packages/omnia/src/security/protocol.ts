import { makeProvenance } from "./provenance"
import type {
  ApprovalEvaluation,
  OperationInput,
  PermissionDecision,
  PermissionEffect,
  PermissionRequest,
  PermissionRule,
  PathScope,
  Provenance,
  ScopeIdentifier,
  ProvenanceSource,
} from "./types"
import type {
  ApprovalDecision,
  ApprovalDecisionRecord,
  ApprovalDecisionValue,
  PermissionScope,
  Provenance as ProtocolProvenance,
  TrustLevel as ProtocolTrustLevel,
} from "../protocol/types.js"

export interface ProtocolPermissionRule {
  readonly action: string
  readonly resource: string
  readonly effect: "allow" | "deny" | "ask"
}

export interface ProtocolPermissionRequest {
  readonly action: string
  readonly resources: readonly string[]
}

export const fromProtocolPermissionRules = (rules: readonly ProtocolPermissionRule[]): readonly PermissionRule[] =>
  Object.freeze(rules.map((rule) => ({ action: rule.action, resource: rule.resource, effect: rule.effect })))

export const toProtocolPermissionRule = (rule: PermissionRule): ProtocolPermissionRule => ({
  action: rule.action,
  resource: rule.resource ?? "*",
  effect: rule.effect === "allow" ? "allow" : rule.effect === "deny" || rule.effect === "blocked" ? "deny" : "ask",
})

export const fromProtocolPermissionRequest = (request: ProtocolPermissionRequest): PermissionRequest => ({
  action: request.action,
  resources: [...request.resources],
})

export const toProtocolEffect = (effect: PermissionEffect): "allow" | "deny" | "ask" =>
  effect === "allow" ? "allow" : effect === "deny" || effect === "blocked" ? "deny" : "ask"

export const toProtocolProvenance = (provenance: Provenance): ProtocolProvenance => ({
  source: provenance.source,
  trust: provenance.trust as ProtocolTrustLevel,
  authority: provenance.authority,
  ...(provenance.origin === undefined ? {} : { origin: provenance.origin }),
})

export const fromProtocolProvenance = (provenance: ProtocolProvenance): Provenance =>
  makeProvenance(
    {
      source: provenance.source as ProvenanceSource,
      trust: provenance.trust,
      authority: provenance.authority ?? "none",
      ...(provenance.origin === undefined ? {} : { origin: provenance.origin }),
    },
    provenance.metadata === undefined ? {} : { metadata: provenance.metadata },
  )

const protocolScopeNames = new Set([
  "computer",
  "screen",
  "input",
  "keyboard",
  "pointer",
  "clipboard",
  "application",
  "window",
  "browser",
  "network",
  "filesystem",
  "read",
  "write",
  "execute",
  "all",
])

export const toProtocolPermissionScope = (scope: ScopeIdentifier | PathScope): PermissionScope => {
  if (typeof scope === "string" && protocolScopeNames.has(scope)) return scope as PermissionScope
  if (typeof scope === "string") return { kind: scope }
  if ("kind" in scope) return scope
  const resources = scope.allow ?? scope.read ?? scope.write ?? scope.create ?? scope.delete ?? scope.execute ?? scope.list ?? scope.search ?? scope.admin ?? []
  return {
    kind: "filesystem",
    paths: [scope.root],
    ...(resources.length === 0 ? {} : { resources: [...resources] }),
  }
}

export const fromProtocolPermissionScope = (scope: PermissionScope): { readonly scope?: string; readonly resources: readonly string[] } => {
  if (typeof scope === "string") return { scope, resources: [] }
  return {
    ...(scope.resource === undefined ? {} : { scope: scope.resource }),
    resources: [...(scope.resources ?? []), ...(scope.paths ?? []), ...(scope.origins ?? [])],
  }
}

export const toProtocolApprovalDecision = (value: ApprovalEvaluation | PermissionDecision | PermissionEffect): ApprovalDecisionValue => {
  const outcome = typeof value === "string" ? value : value.outcome
  if (outcome === "allowed" || outcome === "approved" || outcome === "allow") return "approved"
  if (outcome === "permission_required" || outcome === "ask") return "permission_required"
  if (outcome === "blocked") return "blocked"
  return "denied"
}

export function fromProtocolApprovalDecision(
  value: ApprovalDecision,
  input: OperationInput = { action: "unknown" },
): ApprovalEvaluation {
  const decision = typeof value === "string" ? value : value.decision
  const outcome = decision === "approved" || decision === "allow"
    ? "approved"
    : decision === "permission_required" || decision === "ask"
      ? "permission_required"
      : decision === "blocked"
        ? "blocked"
        : "denied"
  return Object.freeze({
    outcome,
    status: outcome,
    approved: outcome === "approved",
    requiresApproval: outcome === "permission_required",
    reason: typeof value === "string" ? `protocol decision: ${value}` : value.reason ?? `protocol decision: ${decision}`,
    dangerous: input.action !== "unknown",
  })
}

export const toProtocolApprovalRecord = (
  value: ApprovalEvaluation | PermissionDecision | PermissionEffect,
  options: { readonly reason?: string; readonly approvedBy?: string; readonly expiresAt?: number; readonly scope?: PermissionScope } = {},
): ApprovalDecisionRecord => ({
  decision: toProtocolApprovalDecision(value),
  type: "approval",
  ...(options.reason === undefined ? {} : { reason: options.reason }),
  ...(options.approvedBy === undefined ? {} : { approvedBy: options.approvedBy }),
  ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
  ...(options.scope === undefined ? {} : { scope: options.scope }),
})

export const approvalOperation = (input: OperationInput) => ({ action: input.action, resources: input.resources ?? [] })

export function operationFromProtocolAction(action: {
  readonly action?: string
  readonly type?: string
  readonly requiresApproval?: boolean
  readonly permissionScope?: PermissionScope
  readonly scope?: PermissionScope
  readonly provenance?: ProtocolProvenance
  readonly metadata?: Readonly<Record<string, unknown>>
}): OperationInput {
  const name = action.action ?? action.type
  if (name === undefined) throw new TypeError("protocol action requires an action or type")
  return {
    action: name,
    ...(action.requiresApproval === undefined ? {} : { requiresApproval: action.requiresApproval }),
    ...(action.permissionScope === undefined ? {} : { permissionScope: action.permissionScope }),
    ...(action.scope === undefined ? {} : { scope: action.scope }),
    ...(action.provenance === undefined ? {} : { provenance: action.provenance }),
    ...(action.metadata === undefined ? {} : { metadata: action.metadata }),
  }
}
