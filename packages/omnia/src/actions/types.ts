import type {
  ActionError,
  ActionResult,
  ActionResultStatus,
  ActionType,
  ApprovalDecision,
  Backend,
  Bounds,
  CapabilityState,
  ComputerAction,
  ComputerTarget,
  ElementReference,
  JsonValue,
  Limitation,
  Metadata,
  Observation,
  PermissionScope,
  Provenance,
  Role,
  Source,
  UIElement,
  Verification,
  VerificationEvidence,
} from "../protocol"
import type {
  RetrievalContext,
  RetrievalInput,
  RetrievalMatch,
  SemanticRetrievalRequest,
} from "../retrieval/types"

export type ActionTargetInput = string | ComputerTarget | ElementReference | RetrievalMatch | {
  readonly query?: string
  readonly role?: Role
  readonly name?: string
  readonly description?: string
  readonly value?: JsonValue
  readonly elementId?: string
  readonly url?: string
  readonly path?: string
  readonly applicationId?: string
}

export type VerificationKind = "text" | "window" | "value" | "file" | "control" | "url" | "state"
export type VerificationMode = "exact" | "contains" | "prefix" | "suffix" | "regex"

export interface VerificationSpec {
  readonly kind: VerificationKind
  readonly expected?: unknown
  readonly actual?: unknown
  readonly mode?: VerificationMode
  readonly caseSensitive?: boolean
  readonly normalize?: boolean
  readonly property?: string
  readonly tolerance?: number
  readonly timeoutMs?: number
  readonly metadata?: Metadata
}

export type VerificationRequest = VerificationSpec
export type VerificationStrategy = (spec: VerificationSpec) => Verification

export interface ActionIntent {
  readonly type?: ActionType | string
  readonly action?: ActionType | string
  readonly target?: ActionTargetInput
  readonly query?: string
  readonly role?: Role
  readonly name?: string
  readonly description?: string
  readonly value?: JsonValue
  readonly text?: string
  readonly keys?: string
  readonly key?: string
  readonly elementId?: string
  readonly applicationId?: string
  readonly url?: string
  readonly path?: string
  readonly input?: JsonValue
  readonly parameters?: Metadata
  readonly id?: string
  readonly actionId?: string
  readonly source?: Source
  readonly backend?: Backend
  readonly scope?: PermissionScope
  readonly approval?: ApprovalDecision
  readonly timeoutMs?: number
  readonly metadata?: Metadata
  readonly provenance?: Provenance
  readonly button?: "left" | "right" | "middle"
  readonly count?: number
  readonly modifiers?: readonly ("alt" | "control" | "meta" | "shift")[]
  readonly durationMs?: number
  readonly from?: ComputerTarget
  readonly to?: ComputerTarget
  readonly direction?: "up" | "down" | "left" | "right"
  readonly deltaX?: number
  readonly deltaY?: number
  readonly amount?: number
  readonly condition?: string
  readonly ms?: number
  readonly include?: readonly string[]
  readonly region?: Bounds
  readonly includeCursor?: boolean
  readonly application?: string
  readonly request?: SemanticRetrievalRequest
  readonly filters?: SemanticRetrievalRequest
  readonly verification?: VerificationSpec
  readonly [key: string]: unknown
}

export interface ActionResolutionOptions {
  readonly observation?: Observation
  readonly elements?: readonly UIElement[]
  readonly input?: RetrievalInput
  readonly context?: RetrievalContext
  readonly activeWindowId?: string
  readonly activeElementId?: string
  readonly request?: SemanticRetrievalRequest
  readonly limit?: number
  readonly minimumConfidence?: number
  readonly minConfidence?: number
  readonly minimumMargin?: number
  readonly minMargin?: number
  readonly preferredBackendIds?: readonly string[]
  readonly backends?: readonly (ActionBackend | string)[]
  readonly revalidate?: TargetRevalidationCallback
  readonly revalidateTarget?: TargetRevalidationCallback
  readonly execute?: ActionExecutor
  readonly executor?: ActionExecutor
  readonly driver?: ActionDriver
  readonly now?: number
  readonly verify?: boolean
  readonly verification?: VerificationSpec
  readonly deferRevalidation?: boolean
}

export type ActionResolutionStatus = "resolved" | "ambiguous" | "not-found" | "invalid" | "stale" | "unavailable" | "failed"

export interface ActionResolution {
  readonly success: boolean
  readonly status: ActionResultStatus
  readonly resolutionStatus: ActionResolutionStatus
  readonly action?: ComputerAction
  readonly target?: ComputerTarget
  readonly reference?: ElementReference
  readonly match?: RetrievalMatch
  readonly candidate?: RetrievalMatch
  readonly selectedCandidate?: RetrievalMatch
  readonly candidates: readonly RetrievalMatch[]
  readonly rankedBackends: readonly RankedActionBackend[]
  readonly backend?: ActionBackend
  readonly confidence: number
  readonly provenance: Provenance
  readonly result: ActionResult
  readonly message?: string
  readonly error?: ActionError
  readonly limitations?: readonly Limitation[]
  readonly verification?: Verification
}

export interface ActionBackend {
  readonly id?: string
  readonly backend: Backend
  readonly available?: boolean
  readonly status?: string
  readonly priority?: number
  readonly quality?: number
  readonly score?: number
  readonly confidence?: number
  readonly responsiveness?: number
  readonly supports?: readonly ActionType[] | readonly string[]
  readonly supportedActions?: readonly ActionType[] | readonly string[]
  readonly capabilities?: Readonly<Record<string, CapabilityState | string>>
  readonly limitations?: readonly Limitation[]
  readonly metadata?: Metadata
  readonly execute?: ActionExecutor
  readonly driver?: ActionDriver
}

export interface RankedActionBackend extends ActionBackend {
  readonly score: number
  readonly eligible: boolean
  readonly rank?: number
  readonly reasons: readonly string[]
}

export interface ActionDriver {
  readonly id?: string
  readonly backend?: Backend
  readonly execute?: (action: ComputerAction) => ActionResult | Promise<ActionResult>
  readonly act?: (action: ComputerAction) => ActionResult | Promise<ActionResult>
}

export type ActionExecutor = (
  action: ComputerAction,
  backend?: ActionBackend,
) => ActionResult | Promise<ActionResult>

export type TargetRevalidationCallback = (
  target: ComputerTarget,
) => TargetRevalidationValue | Promise<TargetRevalidationValue>

export type TargetRevalidationValue =
  | boolean
  | ElementReference
  | ComputerTarget
  | UIElement
  | {
      readonly valid?: boolean
      readonly status?: string
      readonly target?: ElementReference | ComputerTarget
      readonly reference?: ElementReference
      readonly reason?: string
    }

export interface ActionExecutionOptions extends ActionResolutionOptions {
  readonly requireVerification?: boolean
}

export interface StructuredResultInput {
  readonly actionId?: string
  readonly message?: string
  readonly status?: ActionResultStatus
  readonly verification?: Verification
  readonly limitations?: readonly Limitation[]
  readonly metadata?: Metadata
  readonly error?: ActionError
}

export interface VerificationEvidenceInput extends VerificationEvidence {
  readonly kind?: string
}

export type { ActionBackendCandidate } from "../retrieval/types"
export type {
  CandidateDecision,
  RetrievalContext,
  RetrievalInput,
  RetrievalMatch,
  SemanticRetrievalRequest,
  TargetRevalidationRequest,
  TargetRevalidationResult,
} from "../retrieval/types"
