import type { Bounds } from "../protocol"

export type CuaPlatform = "linux" | "darwin" | "win32"

// Honest accessibility state for an observation. "degraded" covers empty or
// truncated trees that still returned; "unavailable" means the backend could
// not read the tree at all (for example a missing macOS Accessibility grant).
export type CuaAccessibilityState = "available" | "degraded" | "unavailable"

export type CuaDelivery = "background-ax" | "foreground-ax" | "pointer" | "keyboard" | "refused"

export interface CuaElement {
  ref: string
  backendRef: string
  role: string
  name: string
  text?: string
  value?: string
  description?: string
  bounds?: Bounds
  enabled: boolean
  focused: boolean
  editable: boolean
  actions: string[]
  states: string[]
  attributes?: Record<string, string | number | boolean>
  parentRef?: string
  windowRef?: string
  // The owning application as reported by the backend. Windows carry it on the
  // element itself so title-based focus and app aliases can resolve elements
  // even when the backend cannot expose an application node.
  application?: string
  generation: number
}

export interface CuaWindow {
  ref: string
  backendRef: string
  app: string
  title: string
  bounds?: Bounds
  focused: boolean
  // Present and true only when the platform reports the window iconified,
  // minimized, or hidden; the engine verifies minimize against this flag
  // instead of treating a merely unfocused window as minimized.
  minimized?: boolean
  generation: number
}

export interface CuaSnapshot {
  id: string
  generation: number
  takenAt: number
  platform: CuaPlatform
  windows: CuaWindow[]
  elements: CuaElement[]
  focusedRef?: string
  // The virtual screen rectangle. x/y can be negative when a monitor sits left
  // of or above the primary monitor.
  screen?: { x?: number; y?: number; width: number; height: number }
  truncated: boolean
  warnings: string[]
  accessibility?: CuaAccessibilityState
}

export interface CuaRefBinding {
  // Generation-scoped identity: when present, the backend must refuse refs
  // from any other observation/generation instead of rebinding by name.
  readonly observationId?: string
  readonly generation?: number
  // Explicit opt-in to same-name re-resolution when an occurrence index
  // shifted. Without this flag, loose slug matching must refuse.
  readonly allowRebind?: boolean
}

export type CuaAction =
  | ({ type: "invoke"; ref: string; action?: string } & CuaRefBinding)
  | ({ type: "set_value"; ref: string; value: string } & CuaRefBinding)
  | ({ type: "focus"; ref: string } & CuaRefBinding)
  | ({ type: "scroll_into_view"; ref: string } & CuaRefBinding)
  | ({ type: "select"; ref: string } & CuaRefBinding)
  | ({ type: "expand"; ref: string } & CuaRefBinding)
  | ({ type: "collapse"; ref: string } & CuaRefBinding)
  | ({ type: "increment"; ref: string } & CuaRefBinding)
  | ({ type: "decrement"; ref: string } & CuaRefBinding)
  | ({ type: "show_menu"; ref: string } & CuaRefBinding)
  | { type: "dismiss" }
  | {
      type: "click"
      point: { x: number; y: number }
      button?: "left" | "right" | "middle"
      count?: number
      captureId?: string
    }
  | ({ type: "type"; text: string; ref?: string; allowClipboardPaste?: boolean } & CuaRefBinding)
  | { type: "key"; keys: string[] }
  | ({ type: "scroll"; direction: "up" | "down" | "left" | "right"; amount?: number; ref?: string } & CuaRefBinding)
  | { type: "drag"; from: { x: number; y: number }; to: { x: number; y: number }; captureId?: string }
  | ({
      type: "window"
      action: "focus" | "minimize" | "restore" | "close" | "maximize" | "unmaximize" | "tile" | "move"
      ref: string
      position?: string
      x?: number
      y?: number
      width?: number
      height?: number
    } & CuaRefBinding)

export interface CuaStateDelta {
  focusedRef?: string
  addedRefs?: string[]
  removedRefs?: string[]
  changedRefs?: string[]
}

export interface CuaActionResult {
  ok: boolean
  action: CuaAction
  verified: boolean
  message: string
  delivery: CuaDelivery
  generation: number
  stateDelta?: CuaStateDelta
  // A snapshot the backend captured while executing the action. The engine
  // uses it as the post-action state only when it is a distinct, generation-
  // consistent read; it must be complete for the backend's default scope
  // (window/app-scoped refreshes belong in refreshWindow/refreshApplication).
  observation?: CuaSnapshot
  // A post-action delta the backend observed. Used as verification evidence
  // only when its generation is newer than the pre-action snapshot, proving a
  // read happened after the action.
  delta?: CuaStateDelta
  error?: { code: string; message: string; retryable: boolean }
  warnings?: string[]
}

export interface CuaCapabilities {
  snapshot: boolean
  semanticActions: boolean
  backgroundActions: boolean
  backgroundInput: boolean
  pointer: boolean
  keyboard: boolean
  clipboard: boolean
  screenshot: boolean
  windowManagement: boolean
  waitFor: boolean
  refs: boolean
  actions: string[]
  limits: string[]
}

export interface CuaFindQuery {
  name?: string
  role?: string
  text?: string
  window?: string
  limit?: number
}

export interface CuaWaitCondition {
  ref?: string
  role?: string
  name?: string
  text?: string
  state?: string
  windowTitle?: string
  timeoutMs?: number
  pollMs?: number
}

export interface CuaWaitResult {
  ok: boolean
  element?: CuaElement
  waitedMs: number
}

export interface CuaSnapshotOptions {
  app?: string
  maxElements?: number
  includeScreenshot?: boolean
}

export interface CuaBackend {
  readonly platform: CuaPlatform
  readonly name: string
  // The element budget a snapshot() walk uses when maxElements is omitted.
  // The engine needs it to decide whether a cached snapshot covers a request;
  // absent means the shared 1000-element default.
  readonly defaultMaxElements?: number
  available(): Promise<boolean>
  capabilities(): Promise<CuaCapabilities>
  snapshot(options?: CuaSnapshotOptions): Promise<CuaSnapshot>
  find(query: CuaFindQuery, snapshot?: CuaSnapshot): Promise<CuaElement[]>
  execute(action: CuaAction, snapshot?: CuaSnapshot): Promise<CuaActionResult>
  waitFor(condition: CuaWaitCondition): Promise<CuaWaitResult>
  // Optional targeted refresh hooks. When present the engine asks the backend
  // to re-walk only the affected window/application after an action instead of
  // paying for a full snapshot. The returned snapshot must be complete for the
  // backend's default scope (equivalent to snapshot({})); undefined means the
  // refresh is unavailable and the engine falls back to a full snapshot.
  refreshWindow?(ref: string): Promise<CuaSnapshot | undefined>
  refreshApplication?(app: string): Promise<CuaSnapshot | undefined>
  // Optional backend-level cache invalidation. Backends that cache trees keyed
  // by OS generation implement it so callers can force a fresh walk.
  invalidate?(): void
  dispose(): Promise<void>
}
