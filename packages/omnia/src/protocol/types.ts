export type JsonPrimitive = string | number | boolean | null

export type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject

export interface JsonObject {
  readonly [key: string]: JsonValue
}

export type Metadata = JsonObject

export type Timestamp = number

export const ROLES = [
  "alert",
  "alertdialog",
  "application",
  "article",
  "banner",
  "button",
  "cell",
  "checkbox",
  "columnheader",
  "combobox",
  "complementary",
  "contentinfo",
  "dialog",
  "document",
  "form",
  "generic",
  "grid",
  "group",
  "heading",
  "img",
  "link",
  "list",
  "listitem",
  "log",
  "main",
  "marquee",
  "menu",
  "menubar",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "navigation",
  "none",
  "option",
  "progressbar",
  "radio",
  "region",
  "row",
  "rowheader",
  "scrollbar",
  "search",
  "searchbox",
  "separator",
  "slider",
  "spinbutton",
  "status",
  "switch",
  "tab",
  "table",
  "tablist",
  "tabpanel",
  "text",
  "textbox",
  "timer",
  "titlebar",
  "toolbar",
  "tooltip",
  "tree",
  "treeitem",
  "window",
] as const

export type KnownRole = (typeof ROLES)[number]
export type Role = string
export type UIRole = Role
export type ElementRole = Role

export const STATES = [
  "busy",
  "checked",
  "collapsed",
  "disabled",
  "editable",
  "expanded",
  "focused",
  "hidden",
  "mixed",
  "modal",
  "multiselectable",
  "offscreen",
  "pressed",
  "readonly",
  "required",
  "selected",
] as const

export type State = (typeof STATES)[number]
export type ElementState = State

export const ACTION_TYPES = [
  "click",
  "doubleclick",
  "rightclick",
  "longpress",
  "move",
  "drag",
  "type",
  "setvalue",
  "key",
  "keypress",
  "press",
  "press_keys",
  "scroll",
  "focus",
  "toggle",
  "select",
  "expand",
  "collapse",
  "increment",
  "decrement",
  "scroll_into_view",
  "dismiss",
  "wait",
  "observe",
  "screenshot",
  "find",
  "read",
  "launch",
  "open",
  "close",
  "copy",
  "paste",
] as const

export type ActionType = (typeof ACTION_TYPES)[number]
export type ComputerActionType = ActionType
export type CanonicalAction = ActionType

export const SOURCES = [
  "accessibility",
  "dom",
  "vision",
  "ocr",
  "hybrid",
  "native",
  "browser",
  "file",
  "webpage",
  "application",
  "tool",
  "retrieved",
  "memory",
  "remote",
  "virtual",
  "user",
  "operator",
  "system",
  "model",
  "unknown",
] as const

export type KnownSource = (typeof SOURCES)[number]
export type Source = string
export type ObservationSource = Source
export type ElementSource = Source

export const BACKENDS = ["native", "browser", "remote", "virtual", "future", "unknown"] as const

export type KnownBackend = (typeof BACKENDS)[number]
export type Backend = string
export type BackendId = string
export type ElementBackend = Backend

export const PLATFORMS = ["macos", "windows", "linux", "web", "android", "ios", "browser", "future", "unknown"] as const

export type KnownPlatform = (typeof PLATFORMS)[number]
export type Platform = string
export type ComputerPlatform = Platform

export const CAPABILITY_STATES = ["available", "degraded", "unavailable", "unknown"] as const

export type CapabilityState = (typeof CAPABILITY_STATES)[number]
export type CapabilityStatus = CapabilityState
export const CAPABILITY_STATUSES = CAPABILITY_STATES

export const TRUST_LEVELS = ["trusted", "untrusted", "system"] as const

export type TrustLevel = (typeof TRUST_LEVELS)[number]

export const PROVENANCE_SOURCES = [
  "user",
  "operator",
  "system",
  "application",
  "file",
  "webpage",
  "tool",
  "environment",
  "retrieved",
  "memory",
  "computer",
  "vision",
  "model",
  "unknown",
] as const

export type ProvenanceSource = string

export const INSTRUCTION_AUTHORITIES = ["user", "operator", "system", "none"] as const

export type InstructionAuthority = (typeof INSTRUCTION_AUTHORITIES)[number]

export interface Point {
  readonly x: number
  readonly y: number
}

export interface Size {
  readonly width: number
  readonly height: number
}

export interface Bounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export type Rect = Bounds
export type Region = Bounds

export interface Screen {
  readonly width: number
  readonly height: number
  readonly scale?: number
  readonly rotation?: 0 | 90 | 180 | 270
  readonly primary?: boolean
}

export interface Screenshot {
  readonly mediaType?: string
  readonly encoding?: "base64" | "base64url"
  readonly data?: string
  readonly width?: number
  readonly height?: number
  readonly region?: Bounds
  readonly capturedAt?: Timestamp
  readonly metadata?: Metadata
}

export interface ElementAttributes {
  readonly level?: number
  readonly valueMin?: number
  readonly valueMax?: number
  readonly valueNow?: number
  readonly orientation?: "horizontal" | "vertical"
  readonly rowIndex?: number
  readonly colIndex?: number
  readonly rowCount?: number
  readonly colCount?: number
  readonly posInSet?: number
  readonly setSize?: number
  readonly placeholder?: string
  readonly url?: string
  readonly live?: "polite" | "assertive" | "off"
  readonly autocomplete?: "inline" | "list" | "both" | "none"
  readonly keyShortcut?: string
  readonly roledescription?: string
  readonly [key: string]: JsonValue | undefined
}

export type Attributes = ElementAttributes

export interface ElementReferenceBase {
  readonly kind?: "element"
  readonly observationId?: string
  readonly generation?: number
  readonly source?: Source
  readonly backend?: Backend
  readonly role?: Role
  readonly locator?: JsonValue
  readonly expiresAt?: Timestamp
  readonly metadata?: Metadata
}

export type ElementReference =
  | (ElementReferenceBase & { readonly elementId: string; readonly id?: string })
  | (ElementReferenceBase & { readonly id: string; readonly elementId?: string })

export interface UIElement {
  readonly id?: string
  readonly role?: Role
  readonly name?: string
  readonly accessibleName?: string
  readonly label?: string
  readonly description?: string
  readonly text?: string
  readonly value?: JsonValue
  readonly bounds?: Bounds
  readonly states?: readonly State[]
  readonly state?: Readonly<Record<string, JsonValue | undefined>>
  readonly actions?: readonly ActionType[]
  readonly capabilities?: Readonly<Record<string, CapabilityState>>
  readonly attributes?: ElementAttributes
  readonly children?: readonly UIElement[]
  readonly parentId?: string
  readonly source?: Source
  readonly backend?: Backend
  readonly reference?: ElementReference
  readonly provenance?: Provenance
  readonly metadata?: Metadata
}

export interface ActionDescriptorBase {
  readonly name?: string
  readonly label?: string
  readonly description?: string
  readonly target?: ComputerTarget
  readonly input?: JsonValue
  readonly parameters?: JsonObject
  readonly required?: boolean
  readonly enabled?: boolean
  readonly requiresApproval?: boolean
  readonly permissionScope?: PermissionScope
  readonly capability?: CapabilityState
  readonly state?: CapabilityState
  readonly metadata?: Metadata
}

export type ActionDescriptor = ActionDescriptorBase &
  (
    | { readonly action: ActionType; readonly type?: ActionType }
    | { readonly type: ActionType; readonly action?: ActionType }
  )

export interface PointTarget {
  readonly kind: "point"
  readonly x: number
  readonly y: number
}

export interface ElementTarget {
  readonly kind: "element"
  readonly elementId: string
  readonly reference?: ElementReference
}

export interface ApplicationTarget {
  readonly kind: "application"
  readonly applicationId: string
}

export type ComputerTarget = PointTarget | ElementTarget | ApplicationTarget

export const MOUSE_BUTTONS = ["left", "right", "middle"] as const
export type MouseButton = (typeof MOUSE_BUTTONS)[number]

export const MODIFIERS = ["alt", "control", "meta", "shift"] as const
export type Modifier = (typeof MODIFIERS)[number]

export const SCROLL_DIRECTIONS = ["up", "down", "left", "right"] as const
export type ScrollDirection = (typeof SCROLL_DIRECTIONS)[number]

export interface ActionBase {
  readonly id?: string
  readonly actionId?: string
  readonly target?: ComputerTarget
  readonly elementId?: string
  readonly x?: number
  readonly y?: number
  readonly source?: Source
  readonly backend?: Backend
  readonly scope?: PermissionScope
  readonly approval?: ApprovalDecision
  readonly timeoutMs?: number
  readonly metadata?: Metadata
  readonly provenance?: Provenance
}

export interface ObserveAction extends ActionBase {
  readonly type: "observe"
  readonly applicationId?: string
  readonly include?: readonly string[]
}

export interface ScreenshotAction extends ActionBase {
  readonly type: "screenshot"
  readonly region?: Bounds
  readonly includeCursor?: boolean
}

export interface ClickAction extends ActionBase {
  readonly type: "click"
  readonly button?: MouseButton
  readonly count?: number
  readonly modifiers?: readonly Modifier[]
}

export interface DoubleClickAction extends ActionBase {
  readonly type: "doubleclick"
  readonly button?: MouseButton
  readonly modifiers?: readonly Modifier[]
}

export interface RightClickAction extends ActionBase {
  readonly type: "rightclick"
  readonly button?: MouseButton
  readonly modifiers?: readonly Modifier[]
}

export interface LongPressAction extends ActionBase {
  readonly type: "longpress"
  readonly durationMs?: number
}

export interface MoveAction extends ActionBase {
  readonly type: "move"
}

export interface DragAction extends ActionBase {
  readonly type: "drag"
  readonly from: ComputerTarget
  readonly to: ComputerTarget
  readonly button?: MouseButton
  readonly durationMs?: number
}

export interface TypeAction extends ActionBase {
  readonly type: "type"
  readonly text: string
  readonly value?: string
}

export interface SetValueAction extends ActionBase {
  readonly type: "setvalue"
  readonly value: JsonValue
}

export interface KeyAction extends ActionBase {
  readonly type: "key"
  readonly key: string
  readonly keys?: string
  readonly modifiers?: readonly Modifier[]
}

export interface KeypressAction extends ActionBase {
  readonly type: "keypress"
  readonly key: string
  readonly modifiers?: readonly Modifier[]
}

export interface PressAction extends ActionBase {
  readonly type: "press"
  readonly keys: string
}

export interface PressKeysAction extends ActionBase {
  readonly type: "press_keys"
  readonly keys: string
}

export interface ScrollAction extends ActionBase {
  readonly type: "scroll"
  readonly direction?: ScrollDirection
  readonly deltaX?: number
  readonly deltaY?: number
  readonly amount?: number
}

export interface FocusAction extends ActionBase {
  readonly type: "focus"
}

export interface ToggleAction extends ActionBase {
  readonly type: "toggle"
}

export interface SelectAction extends ActionBase {
  readonly type: "select"
  readonly value?: JsonValue
}

export interface ExpandAction extends ActionBase {
  readonly type: "expand"
}

export interface CollapseAction extends ActionBase {
  readonly type: "collapse"
}

export interface IncrementAction extends ActionBase {
  readonly type: "increment"
  readonly amount?: number
}

export interface DecrementAction extends ActionBase {
  readonly type: "decrement"
  readonly amount?: number
}

export interface ScrollIntoViewAction extends ActionBase {
  readonly type: "scroll_into_view"
}

export interface DismissAction extends ActionBase {
  readonly type: "dismiss"
}

export interface WaitAction extends ActionBase {
  readonly type: "wait"
  readonly ms?: number
  readonly condition?: string
}

export interface FindAction extends ActionBase {
  readonly type: "find"
  readonly request: FindRequest
}

export interface ReadAction extends ActionBase {
  readonly type: "read"
  readonly target?: ComputerTarget
}

export interface LaunchAction extends ActionBase {
  readonly type: "launch"
  readonly applicationId: string
}

export interface OpenAction extends Omit<ActionBase, "target"> {
  readonly type: "open"
  readonly target: string
}

export interface CloseAction extends ActionBase {
  readonly type: "close"
  readonly target?: ComputerTarget
}

export interface CopyAction extends ActionBase {
  readonly type: "copy"
  readonly target?: ComputerTarget
}

export interface PasteAction extends ActionBase {
  readonly type: "paste"
  readonly text: string
}

export type ComputerAction =
  | ObserveAction
  | ScreenshotAction
  | ClickAction
  | DoubleClickAction
  | RightClickAction
  | LongPressAction
  | MoveAction
  | DragAction
  | TypeAction
  | SetValueAction
  | KeyAction
  | KeypressAction
  | PressAction
  | PressKeysAction
  | ScrollAction
  | FocusAction
  | ToggleAction
  | SelectAction
  | ExpandAction
  | CollapseAction
  | IncrementAction
  | DecrementAction
  | ScrollIntoViewAction
  | DismissAction
  | WaitAction
  | FindAction
  | ReadAction
  | LaunchAction
  | OpenAction
  | CloseAction
  | CopyAction
  | PasteAction

export type ComputerCommand = ComputerAction
export type Action = ComputerAction

export interface FindRequest {
  readonly query: string
  readonly role?: Role
  readonly name?: string
  readonly window?: string
  readonly source?: Source
  readonly backend?: Backend
  readonly limit?: number
  readonly includeOffscreen?: boolean
  readonly observationId?: string
  readonly metadata?: Metadata
}

export interface FindMatch {
  readonly element: UIElement
  readonly reference?: ElementReference
  readonly score: number
  readonly reason?: string
}

export interface FindResult {
  readonly query?: string
  readonly matches?: readonly FindMatch[]
  readonly results?: readonly FindMatch[]
  readonly elements?: readonly UIElement[]
  readonly references?: readonly ElementReference[]
  readonly observation?: Observation
  readonly truncated?: boolean
  readonly metadata?: Metadata
}

export type SearchRequest = FindRequest
export type SearchResult = FindResult

export interface Capability {
  readonly name: string
  readonly state?: CapabilityState
  readonly status?: CapabilityState
  readonly description?: string
  readonly reason?: string
  readonly version?: string
  readonly metadata?: Metadata
}

export interface PermissionRequirement {
  readonly id: string
  readonly description: string
  readonly status: "granted" | "denied" | "prompt" | "restricted" | "not-required" | "unknown"
  readonly capabilities?: readonly string[]
  readonly promptable?: boolean
  readonly reason?: string
}

export interface Limitation {
  readonly code: string
  readonly kind: "permission" | "platform" | "display-server" | "application" | "compatibility" | "transient"
  readonly severity: "info" | "warning" | "error"
  readonly message: string
  readonly affects?: readonly string[]
}

export interface CapabilitySupport {
  readonly capability: string
  readonly status: CapabilityState
  readonly score?: number
  readonly reason?: string
  readonly permissions?: readonly PermissionRequirement[]
  readonly limitations?: readonly Limitation[]
  readonly metadata?: Metadata
}

export interface ComputerInfo {
  readonly id: string
  readonly name: string
  readonly platform: string
  readonly os?: string
  readonly architecture?: string
  readonly arch?: string
  readonly backend?: Backend
  readonly connected?: boolean
  readonly screen?: Screen
  readonly display?: Screen
  readonly capabilities?: readonly CapabilitySupport[]
  readonly metadata?: Metadata
}

export interface Environment {
  readonly id?: string
  readonly platform: string
  readonly os?: string
  readonly architecture?: string
  readonly arch?: string
  readonly backend?: Backend
  readonly display?: Screen
  readonly sessionId?: string
  readonly locale?: string
  readonly timezone?: string
  readonly remote?: boolean
  readonly capabilities?: Readonly<Record<string, CapabilityState>>
  readonly variables?: Readonly<Record<string, string>>
  readonly metadata?: Metadata
}

export interface Observation {
  readonly id?: string
  readonly timestamp?: Timestamp
  readonly capturedAt?: Timestamp
  readonly computer?: ComputerInfo
  readonly environment?: Environment
  readonly screen?: Screen
  readonly elements?: readonly UIElement[]
  readonly value?: JsonValue
  readonly text?: string
  readonly screenshot?: Screenshot
  readonly source?: Source
  readonly backend?: Backend
  readonly capabilities?: Readonly<Record<string, CapabilityState>>
  readonly warnings?: readonly string[]
  readonly provenance?: Provenance
  readonly metadata?: Metadata
}

export const PERMISSION_SCOPES = [
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
] as const

export type PermissionScopeName = (typeof PERMISSION_SCOPES)[number]

export interface PermissionScopeDescriptor {
  readonly kind: PermissionScopeName | string
  readonly resource?: string
  readonly resources?: readonly string[]
  readonly paths?: readonly string[]
  readonly origins?: readonly string[]
  readonly actions?: readonly ActionType[]
  readonly metadata?: Metadata
}

export type PermissionScope = PermissionScopeName | PermissionScopeDescriptor

export const APPROVAL_DECISIONS = [
  "approved",
  "permission_required",
  "denied",
  "blocked",
  "allow",
  "deny",
  "ask",
] as const

export type ApprovalDecisionValue = (typeof APPROVAL_DECISIONS)[number]

export interface ApprovalDecisionRecord {
  readonly decision: ApprovalDecisionValue
  readonly type?: "approval"
  readonly reason?: string
  readonly approvedBy?: string
  readonly expiresAt?: Timestamp
  readonly scope?: PermissionScope
  readonly metadata?: Metadata
}

export type ApprovalDecision = ApprovalDecisionValue | ApprovalDecisionRecord

export interface Provenance {
  readonly source: ProvenanceSource
  readonly trust: TrustLevel
  readonly authority?: InstructionAuthority
  readonly origin?: string
  readonly capturedAt?: Timestamp
  readonly backend?: Backend
  readonly trustLevel?: TrustLevel
  readonly metadata?: Metadata
}

export const VERIFICATION_STATUSES = [
  "passed",
  "failed",
  "success",
  "failure",
  "verified",
  "unverified",
  "inconclusive",
  "skipped",
] as const

export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number]

export interface VerificationEvidence {
  readonly kind?: string
  readonly value?: JsonValue
  readonly reference?: ElementReference
  readonly observationId?: string
  readonly metadata?: Metadata
}

export interface Verification {
  readonly status: VerificationStatus
  readonly passed?: boolean
  readonly verified?: boolean
  readonly ok?: boolean
  readonly method?: string
  readonly expected?: JsonValue
  readonly actual?: JsonValue
  readonly message?: string
  readonly evidence?: readonly VerificationEvidence[]
  readonly metadata?: Metadata
}

export type ActionError =
  | string
  | {
      readonly code?: string
      readonly message: string
      readonly retryable?: boolean
      readonly details?: JsonValue
      readonly metadata?: Metadata
    }

export const ACTION_RESULT_STATUSES = [
  "success",
  "partial",
  "failed",
  "failure",
  "rejected",
  "unavailable",
  "error",
  "cancelled",
] as const

export type ActionResultStatus = (typeof ACTION_RESULT_STATUSES)[number]

export interface ActionResult {
  readonly success: boolean
  readonly message?: string
  readonly status?: ActionResultStatus
  readonly actionId?: string
  readonly observation?: Observation
  readonly verification?: Verification
  readonly error?: ActionError
  readonly limitations?: readonly Limitation[]
  readonly metadata?: Metadata
}

export type ComputerResult = ActionResult

export interface CommandRequest {
  readonly command: string
  readonly cwd?: string
  readonly timeoutMs?: number
  readonly env?: Readonly<Record<string, string>>
  readonly stdin?: string
  readonly maxOutputBytes?: number
}

export interface CommandResult {
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
  readonly truncated: boolean
  readonly timedOut: boolean
  readonly durationMs: number
  readonly stdinError?: string
}

export interface ObservationRequest {
  readonly include?: readonly string[]
  readonly applicationId?: string
  readonly source?: Source
  readonly backend?: Backend
  readonly includeScreenshot?: boolean
  readonly includeElements?: boolean
  readonly metadata?: Metadata
}

export interface ComputerProviderDescriptor {
  readonly id: string
  readonly name: string
  readonly backend: Backend
  readonly platform?: string
  readonly capabilities?: readonly CapabilitySupport[]
  readonly metadata?: Metadata
}

export interface ComputerProvider extends ComputerProviderDescriptor {
  getInfo?(): Promise<ComputerInfo>
  getComputerInfo?(): Promise<ComputerInfo>
  getEnvironment?(): Promise<Environment>
  observe?(request?: ObservationRequest): Promise<Observation>
  find?(request: FindRequest): Promise<FindResult>
  execute?(action: ComputerAction): Promise<ActionResult>
  act?(action: ComputerAction): Promise<ActionResult>
}

export interface ComputerDriver {
  readonly id: string
  readonly backend: Backend
  readonly providerId?: string
  readonly capabilities?: readonly CapabilitySupport[]
  getInfo?(): Promise<ComputerInfo>
  getComputerInfo?(): Promise<ComputerInfo>
  getEnvironment?(): Promise<Environment>
  observe?(request?: ObservationRequest): Promise<Observation>
  find?(request: FindRequest): Promise<FindResult>
  execute?(action: ComputerAction): Promise<ActionResult>
  act?(action: ComputerAction): Promise<ActionResult>
  close?(): void | Promise<void>
}

export const MODEL_EVENT_TYPES = [
  "model.requested",
  "model.started",
  "model.message",
  "model.tool-call",
  "model.response",
  "model.completed",
  "model.failed",
  "model.cancelled",
] as const

export type ModelEventType = (typeof MODEL_EVENT_TYPES)[number]

export interface ModelEventBase {
  readonly id: string
  readonly timestamp: Timestamp
  readonly type: ModelEventType
  readonly runId?: string
  readonly requestId?: string
  readonly metadata?: Metadata
}

export type ModelEvent =
  | (ModelEventBase & {
      readonly type: "model.requested"
      readonly model?: string
      readonly input?: JsonValue
    })
  | (ModelEventBase & { readonly type: "model.started"; readonly model?: string })
  | (ModelEventBase & { readonly type: "model.message"; readonly role: string; readonly content: JsonValue })
  | (ModelEventBase & {
      readonly type: "model.tool-call"
      readonly callId: string
      readonly name: string
      readonly input: JsonValue
    })
  | (ModelEventBase & { readonly type: "model.response"; readonly output?: JsonValue; readonly finishReason?: string })
  | (ModelEventBase & { readonly type: "model.completed"; readonly output?: JsonValue })
  | (ModelEventBase & { readonly type: "model.failed"; readonly error: ActionError })
  | (ModelEventBase & { readonly type: "model.cancelled"; readonly reason?: string })

export type ModelRequestedEvent = Extract<ModelEvent, { readonly type: "model.requested" }>
export type ModelStartedEvent = Extract<ModelEvent, { readonly type: "model.started" }>
export type ModelMessageEvent = Extract<ModelEvent, { readonly type: "model.message" }>
export type ModelToolCallEvent = Extract<ModelEvent, { readonly type: "model.tool-call" }>
export type ModelResponseEvent = Extract<ModelEvent, { readonly type: "model.response" }>
export type ModelCompletedEvent = Extract<ModelEvent, { readonly type: "model.completed" }>
export type ModelFailedEvent = Extract<ModelEvent, { readonly type: "model.failed" }>
export type ModelCancelledEvent = Extract<ModelEvent, { readonly type: "model.cancelled" }>

export const AGENT_EVENT_TYPES = [
  "agent.started",
  "agent.state.changed",
  "agent.action-requested",
  "agent.action-completed",
  "agent.observation",
  "agent.approval-requested",
  "agent.approval-decided",
  "agent.tool.started",
  "agent.tool.completed",
  "agent.tool.failed",
  "agent.tool.cancelled",
  "agent.waiting",
  "agent.blocked",
  "agent.error",
  "agent.recovery",
  "agent.paused",
  "agent.resumed",
  "agent.completed",
  "agent.failed",
  "agent.cancelled",
  "agent.limit",
  "agent.delegated",
] as const

export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number]
export type AgentLifecycleEventType = Exclude<
  AgentEventType,
  | "agent.started"
  | "agent.action-requested"
  | "agent.action-completed"
  | "agent.observation"
  | "agent.approval-requested"
  | "agent.approval-decided"
  | "agent.completed"
  | "agent.failed"
  | "agent.cancelled"
>

export interface AgentEventBase {
  readonly id: string
  readonly timestamp: Timestamp
  readonly type: AgentEventType
  readonly runId?: string
  readonly agentId?: string
  readonly metadata?: Metadata
}

export type AgentEvent =
  | (AgentEventBase & { readonly type: "agent.started"; readonly objective?: string })
  | (AgentEventBase & { readonly type: "agent.action-requested"; readonly action: ComputerAction })
  | (AgentEventBase & {
      readonly type: "agent.action-completed"
      readonly actionId?: string
      readonly result: ActionResult
    })
  | (AgentEventBase & { readonly type: "agent.observation"; readonly observation: Observation })
  | (AgentEventBase & {
      readonly type: "agent.approval-requested"
      readonly scope: PermissionScope
      readonly requestId?: string
    })
  | (AgentEventBase & {
      readonly type: "agent.approval-decided"
      readonly decision: ApprovalDecision
      readonly requestId?: string
    })
  | (AgentEventBase & { readonly type: "agent.completed"; readonly result?: JsonValue })
  | (AgentEventBase & { readonly type: "agent.failed"; readonly error: ActionError })
  | (AgentEventBase & { readonly type: "agent.cancelled"; readonly reason?: string })
  | (AgentEventBase & {
      readonly type: AgentLifecycleEventType
      readonly from?: string
      readonly to?: string
      readonly state?: string
      readonly reason?: string
      readonly until?: number
      readonly data?: JsonValue
      readonly error?: ActionError
      readonly tool?: string
      readonly callId?: string
      readonly kind?: string
      readonly limit?: number
      readonly observed?: number
      readonly childAgentId?: string
      readonly task?: string
    })

export type AgentLifecycleEvent = Extract<AgentEvent, { readonly type: AgentLifecycleEventType }>
export type AgentStartedEvent = Extract<AgentEvent, { readonly type: "agent.started" }>
export type AgentActionRequestedEvent = Extract<AgentEvent, { readonly type: "agent.action-requested" }>
export type AgentActionCompletedEvent = Extract<AgentEvent, { readonly type: "agent.action-completed" }>
export type AgentObservationEvent = Extract<AgentEvent, { readonly type: "agent.observation" }>
export type AgentApprovalRequestedEvent = Extract<AgentEvent, { readonly type: "agent.approval-requested" }>
export type AgentApprovalDecidedEvent = Extract<AgentEvent, { readonly type: "agent.approval-decided" }>
export type AgentCompletedEvent = Extract<AgentEvent, { readonly type: "agent.completed" }>
export type AgentFailedEvent = Extract<AgentEvent, { readonly type: "agent.failed" }>
export type AgentCancelledEvent = Extract<AgentEvent, { readonly type: "agent.cancelled" }>

export const COMPUTER_EVENT_TYPES = [
  "computer.connected",
  "computer.disconnected",
  "computer.observation",
  "computer.action",
  "computer.approval-requested",
  "computer.approval-decided",
  "computer.error",
] as const

export type ComputerEventType = (typeof COMPUTER_EVENT_TYPES)[number]

export type ComputerEvent =
  | {
      readonly id: string
      readonly timestamp: Timestamp
      readonly type: "computer.connected"
      readonly computer: ComputerInfo
      readonly metadata?: Metadata
    }
  | {
      readonly id: string
      readonly timestamp: Timestamp
      readonly type: "computer.disconnected"
      readonly computerId?: string
      readonly reason?: string
      readonly metadata?: Metadata
    }
  | {
      readonly id: string
      readonly timestamp: Timestamp
      readonly type: "computer.observation"
      readonly observation: Observation
      readonly metadata?: Metadata
    }
  | {
      readonly id: string
      readonly timestamp: Timestamp
      readonly type: "computer.action"
      readonly action: ComputerAction
      readonly result?: ActionResult
      readonly metadata?: Metadata
    }
  | {
      readonly id: string
      readonly timestamp: Timestamp
      readonly type: "computer.approval-requested"
      readonly scope: PermissionScope
      readonly requestId?: string
      readonly metadata?: Metadata
    }
  | {
      readonly id: string
      readonly timestamp: Timestamp
      readonly type: "computer.approval-decided"
      readonly decision: ApprovalDecision
      readonly requestId?: string
      readonly metadata?: Metadata
    }
  | {
      readonly id: string
      readonly timestamp: Timestamp
      readonly type: "computer.error"
      readonly error: ActionError
      readonly metadata?: Metadata
    }

export type ComputerConnectedEvent = Extract<ComputerEvent, { readonly type: "computer.connected" }>
export type ComputerDisconnectedEvent = Extract<ComputerEvent, { readonly type: "computer.disconnected" }>
export type ComputerObservationEvent = Extract<ComputerEvent, { readonly type: "computer.observation" }>
export type ComputerActionEvent = Extract<ComputerEvent, { readonly type: "computer.action" }>
export type ComputerApprovalRequestedEvent = Extract<ComputerEvent, { readonly type: "computer.approval-requested" }>
export type ComputerApprovalDecidedEvent = Extract<ComputerEvent, { readonly type: "computer.approval-decided" }>
export type ComputerErrorEvent = Extract<ComputerEvent, { readonly type: "computer.error" }>

export type ProtocolEvent = ModelEvent | AgentEvent | ComputerEvent
export type Event = ProtocolEvent

export type ProtocolRole = Role
export type ProtocolSource = Source
export type ProtocolBackend = Backend
export type ProtocolBackendId = BackendId
export type ProtocolActionType = ActionType
export type ProtocolElementState = State
export type ProtocolCapabilityState = CapabilityState
export type ProtocolCapability = Capability
export type ProtocolCapabilitySupport = CapabilitySupport
export type ProtocolUIElement = UIElement
export type ProtocolElementReference = ElementReference
export type ProtocolObservation = Observation
export type ProtocolEnvironment = Environment
export type ProtocolComputerInfo = ComputerInfo
export type ProtocolComputerProvider = ComputerProvider
export type ProtocolComputerDriver = ComputerDriver
export type ProtocolComputerAction = ComputerAction
export type ProtocolActionDescriptor = ActionDescriptor
export type ProtocolFindRequest = FindRequest
export type ProtocolFindResult = FindResult
export type ProtocolActionResult = ActionResult
export type ProtocolVerification = Verification
export type ProtocolPermissionScope = PermissionScope
export type ProtocolApprovalDecision = ApprovalDecision
export type ProtocolProvenance = Provenance
export type ProtocolTrustLevel = TrustLevel
export type ProtocolModelEvent = ModelEvent
export type ProtocolAgentEvent = AgentEvent
export type ProtocolComputerEvent = ComputerEvent
export type ProtocolActionError = ActionError
export type ProtocolScreenshot = Screenshot
export type ProtocolMetadata = Metadata
export type ProtocolJsonValue = JsonValue

export type { JsonValue as SerializableValue }
