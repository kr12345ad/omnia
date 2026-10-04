export const COMPUTER_SCOPES = [
  "SCREEN_READ",
  "UI_READ",
  "UI_CONTROL",
  "KEYBOARD",
  "POINTER",
  "CLIPBOARD_READ",
  "CLIPBOARD_WRITE",
  "FILES_READ",
  "FILES_WRITE",
  "FILES_DELETE",
  "PROCESS_READ",
  "PROCESS_EXECUTE",
  "NETWORK",
  "BROWSER",
  "SECRETS",
] as const

export type ComputerScope = (typeof COMPUTER_SCOPES)[number]

export interface ActionEndpoint {
  elementId?: string
  x?: number
  y?: number
}

export interface ActionExpect {
  text?: string
  window?: string
  file?: string
}

export interface ActionFields {
  action: string
  target?: string
  query?: string
  role?: string
  window?: string
  text?: string
  start?: string
  stop?: string
  endKey?: string
  key?: string
  keys?: readonly string[]
  files?: readonly string[]
  app?: string
  url?: string
  path?: string
  direction?: string
  amount?: number
  button?: string
  rows?: readonly (readonly unknown[])[]
  x?: number
  y?: number
  from?: ActionEndpoint
  to?: ActionEndpoint
  command?: string
  cwd?: string
  timeoutMs?: number
  credential?: string
  field?: "username" | "secret"
  position?: string
  point?: string
  tab?: string
  dialog?: string
  promptText?: string
  expectedType?: string
  expectedMessage?: string
  value?: string
  limit?: number
  observationId?: string
  expect?: ActionExpect
  allowUnverified?: boolean
}

export const TILE_POSITIONS = [
  "left",
  "right",
  "top",
  "bottom",
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
  "center",
] as const

const TILE_POSITION_SET: ReadonlySet<string> = new Set(TILE_POSITIONS)

const UI_READ_ACTIONS = new Set([
  "observe",
  "find",
  "inspect",
  "read",
  "read_text",
  "read_value",
  "get_focus",
  "get_cursor",
  "calibration_status",
  "calibration_start",
])

const UI_CONTROL_ACTIONS = new Set([
  "click",
  "double_click",
  "right_click",
  "select",
  "expand",
  "collapse",
  "toggle",
  "focus",
  "focus_window",
  "dismiss",
  "menu",
  "calibration_save",
  "window_tile",
  "window_move",
  "window_maximize",
  "window_minimize",
  "window_restore",
])

const POINTER_ACTIONS = new Set([
  "scroll",
  "scroll_into_view",
  "drag",
  "move",
  "hover",
  "mouse_down",
  "mouse_up",
  "middle_click",
  "calibration_measure",
])

const KEYBOARD_ACTIONS = new Set(["key", "hotkey", "release_keys"])

const PROCESS_ACTIONS = new Set([
  "launch_app",
  "activate_app",
  "close_app",
  "open_file",
  "open_url",
  "close",
  "window_close",
])

// Source of truth for scope mapping: packages/omnia/src/server/permissions.ts
// requiredScopesForAction. Keep this function in sync with the server:
// window_close=PROCESS_EXECUTE, paste_table includes POINTER, scroll_into_view=POINTER.
export function scopesForAction(action: string): readonly ComputerScope[] {
  if (action === "browser_upload") return ["BROWSER", "FILES_READ"]
  if (action.startsWith("browser_")) return ["BROWSER"]
  if (action === "run_command") return ["PROCESS_EXECUTE"]
  if (action === "credentials") return ["SECRETS"]
  // get_context reports the pointer position and the controlled browser's status
  // next to the accessibility tree, so all three scopes are required by the
  // server. Requesting UI_READ alone is answered with 428.
  if (action === "get_context") return ["UI_READ", "POINTER", "BROWSER"]
  if (UI_READ_ACTIONS.has(action)) return ["UI_READ"]
  if (action === "screenshot") return ["SCREEN_READ"]
  if (UI_CONTROL_ACTIONS.has(action)) return ["UI_CONTROL"]
  if (POINTER_ACTIONS.has(action)) return ["POINTER"]
  if (KEYBOARD_ACTIONS.has(action)) return ["KEYBOARD"]
  if (PROCESS_ACTIONS.has(action)) return ["PROCESS_EXECUTE"]
  if (action === "type" || action === "set_value") return ["UI_CONTROL", "KEYBOARD"]
  if (action === "copy") return ["CLIPBOARD_WRITE"]
  if (action === "paste") return ["CLIPBOARD_READ", "UI_CONTROL"]
  if (action === "read_clipboard") return ["CLIPBOARD_READ"]
  if (action === "write_clipboard") return ["CLIPBOARD_WRITE", "KEYBOARD"]
  if (action === "paste_table") return ["CLIPBOARD_WRITE", "KEYBOARD", "POINTER"]
  if (action === "wait") return []
  return ["UI_CONTROL"]
}

export function scopesForAct(fields: ActionFields): readonly ComputerScope[] {
  const scopes = new Set<ComputerScope>(scopesForAction(fields.action))
  if (fields.credential !== undefined) scopes.add("SECRETS")
  return [...scopes]
}

export function scopesForStep(step: ActionFields): readonly ComputerScope[] {
  const scopes = new Set<ComputerScope>(scopesForAct(step))
  if (step.expect?.file !== undefined) scopes.add("FILES_READ")
  return [...scopes]
}

export function batchScopes(steps: readonly ActionFields[]): readonly ComputerScope[] {
  const scopes = new Set<ComputerScope>()
  for (const step of steps) {
    for (const scope of scopesForStep(step)) scopes.add(scope)
  }
  return [...scopes]
}

const VISUAL_ACTIONS: Record<string, string> = {
  ground: "observe",
  inspect: "observe",
  general: "observe",
  click: "click",
  type: "type",
  scroll: "scroll",
  drag: "drag",
  resize: "drag",
}

export function scopesForVisual(operation: string): readonly ComputerScope[] {
  const scopes = new Set<ComputerScope>(["SCREEN_READ"])
  for (const scope of scopesForAction(VISUAL_ACTIONS[operation] ?? "observe")) scopes.add(scope)
  return [...scopes]
}

export function actPermissionPattern(fields: ActionFields): string {
  return `act:${fields.action}:${permissionLabel(fields)}`
}

export function alwaysPatternsForAct(action: string): string[] {
  return [`act:${action}:*`]
}

export function stepPermissionPatterns(steps: readonly ActionFields[]): string[] {
  return [...new Set(steps.map((step) => `do:${step.action}:*`))]
}

export function alwaysPatternsForSteps(steps: readonly ActionFields[]): string[] {
  return stepPermissionPatterns(steps)
}

export function permissionLabel(fields: ActionFields): string {
  const label =
    fields.action === "run_command"
      ? (shortenCommand(fields.command) ?? "command")
      : (fields.target ?? fields.query ?? fields.window ?? fields.app ?? fields.url ?? fields.path ?? "desktop")
  return label.length > 120 ? `${label.slice(0, 120)}…` : label
}

export function shortenCommand(command: string | undefined): string | undefined {
  if (command === undefined) return undefined
  const first = command.trim().split(/\s+/)[0] ?? ""
  return first.length > 40 ? `${first.slice(0, 40)}…` : first
}

const REDACTED_TEXT_ACTIONS = new Set(["type", "set_value", "write_clipboard"])

export function permissionText(action: string, text: string | undefined): string | undefined {
  if (text === undefined) return undefined
  if (!REDACTED_TEXT_ACTIONS.has(action)) return text
  return `[redacted ${text.length} characters]`
}

export function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url.trim())
}

export function applicationOf(params: { app?: string; applicationId?: string }): string | undefined {
  const app = params.app?.trim()
  if (app !== undefined && app.length > 0) return app
  const applicationId = params.applicationId?.trim()
  return applicationId !== undefined && applicationId.length > 0 ? applicationId : undefined
}

function endpointDefined(endpoint: ActionEndpoint | undefined): boolean {
  if (endpoint === undefined) return false
  if (endpoint.elementId !== undefined && endpoint.elementId.length > 0) return true
  return typeof endpoint.x === "number" && typeof endpoint.y === "number"
}

export function validateAction(fields: ActionFields): void {
  const action = fields.action
  if (action === "type") {
    if ((fields.text === undefined || fields.text.length === 0) && fields.credential === undefined)
      throw new Error("The type action requires text or a stored credential.")
    if (!fields.target && !fields.query && !fields.window)
      throw new Error("The type action requires target, query, or window.")
  }
  if (fields.field !== undefined && fields.field !== "username" && fields.field !== "secret")
    throw new Error('The field must be "username" or "secret".')
  if (action === "set_value" && fields.text === undefined) throw new Error("The set_value action requires text.")
  if (action === "write_clipboard" && (fields.text === undefined || fields.text.length === 0))
    throw new Error("The write_clipboard action requires text.")
  if (action === "key" && !fields.key) throw new Error("The key action requires key.")
  if (action === "hotkey" && (fields.keys === undefined || fields.keys.length === 0) && !fields.key)
    throw new Error("The hotkey action requires keys or key.")
  if (action === "launch_app" || action === "activate_app" || action === "close_app") {
    if (!fields.app) throw new Error(`The ${action} action requires app.`)
  }
  if (action === "open_url") {
    if (!fields.url) throw new Error("The open_url action requires url.")
    if (!isHttpUrl(fields.url)) throw new Error("The open_url action only accepts http:// and https:// URLs.")
  }
  if (action === "open_file" && !fields.path) throw new Error("The open_file action requires path.")
  if (action === "run_command" && (fields.command === undefined || fields.command.trim().length === 0))
    throw new Error("The run_command action requires command.")
  if (action === "focus" && !fields.target && !fields.query)
    throw new Error("The focus action requires target or query.")
  if (action === "focus_window" && !fields.target && !fields.window && !fields.query)
    throw new Error("The focus_window action requires target, window, or query.")
  if (action === "read_text" && !fields.target && !fields.query && !fields.window && !fields.app)
    throw new Error("Reading text requires a target, query, window, or app.")
  if (
    (action === "select" ||
      action === "toggle" ||
      action === "expand" ||
      action === "collapse" ||
      action === "increment" ||
      action === "decrement" ||
      action === "scroll_into_view") &&
    (!fields.target || fields.target.length === 0)
  ) {
    throw new Error(`The ${action} action requires a target element ref from computer_observe or computer_find.`)
  }
  if (
    (action === "click" ||
      action === "double_click" ||
      action === "right_click" ||
      action === "middle_click" ||
      action === "move" ||
      action === "hover") &&
    !fields.target &&
    !fields.query &&
    (fields.x === undefined || fields.y === undefined)
  ) {
    throw new Error(`The ${action} action requires target, query, or x/y coordinates.`)
  }
  if (action === "scroll" && fields.direction === undefined) throw new Error("The scroll action requires direction.")
  if (action === "drag") {
    if (!endpointDefined(fields.from) || !endpointDefined(fields.to))
      throw new Error("The drag action requires from and to endpoints with an elementId or x/y coordinates.")
  }
  if (action === "paste_table" && (fields.rows === undefined || fields.rows.length === 0))
    throw new Error("The paste_table action requires rows.")
  if (action === "window_tile") {
    const position = fields.position ?? fields.text
    if (position !== undefined && !TILE_POSITION_SET.has(position))
      throw new Error(`The window_tile action position must be one of: ${TILE_POSITIONS.join(", ")}.`)
  }
  if (action === "window_move" && (fields.x === undefined || fields.y === undefined))
    throw new Error("The window_move action requires x and y.")
  if (action === "calibration_measure" && fields.point === undefined && fields.text === undefined)
    throw new Error("The calibration_measure action requires point.")
  if (action === "menu" && !fields.query && !fields.text) throw new Error("The menu action requires query.")
  if ((action === "browser_open" || action === "browser_navigate") && !fields.url)
    throw new Error(`The ${action} action requires url.`)
  if (action === "browser_find" && !fields.query) throw new Error("The browser_find action requires query.")
  if (
    action === "browser_click" &&
    !fields.target &&
    !fields.query &&
    (fields.x === undefined || fields.y === undefined)
  ) {
    throw new Error("The browser_click action requires target, query, or x/y coordinates.")
  }
  if (action === "browser_type" && (!fields.target || fields.text === undefined))
    throw new Error("The browser_type action requires target and text.")
  if (action === "browser_key" && !fields.key) throw new Error("The browser_key action requires key.")
  if ((action === "browser_activate_tab" || action === "browser_close_tab") && !fields.tab)
    throw new Error(`The ${action} action requires tab.`)
  if (action === "browser_dialog" && fields.dialog !== "accept" && fields.dialog !== "dismiss")
    throw new Error('The browser_dialog action requires dialog "accept" or "dismiss".')
  if (action === "browser_upload" && (fields.files === undefined || fields.files.length === 0))
    throw new Error("The browser_upload action requires files.")
  if (
    action === "browser_hover" &&
    !fields.target &&
    !fields.query &&
    (fields.x === undefined || fields.y === undefined)
  ) {
    throw new Error("The browser_hover action requires target, query, or x/y coordinates.")
  }
  if (action === "browser_select" && (!fields.target || (fields.value === undefined && fields.text === undefined)))
    throw new Error("The browser_select action requires target and value or text.")
  if (action === "browser_drag" && (!endpointDefined(fields.from) || !endpointDefined(fields.to)))
    throw new Error("The browser_drag action requires from and to endpoints with an elementId or x/y coordinates.")
}
