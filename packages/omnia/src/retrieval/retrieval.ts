import type {
  ElementReference,
  FindResult,
  JsonValue,
  Metadata,
  Observation,
  Provenance,
  UIElement,
} from "../protocol"
import type {
  SemanticRetrievalRequest,
  IndexedRetrievalElement,
  RetrievalContext,
  RetrievalInput,
  RetrievalMatch,
  RetrievalCandidate,
  RetrievalResult,
} from "./types"
import { clamp, compareText, filterMatches, isRecord, matchElement, normalizeRole, normalizeText, stableJson } from "./match"
import {
  buildRetrievalHierarchy,
  contextScore,
  contextTargetId,
  elementReference,
} from "./hierarchy"
import type {
  CandidateDecision,
  CandidateDisambiguationOptions,
  TargetRevalidationRequest,
  TargetRevalidationResult,
} from "./types"

const DEFAULT_LIMIT = 50
const DEFAULT_FUZZY_THRESHOLD = 0.55
// 0.35 was low enough that a 0.4 query.includes(name) over-match resolved as
// an executable target; read operations keep a 0.5 floor and mutating actions
// require 0.6, aligned with the router's semantic threshold.
const DEFAULT_MINIMUM_CONFIDENCE = 0.5
const MUTATING_MINIMUM_CONFIDENCE = 0.6
const DEFAULT_MINIMUM_MARGIN = 0.08

export function retrieveElements(
  input: RetrievalInput,
  request: SemanticRetrievalRequest | string = { query: "" },
): RetrievalResult {
  const normalizedRequest = typeof request === "string" ? { query: request } : request
  const hierarchy = buildRetrievalHierarchy(input, normalizedRequest.context ?? {})
  const observation = readObservation(input)
  const query = normalizedRequest.query ?? normalizedRequest.text ?? normalizedRequest.filters?.query ?? ""
  const exact = normalizedRequest.exact === true || normalizedRequest.fuzzy === false
  const threshold = normalizeThreshold(exact ? 1 : normalizedRequest.fuzzyThreshold ?? normalizedRequest.threshold ?? DEFAULT_FUZZY_THRESHOLD)
  const includeOffscreen = normalizedRequest.includeOffscreen ?? normalizedRequest.filters?.includeOffscreen ?? normalizedRequest.context?.includeOffscreen ?? false
  const filters = {
    ...normalizedRequest.filters,
    ...(normalizedRequest.role === undefined ? {} : { role: normalizedRequest.role }),
    ...(normalizedRequest.name === undefined ? {} : { name: normalizedRequest.name }),
    ...(normalizedRequest.description === undefined ? {} : { description: normalizedRequest.description }),
    ...(normalizedRequest.value === undefined ? {} : { value: normalizedRequest.value }),
    ...(normalizedRequest.source === undefined ? {} : { source: normalizedRequest.source }),
    ...(normalizedRequest.backend === undefined ? {} : { backend: normalizedRequest.backend }),
    ...(normalizedRequest.observationId === undefined ? {} : { observationId: normalizedRequest.observationId }),
    includeOffscreen,
  }
  const requestedObservationId = normalizedRequest.observationId ?? normalizedRequest.filters?.observationId
  const scored = hierarchy.elements
    .filter((entry) => filterMatches(entry.element, filters, exact, { ...(observation?.source === undefined ? {} : { source: observation.source }), ...(observation?.backend === undefined ? {} : { backend: observation.backend }) }))
    .filter((entry) => requestedObservationId === undefined || entry.element.reference?.observationId === requestedObservationId || (entry.element.reference === undefined && observation?.id === requestedObservationId))
    .map((entry) => scoreEntry(entry, query, normalizedRequest, observation, hierarchy.activeWindowId, hierarchy.activeElementId, threshold))
    .filter((entry) => query.trim().length === 0 || entry.match.score >= threshold)
    .sort(compareScoredEntries)
  const limit = normalizeLimit(normalizedRequest.limit)
  const matches = scored.slice(0, limit).map(({ entry, match, context: contextAmount, provenance }) => ({
    element: entry.element,
    ...(referenceFor(entry.element, observation) === undefined ? {} : { reference: referenceFor(entry.element, observation) }),
    score: roundScore(match.score),
    confidence: roundScore(match.score),
    reason: createReason(match.matchedOn, contextAmount, match.score),
    provenance,
    matchedOn: match.matchedOn,
    hierarchyPath: entry.path,
    depth: entry.depth,
    contextScore: roundScore(contextAmount),
    elementIndex: entry.index,
  }))
  const selectedElements = matches.map((match) => match.element)
  const references = matches
    .map((match) => match.reference)
    .filter((reference): reference is ElementReference => reference !== undefined)
  const top = matches[0]
  const metadata: Metadata = {
    strategy: "deterministic-semantic",
    ...(query.length === 0 ? {} : { query }),
    ...(observation?.id === undefined ? {} : { observationId: observation.id }),
    ...(hierarchy.activeWindowId === undefined ? {} : { activeWindowId: hierarchy.activeWindowId }),
    ...(hierarchy.activeElementId === undefined ? {} : { activeElementId: hierarchy.activeElementId }),
    ...(hierarchy.warnings.length === 0 ? {} : { hierarchyWarnings: hierarchy.warnings }),
    threshold,
  }
  const result: RetrievalResult = {
    query,
    matches,
    results: matches,
    elements: selectedElements,
    references,
    ...(observation === undefined ? {} : { observation }),
    confidence: top?.confidence ?? 0,
    provenance: top?.provenance ?? fallbackProvenance(observation),
    hierarchy,
    candidates: matches,
    ...(top === undefined ? {} : { bestMatch: top, selected: top }),
    truncated: scored.length > matches.length,
    metadata,
  }
  return result
}

export const retrieve = retrieveElements
export const search = retrieveElements
export const searchElements = retrieveElements
export const findElements = retrieveElements
export const semanticRetrieve = retrieveElements
export const retrieveSemantic = retrieveElements
export const semanticSearch = retrieveElements

export function createRetriever(defaults: SemanticRetrievalRequest = {}) {
  return (input: RetrievalInput, request: SemanticRetrievalRequest = {}) =>
    retrieveElements(input, { ...defaults, ...request, query: request.query ?? defaults.query ?? "" })
}

export const createRetrieval = createRetriever

export function resolveElement(
  input: RetrievalInput,
  request: SemanticRetrievalRequest | string,
): UIElement | undefined {
  const result = retrieveElements(input, request)
  const decision = disambiguateCandidates(result)
  return decision.status === "resolved" ? decision.selected?.element : undefined
}

export const selectElement = resolveElement

export function rankMatches(result: RetrievalResult | readonly RetrievalMatch[]): readonly RetrievalMatch[] {
  return (isRetrievalResult(result) ? result.matches : result).slice().sort(compareMatches)
}

export const rankCandidates = rankMatches

export function disambiguateCandidates(
  input: readonly RetrievalCandidate[] | RetrievalResult,
  options: CandidateDisambiguationOptions = {},
): CandidateDecision {
  const resultInput = isRetrievalResult(input) ? input : undefined
  const rawCandidates: readonly RetrievalCandidate[] = resultInput === undefined ? input as readonly RetrievalCandidate[] : resultInput.matches
  const candidates = rawCandidates.map(normalizeCandidate).sort(compareMatches)
  const inputProvenance = resultInput?.provenance
  const minimumConfidence =
    options.minimumConfidence ??
    options.minConfidence ??
    (options.mutating === true ? MUTATING_MINIMUM_CONFIDENCE : DEFAULT_MINIMUM_CONFIDENCE)
  const viable = candidates.filter((candidate) => candidate.confidence >= minimumConfidence)
  const base: Omit<CandidateDecision, "status" | "selected" | "match" | "confidence" | "reason" | "provenance" | "needsDisambiguation"> = {
    candidates,
  }
  if (viable.length === 0) {
    return {
      ...base,
      status: "not-found",
      confidence: candidates[0]?.confidence ?? 0,
      reason: "No candidate meets the minimum confidence.",
      provenance: candidates[0]?.provenance ?? inputProvenance ?? fallbackProvenance(undefined),
      needsDisambiguation: false,
    }
  }
  const selectedId = options.selectedId ?? targetElementId(options.target)
  if (selectedId !== undefined) {
    const selected = viable.find((candidate) => candidate.element.id === selectedId || candidate.element.reference?.elementId === selectedId || candidate.element.reference?.id === selectedId)
    if (selected !== undefined) return resolved(selected, candidates, "The requested target selected the candidate.")
    return {
      ...base,
      status: "not-found",
      confidence: viable[0]?.confidence ?? 0,
      reason: "The requested target is not present in the candidate set.",
      provenance: viable[0]?.provenance ?? fallbackProvenance(undefined),
      needsDisambiguation: false,
    }
  }
  if (viable.length === 1) return resolved(viable[0], candidates, "Only one candidate met the confidence threshold.")
  const top = viable[0]
  const second = viable[1]
  if (top === undefined || second === undefined) return notFound(candidates)
  const contextSelected = contextSelection(viable, options.context)
  if (contextSelected !== undefined) return resolved(contextSelected, candidates, "Active-window context selected the candidate.")
  const margin = top.confidence - second.confidence
  if (margin >= (options.minimumMargin ?? options.margin ?? DEFAULT_MINIMUM_MARGIN)) {
    return resolved(top, candidates, "The leading candidate exceeded the disambiguation margin.")
  }
  return {
    ...base,
    status: "ambiguous",
    confidence: top.confidence,
    reason: "Multiple candidates have indistinguishable confidence.",
    provenance: top.provenance,
    needsDisambiguation: true,
  }
}

export const disambiguate = disambiguateCandidates
export const chooseCandidate = disambiguateCandidates

export function revalidateTarget(
  request: TargetRevalidationRequest,
): TargetRevalidationResult
export function revalidateTarget(
  target: TargetRevalidationRequest["target"],
  input?: RetrievalInput | TargetRevalidationRequest,
): TargetRevalidationResult
export function revalidateTarget(
  requestOrTarget: TargetRevalidationRequest | TargetRevalidationRequest["target"],
  inputOrObservation?: RetrievalInput | TargetRevalidationRequest,
): TargetRevalidationResult {
  const request = isRevalidationRequest(requestOrTarget)
    ? requestOrTarget
    : isRevalidationRequest(inputOrObservation)
      ? { ...inputOrObservation, target: requestOrTarget }
      : { target: requestOrTarget, input: inputOrObservation as RetrievalInput | undefined }
  const target = targetParts(request.target)
  const currentInput = request.input ?? request.elements ?? request.observation
  if (currentInput === undefined) {
    return {
      status: "missing",
      valid: false,
      candidates: [],
      reason: "No current observation was supplied for target revalidation.",
      confidence: 0,
      provenance: fallbackProvenance(request.observation),
    }
  }
  const hierarchy = buildRetrievalHierarchy(currentInput, request.context ?? {})
  const candidates = hierarchy.elements
    .filter((entry) => entry.id === target.id)
    .map((entry) => entry.element)
  if (candidates.length === 0) {
    return {
      status: "missing",
      valid: false,
      candidates,
      reason: `Element ${target.id} is not present in the current observation.`,
      confidence: 0,
      provenance: fallbackProvenance(readObservation(currentInput)),
    }
  }
  if (candidates.length > 1) {
    return {
      status: "ambiguous",
      valid: false,
      candidates,
      reason: `Element ${target.id} appears more than once in the current observation.`,
      confidence: 0,
      provenance: fallbackProvenance(readObservation(currentInput)),
    }
  }
  const current = candidates[0]
  const currentReference = elementReference(current, readObservation(currentInput)?.id)
  const mismatch = referenceMismatch(target.reference, currentReference, request.now)
  if (mismatch !== undefined) {
    return {
      status: "stale",
      valid: false,
      target: target.reference,
      reference: target.reference,
      element: current,
      candidates,
      reason: mismatch,
      confidence: 0,
      provenance: fallbackProvenance(readObservation(currentInput)),
    }
  }
  const reference = mergeReference(target.reference, currentReference, current)
  return {
    status: "valid",
    valid: true,
    target: reference,
    reference,
    element: current,
    candidates,
    reason: "The target identity and observation generation are unchanged.",
    confidence: 1,
    provenance: elementProvenance(current, readObservation(currentInput)),
  }
}

export const revalidate = revalidateTarget
export const validateTarget = revalidateTarget
export const revalidateElementTarget = revalidateTarget

export function isTargetValid(result: TargetRevalidationResult): boolean {
  return result.valid && result.status === "valid"
}

function scoreEntry(
  entry: IndexedRetrievalElement,
  query: string,
  request: SemanticRetrievalRequest,
  observation: Observation | undefined,
  activeWindowId: string | undefined,
  activeElementId: string | undefined,
  threshold: number,
): {
  readonly entry: IndexedRetrievalElement
  readonly match: ReturnType<typeof matchElement>
  readonly context: number
  readonly provenance: Provenance
} {
  const match = matchElement(entry.element, query, {
    ...request.filters,
    ...(request.role === undefined ? {} : { role: request.role }),
    ...(request.name === undefined ? {} : { name: request.name }),
    ...(request.description === undefined ? {} : { description: request.description }),
    ...(request.value === undefined ? {} : { value: request.value }),
  }, request.exact === true || request.fuzzy === false)
  const context = contextScore(entry, request.context ?? {}, activeWindowId, activeElementId)
  const base = match.score
  const score = request.exact === true || request.fuzzy === false
    ? base
    : base >= 0.999
      ? 1
      : base < threshold
        ? base
        : clamp(base * 0.86 + context * 0.14)
  return {
    entry,
    match: { ...match, score },
    context,
    provenance: elementProvenance(entry.element, observation),
  }
}

function referenceFor(element: UIElement, observation: Observation | undefined): ElementReference | undefined {
  return elementReference(element, observation?.id)
}

function createReason(matchedOn: readonly string[], context: number, score: number): string {
  const fields = matchedOn.length === 0 ? ["context"] : matchedOn
  return `${fields.join(", ")}; ${score >= 0.999 ? "exact" : "fuzzy"}${context > 0 ? "; active context" : ""}`
}

function compareScoredEntries(
  left: { readonly entry: IndexedRetrievalElement; readonly match: ReturnType<typeof matchElement>; readonly context: number },
  right: { readonly entry: IndexedRetrievalElement; readonly match: ReturnType<typeof matchElement>; readonly context: number },
): number {
  return right.match.score - left.match.score ||
    right.context - left.context ||
    compareText(left.entry.path.join(" "), right.entry.path.join(" ")) ||
    compareText(left.entry.id, right.entry.id)
}

function compareMatches(left: RetrievalMatch, right: RetrievalMatch): number {
  return right.score - left.score ||
    right.contextScore - left.contextScore ||
    compareText(left.hierarchyPath.join(" "), right.hierarchyPath.join(" ")) ||
    compareText(left.element.id ?? "", right.element.id ?? "")
}

function contextSelection(candidates: readonly RetrievalMatch[], context: RetrievalContext | undefined): RetrievalMatch | undefined {
  if (context === undefined) return undefined
  const activeId = context.activeElementId ?? context.focusedId ?? contextTargetId(context.activeElement)
  if (activeId !== undefined) {
    const matches = candidates.filter((candidate) => candidate.element.id === activeId)
    if (matches.length === 1) return matches[0]
  }
  const activeWindow = context.activeWindowId ?? context.windowId ?? contextTargetId(context.activeWindow)
  if (activeWindow !== undefined) {
    const matches = candidates.filter((candidate) => candidate.element.id === activeWindow || candidate.hierarchyPath.includes(activeWindow))
    if (matches.length === 1) return matches[0]
  }
  return undefined
}

function resolved(selected: RetrievalMatch, candidates: readonly RetrievalMatch[], reason: string): CandidateDecision {
  return {
    status: "resolved",
    selected,
    match: selected,
    candidates,
    confidence: selected.confidence,
    reason,
    provenance: selected.provenance,
    needsDisambiguation: false,
  }
}

function notFound(candidates: readonly RetrievalMatch[]): CandidateDecision {
  return {
    status: "not-found",
    candidates,
    confidence: candidates[0]?.confidence ?? 0,
    reason: "No candidate could be selected.",
    provenance: candidates[0]?.provenance ?? fallbackProvenance(undefined),
    needsDisambiguation: false,
  }
}

function normalizeCandidate(candidate: RetrievalCandidate, index: number): RetrievalMatch {
  // A candidate may carry a missing/NaN confidence (or NaN score); coerce both
  // so comparisons never see NaN.
  const score = Number.isFinite(candidate.score) ? clamp(candidate.score) : 0
  const confidence =
    "confidence" in candidate && Number.isFinite(candidate.confidence) ? clamp(candidate.confidence) : score
  if (
    "confidence" in candidate &&
    Number.isFinite(candidate.confidence) &&
    Number.isFinite(candidate.score) &&
    "provenance" in candidate &&
    "matchedOn" in candidate &&
    "hierarchyPath" in candidate
  ) {
    return candidate
  }
  return {
    ...candidate,
    score,
    confidence,
    provenance: "provenance" in candidate ? candidate.provenance : fallbackProvenance(undefined),
    matchedOn: "matchedOn" in candidate ? candidate.matchedOn : candidate.reason === undefined ? [] : [candidate.reason],
    hierarchyPath: "hierarchyPath" in candidate ? candidate.hierarchyPath : candidate.element.id === undefined ? [] : [candidate.element.id],
    depth: "depth" in candidate ? candidate.depth : 0,
    contextScore: "contextScore" in candidate ? candidate.contextScore : 0,
    elementIndex: "elementIndex" in candidate ? candidate.elementIndex : index,
  }
}

function isRetrievalResult(value: readonly RetrievalCandidate[] | RetrievalResult): value is RetrievalResult {
  return !Array.isArray(value) && "matches" in value
}

function targetElementId(target: ElementReference | { readonly kind: "element"; readonly elementId: string } | undefined): string | undefined {
  return target === undefined ? undefined : "elementId" in target ? target.elementId : target.id
}

function targetParts(target: TargetRevalidationRequest["target"]): { readonly id: string; readonly reference?: ElementReference } {
  if (typeof target === "string") return { id: target }
  if ("kind" in target && target.kind === "element") {
    const reference = "reference" in target ? target.reference : target
    return { id: target.elementId ?? ("id" in target ? target.id : undefined) ?? "", reference }
  }
  return { id: target.elementId ?? target.id ?? "", reference: target }
}

function referenceMismatch(
  expected: ElementReference | undefined,
  actual: ElementReference | undefined,
  now: number | undefined,
): string | undefined {
  if (expected === undefined) return undefined
  if (expected.observationId !== undefined && actual?.observationId !== expected.observationId) return "The target observation is stale."
  if (expected.generation !== undefined && actual?.generation !== expected.generation) return "The target generation is stale."
  if (expected.generation === undefined && actual?.generation !== undefined) return "The target generation is stale."
  if (expected.source !== undefined && normalizeText(expected.source) !== normalizeText(actual?.source)) return "The target source changed."
  if (expected.backend !== undefined && normalizeText(expected.backend) !== normalizeText(actual?.backend)) return "The target backend changed."
  if (expected.role !== undefined && normalizeRole(expected.role) !== normalizeRole(actual?.role)) return "The target role changed."
  if (expected.locator !== undefined && stableJson(expected.locator) !== stableJson(actual?.locator)) return "The target locator changed."
  if (expected.expiresAt !== undefined && (now ?? Date.now()) >= expected.expiresAt) return "The target reference has expired."
  return undefined
}

function mergeReference(
  expected: ElementReference | undefined,
  actual: ElementReference | undefined,
  element: UIElement,
): ElementReference {
  const id = element.id ?? actual?.elementId ?? actual?.id ?? expected?.elementId ?? expected?.id ?? ""
  const observationId = actual?.observationId ?? expected?.observationId
  const generation = actual?.generation ?? expected?.generation
  const source = actual?.source ?? element.source ?? expected?.source
  const backend = actual?.backend ?? element.backend ?? expected?.backend
  const role = actual?.role ?? element.role ?? expected?.role
  const locator = actual?.locator ?? expected?.locator
  const expiresAt = actual?.expiresAt ?? expected?.expiresAt
  const metadata = actual?.metadata ?? expected?.metadata
  return {
    kind: "element",
    elementId: id,
    ...(observationId === undefined ? {} : { observationId }),
    ...(generation === undefined ? {} : { generation }),
    ...(source === undefined ? {} : { source }),
    ...(backend === undefined ? {} : { backend }),
    ...(role === undefined ? {} : { role }),
    ...(locator === undefined ? {} : { locator }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(metadata === undefined ? {} : { metadata }),
  }
}

function readObservation(input: RetrievalInput | undefined): Observation | undefined {
  if (input === undefined || !isRecord(input)) return undefined
  if ("observation" in input && input.observation !== undefined) return input.observation
  return input as Observation
}

function isRevalidationRequest(value: TargetRevalidationRequest | TargetRevalidationRequest["target"] | RetrievalInput | undefined): value is TargetRevalidationRequest {
  return isRecord(value) && "target" in value && !("kind" in value) && !("id" in value) && !("role" in value)
}

function elementProvenance(element: UIElement, observation: Observation | undefined): Provenance {
  if (element.provenance !== undefined) return element.provenance
  if (element.source !== undefined || element.reference?.source !== undefined) {
    return {
      source: element.source ?? element.reference?.source ?? "retrieved",
      trust: "untrusted",
      authority: "none",
      ...(element.backend ?? element.reference?.backend) === undefined ? {} : { backend: element.backend ?? element.reference?.backend },
    }
  }
  return fallbackProvenance(observation)
}

function fallbackProvenance(observation: Observation | undefined): Provenance {
  if (observation?.provenance !== undefined) return observation.provenance
  return {
    source: observation?.source ?? "retrieved",
    trust: "untrusted",
    authority: "none",
    ...(observation?.backend === undefined ? {} : { backend: observation.backend }),
  }
}

function roundScore(value: number): number {
  return Math.round(clamp(value) * 1_000_000) / 1_000_000
}

// Invalid thresholds/limits are clamped instead of throwing RangeError from
// the public API: a caller-supplied 1.5 must not break retrieval.
function normalizeThreshold(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_FUZZY_THRESHOLD
  return Math.min(1, Math.max(0, value))
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_LIMIT
  return Math.max(0, Math.min(Math.floor(value), 1000))
}

export function asFindResult(result: RetrievalResult): FindResult {
  return result
}

export function asJsonMetadata(value: Metadata): JsonValue {
  return value
}
