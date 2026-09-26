export const OMNIA_SCOPES = [
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

export type OmniaScope = (typeof OMNIA_SCOPES)[number]

export const PERMISSION_STATES = ["granted", "denied", "prompt"] as const
export type PermissionState = (typeof PERMISSION_STATES)[number]

export const APPROVAL_POLICIES = [
  "always_ask",
  "ask_destructive",
  "ask_outside_workspace",
  "auto_safe",
  "fully_autonomous",
] as const

export type ApprovalPolicy = (typeof APPROVAL_POLICIES)[number]

export const DESTRUCTIVE_SCOPES: readonly OmniaScope[] = ["UI_CONTROL", "KEYBOARD", "POINTER", "FILES_WRITE", "FILES_DELETE", "PROCESS_EXECUTE"]

const DEFAULT_STATES: Record<OmniaScope, PermissionState> = {
  SCREEN_READ: "prompt",
  UI_READ: "granted",
  UI_CONTROL: "prompt",
  KEYBOARD: "prompt",
  POINTER: "prompt",
  CLIPBOARD_READ: "prompt",
  CLIPBOARD_WRITE: "prompt",
  FILES_READ: "prompt",
  FILES_WRITE: "prompt",
  FILES_DELETE: "prompt",
  PROCESS_READ: "prompt",
  PROCESS_EXECUTE: "prompt",
  NETWORK: "prompt",
  BROWSER: "prompt",
  SECRETS: "denied",
}

export interface PermissionDescription {
  readonly scope: OmniaScope
  readonly state: PermissionState
  readonly description: string
}

export interface PermissionDecision {
  readonly allowed: boolean
  readonly status: "granted" | "permission_required" | "denied"
  readonly required: readonly OmniaScope[]
  readonly missing: readonly OmniaScope[]
  readonly reason?: string
}

export interface ApprovalInput {
  readonly approved?: boolean
  readonly approvedBy?: string
  readonly scopes?: readonly OmniaScope[]
  readonly policy?: ApprovalPolicy
}

const SCOPE_DESCRIPTIONS: Record<OmniaScope, string> = {
  SCREEN_READ: "Capture the screen or individual windows.",
  UI_READ: "Read the semantic interface tree of applications.",
  UI_CONTROL: "Invoke controls and change application state.",
  KEYBOARD: "Send keyboard input.",
  POINTER: "Move and click the pointer.",
  CLIPBOARD_READ: "Read clipboard contents.",
  CLIPBOARD_WRITE: "Write clipboard contents.",
  FILES_READ: "Read files.",
  FILES_WRITE: "Create or modify files.",
  FILES_DELETE: "Delete files.",
  PROCESS_READ: "List and inspect processes.",
  PROCESS_EXECUTE: "Start processes and run commands.",
  NETWORK: "Make network requests.",
  BROWSER: "Operate browser sessions.",
  SECRETS: "Access stored credentials and secrets.",
}

export function isOmniaScope(value: unknown): value is OmniaScope {
  return typeof value === "string" && (OMNIA_SCOPES as readonly string[]).includes(value)
}

export function describePermissions(states: Readonly<Record<OmniaScope, PermissionState>>): PermissionDescription[] {
  return OMNIA_SCOPES.map((scope) => ({
    scope,
    state: states[scope],
    description: SCOPE_DESCRIPTIONS[scope],
  }))
}

export class PermissionManager {
  private states: Record<OmniaScope, PermissionState>
  private readonly grants = new Map<string, Set<OmniaScope>>()
  private policy: ApprovalPolicy

  constructor(
    initial: Partial<Record<OmniaScope, PermissionState>> = {},
    policy: ApprovalPolicy = "ask_destructive",
  ) {
    this.states = { ...DEFAULT_STATES, ...initial }
    this.policy = policy
  }

  state(scope: OmniaScope): PermissionState {
    return this.states[scope]
  }

  set(scope: OmniaScope, state: PermissionState): void {
    this.states[scope] = state
  }

  setPolicy(policy: ApprovalPolicy): void {
    this.policy = policy
  }

  get approvalPolicy(): ApprovalPolicy {
    return this.policy
  }

  snapshot(): Record<OmniaScope, PermissionState> {
    return { ...this.states }
  }

  grant(sessionId: string, scopes: readonly OmniaScope[]): void {
    const existing = this.grants.get(sessionId) ?? new Set<OmniaScope>()
    for (const scope of scopes) existing.add(scope)
    this.grants.set(sessionId, existing)
  }

  grantedScopes(sessionId: string | undefined): readonly OmniaScope[] {
    if (sessionId === undefined) return []
    return [...(this.grants.get(sessionId) ?? [])]
  }

  evaluate(required: readonly OmniaScope[], options: { sessionId?: string; approval?: ApprovalInput } = {}): PermissionDecision {
    const sessionGrants = new Set(this.grantedScopes(options.sessionId))
    const approvalScopes = new Set(options.approval?.scopes ?? [])
    const missing = required.filter((scope) => {
      if (sessionGrants.has(scope)) return false
      if (options.approval?.approved === true && (approvalScopes.size === 0 || approvalScopes.has(scope))) return false
      return this.states[scope] !== "granted"
    })
    if (missing.length === 0) return { allowed: true, status: "granted", required, missing: [] }

    const denied = missing.filter((scope) => this.states[scope] === "denied" && !approvalScopes.has(scope))
    if (denied.length > 0 && options.approval?.approved !== true) {
      return {
        allowed: false,
        status: "denied",
        required,
        missing,
        reason: `Denied by policy: ${denied.join(", ")}`,
      }
    }

    const destructive = missing.filter((scope) => DESTRUCTIVE_SCOPES.includes(scope))
    const scopeMissing = destructive.length > 0 ? destructive : missing
    if (this.policy === "fully_autonomous" && denied.length === 0) {
      return { allowed: true, status: "granted", required, missing: [] }
    }
    return {
      allowed: false,
      status: "permission_required",
      required,
      missing: scopeMissing,
      reason: `Approval required for: ${scopeMissing.join(", ")}`,
    }
  }

  describe(scope: OmniaScope): string {
    return SCOPE_DESCRIPTIONS[scope]
  }
}

export function requiredScopesForAction(action: string): readonly OmniaScope[] {
  if (action.startsWith("browser_")) return ["BROWSER"]
  if (action.startsWith("office_")) {
    const command = action.slice("office_".length)
    return ["status", "documents", "sheets", "get_cells", "get_cell", "read_text"].includes(command)
      ? ["FILES_READ"]
      : ["FILES_WRITE"]
  }
  if (action === "menu") return ["UI_CONTROL"]
  switch (action) {
    case "observe":
    case "find":
    case "inspect":
    case "read":
    case "read_text":
    case "get_focus":
    case "get_cursor":
    case "get_context":
      return ["UI_READ"]
    case "screenshot":
      return ["SCREEN_READ"]
    case "click":
    case "double_click":
    case "doubleclick":
    case "right_click":
    case "rightclick":
    case "select":
    case "check":
    case "uncheck":
    case "expand":
    case "collapse":
    case "toggle":
    case "focus":
    case "focus_window":
      return ["UI_CONTROL"]
    case "type":
    case "set_value":
    case "setvalue":
      return ["UI_CONTROL", "KEYBOARD"]
    case "key":
    case "keypress":
    case "hotkey":
    case "press_keys":
    case "release_keys":
      return ["KEYBOARD"]
    case "scroll":
    case "drag":
    case "move":
    case "hover":
    case "mouse_down":
    case "mouse_up":
    case "middle_click":
      return ["POINTER"]
    case "screenshot":
      return ["SCREEN_READ"]
    case "launch":
    case "launch_app":
    case "activate_app":
    case "close_app":
      return ["PROCESS_EXECUTE"]
    case "open":
    case "open_url":
    case "open_file":
      return ["PROCESS_EXECUTE"]
    case "copy":
      return ["CLIPBOARD_WRITE"]
    case "paste":
      return ["CLIPBOARD_READ", "UI_CONTROL"]
    case "read_clipboard":
      return ["CLIPBOARD_READ"]
    case "write_clipboard":
    case "paste_table":
      return ["CLIPBOARD_WRITE", "KEYBOARD"]
    case "dismiss":
      return ["UI_CONTROL"]
    case "close":
      return ["PROCESS_EXECUTE"]
    case "wait":
      return []
    default:
      return ["UI_CONTROL"]
  }
}
