import {
  isComputerAction,
  isComputerTarget,
  isElementReference,
  isJsonValue,
  isMetadata,
  isUIElement,
} from "../protocol"
import type {
  ActionResult,
  ActionType,
  ComputerAction,
  ComputerTarget,
  ElementReference,
  JsonValue,
  Observation,
  Provenance,
  UIElement,
  Verification,
} from "../protocol"
import {
  disambiguateCandidates,
  retrieveElements,
  revalidateTarget,
} from "../retrieval/retrieval"
import type {
  RetrievalContext,
  RetrievalInput,
  RetrievalMatch,
  SemanticRetrievalRequest,
} from "../retrieval/types"
import { normalizeActionType, rankActionBackends, selectActionBackend } from "./backend"
import {
  applyVerification,
  createActionFailure,
  createActionSuccess,
  deterministicActionId,
  normalizeActionResult,
  unavailableResult,
} from "./result"
import { verify } from "./verification"
import type {
  ActionDriver,
  ActionExecutionOptions,
  ActionExecutor,
  ActionIntent,
  ActionResolution,
  ActionResolutionOptions,
  ActionResolutionStatus,
  ActionTargetInput,
  TargetRevalidationResult,
  TargetRevalidationValue,
} from "./types"

export function resolveAction(
  input: ActionIntent | ComputerAction,
  options: ActionResolutionOptions = {},
): ActionResolution {
  const intent = normalizeIntent(input)
  const type = normalizeActionType(String(intent.type ?? intent.action ?? ""))
  if (type === undefined) return invalidResolution("The action type is not supported.", intent)
  if (requiresElementTarget(type) && intent.target === undefined && intent.elementId === undefined && !hasSemanticSelector(intent)) {
    return invalidResolution(`${type} requires a target.`, intent)
  }
  const sourceInput = options.input ?? options.observation ?? options.elements
  const targetResolution = resolveActionTarget(intent, type, sourceInput, options)
  if (targetResolution.resolutionStatus !== "resolved") {
    return targetResolution.resolution ?? invalidResolution("The action target could not be resolved.", intent)
  }
  const action = buildAction(intent, type, targetResolution.target)
  if (action === undefined) return invalidResolution(`The ${type} action is missing required parameters.`, intent)
  const actionId = intent.actionId ?? intent.id ?? deterministicActionId(action)
  const resolvedAction = intent.actionId === undefined && isComputerAction({ ...action, actionId })
    ? { ...action, actionId }
    : action
  const rankedBackends = options.backends === undefined
    ? []
    : rankActionBackends(options.backends, type, { preferredBackendIds: options.preferredBackendIds })
  const backend = options.backends === undefined ? undefined : selectActionBackend(options.backends, type, { preferredBackendIds: options.preferredBackendIds })
  const provenance = intent.provenance ?? targetResolution.match?.provenance ?? fallbackProvenance(options.observation)
  const limitations = backend?.limitations ?? []
  const result = createActionSuccess(actionId, {
    message: "The action target was resolved.",
    ...(limitations.length === 0 ? {} : { limitations }),
    metadata: actionMetadata(targetResolution, rankedBackends.length, targetResolution.match?.confidence ?? (targetResolution.target === undefined ? 1 : 0.8), provenance),
  })
  const resolution: ActionResolution = {
    success: true,
    status: "success",
    resolutionStatus: "resolved",
    action: resolvedAction,
    ...(targetResolution.target === undefined ? {} : { target: targetResolution.target }),
    ...(targetResolution.reference === undefined ? {} : { reference: targetResolution.reference }),
    ...(targetResolution.match === undefined ? {} : { match: targetResolution.match, candidate: targetResolution.match, selectedCandidate: targetResolution.match }),
    candidates: targetResolution.candidates,
    rankedBackends,
    ...(backend === undefined ? {} : { backend }),
    confidence: targetResolution.match?.confidence ?? (targetResolution.target === undefined ? 1 : 0.8),
    provenance,
    result,
    ...(limitations.length === 0 ? {} : { limitations }),
    message: result.message,
  }
  const targetFailure = resolutionTargetFailure(resolution, options)
  if (targetFailure !== undefined) {
    const failure = createActionFailure("target_stale", targetFailure, { actionId })
    return {
      ...resolution,
      success: false,
      status: failure.status ?? "failed",
      resolutionStatus: "stale",
      result: failure,
      error: failure.error,
      message: targetFailure,
    }
  }
  if (options.backends !== undefined && rankedBackends.length > 0 && backend === undefined) {
    const failure = unavailableResult("No compatible backend can execute the resolved action.", { actionId })
    return {
      ...resolution,
      success: false,
      status: failure.status ?? "unavailable",
      resolutionStatus: "unavailable",
      result: failure,
      error: failure.error,
      message: failure.message,
    }
  }
  return resolution
}

export const resolve = resolveAction
export const resolveUniversalAction = resolveAction
export const resolveComputerAction = resolveAction
export const resolveTarget = resolveAction

export function resolveActionResult(
  input: ActionIntent | ComputerAction,
  options: ActionResolutionOptions = {},
): ActionResult {
  return resolveAction(input, options).result
}

export function executeAction(
  input: ActionIntent | ComputerAction,
  options: ActionExecutionOptions = {},
): Promise<ActionResolution> {
  const intent = normalizeIntent(input)
  const executionOptions = intent.verification === undefined || options.verification !== undefined
    ? options
    : { ...options, verification: intent.verification, verify: options.verify ?? true }
  return executeResolvedAction(resolveAction(intent, { ...executionOptions, deferRevalidation: true }), executionOptions)
}

export const execute = executeAction
export const resolveAndExecuteAction = executeAction
export const executeUniversalAction = executeAction
export const executeResolved = executeResolvedAction

export function createActionResolver(defaults: ActionExecutionOptions = {}) {
  return {
    resolve: (input: ActionIntent | ComputerAction, options: ActionResolutionOptions = {}) =>
      resolveAction(input, { ...defaults, ...options }),
    execute: (input: ActionIntent | ComputerAction, options: ActionExecutionOptions = {}) =>
      executeAction(input, { ...defaults, ...options }),
  }
}

export const createResolver = createActionResolver

export async function executeResolvedAction(
  resolution: ActionResolution,
  options: ActionExecutionOptions = {},
): Promise<ActionResolution> {
  if (!resolution.success || resolution.action === undefined) return resolution
  let currentResolution = resolution
  const target = currentResolution.target
  const revalidated = await revalidateExecutionTarget(currentResolution, target, options)
  if (revalidated !== undefined) {
    if (!revalidated.success) return revalidated
    currentResolution = revalidated
  }
  if (currentResolution.action === undefined) return currentResolution
  const backend = currentResolution.backend ?? selectActionBackend(options.backends ?? [], currentResolution.action.type, { preferredBackendIds: options.preferredBackendIds })
  const executor = options.execute ?? options.executor ?? backend?.execute ?? driverExecutor(options.driver ?? backend?.driver)
  if (executor === undefined) {
    return { ...withResult(currentResolution, unavailableResult("No executable computer backend was provided.", { actionId: currentResolution.result.actionId })), resolutionStatus: "unavailable" }
  }
  let value: ActionResult
  try {
    value = await executor(currentResolution.action, backend)
  } catch (error) {
    const message = error instanceof Error ? error.message : "The action backend failed."
    return withResult(currentResolution, createActionFailure("operation_failed", message, { actionId: currentResolution.result.actionId }))
  }
  const normalized = normalizeActionResult(value, {
    actionId: currentResolution.result.actionId,
    ...(currentResolution.limitations === undefined ? {} : { limitations: currentResolution.limitations }),
  })
  const verification = currentResolution.action === undefined ? undefined : verificationForResult(options, normalized)
  const finalized = verification === undefined ? normalized : applyVerification(normalized, verification, options.requireVerification ?? true)
  return withResult(currentResolution, finalized, verification)
}

export function requiresElementTarget(type: ActionType): boolean {
  return type === "click" || type === "doubleclick" || type === "rightclick" || type === "longpress" || type === "move" || type === "drag" || type === "type" || type === "setvalue" || type === "focus" || type === "toggle" || type === "select" || type === "expand" || type === "collapse" || type === "increment" || type === "decrement" || type === "dismiss"
}

export function toComputerTarget(candidate: RetrievalMatch, observation?: Observation): ComputerTarget | undefined {
  const id = candidate.element.id ?? candidate.element.reference?.elementId ?? candidate.element.reference?.id
  if (id === undefined) return undefined
  const reference = candidate.reference ?? referenceFromElement(candidate.element, observation?.id)
  return {
    kind: "element",
    elementId: id,
    ...(reference === undefined ? {} : { reference }),
  }
}

export function revalidateActionTarget(
  resolution: ActionResolution,
  options: ActionResolutionOptions = {},
): TargetRevalidationResult {
  const target = resolution.target
  const currentInput = options.input ?? options.observation ?? options.elements
  if (target?.kind !== "element" || currentInput === undefined) {
    return {
      status: "missing",
      valid: false,
      candidates: [],
      reason: "A current observation and element target are required for revalidation.",
      confidence: 0,
      provenance: resolution.provenance,
    }
  }
  return revalidateTarget({
    target,
    input: currentInput,
    ...(options.now === undefined ? {} : { now: options.now }),
  })
}

function retrievalContext(options: ActionResolutionOptions): RetrievalContext {
  return {
    ...(options.activeWindowId === undefined ? {} : { activeWindowId: options.activeWindowId }),
    ...(options.activeElementId === undefined ? {} : { activeElementId: options.activeElementId }),
    ...options.context,
  }
}

function hasSemanticSelector(intent: ActionIntent): boolean {
  return intent.query !== undefined || intent.role !== undefined || intent.name !== undefined || intent.description !== undefined || intent.value !== undefined || intent.filters?.query !== undefined || intent.filters?.role !== undefined || intent.filters?.name !== undefined || intent.filters?.description !== undefined || intent.filters?.value !== undefined
}

function normalizeIntent(input: ActionIntent | ComputerAction): ActionIntent {
  const intent = input as ActionIntent
  const nested = isRecord(intent.input) ? intent.input : isRecord(intent.parameters) ? intent.parameters : undefined
  if (nested === undefined) return intent
  return {
    ...intent,
    ...(intent.type === undefined && typeof nested.type === "string" ? { type: nested.type } : {}),
    ...(intent.action === undefined && typeof nested.action === "string" ? { action: nested.action } : {}),
    ...(intent.target === undefined && nested.target !== undefined ? { target: nested.target as ActionTargetInput } : {}),
    ...(intent.query === undefined && typeof nested.query === "string" ? { query: nested.query } : {}),
    ...(intent.role === undefined && typeof nested.role === "string" ? { role: nested.role } : {}),
    ...(intent.name === undefined && typeof nested.name === "string" ? { name: nested.name } : {}),
    ...(intent.description === undefined && typeof nested.description === "string" ? { description: nested.description } : {}),
    ...(intent.value === undefined && isJsonValue(nested.value) ? { value: nested.value } : {}),
    ...(intent.text === undefined && typeof nested.text === "string" ? { text: nested.text } : {}),
    ...(intent.key === undefined && typeof nested.key === "string" ? { key: nested.key } : {}),
    ...(intent.keys === undefined && typeof nested.keys === "string" ? { keys: nested.keys } : {}),
    ...(intent.elementId === undefined && typeof nested.elementId === "string" ? { elementId: nested.elementId } : {}),
    ...(intent.applicationId === undefined && typeof nested.applicationId === "string" ? { applicationId: nested.applicationId } : {}),
    ...(intent.url === undefined && typeof nested.url === "string" ? { url: nested.url } : {}),
    ...(intent.path === undefined && typeof nested.path === "string" ? { path: nested.path } : {}),
    // Nested input/parameters payloads used to lose these fields, so a
    // click(type: "click", input: { count: 2 }) silently degraded to a
    // single click and drags lost their from/to endpoints.
    ...(intent.modifiers === undefined && isModifierArray(nested.modifiers) ? { modifiers: nested.modifiers } : {}),
    ...(intent.button === undefined && (nested.button === "left" || nested.button === "right" || nested.button === "middle") ? { button: nested.button } : {}),
    ...(intent.count === undefined && Number.isFinite(nested.count) ? { count: nested.count as number } : {}),
    ...(intent.from === undefined && isComputerTarget(nested.from) ? { from: nested.from } : {}),
    ...(intent.to === undefined && isComputerTarget(nested.to) ? { to: nested.to } : {}),
    ...(intent.direction === undefined &&
    (nested.direction === "up" || nested.direction === "down" || nested.direction === "left" || nested.direction === "right")
      ? { direction: nested.direction }
      : {}),
    ...(intent.amount === undefined && Number.isFinite(nested.amount) ? { amount: nested.amount as number } : {}),
    ...(intent.deltaX === undefined && Number.isFinite(nested.deltaX) ? { deltaX: nested.deltaX as number } : {}),
    ...(intent.deltaY === undefined && Number.isFinite(nested.deltaY) ? { deltaY: nested.deltaY as number } : {}),
    ...(intent.durationMs === undefined && Number.isFinite(nested.durationMs) ? { durationMs: nested.durationMs as number } : {}),
    ...(intent.ms === undefined && Number.isFinite(nested.ms) ? { ms: nested.ms as number } : {}),
    ...(intent.condition === undefined && typeof nested.condition === "string" ? { condition: nested.condition } : {}),
    ...(intent.include === undefined && isStringArray(nested.include) ? { include: nested.include } : {}),
  }
}

function isModifierArray(value: unknown): value is readonly ("alt" | "control" | "meta" | "shift")[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => entry === "alt" || entry === "control" || entry === "meta" || entry === "shift")
  )
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
}

function resolveActionTarget(
  intent: ActionIntent,
  type: ActionType,
  sourceInput: RetrievalInput | undefined,
  options: ActionResolutionOptions,
): TargetResolution {
  const descriptor = semanticDescriptor(intent.target)
  const directTarget = directComputerTarget(intent.target)
  if (directTarget !== undefined) return resolvedTarget(directTarget, directTarget.kind === "element" ? directTarget.reference : undefined, [], 1)
  const directReference = descriptor === undefined ? directElementReference(intent.target) : undefined
  if (directReference !== undefined) {
    const id = directReference.elementId ?? directReference.id
    if (id === undefined) return unresolved("not-found", "The target reference has no element identifier.")
    return resolvedTarget({ kind: "element", elementId: id, reference: directReference }, directReference, [], 1)
  }
  const directMatch = retrievalMatch(intent.target)
  if (directMatch !== undefined) {
    const target = toComputerTarget(directMatch, options.observation)
    return target === undefined ? unresolved("not-found", "The candidate has no usable element identifier.") : resolvedTarget(target, target.kind === "element" ? target.reference : undefined, [directMatch], directMatch.confidence)
  }
  if (intent.elementId !== undefined) {
    const reference = referenceFromId(intent.elementId, options.observation?.id, intent)
    return resolvedTarget({ kind: "element", elementId: intent.elementId, reference }, reference, [], 0.8)
  }
  if (type === "read" && intent.target === undefined && !hasSemanticSelector(intent)) return resolvedTarget(undefined, undefined, [], 1)
  const semanticTargetRequested = intent.target !== undefined && !["observe", "screenshot", "find", "launch", "open", "wait", "paste"].includes(type)
  if (!requiresElementTarget(type) && type !== "read" && !semanticTargetRequested) return resolvedTarget(undefined, undefined, [], 1)
  const query = intent.query ?? descriptor?.query ?? (typeof intent.target === "string" ? intent.target : "")
  const request = buildRetrievalRequest(intent, descriptor, query, options)
  if (sourceInput === undefined) return unresolved("not-found", "No observation was supplied for semantic target resolution.")
  const retrieval = retrieveElements(sourceInput, request)
  const decision = disambiguateCandidates(retrieval, {
    context: retrievalContext(options),
    mutating: requiresElementTarget(type) || type === "scroll",
    ...(options.minimumConfidence === undefined ? {} : { minimumConfidence: options.minimumConfidence }),
    ...(options.minConfidence === undefined ? {} : { minConfidence: options.minConfidence }),
    ...(options.minimumMargin === undefined ? {} : { minimumMargin: options.minimumMargin }),
    ...(options.minMargin === undefined ? {} : { minMargin: options.minMargin }),
  })
  if (decision.status !== "resolved" || decision.selected === undefined) {
    return {
      resolutionStatus: decision.status === "not-found" ? "not-found" : "ambiguous",
      target: undefined,
      reference: undefined,
      candidates: decision.candidates,
      match: undefined,
      confidence: decision.confidence,
      provenance: decision.provenance,
      resolution: failureResolution(
        decision.status === "not-found" ? "target_not_found" : "ambiguous_target",
        decision.status === "not-found" ? "No semantic target matched the request." : "Multiple semantic targets require disambiguation.",
        decision.candidates,
        decision.confidence,
        decision.provenance,
        options.observation,
      ),
    }
  }
  const target = toComputerTarget(decision.selected, options.observation)
  if (target === undefined) return unresolved("not-found", "The selected candidate has no usable element identifier.", decision.candidates, decision.confidence, decision.provenance)
  return resolvedTarget(target, target.kind === "element" ? target.reference : undefined, decision.candidates, decision.confidence, decision.match)
}

function buildRetrievalRequest(
  intent: ActionIntent,
  descriptor: SemanticDescriptor | undefined,
  query: string,
  options: ActionResolutionOptions,
): SemanticRetrievalRequest {
  const supplied: SemanticRetrievalRequest = intent.request ?? intent.filters ?? options.request ?? { query: "" }
  const role = intent.role ?? supplied.role ?? descriptor?.role
  const name = intent.name ?? supplied.name ?? descriptor?.name
  const description = intent.description ?? supplied.description ?? descriptor?.description
  const value = intent.value ?? supplied.value ?? descriptor?.value
  return {
    ...supplied,
    query: supplied.query || query || descriptor?.elementId || "",
    ...(role === undefined ? {} : { role }),
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    ...(value === undefined ? {} : { value }),
    context: retrievalContext(options),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  }
}

function buildAction(intent: ActionIntent, type: ActionType, target: ComputerTarget | undefined): ComputerAction | undefined {
  const base: Record<string, unknown> = {
    type,
    ...(intent.id === undefined ? {} : { id: intent.id }),
    ...(intent.actionId === undefined ? {} : { actionId: intent.actionId }),
    ...(target === undefined ? {} : { target }),
    ...(intent.source === undefined ? {} : { source: intent.source }),
    ...(intent.backend === undefined ? {} : { backend: intent.backend }),
    ...(intent.scope === undefined ? {} : { scope: intent.scope }),
    ...(intent.approval === undefined ? {} : { approval: intent.approval }),
    ...(intent.timeoutMs === undefined ? {} : { timeoutMs: intent.timeoutMs }),
    ...(intent.metadata === undefined || !isMetadata(intent.metadata) ? {} : { metadata: intent.metadata }),
    ...(intent.provenance === undefined ? {} : { provenance: intent.provenance }),
  }
  const action = addActionParameters(base, intent, type, target)
  return action !== undefined && isComputerAction(action) ? action : undefined
}

function addActionParameters(
  base: Record<string, unknown>,
  intent: ActionIntent,
  type: ActionType,
  target: ComputerTarget | undefined,
): Record<string, unknown> | undefined {
  if (type === "observe") return { ...base, ...(intent.include === undefined ? {} : { include: intent.include }), ...(intent.applicationId === undefined ? {} : { applicationId: intent.applicationId }) }
  if (type === "screenshot") return { ...base, ...(isRecord(intent.region) ? { region: intent.region } : {}), ...(typeof intent.includeCursor === "boolean" ? { includeCursor: intent.includeCursor } : {}) }
  if (type === "click") return { ...base, ...(intent.button === undefined ? {} : { button: intent.button }), ...(intent.count === undefined ? {} : { count: intent.count }), ...(intent.modifiers === undefined ? {} : { modifiers: intent.modifiers }) }
  if (type === "doubleclick" || type === "rightclick") return { ...base, ...(intent.button === undefined ? {} : { button: intent.button }), ...(intent.modifiers === undefined ? {} : { modifiers: intent.modifiers }) }
  if (type === "longpress") return { ...base, ...(intent.durationMs === undefined ? {} : { durationMs: intent.durationMs }) }
  if (type === "move" || type === "focus" || type === "toggle" || type === "expand" || type === "collapse" || type === "dismiss") return base
  if (type === "drag") {
    if (intent.from === undefined || intent.to === undefined) return undefined
    return { ...base, from: intent.from, to: intent.to, ...(intent.button === undefined ? {} : { button: intent.button }), ...(intent.durationMs === undefined ? {} : { durationMs: intent.durationMs }) }
  }
  if (type === "type") {
    if (typeof intent.text !== "string") return undefined
    return { ...base, text: intent.text, ...(intent.value === undefined ? {} : { value: intent.value }) }
  }
  if (type === "setvalue") {
    if (intent.value === undefined || !isJsonValue(intent.value)) return undefined
    return { ...base, value: intent.value }
  }
  if (type === "key") {
    const key = intent.key ?? intent.keys
    if (typeof key !== "string") return undefined
    return { ...base, key, ...(intent.modifiers === undefined ? {} : { modifiers: intent.modifiers }) }
  }
  if (type === "keypress") {
    if (typeof intent.key !== "string") return undefined
    return { ...base, key: intent.key, ...(intent.modifiers === undefined ? {} : { modifiers: intent.modifiers }) }
  }
  if (type === "press" || type === "press_keys") {
    if (typeof intent.keys !== "string") return undefined
    return { ...base, keys: intent.keys }
  }
  if (type === "scroll") return { ...base, ...(intent.direction === undefined ? {} : { direction: intent.direction }), ...(intent.deltaX === undefined ? {} : { deltaX: intent.deltaX }), ...(intent.deltaY === undefined ? {} : { deltaY: intent.deltaY }), ...(intent.amount === undefined ? {} : { amount: intent.amount }) }
  if (type === "select") return { ...base, ...(intent.value === undefined ? {} : { value: intent.value }) }
  if (type === "increment" || type === "decrement") return { ...base, ...(intent.amount === undefined ? {} : { amount: intent.amount }) }
  if (type === "wait") return { ...base, ...(intent.ms === undefined ? {} : { ms: intent.ms }), ...(intent.condition === undefined ? {} : { condition: intent.condition }) }
  if (type === "find") {
    const request = intent.request ?? intent.filters ?? (intent.query === undefined ? undefined : { query: intent.query })
    return request === undefined ? undefined : { ...base, request }
  }
  if (type === "read") return { ...base, ...(target === undefined ? {} : { target }) }
  if (type === "launch") {
    const targetRecord = isRecord(intent.target) ? intent.target : undefined
    const applicationId = intent.applicationId ?? intent.application ?? (typeof targetRecord?.applicationId === "string" ? targetRecord.applicationId : undefined)
    return applicationId === undefined ? undefined : { ...base, applicationId }
  }
  if (type === "open") {
    const targetRecord = isRecord(intent.target) ? intent.target : undefined
    const openTarget = typeof intent.target === "string"
      ? intent.target
      : intent.url ?? intent.path ?? (typeof targetRecord?.url === "string" ? targetRecord.url : typeof targetRecord?.path === "string" ? targetRecord.path : undefined)
    return typeof openTarget === "string" ? { ...base, target: openTarget } : undefined
  }
  if (type === "close" || type === "copy") return { ...base, ...(target === undefined ? {} : { target }) }
  if (type === "paste") return typeof intent.text === "string" ? { ...base, text: intent.text } : undefined
  return base
}

function verificationForResult(options: ActionExecutionOptions, result: ActionResult): Verification | undefined {
  if (options.verify !== true) return undefined
  const request = options.verification
  if (request === undefined) return undefined
  const actual = request.actual ?? verificationValue(request.kind, result)
  return verify(actual === undefined ? request : { ...request, actual })
}

function verificationValue(kind: string, result: ActionResult): unknown {
  if (kind === "text") return result.observation?.text ?? result.metadata?.text
  if (kind === "value") return result.observation?.value ?? result.metadata?.value
  if (kind === "window") return result.observation?.metadata?.activeWindowId ?? result.observation?.metadata?.windowId ?? result.metadata?.window ?? result.metadata?.activeWindowId ?? result.metadata?.windowId
  if (kind === "file") return result.observation?.metadata?.file ?? result.metadata?.file
  if (kind === "control") return result.metadata?.control
  if (kind === "url") return result.metadata?.url
  return result.metadata?.state
}

function withResult(resolution: ActionResolution, result: ActionResult, verification?: Verification): ActionResolution {
  const code = typeof result.error === "object" && result.error !== null ? result.error.code : undefined
  // A failed execution must not keep resolutionStatus "resolved"; callers use
  // it to distinguish a resolved-but-failed action from a successful one.
  const failedStatus: ActionResolutionStatus =
    result.status === "unavailable" || code === "unavailable" ? "unavailable" : "failed"
  return {
    ...resolution,
    success: result.success,
    status: result.status ?? (result.success ? "success" : "failed"),
    resolutionStatus: result.success ? resolution.resolutionStatus : failedStatus,
    result,
    ...(verification === undefined ? {} : { verification }),
  }
}

function resolutionTargetFailure(resolution: ActionResolution, options: ActionResolutionOptions): string | undefined {
  if (options.deferRevalidation === true) return undefined
  const target = resolution.target
  if (target?.kind !== "element") return undefined
  const callback = options.revalidate ?? options.revalidateTarget
  if (callback !== undefined) {
    try {
      const value = callback(target)
      if (isPromiseLike(value)) return undefined
      const normalized = callbackResult(value)
      if (!normalized.valid) return normalized.reason ?? "The action target is stale."
    } catch (error) {
      return error instanceof Error ? error.message : "The action target revalidation failed."
    }
  }
  const currentInput = options.input ?? options.observation ?? options.elements
  if (currentInput === undefined) return undefined
  const result = revalidateTarget({
    target,
    input: currentInput,
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  return result.valid ? undefined : result.reason
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return typeof value === "object" && value !== null && "then" in value && typeof value.then === "function"
}

async function revalidateExecutionTarget(
  resolution: ActionResolution,
  target: ComputerTarget | undefined,
  options: ActionExecutionOptions,
): Promise<ActionResolution | undefined> {
  if (target?.kind !== "element") return undefined
  const callback = options.revalidate ?? options.revalidateTarget
  if (callback !== undefined) {
    try {
      const value = await callback(target)
      const normalized = callbackResult(value)
      if (normalized.valid) return normalized.target === undefined ? undefined : withTargetResolution(resolution, normalized.target)
      return { ...withResult(resolution, createActionFailure("target_stale", normalized.reason ?? "The action target is stale.", { actionId: resolution.result.actionId })), resolutionStatus: "stale" }
    } catch (error) {
      const message = error instanceof Error ? error.message : "The action target revalidation failed."
      return { ...withResult(resolution, createActionFailure("target_stale", message, { actionId: resolution.result.actionId })), resolutionStatus: "stale" }
    }
  }
  const currentInput = options.input ?? options.observation ?? options.elements
  if (currentInput === undefined) return undefined
  const result = revalidateTarget({
    target,
    input: currentInput,
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  if (result.valid) return result.reference === undefined ? undefined : withTargetResolution(resolution, { kind: "element", elementId: target.elementId, reference: result.reference })
  return { ...withResult(resolution, createActionFailure("target_stale", result.reason, { actionId: resolution.result.actionId })), resolutionStatus: "stale" }
}

function callbackResult(value: TargetRevalidationValue): { readonly valid: boolean; readonly reason?: string; readonly target?: ComputerTarget } {
  if (typeof value === "boolean") return { valid: value }
  if (isComputerTarget(value) && "reference" in value && value.reference !== undefined) return { valid: true, target: value }
  if (isElementReference(value)) return { valid: true, target: referenceTarget(value) }
  if (isComputerTarget(value)) return { valid: true, target: value }
  if (isUIElement(value)) {
    const target = elementTarget(value)
    return target === undefined ? { valid: true } : { valid: true, target }
  }
  if (typeof value !== "object" || value === null) return { valid: false }
  if (value.valid !== undefined) {
    if (!value.valid) return { valid: false, ...(value.reason === undefined ? {} : { reason: value.reason }) }
    if (value.target !== undefined) return { valid: true, ...(isComputerTarget(value.target) ? { target: value.target } : isElementReference(value.target) ? { target: referenceTarget(value.target) } : {}) }
    if (value.reference !== undefined) return { valid: true, target: referenceTarget(value.reference) }
    return { valid: true }
  }
  if (value.status !== undefined) return { valid: value.status === "valid", ...(value.reason === undefined ? {} : { reason: value.reason }) }
  if (value.target !== undefined) return { valid: true, ...(isComputerTarget(value.target) ? { target: value.target } : isElementReference(value.target) ? { target: referenceTarget(value.target) } : {}) }
  if (value.reference !== undefined) return { valid: true, target: referenceTarget(value.reference) }
  return { valid: false, reason: "The target revalidation callback returned an invalid result." }
}

function referenceTarget(reference: ElementReference): ComputerTarget {
  const id = reference.elementId ?? reference.id ?? ""
  return { kind: "element", elementId: id, reference }
}

function elementTarget(element: UIElement): ComputerTarget | undefined {
  const id = element.id ?? element.reference?.elementId ?? element.reference?.id
  return id === undefined ? undefined : { kind: "element", elementId: id, ...(element.reference === undefined ? {} : { reference: element.reference }) }
}

function withTargetResolution(resolution: ActionResolution, target: ComputerTarget): ActionResolution {
  if (target.kind !== "element") return resolution
  const action = resolution.action
  const updatedAction = action === undefined || action.type === "open" || !isComputerAction({ ...action, target })
    ? action
    : { ...action, target }
  return {
    ...resolution,
    ...(updatedAction === undefined ? {} : { action: updatedAction }),
    target,
    ...(target.reference === undefined ? {} : { reference: target.reference }),
  }
}

function driverExecutor(driver: ActionDriver | undefined): ActionExecutor | undefined {
  const execute = driver?.execute ?? driver?.act
  return execute === undefined ? undefined : (action) => execute(action)
}

function failureResolution(
  code: string,
  message: string,
  candidates: readonly RetrievalMatch[],
  confidence: number,
  provenance: Provenance,
  observation: Observation | undefined,
): ActionResolution {
  const result = createActionFailure(code, message, {
    metadata: {
      ...(observation?.id === undefined ? {} : { observationId: observation.id }),
      candidateCount: candidates.length,
      confidence,
    },
  })
  return {
    success: false,
    status: result.status ?? "failed",
    resolutionStatus: code === "ambiguous_target" ? "ambiguous" : code === "unavailable" ? "unavailable" : "not-found",
    candidates,
    rankedBackends: [],
    confidence,
    provenance,
    result,
    error: result.error,
    message,
  }
}

function invalidResolution(message: string, intent: ActionIntent): ActionResolution {
  const result = createActionFailure("invalid_action", message, {
    ...(intent.actionId === undefined ? {} : { actionId: intent.actionId }),
  })
  return {
    success: false,
    status: result.status ?? "failed",
    resolutionStatus: "invalid",
    candidates: [],
    rankedBackends: [],
    confidence: 0,
    provenance: intent.provenance ?? fallbackProvenance(undefined),
    result,
    error: result.error,
    message,
  }
}

function unresolved(
  status: ActionResolutionStatus,
  message: string,
  candidates: readonly RetrievalMatch[] = [],
  confidence = 0,
  provenance: Provenance = fallbackProvenance(undefined),
): TargetResolution {
  return {
    resolutionStatus: status,
    target: undefined,
    reference: undefined,
    candidates,
    match: undefined,
    confidence,
    provenance,
    resolution: failureResolution(status === "ambiguous" ? "ambiguous_target" : status === "unavailable" ? "unavailable" : "target_not_found", message, candidates, confidence, provenance, undefined),
  }
}

function resolvedTarget(
  target: ComputerTarget | undefined,
  reference: ElementReference | undefined,
  candidates: readonly RetrievalMatch[],
  confidence: number,
  match?: RetrievalMatch,
): TargetResolution {
  return {
    resolutionStatus: "resolved",
    target,
    reference,
    candidates,
    match,
    confidence,
    provenance: match?.provenance ?? fallbackProvenance(undefined),
    resolution: undefined,
  }
}

function actionMetadata(target: TargetResolution, backendCount: number, confidence: number, provenance: Provenance): import("../protocol").Metadata | undefined {
  const values: Record<string, JsonValue> = {}
  if (target.reference?.observationId !== undefined) values.observationId = target.reference.observationId
  if (target.reference?.generation !== undefined) values.generation = target.reference.generation
  if (target.target?.kind === "element") values.targetId = target.target.elementId
  values.confidence = confidence
  values.provenanceSource = provenance.source
  if (backendCount > 0) values.backendCandidates = backendCount
  return Object.keys(values).length === 0 ? undefined : values
}

function referenceFromElement(element: UIElement, observationId: string | undefined, intent?: ActionIntent): ElementReference {
  return {
    kind: "element",
    elementId: element.id ?? element.reference?.elementId ?? element.reference?.id ?? "",
    ...(observationId === undefined ? {} : { observationId }),
    ...(element.source === undefined ? {} : { source: element.source }),
    ...(element.backend === undefined ? {} : { backend: element.backend }),
    ...(element.role === undefined ? {} : { role: element.role }),
    ...(intent?.metadata === undefined || !isMetadata(intent.metadata) ? {} : { metadata: intent.metadata }),
  }
}

function referenceFromId(id: string, observationId: string | undefined, intent: ActionIntent): ElementReference {
  return {
    kind: "element",
    elementId: id,
    ...(observationId === undefined ? {} : { observationId }),
    ...(intent.source === undefined ? {} : { source: intent.source }),
    ...(intent.backend === undefined ? {} : { backend: intent.backend }),
  }
}

function directComputerTarget(value: unknown): ComputerTarget | undefined {
  return isComputerTarget(value) ? value : undefined
}

function directElementReference(value: unknown): ElementReference | undefined {
  return isElementReference(value) ? value : undefined
}

function retrievalMatch(value: unknown): RetrievalMatch | undefined {
  if (typeof value !== "object" || value === null || !("element" in value) || !("confidence" in value)) return undefined
  if (!isUIElement((value as { readonly element: unknown }).element)) return undefined
  return value as RetrievalMatch
}

interface SemanticDescriptor {
  readonly query?: string
  readonly role?: string
  readonly name?: string
  readonly description?: string
  readonly value?: JsonValue
  readonly elementId?: string
}

function semanticDescriptor(value: unknown): SemanticDescriptor | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const hasSelector = "query" in record || "name" in record || "description" in record || "value" in record
  if (!hasSelector && ("kind" in record || "elementId" in record || "id" in record)) return undefined
  if (!hasSelector && !("role" in record)) return undefined
  return {
    ...(typeof record.query === "string" ? { query: record.query } : {}),
    ...(typeof record.role === "string" ? { role: record.role } : {}),
    ...(typeof record.name === "string" ? { name: record.name } : {}),
    ...(typeof record.description === "string" ? { description: record.description } : {}),
    ...(isJsonValue(record.value) ? { value: record.value } : {}),
    ...(typeof record.elementId === "string" ? { elementId: record.elementId } : {}),
  }
}

function fallbackProvenance(observation: Observation | undefined): Provenance {
  return observation?.provenance ?? { source: "retrieved", trust: "untrusted", authority: "none" }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

interface TargetResolution {
  readonly resolutionStatus: ActionResolutionStatus
  readonly target?: ComputerTarget
  readonly reference?: ElementReference
  readonly candidates: readonly RetrievalMatch[]
  readonly match?: RetrievalMatch
  readonly confidence: number
  readonly provenance: Provenance
  readonly resolution?: ActionResolution
}
