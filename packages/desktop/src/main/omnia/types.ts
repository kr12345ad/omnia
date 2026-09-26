import type {
  ActionResult,
  Backend,
  CapabilitySupport,
  ClickAction,
  ComputerAction,
  ComputerDriver,
  ComputerEvent,
  ComputerInfo,
  DoubleClickAction,
  ElementReferenceBase,
  FindRequest,
  FindResult,
  FocusAction,
  KeyAction,
  Modifier,
  Observation,
  ObservationRequest,
  RightClickAction,
  ScrollAction,
  Source,
  TypeAction,
} from "@opencode-ai/omnia/protocol"

export const OMNIA_UNAVAILABLE_REASONS = ["driver_unavailable", "operation_unavailable"] as const

export const OMNIA_BLOCKED_REASONS = [
  "sender_rejected",
  "invalid_payload",
  "invalid_result",
  "result_too_large",
  "target_stale",
  "driver_blocked",
  "operation_failed",
  "subscription_limit",
] as const

export type OmniaUnavailableReason = (typeof OMNIA_UNAVAILABLE_REASONS)[number]
export type OmniaBlockedReason = (typeof OMNIA_BLOCKED_REASONS)[number]
export type OmniaAwaitable<T> = T | PromiseLike<T>

export type OmniaFailure =
  | { ok: false; status: "unavailable"; reason: OmniaUnavailableReason }
  | { ok: false; status: "blocked"; reason: OmniaBlockedReason }
  | { ok: false; status: "permission_required"; permission: string; canRequest: boolean }

export type OmniaResult<T> = { ok: true; status: "ok"; value: T } | OmniaFailure

export type OmniaCapabilities = {
  id: string
  backend: Backend
  platform: string
  available: boolean
  computer: ComputerInfo | null
  operations: {
    observe: boolean
    find: boolean
    execute: boolean
    subscribe: boolean
  }
  capabilities: CapabilitySupport[]
}

export type OmniaTargetReference = ElementReferenceBase & {
  elementId: string
  generation: number
}

export type OmniaObserveRequest = {
  include?: readonly string[]
  applicationId?: string
  source?: Source
  backend?: Backend
  includeScreenshot: boolean
  includeElements: boolean
}

export type OmniaFindRequest = Omit<FindRequest, "metadata" | "limit"> & {
  limit: number
}

export type OmniaAction =
  | Pick<ClickAction, "type" | "button" | "count" | "modifiers">
  | Pick<DoubleClickAction, "type" | "button" | "modifiers">
  | Pick<RightClickAction, "type" | "button" | "modifiers">
  | Pick<TypeAction, "type" | "text">
  | Pick<KeyAction, "type" | "key" | "modifiers">
  | Pick<ScrollAction, "type" | "deltaX" | "deltaY" | "amount">
  | Pick<FocusAction, "type">

export type OmniaExecuteRequest = {
  target: OmniaTargetReference
  action: OmniaAction
}

export type OmniaExecution = {
  target: OmniaTargetReference
  result: ActionResult
}

export type OmniaObservation = Observation
export type OmniaFindResult = FindResult

export type OmniaEvent = {
  id: string
  timestamp: number
  type: ComputerEvent["type"]
  computerId?: string
  code?: string
}

export type OmniaSubscribeIpcResult = OmniaResult<{ subscriptionId: string }>

export type OmniaSubscribeResult = { ok: true; status: "ok"; unsubscribe: () => Promise<void> } | OmniaFailure

export type OmniaDriverUnsubscribe = () => void

export type OmniaDriver = ComputerDriver & {
  revalidateTarget?: (target: OmniaTargetReference) => OmniaAwaitable<OmniaResult<OmniaTargetReference>>
  subscribe?: (listener: (event: ComputerEvent) => void) => OmniaAwaitable<OmniaResult<OmniaDriverUnsubscribe>>
}

export class OmniaDriverError extends Error {
  readonly failure: OmniaFailure

  constructor(failure: OmniaFailure) {
    super(failure.status)
    this.name = "OmniaDriverError"
    this.failure = failure
  }
}

export type OmniaAPI = {
  getCapabilities: () => Promise<OmniaResult<OmniaCapabilities>>
  observe: (request?: Partial<Omit<ObservationRequest, "metadata">>) => Promise<OmniaResult<Observation>>
  find: (request: Omit<FindRequest, "metadata">) => Promise<OmniaResult<FindResult>>
  execute: (request: OmniaExecuteRequest) => Promise<OmniaResult<OmniaExecution>>
  subscribe: (listener: (event: OmniaEvent) => void) => Promise<OmniaSubscribeResult>
}

export type OmniaComputerAction = ComputerAction
export type OmniaModifier = Modifier
