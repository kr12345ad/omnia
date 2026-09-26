import type {
  ActionType,
  Backend,
  ElementReference,
  FindMatch,
  FindRequest,
  FindResult,
  JsonValue,
  Limitation,
  Metadata,
  Observation,
  Provenance,
  Role,
  Source,
  UIElement,
} from "../protocol"

export interface RetrievalWindowContext {
  readonly id?: string
  readonly elementId?: string
  readonly title?: string
  readonly active?: boolean
  readonly focused?: boolean
}

export interface RetrievalContext {
  readonly activeWindowId?: string
  readonly activeElementId?: string
  readonly activeWindow?: RetrievalWindowContext | string
  readonly activeElement?: RetrievalWindowContext | string
  readonly windowId?: string
  readonly focusedId?: string
  readonly hierarchyRootId?: string
  readonly includeOffscreen?: boolean
  readonly metadata?: Metadata
}

export interface SemanticRetrievalRequest extends Omit<FindRequest, "query"> {
  readonly query?: string
  readonly description?: string
  readonly value?: JsonValue
  readonly text?: string
  readonly exact?: boolean
  readonly fuzzy?: boolean
  readonly fuzzyThreshold?: number
  readonly threshold?: number
  readonly filters?: RetrievalFilters
  readonly context?: RetrievalContext
  readonly includeHierarchy?: boolean
}

export type RetrievalRequest = SemanticRetrievalRequest
export type RetrievalCandidate = RetrievalMatch | FindMatch

export interface IndexedRetrievalElement {
  readonly element: UIElement
  readonly id: string
  readonly index: number
  readonly depth: number
  readonly siblingIndex: number
  readonly path: readonly string[]
  readonly parentId?: string
  readonly children: readonly string[]
}

export interface RetrievalHierarchy {
  readonly elements: readonly IndexedRetrievalElement[]
  readonly byId: ReadonlyMap<string, IndexedRetrievalElement>
  readonly children: ReadonlyMap<string, readonly string[]>
  readonly roots: readonly string[]
  readonly activeWindowId?: string
  readonly activeElementId?: string
  readonly warnings: readonly string[]
}

export interface RetrievalMatch extends FindMatch {
  readonly confidence: number
  readonly provenance: Provenance
  readonly matchedOn: readonly string[]
  readonly hierarchyPath: readonly string[]
  readonly depth: number
  readonly contextScore: number
  readonly elementIndex: number
}

export interface RetrievalResult extends FindResult {
  readonly query: string
  readonly matches: readonly RetrievalMatch[]
  readonly results: readonly RetrievalMatch[]
  readonly elements: readonly UIElement[]
  readonly references: readonly ElementReference[]
  readonly confidence: number
  readonly provenance: Provenance
  readonly hierarchy: RetrievalHierarchy
  readonly candidates: readonly RetrievalMatch[]
  readonly bestMatch?: RetrievalMatch
  readonly selected?: RetrievalMatch
  readonly truncated: boolean
  readonly metadata: Metadata
}

export type RetrievalInput = Observation | readonly UIElement[] | {
  readonly observation: Observation
  readonly elements?: readonly UIElement[]
}

export type DisambiguationStatus = "resolved" | "ambiguous" | "not-found"

export interface CandidateDisambiguationOptions {
  readonly context?: RetrievalContext
  readonly minimumConfidence?: number
  readonly minConfidence?: number
  readonly minimumMargin?: number
  readonly margin?: number
  readonly selectedId?: string
  readonly target?: ElementReference | { readonly kind: "element"; readonly elementId: string }
}

export interface CandidateDecision {
  readonly status: DisambiguationStatus
  readonly selected?: RetrievalMatch
  readonly match?: RetrievalMatch
  readonly candidates: readonly RetrievalMatch[]
  readonly confidence: number
  readonly reason: string
  readonly provenance: Provenance
  readonly needsDisambiguation: boolean
}

export type RevalidationStatus = "valid" | "stale" | "missing" | "ambiguous"

export interface TargetRevalidationRequest {
  readonly target: ElementReference | { readonly kind: "element"; readonly elementId: string; readonly reference?: ElementReference } | string
  readonly observation?: Observation
  readonly elements?: readonly UIElement[]
  readonly input?: RetrievalInput
  readonly context?: RetrievalContext
  readonly now?: number
}

export interface TargetRevalidationResult {
  readonly status: RevalidationStatus
  readonly valid: boolean
  readonly target?: ElementReference
  readonly reference?: ElementReference
  readonly element?: UIElement
  readonly candidates: readonly UIElement[]
  readonly reason: string
  readonly confidence: number
  readonly provenance: Provenance
}

export interface RetrievalFilters {
  readonly query?: string
  readonly role?: Role
  readonly name?: string
  readonly description?: string
  readonly value?: JsonValue
  readonly source?: Source
  readonly backend?: Backend
  readonly observationId?: string
  readonly includeOffscreen?: boolean
}

export interface FieldMatch {
  readonly field: string
  readonly score: number
  readonly exact: boolean
  readonly distance?: number
}

export interface ElementMatchResult {
  readonly score: number
  readonly fields: readonly FieldMatch[]
  readonly matchedOn: readonly string[]
  readonly distance?: number
}

export interface ActionBackendCandidate {
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
  readonly capabilities?: Readonly<Record<string, string>>
  readonly limitations?: readonly Limitation[]
  readonly metadata?: Metadata
}

export type RetrievalInputWithContext = {
  readonly input: RetrievalInput
  readonly context?: RetrievalContext
}
