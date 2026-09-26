import type {
  ApprovalDecisionValue,
  Metadata as ProtocolMetadata,
  PermissionScope as ProtocolPermissionScope,
  Provenance as ProtocolProvenance,
  TrustLevel as ProtocolTrustLevel,
} from "../protocol/types.js"

export type ProtocolProvenanceContract = ProtocolProvenance
export type ProtocolTrustLevelContract = ProtocolTrustLevel
export type ProtocolMetadataContract = ProtocolMetadata
export type ProtocolPermissionScopeContract = ProtocolPermissionScope
export type ProtocolApprovalDecisionValue = ApprovalDecisionValue

export type PermissionOutcome = "allowed" | "denied" | "blocked" | "permission_required"
export type PermissionStatus = PermissionOutcome
export type PermissionResult = PermissionDecision
export type PermissionEffect = "allow" | "deny" | "ask" | "permission_required" | "blocked"
export type AccessMode = "read" | "list" | "search" | "create" | "write" | "delete" | "execute" | "admin"
export type TrustLevel = "trusted" | "untrusted" | "system"
export type InstructionAuthority = "user" | "operator" | "system" | "none"
export type ProvenanceSource =
  | "user"
  | "operator"
  | "system"
  | "application"
  | "file"
  | "webpage"
  | "tool"
  | "environment"
  | "retrieved"
  | "memory"
  | "computer"
  | "vision"
  | "model"
  | "remote"
  | "virtual"
  | "accessibility"
  | "dom"
  | "ocr"
  | "hybrid"
  | "native"
  | "browser"
  | "unknown"
  | (string & {})

export interface Provenance {
  readonly source: ProvenanceSource
  readonly trust: TrustLevel
  readonly authority: InstructionAuthority
  readonly origin?: string
  readonly metadata?: Readonly<Record<string, unknown>>
}

export type ProvenanceInput = Provenance | ProtocolProvenance | ProvenanceSource
export type ScopeIdentifier = string | ProtocolPermissionScope

export interface OperationInput {
  readonly action: string
  readonly resources?: readonly string[]
  readonly resource?: string
  readonly access?: AccessMode
  readonly mode?: AccessMode
  readonly paths?: readonly string[]
  readonly command?: string
  readonly recursive?: boolean
  readonly explicitDangerous?: boolean
  readonly dangerous?: boolean
  readonly destructive?: boolean
  readonly requiresApproval?: boolean
  readonly scope?: ScopeIdentifier
  readonly permissionScope?: ScopeIdentifier
  readonly followSymlinks?: boolean
  readonly realpath?: (path: string) => string
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly provenance?: ProvenanceInput
}

export interface PermissionRule {
  readonly action: string
  readonly resource?: string
  readonly effect: PermissionEffect
  readonly source?: string
  readonly priority?: number
  readonly scope?: ScopeIdentifier
}

export type Ruleset = readonly PermissionRule[]
export type PermissionRuleset = Ruleset

export interface PermissionRequest extends OperationInput {
  readonly resources?: readonly string[]
}

export type DangerLevel = "none" | "low" | "medium" | "high" | "critical"
export type RiskLevel = DangerLevel

export interface DangerClassification {
  readonly dangerous: boolean
  readonly level: DangerLevel
  readonly risk: DangerLevel
  readonly requiresExplicitApproval: boolean
  readonly kind:
    | "none"
    | "read"
    | "write"
    | "delete"
    | "recursive_delete"
    | "permission_change"
    | "shell"
    | "network"
    | "credential"
    | "package"
    | "process"
    | "vcs"
    | "database"
    | "privilege"
    | "external_path"
    | "unknown"
  readonly requiresApproval: boolean
  readonly irreversible: boolean
  readonly reasons: readonly string[]
}

export interface PermissionDecision {
  readonly outcome: PermissionOutcome
  readonly status?: PermissionOutcome | undefined
  readonly effect: "allow" | "deny" | "ask"
  readonly allowed: boolean
  readonly requiresApproval: boolean
  readonly action: string
  readonly resources: readonly string[]
  readonly reason: string
  readonly rule?: PermissionRule | undefined
  readonly danger: DangerClassification
  readonly provenance: Provenance
  readonly approval?: ApprovalEvaluation | undefined
  readonly path?: PathDecision | undefined
}

export interface ApprovalPolicy {
  readonly mode?: "ask" | "allow" | "deny" | "block" | "auto" | "never" | "always_ask"
  readonly requireApproval?: boolean
  readonly allowDangerous?: boolean
  readonly trustedApproverOnly?: boolean
  readonly expiresInMs?: number
  readonly maxUses?: number
}

export interface ApprovalGrant {
  readonly id: string
  readonly action: string
  readonly resources: readonly string[]
  readonly approvedBy: string
  readonly issuedAt: number
  readonly expiresAt?: number
  readonly usesRemaining?: number
  readonly persistent?: boolean
  readonly scope?: ScopeIdentifier
  readonly dangerLevel?: DangerClassification["level"]
  readonly fingerprint?: string
  readonly provenance?: Provenance
}

export interface ApprovalEvaluation {
  readonly outcome: "approved" | "permission_required" | "denied" | "blocked"
  readonly status?: "approved" | "permission_required" | "denied" | "blocked" | undefined
  readonly approved: boolean
  readonly requiresApproval: boolean
  readonly reason: string
  readonly grant?: ApprovalGrant
  readonly dangerous: boolean
}

export type ApprovalResult = ApprovalEvaluation
export type ApprovalReply = "once" | "always" | "reject"

export interface PathAccessRequest {
  readonly path: string
  readonly access?: AccessMode
  readonly operation?: string
  readonly followSymlinks?: boolean
  readonly realpath?: (path: string) => string
}

export interface PathScope {
  readonly root: string
  readonly allow?: readonly string[]
  readonly read?: readonly string[]
  readonly write?: readonly string[]
  readonly create?: readonly string[]
  readonly delete?: readonly string[]
  readonly execute?: readonly string[]
  readonly list?: readonly string[]
  readonly search?: readonly string[]
  readonly admin?: readonly string[]
  readonly deny?: readonly string[]
  readonly caseSensitive?: boolean
  readonly followSymlinks?: boolean
  readonly realpath?: (path: string) => string
}

export interface PathDecision {
  readonly outcome: PermissionOutcome
  readonly status?: PermissionOutcome | undefined
  readonly allowed: boolean
  readonly path: string
  readonly normalizedPath: string
  readonly root: string
  readonly access: AccessMode
  readonly reason: string
  readonly pattern?: string
}

export type Scope = PathScope
export type FileAccessDecision = PathDecision

export type ContentKind =
  | "user_instruction"
  | "operator_instruction"
  | "system_context"
  | "untrusted_content"
  | "tool_result"
  | "file_content"
  | "web_content"
  | "application_content"
  | "environment_content"

export interface ContentEnvelope {
  readonly id: string
  readonly kind: ContentKind
  readonly channel: "user" | "system" | "tool"
  readonly instruction: boolean
  readonly provenance: Provenance
  readonly content: string
  readonly _tag?: "UntrustedContent"
  readonly authority?: "untrusted_data"
  readonly trust?: TrustLevel
  readonly mediaType?: string
  readonly metadata?: Readonly<Record<string, unknown>>
}

export type Envelope = ContentEnvelope
export type UntrustedEnvelope = ContentEnvelope

export type AuditEventType =
  | "permission.evaluated"
  | "permission.denied"
  | "permission.blocked"
  | "permission.required"
  | "approval.granted"
  | "approval.denied"
  | "approval.consumed"
  | "file.access"
  | "dangerous.detected"
  | "content.untrusted"
  | "secret.redacted"

export interface AuditEvent {
  readonly id: string
  readonly timestamp: number
  readonly type: AuditEventType
  readonly outcome: PermissionOutcome | "approved" | "redacted" | "observed"
  readonly status?: PermissionOutcome | "approved" | "redacted" | "observed" | undefined
  readonly action?: string
  readonly resources: readonly string[]
  readonly reason: string
  readonly actor?: string
  readonly metadata: Readonly<Record<string, unknown>>
}
