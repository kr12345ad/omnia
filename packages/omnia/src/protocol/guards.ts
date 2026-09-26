import type {
  ActionDescriptor,
  ActionError,
  ActionResult,
  ActionType,
  AgentEvent,
  ApprovalDecision,
  ApprovalDecisionValue,
  Backend,
  Bounds,
  Capability,
  CapabilityState,
  CapabilitySupport,
  ComputerAction,
  ComputerDriver,
  ComputerEvent,
  ComputerInfo,
  ComputerProvider,
  ComputerTarget,
  ElementAttributes,
  ElementReference,
  Environment,
  FindMatch,
  FindRequest,
  FindResult,
  InstructionAuthority,
  JsonObject,
  JsonValue,
  Limitation,
  Metadata,
  ModelEvent,
  Observation,
  ProtocolEvent,
  PermissionRequirement,
  PermissionScope,
  Point,
  Provenance,
  ProvenanceSource,
  Role,
  Screen,
  Screenshot,
  Source,
  State,
  TrustLevel,
  UIElement,
  Verification,
  VerificationEvidence,
  VerificationStatus,
} from "./types.js"
import {
  ACTION_RESULT_STATUSES,
  ACTION_TYPES,
  AGENT_EVENT_TYPES,
  APPROVAL_DECISIONS,
  CAPABILITY_STATES,
  COMPUTER_EVENT_TYPES,
  INSTRUCTION_AUTHORITIES,
  MODEL_EVENT_TYPES,
  MODIFIERS,
  MOUSE_BUTTONS,
  PERMISSION_SCOPES,
  ROLES,
  SCROLL_DIRECTIONS,
  SOURCES,
  STATES,
  TRUST_LEVELS,
  VERIFICATION_STATUSES,
} from "./types.js"

export function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export const isPlainRecord = isRecord

export function isJsonValue(value: unknown): value is JsonValue {
  return isJsonValueInternal(value, new Set<object>())
}

export function isJsonObject(value: unknown): value is JsonObject {
  if (!isRecord(value)) return false
  return Object.values(value).every((item) => isJsonValue(item))
}

export function isMetadata(value: unknown): value is Metadata {
  return isJsonObject(value)
}

export function isKnownRole(value: unknown): value is (typeof ROLES)[number] {
  return typeof value === "string" && ROLES.some((role) => role === value)
}

export function isRole(value: unknown): value is Role {
  return isNonEmptyString(value)
}

export function isKnownSource(value: unknown): value is (typeof SOURCES)[number] {
  return typeof value === "string" && SOURCES.some((source) => source === value)
}

export function isSource(value: unknown): value is Source {
  return isNonEmptyString(value)
}

export function isBackend(value: unknown): value is Backend {
  return isNonEmptyString(value)
}

export function isState(value: unknown): value is State {
  return typeof value === "string" && STATES.some((state) => state === value)
}

export function isActionType(value: unknown): value is ActionType {
  return typeof value === "string" && ACTION_TYPES.some((action) => action === value)
}

export function isCapabilityState(value: unknown): value is CapabilityState {
  return typeof value === "string" && CAPABILITY_STATES.some((state) => state === value)
}

export function isTrustLevel(value: unknown): value is TrustLevel {
  return typeof value === "string" && TRUST_LEVELS.some((level) => level === value)
}

export function isProvenanceSource(value: unknown): value is ProvenanceSource {
  return isNonEmptyString(value)
}

export function isInstructionAuthority(value: unknown): value is InstructionAuthority {
  return typeof value === "string" && INSTRUCTION_AUTHORITIES.some((authority) => authority === value)
}

export function isPoint(value: unknown): value is Point {
  if (!isRecord(value)) return false
  return isFiniteNumber(value.x) && isFiniteNumber(value.y)
}

export function isBounds(value: unknown): value is Bounds {
  if (!isRecord(value)) return false
  return (
    isFiniteNumber(value.x) &&
    isFiniteNumber(value.y) &&
    isFiniteNumber(value.width) &&
    isFiniteNumber(value.height) &&
    value.width >= 0 &&
    value.height >= 0
  )
}

export function isScreen(value: unknown): value is Screen {
  if (!isRecord(value)) return false
  if (!isFiniteNumber(value.width) || !isFiniteNumber(value.height) || value.width < 0 || value.height < 0) return false
  if (value.scale !== undefined && (!isFiniteNumber(value.scale) || value.scale <= 0)) return false
  if (
    value.rotation !== undefined &&
    value.rotation !== 0 &&
    value.rotation !== 90 &&
    value.rotation !== 180 &&
    value.rotation !== 270
  ) {
    return false
  }
  return value.primary === undefined || typeof value.primary === "boolean"
}

export function isElementReference(value: unknown): value is ElementReference {
  if (!isRecord(value)) return false
  const hasElementId = isNonEmptyString(value.elementId)
  const hasId = isNonEmptyString(value.id)
  if (!hasElementId && !hasId) return false
  return (
    (value.kind === undefined || value.kind === "element") &&
    optionalString(value, "observationId") &&
    optionalNumber(value, "generation") &&
    optionalSource(value, "source") &&
    optionalBackend(value, "backend") &&
    optionalRole(value, "role") &&
    optionalJson(value, "locator") &&
    optionalNumber(value, "expiresAt") &&
    optionalMetadata(value, "metadata")
  )
}

export function isElementAttributes(value: unknown): value is ElementAttributes {
  if (!isRecord(value)) return false
  return (
    optionalNumber(value, "level") &&
    optionalNumber(value, "valueMin") &&
    optionalNumber(value, "valueMax") &&
    optionalNumber(value, "valueNow") &&
    optionalOrientation(value, "orientation") &&
    optionalNumber(value, "rowIndex") &&
    optionalNumber(value, "colIndex") &&
    optionalNumber(value, "rowCount") &&
    optionalNumber(value, "colCount") &&
    optionalNumber(value, "posInSet") &&
    optionalNumber(value, "setSize") &&
    optionalString(value, "placeholder") &&
    optionalString(value, "url") &&
    optionalLive(value, "live") &&
    optionalAutocomplete(value, "autocomplete") &&
    optionalString(value, "keyShortcut") &&
    optionalString(value, "roledescription") &&
    Object.values(value).every((item) => item === undefined || isJsonValue(item))
  )
}

export function isUIElement(value: unknown): value is UIElement {
  return isUIElementInternal(value, new Set<object>())
}

export function isActionDescriptor(value: unknown): value is ActionDescriptor {
  if (!isRecord(value)) return false
  const action = value.action
  const type = value.type
  if (!isActionType(action) && !isActionType(type)) return false
  if (isActionType(action) && isActionType(type) && action !== type) return false
  return (
    optionalString(value, "name") &&
    optionalString(value, "label") &&
    optionalString(value, "description") &&
    optionalTarget(value, "target") &&
    optionalJson(value, "input") &&
    optionalJsonObject(value, "parameters") &&
    optionalBoolean(value, "required") &&
    optionalBoolean(value, "enabled") &&
    optionalBoolean(value, "requiresApproval") &&
    optionalPermissionScope(value, "permissionScope") &&
    optionalCapabilityState(value, "capability") &&
    optionalCapabilityState(value, "state") &&
    optionalMetadata(value, "metadata")
  )
}

export function isComputerTarget(value: unknown): value is ComputerTarget {
  if (!isRecord(value)) return false
  if (value.kind === "point") return isFiniteNumber(value.x) && isFiniteNumber(value.y)
  if (value.kind === "element") return isNonEmptyString(value.elementId) && optionalElementReference(value, "reference")
  if (value.kind === "application") return isNonEmptyString(value.applicationId)
  return false
}

export function isComputerAction(value: unknown): value is ComputerAction {
  if (!isRecord(value) || !isActionType(value.type)) return false
  if (!isActionBase(value)) return false
  switch (value.type) {
    case "observe":
      return optionalString(value, "applicationId") && optionalStringArray(value, "include")
    case "screenshot":
      return optionalBounds(value, "region") && optionalBoolean(value, "includeCursor")
    case "click":
      return (
        hasTarget(value) &&
        optionalMouseButton(value, "button") &&
        optionalCount(value, "count") &&
        optionalModifiers(value, "modifiers")
      )
    case "doubleclick":
    case "rightclick":
      return hasTarget(value) && optionalMouseButton(value, "button") && optionalModifiers(value, "modifiers")
    case "longpress":
      return hasTarget(value) && optionalNonNegativeNumber(value, "durationMs")
    case "move":
      return hasTarget(value)
    case "drag":
      return (
        isComputerTarget(value.from) &&
        isComputerTarget(value.to) &&
        optionalMouseButton(value, "button") &&
        optionalNonNegativeNumber(value, "durationMs")
      )
    case "type":
      return typeof value.text === "string" && optionalTarget(value, "target") && optionalString(value, "value")
    case "setvalue":
      return hasTarget(value) && Object.hasOwn(value, "value") && isJsonValue(value.value)
    case "key":
      return (typeof value.key === "string" || typeof value.keys === "string") && optionalModifiers(value, "modifiers")
    case "keypress":
      return typeof value.key === "string" && optionalModifiers(value, "modifiers")
    case "press":
    case "press_keys":
      return typeof value.keys === "string"
    case "scroll":
      return (
        optionalTarget(value, "target") &&
        optionalDirection(value, "direction") &&
        optionalFiniteNumber(value, "deltaX") &&
        optionalFiniteNumber(value, "deltaY") &&
        optionalFiniteNumber(value, "amount")
      )
    case "focus":
    case "toggle":
    case "expand":
    case "collapse":
    case "dismiss":
      return hasTarget(value)
    case "select":
      return hasTarget(value) && optionalJson(value, "value")
    case "increment":
    case "decrement":
      return hasTarget(value) && optionalFiniteNumber(value, "amount")
    case "wait":
      return (
        (value.ms === undefined || (isFiniteNumber(value.ms) && value.ms >= 0)) &&
        (value.condition === undefined || typeof value.condition === "string")
      )
    case "find":
      return isFindRequest(value.request)
    case "read":
      return optionalTarget(value, "target")
    case "launch":
      return typeof value.applicationId === "string"
    case "open":
      return typeof value.target === "string"
    case "close":
    case "copy":
      return optionalTarget(value, "target")
    case "paste":
      return typeof value.text === "string"
  }
  return false
}

export function isFindRequest(value: unknown): value is FindRequest {
  if (!isRecord(value)) return false
  return (
    typeof value.query === "string" &&
    optionalRole(value, "role") &&
    optionalString(value, "name") &&
    optionalSource(value, "source") &&
    optionalBackend(value, "backend") &&
    optionalLimit(value, "limit") &&
    optionalBoolean(value, "includeOffscreen") &&
    optionalString(value, "observationId") &&
    optionalMetadata(value, "metadata")
  )
}

export function isFindMatch(value: unknown): value is FindMatch {
  if (!isRecord(value)) return false
  return (
    isUIElement(value.element) &&
    isFiniteNumber(value.score) &&
    optionalElementReference(value, "reference") &&
    optionalString(value, "reason")
  )
}

export function isFindResult(value: unknown): value is FindResult {
  if (!isRecord(value)) return false
  const hasMatches = Object.hasOwn(value, "matches") || Object.hasOwn(value, "results")
  const hasElements = Object.hasOwn(value, "elements")
  const hasReferences = Object.hasOwn(value, "references")
  if (!hasMatches && !hasElements && !hasReferences) return false
  return (
    optionalString(value, "query") &&
    optionalArray(value, "matches", isFindMatch) &&
    optionalArray(value, "results", isFindMatch) &&
    optionalArray(value, "elements", isUIElement) &&
    optionalArray(value, "references", isElementReference) &&
    optionalObservation(value, "observation") &&
    optionalBoolean(value, "truncated") &&
    optionalMetadata(value, "metadata")
  )
}

export function isCapability(value: unknown): value is Capability {
  if (!isRecord(value) || !isNonEmptyString(value.name)) return false
  return (
    optionalCapabilityState(value, "state") &&
    optionalCapabilityState(value, "status") &&
    optionalString(value, "description") &&
    optionalString(value, "reason") &&
    optionalString(value, "version") &&
    optionalMetadata(value, "metadata")
  )
}

export function isPermissionRequirement(value: unknown): value is PermissionRequirement {
  if (!isRecord(value)) return false
  return (
    isNonEmptyString(value.id) &&
    typeof value.description === "string" &&
    typeof value.status === "string" &&
    ["granted", "denied", "prompt", "restricted", "not-required", "unknown"].some(
      (status) => status === value.status,
    ) &&
    optionalStringArray(value, "capabilities") &&
    optionalBoolean(value, "promptable") &&
    optionalString(value, "reason")
  )
}

export function isLimitation(value: unknown): value is Limitation {
  if (!isRecord(value)) return false
  return (
    isNonEmptyString(value.code) &&
    typeof value.kind === "string" &&
    ["permission", "platform", "display-server", "application", "compatibility", "transient"].some(
      (kind) => kind === value.kind,
    ) &&
    typeof value.severity === "string" &&
    ["info", "warning", "error"].some((severity) => severity === value.severity) &&
    typeof value.message === "string" &&
    optionalStringArray(value, "affects")
  )
}

export function isCapabilitySupport(value: unknown): value is CapabilitySupport {
  if (!isRecord(value) || !isNonEmptyString(value.capability) || !isCapabilityState(value.status)) return false
  return (
    optionalScore(value, "score") &&
    optionalString(value, "reason") &&
    optionalArray(value, "permissions", isPermissionRequirement) &&
    optionalArray(value, "limitations", isLimitation) &&
    optionalMetadata(value, "metadata")
  )
}

export function isComputerInfo(value: unknown): value is ComputerInfo {
  if (!isRecord(value)) return false
  return (
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.name) &&
    isNonEmptyString(value.platform) &&
    optionalString(value, "os") &&
    optionalString(value, "architecture") &&
    optionalString(value, "arch") &&
    optionalBackend(value, "backend") &&
    optionalBoolean(value, "connected") &&
    optionalScreen(value, "screen") &&
    optionalScreen(value, "display") &&
    optionalArray(value, "capabilities", isCapabilitySupport) &&
    optionalMetadata(value, "metadata")
  )
}

export function isEnvironment(value: unknown): value is Environment {
  if (!isRecord(value) || !isNonEmptyString(value.platform)) return false
  return (
    optionalString(value, "id") &&
    optionalString(value, "os") &&
    optionalString(value, "architecture") &&
    optionalString(value, "arch") &&
    optionalBackend(value, "backend") &&
    optionalScreen(value, "display") &&
    optionalString(value, "sessionId") &&
    optionalString(value, "locale") &&
    optionalString(value, "timezone") &&
    optionalBoolean(value, "remote") &&
    optionalCapabilityMap(value, "capabilities") &&
    optionalStringMap(value, "variables") &&
    optionalMetadata(value, "metadata")
  )
}

export function isObservation(value: unknown): value is Observation {
  if (!isRecord(value)) return false
  const known = [
    "id",
    "timestamp",
    "capturedAt",
    "computer",
    "environment",
    "screen",
    "elements",
    "value",
    "text",
    "screenshot",
    "source",
    "backend",
    "capabilities",
    "warnings",
    "provenance",
    "metadata",
    "browser",
  ].some((key) => Object.hasOwn(value, key))
  if (!known) return false
  return (
    optionalString(value, "id") &&
    optionalTimestamp(value, "timestamp") &&
    optionalTimestamp(value, "capturedAt") &&
    optionalComputerInfo(value, "computer") &&
    optionalEnvironment(value, "environment") &&
    optionalScreen(value, "screen") &&
    optionalArray(value, "elements", isUIElement) &&
    optionalJson(value, "value") &&
    optionalString(value, "text") &&
    optionalScreenshot(value, "screenshot") &&
    optionalSource(value, "source") &&
    optionalBackend(value, "backend") &&
    optionalCapabilityMap(value, "capabilities") &&
    optionalStringArray(value, "warnings") &&
    optionalProvenance(value, "provenance") &&
    optionalMetadata(value, "metadata") &&
    (value.browser === undefined || isJsonValue(value.browser))
  )
}

export function isScreenshot(value: unknown): value is Screenshot {
  if (!isRecord(value)) return false
  return (
    optionalString(value, "mediaType") &&
    optionalEncoding(value, "encoding") &&
    optionalString(value, "data") &&
    optionalNonNegativeNumber(value, "width") &&
    optionalNonNegativeNumber(value, "height") &&
    optionalBounds(value, "region") &&
    optionalTimestamp(value, "capturedAt") &&
    optionalMetadata(value, "metadata")
  )
}

export function isPermissionScope(value: unknown): value is PermissionScope {
  if (typeof value === "string") return PERMISSION_SCOPES.some((scope) => scope === value)
  if (!isRecord(value)) return false
  return (
    isNonEmptyString(value.kind) &&
    optionalString(value, "resource") &&
    optionalStringArray(value, "resources") &&
    optionalStringArray(value, "paths") &&
    optionalStringArray(value, "origins") &&
    optionalActionTypeArray(value, "actions") &&
    optionalMetadata(value, "metadata")
  )
}

export function isApprovalDecision(value: unknown): value is ApprovalDecision {
  if (typeof value === "string") return APPROVAL_DECISIONS.some((decision) => decision === value)
  if (!isRecord(value) || !isApprovalDecisionValue(value.decision)) return false
  return (
    (value.type === undefined || value.type === "approval") &&
    optionalString(value, "reason") &&
    optionalString(value, "approvedBy") &&
    optionalTimestamp(value, "expiresAt") &&
    optionalPermissionScope(value, "scope") &&
    optionalMetadata(value, "metadata")
  )
}

export function isProvenance(value: unknown): value is Provenance {
  if (!isRecord(value) || !isProvenanceSource(value.source) || !isTrustLevel(value.trust)) return false
  return (
    optionalInstructionAuthority(value, "authority") &&
    optionalString(value, "origin") &&
    optionalTimestamp(value, "capturedAt") &&
    optionalBackend(value, "backend") &&
    optionalTrustLevel(value, "trustLevel") &&
    optionalMetadata(value, "metadata")
  )
}

export function isVerificationEvidence(value: unknown): value is VerificationEvidence {
  if (!isRecord(value)) return false
  return (
    optionalString(value, "kind") &&
    optionalJson(value, "value") &&
    optionalElementReference(value, "reference") &&
    optionalString(value, "observationId") &&
    optionalMetadata(value, "metadata")
  )
}

export function isVerification(value: unknown): value is Verification {
  if (!isRecord(value) || !isVerificationStatus(value.status)) return false
  return (
    optionalBoolean(value, "passed") &&
    optionalBoolean(value, "verified") &&
    optionalBoolean(value, "ok") &&
    optionalString(value, "method") &&
    optionalJson(value, "expected") &&
    optionalJson(value, "actual") &&
    optionalString(value, "message") &&
    optionalArray(value, "evidence", isVerificationEvidence) &&
    optionalMetadata(value, "metadata")
  )
}

export function isActionError(value: unknown): value is ActionError {
  if (typeof value === "string") return true
  if (!isRecord(value)) return false
  return (
    optionalString(value, "code") &&
    typeof value.message === "string" &&
    optionalBoolean(value, "retryable") &&
    optionalJson(value, "details") &&
    optionalMetadata(value, "metadata")
  )
}

export function isActionResult(value: unknown): value is ActionResult {
  if (!isRecord(value) || typeof value.success !== "boolean") return false
  return (
    optionalString(value, "message") &&
    optionalActionResultStatus(value, "status") &&
    optionalString(value, "actionId") &&
    optionalObservation(value, "observation") &&
    optionalVerification(value, "verification") &&
    optionalActionError(value, "error") &&
    optionalArray(value, "limitations", isLimitation) &&
    optionalMetadata(value, "metadata")
  )
}

export const isStructuredCloneable = isJsonValue
export const isWireValue = isJsonValue
export const isCapabilityStatus = isCapabilityState
export const isComputerObservation = isObservation
export const isComputerResult = isActionResult
export const isSearchRequest = isFindRequest
export const isSearchResult = isFindResult

export function isModelEvent(value: unknown): value is ModelEvent {
  if (!isEventBase(value, MODEL_EVENT_TYPES)) return false
  switch (value.type) {
    case "model.requested":
      return optionalString(value, "model") && optionalJson(value, "input")
    case "model.started":
      return optionalString(value, "model")
    case "model.message":
      return typeof value.role === "string" && isJsonValue(value.content)
    case "model.tool-call":
      return isNonEmptyString(value.callId) && isNonEmptyString(value.name) && isJsonValue(value.input)
    case "model.response":
      return optionalJson(value, "output") && optionalString(value, "finishReason")
    case "model.completed":
      return optionalJson(value, "output")
    case "model.failed":
      return isActionError(value.error)
    case "model.cancelled":
      return optionalString(value, "reason")
  }
  return false
}

export function isAgentEvent(value: unknown): value is AgentEvent {
  if (!isEventBase(value, AGENT_EVENT_TYPES)) return false
  switch (value.type) {
    case "agent.started":
      return optionalString(value, "objective")
    case "agent.action-requested":
      return isComputerAction(value.action)
    case "agent.action-completed":
      return optionalString(value, "actionId") && isActionResult(value.result)
    case "agent.observation":
      return isObservation(value.observation)
    case "agent.approval-requested":
      return isPermissionScope(value.scope) && optionalString(value, "requestId")
    case "agent.approval-decided":
      return isApprovalDecision(value.decision) && optionalString(value, "requestId")
    case "agent.completed":
      return optionalJson(value, "result")
    case "agent.failed":
      return isActionError(value.error)
    case "agent.cancelled":
      return optionalString(value, "reason")
    default:
      return (
        optionalString(value, "from") &&
        optionalString(value, "to") &&
        optionalString(value, "state") &&
        optionalString(value, "reason") &&
        optionalNumber(value, "until") &&
        optionalJson(value, "data") &&
        optionalActionError(value, "error") &&
        optionalString(value, "tool") &&
        optionalString(value, "callId") &&
        optionalString(value, "kind") &&
        optionalNumber(value, "limit") &&
        optionalNumber(value, "observed") &&
        optionalString(value, "childAgentId") &&
        optionalString(value, "task")
      )
  }
  return false
}

export function isProtocolEvent(value: unknown): value is ProtocolEvent {
  return isModelEvent(value) || isAgentEvent(value) || isComputerEvent(value)
}

export function isComputerEvent(value: unknown): value is ComputerEvent {
  if (!isEventBase(value, COMPUTER_EVENT_TYPES)) return false
  switch (value.type) {
    case "computer.connected":
      return isComputerInfo(value.computer)
    case "computer.disconnected":
      return optionalString(value, "computerId") && optionalString(value, "reason")
    case "computer.observation":
      return isObservation(value.observation)
    case "computer.action":
      return isComputerAction(value.action) && optionalActionResult(value, "result")
    case "computer.approval-requested":
      return isPermissionScope(value.scope) && optionalString(value, "requestId")
    case "computer.approval-decided":
      return isApprovalDecision(value.decision) && optionalString(value, "requestId")
    case "computer.error":
      return isActionError(value.error)
  }
  return false
}

export function isComputerProvider(value: unknown): value is ComputerProvider {
  if (!isRecord(value) || !isNonEmptyString(value.id) || !isNonEmptyString(value.name) || !isBackend(value.backend))
    return false
  return (
    optionalString(value, "platform") &&
    optionalArray(value, "capabilities", isCapabilitySupport) &&
    optionalMetadata(value, "metadata") &&
    optionalMethod(value, "getInfo") &&
    optionalMethod(value, "getComputerInfo") &&
    optionalMethod(value, "getEnvironment") &&
    optionalMethod(value, "observe") &&
    optionalMethod(value, "find") &&
    optionalMethod(value, "execute") &&
    optionalMethod(value, "act")
  )
}

export function isComputerDriver(value: unknown): value is ComputerDriver {
  if (!isRecord(value) || !isNonEmptyString(value.id) || !isBackend(value.backend)) return false
  return (
    optionalString(value, "providerId") &&
    optionalArray(value, "capabilities", isCapabilitySupport) &&
    optionalMethod(value, "getInfo") &&
    optionalMethod(value, "getComputerInfo") &&
    optionalMethod(value, "getEnvironment") &&
    optionalMethod(value, "observe") &&
    optionalMethod(value, "find") &&
    optionalMethod(value, "execute") &&
    optionalMethod(value, "act") &&
    optionalMethod(value, "close")
  )
}

function isJsonValueInternal(value: unknown, seen: Set<object>): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (typeof value !== "object" || value === null) return false
  if (seen.has(value)) return false
  seen.add(value)
  const valid = Array.isArray(value)
    ? value.every((item: unknown) => isJsonValueInternal(item, seen))
    : isRecord(value) && Object.values(value).every((item) => isJsonValueInternal(item, seen))
  seen.delete(value)
  return valid
}

function isUIElementInternal(value: unknown, seen: Set<object>): value is UIElement {
  if (!isRecord(value)) return false
  if (seen.has(value)) return false
  const hasKnownField = [
    "id",
    "role",
    "name",
    "accessibleName",
    "label",
    "description",
    "text",
    "value",
    "bounds",
    "states",
    "state",
    "actions",
    "capabilities",
    "attributes",
    "children",
    "parentId",
    "source",
    "backend",
    "reference",
    "provenance",
    "metadata",
    "browser",
  ].some((key) => Object.hasOwn(value, key))
  if (!hasKnownField) return false
  seen.add(value)
  const valid =
    optionalString(value, "id") &&
    optionalRole(value, "role") &&
    optionalString(value, "name") &&
    optionalString(value, "accessibleName") &&
    optionalString(value, "label") &&
    optionalString(value, "description") &&
    optionalString(value, "text") &&
    optionalJson(value, "value") &&
    optionalBounds(value, "bounds") &&
    optionalArray(value, "states", isState) &&
    optionalRecord(value, "state", isOptionalJsonRecord) &&
    optionalArray(value, "actions", isActionType) &&
    optionalCapabilityMap(value, "capabilities") &&
    optionalElementAttributes(value, "attributes") &&
    optionalArray(value, "children", (item) => isUIElementInternal(item, seen)) &&
    optionalString(value, "parentId") &&
    optionalSource(value, "source") &&
    optionalBackend(value, "backend") &&
    optionalElementReference(value, "reference") &&
    optionalProvenance(value, "provenance") &&
    optionalMetadata(value, "metadata") &&
    (value.browser === undefined || isJsonValue(value.browser))
  seen.delete(value)
  return valid
}

function isActionBase(value: Record<string, unknown>): boolean {
  return (
    optionalString(value, "id") &&
    optionalString(value, "actionId") &&
    (value.type === "open" ? optionalString(value, "target") : optionalTarget(value, "target")) &&
    optionalString(value, "elementId") &&
    optionalFiniteNumber(value, "x") &&
    optionalFiniteNumber(value, "y") &&
    optionalSource(value, "source") &&
    optionalBackend(value, "backend") &&
    optionalPermissionScope(value, "scope") &&
    optionalApprovalDecision(value, "approval") &&
    optionalNonNegativeNumber(value, "timeoutMs") &&
    optionalMetadata(value, "metadata") &&
    optionalProvenance(value, "provenance")
  )
}

function isEventBase(value: unknown, types: readonly string[]): value is Record<string, unknown> & { type: string } {
  if (!isRecord(value) || !isNonEmptyString(value.id) || !isFiniteNumber(value.timestamp)) return false
  if (typeof value.type !== "string" || !types.some((type) => type === value.type)) return false
  return (
    optionalString(value, "runId") &&
    optionalString(value, "requestId") &&
    optionalString(value, "agentId") &&
    optionalMetadata(value, "metadata")
  )
}

function hasTarget(value: Record<string, unknown>): boolean {
  return (
    isComputerTarget(value.target) ||
    isNonEmptyString(value.elementId) ||
    (isFiniteNumber(value.x) && isFiniteNumber(value.y))
  )
}

function isOptionalJsonRecord(value: unknown): value is Readonly<Record<string, JsonValue | undefined>> {
  return isRecord(value) && Object.values(value).every((item) => item === undefined || isJsonValue(item))
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function hasOptional(value: Record<string, unknown>, key: string): boolean {
  return !Object.hasOwn(value, key) || value[key] === undefined
}

function optionalString(value: Record<string, unknown>, key: string): boolean {
  return hasOptional(value, key) || typeof value[key] === "string"
}

function optionalNumber(value: Record<string, unknown>, key: string): boolean {
  return hasOptional(value, key) || isFiniteNumber(value[key])
}

function optionalLimit(value: Record<string, unknown>, key: string): boolean {
  return hasOptional(value, key) || (isFiniteNumber(value[key]) && Number.isSafeInteger(value[key]) && value[key] >= 0)
}

function optionalScore(value: Record<string, unknown>, key: string): boolean {
  return hasOptional(value, key) || (isFiniteNumber(value[key]) && value[key] >= 0 && value[key] <= 1)
}

function optionalTimestamp(value: Record<string, unknown>, key: string): boolean {
  return hasOptional(value, key) || (isFiniteNumber(value[key]) && value[key] >= 0)
}

function optionalNonNegativeNumber(value: Record<string, unknown>, key: string): boolean {
  return hasOptional(value, key) || (isFiniteNumber(value[key]) && value[key] >= 0)
}

function optionalFiniteNumber(value: Record<string, unknown>, key: string): boolean {
  return hasOptional(value, key) || isFiniteNumber(value[key])
}

function optionalBoolean(value: Record<string, unknown>, key: string): boolean {
  return hasOptional(value, key) || typeof value[key] === "boolean"
}

function optionalJson(value: Record<string, unknown>, key: string): boolean {
  return hasOptional(value, key) || isJsonValue(value[key])
}

function optionalJsonObject(value: Record<string, unknown>, key: string): boolean {
  return hasOptional(value, key) || isJsonObject(value[key])
}

function optionalMetadata(value: Record<string, unknown>, key: string): boolean {
  return hasOptional(value, key) || isMetadata(value[key])
}

function optionalSource(value: Record<string, unknown>, key: string): boolean {
  return hasOptional(value, key) || isSource(value[key])
}

function optionalBackend(value: Record<string, unknown>, key: string): boolean {
  return hasOptional(value, key) || isBackend(value[key])
}

function optionalRole(value: Record<string, unknown>, key: string): boolean {
  return hasOptional(value, key) || isRole(value[key])
}

function optionalCapabilityState(value: Record<string, unknown>, key: string): boolean {
  return hasOptional(value, key) || isCapabilityState(value[key])
}

function optionalInstructionAuthority(value: Record<string, unknown>, key: string): boolean {
  return hasOptional(value, key) || isInstructionAuthority(value[key])
}

function optionalTrustLevel(value: Record<string, unknown>, key: string): boolean {
  return hasOptional(value, key) || isTrustLevel(value[key])
}

function optionalElementReference(value: Record<string, unknown>, key: string): boolean {
  return hasOptional(value, key) || isElementReference(value[key])
}

function optionalProvenance(value: Record<string, unknown>, key: string): boolean {
  return hasOptional(value, key) || isProvenance(value[key])
}

function optionalPermissionScope(value: Record<string, unknown>, key: string): boolean {
  return hasOptional(value, key) || isPermissionScope(value[key])
}

function optionalApprovalDecision(value: Record<string, unknown>, key: string): boolean {
  return hasOptional(value, key) || isApprovalDecision(value[key])
}

function optionalVerification(value: Record<string, unknown>, key: string): boolean {
  return hasOptional(value, key) || isVerification(value[key])
}

function optionalActionError(value: Record<string, unknown>, key: string): boolean {
  return hasOptional(value, key) || isActionError(value[key])
}

function optionalActionResult(value: Record<string, unknown>, key: string): boolean {
  return hasOptional(value, key) || isActionResult(value[key])
}

function optionalComputerInfo(value: Record<string, unknown>, key: string): boolean {
  return hasOptional(value, key) || isComputerInfo(value[key])
}

function optionalEnvironment(value: Record<string, unknown>, key: string): boolean {
  return hasOptional(value, key) || isEnvironment(value[key])
}

function optionalScreen(value: Record<string, unknown>, key: string): boolean {
  return hasOptional(value, key) || isScreen(value[key])
}

function optionalScreenshot(value: Record<string, unknown>, key: string): boolean {
  return hasOptional(value, key) || isScreenshot(value[key])
}

function optionalObservation(value: Record<string, unknown>, key: string): boolean {
  return hasOptional(value, key) || isObservation(value[key])
}

function optionalTarget(value: Record<string, unknown>, key: string): boolean {
  return hasOptional(value, key) || isComputerTarget(value[key])
}

function optionalBounds(value: Record<string, unknown>, key: string): boolean {
  return hasOptional(value, key) || isBounds(value[key])
}

function optionalEncoding(value: Record<string, unknown>, key: string): boolean {
  return hasOptional(value, key) || value[key] === "base64" || value[key] === "base64url"
}

function optionalOrientation(value: Record<string, unknown>, key: string): boolean {
  return hasOptional(value, key) || value[key] === "horizontal" || value[key] === "vertical"
}

function optionalLive(value: Record<string, unknown>, key: string): boolean {
  return hasOptional(value, key) || value[key] === "polite" || value[key] === "assertive" || value[key] === "off"
}

function optionalAutocomplete(value: Record<string, unknown>, key: string): boolean {
  return (
    hasOptional(value, key) ||
    value[key] === "inline" ||
    value[key] === "list" ||
    value[key] === "both" ||
    value[key] === "none"
  )
}

function optionalMouseButton(value: Record<string, unknown>, key: string): boolean {
  return (
    hasOptional(value, key) || (typeof value[key] === "string" && MOUSE_BUTTONS.some((button) => button === value[key]))
  )
}

function optionalDirection(value: Record<string, unknown>, key: string): boolean {
  return (
    hasOptional(value, key) ||
    (typeof value[key] === "string" && SCROLL_DIRECTIONS.some((direction) => direction === value[key]))
  )
}

function optionalCount(value: Record<string, unknown>, key: string): boolean {
  return hasOptional(value, key) || (isFiniteNumber(value[key]) && Number.isSafeInteger(value[key]) && value[key] > 0)
}

function optionalModifiers(value: Record<string, unknown>, key: string): boolean {
  return (
    hasOptional(value, key) ||
    (Array.isArray(value[key]) &&
      value[key].every((item: unknown) => typeof item === "string" && MODIFIERS.some((modifier) => modifier === item)))
  )
}

function optionalStringArray(value: Record<string, unknown>, key: string): boolean {
  return (
    hasOptional(value, key) ||
    (Array.isArray(value[key]) && value[key].every((item: unknown) => typeof item === "string"))
  )
}

function optionalActionTypeArray(value: Record<string, unknown>, key: string): boolean {
  return hasOptional(value, key) || (Array.isArray(value[key]) && value[key].every(isActionType))
}

function optionalCapabilityMap(value: Record<string, unknown>, key: string): boolean {
  return hasOptional(value, key) || isCapabilityMap(value[key])
}

function optionalStringMap(value: Record<string, unknown>, key: string): boolean {
  return (
    hasOptional(value, key) ||
    (isRecord(value[key]) && Object.values(value[key]).every((item) => typeof item === "string"))
  )
}

function optionalElementAttributes(value: Record<string, unknown>, key: string): boolean {
  return hasOptional(value, key) || isElementAttributes(value[key])
}

function optionalRecord(value: Record<string, unknown>, key: string, predicate: (item: unknown) => boolean): boolean {
  return hasOptional(value, key) || (isRecord(value[key]) && predicate(value[key]))
}

function optionalArray(value: Record<string, unknown>, key: string, predicate: (item: unknown) => boolean): boolean {
  return hasOptional(value, key) || (Array.isArray(value[key]) && value[key].every(predicate))
}

function isCapabilityMap(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every(isCapabilityState)
}

function optionalMethod(value: Record<string, unknown>, key: string): boolean {
  return hasOptional(value, key) || typeof value[key] === "function"
}

function isApprovalDecisionValue(value: unknown): value is ApprovalDecisionValue {
  return typeof value === "string" && APPROVAL_DECISIONS.some((decision) => decision === value)
}

function isVerificationStatus(value: unknown): value is VerificationStatus {
  return typeof value === "string" && VERIFICATION_STATUSES.some((status) => status === value)
}

function optionalActionResultStatus(value: Record<string, unknown>, key: string): boolean {
  return (
    hasOptional(value, key) ||
    (typeof value[key] === "string" && ACTION_RESULT_STATUSES.some((status) => status === value[key]))
  )
}
