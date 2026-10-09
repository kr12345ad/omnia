import { ApprovalRegistry, operationFingerprint } from "../security/approval"
import type { OperationInput } from "../security/types"

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
  readonly fingerprint?: string
  readonly policy?: ApprovalPolicy
}

export interface PermissionEvaluationOptions {
  readonly sessionId?: string
  readonly approval?: ApprovalInput
  // The exact operation the caller is asking about. Supplying it lets a
  // fingerprint-bound approval (see /v1/permissions/approve) be matched
  // against the operation instead of trusting a self-asserted boolean.
  readonly operation?: OperationInput
}

export interface PermissionManagerOptions {
  readonly now?: () => number
  readonly approvals?: ApprovalRegistry
  readonly grantTtlMs?: number
  readonly maxSessionGrants?: number
}

const SESSION_GRANT_TTL_MS = 15 * 60 * 1000
const MAX_SESSION_GRANTS = 500

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

interface SessionGrant {
  readonly scopes: Set<OmniaScope>
  readonly expiresAt: number
}

export class PermissionManager {
  private states: Record<OmniaScope, PermissionState>
  private readonly grants = new Map<string, SessionGrant>()
  private policy: ApprovalPolicy
  private readonly now: () => number
  private readonly approvals: ApprovalRegistry | undefined
  private readonly grantTtlMs: number
  private readonly maxSessionGrants: number

  constructor(
    initial: Partial<Record<OmniaScope, PermissionState>> = {},
    policy: ApprovalPolicy = "ask_destructive",
    options: PermissionManagerOptions = {},
  ) {
    this.states = { ...DEFAULT_STATES, ...initial }
    this.policy = policy
    this.now = options.now ?? Date.now
    this.approvals = options.approvals
    this.grantTtlMs = options.grantTtlMs ?? SESSION_GRANT_TTL_MS
    this.maxSessionGrants = options.maxSessionGrants ?? MAX_SESSION_GRANTS
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
    const existing = this.grants.get(sessionId) ?? { scopes: new Set<OmniaScope>(), expiresAt: 0 }
    for (const scope of scopes) existing.scopes.add(scope)
    if (this.grants.size >= this.maxSessionGrants && !this.grants.has(sessionId)) {
      const oldest = this.grants.keys().next().value
      if (oldest !== undefined) this.grants.delete(oldest)
    }
    this.grants.set(sessionId, { scopes: existing.scopes, expiresAt: this.now() + this.grantTtlMs })
  }

  grantedScopes(sessionId: string | undefined): readonly OmniaScope[] {
    if (sessionId === undefined) return []
    const grant = this.grants.get(sessionId)
    if (grant === undefined) return []
    if (grant.expiresAt <= this.now()) {
      this.grants.delete(sessionId)
      return []
    }
    return [...grant.scopes]
  }

  evaluate(required: readonly OmniaScope[], options: PermissionEvaluationOptions = {}): PermissionDecision {
    const sessionGrants = new Set(this.grantedScopes(options.sessionId))
    const approval = options.approval
    const approved = approval?.approved === true
    const approvalScopes = new Set((approval?.scopes ?? []).filter(isOmniaScope))
    const operation = options.operation

    // A fingerprint-bound approval is only trusted when it matches both the
    // presented fingerprint and a live grant issued for this exact operation.
    // It stands on its own: the fingerprint is the proof, so approve:true is
    // not required for it. Empty approval scopes never mean "all scopes".
    const bound = (() => {
      if (approval?.fingerprint === undefined || operation === undefined) return false
      if (approval.fingerprint !== operationFingerprint(operation)) return false
      const registry = this.approvals
      if (registry === undefined) return false
      const evaluation = registry.evaluate(operation)
      if (!evaluation.approved || evaluation.grant === undefined) return false
      return registry.consume(evaluation.grant.id, operation).approved
    })()
    // A denied scope is an operator policy decision, so only a grant this
    // server issued can satisfy it: an explicit per-scope session grant or a
    // fingerprint-bound approval. A caller's own approve:true claim is only ever
    // forwarded by the API layer for a server-token caller, and it still stops
    // at "denied" here.
    const approvedScope = (scope: OmniaScope) =>
      sessionGrants.has(scope) || bound || (approved && approvalScopes.has(scope) && this.states[scope] !== "denied")

    const deniedRequired = required.filter((scope) => this.states[scope] === "denied" && !approvedScope(scope))
    const missing = required.filter((scope) => !approvedScope(scope) && this.states[scope] !== "granted")
    if (deniedRequired.length > 0) {
      return {
        allowed: false,
        status: "denied",
        required,
        missing: deniedRequired,
        reason: `Denied by policy: ${deniedRequired.join(", ")}`,
      }
    }
    if (missing.length === 0) return { allowed: true, status: "granted", required, missing: [] }

    const destructive = missing.filter((scope) => DESTRUCTIVE_SCOPES.includes(scope))
    const scopeMissing = destructive.length > 0 ? destructive : missing
    // Autonomy never extends to executing processes or reading secrets: those
    // cross from observing the machine to acting with its credentials, and a
    // single compromised instruction must not be able to spend them silently.
    const neverAutonomous: readonly OmniaScope[] = ["PROCESS_EXECUTE", "SECRETS"]
    const reserved = missing.filter((scope) => neverAutonomous.includes(scope))
    if (reserved.length > 0) {
      return {
        allowed: false,
        status: "permission_required",
        required,
        missing: reserved,
        reason: `Approval required for: ${reserved.join(", ")}`,
      }
    }
    if (this.policy === "fully_autonomous") {
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
  if (action === "browser_upload") return ["BROWSER", "FILES_READ"]
  if (action.startsWith("browser_")) return ["BROWSER"]
  if (action.startsWith("office_")) {
    const command = action.slice("office_".length)
    return ["status", "documents", "sheets", "get_cells", "get_cell", "read_text"].includes(command)
      ? ["FILES_READ"]
      : ["FILES_WRITE"]
  }
  if (action === "menu") return ["UI_CONTROL"]
  if (action === "run_command") return ["PROCESS_EXECUTE"]
  if (action === "credentials") return ["SECRETS"]
  switch (action) {
    case "observe":
    case "find":
    case "inspect":
    case "read":
    case "read_text":
    case "read_value":
    case "get_focus":
    case "get_cursor":
      return ["UI_READ"]
    // get_context reads the pointer position and the controlled browser's
    // status in addition to the accessibility tree.
    case "get_context":
      return ["UI_READ", "POINTER", "BROWSER"]
    case "screenshot":
      return ["SCREEN_READ"]
    case "calibration_status":
    case "calibration_start":
      return ["UI_READ"]
    case "calibration_measure":
      return ["POINTER"]
    case "calibration_save":
      return ["UI_CONTROL"]
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
    case "scroll_into_view":
    case "drag":
    case "move":
    case "hover":
    case "mouse_down":
    case "mouse_up":
    case "middle_click":
      return ["POINTER"]
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
      return ["CLIPBOARD_WRITE", "KEYBOARD"]
    // paste_table clicks the start cell before pasting, so it needs pointer
    // control on top of the clipboard and keyboard scopes.
    case "paste_table":
      return ["CLIPBOARD_WRITE", "KEYBOARD", "POINTER"]
    case "window_tile":
    case "window_move":
    case "window_maximize":
    case "window_minimize":
    case "window_restore":
      return ["UI_CONTROL"]
    case "window_close":
      return ["PROCESS_EXECUTE"]
    case "cua_snapshot":
    case "cua_find":
    case "cua_wait":
      return ["UI_READ"]
    case "cua_act":
      return ["UI_CONTROL"]
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
