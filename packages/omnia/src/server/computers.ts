import { access } from "node:fs/promises"
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, isAbsolute, join, relative, resolve } from "node:path"
import {
  isCapabilitySupport,
  type ActionResult,
  type CapabilitySupport,
  type CommandRequest,
  type CommandResult,
  type Bounds,
  type ComputerAction,
  type ComputerInfo,
  type ComputerTarget,
  type ElementReference,
  type ElementTarget,
  type FindRequest,
  type FindResult,
  type JsonObject,
  type Observation,
  type ObservationRequest,
  type UIElement,
  type Verification,
} from "../protocol"
import {
  requiredScopesForAction,
  type ApprovalInput,
  type OmniaScope,
  type PermissionManager,
  type PermissionState,
} from "./permissions"
import { operationFingerprint } from "../security/approval"
import type { OperationInput } from "../security/types"
import type { EventBus } from "./events"
import type { ComputerCredential, CredentialMatch, CredentialStore } from "../credentials"
import { credentialEnv, redactSecrets } from "../credentials"
import { CdpError } from "../browser/cdp"
import { browserFailure } from "../browser/errors"
import { imageDownloadsDir } from "../browser/image-file"
import { cuaDriverFor } from "../computer-use/service"
import type { CalibrationManager, CalibrationProfile } from "../computer-use/calibration"
import type { CuaWindow } from "../cua/types"
import {
  activeWindowIdFromObservation,
  verifyWindowClosed,
  verifyWindowState,
  type KWinShellRunner,
} from "./kwin-verify"

export type { CommandRequest, CommandResult } from "../protocol"

export interface BrowserTabSummary {
  readonly id: string
  readonly url: string
  readonly title?: string
  readonly active?: boolean
}

export interface BrowserPageSummary {
  readonly url: string
  readonly title: string
  readonly text: string
  readonly length: number
  readonly hash: string
  // Real paging metadata. Controllers backed by the embedded runtime always
  // supply these; legacy/fake controllers may omit them, in which case the
  // server derives fail-closed defaults (offset 0, totalLength=length,
  // truncated=false) instead of silently slicing.
  readonly offset?: number
  readonly totalLength?: number
  readonly truncated?: boolean
  readonly sourceTruncated?: boolean
  readonly viewport?: { readonly width: number; readonly height: number }
  // The document generation the read came from. Reload verification compares
  // this across independent before/after reads; an unchanged URL is not
  // evidence that the page reloaded.
  readonly documentId?: string
}

export interface BrowserElementSummary {
  readonly id: string
  readonly role: string
  readonly name: string
  readonly visible?: boolean
  readonly disabled?: boolean
  readonly score?: number
  readonly rect?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  readonly center?: { readonly x: number; readonly y: number }
}

export interface BrowserImageSummary {
  readonly id: string
  readonly src: string
  readonly alt: string
  readonly width: number
  readonly height: number
  readonly naturalWidth: number
  readonly naturalHeight: number
  readonly visible: boolean
  readonly rect?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  readonly link?: string
}

export interface BrowserImageSave {
  readonly path: string
  readonly bytes: number
  // sha256 of the bytes read back from disk on the machine that wrote them.
  readonly hash?: string
  readonly mimeType?: string
  readonly src: string
  readonly alt: string
  readonly method: "download" | "fetch"
}

export interface BrowserStatusSummary {
  readonly running: boolean
  readonly endpoint?: string
  readonly browser?: string
  readonly tabs: number
}

export interface BrowserDialogSummary {
  readonly type: string
  readonly message: string
  readonly defaultPrompt?: string
  readonly frameUrl?: string
  readonly hasBrowserHandler?: boolean
}

export interface BrowserDialogAnswer {
  readonly tabId?: string
  readonly sessionId?: string
  readonly accept: boolean
  readonly promptText?: string
  readonly expectedType?: string
  readonly expectedMessage?: string
}

export interface BrowserDownloadSummary {
  readonly id: string
  readonly url: string
  readonly filename: string
  readonly path: string
  readonly state: "progressing" | "completed" | "cancelled" | "interrupted"
  readonly receivedBytes: number
  readonly totalBytes: number
  readonly startedAt: number
  readonly finishedAt?: number
  readonly mimeType?: string
  readonly error?: string
}

export interface BrowserAuthChallengeSummary {
  readonly url: string
  readonly host: string
  readonly realm: string
  readonly isProxy: boolean
}

export interface BrowserAuthAnswer {
  readonly username: string
  readonly password: string
}

export interface BrowserController {
  screenshot?(tabId?: string, sessionId?: string): Promise<{ mimeType: string; data: string; viewport?: { width: number; height: number } }>
  status(): Promise<BrowserStatusSummary>
  open(url?: string): Promise<BrowserTabSummary>
  tabs(): Promise<BrowserTabSummary[]>
  activate(tabId: string): Promise<void>
  closeTab(tabId: string): Promise<void>
  navigate(url: string, tabId?: string, sessionId?: string): Promise<BrowserTabSummary>
  read(
    tabId?: string,
    options?: { sessionId?: string; offset?: number; limit?: number; maxChars?: number },
  ): Promise<BrowserPageSummary>
  find(
    query: string,
    options?: { tabId?: string; role?: string; limit?: number; sessionId?: string },
  ): Promise<BrowserElementSummary[]>
  // The embedded/legacy runtimes always implement the image operations. The
  // properties stay optional so partial controllers can be injected, but the
  // server never silently skips them: a missing capability answers an explicit
  // operation_unavailable failure (see executeBrowser).
  images?(tabId?: string, options?: { limit?: number; sessionId?: string }): Promise<BrowserImageSummary[]>
  saveImage?(target: {
    tabId?: string
    id?: string
    url?: string
    query?: string
    path?: string
    filename?: string
    sessionId?: string
    // True when the server already made a FILES_WRITE decision for this path;
    // the runtime still resolves and verifies the final path on the machine
    // that performs the write.
    allowOutside?: boolean
  }): Promise<BrowserImageSave>
  click(target: {
    tabId?: string
    sessionId?: string
    id?: string
    x?: number
    y?: number
    button?: "left" | "right" | "middle"
  }): Promise<{
    clicked: boolean
    name?: string
    role?: string
    x?: number
    y?: number
    rect?: { x: number; y: number; width: number; height: number }
    popup?: { url: string; tabId: string }
  }>
  hover?(target: { tabId?: string; sessionId?: string; id?: string; x?: number; y?: number }): Promise<{
    hovered: boolean
    name?: string
    role?: string
    x?: number
    y?: number
  }>
  select?(
    target: { tabId?: string; sessionId?: string; id: string },
    value?: string,
    text?: string,
  ): Promise<{ selected: boolean; value?: string }>
  drag?(
    from: { tabId?: string; sessionId?: string; id?: string; x?: number; y?: number },
    to: { tabId?: string; sessionId?: string; id?: string; x?: number; y?: number },
  ): Promise<{ dragged: boolean; method?: "drag_events" | "mouse" }>
  // Scroll is optional like hover: partial controllers stay injectable, and the
  // server answers an explicit operation_unavailable when it is missing.
  scroll?(input: {
    tabId?: string
    sessionId?: string
    deltaX?: number
    deltaY?: number
    x?: number
    y?: number
  }): Promise<void>
  // The scrolled offset after a wheel event. The scroll case reads it before
  // and after so verification is an independent measurement, not trust in the
  // dispatched input.
  scrollPosition?(input: { tabId?: string; sessionId?: string }): Promise<{ x: number; y: number }>
  type(target: { tabId?: string; sessionId?: string; id?: string; x?: number; y?: number; text: string }): Promise<{ typed: boolean; value?: string }>
  // Optional independent value read-back. Sensitive fields answer
  // `sensitive: true` without a value so verification can never echo a secret.
  readValue?(target: { tabId?: string; sessionId?: string; id: string }): Promise<{ value?: string; sensitive?: boolean }>
  key(key: string, tabId?: string, sessionId?: string): Promise<void>
  back(tabId?: string, sessionId?: string): Promise<void>
  forward(tabId?: string, sessionId?: string): Promise<void>
  reload(tabId?: string, sessionId?: string): Promise<void>
  // Page JavaScript dialogs (alert/confirm/prompt/beforeunload). Optional so
  // partial controllers can be injected; executeBrowser fails closed when the
  // capability is missing, and pre-checks pendingDialog before other actions.
  pendingDialog?(tabId?: string, sessionId?: string): Promise<BrowserDialogSummary | null>
  handleDialog?(input: BrowserDialogAnswer): Promise<{ handled: boolean }>
  // Downloads and HTTP auth challenges. Optional so partial controllers can be
  // injected; executeBrowser fails closed when a capability is missing.
  downloads?(): Promise<BrowserDownloadSummary[]>
  authRequired?(): Promise<BrowserAuthChallengeSummary | null>
  answerAuth?(input: BrowserAuthAnswer): Promise<{ answered: boolean }>
  upload?(files: readonly string[], tabId?: string, sessionId?: string): Promise<{ files: string[] }>
  currentTab?(sessionId?: string): string | undefined
}

export interface Revalidation {
  readonly valid: boolean
  readonly reason?: string
}

export type InputGrabReleasedBy = "escape" | "signal" | "request"

export interface InputGrabEvent {
  readonly type: "frozen" | "released"
  readonly releasedBy?: InputGrabReleasedBy
  readonly reason?: string
}

export interface InputFreezeOutcome {
  readonly frozen: boolean
  readonly supported: boolean
  readonly mode?: string
  readonly error?: string
}

export interface InputReleaseOutcome {
  readonly frozen: boolean
  readonly supported: boolean
  readonly releasedBy: "escape" | "request"
  readonly error?: string
}

export interface InputStateOutcome {
  readonly frozen: boolean
  readonly supported: boolean
  readonly reason?: string
  readonly releasedBy?: InputGrabReleasedBy
}

export interface ServerComputerDriver {
  readonly id: string
  readonly backend: string
  cua?: unknown
  readonly browser?: BrowserController
  getInfo(): Promise<ComputerInfo>
  capabilities(): readonly CapabilitySupport[]
  observe(request?: ObservationRequest): Promise<Observation>
  find(request: FindRequest): Promise<FindResult>
  execute(action: ComputerAction): Promise<ActionResult>
  runCommand?(request: CommandRequest): Promise<ActionResult & { command?: CommandResult }>
  connect?(): Promise<ActionResult>
  disconnect?(): Promise<ActionResult>
  readText?(input: { elementId?: string; application?: string; limit?: number }): Promise<
    ActionResult & { text?: string; length?: number; hash?: string }
  >
  readClipboard?(): Promise<ActionResult & { text?: string; length?: number; hash?: string }>
  writeClipboard?(text: string): Promise<ActionResult>
  writeClipboardImage?(path: string): Promise<ActionResult>
  pointerPosition?(): Promise<ActionResult & { x?: number; y?: number; held?: boolean }>
  hoverPointer?(x: number, y: number, holdMs?: number): Promise<ActionResult>
  mouseDown?(button?: number): Promise<ActionResult>
  mouseUp?(button?: number): Promise<ActionResult>
  releaseStuckKeys?(): Promise<ActionResult>
  grabInput?(reason?: string): Promise<ActionResult & { frozen?: boolean; supported?: boolean; mode?: string }>
  releaseInput?(): Promise<
    ActionResult & { frozen?: boolean; releasedBy?: InputGrabReleasedBy; supported?: boolean; mode?: string }
  >
  inputGrabState?(): Promise<
    ActionResult & { frozen?: boolean; supported?: boolean; reason?: string; releasedBy?: InputGrabReleasedBy }
  >
  subscribeInputGrab?(listener: (event: InputGrabEvent) => void): () => void
  dispose?(): void | Promise<void>
  revalidateTarget?(reference: ElementReference): Promise<Revalidation>
}

export interface ComputerSummary {
  readonly id: string
  readonly name: string
  readonly platform: string
  readonly architecture?: string
  readonly backend: string
  readonly driver: string
  readonly connected: boolean
  readonly capabilities: readonly CapabilitySupport[]
  readonly permissions?: Readonly<Record<OmniaScope, PermissionState>>
  readonly lastSeen?: number
}

export type Computer = ComputerSummary

export interface ExecuteContext {
  readonly sessionId?: string
  readonly approved?: boolean
  readonly approvedBy?: string
  readonly approvedScopes?: readonly OmniaScope[]
  readonly approvalFingerprint?: string
  readonly origin?: "desktop" | "agent"
}

export interface DragEndpoint {
  readonly elementId?: string
  readonly x?: number
  readonly y?: number
}

export interface ServerActionRequest {
  readonly action: string
  // Set when the server itself resolved a window from a title/app fragment in
  // this same request; such targets were validated against a fresh observation
  // and must not be re-rejected by a second stale check.
  readonly windowResolved?: boolean
  readonly target?: ElementReference
  readonly query?: string
  readonly role?: string
  readonly window?: string
  readonly tab?: string
  // browser_dialog: answer the pending page dialog. expectedType/expectedMessage
  // make the answer fail closed when the dialog changed since it was observed.
  readonly dialog?: string
  readonly promptText?: string
  readonly expectedType?: string
  readonly expectedMessage?: string
  readonly from?: DragEndpoint
  readonly to?: DragEndpoint
  // browser_scroll: wheel deltas in CSS pixels; at least one must be non-zero.
  readonly deltaX?: number
  readonly deltaY?: number
  readonly value?: string
  readonly x?: number
  readonly y?: number
  readonly region?: Bounds
  readonly text?: string
  readonly files?: readonly string[]
  readonly start?: string
  readonly stop?: string
  readonly endKey?: string
  readonly key?: string
  readonly keys?: readonly string[]
  readonly app?: string
  readonly url?: string
  readonly path?: string
  readonly direction?: string
  readonly amount?: number
  readonly limit?: number
  readonly doc?: string
  readonly sheet?: string
  readonly range?: string
  readonly cell?: string
  readonly name?: string
  readonly type?: string
  readonly title?: string
  readonly rows?: readonly (readonly (string | number | boolean | null)[])[]
  readonly items?: readonly { readonly text: string; readonly style?: string }[]
  readonly bold?: boolean
  readonly background?: string
  readonly wrap?: boolean
  readonly fontSize?: number
  readonly index?: number
  readonly count?: number
  readonly width?: number
  readonly height?: number
  readonly button?: string
  readonly command?: string
  readonly cwd?: string
  readonly timeoutMs?: number
  readonly credential?: string
  // Which part of a stored credential a type/browser_type action types:
  // "secret" (default) or "username". Ignored for run_command.
  readonly field?: string
  // browser_auth: explicit credentials used when no stored credential is
  // selected. The stored secret always wins when a credential is resolved.
  readonly username?: string
  readonly password?: string
  // browser_auth: fail closed when the pending challenge is for another host.
  readonly expectedHost?: string
  // browser_login: explicit field targets so the model can drive a form whose
  // controls have no usable accessible name. Both accept a page element id or a
  // query. When omitted the runtime discovers them by name.
  readonly usernameField?: string
  readonly passwordField?: string
  // browser_login: set false to fill the form without submitting (two-factor
  // pages, forms with a separate submit step).
  readonly submit?: boolean
  // browser_login: what a signed-in page looks like (text on the page or a URL
  // fragment). Without it the action can never report a verified login.
  readonly expect?: StepExpectation
  // browser_login: the first page asks only for the identifier and a later page
  // asks for the secret (Google, Apple, SSO portals). Opt-in, so an unrelated
  // form with an email box is never treated as a sign-in step.
  readonly identifierFirst?: boolean
  readonly approve?: boolean
  readonly approvedBy?: string
  readonly approvedScopes?: readonly OmniaScope[]
  readonly approvalFingerprint?: string
  readonly sessionId?: string
  readonly origin?: "desktop" | "agent"
  // Observation the caller's target came from. Preserved from the API body
  // (both top-level and target.observationId) and enforced fail-closed:
  // a mismatch answers target_stale instead of acting on a stale element.
  readonly observationId?: string
  // Browser read paging. Forwarded from the API body to the browser runtime;
  // the page answers real paging metadata (offset/totalLength/truncated)
  // instead of silently slicing.
  readonly offset?: number
  readonly maxChars?: number
  // Server-internal cancellation probe (client disconnect). Never parsed from
  // an API body; executeBatch threads its own shouldStop through each step.
  readonly shouldStop?: () => boolean
}

export interface StepExpectation {
  readonly text?: string
  readonly window?: string
  readonly file?: string
  // browser_login: the caller states what a signed-in page looks like. A login
  // cannot be proven by the login action alone, because a rejected login also
  // navigates away from the form.
  readonly urlContains?: string
}

export interface ServerBatchStep extends ServerActionRequest {
  readonly expect?: StepExpectation
  // Per-step escape from fail-closed verification. Default false: an
  // unverified step fails unless the caller explicitly opts into accepting
  // unverified outcomes for that step.
  readonly allowUnverified?: boolean
}

export interface BatchStepResult {
  readonly index: number
  readonly action: string
  readonly success: boolean
  // Fail-closed contract for agents: true only when verification.status is
  // "verified". Agents must treat verified===false as failed unless the step
  // set allowUnverified:true (the tool agent implements that client side).
  readonly verified: boolean
  readonly allowUnverified?: boolean
  readonly message?: string
  readonly target?: { readonly role?: string; readonly name?: string }
  readonly resolvedBy?: string
  readonly confidence?: number
  readonly verification?: Verification
  readonly stateDelta?: StateDelta
  readonly error?: ActionResult["error"]
}

export interface BatchResult {
  readonly success: boolean
  // Fail-closed contract: true only when every executed step verified (or
  // explicitly allowed unverified). Agents treat verified===false as failed.
  readonly verified: boolean
  readonly completed: number
  readonly total: number
  readonly failedAt?: number
  readonly steps: readonly BatchStepResult[]
  readonly message: string
}

const AMBIGUITY_GAP = 0.08

export interface TypeSlice {
  readonly text: string
  readonly error?: string
}

// The model can bound exactly what gets typed: `start` skips everything before
// the marker, `stop` ends immediately after the marker. A marker that is not
// found types nothing instead of risking a run-on.
export function sliceTypeText(text: string, start?: string, stop?: string): TypeSlice {
  let value = text
  if (start !== undefined && start.length > 0) {
    const index = value.indexOf(start)
    if (index < 0) return { text: "", error: `The start marker "${truncateMarker(start)}" is not in the text; nothing was typed.` }
    value = value.slice(index)
  }
  if (stop !== undefined && stop.length > 0) {
    const index = value.indexOf(stop)
    if (index < 0) return { text: "", error: `The stop marker "${truncateMarker(stop)}" is not in the text; nothing was typed.` }
    value = value.slice(0, index + stop.length)
  }
  return { text: value }
}

function truncateMarker(value: string): string {
  return value.length > 40 ? `${value.slice(0, 37)}…` : value
}

// Redaction needles include the truncation lengths used by state snapshots
// (120) and readback evidence (80) so a long secret cannot leak as a prefix.
// JSON-escaped forms cover values held as JSON string literals.
function credentialRedactionNeedles(secret: string): string[] {
  if (secret.length === 0) return []
  const needles = new Set<string>([secret, JSON.stringify(secret).slice(1, -1)])
  for (const length of [80, 120]) {
    if (secret.length <= length) continue
    const prefix = secret.slice(0, length)
    needles.add(prefix)
    needles.add(JSON.stringify(prefix).slice(1, -1))
  }
  return [...needles].filter((needle) => needle.length > 0)
}

function redactValueSecrets(value: unknown, needles: readonly string[]): unknown {
  if (typeof value === "string") return redactSecrets(value, needles)
  if (Array.isArray(value)) return value.map((entry) => redactValueSecrets(entry, needles))
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactValueSecrets(entry, needles)]))
  }
  return value
}

// Defense in depth: a driver or verifier that echoes the typed value still
// cannot place the stored secret into the model-visible result.
function redactResultCredential(result: ActionResult, credential: ComputerCredential): ActionResult {
  const needles = credentialRedactionNeedles(credential.secret)
  if (needles.length === 0) return result
  return redactValueSecrets(result, needles) as ActionResult
}

export interface ServerBatchRequest {
  readonly steps: readonly ServerBatchStep[]
  readonly stopOnError?: boolean
  readonly shouldStop?: () => boolean
  readonly approve?: boolean
  readonly approvedBy?: string
  readonly approvedScopes?: readonly OmniaScope[]
  readonly approvalFingerprint?: string
  readonly sessionId?: string
  readonly origin?: "desktop" | "agent"
  readonly resumeFrom?: number
}

export interface ElementDelta {
  readonly id?: string
  readonly role?: string
  readonly name?: string
  readonly fields?: readonly string[]
  readonly before?: Readonly<Record<string, string>>
  readonly after?: Readonly<Record<string, string>>
}

export interface StateDelta {
  readonly added: readonly { readonly id?: string; readonly role?: string; readonly name?: string }[]
  readonly removed: readonly { readonly id?: string; readonly role?: string; readonly name?: string }[]
  readonly changed: readonly ElementDelta[]
  readonly hasChanges: boolean
  readonly summary: string
  readonly highlights: readonly string[]
}

const MAX_DELTA_ITEMS = 20
const MAX_FIELD_CHARS = 120

// Launching, opening, activating, and closing are asynchronous at the desktop
// level: the window appears or disappears after the call returns, so the
// verification observation has to wait briefly before comparing state.
const SETTLE_ACTIONS = new Set(["launch", "launch_app", "open", "open_url", "open_file", "activate_app", "close_app"])
const SETTLE_DELAY_MS = 1200

// Window-management actions must NOT use generic observation-diff
// verification: any unrelated delta (clock tick, pointer move) used to mark
// a title-bar minimize/close as verified while the window stayed open.
// These actions require positive KWin/AT-SPI state (see kwin-verify.ts).
const WINDOW_MANAGEMENT_ACTIONS = new Set([
  "close",
  "close_app",
  "focus",
  "focus_window",
  "activate_app",
  "minimize",
  "restore",
  "maximize",
])

// Window management (tile, move, maximize, minimize, restore, close) is
// resolved through the Cua engine so it works for both AT-SPI and X11-only
// windows. Only these window_* actions exist; anything else must 400 rather
// than falling through to window_close under the wrong scope.
export const WINDOW_ACTION_SCOPES: Readonly<Record<string, readonly OmniaScope[]>> = {
  window_tile: requiredScopesForAction("window_tile"),
  window_move: requiredScopesForAction("window_move"),
  window_maximize: requiredScopesForAction("window_maximize"),
  window_minimize: requiredScopesForAction("window_minimize"),
  window_restore: requiredScopesForAction("window_restore"),
  window_close: requiredScopesForAction("window_close"),
}

// Prioritized window matching for the fragment the caller supplied: exact
// title, then exact app, then title substring, then app substring. A window
// fragment always wins over a caller element id, and a caller id is only
// honored when it names a window in the same fresh snapshot, so a stale or
// forged ref cannot retarget the action.
function matchWindowFragment(windows: readonly CuaWindow[], fragment: string): CuaWindow | undefined {
  const exactTitle = windows.find((window) => window.title.toLowerCase() === fragment)
  if (exactTitle !== undefined) return exactTitle
  const exactApp = windows.find((window) => window.app.toLowerCase() === fragment)
  if (exactApp !== undefined) return exactApp
  const titleMatch = windows.find((window) => window.title.toLowerCase().includes(fragment))
  if (titleMatch !== undefined) return titleMatch
  return windows.find((window) => window.app.toLowerCase().includes(fragment))
}

// App aliases let an agent say "libreoffice" or "files" and still match the
// window manager's binary class (soffice, dolphin).
const APP_ALIASES: Readonly<Record<string, readonly string[]>> = {
  libreoffice: ["soffice", "libreoffice"],
  soffice: ["soffice", "libreoffice"],
  "libreoffice calc": ["soffice"],
  "libreoffice writer": ["soffice"],
  "libreoffice impress": ["soffice"],
  files: ["dolphin", "nautilus", "files"],
  dolphin: ["dolphin", "files"],
  terminal: ["konsole", "kitty", "alacritty", "gnome-terminal", "xterm"],
  konsole: ["konsole", "terminal"],
  kitty: ["kitty", "terminal"],
  browser: ["firefox", "chrome", "chromium"],
  firefox: ["firefox", "browser"],
  chrome: ["chrome", "chromium", "browser"],
}

function aliasTerms(fragment: string): string[] {
  const terms = new Set<string>([fragment])
  for (const alias of APP_ALIASES[fragment] ?? []) terms.add(alias)
  for (const [key, values] of Object.entries(APP_ALIASES)) {
    if (values.includes(fragment)) terms.add(key)
  }
  return [...terms]
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// Ranked matching: exact name/app beat prefixes, prefixes beat word-boundary,
// word-boundary beats loose substring. Zero means no match.
function windowMatchScore(element: UIElement, fragment: string): number {
  const name = String(element.name ?? "").toLowerCase()
  const application = String(element.metadata?.application ?? element.metadata?.app ?? "").toLowerCase()
  let best = 0
  for (const term of aliasTerms(fragment)) {
    const escaped = escapeRegExp(term)
    const word = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`)
    if (name === term) best = Math.max(best, 100)
    else if (application === term) best = Math.max(best, 90)
    else if (name.startsWith(term)) best = Math.max(best, 70)
    else if (application.startsWith(term)) best = Math.max(best, 60)
    else if (word.test(name)) best = Math.max(best, 50)
    else if (word.test(application)) best = Math.max(best, 40)
    else if (name.includes(term)) best = Math.max(best, 30)
    else if (application.includes(term)) best = Math.max(best, 20)
  }
  return best
}

// `readText({ application })` reaches the daemon's AT-SPI text reader, which
// only knows AT-SPI application names -- never X11 WM classes. When a matched
// window has no element id, resolve the AT-SPI app for the same window by
// title and require metadata.atspiPath (proof the element came from the
// AT-SPI tree, not the X11 merge). Ambiguous or WM-class-only values resolve
// to undefined so the caller answers a clear rejection instead of a 500.
function atspiApplicationName(observation: Observation | undefined, window: UIElement): string | undefined {
  const title = String(window.name ?? "").trim().toLowerCase()
  if (title.length === 0) return undefined
  const candidates = new Set<string>()
  for (const element of observation?.elements ?? []) {
    const application = element.metadata?.application
    if (typeof application !== "string" || application.length === 0) continue
    if (element.metadata?.atspiPath === undefined) continue
    if (String(element.name ?? "").trim().toLowerCase() !== title) continue
    candidates.add(application)
  }
  return candidates.size === 1 ? [...candidates][0] : undefined
}

function label(element: UIElement): { id?: string; role?: string; name?: string } {
  const name = element.name ?? element.label ?? element.text
  return {
    ...(element.id === undefined ? {} : { id: element.id }),
    ...(element.role === undefined ? {} : { role: element.role }),
    ...(name === undefined ? {} : { name: name.slice(0, MAX_FIELD_CHARS) }),
  }
}

function fieldSnapshot(element: UIElement): Record<string, string> {
  const snapshot: Record<string, string> = {}
  if (typeof element.name === "string" && element.name.length > 0) snapshot.name = element.name.slice(0, MAX_FIELD_CHARS)
  if (typeof element.text === "string" && element.text.length > 0) snapshot.text = element.text.slice(0, MAX_FIELD_CHARS)
  if (element.value !== undefined) snapshot.value = JSON.stringify(element.value).slice(0, MAX_FIELD_CHARS)
  if ((element.states ?? []).length > 0) snapshot.states = (element.states ?? []).join(",")
  return snapshot
}

// Same field comparison computeStateDelta uses, scoped to one element so a
// truncated observation can still verify the action that targeted it.
function elementChangedFields(before: UIElement | undefined, after: UIElement): string[] {
  if (before === undefined) return []
  return ["name", "value", "text", "states"].filter(
    (field) => JSON.stringify(before[field as keyof UIElement]) !== JSON.stringify(after[field as keyof UIElement]),
  )
}

function describeChange(element: UIElement, fields: readonly string[], before: UIElement): string {
  const name = element.name ?? element.label ?? element.role ?? "element"
  if (fields.includes("value") && element.value !== undefined) {
    return `field "${name}" now reads ${JSON.stringify(JSON.stringify(element.value).slice(0, MAX_FIELD_CHARS))}`
  }
  if (fields.includes("text")) {
    const beforeLength = typeof before.text === "string" ? before.text.length : 0
    const afterLength = typeof element.text === "string" ? element.text.length : 0
    return `text of "${name}" changed (${beforeLength} → ${afterLength} chars)`
  }
  if (fields.includes("name")) return `${element.role ?? "element"} renamed to "${element.name ?? ""}"`
  if (fields.includes("states")) {
    return `"${name}" states changed to [${(element.states ?? []).join(", ")}]`
  }
  return `${element.role ?? "element"} "${name}" changed`
}

export function computeStateDelta(previous: Observation | undefined, current: Observation | undefined): StateDelta {
  const before = new Map((previous?.elements ?? []).map((element) => [element.id ?? "", element]))
  const after = new Map((current?.elements ?? []).map((element) => [element.id ?? "", element]))
  const addedElements = [...after.entries()].filter(([id]) => id !== "" && !before.has(id)).map(([, element]) => element)
  const removedElements = [...before.entries()].filter(([id]) => id !== "" && !after.has(id)).map(([, element]) => element)
  // Built in a single pass so the change list and its highlight sources can
  // never drift out of alignment.
  const changedSources = [...after.entries()].flatMap(([id, element]) => {
    if (id === "") return []
    const prior = before.get(id)
    if (!prior) return []
    const fields = ["name", "value", "text", "states"].filter(
      (field) => JSON.stringify(prior[field as keyof UIElement]) !== JSON.stringify(element[field as keyof UIElement]),
    )
    if (fields.length === 0) return []
    const change: ElementDelta = { ...label(element), fields, before: fieldSnapshot(prior), after: fieldSnapshot(element) }
    return [{ change, prior, element }]
  })
  const changed = changedSources.map((entry) => entry.change)

  const highlights: string[] = []
  for (const element of addedElements) {
    const name = element.name ?? element.label
    if (element.role === "window") highlights.push(`window "${name ?? "untitled"}" appeared`)
    else if (element.role === "dialog") highlights.push(`dialog "${name ?? "untitled"}" opened`)
    else if (element.role === "menu" || element.role === "menuitem") continue
    else if (name !== undefined) highlights.push(`${element.role ?? "element"} "${name}" appeared`)
  }
  for (const element of removedElements) {
    const name = element.name ?? element.label
    if (element.role === "window") highlights.push(`window "${name ?? "untitled"}" closed`)
    else if (element.role === "dialog") highlights.push(`dialog "${name ?? "untitled"}" closed`)
  }
  for (const entry of changedSources) {
    highlights.push(describeChange(entry.element, entry.change.fields ?? [], entry.prior))
  }

  const hasChanges = addedElements.length > 0 || removedElements.length > 0 || changed.length > 0
  const summary =
    highlights.length > 0
      ? highlights.slice(0, 4).join("; ") + (highlights.length > 4 ? `; +${highlights.length - 4} more` : "")
      : hasChanges
        ? `${addedElements.length} added, ${removedElements.length} removed, ${changed.length} changed`
        : "No observable state change"
  return {
    added: addedElements.slice(0, MAX_DELTA_ITEMS).map((element) => label(element)),
    removed: removedElements.slice(0, MAX_DELTA_ITEMS).map((element) => label(element)),
    changed: changed.slice(0, MAX_DELTA_ITEMS),
    hasChanges,
    summary,
    highlights: highlights.slice(0, 8),
  }
}

// Actions where any state change is not evidence: the required field must
// have actually changed, so an unrelated delta (clock tick, pointer move)
// cannot verify the action.
const ACTION_EVIDENCE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  type: ["value", "text"],
  set_value: ["value", "text"],
  setvalue: ["value", "text"],
  toggle: ["value", "states", "name"],
  check: ["value", "states", "name"],
  uncheck: ["value", "states", "name"],
  select: ["value", "states", "name", "text"],
}

// Read-only plan steps never mutate state, so their success is itself the
// evidence. They report verified on success instead of forcing an
// observation-diff that would always be unverified (no state change is
// expected from a read).
const BATCH_READ_ONLY_ACTIONS = new Set([
  "observe",
  "find",
  "inspect",
  "read",
  "read_text",
  "read_value",
  "get_focus",
  "get_cursor",
  "get_context",
  "screenshot",
  "browser_read",
  "browser_find",
  "browser_images",
  "browser_tabs",
  "browser_status",
  "calibration_status",
  "calibration_start",
  "calibration_measure",
  "calibration_save",
  "cua_snapshot",
  "cua_find",
  "cua_wait",
  "credentials",
  "read_clipboard",
])

export function verifyOutcome(
  result: ActionResult,
  delta: StateDelta,
  action?: string,
  targetId?: string,
): Verification {
  if (!result.success) {
    return { status: "failed", message: result.message ?? "The action did not succeed.", method: "observation-diff" }
  }
  const requiredFields = action === undefined ? undefined : ACTION_EVIDENCE_FIELDS[action]
  // FAIL-CLOSED, target-scoped verification: when the caller named a target,
  // only that target's own change counts. An unrelated delta (clock tick,
  // pointer move, or another element's text change) must never verify the
  // action. The delta carries element ids (see computeStateDelta/label) so the
  // check is scoped to the exact element the action addressed.
  if (targetId !== undefined && targetId.length > 0) {
    const targetChange = delta.changed.find((change) => change.id === targetId)
    const targetAdded = delta.added.find((item) => item.id === targetId)
    const targetRemoved = delta.removed.find((item) => item.id === targetId)
    if (requiredFields !== undefined) {
      const fields = targetChange?.fields ?? []
      const matched = fields.some((field) => requiredFields.includes(field))
      if (!matched) {
        return {
          status: "unverified",
          message: `The ${action} action was sent to ${targetId}, but ${requiredFields.join("/")} did not change on that target.`,
          method: "observation-diff",
        }
      }
      return {
        status: "verified",
        message: `Observed target change on ${targetId}: ${delta.summary}`,
        method: "observation-diff",
        evidence: [
          { kind: "state-delta", value: delta.summary },
          {
            kind: "state-changes",
            value: JSON.stringify({ target: targetId, fields, added: delta.added, removed: delta.removed, changed: delta.changed }).slice(0, 2000),
          },
        ],
      }
    }
    if (targetChange !== undefined || targetAdded !== undefined || targetRemoved !== undefined) {
      return {
        status: "verified",
        message: `Observed target change on ${targetId}: ${delta.summary}`,
        method: "observation-diff",
        evidence: [
          { kind: "state-delta", value: delta.summary },
          {
            kind: "state-changes",
            value: JSON.stringify({ target: targetId, added: delta.added, removed: delta.removed, changed: delta.changed }).slice(0, 2000),
          },
        ],
      }
    }
    return {
      status: "unverified",
      message: `The action targeted ${targetId}, but that target did not change; an unrelated state change cannot verify it.`,
      method: "observation-diff",
    }
  }
  // No target to scope to. Required-field actions cannot be verified from an
  // untargeted diff: any element's field change would otherwise verify the
  // action. Fail closed here; targeted readbacks (text-readback etc.) remain
  // the independent evidence for these actions.
  if (requiredFields !== undefined) {
    return {
      status: "unverified",
      message: `The ${action} action was sent, but there is no target to verify ${requiredFields.join("/")} against.`,
      method: "observation-diff",
    }
  }
  if (delta.hasChanges) {
    return {
      status: "verified",
      message: `Observed state change: ${delta.summary}`,
      method: "observation-diff",
      evidence: [
        { kind: "state-delta", value: delta.summary },
        {
          kind: "state-changes",
          value: JSON.stringify({ added: delta.added, removed: delta.removed, changed: delta.changed }).slice(0, 2000),
        },
      ],
    }
  }
  return {
    status: "unverified",
    message: "The action was sent, but no observable state change was detected yet.",
    method: "observation-diff",
  }
}

// Driver self-verification is only evidence when its method is an independent
// readback (a second read of the world, not the driver's own claim that it
// acted). A driver that answers verified with method "driver",
// "observation-diff", undefined, or any other non-readback must not verify:
// the server falls through to its own target-scoped diff and fails closed.
const INDEPENDENT_DRIVER_METHODS = new Set([
  "text-readback",
  "clipboard-readback",
  "observation-readback",
  "driver-readback",
  "cua-snapshot",
  "menu-item-diff",
  "exit-code",
  "browser-url-readback",
  "browser-click-readback",
  "browser-history-readback",
  "browser-reload-readback",
  "browser-value-readback",
  "atspi-focus",
  "kwin-dbus",
  "x11-net-wm-state",
  "observation",
  "cua-state-delta",
])

export function isIndependentDriverVerification(verification: Verification | undefined): boolean {
  if (verification === undefined || verification.status !== "verified") return false
  const method = verification.method ?? ""
  if (INDEPENDENT_DRIVER_METHODS.has(method)) return true
  // Browser readbacks share one prefix; allow future browser-*-readback
  // methods without enumerating each one.
  return method.startsWith("browser-") && method.endsWith("-readback")
}

// Windows and dialogs are listed before the accessibility-element budget is
// applied, so a structural element that appears in a truncated observation was
// really added near the head of the tree, not hidden at the cut.
const STRUCTURAL_ADDITION_ROLES = new Set(["window", "dialog", "alert", "alertdialog"])

const INCOMPLETE_OBSERVATION_MESSAGE =
  "The observation was incomplete (truncated), so the action outcome cannot be confirmed from the state diff."

// Verification when either observation was truncated. A truncated full-tree
// diff is only partly trustworthy: an element beyond the cut is missing from
// one side, so it looks removed (truncated after) or added (truncated before)
// even though nothing changed. Verification therefore falls back to
// action-local evidence: the exact element the action targeted, a structural
// window/dialog appearing, a change to an element observed both times, or the
// driver's own pointer readback. When the action's target cannot be found or
// nothing local changed, the outcome stays unverified so an unrelated delta can
// never verify a truncated action.
export function verifyIncompleteOutcome(input: {
  readonly result: ActionResult
  readonly action: string
  readonly request: ServerActionRequest
  readonly before?: Observation
  readonly after?: Observation
  readonly delta: StateDelta
}): Verification {
  if (!input.result.success)
    return verifyOutcome(input.result, input.delta, input.action, input.request.target?.elementId)
  const unverified = (message: string): Verification => ({ status: "unverified", message, method: "observation-diff" })
  const targetId = input.request.target?.elementId
  if (targetId !== undefined && targetId.length > 0) {
    const target = (input.after?.elements ?? []).find((element) => element.id === targetId)
    if (target === undefined) {
      return unverified(
        `The observation was incomplete (truncated) and the action target ${targetId} is missing from it, so the outcome cannot be confirmed.`,
      )
    }
    const prior = (input.before?.elements ?? []).find((element) => element.id === targetId)
    const fields = elementChangedFields(prior, target)
    const required = ACTION_EVIDENCE_FIELDS[input.action]
    const matched = required === undefined ? fields : required.filter((field) => fields.includes(field))
    if (prior !== undefined && matched.length > 0) {
      return {
        status: "verified",
        message: `Observed target change: ${describeChange(target, fields, prior)}`,
        method: "observation-diff",
        evidence: [{ kind: "state-delta", value: JSON.stringify({ target: targetId, fields }) }],
      }
    }
    return unverified(
      required === undefined
        ? `The observation was incomplete (truncated) and the action target ${targetId} did not change, so the outcome cannot be confirmed.`
        : `The ${input.action} action was sent to ${targetId}, but ${required.join("/")} did not change in the truncated observation.`,
    )
  }
  const readback = pointerReadback(input.action, input.result)
  if (readback !== undefined) return readback
  const hasBaseline = input.before !== undefined
  const structural = hasBaseline && input.delta.added.some((item) => item.role !== undefined && STRUCTURAL_ADDITION_ROLES.has(item.role))
  const changed = hasBaseline && input.delta.changed.length > 0
  const removed = hasBaseline && input.after !== undefined && !observationIncomplete(input.after) && input.delta.removed.length > 0
  if (!structural && !changed && !removed) return unverified(INCOMPLETE_OBSERVATION_MESSAGE)
  return {
    status: "verified",
    message: `Observed state change: ${input.delta.summary}`,
    method: "observation-diff",
    evidence: [
      { kind: "state-delta", value: input.delta.summary },
      {
        kind: "state-changes",
        value: JSON.stringify({ added: input.delta.added, removed: input.delta.removed, changed: input.delta.changed }).slice(0, 2000),
      },
    ],
  }
}

// Pointer input is not observable in the accessibility tree; the driver's own
// readback (the post-action pointer position, or the point a move was
// delivered to) is the action-local evidence for a truncated observation.
function pointerReadback(action: string, result: ActionResult): Verification | undefined {
  if (action !== "move" && action !== "click" && action !== "doubleclick" && action !== "rightclick" && action !== "middle_click") {
    return undefined
  }
  const metadata = result.metadata as Record<string, unknown> | undefined
  const actualX = metadata?.["actualX"]
  const actualY = metadata?.["actualY"]
  if (typeof actualX === "number" && typeof actualY === "number") {
    return {
      status: "verified",
      message: `The driver read the pointer back at ${actualX},${actualY}.`,
      method: "driver-readback",
      evidence: [{ kind: "pointer-readback", value: JSON.stringify({ x: actualX, y: actualY }) }],
    }
  }
  if (action !== "move") return undefined
  // A pointer move has no state to observe; the driver's acknowledgement that
  // the move was delivered is the action-local evidence, with the readback
  // position when the driver reports one.
  const x = metadata?.["x"]
  const y = metadata?.["y"]
  return typeof x === "number" && typeof y === "number"
    ? {
        status: "verified",
        message: `The driver moved the pointer to ${x},${y}.`,
        method: "driver-readback",
        evidence: [{ kind: "pointer-readback", value: JSON.stringify({ x, y }) }],
      }
    : {
        status: "verified",
        message: "The driver confirmed the pointer move.",
        method: "driver-readback",
        evidence: [{ kind: "pointer-readback", value: "move" }],
      }
}

export interface ComputerManagerOptions {
  readonly events: EventBus
  readonly permissions: PermissionManager
  readonly now?: () => number
  readonly browser?: BrowserController
  readonly credentials?: CredentialStore
  // Display calibration is applied to element-derived points, which never pass
  // through the API's explicit-coordinate calibration (api.ts calibrateFields).
  readonly calibration?: CalibrationManager
  readonly onObservation?: (input: { computerId: string; applicationId?: string; observation: Observation }) => void
  readonly onSessionActivity?: (input: { sessionId: string; computerId: string; action: string; at: number }) => void
}

export interface ManagedComputer {
  readonly id: string
  readonly driver: ServerComputerDriver
  connectedAt: number
  lastSeen: number
  lastObservation?: Observation
  grabFrozen: boolean
  grabEvents: number
  stopSeq: number
  stopped: boolean
  stoppedReason?: string
}

export interface ExecuteOutcome {
  readonly httpStatus: number
  readonly result: ActionResult
}

const MAX_STORED_OBSERVATION_ELEMENTS = 2000
const MAX_ELEMENT_IDENTITIES = 50000
const MAX_BROWSER_TAB_SESSIONS = 500
const MAX_SESSION_TABS = 64

// Sentinel returned by raceStop when control was stopped while a driver call
// was still in flight. The driver call itself cannot be aborted (the driver
// contract takes no signal), but the server stops waiting on it and answers
// "cancelled" instead of treating a late completion as the action result.
const STOPPED = Symbol("computer-stopped")

export class ComputerManager {
  private readonly computers = new Map<string, ManagedComputer>()
  private readonly identities = new Map<string, { role?: string; name?: string }>()
  private readonly executeLocks = new Map<string, Promise<void>>()
  private readonly browserTabs = new WeakMap<ManagedComputer, WeakMap<BrowserController, Map<string, Set<string>>>>()
  private readonly events: EventBus
  private readonly permissions: PermissionManager
  private readonly now: () => number
  private readonly browser: BrowserController | undefined
  private readonly credentials: CredentialStore | undefined
  private readonly calibration: CalibrationManager | undefined
  private readonly onObservation: ComputerManagerOptions["onObservation"]
  private readonly onSessionActivity: ComputerManagerOptions["onSessionActivity"]

  constructor(options: ComputerManagerOptions) {
    this.events = options.events
    this.permissions = options.permissions
    this.now = options.now ?? Date.now
    this.browser = options.browser
    this.credentials = options.credentials
    this.calibration = options.calibration
    this.onObservation = options.onObservation
    this.onSessionActivity = options.onSessionActivity
  }

  register(driver: ServerComputerDriver, info?: Partial<ComputerSummary>): () => void {
    if (typeof driver?.id !== "string" || driver.id.trim().length === 0) {
      throw new TypeError("A computer driver id is required.")
    }
    if (this.computers.has(driver.id)) {
      throw new Error(`Computer ${driver.id} is already registered.`)
    }
    const at = this.now()
    const computer: ManagedComputer = {
      id: driver.id,
      driver,
      connectedAt: at,
      lastSeen: at,
      grabFrozen: false,
      grabEvents: 0,
      stopSeq: 0,
      stopped: false,
    }
    this.computers.set(driver.id, computer)
    this.events.emit("computer.connected", {
      computerId: driver.id,
      data: { backend: driver.backend, name: info?.name ?? driver.id },
    })
    const unsubscribeGrab = driver.subscribeInputGrab?.((event) => {
      computer.grabEvents += 1
      if (event.type === "frozen") {
        computer.grabFrozen = true
        this.events.emit("input.frozen", {
          computerId: driver.id,
          data: { mode: "x11", ...(event.reason === undefined ? {} : { reason: event.reason }) },
        })
        return
      }
      computer.grabFrozen = false
      this.events.emit("input.released", {
        computerId: driver.id,
        data: { releasedBy: event.releasedBy ?? "request" },
      })
    })
    return () => {
      unsubscribeGrab?.()
      // A freeze must never outlive its driver: the grab is released and the
      // helper is killed when the computer is unregistered or the server stops.
      void driver.releaseInput?.().catch(() => undefined)
      // dispose may be async per the driver contract, and an unregister is fire
      // and forget: a rejection here would be an unhandled rejection that takes
      // the whole server down during shutdown.
      void Promise.resolve(driver.dispose?.()).catch(() => undefined)
      // Only remove the entry this registration owns: a re-registration of the
      // same id must not have its replacement torn down by the old handle.
      if (this.computers.get(driver.id) !== computer) return
      this.computers.delete(driver.id)
      this.events.emit("computer.disconnected", { computerId: driver.id })
    }
  }

  async list(): Promise<ComputerSummary[]> {
    return Promise.all(this.ids().map((id) => this.summary(id))).then((summaries) =>
      summaries.filter((summary): summary is ComputerSummary => summary !== undefined),
    )
  }

  get(id: string): ManagedComputer | undefined {
    return this.computers.get(id)
  }

  ids(): string[] {
    return [...this.computers.keys()]
  }

  async summary(id: string): Promise<ComputerSummary | undefined> {
    const computer = this.computers.get(id)
    if (!computer) return undefined
    const info = await computer.driver.getInfo().catch(() => undefined)
    const architecture = info?.architecture ?? info?.arch
    return {
      id: computer.id,
      name: info?.name ?? computer.id,
      platform: info?.platform ?? "",
      ...(architecture === undefined ? {} : { architecture }),
      backend: computer.driver.backend,
      driver: computer.driver.id,
      connected: info?.connected !== false && !computer.stopped,
      capabilities: await this.capabilities(id),
      lastSeen: computer.lastSeen,
    }
  }

  async capabilities(id: string): Promise<readonly CapabilitySupport[]> {
    const computer = this.computers.get(id)
    if (!computer) return []
    // Drivers may expose capabilities as a method (server contract) or as an
    // array property (the protocol ComputerDriver contract). The value is
    // untrusted: validate every entry and drop malformed ones instead of
    // casting them through.
    const capabilities = computer.driver.capabilities as unknown
    const resolved = typeof capabilities === "function" ? (capabilities as () => unknown).call(computer.driver) : capabilities
    if (!Array.isArray(resolved)) return []
    return resolved.filter(isCapabilitySupport)
  }

  async connect(id: string): Promise<ExecuteOutcome> {
    const computer = this.computers.get(id)
    if (!computer) {
      return { httpStatus: 404, result: { success: false, status: "unavailable", message: `Unknown computer ${id}.` } }
    }
    const outcome = await computer.driver.connect?.()
    if (outcome !== undefined && !outcome.success) return { httpStatus: 500, result: outcome }
    computer.stopped = false
    delete computer.stoppedReason
    computer.lastSeen = this.now()
    this.events.emit("computer.connected", {
      computerId: id,
      data: { backend: computer.driver.backend, name: computer.driver.id, requested: true },
    })
    return {
      httpStatus: 200,
      result: {
        success: true,
        status: "success",
        message: `Connected to ${id}.`,
        ...(outcome ?? {}),
      },
    }
  }

  async disconnect(id: string): Promise<ExecuteOutcome> {
    const computer = this.computers.get(id)
    if (!computer) {
      return { httpStatus: 404, result: { success: false, status: "unavailable", message: `Unknown computer ${id}.` } }
    }
    const outcome = await computer.driver.disconnect?.()
    if (outcome !== undefined && !outcome.success) return { httpStatus: 500, result: outcome }
    computer.stopped = true
    computer.stoppedReason = "disconnected"
    computer.stopSeq += 1
    await computer.driver.releaseInput?.().catch(() => undefined)
    computer.grabFrozen = false
    this.events.emit("computer.disconnected", { computerId: id, data: { requested: true } })
    return {
      httpStatus: 200,
      result: {
        success: true,
        status: "success",
        message: `Disconnected from ${id}.`,
        ...(outcome ?? {}),
      },
    }
  }

  async stop(id: string, options: { reason?: string; sessionId?: string } = {}): Promise<ExecuteOutcome> {
    const computer = this.computers.get(id)
    if (!computer) {
      return { httpStatus: 404, result: { success: false, status: "unavailable", message: `Unknown computer ${id}.` } }
    }
    computer.stopped = true
    computer.stopSeq += 1
    if (options.reason !== undefined) computer.stoppedReason = options.reason
    let releasedInput = false
    if (computer.driver.releaseInput) {
      const released = await computer.driver.releaseInput().catch(() => undefined)
      releasedInput = released?.success === true
      computer.grabFrozen = false
    }
    await computer.driver.releaseStuckKeys?.().catch(() => undefined)
    this.events.emit("computer.stopped", {
      computerId: id,
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      data: {
        ...(options.reason === undefined ? {} : { reason: options.reason }),
        releasedInput,
      },
    })
    this.events.emit("action.cancelled", {
      computerId: id,
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      data: { reason: options.reason ?? "emergency stop", releasedInput },
    })
    return {
      httpStatus: 200,
      result: {
        success: true,
        status: "cancelled",
        message: `Stopped computer control on ${id}.`,
        metadata: { releasedInput, stopped: true },
      },
    }
  }

  async freezeInput(computerId: string | undefined, reason?: string): Promise<InputFreezeOutcome> {
    if (computerId === undefined) {
      return { frozen: false, supported: false, error: "Freezing physical input needs an explicit computer id." }
    }
    const computer = this.inputComputer(computerId)
    if (!computer || !computer.driver.grabInput) {
      return { frozen: false, supported: false, error: "Freezing physical input is not available on this computer." }
    }
    const result = await computer.driver.grabInput(reason)
    // Only an explicit frozen:true counts. A driver that answers success
    // without the flag has not confirmed the grab.
    if (!result.success) {
      return {
        frozen: false,
        supported: result.supported !== false,
        ...(result.mode === undefined ? {} : { mode: result.mode }),
        error: result.message ?? "Freezing physical input failed.",
      }
    }
    if (result.frozen !== true) {
      return {
        frozen: false,
        supported: result.supported !== false,
        ...(result.mode === undefined ? {} : { mode: result.mode }),
        error: "The runtime did not confirm that physical input was frozen.",
      }
    }
    computer.lastSeen = this.now()
    computer.grabFrozen = true
    if (!computer.driver.subscribeInputGrab) {
      this.events.emit("input.frozen", {
        computerId: computer.id,
        data: { mode: result.mode ?? "x11", ...(reason === undefined ? {} : { reason }) },
      })
    }
    return { frozen: true, supported: true, mode: result.mode ?? "x11" }
  }

  async releaseInput(computerId?: string): Promise<InputReleaseOutcome> {
    if (computerId === undefined) {
      return { frozen: false, supported: false, releasedBy: "request", error: "Releasing physical input needs an explicit computer id." }
    }
    const computer = this.inputComputer(computerId)
    if (!computer || !computer.driver.releaseInput) {
      return { frozen: false, supported: false, releasedBy: "request" }
    }
    const wasFrozen = computer.grabFrozen
    const eventsBefore = computer.grabEvents
    const result = await computer.driver.releaseInput()
    const releasedBy = result.releasedBy === "escape" ? "escape" : "request"
    const notified = computer.grabEvents > eventsBefore
    computer.grabFrozen = false
    if (!result.success) {
      return {
        frozen: false,
        supported: result.supported !== false,
        releasedBy,
        error: result.message ?? "Releasing physical input failed.",
      }
    }
    computer.lastSeen = this.now()
    // A driver with an event subscription reports its own releases, including
    // the double-Escape escape hatch; only emit when the request was the first
    // to learn about the release and the driver stayed silent.
    if (wasFrozen && !notified) {
      this.events.emit("input.released", { computerId: computer.id, data: { releasedBy } })
    }
    return { frozen: false, supported: result.supported !== false, releasedBy }
  }

  async inputState(computerId?: string): Promise<InputStateOutcome> {
    if (computerId === undefined) {
      return { frozen: false, supported: false, reason: "Reading physical input state needs an explicit computer id." }
    }
    const computer = this.inputComputer(computerId)
    if (!computer || !computer.driver.inputGrabState) {
      return { frozen: false, supported: false, reason: "Freezing physical input is not available on this computer." }
    }
    const result = await computer.driver.inputGrabState()
    return {
      frozen: result.frozen === true,
      supported: result.success && result.supported !== false,
      ...(result.reason === undefined ? {} : { reason: result.reason }),
      ...(result.releasedBy === undefined ? {} : { releasedBy: result.releasedBy }),
    }
  }

  // Input grabbing is a machine-level operation: an omitted computer id must
  // not silently pick the first input-capable driver, because that can freeze
  // input on the wrong host. Callers must name the computer.
  private inputComputer(computerId?: string): ManagedComputer | undefined {
    if (computerId === undefined) return undefined
    return this.computers.get(computerId)
  }

  async observe(id: string, request?: ObservationRequest): Promise<Observation> {
    const computer = this.requireComputer(id)
    const observation = await computer.driver.observe(request)
    this.storeObservation(computer, observation)
    this.remember(id, observation)
    this.onObservation?.({
      computerId: id,
      ...(request?.applicationId === undefined ? {} : { applicationId: request.applicationId }),
      observation,
    })
    computer.lastSeen = this.now()
    this.events.emit("observation.created", {
      computerId: id,
      data: {
        observationId: observation.id,
        elements: observation.elements?.length ?? 0,
        warnings: observation.warnings ?? [],
      },
    })
    return observation
  }

  async find(id: string, request: FindRequest): Promise<FindResult> {
    const computer = this.requireComputer(id)
    const result = await computer.driver.find(request)
    computer.lastSeen = this.now()
    if (result.observation !== undefined) this.remember(id, result.observation)
    for (const match of result.matches ?? result.results ?? []) this.rememberElement(id, match.element)
    const fragment = request.window?.trim().toLowerCase()
    if (fragment === undefined || fragment.length === 0) return result
    const inWindow = (element: UIElement) => windowMatchScore(element, fragment) > 0
    return {
      ...result,
      ...(result.matches === undefined ? {} : { matches: result.matches.filter((match) => inWindow(match.element)) }),
      ...(result.results === undefined ? {} : { results: result.results.filter((match) => inWindow(match.element)) }),
      ...(result.elements === undefined ? {} : { elements: result.elements.filter(inWindow) }),
    }
  }

  async execute(id: string, request: ServerActionRequest): Promise<ExecuteOutcome> {
    // Serialize per computer: concurrent executions would otherwise share
    // lastObservation and verify each other's changes.
    const previous = this.executeLocks.get(id) ?? Promise.resolve()
    const run = previous.then(
      () => this.executeInternal(id, request),
      () => this.executeInternal(id, request),
    )
    this.executeLocks.set(id, run.then(
      () => undefined,
      () => undefined,
    ))
    return run
  }

  private approvalInput(request: Pick<ServerActionRequest, "approve" | "approvedBy" | "approvedScopes" | "approvalFingerprint">): ApprovalInput {
    return {
      approved: request.approve === true,
      ...(request.approvedBy === undefined ? {} : { approvedBy: request.approvedBy }),
      ...(request.approvedScopes === undefined ? {} : { scopes: request.approvedScopes }),
      ...(request.approvalFingerprint === undefined ? {} : { fingerprint: request.approvalFingerprint }),
    }
  }

  private actionOperation(actionType: string, id: string, request: ServerActionRequest): OperationInput {
    const resource =
      request.target?.elementId ??
      request.command ??
      request.query ??
      request.app ??
      request.url ??
      request.path ??
      request.window ??
      id
    return {
      action: actionType,
      resources: [resource],
      ...(request.command === undefined ? {} : { command: request.command }),
    }
  }

  private requiredDetails(required: readonly OmniaScope[], missing: readonly OmniaScope[], operation: OperationInput): JsonObject {
    return { missing: [...missing], fingerprint: operationFingerprint(operation) }
  }

  private async executeInternal(id: string, request: ServerActionRequest): Promise<ExecuteOutcome> {
    const computer = this.computers.get(id)
    if (!computer) {
      return {
        httpStatus: 404,
        result: { success: false, status: "unavailable", message: `Unknown computer ${id}.` },
      }
    }
    const actionType = request.action
    if (typeof actionType !== "string" || actionType.length === 0) {
      return { httpStatus: 400, result: { success: false, status: "rejected", message: "The action is required." } }
    }

    if (computer.stopped) {
      const message = computer.stoppedReason ?? "Computer control was stopped."
      return {
        httpStatus: 409,
        result: {
          success: false,
          status: "cancelled",
          message,
          error: { code: "action_cancelled", message, retryable: true },
        },
      }
    }

    // Every action is policy-checked before it can touch the computer.
    // run_command, credentials, window management, and calibration add their
    // own scopes and operations inside their handlers, so they gate themselves
    // (window_* must also reject unknown actions before any permission check).
    // Browser actions gate separately below: the embedded browser UI is the
    // approver for desktop-originated calls, but agent sessions are gated.
    // A type action that selects a stored credential resolves it here so the
    // SECRETS scope is part of the same policy decision.
    // A browser_login fills a form with a stored secret, so it reads the vault.
    // The entitlement has to be settled BEFORE the read, otherwise the highest
    // value gate in the product runs after the credential is already in memory.
    if (actionType.startsWith("browser_") && request.credential !== undefined) {
      const capability = actionType === "browser_login" ? "vault_login" : "browser_automation"
      const denied = await this.denyUnentitled(capability)
      if (denied !== undefined) return denied
    }
    const typedCredential =
      actionType === "type" && request.credential !== undefined
        ? this.resolveTypedCredential(computer, request, actionType)
        : undefined
    if (typedCredential?.failure !== undefined) return typedCredential.failure
    if (
      actionType !== "run_command" &&
      actionType !== "credentials" &&
      !actionType.startsWith("browser_") &&
      !actionType.startsWith("window_") &&
      !actionType.startsWith("calibration_")
    ) {
      const required: readonly OmniaScope[] =
        typedCredential?.credential === undefined
          ? requiredScopesForAction(actionType)
          : [...requiredScopesForAction(actionType), "SECRETS"]
      const operation = this.actionOperation(actionType, id, request)
      const decision = this.permissions.evaluate(required, {
        sessionId: request.sessionId,
        approval: this.approvalInput(request),
        operation,
      })
      this.events.emit("action.requested", {
        computerId: id,
        ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
        data: {
          action: actionType,
          requiredScopes: required,
          ...(typedCredential?.credential === undefined
            ? {}
            : { credentialId: typedCredential.credential.id, credentialName: typedCredential.credential.name }),
        },
      })
      if (!decision.allowed) {
        this.events.emit("permission.requested", {
          computerId: id,
          ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
          data: {
            action: actionType,
            missing: decision.missing,
            reason: decision.reason,
            ...(typedCredential?.credential === undefined
              ? {}
              : { credentialId: typedCredential.credential.id, credentialName: typedCredential.credential.name }),
          },
        })
        return {
          httpStatus: decision.status === "denied" ? 403 : 428,
          result: {
            success: false,
            status: "rejected",
            message: decision.reason ?? "Permission required.",
            error: {
              code: decision.status === "denied" ? "permission_denied" : "permission_required",
              message: decision.reason ?? "Permission required.",
              retryable: decision.status !== "denied",
              details: this.requiredDetails(required, decision.missing, operation),
            },
          },
        }
      }
      if (request.approve === true) {
        this.events.emit("permission.decided", {
          computerId: id,
          ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
          data: { action: actionType, approvedBy: request.approvedBy ?? "session", scopes: required },
        })
      }
    }

    if (actionType === "run_command") {
      return this.executeCommand(computer, request)
    }

    if (actionType === "credentials") {
      return this.executeCredentials(computer, request)
    }

    // Browser actions address their own surface, so they must never pass
    // through desktop query or window resolution.
    if (actionType.startsWith("browser_")) {
      // Desktop-originated calls (no session and no agent origin) stay
      // allowed because the embedded UI is the approver. Any agent-originated
      // call is gated even when the caller omitted a sessionId.
      const browserCredential =
        actionType === "browser_type" || actionType === "browser_login"
          ? request.credential === undefined
            ? undefined
            : this.resolveTypedCredential(computer, request, actionType)
          : actionType === "browser_auth" && request.credential !== undefined
            ? this.resolveCredential(computer, request, actionType)
            : undefined
      if (browserCredential?.failure !== undefined) return browserCredential.failure
      if (request.sessionId !== undefined || request.origin === "agent") {
        const required: readonly OmniaScope[] =
          browserCredential?.credential === undefined
            ? requiredScopesForAction(actionType)
            : [...requiredScopesForAction(actionType), "SECRETS"]
        const operation = this.actionOperation(actionType, id, request)
        const decision = this.permissions.evaluate(required, {
          sessionId: request.sessionId,
          approval: this.approvalInput(request),
          operation,
        })
        this.events.emit("action.requested", {
          computerId: id,
          ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
          data: {
            action: actionType,
            requiredScopes: required,
            ...(browserCredential?.credential === undefined
              ? {}
              : { credentialId: browserCredential.credential.id, credentialName: browserCredential.credential.name }),
          },
        })
        if (!decision.allowed) {
          this.events.emit("permission.requested", {
            computerId: id,
            ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
            data: {
              action: actionType,
              missing: decision.missing,
              reason: decision.reason,
              ...(browserCredential?.credential === undefined
                ? {}
                : { credentialId: browserCredential.credential.id, credentialName: browserCredential.credential.name }),
            },
          })
          return {
            httpStatus: decision.status === "denied" ? 403 : 428,
            result: {
              success: false,
              status: "rejected",
              message: decision.reason ?? "Permission required.",
              error: {
                code: decision.status === "denied" ? "permission_denied" : "permission_required",
                message: decision.reason ?? "Permission required.",
                retryable: decision.status !== "denied",
                details: this.requiredDetails(required, decision.missing, operation),
              },
            },
          }
        }
        if (request.approve === true) {
          this.events.emit("permission.decided", {
            computerId: id,
            ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
            data: { action: actionType, approvedBy: request.approvedBy ?? (request.origin === "agent" ? "agent" : "session"), scopes: required },
          })
        }
      }
      return this.executeBrowser(request, id, browserCredential)
    }

    // Window management and display calibration are server-resolved actions
    // rather than protocol driver actions. Handling them here (instead of
    // inside toComputerAction) makes batch steps in a /do plan behave exactly
    // like standalone /actions calls, including per-step approvals and stop
    // checks.
    if (actionType.startsWith("window_")) return this.executeWindowAction(computer, request)
    if (actionType.startsWith("calibration_")) return this.executeCalibrationAction(computer, request)

    const byQuery = await this.resolveQuery(computer, request)
    if ("error" in byQuery) {
      return { httpStatus: byQuery.status, result: byQuery.error }
    }
    const focused = await this.resolveWindowFocus(computer, byQuery.request)
    if ("error" in focused) {
      return { httpStatus: focused.status, result: focused.error }
    }
    const resolved = await this.resolveApplicationAction(computer, focused.request)
    if ("error" in resolved) {
      return { httpStatus: resolved.status, result: resolved.error }
    }
    const effective = resolved.request
    const effectiveType = effective.action
    const stopSeq = computer.stopSeq
    // computerStopped aborts an in-flight driver call; shouldStop additionally
    // honors client-disconnect probes between driver calls (paste_table, menu).
    const computerStopped = () => computer.stopped || computer.stopSeq !== stopSeq
    const shouldStop = () => computerStopped() || effective.shouldStop?.() === true

    let actionRequest = effective
    if (effectiveType === "type" && typeof effective.text === "string") {
      const slice = sliceTypeText(effective.text, effective.start, effective.stop)
      if (slice.error !== undefined) {
        return {
          httpStatus: 400,
          result: {
            success: false,
            status: "rejected",
            message: slice.error,
            error: { code: "marker_not_found", message: slice.error, retryable: true },
          },
        }
      }
      actionRequest = { ...effective, text: slice.text }
    }

    if (effectiveType === "type" && typedCredential?.value !== undefined) {
      actionRequest = { ...actionRequest, text: typedCredential.value }
    }

    if (effectiveType === "read_text") {
      if (!computer.driver.readText) {
        return {
          httpStatus: 501,
          result: { success: false, status: "unavailable", message: "This computer runtime cannot read text." },
        }
      }
      let elementId = effective.target?.elementId
      let application = effective.app
      let windowMatched = false
      if (elementId === undefined && application === undefined && effective.window !== undefined) {
        const observation = await computer.driver.observe().catch(() => undefined)
        const fragment = effective.window.trim().toLowerCase()
        // Same ranked matcher/aliases as window focus and app resolution, so
        // read_text "libreoffice" or "files" reaches soffice/dolphin too.
        const window = (observation?.elements ?? [])
          .filter((element) => element.role === "window")
          .map((element) => ({ element, score: windowMatchScore(element, fragment) }))
          .filter((entry) => entry.score > 0)
          .sort((a, b) => b.score - a.score)[0]?.element
        windowMatched = window !== undefined
        if (window !== undefined) {
          // Read by element id: the Cua driver collects a window ref's
          // subtree text. A window's `application` metadata is usually an
          // X11 WM class ("libreoffice-calc"), which the AT-SPI daemon does
          // not know, so it must never be forwarded as the application.
          elementId = window.id ?? window.reference?.elementId
          if (elementId === undefined) application = atspiApplicationName(observation, window)
        }
      }
      if (elementId === undefined && application === undefined) {
        const message = windowMatched
          ? `Window "${effective.window ?? ""}" has no element id and no AT-SPI application name; text cannot be read by window.`
          : effective.window !== undefined
            ? `No open window matches "${effective.window}" and no target or app was given.`
            : "Reading text needs a target, query, app, or window."
        return {
          httpStatus: 400,
          result: {
            success: false,
            status: "rejected",
            message,
            error: {
              code: "invalid_action",
              message,
              retryable: true,
            },
          },
        }
      }
      const read = await computer.driver
        .readText({
          ...(elementId === undefined ? {} : { elementId }),
          ...(application === undefined ? {} : { application }),
          ...(effective.limit === undefined ? {} : { limit: effective.limit }),
        })
        .catch(() => undefined)
      if (read === undefined) {
        const message = "Text read failed: the computer runtime did not return a text source."
        return {
          httpStatus: 502,
          result: {
            success: false,
            status: "failed",
            message,
            error: { code: "read_failed", message, retryable: true },
          },
        }
      }
      if (!read.success) return { httpStatus: 500, result: read }
      return {
        httpStatus: 200,
        result: {
          ...read,
          metadata: {
            ...(read.metadata ?? {}),
            ...(read.length === undefined ? {} : { length: read.length }),
            ...(read.hash === undefined ? {} : { hash: read.hash }),
            preview: (read.text ?? "").slice(0, 4000),
          },
        },
      }
    }

    if (effectiveType === "read_value") {
      const elementId = effective.target?.elementId
      const observation = await computer.driver.observe().catch(() => undefined)
      const elements = observation?.elements ?? []
      const element =
        elementId === undefined
          ? elements.find((candidate) => (candidate.states ?? []).includes("focused"))
          : elements.find((candidate) => candidate.id === elementId)
      if (element === undefined) {
        const message =
          elementId === undefined
            ? "No element reports keyboard focus."
            : `Element ${elementId} is not in the current observation.`
        return {
          httpStatus: 404,
          result: {
            success: false,
            status: "rejected",
            message,
            error: { code: "target_not_found", message, retryable: true },
          },
        }
      }
      return {
        httpStatus: 200,
        result: {
          success: true,
          status: "success",
          message: `Value of ${element.role ?? "element"} "${element.name ?? element.id ?? ""}" read.`,
          metadata: {
            ...(element.id === undefined ? {} : { elementId: element.id }),
            ...(element.role === undefined ? {} : { role: element.role }),
            ...(element.name === undefined ? {} : { name: element.name }),
            value: element.value ?? null,
            ...(typeof element.text === "string" ? { text: element.text.slice(0, 2000) } : {}),
            ...(element.metadata?.application === undefined ? {} : { application: element.metadata.application }),
          },
        },
      }
    }

    if (effectiveType === "paste_table") {
      if (!computer.driver.writeClipboard) {
        return {
          httpStatus: 501,
          result: { success: false, status: "unavailable", message: "This computer runtime cannot write the clipboard." },
        }
      }
      const tsv =
        request.text ??
        (request.rows ?? []).map((row) => row.map((value) => (value === null ? "" : String(value))).join("\t")).join("\n")
      if (tsv.length === 0) {
        return {
          httpStatus: 400,
          result: {
            success: false,
            status: "rejected",
            message: "paste_table needs text or rows.",
            error: { code: "invalid_action", message: "paste_table needs text or rows.", retryable: true },
          },
        }
      }
      const written = await computer.driver.writeClipboard(tsv)
      if (!written.success) return { httpStatus: 500, result: written }
      if (shouldStop()) return this.cancelledOutcome(computer, effective)
      if (effective.target?.elementId !== undefined) {
        const focused = await computer.driver.execute({
          type: "click",
          target: { kind: "element", elementId: effective.target.elementId },
        })
        if (!focused.success) return { httpStatus: 500, result: focused }
        if (shouldStop()) return this.cancelledOutcome(computer, effective)
      }
      const pasted = await computer.driver.execute({ type: "key", key: "ctrl+v" })
      if (!pasted.success) return { httpStatus: 500, result: pasted }
      const rows = (request.rows ?? []).length
      const verification = await this.verifyPastedTable(computer, effective, tsv)
      return {
        httpStatus: 200,
        result: {
          success: true,
          status: "success",
          message: `Pasted ${rows > 0 ? `${rows} rows` : `${tsv.length} characters`} from the clipboard.`,
          metadata: { characters: tsv.length, rows },
          verification,
          ...(pasted.observation === undefined ? {} : { observation: pasted.observation }),
        },
      }
    }

    if (effectiveType === "read_clipboard") {
      if (!computer.driver.readClipboard) {
        return {
          httpStatus: 501,
          result: { success: false, status: "unavailable", message: "This computer runtime cannot read the clipboard." },
        }
      }
      const read = await computer.driver.readClipboard()
      if (!read.success) return { httpStatus: 500, result: read }
      return {
        httpStatus: 200,
        result: {
          ...read,
          metadata: {
            ...(read.metadata ?? {}),
            ...(read.length === undefined ? {} : { length: read.length }),
            ...(read.hash === undefined ? {} : { hash: read.hash }),
            preview: (read.text ?? "").slice(0, 4000),
          },
        },
      }
    }

    if (effectiveType === "write_clipboard") {
      if (!computer.driver.writeClipboard) {
        return {
          httpStatus: 501,
          result: { success: false, status: "unavailable", message: "This computer runtime cannot write the clipboard." },
        }
      }
      const written = await computer.driver.writeClipboard(effective.text ?? "")
      const verification = written.success
        ? await this.verifyClipboardWrite(computer, effective.text ?? "")
        : undefined
      return {
        httpStatus: written.success ? 200 : 500,
        result: {
          ...written,
          ...(verification === undefined ? {} : { verification }),
          ...(written.success || written.error !== undefined
            ? {}
            : { error: { code: "action_failed" as const, message: written.message ?? "The clipboard write failed.", retryable: true } }),
        },
      }
    }

    if (effectiveType === "menu") {
      return this.executeMenu(computer, effective, shouldStop)
    }

    if (effectiveType === "inspect") {
      const elementId = effective.target?.elementId
      if (elementId === undefined || elementId.length === 0) {
        return {
          httpStatus: 400,
          result: {
            success: false,
            status: "rejected",
            message: "Inspect needs a target element id or a query.",
            error: { code: "invalid_action", message: "Inspect needs a target element id or a query.", retryable: true },
          },
        }
      }
      const observation = await computer.driver.observe()
      const elements = observation.elements ?? []
      const byId = new Map(elements.flatMap((element) => (element.id === undefined ? [] : [[element.id, element] as const])))
      const element = byId.get(elementId)
      if (element === undefined) {
        return {
          httpStatus: 409,
          result: {
            success: false,
            status: "rejected",
            message: `Element ${elementId} is not in the current observation.`,
            error: { code: "target_stale", message: `Element ${elementId} is not in the current observation.`, retryable: true },
          },
        }
      }
      const ancestors: Array<{ id?: string; role?: string; name?: string }> = []
      let parentId = element.parentId
      let guard = 0
      while (parentId !== undefined && guard < 12) {
        const parent = byId.get(parentId)
        if (parent === undefined) break
        ancestors.push({
          ...(parent.id === undefined ? {} : { id: parent.id }),
          ...(parent.role === undefined ? {} : { role: parent.role }),
          ...(parent.name === undefined ? {} : { name: parent.name }),
        })
        parentId = parent.parentId
        guard += 1
      }
      const children = elements
        .filter((candidate) => candidate.parentId === elementId)
        .slice(0, 25)
        .map((child) => ({
          ...(child.id === undefined ? {} : { id: child.id }),
          ...(child.role === undefined ? {} : { role: child.role }),
          ...(child.name === undefined ? {} : { name: child.name }),
          ...(child.states === undefined ? {} : { states: child.states }),
          ...(child.actions === undefined ? {} : { actions: child.actions }),
        }))
      const bounds = element.bounds
      return {
        httpStatus: 200,
        result: {
          success: true,
          status: "success",
          message: `Inspected ${element.role ?? "element"} "${element.name ?? element.text ?? elementId}".`,
          metadata: {
            element: {
              ...(element.id === undefined ? {} : { id: element.id }),
              ...(element.role === undefined ? {} : { role: element.role }),
              ...(element.name === undefined ? {} : { name: element.name }),
              ...(element.description === undefined ? {} : { description: element.description }),
              ...(element.text === undefined ? {} : { text: element.text.slice(0, 500) }),
              ...(element.value === undefined ? {} : { value: element.value }),
              ...(element.states === undefined ? {} : { states: element.states }),
              ...(element.actions === undefined ? {} : { actions: element.actions }),
              ...(bounds === undefined
                ? {}
                : {
                    bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
                    center: { x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 2) },
                  }),
              ...(element.metadata?.application === undefined ? {} : { application: element.metadata.application }),
              ...(element.source === undefined ? {} : { source: element.source }),
            },
            ancestors,
            children,
          },
        },
      }
    }

    if (effectiveType === "get_context") {
      const [pointer, observation, browserStatus] = await Promise.all([
        computer.driver.pointerPosition?.().catch(() => undefined),
        computer.driver.observe().catch(() => undefined),
        this.browser?.status().catch(() => undefined),
      ])
      const elements = observation?.elements ?? []
      const focused = elements.find((element) => (element.states ?? []).includes("focused"))
      const activeWindow = elements.find(
        (element) => element.role === "window" && (element.states ?? []).includes("focused"),
      )
      const windows = elements
        .filter((element) => element.role === "window")
        .slice(0, 12)
        .map((element) => ({
          name: element.name ?? element.id ?? "window",
          ...(element.metadata?.application === undefined ? {} : { application: element.metadata.application }),
          ...(element.bounds === undefined
            ? {}
            : { bounds: { x: element.bounds.x, y: element.bounds.y, width: element.bounds.width, height: element.bounds.height } }),
        }))
      const describe = (element: (typeof elements)[number] | undefined) =>
        element === undefined
          ? undefined
          : {
              ...(element.role === undefined ? {} : { role: element.role }),
              ...(element.name === undefined ? {} : { name: element.name }),
              ...(typeof element.text === "string" ? { text: element.text.slice(0, 120) } : {}),
              ...(element.id === undefined ? {} : { id: element.id }),
              ...(element.bounds === undefined
                ? {}
                : {
                    center: {
                      x: Math.round(element.bounds.x + element.bounds.width / 2),
                      y: Math.round(element.bounds.y + element.bounds.height / 2),
                    },
                  }),
            }
      return {
        httpStatus: 200,
        result: {
          success: true,
          status: "success",
          message: `At ${activeWindow?.name ?? "the desktop"}${focused === undefined ? "" : `, focus on ${focused.role ?? "element"} "${focused.name ?? focused.text ?? focused.id ?? ""}"`}.`,
          metadata: {
            platform: observation?.environment?.platform ?? "unknown",
            ...(pointer?.x === undefined || pointer.y === undefined
              ? {}
              : { pointer: { x: pointer.x, y: pointer.y, held: pointer.held === true } }),
            ...(describe(activeWindow) === undefined ? {} : { activeWindow: describe(activeWindow)! }),
            ...(describe(focused) === undefined ? {} : { focused: describe(focused)! }),
            windows,
            ...(browserStatus === undefined
              ? {}
              : {
                  browser: {
                    running: browserStatus.running,
                    tabs: browserStatus.tabs,
                    ...(browserStatus.browser === undefined ? {} : { name: browserStatus.browser }),
                    ...(this.browser?.currentTab?.() === undefined ? {} : { currentTab: this.browser.currentTab!() }),
                  },
                }),
          },
        },
      }
    }

    if (effectiveType === "get_cursor") {
      if (!computer.driver.pointerPosition) {
        return {
          httpStatus: 501,
          result: { success: false, status: "unavailable", message: "This computer runtime cannot read the pointer." },
        }
      }
      const position = await computer.driver.pointerPosition()
      if (!position.success) return { httpStatus: 500, result: position }
      return {
        httpStatus: 200,
        result: {
          ...position,
          metadata: {
            ...(position.metadata ?? {}),
            ...(position.x === undefined ? {} : { x: position.x }),
            ...(position.y === undefined ? {} : { y: position.y }),
            held: position.held === true,
          },
        },
      }
    }

    if (effectiveType === "hover") {
      if (!computer.driver.hoverPointer) {
        return {
          httpStatus: 501,
          result: { success: false, status: "unavailable", message: "This computer runtime cannot hover the pointer." },
        }
      }
      const point = await this.resolvePoint(computer, effective)
      if (point === undefined) {
        return {
          httpStatus: 400,
          result: {
            success: false,
            status: "rejected",
            message: "Hovering needs a target or query with bounds.",
            error: { code: "target_not_found", message: "Hovering needs a target or query with bounds.", retryable: true },
          },
        }
      }
      const hovered = await computer.driver.hoverPointer(point.x, point.y, typeof effective.amount === "number" ? effective.amount : 600)
      return { httpStatus: hovered.success ? 200 : 500, result: hovered }
    }

    if (effectiveType === "mouse_down" || effectiveType === "mouse_up") {
      const method = effectiveType === "mouse_down" ? computer.driver.mouseDown : computer.driver.mouseUp
      if (!method) {
        return {
          httpStatus: 501,
          result: { success: false, status: "unavailable", message: "This computer runtime cannot press mouse buttons directly." },
        }
      }
      const button = buttonNumber(effective.button)
      if (button === undefined) {
        const message = `Unknown mouse button ${JSON.stringify(effective.button)}; use left, middle, or right.`
        return {
          httpStatus: 400,
          result: {
            success: false,
            status: "rejected",
            message,
            error: { code: "invalid_action", message, retryable: true },
          },
        }
      }
      const pressed = await method.call(computer.driver, button)
      return { httpStatus: pressed.success ? 200 : 500, result: pressed }
    }

    if (effectiveType === "get_focus") {
      const observation = await computer.driver.observe()
      const focused = (observation.elements ?? []).find((element) => (element.states ?? []).includes("focused"))
      if (!focused) {
        return {
          httpStatus: 200,
          result: { success: true, status: "success", message: "No element reports keyboard focus.", metadata: { focused: null } },
        }
      }
      const label = focused.name ?? focused.text ?? focused.value ?? focused.id ?? "element"
      return {
        httpStatus: 200,
        result: {
          success: true,
          status: "success",
          message: `Focus is on ${focused.role ?? "element"} "${label}".`,
          metadata: {
            focused: {
              ...(focused.id === undefined ? {} : { id: focused.id }),
              ...(focused.role === undefined ? {} : { role: focused.role }),
              ...(focused.name === undefined ? {} : { name: focused.name }),
              ...(focused.value === undefined ? {} : { value: focused.value }),
              ...(typeof focused.text === "string" ? { text: focused.text.slice(0, 200) } : {}),
              ...(focused.metadata?.application === undefined ? {} : { application: focused.metadata.application }),
            },
          },
        },
      }
    }

    if (effectiveType === "release_keys") {
      if (!computer.driver.releaseStuckKeys) {
        return {
          httpStatus: 501,
          result: {
            success: false,
            status: "unavailable",
            message: "This computer runtime cannot reset keyboard state.",
          },
        }
      }
      const released = await computer.driver.releaseStuckKeys()
      return { httpStatus: released.success ? 200 : 500, result: released }
    }

    const action = toComputerAction(actionRequest)
    if (!action) {
      return {
        httpStatus: 400,
        result: {
          success: false,
          status: "rejected",
          message: `Action ${effectiveType} requires a target, text, or key that was not provided.`,
        },
      }
    }

    const before = computer.lastObservation
    this.events.emit("action.started", {
      computerId: id,
      ...(effective.sessionId === undefined ? {} : { sessionId: effective.sessionId }),
      data: { action: effectiveType, target: effective.target?.elementId ?? effective.target?.id },
    })

    const identityIssue = await this.checkIdentity(computer, effective)
    if (identityIssue !== undefined) {
      const context = await this.failureContext(computer)
      const result: ActionResult = {
        success: false,
        status: "rejected",
        message: identityIssue.message,
        error: { code: "target_mismatch", message: identityIssue.message, retryable: true, details: identityIssue.details },
        metadata: { context: [...context] },
      }
      this.events.emit("action.failed", {
        computerId: id,
        ...(effective.sessionId === undefined ? {} : { sessionId: effective.sessionId }),
        data: { action: effectiveType, reason: result.message },
      })
      return { httpStatus: 409, result }
    }

    const needsRevalidation =
      effective.windowResolved !== true &&
      effectiveType !== "screenshot" &&
      effectiveType !== "launch" &&
      effectiveType !== "launch_app" &&
      effectiveType !== "open" &&
      effectiveType !== "open_url" &&
      effectiveType !== "open_file"
    if (
      needsRevalidation &&
      computer.driver.revalidateTarget &&
      action.target !== undefined &&
      typeof action.target === "object" &&
      action.target.kind === "element"
    ) {
      const revalidation = await computer.driver.revalidateTarget({
        kind: "element",
        elementId: action.target.elementId,
      })
      if (!revalidation.valid) {
        const result: ActionResult = {
          success: false,
          status: "rejected",
          message: revalidation.reason ?? "The target is stale.",
          error: { code: "target_stale", message: revalidation.reason ?? "The target is stale.", retryable: true },
        }
        this.events.emit("action.failed", {
          computerId: id,
          ...(effective.sessionId === undefined ? {} : { sessionId: effective.sessionId }),
          data: { action: effectiveType, reason: result.message },
        })
        return { httpStatus: 409, result }
      }
    }

    const typedBefore = await this.readTargetText(computer, effective)
    const firstCall = await this.raceStop(computerStopped, () => computer.driver.execute(action))
    if (firstCall === STOPPED) return this.cancelledOutcome(computer, effective)
    let executed = firstCall
    const endKeyName = effective.endKey
    if (executed.success && effectiveType === "type" && typeof endKeyName === "string" && endKeyName.length > 0) {
      const endKey = await this.raceStop(computerStopped, () => computer.driver.execute({ type: "key", key: endKeyName }))
      if (endKey === STOPPED) return this.cancelledOutcome(computer, effective)
      if (!endKey.success) return { httpStatus: 500, result: endKey }
      executed = {
        ...executed,
        ...(endKey.observation === undefined ? {} : { observation: endKey.observation }),
        metadata: { ...(executed.metadata ?? {}), endKey: endKeyName },
      }
    }
    computer.lastSeen = this.now()
    if (effective.sessionId !== undefined) {
      this.onSessionActivity?.({
        sessionId: effective.sessionId,
        computerId: id,
        action: effectiveType,
        at: computer.lastSeen,
      })
    }
    const settles = SETTLE_ACTIONS.has(effectiveType)
    const settled =
      executed.observation ?? (settles ? await this.settle(computer) : computer.lastObservation)
    const after = settled ?? computer.lastObservation
    if (after) this.storeObservation(computer, after)
    const delta = computeStateDelta(before, after)
    const readback = executed.success ? await this.verifyTypedText(computer, effective, actionRequest, typedBefore) : undefined
    // Driver-provided verification beats re-deriving the outcome only when it is
    // an independent readback (a second read of the world) that says verified.
    // A driver that answers verified with method "driver", "observation-diff",
    // undefined, or any other non-readback is ignored so the server falls
    // through to its own target-scoped diff and fails closed. A driver that
    // answers anything else is likewise not allowed to stand in for the
    // server's own read: it only adds the reason, never the verdict, so a
    // driver that reports "unverified" (or omits a verification entirely, as
    // the legacy pointer/window fallbacks do) cannot veto an independent
    // post-action read the server actually took.
    const rawDriverVerification = executed.success ? executed.verification : undefined
    const driverVerification =
      rawDriverVerification?.status === "verified" && isIndependentDriverVerification(rawDriverVerification)
        ? rawDriverVerification
        : undefined
    const targetId = effective.target?.elementId ?? effective.target?.id
    const verification =
      readback ??
      driverVerification ??
      (WINDOW_MANAGEMENT_ACTIONS.has(effectiveType)
        ? await this.verifyWindowManagement(computer, effective, before, after)
        : effectiveType === "wait"
          ? await this.verifyWait(computer, actionRequest, executed)
          : observationIncomplete(after) || observationIncomplete(before)
            ? verifyIncompleteOutcome({
                result: executed,
                action: effectiveType,
                request: effective,
                ...(before === undefined ? {} : { before }),
                ...(after === undefined ? {} : { after }),
                delta,
              })
            : verifyOutcome(executed, delta, effectiveType, targetId))
    const failureContext = executed.success ? undefined : await this.failureContext(computer)
    const result: ActionResult = {
      ...executed,
      verification,
      ...(executed.success || executed.error !== undefined
        ? {}
        : {
            error: {
              code: "action_failed" as const,
              message: executed.message ?? "The action failed.",
              retryable: true,
            },
          }),
      metadata: {
        ...(executed.metadata ?? {}),
        computerId: id,
        action: effectiveType,
        ...("resolution" in byQuery && byQuery.resolution !== undefined
          ? { resolvedBy: byQuery.resolution.resolvedBy, confidence: byQuery.resolution.confidence }
          : {}),
        ...(failureContext === undefined ? {} : { context: failureContext }),
        stateDelta: {
          added: delta.added.map((item) => ({ ...item })),
          removed: delta.removed.map((item) => ({ ...item })),
          changed: delta.changed.map((item) => ({
            ...item,
            ...(item.fields === undefined ? {} : { fields: [...item.fields] }),
            ...(item.before === undefined ? {} : { before: { ...item.before } }),
            ...(item.after === undefined ? {} : { after: { ...item.after } }),
          })),
          hasChanges: delta.hasChanges,
          summary: delta.summary,
          highlights: [...delta.highlights],
        },
      },
    }
    if (result.success) {
      this.events.emit(verification.status === "verified" ? "action.verified" : "action.completed", {
        computerId: id,
        ...(effective.sessionId === undefined ? {} : { sessionId: effective.sessionId }),
        data: {
          action: effectiveType,
          target: effective.target?.elementId ?? effective.target?.id,
          verification: verification.status,
          summary: delta.summary,
        },
      })
    } else {
      this.events.emit("action.failed", {
        computerId: id,
        ...(effective.sessionId === undefined ? {} : { sessionId: effective.sessionId }),
        data: { action: effectiveType, reason: result.message },
      })
    }
    if (typedCredential?.credential !== undefined) {
      this.events.emit("credential.used", {
        computerId: id,
        ...(effective.sessionId === undefined ? {} : { sessionId: effective.sessionId }),
        data: { credentialId: typedCredential.credential.id, credentialName: typedCredential.credential.name },
      })
      return { httpStatus: 200, result: redactResultCredential(result, typedCredential.credential) }
    }
    return { httpStatus: 200, result }
  }

  private async executeCredentials(computer: ManagedComputer, request: ServerActionRequest): Promise<ExecuteOutcome> {
    const required = requiredScopesForAction("credentials")
    const operation = this.actionOperation("credentials", computer.id, request)
    const decision = this.permissions.evaluate(required, {
      sessionId: request.sessionId,
      approval: this.approvalInput(request),
      operation,
    })
    if (!decision.allowed) {
      this.events.emit("permission.requested", {
        computerId: computer.id,
        ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
        data: { action: "credentials", missing: decision.missing, reason: decision.reason },
      })
      return {
        httpStatus: decision.status === "denied" ? 403 : 428,
        result: {
          success: false,
          status: "rejected",
          message: decision.reason ?? "Permission required.",
          error: {
            code: decision.status === "denied" ? "permission_denied" : "permission_required",
            message: decision.reason ?? "Permission required.",
            retryable: decision.status !== "denied",
            details: this.requiredDetails(required, decision.missing, operation),
          },
        },
      }
    }
    const summaries = this.credentials?.summaries(computer.id) ?? []
    return {
      httpStatus: 200,
      result: {
        success: true,
        status: "success",
        message:
          summaries.length === 0
            ? `No credentials are stored for ${computer.id}. Add them in Settings under Computers.`
            : `Found ${summaries.length} stored credential(s) for ${computer.id}.`,
        metadata: {
          computerId: computer.id,
          credentials: summaries.map((summary) => ({
            id: summary.id,
            name: summary.name,
            kind: summary.kind,
            ...(summary.username === undefined ? {} : { username: summary.username }),
            rules: summary.rules.map((rule) => ({ ...rule })),
            enabled: summary.enabled,
            hasSecret: summary.hasSecret,
            ...(summary.description === undefined ? {} : { description: summary.description }),
          })),
        },
      },
    }
  }

  // Shared credential selection. run_command matches rules even when the
  // caller omits the selector; type and browser_type resolve only when the
  // caller asks explicitly, so ordinary text is never replaced by a secret.
  private resolveCredential(
    computer: ManagedComputer,
    request: ServerActionRequest,
    action: string,
  ): {
    readonly credential?: ComputerCredential
    readonly match?: CredentialMatch
    readonly required: readonly OmniaScope[]
    readonly failure?: ExecuteOutcome
  } {
    const baseScopes = requiredScopesForAction(action)
    const selector = request.credential
    if (selector === "none" || (selector === undefined && action !== "run_command")) {
      return {
        ...(action === "run_command" ? { match: this.credentialMatch(computer, request, action) } : {}),
        required: baseScopes,
      }
    }
    const match = this.credentialMatch(computer, request, action)
    if (selector === undefined || selector === "auto") {
      const credential = match?.credential
      return { credential, match, required: credential === undefined ? baseScopes : [...baseScopes, "SECRETS"] }
    }
    const candidate =
      this.credentials?.get(selector) ?? this.credentials?.list(computer.id).find((entry) => entry.name === selector)
    if (candidate !== undefined && candidate.computerId !== computer.id && candidate.computerId !== "*") {
      const message = `Credential ${selector} is not stored for ${computer.id}.`
      return {
        match,
        required: baseScopes,
        failure: {
          httpStatus: 403,
          result: {
            success: false,
            status: "rejected",
            message,
            error: { code: "credential_not_found", message, retryable: true },
          },
        },
      }
    }
    if (candidate === undefined) {
      const message = `No credential ${selector} is stored for ${computer.id}.`
      return {
        match,
        required: baseScopes,
        failure: {
          httpStatus: 404,
          result: {
            success: false,
            status: "rejected",
            message,
            error: { code: "credential_not_found", message, retryable: true },
          },
        },
      }
    }
    return { credential: candidate, match, required: [...baseScopes, "SECRETS"] }
  }

  private credentialMatch(computer: ManagedComputer, request: ServerActionRequest, action: string): CredentialMatch | undefined {
    if (action === "run_command") {
      return this.credentials?.match({ computerId: computer.id, command: (request.command ?? request.text ?? "").trim() })
    }
    if (action === "browser_type" || action === "browser_login") {
      // Login selects a credential the same way typing does, by the page it is
      // for: `url` only picks the credential, it is never typed anywhere.
      return this.credentials?.match({
        computerId: computer.id,
        ...(request.url === undefined ? {} : { url: request.url }),
        ...(request.app === undefined ? {} : { application: request.app }),
      })
    }
    return this.credentials?.match({
      computerId: computer.id,
      ...(request.app === undefined ? {} : { application: request.app }),
    })
  }

  // Resolves the credential plus the exact field value a type action should
  // enter. The value stays separate from model-visible output.
  /**
   * Refuses a capability the current plan does not include.
   *
   * Returns undefined when the caller may proceed. A transport failure is NOT
   * treated as a refusal here: the browser and CUA layers already own the
   * fail-open/fail-closed split per capability, and duplicating that decision in
   * the driver would let one unreachable endpoint deny every local action.
   */
  private async denyUnentitled(
    capability: "vault_login" | "browser_automation",
  ): Promise<{ readonly httpStatus: number; readonly result: ActionResult } | undefined> {
    const base = this.controlPlaneUrl()
    const token = this.controlPlaneToken()
    // No control plane configured means billing was never enabled here, so the
    // gate is inert: refusing every credential on a self-hosted install that
    // never opted into billing would break the product for everyone using it
    // locally. This is distinct from a CONFIGURED control plane being
    // unreachable, which is a failure and fails closed.
    if (base === undefined || token.length === 0) return undefined
    let json: Record<string, unknown>
    try {
      const response = await fetch(`${base}/v1/billing/check`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ capability }),
        // Without a deadline a hung control plane hung the action forever, which
        // reads to the user as Omnia being broken rather than billing being slow.
        signal: AbortSignal.timeout(5_000),
      })
      // A 5xx is a FAILURE, not a decision. Reporting it as "not included in your
      // plan" both lied to the customer and applied free-plan policy to someone
      // who had paid.
      if (response.status >= 500) {
        return this.entitlementUnavailable(capability)
      }
      json = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined ?? {}
    } catch {
      // Both capabilities gated here are HARD metered on free, so a transport
      // failure must refuse rather than hand out unmetered use.
      return this.entitlementUnavailable(capability)
    }
    if (json.allowed === true) return undefined
    const reason = typeof json.reason === "string" ? json.reason : `${capability} is not available on your plan.`
    return {
      httpStatus: 402,
      result: {
        success: false,
        status: "rejected",
        message: reason,
        // The plan and the capability are named in the message on purpose:
        // ActionResult has no details bag, and a refusal the user cannot act on
        // is a support ticket instead of an upgrade.
        error: {
          code: "capability_not_entitled",
          message: `${reason} (${capability}, plan: ${typeof json.plan === "string" ? json.plan : "free"})`,
        },
      },
    }
  }

  /** Refusal used when billing itself could not be reached. */
  private entitlementUnavailable(
    capability: "vault_login" | "browser_automation",
  ): { readonly httpStatus: number; readonly result: ActionResult } {
    const message = `Billing could not be reached, so ${capability} is unavailable right now. This is our problem, not yours - try again shortly.`
    return {
      httpStatus: 503,
      result: {
        success: false,
        status: "rejected",
        message,
        error: { code: "entitlement_unavailable", message, retryable: true },
      },
    }
  }

  private controlPlaneUrl(): string | undefined {
    const url = process.env.OMNIA_SERVER_URL ?? process.env.OMNIA_PUBLIC_URL
    return url === undefined || url.length === 0 ? undefined : url.replace(/\/+$/, "")
  }

  private controlPlaneToken(): string {
    return process.env.OMNIA_SERVER_TOKEN ?? ""
  }

  private resolveTypedCredential(
    computer: ManagedComputer,
    request: ServerActionRequest,
    action: string,
  ): {
    readonly credential?: ComputerCredential
    readonly value?: string
    readonly required: readonly OmniaScope[]
    readonly failure?: ExecuteOutcome
  } {
    const resolution = this.resolveCredential(computer, request, action)
    if (resolution.failure !== undefined || resolution.credential === undefined) return resolution
    const credential = resolution.credential
    if (request.field !== undefined && request.field !== "secret" && request.field !== "username") {
      const message = `Unknown credential field ${JSON.stringify(request.field)}; use "username" or "secret".`
      return {
        credential,
        required: resolution.required,
        failure: {
          httpStatus: 400,
          result: {
            success: false,
            status: "rejected",
            message,
            error: { code: "invalid_action", message, retryable: false },
          },
        },
      }
    }
    if (request.field === "username") {
      if (credential.username === undefined || credential.username.length === 0) {
        const message = `Credential ${credential.name} has no username stored.`
        return {
          credential,
          required: resolution.required,
          failure: {
            httpStatus: 400,
            result: {
              success: false,
              status: "rejected",
              message,
              error: { code: "credential_username_missing", message, retryable: false },
            },
          },
        }
      }
      return { credential, value: credential.username, required: resolution.required }
    }
    return { credential, value: credential.secret, required: resolution.required }
  }

  private async executeCommand(computer: ManagedComputer, request: ServerActionRequest): Promise<ExecuteOutcome> {
    const id = computer.id
    if (!computer.driver.runCommand) {
      return {
        httpStatus: 501,
        result: {
          success: false,
          status: "unavailable",
          message: "This computer runtime cannot run shell commands.",
        },
      }
    }
    const command = (request.command ?? request.text ?? "").trim()
    if (command.length === 0) {
      return {
        httpStatus: 400,
        result: {
          success: false,
          status: "rejected",
          message: "run_command needs a command.",
          error: { code: "invalid_action", message: "run_command needs a command.", retryable: true },
        },
      }
    }
    const resolution = this.resolveCredential(computer, request, "run_command")
    if (resolution.failure !== undefined) return resolution.failure
    const credential = resolution.credential
    const match = resolution.match
    const required = resolution.required
    const operation = this.actionOperation("run_command", id, request)
    const decision = this.permissions.evaluate(required, {
      sessionId: request.sessionId,
      approval: this.approvalInput(request),
      operation,
    })
    this.events.emit("action.requested", {
      computerId: id,
      ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
      data: {
        action: "run_command",
        requiredScopes: required,
        ...(credential === undefined ? {} : { credentialId: credential.id, credentialName: credential.name }),
      },
    })
    if (!decision.allowed) {
      this.events.emit("permission.requested", {
        computerId: id,
        ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
        data: {
          action: "run_command",
          missing: decision.missing,
          reason: decision.reason,
          ...(credential === undefined ? {} : { credentialId: credential.id, credentialName: credential.name }),
        },
      })
      return {
        httpStatus: decision.status === "denied" ? 403 : 428,
        result: {
          success: false,
          status: "rejected",
          message: decision.reason ?? "Permission required.",
          error: {
            code: decision.status === "denied" ? "permission_denied" : "permission_required",
            message: decision.reason ?? "Permission required.",
            retryable: decision.status !== "denied",
            details: {
              ...this.requiredDetails(required, decision.missing, operation),
              ...(credential === undefined
                ? match === undefined
                  ? {}
                  : {
                      credential: {
                        id: match.credential.id,
                        name: match.credential.name,
                        rules: match.credential.rules.map((rule) => `${rule.kind}:${rule.match}`),
                      },
                    }
                : { credential: { id: credential.id, name: credential.name } }),
            },
          },
        },
      }
    }
    if (request.approve === true) {
      this.events.emit("permission.decided", {
        computerId: id,
        ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
        data: {
          action: "run_command",
          approvedBy: request.approvedBy ?? "session",
          scopes: required,
          ...(credential === undefined ? {} : { credentialId: credential.id, credentialName: credential.name }),
        },
      })
    }

    const usesStoredSecret =
      credential !== undefined && /(^|[\s;&|])(sudo|doas|pkexec)(\s|$)/.test(command)
    const env = credential === undefined ? undefined : credentialEnv(credential)
    const stdin = usesStoredSecret && credential !== undefined ? `${credential.secret}\n` : undefined
    // Every sudo invocation is rewritten, not just the first, so a chained
    // "sudo a && sudo b" both read the credential from stdin.
    const effectiveCommand =
      usesStoredSecret && credential !== undefined
        ? command.replace(/(^|[\s;&|])sudo(?=\s|$)/g, (_whole, prefix: string) => `${prefix}sudo -S -p ''`)
        : command
    this.events.emit("action.started", {
      computerId: id,
      ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
      data: {
        action: "run_command",
        ...(credential === undefined ? {} : { credentialId: credential.id, credentialName: credential.name }),
      },
    })

    const executed = await computer.driver.runCommand({
      command: effectiveCommand,
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
      ...(env === undefined ? {} : { env }),
      ...(stdin === undefined ? {} : { stdin }),
    })
    const secrets = credential === undefined ? [] : [credential.secret]
    const commandResult =
      executed.command === undefined
        ? undefined
        : {
            ...executed.command,
            stdout: redactSecrets(executed.command.stdout, secrets),
            stderr: redactSecrets(executed.command.stderr, secrets),
          }
    const success = executed.success && (commandResult === undefined || commandResult.exitCode === 0)
    const verification: Verification =
      commandResult === undefined
        ? {
            status: executed.success ? "unverified" : "failed",
            method: "exit-code",
            message: executed.message ?? (executed.success ? "The command ran but returned no result." : "The command failed."),
          }
        : {
            status: commandResult.timedOut ? "failed" : success ? "verified" : "failed",
            method: "exit-code",
            evidence: [{ kind: "exit-code", value: commandResult.exitCode }],
            message: commandResult.timedOut
              ? `The command timed out after ${commandResult.durationMs}ms.`
              : success
                ? `The command exited with code 0 in ${commandResult.durationMs}ms.`
                : `The command exited with code ${commandResult.exitCode ?? "unknown"}.`,
          }
    computer.lastSeen = this.now()
    if (request.sessionId !== undefined) {
      this.onSessionActivity?.({ sessionId: request.sessionId, computerId: id, action: "run_command", at: computer.lastSeen })
    }
    if (credential !== undefined) {
      this.events.emit("credential.used", {
        computerId: id,
        ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
        data: {
          credentialId: credential.id,
          credentialName: credential.name,
          command: redactSecrets(command, [credential.secret]).slice(0, 200),
          viaSudoStdin: usesStoredSecret,
        },
      })
    }
    if (success) {
      this.events.emit("action.verified", {
        computerId: id,
        ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
        data: { action: "run_command", verification: verification.status },
      })
    } else {
      this.events.emit("action.failed", {
        computerId: id,
        ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
        data: { action: "run_command", reason: verification.message },
      })
    }
    // A failed command is not an HTTP success: timeouts answer 504 and other
    // non-zero exits 409, and the result always carries an error object the
    // same way the generic action path does.
    const httpStatus = success ? 200 : commandResult === undefined ? 500 : commandResult.timedOut ? 504 : 409
    const failure =
      success
        ? undefined
        : executed.error ??
          {
            code: commandResult?.timedOut === true ? ("command_timeout" as const) : ("command_failed" as const),
            message: verification.message ?? "The command failed.",
            retryable: true,
            ...(commandResult === undefined
              ? {}
              : { details: { exitCode: commandResult.exitCode, timedOut: commandResult.timedOut } }),
          }
    return {
      httpStatus,
      result: {
        ...executed,
        ...(commandResult === undefined ? {} : { command: commandResult }),
        success,
        verification,
        ...(failure === undefined ? {} : { error: failure }),
        metadata: {
          ...(executed.metadata ?? {}),
          computerId: id,
          action: "run_command",
          ...(credential === undefined
            ? {}
            : { credential: { id: credential.id, name: credential.name, kind: credential.kind } }),
          ...(commandResult === undefined
            ? {}
            : {
                exitCode: commandResult.exitCode,
                timedOut: commandResult.timedOut,
                truncated: commandResult.truncated,
                durationMs: commandResult.durationMs,
              }),
        },
      },
    }
  }

  private async executeWindowAction(computer: ManagedComputer, request: ServerActionRequest): Promise<ExecuteOutcome> {
    const action = request.action
    const required = WINDOW_ACTION_SCOPES[action]
    if (required === undefined) {
      const message = `Unknown window action ${action}.`
      return {
        httpStatus: 400,
        result: {
          success: false,
          status: "rejected",
          message,
          error: { code: "invalid_action", message, retryable: false },
        },
      }
    }
    const operation: OperationInput = {
      action,
      resources: [request.target?.elementId ?? request.window ?? computer.id],
    }
    const decision = this.permissions.evaluate(required, {
      sessionId: request.sessionId,
      approval: this.approvalInput(request),
      operation,
    })
    this.events.emit("action.requested", {
      computerId: computer.id,
      ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
      data: { action, requiredScopes: required },
    })
    if (!decision.allowed) {
      this.events.emit("permission.requested", {
        computerId: computer.id,
        ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
        data: { action, missing: decision.missing, reason: decision.reason },
      })
      return {
        httpStatus: decision.status === "denied" ? 403 : 428,
        result: {
          success: false,
          status: "rejected",
          message: decision.reason ?? "Permission required.",
          error: {
            code: decision.status === "denied" ? "permission_denied" : "permission_required",
            message: decision.reason ?? "Permission required.",
            retryable: decision.status !== "denied",
            details: this.requiredDetails(required, decision.missing, operation),
          },
        },
      }
    }
    if (request.approve === true) {
      this.events.emit("permission.decided", {
        computerId: computer.id,
        ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
        data: { action, approvedBy: request.approvedBy ?? "session", scopes: required },
      })
    }
    const cua = await cuaDriverFor(computer.driver)
    const act = cua?.act
    if (cua === undefined || act === undefined) {
      const message = "Window management needs the Cua engine on this computer."
      return {
        httpStatus: 501,
        result: {
          success: false,
          status: "failure",
          message,
          error: { code: "window_management_unavailable", message },
        },
      }
    }
    const snapshot = cua.snapshot === undefined ? undefined : await cua.snapshot({}).catch(() => undefined)
    const windows = snapshot?.windows ?? []
    const fragment = request.window?.toLowerCase()
    const requested = request.target?.elementId
    const ref =
      fragment !== undefined
        ? matchWindowFragment(windows, fragment)?.ref
        : requested !== undefined
          ? windows.find((window) => window.ref === requested)?.ref
          : windows.find((window) => window.focused)?.ref
    if (ref === undefined) {
      const message =
        fragment !== undefined
          ? `No window matches "${request.window}".`
          : requested !== undefined
            ? `No window with id "${requested}" is open.`
            : "No focused window to manage."
      return {
        httpStatus: 404,
        result: {
          success: false,
          status: "failure",
          message,
          error: { code: "window_not_found", message },
        },
      }
    }
    const windowRequest: Parameters<typeof act>[0] =
      action === "window_tile"
        ? { type: "window", action: "tile", ref, position: request.text ?? "left" }
        : action === "window_move"
          ? {
              type: "window",
              action: "move",
              ref,
              ...(request.x === undefined ? {} : { x: request.x }),
              ...(request.y === undefined ? {} : { y: request.y }),
            }
          : action === "window_maximize"
            ? { type: "window", action: "maximize", ref }
            : action === "window_minimize"
              ? { type: "window", action: "minimize", ref }
              : action === "window_restore"
                ? { type: "window", action: "restore", ref }
                : { type: "window", action: "close", ref }
    const stopSeq = computer.stopSeq
    const stopped = () => computer.stopped || computer.stopSeq !== stopSeq || request.shouldStop?.() === true
    const outcome = await this.raceStop(stopped, () => act(windowRequest))
    if (outcome === STOPPED) return this.cancelledOutcome(computer, request)
    computer.lastSeen = this.now()
    if (request.sessionId !== undefined) {
      this.onSessionActivity?.({
        sessionId: request.sessionId,
        computerId: computer.id,
        action,
        at: computer.lastSeen,
      })
    }
    this.events.emit(outcome.ok ? "action.completed" : "action.failed", {
      computerId: computer.id,
      ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
      data: { action, ...(outcome.ok ? {} : { reason: outcome.message }) },
    })
    const stateDelta = outcome.stateDelta
    return {
      httpStatus: outcome.ok ? 200 : 409,
      result: {
        success: outcome.ok,
        status: outcome.ok ? "success" : "failure",
        message: outcome.message,
        verification: {
          status: outcome.ok ? (outcome.verified ? "verified" : "unverified") : "failed",
          method: "cua-snapshot",
          message: outcome.message,
          ...(stateDelta === undefined
            ? {}
            : { evidence: [{ kind: "cua-state-delta", value: JSON.stringify(stateDelta) }] }),
        },
        metadata: {
          delivery: outcome.delivery,
          verified: outcome.verified,
          ...(stateDelta === undefined
            ? {}
            : {
                stateDelta: {
                  ...(stateDelta.focusedRef === undefined ? {} : { focusedRef: stateDelta.focusedRef }),
                  ...(stateDelta.addedRefs === undefined ? {} : { addedRefs: [...stateDelta.addedRefs] }),
                  ...(stateDelta.removedRefs === undefined ? {} : { removedRefs: [...stateDelta.removedRefs] }),
                  ...(stateDelta.changedRefs === undefined ? {} : { changedRefs: [...stateDelta.changedRefs] }),
                },
              }),
        },
        ...(outcome.error === undefined ? {} : { error: outcome.error }),
      },
    }
  }

  private async executeCalibrationAction(computer: ManagedComputer, request: ServerActionRequest): Promise<ExecuteOutcome> {
    const action = request.action
    const calibration = this.calibration
    if (calibration === undefined) {
      return {
        httpStatus: 501,
        result: {
          success: false,
          status: "unavailable",
          message: "Display calibration is unavailable on this server.",
        },
      }
    }
    const required = requiredScopesForAction(action)
    const operation: OperationInput = { action, resources: [computer.id] }
    const decision = this.permissions.evaluate(required, {
      sessionId: request.sessionId,
      approval: this.approvalInput(request),
      operation,
    })
    this.events.emit("action.requested", {
      computerId: computer.id,
      ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
      data: { action, requiredScopes: required },
    })
    if (!decision.allowed) {
      this.events.emit("permission.requested", {
        computerId: computer.id,
        ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
        data: { action, missing: decision.missing, reason: decision.reason },
      })
      return {
        httpStatus: decision.status === "denied" ? 403 : 428,
        result: {
          success: false,
          status: "rejected",
          message: decision.reason ?? "Permission required.",
          error: {
            code: decision.status === "denied" ? "permission_denied" : "permission_required",
            message: decision.reason ?? "Permission required.",
            retryable: decision.status !== "denied",
            details: this.requiredDetails(required, decision.missing, operation),
          },
        },
      }
    }
    if (request.approve === true) {
      this.events.emit("permission.decided", {
        computerId: computer.id,
        ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
        data: { action, approvedBy: request.approvedBy ?? "session", scopes: required },
      })
    }
    const info = await computer.driver.getInfo().catch(() => undefined)
    const screen = info?.screen ?? { width: 1920, height: 1080 }
    const record = () => {
      computer.lastSeen = this.now()
      if (request.sessionId !== undefined) {
        this.onSessionActivity?.({
          sessionId: request.sessionId,
          computerId: computer.id,
          action,
          at: computer.lastSeen,
        })
      }
    }
    if (action === "calibration_status") {
      const status = calibration.status(screen)
      record()
      const profile = status.profile
      const message =
        profile === undefined
          ? "Display is not calibrated."
          : status.stale
            ? `Calibration is stale for ${screen.width}x${screen.height}; recalibrate.`
            : `Calibrated: scale ${profile.scaleX}/${profile.scaleY}, offset ${profile.offsetX},${profile.offsetY} (${profile.samples} samples).`
      return {
        httpStatus: 200,
        result: {
          success: true,
          status: "success",
          message,
          metadata: {
            calibration: {
              ...(profile === undefined ? {} : { profile: calibrationProfileJson(profile) }),
              screen: { width: screen.width, height: screen.height },
              stale: status.stale,
              calibrated: status.calibrated,
            },
          },
        },
      }
    }
    if (action === "calibration_start") {
      calibration.begin()
      const points = calibration.grid(screen)
      const listed = points.map((point) => `${point.id} (${point.x},${point.y})`).join(", ")
      record()
      return {
        httpStatus: 200,
        result: {
          success: true,
          status: "success",
          message: `Calibration started on ${screen.width}x${screen.height}. Measure these points in order with calibration_measure and the id in text: ${listed}.`,
          metadata: {
            screen: { width: screen.width, height: screen.height },
            points: points.map((point) => ({ id: point.id, x: point.x, y: point.y })),
          },
        },
      }
    }
    if (action === "calibration_measure") {
      const pointId = request.text
      const point = calibration.grid(screen).find((entry) => entry.id === pointId)
      if (point === undefined) {
        const valid = calibration
          .grid(screen)
          .map((entry) => entry.id)
          .join(", ")
        const message = `Unknown calibration point "${pointId ?? ""}". Valid ids: ${valid}.`
        return {
          httpStatus: 400,
          result: {
            success: false,
            status: "failure",
            message,
            error: { code: "unknown_point", message, details: { valid: valid.split(", ") } },
          },
        }
      }
      const stopSeq = computer.stopSeq
      const stopped = () => computer.stopped || computer.stopSeq !== stopSeq || request.shouldStop?.() === true
      const measured = await this.raceStop(stopped, () => calibration.measure(computer.driver, point))
      if (measured === STOPPED) return this.cancelledOutcome(computer, request)
      record()
      const message =
        measured.error !== undefined
          ? `${point.id}: could not measure (${measured.error}).`
          : `${point.id}: target ${point.x},${point.y} observed ${measured.observedX},${measured.observedY} delta ${measured.deltaX},${measured.deltaY}.`
      return {
        httpStatus: 200,
        result: {
          success: measured.error === undefined,
          // A measurement the runtime could not take reported status "success"
          // next to success:false, which reads as a completed measurement.
          status: measured.error === undefined ? "success" : "failure",
          message,
          metadata: {
            measurement: {
              pointId: measured.pointId,
              x: measured.x,
              y: measured.y,
              ...(measured.observedX === undefined ? {} : { observedX: measured.observedX }),
              ...(measured.observedY === undefined ? {} : { observedY: measured.observedY }),
              ...(measured.deltaX === undefined ? {} : { deltaX: measured.deltaX }),
              ...(measured.deltaY === undefined ? {} : { deltaY: measured.deltaY }),
              ...(measured.error === undefined ? {} : { error: measured.error }),
            },
          },
        },
      }
    }
    const failedPoints = calibration
      .pendingMeasurements()
      .filter((entry) => entry.error !== undefined)
      .map((entry) => entry.pointId)
    if (failedPoints.length > 0) {
      const message = `Calibration is incomplete: ${failedPoints.join(", ")} could not be measured. Re-run calibration before saving.`
      return {
        httpStatus: 400,
        result: {
          success: false,
          status: "failure",
          message,
          error: { code: "calibration_incomplete", message, details: { failed: failedPoints } },
        },
      }
    }
    const residuals = calibration
      .pendingMeasurements()
      .flatMap((entry) =>
        entry.deltaX === undefined || entry.deltaY === undefined
          ? []
          : [Math.max(Math.abs(entry.deltaX), Math.abs(entry.deltaY))],
      )
    const worst = residuals.length === 0 ? 0 : Math.max(...residuals)
    const profile = calibration.commit(screen)
    record()
    if (profile === undefined) {
      const message = "No valid measurements to calibrate from."
      return {
        httpStatus: 400,
        result: {
          success: false,
          status: "failure",
          message,
          error: { code: "no_measurements", message },
        },
      }
    }
    return {
      httpStatus: 200,
      result: {
        success: true,
        status: "success",
        message: `Calibration saved: scale ${profile.scaleX}/${profile.scaleY}, offset ${profile.offsetX},${profile.offsetY} (${profile.samples} samples, worst residual ${Math.round(worst)}px).`,
        metadata: { profile: calibrationProfileJson(profile) },
      },
    }
  }

  private async resolvePoint(
    computer: ManagedComputer,
    request: ServerActionRequest,
  ): Promise<{ x: number; y: number } | undefined> {
    if (typeof request.x === "number" && typeof request.y === "number") return { x: request.x, y: request.y }
    const elementId = request.target?.elementId
    if (elementId === undefined) return undefined
    const observation = await computer.driver.observe().catch(() => undefined)
    const element = (observation?.elements ?? []).find((candidate) => candidate.id === elementId)
    const bounds = element?.bounds
    if (bounds === undefined) return undefined
    const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
    // Element-derived centers never pass through the API's explicit-coordinate
    // calibration, so the display transform has to happen here.
    return this.calibration === undefined ? center : this.calibration.transform(center.x, center.y)
  }

  private remember(computerId: string, observation: Observation): void {
    for (const element of observation.elements ?? []) this.rememberElement(computerId, element)
  }

  private rememberElement(computerId: string, element: UIElement): void {
    const id = element.id
    if (id === undefined || id.length === 0) return
    const key = `${computerId}:${id}`
    // Bounded eviction instead of a wholesale clear: clearing at the cap threw
    // away every live identity at once and made the first stale-target check
    // after the clear silently skip verification.
    if (!this.identities.has(key)) {
      while (this.identities.size >= MAX_ELEMENT_IDENTITIES) {
        const oldest = this.identities.keys().next().value
        if (oldest === undefined) break
        this.identities.delete(oldest)
      }
    }
    this.identities.set(key, {
      ...(element.role === undefined ? {} : { role: element.role }),
      ...(element.name === undefined ? {} : { name: element.name }),
    })
  }

  private async checkIdentity(
    computer: ManagedComputer,
    request: ServerActionRequest,
  ): Promise<
    | {
        message: string
        details: {
          expected: { readonly role?: string; readonly name?: string }
          actual: { readonly role?: string; readonly name?: string }
        }
      }
    | undefined
  > {
    if (request.query !== undefined) return undefined
    const elementId = request.target?.elementId
    if (elementId === undefined || elementId.length === 0) return undefined
    const key = `${computer.id}:${elementId}`
    const cached = this.identities.get(key)
    if (cached === undefined) return undefined
    // Refresh recency so a frequently checked target survives eviction.
    this.identities.delete(key)
    this.identities.set(key, cached)
    const observation = await computer.driver.observe().catch(() => undefined)
    const current = (observation?.elements ?? []).find((element) => element.id === elementId)
    if (current === undefined) return undefined
    const roleChanged = cached.role !== undefined && current.role !== undefined && cached.role !== current.role
    const nameChanged = cached.name !== undefined && current.name !== undefined && cached.name !== current.name
    if (!roleChanged && !nameChanged) return undefined
    return {
      message: `Element ${elementId} is no longer the ${cached.role ?? "element"} "${cached.name ?? ""}"; it is now ${current.role ?? "unknown"} "${current.name ?? ""}". Re-find the control before acting.`,
      details: {
        expected: {
          ...(cached.role === undefined ? {} : { role: cached.role }),
          ...(cached.name === undefined ? {} : { name: cached.name }),
        },
        actual: {
          ...(current.role === undefined ? {} : { role: current.role }),
          ...(current.name === undefined ? {} : { name: current.name }),
        },
      },
    }
  }

  // KWin/xprop verification shells out through the driver's process runner.
  // Agent sessions must hold PROCESS_EXECUTE for that crossing; desktop
  // calls (the embedded UI is the approver) keep the unconditional path.
  private windowShellRunner(computer: ManagedComputer, request: ServerActionRequest): KWinShellRunner | undefined {
    const runCommand = computer.driver.runCommand
    if (runCommand === undefined) return undefined
    if ((request.sessionId !== undefined || request.origin === "agent") && !this.windowShellAllowed(computer, request)) {
      return undefined
    }
    return async (command: string) => {
      const result = await runCommand.call(computer.driver, { command, timeoutMs: 5000 }).catch(() => undefined)
      if (result === undefined || result.command === undefined) return undefined
      return { stdout: result.command.stdout, exitCode: result.command.exitCode }
    }
  }

  private windowShellAllowed(computer: ManagedComputer, request: ServerActionRequest): boolean {
    const decision = this.permissions.evaluate(["PROCESS_EXECUTE"], {
      sessionId: request.sessionId,
      approval: this.approvalInput(request),
      operation: this.actionOperation(request.action, computer.id, request),
    })
    return decision.allowed
  }

  private async verifyWindowManagement(
    computer: ManagedComputer,
    request: ServerActionRequest,
    before: Observation | undefined,
    after: Observation | undefined,
  ): Promise<Verification> {
    // The target window is the thing being verified; the active window is only
    // a fallback when the caller could not name one.
    const expectedWindowId =
      request.target?.elementId ?? activeWindowIdFromObservation(before) ?? activeWindowIdFromObservation(after)
    const runShell = this.windowShellRunner(computer, request)
    if (request.action === "close" || request.action === "close_app") {
      // Re-query after the KWin settle so a slow close is not misread.
      // Close is verified ONLY by the window disappearing; a window that was
      // merely minimized must not fall through to focus-loss verification.
      const fresh = await computer.driver
        .observe()
        .catch(() => undefined)
        .then(async (observation) => {
          if (observation !== undefined) return observation
          await new Promise((resolve) => setTimeout(resolve, 500))
          return computer.driver.observe().catch(() => undefined)
        })
      const current = fresh ?? after
      if (current) this.storeObservation(computer, current)
      return verifyWindowClosed({ expectedWindowId, after: current, method: "atspi-focus" })
    }
    const expectMinimized =
      request.action === "minimize" ? true : request.action === "restore" || request.action === "maximize" ? false : undefined
    // focus_window and activate_app are normalized to "focus" before
    // verification. Focus needs positive focus-gain verification: "still
    // focused" must read as verified, and focus moving to the target must
    // read as verified. verifyFocusLoss (the minimize path) says the exact
    // opposite, so it must never judge a focus action.
    const expectFocused =
      request.action === "focus" || request.action === "focus_window" || request.action === "activate_app"
    return verifyWindowState({
      ...(runShell === undefined ? {} : { runShell }),
      ...(before === undefined ? {} : { before }),
      ...(after === undefined ? {} : { after }),
      ...(expectedWindowId === undefined ? {} : { expectedWindowId }),
      ...(expectMinimized === undefined ? {} : { expectMinimized }),
      ...(expectFocused ? { expectFocused: true } : {}),
      reobserve: async () => computer.driver.observe().catch(() => undefined),
    })
  }

  private async readTargetText(
    computer: ManagedComputer,
    request: ServerActionRequest,
  ): Promise<string | undefined> {
    const elementId = request.target?.elementId
    if (request.action !== "type" || !computer.driver.readText || elementId === undefined) return undefined
    const read = await computer.driver.readText({ elementId, limit: 4000 }).catch(() => undefined)
    return read?.success === true && typeof read.text === "string" ? read.text : undefined
  }

  private async verifyTypedText(
    computer: ManagedComputer,
    request: ServerActionRequest,
    actionRequest: ServerActionRequest,
    before: string | undefined,
  ): Promise<Verification | undefined> {
    if (request.action !== "type" || !computer.driver.readText) return undefined
    const elementId = request.target?.elementId
    const expected = actionRequest.text ?? ""
    if (elementId === undefined || expected.trim().length === 0) return undefined
    const read = await computer.driver
      .readText({ elementId, limit: Math.max(4000, expected.length + 2000) })
      .catch(() => undefined)
    if (!read?.success || typeof read.text !== "string" || read.text.length === 0) return undefined
    const probe = expected.trim().slice(0, Math.min(80, expected.trim().length))
    const matched = read.text.includes(probe)
    // FAIL-CLOSED: the text must be absent-or-different before the action, and
    // proving that needs a pre-read that actually succeeded. A failed pre-read
    // leaves "the target already held this text" indistinguishable from "this
    // action typed it", so the readback is not evidence at all and the caller
    // keeps deriving the outcome from the observations it took itself.
    if (before === undefined) return undefined
    if (matched && before !== read.text) {
      return {
        status: "verified",
        message: `Text readback confirms the target contains the typed text (${read.length ?? read.text.length} chars${read.hash === undefined ? "" : `, hash ${read.hash}`}).`,
        method: "text-readback",
        evidence: [{ kind: "text-readback", value: JSON.stringify({ length: read.length, hash: read.hash, matched: probe }) }],
      }
    }
    if (matched) {
      return {
        status: "unverified",
        message: "The target already contained the typed text before the action; the type action could not be confirmed.",
        method: "text-readback",
      }
    }
    return {
      status: "unverified",
      message: `Typed text was not found in the target's readback (${read.length ?? read.text.length} chars, begins ${JSON.stringify(read.text.slice(0, 80))}).`,
      method: "text-readback",
    }
  }

  private storeObservation(computer: ManagedComputer, observation: Observation): void {
    const elements = observation.elements
    if (elements === undefined || elements.length <= MAX_STORED_OBSERVATION_ELEMENTS) {
      computer.lastObservation = observation
      return
    }
    // FAIL-CLOSED truncation: never silently slice. The stored observation is
    // explicitly marked truncated with completeness metadata (stored/seen) so
    // verification can fall back to target-scoped evidence instead of trusting
    // a partial diff.
    const stored = elements.slice(0, MAX_STORED_OBSERVATION_ELEMENTS)
    const metadata = observation.metadata as Record<string, unknown> | undefined
    computer.lastObservation = {
      ...observation,
      elements: stored,
      metadata: {
        ...(metadata ?? {}),
        truncated: true,
        stored: stored.length,
        seen: elements.length,
      },
    }
  }

  // Resolves as soon as the stop probe fires while `run` is still in flight.
  // The driver call is not abortable (the driver contract takes no signal), so
  // the abandoned promise is settled with a no-op catch; the action answers
  // "cancelled" rather than waiting for or trusting the late completion.
  private async raceStop<T>(stop: () => boolean, run: () => Promise<T>): Promise<T | typeof STOPPED> {
    if (stop()) return STOPPED
    const call = run()
    void call.catch(() => undefined)
    let timer: ReturnType<typeof setInterval> | undefined
    const interrupted = new Promise<typeof STOPPED>((resolve) => {
      timer = setInterval(() => {
        if (!stop()) return
        clearInterval(timer)
        resolve(STOPPED)
      }, 25)
    })
    try {
      const settled = await Promise.race([call, interrupted])
      // The driver call may resolve in the same tick the stop lands (the poll
      // interval is not synchronous with the stop request). Re-check after the
      // race so an action that finished while control was being stopped is
      // reported as cancelled instead of verified.
      if (settled !== STOPPED && stop()) return STOPPED
      return settled
    } finally {
      if (timer !== undefined) clearInterval(timer)
    }
  }

  private cancelledOutcome(computer: ManagedComputer, request: ServerActionRequest): ExecuteOutcome {
    const message =
      request.shouldStop?.() === true
        ? "The action was cancelled because the client disconnected."
        : computer.stoppedReason ?? "Computer control was stopped."
    return {
      httpStatus: 409,
      result: {
        success: false,
        status: "cancelled",
        message,
        error: { code: "action_cancelled", message, retryable: true },
      },
    }
  }

  private async verifyWait(
    computer: ManagedComputer,
    request: ServerActionRequest,
    executed: ActionResult,
  ): Promise<Verification> {
    if (!executed.success) {
      return { status: "failed", message: executed.message ?? "The wait did not complete.", method: "observation-readback" }
    }
    const ms = typeof request.amount === "number" ? request.amount : 800
    const observation = await computer.driver.observe().catch(() => undefined)
    if (observation === undefined) {
      return {
        status: "unverified",
        message: `Waited ${ms}ms, but the environment could not be re-observed to confirm it settled.`,
        method: "observation-readback",
      }
    }
    this.storeObservation(computer, observation)
    const elements = observation.elements?.length ?? 0
    return {
      status: "verified",
      message: `Waited ${ms}ms and re-observed ${elements} element(s).`,
      method: "observation-readback",
      evidence: [{ kind: "observation-readback", value: JSON.stringify({ ms, elements, observationId: observation.id }) }],
    }
  }

  private async verifyPastedTable(
    computer: ManagedComputer,
    request: ServerActionRequest,
    tsv: string,
  ): Promise<Verification> {
    const elementId = request.target?.elementId
    if (elementId !== undefined && computer.driver.readText) {
      const read = await computer.driver
        .readText({ elementId, limit: Math.max(4000, tsv.length + 2000) })
        .catch(() => undefined)
      if (read?.success === true && typeof read.text === "string" && read.text.length > 0) {
        const probe = tsv.trim().slice(0, Math.min(80, tsv.trim().length))
        const matched = probe.length > 0 && read.text.includes(probe)
        return matched
          ? {
              status: "verified",
              message: "The target control's readback contains the pasted table text.",
              method: "text-readback",
              evidence: [{ kind: "text-readback", value: JSON.stringify({ matched: probe }) }],
            }
          : {
              status: "unverified",
              message: "The pasted table text was not found in the target control's readback.",
              method: "text-readback",
            }
      }
    }
    // FAIL-CLOSED: the clipboard is the paste's source, never its destination.
    // Re-reading it proves the text was written and nothing about where it
    // landed, so a clipboard match stays unverified; only the target's own
    // readback above can verify a paste.
    if (computer.driver.readClipboard) {
      const read = await computer.driver.readClipboard().catch(() => undefined)
      if (read?.success === true && typeof read.text === "string") {
        return {
          status: "unverified",
          message:
            read.text === tsv
              ? "The clipboard still holds the pasted table, but the paste target could not be read back, so the paste is unverified."
              : "The clipboard no longer holds the pasted table and the paste target could not be read back.",
          method: "clipboard-readback",
        }
      }
    }
    return { status: "unverified", message: "No target readback was available to confirm the paste.", method: "clipboard-readback" }
  }

  private async verifyClipboardWrite(computer: ManagedComputer, text: string): Promise<Verification> {
    const method = "clipboard-readback"
    if (!computer.driver.readClipboard) {
      return { status: "unverified", message: "The clipboard cannot be re-read on this computer.", method }
    }
    const read = await computer.driver.readClipboard().catch(() => undefined)
    if (read?.success !== true || typeof read.text !== "string") {
      return { status: "unverified", message: "The clipboard could not be read back after writing.", method }
    }
    return read.text === text
      ? {
          status: "verified",
          message: "The clipboard readback matches the written text.",
          method,
          evidence: [{ kind: "clipboard-readback", value: JSON.stringify({ length: read.text.length, hash: read.hash }) }],
        }
      : {
          status: "unverified",
          message: "The clipboard does not contain the written text.",
          method,
        }
  }

  private async failureContext(computer: ManagedComputer): Promise<readonly string[]> {
    const observation = await computer.driver.observe().catch(() => undefined)
    const elements = observation?.elements ?? []
    const focused = elements.find((element) => (element.states ?? []).includes("focused"))
    const application = String(focused?.metadata?.application ?? "")
    const lines: string[] = []
    if (focused !== undefined) {
      lines.push(`focused: ${focused.role ?? "element"} "${focused.name ?? focused.text ?? focused.id ?? ""}"`)
    }
    for (const element of elements) {
      if (lines.length >= 15) break
      if (element.role === "window" || element.role === "dialog") {
        const name = element.name ?? element.label
        if (name !== undefined) lines.push(`${element.role}: ${name}`)
        continue
      }
      const elementApplication = String(element.metadata?.application ?? "")
      if (application.length > 0 && elementApplication !== application) continue
      const name = element.name ?? element.label
      if (name === undefined || name.length === 0) continue
      if (element.role === "menu" || element.role === "menubar" || element.role === "filler" || element.role === "panel") continue
      lines.push(`${element.role ?? "element"}: ${name}`)
    }
    return lines
  }

  private async executeBrowser(
    request: ServerActionRequest,
    computerId: string,
    typedCredential?: { readonly credential?: ComputerCredential; readonly value?: string },
  ): Promise<{ httpStatus: number; result: ActionResult }> {
    // A paired remote computer carries its own browser on the user's machine;
    // only fall back to the server-global controller when the computer has none.
    const computer = this.computers.get(computerId)
    const browser = computer?.driver.browser ?? this.browser
    if (browser === undefined) {
      return {
        httpStatus: 501,
        result: {
          success: false,
          status: "unavailable",
          message: "No browser runtime is connected to this Omnia Server.",
          error: { code: "operation_unavailable", message: "No browser runtime is connected.", retryable: false },
        },
      }
    }
    const action = request.action
    const ok = (message: string, metadata: JsonObject, verification?: Verification): { httpStatus: number; result: ActionResult } => ({
      httpStatus: 200,
      result: {
        success: true,
        status: "success",
        message,
        metadata,
        ...(verification === undefined ? {} : { verification }),
      },
    })
    const fail = (code: string, message: string, retryable = true): { httpStatus: number; result: ActionResult } => ({
      httpStatus:
        code === "invalid_action"
          ? 400
          : code === "operation_unavailable"
            ? 501
            : code === "files_write_required" || code === "tab_not_owned"
              ? 403
              : code === "no_auth_challenge" || code === "auth_host_mismatch" || code === "dialog_open" || code === "file_chooser_open" || code === "no_file_chooser"
                ? 409
                : code === "download_failed" || code === "upload_failed"
                  ? 502
                  : 500,
      result: {
        success: false,
        status:
          code === "invalid_action" || code === "tab_not_owned" || code === "no_auth_challenge" || code === "auth_host_mismatch" || code === "file_chooser_open" || code === "no_file_chooser"
            ? "rejected"
            : "failed",
        message,
        error: { code, message, retryable },
      },
    })
    const sessionId = request.sessionId
    // Desktop calls (no session, no agent origin) are the embedded UI's own
    // requests and keep unrestricted tabs. Agent sessions get a per-session
    // tab allowlist so a guessed tab id cannot activate or close someone
    // else's page.
    const browserSession = sessionId === undefined ? (request.origin === "agent" ? "agent" : undefined) : `session:${sessionId}`
    // Browser read paging: offset/maxChars/limit are forwarded to the runtime
    // so the page answers real paging metadata instead of silently slicing.
    const readLimit = request.maxChars ?? request.limit
    const readOffset = request.offset
    const readOptions =
      sessionId === undefined && readOffset === undefined && readLimit === undefined
        ? {}
        : {
            ...(sessionId === undefined ? {} : { sessionId }),
            ...(readOffset === undefined ? {} : { offset: readOffset }),
            ...(readLimit === undefined ? {} : { limit: readLimit }),
            ...(request.maxChars === undefined ? {} : { maxChars: request.maxChars }),
          }
    // Tab ids are only meaningful within this computer registration and browser
    // controller. A replacement driver/browser must start with no ownership.
    const controllers = computer === undefined ? undefined : this.browserTabs.get(computer) ?? new WeakMap<BrowserController, Map<string, Set<string>>>()
    if (computer !== undefined && controllers !== undefined) this.browserTabs.set(computer, controllers)
    const sessions = controllers?.get(browser) ?? new Map<string, Set<string>>()
    controllers?.set(browser, sessions)
    if (browserSession !== undefined && !sessions.has(browserSession)) {
      if (sessions.size >= MAX_BROWSER_TAB_SESSIONS) {
        const oldest = sessions.keys().next().value
        if (oldest !== undefined) sessions.delete(oldest)
      }
      sessions.set(browserSession, new Set())
    }
    const owned = browserSession === undefined ? undefined : sessions.get(browserSession)
    const recordTab = (tabId: string | undefined): void => {
      if (browserSession === undefined || tabId === undefined || tabId.length === 0) return
      if (owned === undefined) return
      // Evicting the oldest entry here would silently hand a still-open tab to
      // whoever crosses the cap, so the cap is an explicit failure instead.
      if (!owned.has(tabId) && owned.size >= MAX_SESSION_TABS) {
        throw new CdpError(
          "tab_limit",
          `This session already owns ${MAX_SESSION_TABS} browser tabs; close one before opening another.`,
        )
      }
      // Keep the most recently opened/used owned tab as the remote fallback.
      owned.delete(tabId)
      owned.add(tabId)
    }
    const forgetTab = (tabId: string): void => {
      if (browserSession === undefined) return
      owned?.delete(tabId)
    }
    const requireOwnedTab = (tabId: string | undefined): { httpStatus: number; result: ActionResult } | undefined => {
      if (browserSession === undefined) return undefined
      if (tabId !== undefined && owned?.has(tabId) === true) return undefined
      return fail(
        "tab_not_owned",
        tabId === undefined
          ? "This session owns no browser tab; open a tab before using page actions."
          : `Tab ${tabId} is not owned by this session; open a tab before using its id.`,
        false,
      )
    }
    const current = request.tab === undefined && owned !== undefined && owned.size > 0 ? browser.currentTab?.(sessionId) : undefined
    const tab = request.tab ?? (owned === undefined ? undefined : current !== undefined && owned.has(current) ? current : [...owned].at(-1))
    const pageAction = action !== "browser_open" && action !== "browser_tabs" && action !== "browser_status" && action !== "browser_downloads"
    // Resolve and validate before even querying a dialog: remote controllers
    // omit currentTab, and undefined would dispatch against the global page.
    if (pageAction) {
      const denied = requireOwnedTab(tab)
      if (denied !== undefined) return denied
    }
    const activeTab = (explicit?: string): string | undefined => explicit ?? browser.currentTab?.(sessionId)
    type PageRead = { readonly page: BrowserPageSummary } | { readonly error: string }
    const readPage = async (tabId?: string): Promise<PageRead> => {
      try {
        return { page: await browser.read(tabId, readOptions) }
      } catch (error) {
        return { error: browserFailure(error).code }
      }
    }
    // A JavaScript dialog blocks the page's renderer, so any other page command
    // would sit until the CDP timeout. Querying the dialog is bridge-only and
    // never stalls; a failure to query (older runtime) degrades to no dialog.
    const requeryDialog = async (): Promise<BrowserDialogSummary | null | undefined> => {
      if (browserSession !== undefined && (tab === undefined || owned?.has(tab) !== true)) return undefined
      const query = browser.pendingDialog
      if (query === undefined) return undefined
      return query.call(browser, tab, sessionId).catch(() => undefined)
    }
    const pendingDialog = async (): Promise<BrowserDialogSummary | null> => (await requeryDialog()) ?? null
    const dialogMetadata = (dialog: BrowserDialogSummary | null): JsonObject =>
      dialog === null ? {} : { dialog: { ...dialog } }
    const dialogOpen = (dialog: BrowserDialogSummary): { httpStatus: number; result: ActionResult } => {
      const message = `The page has an open ${dialog.type} dialog; answer it with browser_dialog before continuing.`
      return {
        httpStatus: 409,
        result: {
          success: false,
          status: "rejected",
          message,
          metadata: { dialog: { ...dialog } },
          error: {
            code: "dialog_open",
            message,
            retryable: true,
          },
        },
      }
    }
    const dialogBlocked = (code: string, message: string): { httpStatus: number; result: ActionResult } => ({
      httpStatus: 409,
      result: {
        success: false,
        status: "rejected",
        message,
        error: { code, message, retryable: true },
      },
    })
    const unverified = (message: string, method: string): Verification => ({ status: "unverified", message, method })
    // FAIL-CLOSED observation binding for browser targets. Both the targeted
    // reference (target.observationId) and the top-level observationId are
    // preserved from the API body; a mismatch means the caller resolved
    // against a different page/document and must re-find. Element ids carry
    // the document they were resolved in as "id@documentId" (see
    // page-script REF_HELPERS); when that document differs from any supplied
    // observationId the target is stale.
    const browserStale = (
      elementId?: string,
    ): { httpStatus: number; result: ActionResult } | undefined => {
      const targetObs = request.target?.observationId
      const topObs = request.observationId
      if (targetObs !== undefined && topObs !== undefined && targetObs !== topObs) {
        const message = `The browser target was resolved in observation ${targetObs}, but the request carries observation ${topObs}; re-find the element.`
        return {
          httpStatus: 409,
          result: {
            success: false,
            status: "rejected",
            message,
            error: { code: "target_stale", message, retryable: true },
          },
        }
      }
      const expected = targetObs ?? topObs
      if (expected === undefined) return undefined
      const doc = browserDocumentId(elementId ?? request.target?.elementId)
      if (doc === undefined) return undefined
      if (expected !== doc && expected !== elementId && expected !== request.target?.elementId) {
        const message = `The browser target belongs to document ${doc}, but observation ${expected} was supplied; the page changed since the find.`
        return {
          httpStatus: 409,
          result: {
            success: false,
            status: "rejected",
            message,
            error: { code: "target_stale", message, retryable: true },
          },
        }
      }
      return undefined
    }
    // Arbitrary save paths would otherwise let a browser-only approval write
    // anywhere on the host; keep writes inside the Omnia downloads sandbox or
    // the OS temp directory unless FILES_WRITE is granted. This is the
    // permission gate only: the runtime independently enforces the sandbox on
    // the machine that performs the write. relative() keeps Windows
    // separators correct.
    const imagePathAllowed = (path: string): boolean => {
      const target = resolve(path)
      const roots = [resolve(imageDownloadsDir()), resolve(tmpdir())]
      return roots.some((root) => {
        if (target === root) return true
        const contained = relative(root, target)
        return contained.length > 0 && !contained.startsWith("..") && !isAbsolute(contained)
      })
    }
    const imageWriteDenied = (path: string | undefined): { httpStatus: number; result: ActionResult } | undefined => {
      if (path === undefined || path.length === 0 || imagePathAllowed(path)) return undefined
      const operation: OperationInput = { action: "browser_save_image", resources: [path] }
      const decision = this.permissions.evaluate(["FILES_WRITE"], {
        sessionId: request.sessionId,
        approval: this.approvalInput(request),
        operation,
      })
      if (decision.allowed) return undefined
      return {
        httpStatus: decision.status === "denied" ? 403 : 428,
        result: {
          success: false,
          status: "rejected",
          message: `Saving an image outside the Omnia downloads folder needs FILES_WRITE approval: ${decision.reason ?? "permission required"}`,
          error: {
            code: decision.status === "denied" ? "permission_denied" : "files_write_required",
            message: "Saving outside the Omnia downloads folder needs FILES_WRITE approval.",
            retryable: true,
          },
        },
      }
    }
    this.events.emit("browser.action", {
      ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
      data: { action },
    })

    const emitNavigated = (current: string | undefined, url: string | undefined): void => {
      this.events.emit("browser.navigated", {
        computerId,
        ...(sessionId === undefined ? {} : { sessionId }),
        data: { ...(current === undefined ? {} : { tab: current }), ...(url === undefined ? {} : { url }) },
      })
    }
    try {
      // Fail fast while a dialog blocks the renderer. browser_dialog is the one
      // action allowed through (it is the answer), and browser_status/read are
      // pre-checked too so a blocked command never waits out the CDP timeout.
      if (action !== "browser_dialog" && (browserSession === undefined || pageAction || action === "browser_status")) {
        const dialog = await pendingDialog()
        if (dialog !== null) return dialogOpen(dialog)
      }
      switch (action) {
        case "browser_dialog": {
          const answerDialog = browser.handleDialog
          if (answerDialog === undefined) {
            return fail("operation_unavailable", "Answering page dialogs is unavailable in this browser runtime.", false)
          }
          const choice = request.dialog
          if (choice !== "accept" && choice !== "dismiss") {
            return fail("invalid_action", 'The browser_dialog action needs dialog "accept" or "dismiss".')
          }
          const denied = requireOwnedTab(tab)
          if (denied !== undefined) return denied
          const pending = await pendingDialog()
          if (pending === null) return dialogBlocked("dialog_not_open", "There is no page dialog to answer.")
          const mismatch =
            (request.expectedType !== undefined && request.expectedType !== pending.type) ||
            (request.expectedMessage !== undefined && request.expectedMessage !== pending.message)
          if (mismatch) {
            return dialogBlocked(
              "dialog_mismatch",
              `The pending dialog does not match the expectation; it is a ${pending.type} dialog.`,
            )
          }
          try {
            await answerDialog.call(browser, {
              ...(tab === undefined ? {} : { tabId: tab }),
              ...(sessionId === undefined ? {} : { sessionId }),
              accept: choice === "accept",
              ...(request.promptText === undefined ? {} : { promptText: request.promptText }),
              ...(request.expectedType === undefined ? {} : { expectedType: request.expectedType }),
              ...(request.expectedMessage === undefined ? {} : { expectedMessage: request.expectedMessage }),
            })
          } catch (error) {
            const failure = browserFailure(error)
            if (failure.code === "dialog_not_open" || failure.code === "dialog_mismatch") {
              return dialogBlocked(failure.code, failure.message)
            }
            throw error
          }
          // FAIL-CLOSED verification: a resolved handler call is not proof the
          // dialog actually went away, so the runtime is re-queried independently
          // and the same tab must still read back afterwards. Any missing piece
          // is an explicit unverified with the reason.
          const remaining = await requeryDialog()
          // Only touch the page once the dialog is confirmed gone; a read while
          // it is still pending would itself wait out the CDP timeout.
          const read = remaining === null ? await readPage(tab) : undefined
          const verification: Verification =
            remaining === null && read !== undefined && "page" in read
              ? {
                  status: "verified",
                  message: "The dialog closed and an independent page read succeeded.",
                  method: "browser-dialog-readback",
                  evidence: [
                    {
                      kind: "browser-dialog",
                      value: JSON.stringify({
                        type: pending.type,
                        action: choice,
                        cleared: true,
                        readUrl: read.page.url,
                      }),
                    },
                  ],
                }
              : unverified(
                  remaining === undefined
                    ? "The dialog state could not be re-read independently after answering."
                    : remaining !== null
                      ? "The dialog is still pending after the answer."
                      : `The page could not be read back after answering the dialog (${read !== undefined && "error" in read ? read.error : "unknown"}).`,
                  "browser-dialog-readback",
                )
          return ok(
            choice === "accept" ? `Accepted the ${pending.type} dialog.` : `Dismissed the ${pending.type} dialog.`,
            { dialog: { ...pending }, ...(tab === undefined ? {} : { tab }) },
            verification,
          )
        }
        case "browser_status": {
          const status = await browser.status()
          const dialog = await pendingDialog()
          return ok(
            status.running
              ? `Browser running${status.browser === undefined ? "" : ` (${status.browser})`} with ${status.tabs} tab(s).`
              : "The browser runtime is not running yet; the first browser action starts it.",
            { status: { ...status }, ...dialogMetadata(dialog) },
          )
        }
        case "browser_open": {
          const opened = await browser.open(request.url)
          recordTab(opened.id)
          this.events.emit("browser.launched", {
            computerId,
            ...(sessionId === undefined ? {} : { sessionId }),
            data: { tab: opened.id, url: opened.url },
          })
          // Real verification: the new tab's page must independently read
          // back the opened URL. A controller echo alone never verifies.
          const read = await readPage(opened.id)
          const verification =
            "page" in read && sameBrowserUrl(read.page.url, opened.url)
              ? {
                  status: "verified" as const,
                  message: `Independent page read confirms ${read.page.url}.`,
                  method: "browser-url-readback",
                  evidence: [
                    { kind: "browser-url", value: JSON.stringify({ opened: opened.url, read: read.page.url }) },
                  ],
                }
              : unverified(
                  "page" in read
                    ? `The page read back ${read.page.url} instead of ${opened.url}.`
                    : `The page could not be read back after opening (${read.error}).`,
                  "browser-url-readback",
                )
          return ok(`Opened ${opened.url}.`, { tab: { id: opened.id, url: opened.url } }, verification)
        }
        case "browser_tabs": {
          const tabs = await browser.tabs()
          // Agent sessions only see tabs they own; the desktop UI keeps the
          // unrestricted list because it is the surface that manages them.
          const visible = owned === undefined ? tabs : tabs.filter((entry) => owned.has(entry.id))
          return ok(`${visible.length} tab(s) open.`, {
            tabs: visible.map((entry) => ({
              id: entry.id,
              url: entry.url,
              ...(entry.title === undefined ? {} : { title: entry.title }),
              ...(entry.active === undefined ? {} : { active: entry.active }),
            })),
          })
        }
        case "browser_activate_tab": {
          if (request.tab === undefined || tab === undefined) return fail("invalid_action", "Activating a tab needs a tab id.")
          const denied = requireOwnedTab(tab)
          if (denied !== undefined) return denied
          await browser.activate(tab)
          recordTab(tab)
          // Activation has no page-content side effect to read back. FAIL-CLOSED:
          // return an explicit unverified instead of implying success verified.
          // When the runtime exposes the active tab, a matching readback
          // verifies; otherwise the caller must observe before continuing.
          const current = browser.currentTab?.(sessionId)
          const verification =
            current !== undefined && current === tab
              ? {
                  status: "verified" as const,
                  message: `Independent tab read confirms ${tab} is active.`,
                  method: "browser-activate-readback",
                  evidence: [{ kind: "browser-tab", value: JSON.stringify({ tab, current }) }],
                }
              : unverified(
                  current === undefined
                    ? `Activated tab ${tab}, but the active tab could not be read back to confirm it.`
                    : `The active tab read back as ${current} instead of ${tab}.`,
                  "browser-activate-readback",
                )
          return ok(`Activated tab ${tab}.`, { tab }, verification)
        }
        case "browser_close_tab": {
          if (request.tab === undefined || tab === undefined) return fail("invalid_action", "Closing a tab needs a tab id.")
          const denied = requireOwnedTab(tab)
          if (denied !== undefined) return denied
          await browser.closeTab(tab)
          forgetTab(tab)
          // Independent readback: the runtime's own tab list must no longer
          // report the tab before the close is reported as success.
          const remaining = await browser.tabs().catch(() => undefined)
          const verification =
            remaining === undefined
              ? unverified(
                  `Closed tab ${tab}, but the tab list could not be read back to confirm it.`,
                  "browser-tabs-readback",
                )
              : remaining.some((entry) => entry.id === tab)
                ? unverified(`The tab list still reports tab ${tab} after closing it.`, "browser-tabs-readback")
                : {
                    status: "verified" as const,
                    message: `Independent tab list read confirms ${tab} is gone.`,
                    method: "browser-tabs-readback",
                    evidence: [
                      {
                        kind: "browser-tabs",
                        value: JSON.stringify({ closed: tab, remaining: remaining.map((entry) => entry.id) }),
                      },
                    ],
                  }
          return ok(`Closed tab ${tab}.`, { tab }, verification)
        }
        case "browser_navigate": {
          if (request.url === undefined || request.url.length === 0) return fail("invalid_action", "Navigating needs a url.")
          const denied = requireOwnedTab(tab)
          if (denied !== undefined) return denied
          const navigated = await browser.navigate(request.url, tab, sessionId)
          recordTab(navigated.id)
          // Independent readback: the page itself must report the navigated URL.
          const read = await readPage(navigated.id)
          const verification =
            "page" in read && sameBrowserUrl(read.page.url, navigated.url)
              ? {
                  status: "verified" as const,
                  message: `Independent page read confirms ${read.page.url}.`,
                  method: "browser-url-readback",
                  evidence: [
                    {
                      kind: "browser-url",
                      value: JSON.stringify({ requested: request.url, navigated: navigated.url, read: read.page.url }),
                    },
                  ],
                }
              : unverified(
                  "page" in read
                    ? `The page read back ${read.page.url} instead of ${navigated.url}.`
                    : `The page could not be read back after navigating (${read.error}).`,
                  "browser-url-readback",
                )
          emitNavigated(navigated.id, navigated.url)
          return ok(`Navigated to ${navigated.url}.`, { tab: { id: navigated.id, url: navigated.url } }, verification)
        }
        case "browser_read": {
          const denied = requireOwnedTab(tab)
          if (denied !== undefined) return denied
          const page = await browser.read(tab, readOptions)
          const current = activeTab(tab)
          recordTab(current ?? tab)
          if (tab !== undefined) recordTab(tab)
          // Fail-closed paging defaults for legacy controllers that omit the
          // fields: offset 0, totalLength=length, truncated=false.
          const offset = page.offset ?? 0
          const totalLength = page.totalLength ?? page.length
          const truncated = page.truncated ?? false
          const dialog = await pendingDialog()
          return ok(`${page.title === "" ? page.url : page.title} (${page.length} characters).`, {
            url: page.url,
            title: page.title,
            length: page.length,
            hash: page.hash,
            text: page.text,
            offset,
            totalLength,
            truncated,
            ...(page.sourceTruncated === undefined ? {} : { sourceTruncated: page.sourceTruncated }),
            ...(page.viewport === undefined ? {} : { viewport: { width: page.viewport.width, height: page.viewport.height } }),
            ...(current === undefined ? {} : { tab: current }),
            ...dialogMetadata(dialog),
          })
        }
        case "browser_find": {
          if (request.query === undefined || request.query.trim().length === 0) return fail("invalid_action", "Finding needs a query.")
          const denied = requireOwnedTab(tab)
          if (denied !== undefined) return denied
          const candidates = await browser.find(request.query, {
            ...(tab === undefined ? {} : { tabId: tab }),
            ...(request.role === undefined ? {} : { role: request.role }),
            limit: typeof request.limit === "number" ? request.limit : 8,
            ...readOptions,
          })
          const current = activeTab(tab)
          recordTab(current)
          return ok(
            candidates.length === 0
              ? `No page element matched "${request.query}".`
              : `Found ${candidates.length} page element(s) for "${request.query}".`,
            {
              ...(current === undefined ? {} : { tab: current }),
              candidates: candidates.map((candidate) => ({
                id: candidate.id,
                role: candidate.role,
                name: candidate.name,
                ...(candidate.visible === undefined ? {} : { visible: candidate.visible }),
                ...(candidate.disabled === undefined ? {} : { disabled: candidate.disabled }),
                ...(candidate.score === undefined ? {} : { score: candidate.score }),
                ...(candidate.rect === undefined
                  ? {}
                  : { rect: { x: candidate.rect.x, y: candidate.rect.y, width: candidate.rect.width, height: candidate.rect.height } }),
                ...(candidate.center === undefined ? {} : { center: { x: candidate.center.x, y: candidate.center.y } }),
              })),
            },
          )
        }
        case "browser_images": {
          const listImages = browser.images
          if (listImages === undefined) {
            return fail("operation_unavailable", "Listing images is unavailable in this browser runtime.", false)
          }
          const denied = requireOwnedTab(tab)
          if (denied !== undefined) return denied
          const images = await listImages.call(browser, tab, {
            limit: typeof request.limit === "number" ? request.limit : 24,
            ...readOptions,
          })
          const current = activeTab(tab)
          recordTab(current)
          return ok(
            images.length === 0 ? "No images were found on the page." : `Found ${images.length} image(s) on the page.`,
            {
              ...(current === undefined ? {} : { tab: current }),
              images: images.map((image) => ({
                id: image.id,
                src: image.src,
                ...(image.alt.length === 0 ? {} : { alt: image.alt }),
                width: image.width,
                height: image.height,
                naturalWidth: image.naturalWidth,
                naturalHeight: image.naturalHeight,
                visible: image.visible,
                ...(image.rect === undefined ? {} : { rect: { x: image.rect.x, y: image.rect.y, width: image.rect.width, height: image.rect.height } }),
                ...(image.link === undefined ? {} : { link: image.link }),
              })),
            },
          )
        }
        case "browser_save_image": {
          const saveImage = browser.saveImage
          if (saveImage === undefined) {
            return fail("operation_unavailable", "Saving images is unavailable in this browser runtime.", false)
          }
          const denied = requireOwnedTab(tab)
          if (denied !== undefined) return denied
          const stale = browserStale(request.target?.elementId)
          if (stale !== undefined) return stale
          const pathDenied = imageWriteDenied(request.path)
          if (pathDenied !== undefined) return pathDenied
          // An out-of-sandbox path only reaches this point with FILES_WRITE
          // approval; pass that decision to the runtime, which still resolves
          // and verifies the final path on the machine doing the write.
          const allowOutside = request.path !== undefined && !imagePathAllowed(request.path)
          const saved = await saveImage.call(browser, {
            ...(tab === undefined ? {} : { tabId: tab }),
            ...(request.target?.elementId === undefined ? {} : { id: request.target.elementId }),
            ...(request.url === undefined ? {} : { url: request.url }),
            ...(request.query === undefined ? {} : { query: request.query }),
            ...(request.path === undefined ? {} : { path: request.path }),
            ...(request.name === undefined ? {} : { filename: request.name }),
            ...(allowOutside ? { allowOutside: true } : {}),
            ...readOptions,
          })
          recordTab(activeTab(tab))
          const verification =
            saved.hash === undefined
              ? unverified(
                  `Saved ${saved.bytes} byte(s) to ${saved.path}, but the runtime returned no disk readback hash.`,
                  "browser-image-readback",
                )
              : {
                  status: "verified" as const,
                  message: `Disk readback on the runtime confirms ${saved.bytes} byte(s) at ${saved.path} (sha256 ${saved.hash}).`,
                  method: "browser-image-readback",
                  evidence: [
                    {
                      kind: "browser-image",
                      value: JSON.stringify({ path: saved.path, bytes: saved.bytes, hash: saved.hash }),
                    },
                  ],
                }
          return ok(
            `Saved the image to ${saved.path} (${saved.bytes} bytes).`,
            {
              path: saved.path,
              bytes: saved.bytes,
              ...(saved.hash === undefined ? {} : { hash: saved.hash }),
              ...(saved.mimeType === undefined ? {} : { mimeType: saved.mimeType }),
              src: saved.src,
              ...(saved.alt.length === 0 ? {} : { alt: saved.alt }),
              method: saved.method,
            },
            verification,
          )
        }
        case "browser_copy_image": {
          const saveImage = browser.saveImage
          const computer = this.computers.get(computerId)
          const writeImage = computer?.driver.writeClipboardImage
          if (saveImage === undefined || computer === undefined || writeImage === undefined) {
            return fail("operation_unavailable", "Copying images to the clipboard is unavailable on this computer; save the image instead.")
          }
          const denied = requireOwnedTab(tab)
          if (denied !== undefined) return denied
          const stale = browserStale(request.target?.elementId)
          if (stale !== undefined) return stale
          // Stage inside the downloads sandbox with a per-call private
          // directory (avoids predictable-path symlink attacks and keeps the
          // runtime's own containment check satisfied); the temporary file is
          // removed after the clipboard takes ownership of the bytes.
          mkdirSync(imageDownloadsDir(), { recursive: true })
          const dir = mkdtempSync(join(imageDownloadsDir(), ".copy-"))
          try {
            const temp = join(dir, "image.png")
            const saved = await saveImage.call(browser, {
              ...(tab === undefined ? {} : { tabId: tab }),
              ...(request.target?.elementId === undefined ? {} : { id: request.target.elementId }),
              ...(request.url === undefined ? {} : { url: request.url }),
              ...(request.query === undefined ? {} : { query: request.query }),
              path: temp,
              // The server owns the staging path, so it authorizes it on the
              // write machine; the runtime still resolves and reads it back.
              allowOutside: true,
              ...readOptions,
            })
            const written = await writeImage.call(computer.driver, saved.path)
            if (!written.success) return fail("clipboard_failed", written.message ?? "Could not copy the image.", true)
            recordTab(activeTab(tab))
            const verification =
              saved.hash === undefined
                ? unverified(
                    `Copied ${saved.bytes} byte(s) to the clipboard, but the runtime returned no disk readback hash.`,
                    "browser-clipboard-image",
                  )
                : {
                    status: "verified" as const,
                    message: `The clipboard write succeeded for ${saved.bytes} byte(s) independently read back from ${saved.path} (sha256 ${saved.hash}).`,
                    method: "browser-clipboard-image",
                    evidence: [
                      {
                        kind: "browser-image",
                        value: JSON.stringify({ path: saved.path, bytes: saved.bytes, hash: saved.hash }),
                      },
                    ],
                  }
            return ok(
              "Copied the image to the clipboard.",
              {
                path: saved.path,
                bytes: saved.bytes,
                ...(saved.hash === undefined ? {} : { hash: saved.hash }),
                ...(saved.mimeType === undefined ? {} : { mimeType: saved.mimeType }),
                src: saved.src,
              },
              verification,
            )
          } finally {
            rmSync(dir, { recursive: true, force: true })
          }
        }
        case "browser_downloads": {
          if (browser.downloads === undefined) {
            return fail("operation_unavailable", "This browser runtime cannot list downloads.", false)
          }
          const downloads = await browser.downloads()
          const items = downloads.map((entry) => ({
            id: entry.id,
            url: entry.url,
            filename: entry.filename,
            path: entry.path,
            state: entry.state,
            receivedBytes: entry.receivedBytes,
            totalBytes: entry.totalBytes,
            startedAt: entry.startedAt,
            ...(entry.finishedAt === undefined ? {} : { finishedAt: entry.finishedAt }),
            ...(entry.mimeType === undefined ? {} : { mimeType: entry.mimeType }),
            ...(entry.error === undefined ? {} : { error: entry.error }),
          }))
          const completed = downloads.filter((entry) => entry.state === "completed" && entry.receivedBytes > 0)
          const failed = downloads.filter((entry) => entry.state === "interrupted" || entry.state === "cancelled")
          const verification: Verification =
            completed.length > 0
              ? {
                  status: "verified" as const,
                  message: `${completed.length} download(s) completed with a non-zero size (reported by the browser that saved them).`,
                  method: "browser-download-registry",
                  evidence: completed.slice(0, 5).map((entry) => ({
                    kind: "browser-download",
                    value: JSON.stringify({ filename: entry.filename, path: entry.path, bytes: entry.receivedBytes }),
                  })),
                }
              : downloads.length === 0
                ? unverified("No downloads have been started in this browser.", "browser-download-registry")
                : failed.length === downloads.length
                  ? {
                      status: "failed" as const,
                      message: `${failed.length} download(s) failed or were cancelled.`,
                      method: "browser-download-registry",
                    }
                  : unverified("Downloads are still in progress.", "browser-download-registry")
          return ok(`${downloads.length} download(s); ${completed.length} completed.`, { downloads: items }, verification)
        }
        case "browser_login": {
          const denied = requireOwnedTab(tab)
          if (denied !== undefined) return denied
          const credential = typedCredential?.credential
          const username = credential?.username
          const secret = credential?.secret
          // Zero-trust: the secret only ever exists here, server-side, on its
          // way into the page. It is never accepted from the request body, so a
          // model can neither read nor echo it.
          if (credential === undefined || username === undefined || username.length === 0 || secret === undefined) {
            return fail(
              "invalid_action",
              "browser_login needs a stored credential with a username and a secret. Reference it with credential: \"auto\" or a name; secrets are never passed as text.",
              false,
            )
          }
          const pending = await pendingDialog()
          if (pending !== null) return dialogOpen(pending)
          const resolveField = (spec: string | undefined, queries: readonly string[], role: string, exclude: Set<string>) =>
            resolveLoginField(browser, {
              ...(spec === undefined ? {} : { spec }),
              queries,
              role,
              exclude,
              ...(tab === undefined ? {} : { tab }),
              ...(sessionId === undefined ? {} : { sessionId }),
            })
          const filled = new Set<string>()
          const steps: JsonObject[] = []
          let submittedAny = false
          let lastUrl: string | undefined
          let secretTyped = false
          // Two-step sign-ins (Google, Apple, SSO portals) put the identifier
          // and the secret on separate pages, so the action follows the flow
          // across pages instead of expecting both fields at once.
          const outcome = (message: string, metadata: JsonObject, verification: Verification) => ({
            httpStatus: 200,
            result: redactResultCredential(ok(message, metadata, verification).result, credential),
          })
          const reported = (value: boolean) => ({ submitted: value || submittedAny })
          const unproved = (message: string): Verification => ({
            status: "unverified",
            message,
            method: "browser-login-readback",
          })
          for (let attempt = 0; attempt < 3; attempt += 1) {
            const before = await readPage(tab)
            if ("error" in before) {
              return fail("page_unreadable", "The page could not be read before the login attempt.", true)
            }
            const exclude = new Set(filled)
            const passwordField = await resolveField(request.passwordField, LOGIN_PASSWORD_QUERIES, "textbox", exclude)
            exclude.add(passwordField?.id ?? "")
            const usernameField = await resolveField(request.usernameField, LOGIN_USERNAME_QUERIES, "textbox", exclude)
            // Typing just an identifier is opt-in. By default the secret needs a
            // password field on the first page, so an unrelated form with an
            // email box is never mistaken for a sign-in step.
            if (passwordField === undefined && usernameField !== undefined && attempt === 0 && request.identifierFirst !== true) {
              return fail(
                "login_field_not_found",
                "This page has no password field, so the secret was not typed. If the sign-in asks for the identifier first and the secret on a later page (Google, Apple, SSO), re-run with identifierFirst: true; otherwise point passwordField at the field.",
                true,
              )
            }
            // The secret is never typed into a page whose identifier field we
            // could not identify: on a later page that is legitimate (the
            // identifier was already submitted), and the caller says so by
            // passing usernameField.
            if (
              passwordField !== undefined &&
              usernameField === undefined &&
              attempt === 0 &&
              request.usernameField === undefined
            ) {
              return fail(
                "login_field_not_found",
                "No username field could be identified, so the secret was not typed. Find the field with browser_find and pass usernameField (or its query) with it.",
                true,
              )
            }
            if (passwordField === undefined && usernameField === undefined) {
              const idle = activeTab(tab)
              return outcome(
                "The page no longer offers a username or password field, so there is nothing left for this action to fill.",
                { steps, ...(idle === undefined ? {} : { tab: idle }) },
                unproved(
                  steps.length === 0
                    ? "Nothing was filled on this page: it has no username or password field. Read it to see what it asks for next (a one-time code, a device prompt, a CAPTCHA) and continue with the matching action."
                    : `The flow advanced past the login form but nothing proves the credential was accepted: a rejected login navigates away the same way. Pass expect (text on the signed-in page, or expectUrlContains) so this login can be verified, and read the page for a one-time code or device prompt.${
                        submittedAny ? "" : " Nothing was submitted."
                      }`,
                ),
              )
            }
            const staleField = browserStale(usernameField?.id) ?? browserStale(passwordField?.id)
            if (staleField !== undefined) return staleField
            if (usernameField !== undefined) {
              await browser.type({
                ...(tab === undefined ? {} : { tabId: tab }),
                ...(sessionId === undefined ? {} : { sessionId }),
                id: usernameField.id,
                text: username,
              })
              filled.add(usernameField.id)
            }
            if (passwordField !== undefined) {
              await browser.type({
                ...(tab === undefined ? {} : { tabId: tab }),
                ...(sessionId === undefined ? {} : { sessionId }),
                id: passwordField.id,
                text: secret,
              })
              filled.add(passwordField.id)
              secretTyped = true
            }
            if (passwordField !== undefined) {
              // The audit trail records that the credential was used, never its
              // value, as soon as it reaches the page.
              this.events.emit("credential.used", {
                computerId,
                ...(sessionId === undefined ? {} : { sessionId }),
                data: { credentialId: credential.id, credentialName: credential.name },
              })
            }
            const current = activeTab(tab)
            recordTab(current)
            const submitField =
              request.submit === false
                ? undefined
                : await resolveField(undefined, LOGIN_SUBMIT_QUERIES, "button", new Set(filled))
            if (submitField !== undefined) {
              await browser.click({
                ...(tab === undefined ? {} : { tabId: tab }),
                ...(sessionId === undefined ? {} : { sessionId }),
                id: submitField.id,
              })
              submittedAny = true
              recordTab(activeTab(tab))
            }
            steps.push({
              step: attempt + 1,
              ...(usernameField === undefined ? {} : { usernameField: usernameField.name }),
              ...(passwordField === undefined ? {} : { passwordField: passwordField.name }),
              submitted: submitField !== undefined,
            })
            const after = await readPage(tab)
            const afterUrl = "page" in after ? after.page.url : undefined
            const afterText = "page" in after ? (after.page.text ?? "") : ""
            // Probe with a clean exclusion set: the fields we just typed into
            // are exactly the ones whose disappearance proves we left the form.
            const formStillThere =
              "page" in after &&
              (await resolveField(undefined, LOGIN_PASSWORD_QUERIES, "textbox", new Set<string>())) !== undefined
            const urlMatched =
              request.expect?.urlContains !== undefined &&
              afterUrl !== undefined &&
              afterUrl.includes(request.expect.urlContains)
            const textMatched = request.expect?.text !== undefined && afterText.includes(request.expect.text)
            // A declared signal plus a form that is gone is the only proof of a
            // completed login; navigating away is not (a rejected login does).
            if (!formStillThere && (urlMatched || textMatched)) {
              return outcome(
                "Signed in with the stored credential; the page matches the expected signed-in state.",
                { steps, ...reported(true), verified: true, ...(current === undefined ? {} : { tab: current }) },
                {
                  status: "verified",
                  message: urlMatched
                    ? "An independent page read after submitting shows the expected signed-in URL and the login form is gone."
                    : "An independent page read after submitting shows the expected signed-in text and the login form is gone.",
                  method: "browser-login-readback",
                  evidence: [
                    {
                      kind: "browser-page-change",
                      value: JSON.stringify({
                        steps: steps.length,
                        url: urlMatched ? "matched" : "no-match",
                        text: textMatched ? "matched" : "no-match",
                        formGone: !formStillThere,
                      }),
                    },
                  ],
                },
              )
            }
            if (submitField === undefined) {
              return outcome(
                "Filled the stored credential into the login form; no submit control was found, so nothing was submitted.",
                { steps, ...reported(false), ...(current === undefined ? {} : { tab: current }) },
                unproved(
                  "The credential was typed, but the form was not submitted and the login is not proven. Find the submit control, or use submit: false deliberately and submit it yourself.",
                ),
              )
            }
            const movedOn = afterUrl !== undefined && !sameBrowserUrl(before.page.url, afterUrl)
            // The only safe continuation is a page that still needs the secret:
            // that is step two of a two-page sign-in. A reload after a rejected
            // login hands back a fresh form with new element ids, so continuing
            // on anything else would resubmit the same credential.
            if (formStillThere && secretTyped) {
              return outcome(
                "The login form was submitted and the page asks for the same secret again, so the credential was rejected.",
                { steps, ...reported(true), ...(current === undefined ? {} : { tab: current }) },
                unproved(
                  "The form came back with a password field again: a rejected password, a locked account, or a captcha all look like this. Read the page for the reason before trying anything else, and never resend the same credential blindly.",
                ),
              )
            }
            if (!formStillThere) {
              return outcome(
                "The sign-in flow moved past the login form.",
                { steps, ...reported(true), ...(lastUrl === undefined && afterUrl === undefined ? {} : { url: afterUrl }) },
                unproved(
                  `Leaving the form is not proof: a rejected login navigates away the same way.${
                    movedOn ? "" : " The page did not even change."
                  } Pass expect (text on the signed-in page, or expectUrlContains) so this login can be verified.`,
                ),
              )
            }
            if (request.submit === false) {
              return outcome(
                "Filled the stored credential without submitting, as requested.",
                { steps, ...reported(false) },
                unproved(""),
              )
            }
            lastUrl = afterUrl
          }
          return outcome(
            `Filled the credential across ${steps.length} page(s) of the sign-in flow, but the final page did not match the expected signed-in state.`,
            { steps, ...reported(true), ...(lastUrl === undefined ? {} : { url: lastUrl }) },
            unproved(
              "The flow advanced but never reached the declared signed-in state. Read the page: it probably asks for a one-time code or a device confirmation, which are different actions.",
            ),
          )
        }
        case "browser_auth": {
          if (browser.answerAuth === undefined || browser.authRequired === undefined) {
            return fail("operation_unavailable", "This browser runtime cannot answer authentication challenges.", false)
          }
          const challenge = await browser.authRequired().catch(() => null)
          if (challenge === null) {
            return fail("no_auth_challenge", "No HTTP authentication challenge is pending.", true)
          }
          if (request.expectedHost !== undefined && request.expectedHost !== challenge.host) {
            return fail(
              "auth_host_mismatch",
              `The pending challenge is for ${challenge.host}, not ${request.expectedHost}.`,
              false,
            )
          }
          const credential = typedCredential?.credential
          const username = credential?.username ?? request.username
          const password = credential?.secret ?? request.password
          if (username === undefined || username.length === 0 || password === undefined) {
            return fail("invalid_action", "browser_auth needs a stored credential or explicit username and password.", false)
          }
          await browser.answerAuth({ username, password })
          const after = await readPage(tab)
          const verification: Verification =
            "page" in after && sameBrowserUrl(after.page.url, challenge.url)
              ? {
                  status: "verified" as const,
                  message: `The page is readable after answering the challenge for ${challenge.host}.`,
                  method: "browser-auth-readback",
                  evidence: [
                    { kind: "browser-auth", value: JSON.stringify({ host: challenge.host, url: after.page.url }) },
                  ],
                }
              : unverified("The page could not be read back after answering the challenge.", "browser-auth-readback")
          if (credential !== undefined) {
            this.events.emit("credential.used", {
              computerId,
              ...(sessionId === undefined ? {} : { sessionId }),
              data: { credentialId: credential.id, credentialName: credential.name },
            })
          }
          return ok(
            `Answered the authentication challenge for ${challenge.host}.`,
            { host: challenge.host, realm: challenge.realm, isProxy: challenge.isProxy },
            verification,
          )
        }
        case "browser_upload": {
          const denied = requireOwnedTab(tab)
          if (denied !== undefined) return denied
          const files = request.files
          if (
            files === undefined ||
            files.length === 0 ||
            files.length > 10 ||
            files.some((file) => typeof file !== "string" || file.length === 0 || file.length > 400)
          ) {
            return fail("invalid_action", "The browser_upload action needs files: 1-10 paths of at most 400 characters.")
          }
          const upload = browser.upload
          if (upload === undefined) {
            return fail("operation_unavailable", "Answering a file chooser is unavailable in this browser runtime.", false)
          }
          const uploaded = await upload.call(browser, files, tab, sessionId)
          const current = activeTab(tab)
          recordTab(current)
          const verification = await this.verifyBrowserUpload(browser, files, tab, sessionId, request.target?.elementId)
          return ok(
            `Attached ${uploaded.files.length} file(s) to the page's file input.`,
            { files: uploaded.files, ...(current === undefined ? {} : { tab: current }) },
            verification,
          )
        }
        case "browser_click": {
          const id = request.target?.elementId
          const denied = requireOwnedTab(tab)
          if (denied !== undefined) return denied
          const stale = browserStale(id)
          if (stale !== undefined) return stale
          if (request.button !== undefined && request.button !== "left" && request.button !== "right" && request.button !== "middle") {
            return fail("invalid_action", 'The browser_click button must be "left", "right", or "middle".')
          }
          const before = await readPage(tab)
          const clicked = await browser.click({
            ...(tab === undefined ? {} : { tabId: tab }),
            ...(id === undefined ? {} : { id }),
            ...(typeof request.x === "number" ? { x: request.x } : {}),
            ...(typeof request.y === "number" ? { y: request.y } : {}),
            ...(request.button === "left" || request.button === "right" || request.button === "middle"
              ? { button: request.button }
              : {}),
            ...readOptions,
          })
          // A target=_blank link opens a real tab through the bridge because
          // synthetic input cannot pass the popup blocker; verify the new tab.
          if (clicked.popup !== undefined) {
            recordTab(clicked.popup.tabId)
            const popup = await browser.read(clicked.popup.tabId, readOptions).catch(() => undefined)
            const popupVerified =
              popup !== undefined && popup.url !== undefined && popup.url.length > 0
            return ok(
              `Clicked ${clicked.role ?? "element"} "${clicked.name ?? id ?? "page"}" and opened ${clicked.popup.url} in a new tab.`,
              {
                clicked: {
                  ...(clicked.name === undefined ? {} : { name: clicked.name }),
                  ...(clicked.role === undefined ? {} : { role: clicked.role }),
                  ...(id === undefined ? {} : { id }),
                  ...(clicked.x === undefined ? {} : { x: clicked.x }),
                  ...(clicked.y === undefined ? {} : { y: clicked.y }),
                  tab: clicked.popup.tabId,
                  url: clicked.popup.url,
                },
                tab: clicked.popup.tabId,
              },
              popupVerified
                ? {
                    status: "verified" as const,
                    message: `An independent read of the new tab confirms ${clicked.popup.url}.`,
                    method: "browser-click-popup",
                    evidence: [{ kind: "browser-popup", value: JSON.stringify({ url: clicked.popup.url, tab: clicked.popup.tabId }) }],
                  }
                : unverified("The new tab could not be read back after the click.", "browser-click-popup"),
            )
          }
          const current = activeTab(tab)
          recordTab(current)
          const after = await readPage(tab)
          const beforePage = "page" in before ? before.page : undefined
          const afterPage = "page" in after ? after.page : undefined
          // Target-scoped readback: the verdict comes from re-reading the
          // target's own page (before/after on the same tab), not from a
          // global hash delta. The target id is part of the evidence so an
          // unrelated page change cannot verify a different target.
          const changed =
            beforePage !== undefined &&
            afterPage !== undefined &&
            (afterPage.hash !== beforePage.hash || !sameBrowserUrl(afterPage.url, beforePage.url))
          const verification = changed
            ? {
                status: "verified" as const,
                message:
                  id === undefined
                    ? "The page changed after the click."
                    : `The page for target ${id} changed after the click.`,
                method: "browser-click-readback",
                evidence: [
                  {
                    kind: "browser-page-change",
                    value: JSON.stringify({
                      ...(id === undefined ? {} : { target: id }),
                      before: beforePage === undefined ? null : { url: beforePage.url, hash: beforePage.hash },
                      after: afterPage === undefined ? null : { url: afterPage.url, hash: afterPage.hash },
                    }),
                  },
                ],
              }
            : unverified(
                afterPage === undefined
                  ? `The page could not be read back after the click (${"error" in after ? after.error : "unknown"}).`
                  : beforePage === undefined
                    ? `The page could not be read before the click (${"error" in before ? before.error : "unknown"}); the click effect cannot be compared.`
                    : id === undefined
                      ? "The page did not change after the click."
                      : `The page for target ${id} did not change after the click.`,
                "browser-click-readback",
              )
          return ok(
            `Clicked ${clicked.role ?? "element"} "${clicked.name ?? id ?? "page"}"${clicked.x === undefined ? "" : ` at pixel ${clicked.x},${clicked.y}`}.`,
            {
              clicked: {
                ...(clicked.name === undefined ? {} : { name: clicked.name }),
                ...(clicked.role === undefined ? {} : { role: clicked.role }),
                ...(id === undefined ? {} : { id }),
                ...(clicked.x === undefined ? {} : { x: clicked.x }),
                ...(clicked.y === undefined ? {} : { y: clicked.y }),
                ...(clicked.rect === undefined
                  ? {}
                  : { rect: { x: clicked.rect.x, y: clicked.rect.y, width: clicked.rect.width, height: clicked.rect.height } }),
                ...(request.button === "left" || request.button === "right" || request.button === "middle"
                  ? { button: request.button }
                  : {}),
              },
              ...(current === undefined ? {} : { tab: current }),
            },
            verification,
          )
        }
        case "browser_screenshot": {
          const denied = requireOwnedTab(tab)
          if (denied !== undefined) return denied
          if (browser.screenshot === undefined) return fail("operation_unavailable", "This browser runtime cannot capture its page.", false)
          const image = await browser.screenshot(tab, sessionId)
          if (image.mimeType !== "image/png" || typeof image.data !== "string" || !image.data || image.data.length > 14 * 1024 * 1024) {
            return fail("invalid_action", "The browser screenshot was missing or too large to return.")
          }
          return ok("Captured the browser viewport. Use its CSS pixel coordinates for browser click and type.", {
            screenshot: image,
            ...(tab === undefined ? {} : { tab }),
          }, unverified("The viewport was captured through Chromium; no desktop Screen Recording permission is required.", "browser-screenshot"))
        }
        case "browser_type": {
          const id = request.target?.elementId
          if (id === undefined && (!Number.isFinite(request.x) || !Number.isFinite(request.y) || request.x! < 0 || request.y! < 0)) {
            return fail("invalid_action", "Typing on a page needs an element id from browser_find or viewport x/y coordinates.")
          }
          if (id === undefined && typedCredential !== undefined) return fail("invalid_action", "Stored credentials require a named page field; they cannot be typed by coordinates.")
          const denied = requireOwnedTab(tab)
          if (denied !== undefined) return denied
          const stale = browserStale(id)
          if (stale !== undefined) return stale
          const text = typedCredential?.value ?? request.text ?? ""
          const typed = await browser.type({
            ...(tab === undefined ? {} : { tabId: tab }),
            ...(id === undefined ? { x: request.x, y: request.y } : { id }),
            text,
            ...readOptions,
          })
          const current = activeTab(tab)
          recordTab(current)
          const verification = id === undefined
            ? unverified("Text input was sent at browser viewport coordinates. Re-read the field or take a browser screenshot to confirm its value.", "browser-type-coordinate")
            : await this.verifyBrowserTypedValue(browser, id, text, tab, sessionId)
          if (typedCredential?.credential !== undefined) {
            this.events.emit("credential.used", {
              computerId,
              ...(sessionId === undefined ? {} : { sessionId }),
              data: { credentialId: typedCredential.credential.id, credentialName: typedCredential.credential.name },
            })
            return {
              httpStatus: 200,
              result: redactResultCredential(
                ok(
                  "Typed the stored credential into the page field.",
                  { ...(current === undefined ? {} : { tab: current }) },
                  verification,
                ).result,
                typedCredential.credential,
              ),
            }
          }
          return ok(
            `Typed into the page field${typed.value === undefined ? "" : `: "${typed.value}"`}.`,
            {
              ...(typed.value === undefined ? {} : { value: typed.value }),
              ...(current === undefined ? {} : { tab: current }),
            },
            verification,
          )
        }
        case "browser_key": {
          const denied = requireOwnedTab(tab)
          if (denied !== undefined) return denied
          const stale = browserStale(undefined)
          if (stale !== undefined) return stale
          const before = await readPage(tab)
          await browser.key(request.key ?? "Enter", tab, sessionId)
          recordTab(activeTab(tab))
          // Real verification: a key press must show its effect in an
          // independent page re-read. FAIL-CLOSED: no change (or an unreadable
          // page) is an explicit unverified, never an implied verified.
          const after = await readPage(tab)
          const beforePage = "page" in before ? before.page : undefined
          const afterPage = "page" in after ? after.page : undefined
          const changed =
            beforePage !== undefined &&
            afterPage !== undefined &&
            (afterPage.hash !== beforePage.hash || !sameBrowserUrl(afterPage.url, beforePage.url))
          const verification = changed
            ? {
                status: "verified" as const,
                message: `The page changed after pressing ${request.key ?? "Enter"}.`,
                method: "browser-key-readback",
                evidence: [
                  {
                    kind: "browser-page-change",
                    value: JSON.stringify({
                      key: request.key ?? "Enter",
                      before: beforePage === undefined ? null : { url: beforePage.url, hash: beforePage.hash },
                      after: afterPage === undefined ? null : { url: afterPage.url, hash: afterPage.hash },
                    }),
                  },
                ],
              }
            : unverified(
                afterPage === undefined
                  ? `The page could not be read back after pressing ${request.key ?? "Enter"} (${"error" in after ? after.error : "unknown"}).`
                  : beforePage === undefined
                    ? `The page could not be read before pressing ${request.key ?? "Enter"}; the effect cannot be compared.`
                    : `The page did not change after pressing ${request.key ?? "Enter"}.`,
                "browser-key-readback",
              )
          return ok(`Pressed ${request.key ?? "Enter"} in the browser.`, { key: request.key ?? "Enter" }, verification)
        }
        case "browser_back":
        case "browser_forward":
        case "browser_reload": {
          const denied = requireOwnedTab(tab)
          if (denied !== undefined) return denied
          // Resolve the tab once so the action and both independent reads
          // address the same page even when the caller omitted `tab`; a
          // re-resolve between reads could attribute another tab's change.
          const beforeTab = tab ?? browser.currentTab?.(sessionId)
          const before = await readPage(beforeTab)
          const resolved = beforeTab ?? activeTab(tab)
          if (action === "browser_back") await browser.back(resolved, sessionId)
          else if (action === "browser_forward") await browser.forward(resolved, sessionId)
          else await browser.reload(resolved, sessionId)
          recordTab(resolved)
          const after = await readPage(resolved)
          const beforePage = "page" in before ? before.page : undefined
          const afterPage = "page" in after ? after.page : undefined
          const documentChanged =
            beforePage?.documentId !== undefined &&
            afterPage?.documentId !== undefined &&
            beforePage.documentId !== afterPage.documentId
          const urlChanged =
            beforePage !== undefined && afterPage !== undefined && !sameBrowserUrl(beforePage.url, afterPage.url)
          const label = action === "browser_back" ? "Went back" : action === "browser_forward" ? "Went forward" : "Reloaded"
          // Reload evidence is a new document generation or an explicit
          // navigation read independently before and after; an identical URL
          // and hash only prove the page was readable both times. History
          // moves use the same independent-change rule. FAIL-CLOSED: missing
          // reads are unverified, never an implied success.
          const verification =
            action === "browser_reload"
              ? documentChanged || urlChanged
                ? {
                    status: "verified" as const,
                    message: documentChanged
                      ? `Reload evidence: the page document changed (${beforePage?.documentId} → ${afterPage?.documentId}) after the reload.`
                      : `Reload evidence: the page navigated to ${afterPage?.url} after the reload.`,
                    method: "browser-reload-readback",
                    evidence: [
                      {
                        kind: "browser-reload",
                        value: JSON.stringify({
                          before: { url: beforePage?.url, documentId: beforePage?.documentId },
                          after: { url: afterPage?.url, documentId: afterPage?.documentId },
                        }),
                      },
                    ],
                  }
                : unverified(
                    beforePage !== undefined && afterPage !== undefined
                      ? `The page was readable before and after at ${afterPage.url}; no reload evidence (the URL and document generation did not change).`
                      : `The page could not be read back before and after the reload (${"error" in after ? after.error : "before read failed"}); reload evidence is missing.`,
                    "browser-reload-readback",
                  )
              : documentChanged || urlChanged
                ? {
                    status: "verified" as const,
                    message: `History navigation changed the page from ${beforePage?.url} to ${afterPage?.url}.`,
                    method: "browser-history-readback",
                    evidence: [
                      {
                        kind: "browser-url",
                        value: JSON.stringify({
                          before: { url: beforePage?.url, documentId: beforePage?.documentId },
                          after: { url: afterPage?.url, documentId: afterPage?.documentId },
                        }),
                      },
                    ],
                  }
                : unverified(
                    beforePage !== undefined && afterPage !== undefined
                      ? "The page did not change after the history navigation."
                      : `The page could not be read back before and after the history navigation (${"error" in after ? after.error : "before read failed"}).`,
                    "browser-history-readback",
                  )
          // Reload is not a navigation; only history moves emit browser.navigated.
          if (action !== "browser_reload") emitNavigated(resolved, afterPage?.url)
          // A failed reload verification must not read as "reloaded"; the
          // action is always requested, but only evidence makes it a fact.
          const message =
            action === "browser_reload" && verification.status !== "verified" ? "Reload requested." : `${label}.`
          return ok(message, resolved === undefined ? {} : { tab: resolved }, verification)
        }
        case "browser_hover": {
          const id = request.target?.elementId
          const denied = requireOwnedTab(tab)
          if (denied !== undefined) return denied
          const stale = browserStale(id)
          if (stale !== undefined) return stale
          if (id === undefined && (typeof request.x !== "number" || typeof request.y !== "number")) {
            return fail("invalid_action", "Hovering needs an element id from browser_find or x/y coordinates.")
          }
          if (browser.hover === undefined) {
            return fail("operation_unavailable", "This browser runtime cannot hover.", false)
          }
          const before = await readPage(tab)
          const beforeValue =
            id === undefined || browser.readValue === undefined
              ? undefined
              : await browser
                  .readValue({ id, ...(tab === undefined ? {} : { tabId: tab }), ...readOptions })
                  .catch(() => undefined)
          const hovered = await browser.hover({
            ...(tab === undefined ? {} : { tabId: tab }),
            ...(id === undefined ? {} : { id }),
            ...(typeof request.x === "number" ? { x: request.x } : {}),
            ...(typeof request.y === "number" ? { y: request.y } : {}),
            ...readOptions,
          })
          const current = activeTab(tab)
          recordTab(current)
          const after = await readPage(tab)
          const afterValue =
            id === undefined || browser.readValue === undefined
              ? undefined
              : await browser
                  .readValue({ id, ...(tab === undefined ? {} : { tabId: tab }), ...readOptions })
                  .catch(() => undefined)
          const beforePage = "page" in before ? before.page : undefined
          const afterPage = "page" in after ? after.page : undefined
          const pageChanged =
            beforePage !== undefined &&
            afterPage !== undefined &&
            (afterPage.hash !== beforePage.hash || !sameBrowserUrl(afterPage.url, beforePage.url))
          const valueChanged =
            beforeValue !== undefined &&
            afterValue !== undefined &&
            beforeValue.value !== undefined &&
            afterValue.value !== undefined &&
            beforeValue.value !== afterValue.value
          const verification: Verification =
            pageChanged || valueChanged
              ? {
                  status: "verified" as const,
                  message: "An independent re-read shows the hover changed the page or the target's value.",
                  method: "browser-hover-readback",
                  evidence: [
                    {
                      kind: "browser-hover",
                      value: JSON.stringify({
                        ...(id === undefined ? {} : { target: id }),
                        before: beforePage === undefined ? null : { url: beforePage.url, hash: beforePage.hash },
                        after: afterPage === undefined ? null : { url: afterPage.url, hash: afterPage.hash },
                      }),
                    },
                  ],
                }
              : unverified(
                  afterPage === undefined
                    ? `The page could not be read back after the hover (${"error" in after ? after.error : "unknown"}).`
                    : "The page did not change and the target's value was unchanged after the hover.",
                  "browser-hover-readback",
                )
          return ok(
            `Hovered ${hovered.role ?? "element"} "${hovered.name ?? id ?? "page"}"${hovered.x === undefined ? "" : ` at pixel ${hovered.x},${hovered.y}`}.`,
            {
              hovered: {
                ...(hovered.name === undefined ? {} : { name: hovered.name }),
                ...(hovered.role === undefined ? {} : { role: hovered.role }),
                ...(id === undefined ? {} : { id }),
                ...(hovered.x === undefined ? {} : { x: hovered.x }),
                ...(hovered.y === undefined ? {} : { y: hovered.y }),
              },
              ...(current === undefined ? {} : { tab: current }),
            },
            verification,
          )
        }
        case "browser_select": {
          const id = request.target?.elementId
          if (id === undefined) return fail("invalid_action", "Selecting an option needs an element id from browser_find.")
          const denied = requireOwnedTab(tab)
          if (denied !== undefined) return denied
          const stale = browserStale(id)
          if (stale !== undefined) return stale
          if (request.value === undefined && request.text === undefined) {
            return fail("invalid_action", "Selecting an option needs value or text.")
          }
          if (browser.select === undefined) {
            return fail("operation_unavailable", "This browser runtime cannot select options.", false)
          }
          const selected = await browser.select(
            { id, ...(tab === undefined ? {} : { tabId: tab }), ...readOptions },
            request.value,
            request.text,
          )
          const current = activeTab(tab)
          recordTab(current)
          const verification = await this.verifyBrowserTypedValue(
            browser,
            id,
            selected.value ?? request.value ?? "",
            tab,
            sessionId,
          )
          return ok(
            `Selected ${selected.value === undefined ? (request.value ?? request.text ?? "option") : `"${selected.value}"`}.`,
            { ...(selected.value === undefined ? {} : { value: selected.value }), ...(current === undefined ? {} : { tab: current }) },
            verification,
          )
        }
        case "browser_drag": {
          const from = request.from
          const to = request.to
          const denied = requireOwnedTab(tab)
          if (denied !== undefined) return denied
          const fromDefined =
            from !== undefined && ((typeof from.elementId === "string" && from.elementId.length > 0) || (typeof from.x === "number" && typeof from.y === "number"))
          const toDefined =
            to !== undefined && ((typeof to.elementId === "string" && to.elementId.length > 0) || (typeof to.x === "number" && typeof to.y === "number"))
          if (!fromDefined || !toDefined) {
            return fail("invalid_action", "Dragging needs from and to endpoints, each an element id or x/y coordinates.")
          }
          const staleFrom = from !== undefined && from.elementId !== undefined ? browserStale(from.elementId) : undefined
          if (staleFrom !== undefined) return staleFrom
          if (browser.drag === undefined) {
            return fail("operation_unavailable", "This browser runtime cannot drag.", false)
          }
          const before = await readPage(tab)
          const dragged = await browser.drag(
            {
              ...(from?.elementId === undefined ? {} : { id: from.elementId }),
              ...(typeof from?.x === "number" ? { x: from.x } : {}),
              ...(typeof from?.y === "number" ? { y: from.y } : {}),
              ...(tab === undefined ? {} : { tabId: tab }),
              ...readOptions,
            },
            {
              ...(to?.elementId === undefined ? {} : { id: to.elementId }),
              ...(typeof to?.x === "number" ? { x: to.x } : {}),
              ...(typeof to?.y === "number" ? { y: to.y } : {}),
              ...(tab === undefined ? {} : { tabId: tab }),
              ...readOptions,
            },
          )
          const current = activeTab(tab)
          recordTab(current)
          const after = await readPage(tab)
          const beforePage = "page" in before ? before.page : undefined
          const afterPage = "page" in after ? after.page : undefined
          const pageChanged =
            beforePage !== undefined &&
            afterPage !== undefined &&
            (afterPage.hash !== beforePage.hash || !sameBrowserUrl(afterPage.url, beforePage.url))
          // A page hash only says that something re-rendered or navigated. It
          // cannot prove that the intended source landed in the intended drop
          // target, so drag stays unverified until the agent reads that specific
          // target back rather than reporting a coincidental page change as done.
          const verification: Verification = unverified(
            afterPage === undefined
              ? `The page could not be read back after the drag (${"error" in after ? after.error : "unknown"}).`
              : pageChanged
                ? "The page changed after the drag, but that does not confirm the intended drop. Read the source and target to verify the result."
                : dragged.method === undefined
                  ? "The browser could not deliver the drag input."
                  : "The drag input was delivered, but the drop effect is not confirmed. Read the source and target to verify the result.",
            "browser-drag-readback",
          )
          return ok(
            `Dragged from ${from?.elementId ?? `${from?.x ?? 0},${from?.y ?? 0}`} to ${to?.elementId ?? `${to?.x ?? 0},${to?.y ?? 0}`}.`,
            {
              dragged: {
                ...(dragged.method === undefined ? {} : { method: dragged.method }),
                ...(dragged.dragged === undefined ? {} : { dragged: dragged.dragged }),
              },
              ...(current === undefined ? {} : { tab: current }),
            },
            verification,
          )
        }
        case "browser_scroll": {
          const denied = requireOwnedTab(tab)
          if (denied !== undefined) return denied
          const deltaX = typeof request.deltaX === "number" ? request.deltaX : 0
          const deltaY = typeof request.deltaY === "number" ? request.deltaY : 0
          if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY) || (deltaX === 0 && deltaY === 0)) {
            return fail(
              "invalid_action",
              "Scrolling needs a non-zero deltaX or deltaY in CSS pixels, for example deltaY 800.",
            )
          }
          if (Math.abs(deltaX) > 20000 || Math.abs(deltaY) > 20000) {
            return fail("invalid_action", "Scroll deltas are capped at 20000 pixels per call; repeat for more.")
          }
          if (browser.scroll === undefined) {
            return fail("operation_unavailable", "This browser runtime cannot scroll.", false)
          }
          const beforeOffset =
            browser.scrollPosition === undefined
              ? undefined
              : await browser
                  .scrollPosition({ ...(tab === undefined ? {} : { tabId: tab }), ...readOptions })
                  .catch(() => undefined)
          const scrolled = await browser.scroll({
            ...(tab === undefined ? {} : { tabId: tab }),
            deltaX: Math.round(deltaX),
            deltaY: Math.round(deltaY),
            ...(typeof request.x === "number" ? { x: request.x } : {}),
            ...(typeof request.y === "number" ? { y: request.y } : {}),
            ...readOptions,
          })
          void scrolled
          const current = activeTab(tab)
          recordTab(current)
          // The offset is read independently before and after: a wheel event
          // that hits the page edge moves nothing, and only the measured
          // offset can tell that apart from a real scroll.
          const afterOffset =
            browser.scrollPosition === undefined || beforeOffset === undefined
              ? undefined
              : await browser
                  .scrollPosition({ ...(tab === undefined ? {} : { tabId: tab }), ...readOptions })
                  .catch(() => undefined)
          const moved =
            beforeOffset !== undefined &&
            afterOffset !== undefined &&
            (beforeOffset.x !== afterOffset.x || beforeOffset.y !== afterOffset.y)
          const verification: Verification = moved
            ? {
                status: "verified" as const,
                message: "An independent scroll-position read shows the page offset moved.",
                method: "browser-scroll-readback",
                evidence: [
                  {
                    kind: "browser-scroll",
                    value: JSON.stringify({ before: beforeOffset, after: afterOffset }),
                  },
                ],
              }
            : unverified(
                beforeOffset === undefined || afterOffset === undefined
                  ? "The scroll position could not be read back after the scroll."
                  : "The scroll offset did not move; the page may already be at its edge in that direction.",
                "browser-scroll-readback",
              )
          return ok(
            `Scrolled the page by ${Math.round(deltaX)},${Math.round(deltaY)} pixels${
              afterOffset === undefined ? "" : ` to offset ${Math.round(afterOffset.x)},${Math.round(afterOffset.y)}`
            }.`,
            {
              scrolled: {
                deltaX: Math.round(deltaX),
                deltaY: Math.round(deltaY),
                ...(beforeOffset === undefined
                  ? {}
                  : { before: { x: beforeOffset.x, y: beforeOffset.y } }),
                ...(afterOffset === undefined ? {} : { after: { x: afterOffset.x, y: afterOffset.y } }),
              },
              ...(current === undefined ? {} : { tab: current }),
            },
            verification,
          )
        }
        default:
          return fail("operation_unavailable", `The browser action ${action} is not supported.`, false)
      }
    } catch (error) {
      // Map typed runtime errors through the browser taxonomy (status + code)
      // instead of flattening every failure into a 500. Messages are only
      // surfaced for known runtime codes; anything else keeps the generic text
      // so raw page content or paths never reach the caller. A paired remote
      // runtime is the user's own machine, so its untyped infrastructure
      // errors (missing bridge, panel failures) stay actionable.
      const failure = browserFailure(error)
      const remote = this.computers.get(computerId)?.driver.browser !== undefined
      const message =
        BROWSER_SAFE_MESSAGES.has(failure.code) || (remote && failure.code === "browser_error")
          ? failure.message.slice(0, 500)
          : "The browser action failed."
      return {
        httpStatus: failure.httpStatus,
        result: {
          success: false,
          status: failure.httpStatus >= 400 && failure.httpStatus < 500 ? "rejected" : "failed",
          message,
          error: { code: failure.code, message, retryable: failure.retryable },
        },
      }
    }
  }

  // Independent re-read after browser_type: the controller-returned value is
  // not evidence that the page holds the text. A second page evaluation finds
  // the field by id and compares its value (find exposes the value as name for
  // non-sensitive fields), so a controller that echoes the request cannot mark
  // the action verified.
  private async verifyBrowserTypedValue(
    browser: BrowserController,
    id: string,
    text: string,
    tab: string | undefined,
    sessionId: string | undefined,
  ): Promise<Verification> {
    const method = "browser-value-readback"
    const expected = text.replace(/\s+/g, " ").trim()
    if (expected.length === 0) {
      return { status: "unverified", message: "No text was requested, so nothing could be read back.", method }
    }
    if (browser.readValue !== undefined) {
      const read = await browser
        .readValue({ id, ...(tab === undefined ? {} : { tabId: tab }), ...(sessionId === undefined ? {} : { sessionId }) })
        .catch(() => undefined)
      if (read === undefined) {
        return { status: "unverified", message: "The field could not be re-read after typing.", method }
      }
      if (read.sensitive === true) {
        return {
          status: "unverified",
          message: "The field is sensitive, so the typed value cannot be read back independently.",
          method,
        }
      }
      const actual = (read.value ?? "").replace(/\s+/g, " ").trim()
      const matched = actual === expected || (expected.length > 120 && actual === expected.slice(0, 120))
      return matched
        ? {
            status: "verified",
            message: "An independent page read confirms the field holds the typed text.",
            method,
            evidence: [{ kind: "browser-value-readback", value: JSON.stringify({ elementId: id, value: actual.slice(0, 120) }) }],
          }
        : {
            status: "unverified",
            message: `The field read back ${JSON.stringify(actual.slice(0, 80))} instead of the typed text.`,
            method,
          }
    }
    const candidates = await browser
      .find(text, {
        ...(tab === undefined ? {} : { tabId: tab }),
        limit: 25,
        ...(sessionId === undefined ? {} : { sessionId }),
      })
      .catch(() => undefined)
    if (candidates === undefined) {
      return { status: "unverified", message: "The field could not be re-read after typing.", method }
    }
    const candidate = candidates.find((entry) => entry.id === id)
    if (candidate === undefined) {
      return {
        status: "unverified",
        message: "The typed field was not found in an independent page read; it may be sensitive or no longer present.",
        method,
      }
    }
    const actual = candidate.name.replace(/\s+/g, " ").trim()
    const matched = actual === expected || (expected.length > 120 && actual === expected.slice(0, 120))
    return matched
      ? {
          status: "verified",
          message: "An independent page read confirms the field holds the typed text.",
          method,
          evidence: [{ kind: "browser-value-readback", value: JSON.stringify({ elementId: id, value: actual.slice(0, 120) }) }],
        }
      : {
          status: "unverified",
          message: `The field read back ${JSON.stringify(actual.slice(0, 80))} instead of the typed text.`,
          method,
        }
  }

  // Independent re-read of the file input after browser_upload: the runtime
  // echoing the request proves nothing, so the attached file name must show
  // up in a second read of the input value or a find of the file name.
  private async verifyBrowserUpload(
    browser: BrowserController,
    files: readonly string[],
    tab: string | undefined,
    sessionId: string | undefined,
    elementId: string | undefined,
  ): Promise<Verification> {
    const method = "browser-upload-readback"
    if (elementId !== undefined && browser.readValue !== undefined) {
      const read = await browser
        .readValue({ id: elementId, ...(tab === undefined ? {} : { tabId: tab }), ...(sessionId === undefined ? {} : { sessionId }) })
        .catch(() => undefined)
      if (read === undefined) {
        return { status: "unverified", message: "The file input could not be re-read after the upload.", method }
      }
      if (read.sensitive === true) {
        return {
          status: "unverified",
          message: "The file input value is sensitive, so the attached files cannot be read back.",
          method,
        }
      }
      const actual = read.value ?? ""
      const matched = files.some((file) => actual.includes(file) || actual.includes(basename(file)))
      return matched
        ? {
            status: "verified",
            message: "An independent page read confirms the file input reports the attached file(s).",
            method,
            evidence: [{ kind: "browser-upload-readback", value: JSON.stringify({ elementId, value: actual.slice(0, 120) }) }],
          }
        : {
            status: "unverified",
            message: `The file input read back ${JSON.stringify(actual.slice(0, 80))} instead of the attached file(s).`,
            method,
          }
    }
    const query = files[0] === undefined ? "" : basename(files[0])
    if (query.length === 0) {
      return { status: "unverified", message: "No file name could be derived for the read-back.", method }
    }
    const candidates = await browser
      .find(query, {
        ...(tab === undefined ? {} : { tabId: tab }),
        limit: 10,
        ...(sessionId === undefined ? {} : { sessionId }),
      })
      .catch(() => undefined)
    if (candidates === undefined) {
      return { status: "unverified", message: "The file input could not be read back after the upload.", method }
    }
    const matched = candidates.find((candidate) => candidate.name.includes(query))
    return matched === undefined
      ? { status: "unverified", message: `The file input did not report ${JSON.stringify(query)} on an independent read.`, method }
      : {
          status: "verified",
          message: "An independent page read confirms the file input reports the attached file(s).",
          method,
          evidence: [{ kind: "browser-upload-readback", value: JSON.stringify({ query, name: matched.name }) }],
        }
  }

  private async executeMenu(
    computer: ManagedComputer,
    request: ServerActionRequest,
    shouldStop: () => boolean,
  ): Promise<{ httpStatus: number; result: ActionResult }> {
    const path = (request.query ?? request.text ?? "").split(">").map((part) => part.trim()).filter((part) => part.length > 0)
    if (path.length === 0) {
      return {
        httpStatus: 400,
        result: {
          success: false,
          status: "rejected",
          message: "A menu action needs a path such as 'Sheet > Rename Sheet'.",
          error: { code: "invalid_action", message: "A menu action needs a path such as 'Sheet > Rename Sheet'.", retryable: true },
        },
      }
    }
    const clicked: string[] = []
    const items: Array<{ label: string; verification: Verification }> = []
    for (const label of path) {
      if (shouldStop()) return this.cancelledOutcome(computer, request)
      const find = await computer.driver.find({ query: label, limit: 5 })
      const match = (find.matches ?? find.results ?? [])[0]
      if (match?.element?.id === undefined) {
        const message = `Menu item "${label}" was not found. Open the menu first and check the label.`
        return {
          httpStatus: 404,
          result: {
            success: false,
            status: "unavailable",
            message,
            error: { code: "menu_item_not_found", message, retryable: true, details: { path, reached: clicked } },
          },
        }
      }
      if (shouldStop()) return this.cancelledOutcome(computer, request)
      const beforeItem = computer.lastObservation
      const outcome = await computer.driver.execute({
        type: "click",
        target: { kind: "element", elementId: match.element.id },
      })
      if (!outcome.success) return { httpStatus: 500, result: outcome }
      const afterItem = outcome.observation ?? (await computer.driver.observe().catch(() => undefined))
      if (afterItem !== undefined) this.storeObservation(computer, afterItem)
      // Each menu click must show its own state change: one final observe kept
      // a dead click looking successful whenever any later step changed state.
      const itemVerification = verifyOutcome(outcome, computeStateDelta(beforeItem, afterItem), "menu")
      if (itemVerification.status !== "verified") {
        const message = `Menu item "${label}" was clicked but its effect could not be verified: ${itemVerification.message}`
        return {
          httpStatus: 409,
          result: {
            success: false,
            status: "failed",
            message,
            verification: itemVerification,
            error: { code: "menu_item_unverified", message, retryable: true, details: { path, reached: clicked, item: label } },
          },
        }
      }
      items.push({ label, verification: itemVerification })
      clicked.push(label)
      await new Promise((resolve) => setTimeout(resolve, 350))
    }
    const observation = await computer.driver.observe().catch(() => undefined)
    if (observation !== undefined) this.storeObservation(computer, observation)
    return {
      httpStatus: 200,
      result: {
        success: true,
        status: "success",
        message: `Selected menu path ${clicked.join(" > ")}.`,
        verification: {
          status: "verified",
          message: `Each of ${items.length} menu item(s) showed a state change.`,
          method: "menu-item-diff",
          evidence: [
            {
              kind: "menu-items",
              value: JSON.stringify(items.map((item) => ({ label: item.label, status: item.verification.status }))).slice(0, 2000),
            },
          ],
        },
        metadata: { path: clicked },
        ...(observation === undefined ? {} : { observation }),
      },
    }
  }

  private requireComputer(id: string): ManagedComputer {
    const computer = this.computers.get(id)
    if (!computer) throw new Error(`Unknown computer ${id}.`)
    return computer
  }

  private async resolveQuery(
    computer: ManagedComputer,
    request: ServerActionRequest,
  ): Promise<
    | { request: ServerActionRequest; resolution?: { resolvedBy: string; confidence?: number } }
    | { status: number; error: ActionResult }
  > {
    if (request.target !== undefined) return { request }
    const query = request.query?.trim()
    if (query === undefined || query.length === 0) return { request }
    const found = await computer.driver
      .find({ query, ...(request.role === undefined ? {} : { role: request.role }), limit: 5 })
      .catch(() => undefined)
    const all = found?.matches ?? found?.results ?? []
    const unusable = (element: UIElement): boolean =>
      (element.states ?? []).some((state) => state === "disabled" || state === "hidden" || state === "offscreen")
    const usable = all.some((match) => !unusable(match.element)) ? all.filter((match) => !unusable(match.element)) : all
    const matches = preferHierarchy(usable, found?.observation)
    if (matches.length === 0) {
      return {
        status: 404,
        error: {
          success: false,
          status: "unavailable",
          message: `No control matched "${query}".`,
          error: {
            code: "target_not_found",
            message: `No control matched "${query}". Observe the application again; its interface may have changed.`,
            retryable: true,
          },
        },
      }
    }
    const best = matches[0]!
    const challenger = matches[1]
    const ambiguous =
      challenger !== undefined &&
      challenger.element.id !== best.element.id &&
      best.score - challenger.score < AMBIGUITY_GAP
    if (ambiguous) {
      const candidates = matches.slice(0, 3).map((match) => ({
        ...(match.element.id === undefined ? {} : { id: match.element.id }),
        ...(match.element.role === undefined ? {} : { role: match.element.role }),
        ...(match.element.name ?? match.element.text) === undefined
          ? {}
          : { name: match.element.name ?? match.element.text },
        score: match.score,
      }))
      const summary = candidates
        .map((candidate) => `${candidate.role ?? "element"} "${candidate.name ?? candidate.id ?? "?"}" (id=${candidate.id ?? "?"})`)
        .join(", ")
      return {
        status: 409,
        error: {
          success: false,
          status: "rejected",
          message: `"${query}" matched more than one control.`,
          error: {
            code: "target_ambiguous",
            message: `"${query}" is ambiguous: ${summary}. Pass the target element id or narrow with role or app.`,
            retryable: true,
            details: { candidates },
          },
        },
      }
    }
    const elementId = best.element.id
    if (elementId === undefined) {
      return {
        status: 404,
        error: {
          success: false,
          status: "unavailable",
          message: `The best match for "${query}" has no stable identifier.`,
          error: { code: "target_not_found", message: "The best match has no stable identifier.", retryable: true },
        },
      }
    }
    return {
      request: {
        ...request,
        target: {
          kind: "element",
          elementId,
          ...(best.element.role === undefined ? {} : { role: best.element.role }),
        },
      },
      resolution: { resolvedBy: "semantic-query", confidence: best.score },
    }
  }

  private async resolveWindowFocus(
    computer: ManagedComputer,
    request: ServerActionRequest,
  ): Promise<{ request: ServerActionRequest } | { status: number; error: ActionResult }> {
    const globalInput = ["type", "key", "hotkey", "press_keys", "paste", "copy", "scroll"]
    const wantsWindow =
      request.action === "focus_window" ||
      (request.window !== undefined && request.target === undefined && globalInput.includes(request.action))
    if (!wantsWindow) return { request }

    const fragment = (request.window ?? request.query ?? "").trim().toLowerCase()
    const observation = await computer.driver.observe().catch(() => undefined)
    const windows = (observation?.elements ?? []).filter(
      (element) => element.role === "window" && element.id !== undefined,
    )
    const scored =
      fragment.length === 0
        ? []
        : windows
            .map((window) => ({ window, score: windowMatchScore(window, fragment) }))
            .filter((entry) => entry.score > 0)
            .sort((a, b) => b.score - a.score)
    const matching = scored.map((entry) => entry.window)
    // A stale ref still carries the window's app/title slug; use it as a
    // fallback so focus_window never dead-ends on an invalidated id.
    const slugFromRef = (() => {
      const ref = request.target?.elementId
      if (request.action !== "focus_window" || ref === undefined || !ref.startsWith("cua:window/")) return undefined
      const segment = ref.split("/")[2]
      return segment === undefined || segment.length < 3 ? undefined : segment
    })()
    const slugify = (value: string) =>
      value
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 32)
    // Ranked fallback only: an exact slug beats the word-boundary matcher and
    // loose substring hits (score < 50) never resolve. Ambiguous ties resolve
    // to undefined so a stale ref cannot focus the wrong window.
    const bySlug = (() => {
      if (slugFromRef === undefined) return undefined
      const ranked = windows
        .flatMap((window) => {
          const slug = slugify(String(window.name ?? ""))
          const exact = slug === slugFromRef
          const score = windowMatchScore(window, slugFromRef)
          if (!exact && score < 50) return []
          return [{ window, rank: exact ? 200 : score }]
        })
        .sort((a, b) => b.rank - a.rank)
      const best = ranked[0]
      if (best === undefined || ranked[1]?.rank === best.rank) return undefined
      return best.window
    })()
    const topScore = scored[0]?.score ?? 0
    const ties = scored.filter((entry) => entry.score === topScore).map((entry) => entry.window)
    const focusedTie = ties.find((window) => (window.states ?? []).includes("focused"))
    const ambiguous = topScore > 0 && ties.length > 1 && focusedTie === undefined
    const target =
      (ambiguous ? undefined : focusedTie ?? ties[0] ?? matching[0]) ?? bySlug
    if (ambiguous && bySlug === undefined) {
      return {
        status: 409,
        error: {
          success: false,
          status: "unavailable",
          message: `Several windows match "${request.window ?? request.query ?? ""}": ${ties
            .map((window) => window.name)
            .slice(0, 5)
            .join(", ")}. Name the window more precisely.`,
          error: {
            code: "window_ambiguous",
            message: "Several windows match; name the window more precisely.",
            retryable: true,
            details: {
              candidates: ties
                .flatMap((window) => (window.id === undefined ? [] : [{ id: window.id, name: window.name ?? "" }]))
                .slice(0, 10),
            },
          },
        },
      }
    }

    if (request.action === "focus_window") {
      if (target?.id === undefined) {
        const available = windows.map((window) => window.name).filter((name): name is string => typeof name === "string")
        return {
          status: 404,
          error: {
            success: false,
            status: "unavailable",
            message: `No open window matches "${request.window ?? request.query ?? ""}".`,
            error: {
              code: "window_not_found",
              message: `No open window matches "${request.window ?? request.query ?? ""}".`,
              retryable: true,
              details: { windows: available.slice(0, 10) },
            },
          },
        }
      }
      return {
        request: {
          ...request,
          action: "focus",
          windowResolved: true,
          target: { kind: "element", elementId: target.id },
        },
      }
    }

    if (target?.id !== undefined && !(target.states ?? []).includes("focused")) {
      const focused = await this.executeInternal(computer.id, {
        action: "focus",
        target: { kind: "element", elementId: target.id },
        ...(request.approve === undefined ? {} : { approve: request.approve }),
        ...(request.approvedBy === undefined ? {} : { approvedBy: request.approvedBy }),
        ...(request.approvedScopes === undefined ? {} : { approvedScopes: request.approvedScopes }),
        ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
      })
      if (!focused.result.success) return { status: focused.httpStatus, error: focused.result }
    }
    return { request }
  }

  async executeBatch(id: string, batch: ServerBatchRequest): Promise<{ httpStatus: number; result: BatchResult }> {
    if (batch.steps.length === 0) {
      return {
        httpStatus: 400,
        result: { success: false, verified: false, completed: 0, total: 0, steps: [], message: "The batch contains no steps." },
      }
    }
    const stopOnError = batch.stopOnError !== false
    const stopSeq = this.computers.get(id)?.stopSeq ?? 0
    const resumeFrom = Math.max(0, Math.floor(batch.resumeFrom ?? 0))
    const steps: BatchStepResult[] = []
    for (let index = resumeFrom; index < batch.steps.length; index += 1) {
      const current = this.computers.get(id)
      if (batch.shouldStop?.() === true || current === undefined || current.stopSeq !== stopSeq) {
        const reason = batch.shouldStop?.() === true ? "the client disconnected" : "computer control was stopped"
        return {
          httpStatus: 200,
          result: {
            success: false,
            verified: steps.length > 0 && steps.every((entry) => entry.verified),
            completed: steps.length,
            total: batch.steps.length,
            steps,
            message: `Stopped after ${steps.length} step(s) because ${reason}.`,
          },
        }
      }
      const step = batch.steps[index]!
      const outcome = await this.execute(id, {
        ...step,
        approve: step.approve ?? batch.approve,
        ...(step.approvedBy ?? batch.approvedBy) === undefined
          ? {}
          : { approvedBy: step.approvedBy ?? batch.approvedBy },
        ...(step.approvedScopes ?? batch.approvedScopes) === undefined
          ? {}
          : { approvedScopes: step.approvedScopes ?? batch.approvedScopes },
        ...(step.approvalFingerprint ?? batch.approvalFingerprint) === undefined
          ? {}
          : { approvalFingerprint: step.approvalFingerprint ?? batch.approvalFingerprint },
        ...(step.origin ?? batch.origin) === undefined ? {} : { origin: step.origin ?? batch.origin },
        sessionId: step.sessionId ?? batch.sessionId,
        // Threads client-disconnect cancellation into the in-flight driver call
        // instead of only checking between steps.
        ...(batch.shouldStop === undefined ? {} : { shouldStop: batch.shouldStop }),
      })
      const result = outcome.result
      const metadata = (result.metadata ?? {}) as Record<string, unknown>
      // Fail-closed plans contract: verified is true only when the step's own
      // verification is "verified" (or the step is read-only and succeeded, or
      // its expect: met). Agents must treat verified===false as failed unless
      // the step set allowUnverified:true. Default false.
      const allowUnverified = step.allowUnverified === true
      const readOnly = BATCH_READ_ONLY_ACTIONS.has(step.action)
      // FAIL-CLOSED: "the action returned no verification" is not evidence, so
      // it is reported as an explicit unverified with its reason instead of
      // being read as the action's own success. Only an explicit
      // verification.status === "verified" from an independent read counts;
      // hover/mouse_down/mouse_up/release_keys and the legacy driver fallbacks
      // never return one, so they can no longer ride on success alone.
      const verification: Verification | undefined =
        result.verification ??
        (result.success
          ? {
              status: "unverified",
              method: "no-readback",
              message: `${step.action} reported success without an independent readback, so its effect is not verified.`,
            }
          : undefined)
      let verified = readOnly ? result.success : verification?.status === "verified"
      let stepResult: BatchStepResult = {
        index,
        action: step.action,
        success: result.success,
        verified,
        ...(step.allowUnverified === undefined ? {} : { allowUnverified: step.allowUnverified }),
        ...(result.message === undefined ? {} : { message: result.message }),
        ...(typeof metadata.resolvedBy === "string" ? { resolvedBy: metadata.resolvedBy } : {}),
        ...(typeof metadata.confidence === "number" ? { confidence: metadata.confidence } : {}),
        ...(verification === undefined ? {} : { verification }),
        ...(metadata.stateDelta === undefined ? {} : { stateDelta: metadata.stateDelta as StateDelta }),
        ...(result.error === undefined ? {} : { error: result.error }),
      }
      if (stepResult.success && step.expect !== undefined) {
        const expectation = await this.checkExpectation(
          id,
          step.expect,
          {
            ...(step.sessionId ?? batch.sessionId) === undefined ? {} : { sessionId: step.sessionId ?? batch.sessionId },
            ...(step.approve ?? batch.approve) === true ? { approve: true } : {},
            ...(step.approvedBy ?? batch.approvedBy) === undefined ? {} : { approvedBy: step.approvedBy ?? batch.approvedBy },
            ...(step.approvedScopes ?? batch.approvedScopes) === undefined
              ? {}
              : { approvedScopes: step.approvedScopes ?? batch.approvedScopes },
            ...(step.approvalFingerprint ?? batch.approvalFingerprint) === undefined
              ? {}
              : { approvalFingerprint: step.approvalFingerprint ?? batch.approvalFingerprint },
          },
          { result, ...(stepResult.stateDelta === undefined ? {} : { stateDelta: stepResult.stateDelta }) },
        )
        if (!expectation.met) {
          stepResult = {
            ...stepResult,
            success: false,
            verified: false,
            message: expectation.message,
            error: {
              code: "expectation_unmet",
              message: expectation.message,
              retryable: true,
            },
          }
        } else {
          // An explicitly met expectation is independent evidence for the step.
          stepResult = { ...stepResult, verified: true }
          verified = true
        }
      }
      // Unverified-for-agents is failed unless explicitly allowed. Read-only
      // steps already report verified on success, so only mutating unverified
      // steps reach here.
      if (stepResult.success && !stepResult.verified && !allowUnverified) {
        const message =
          verification?.message !== undefined
            ? `Step ${index + 1} (${step.action}) was not verified: ${verification.message}`
            : `Step ${index + 1} (${step.action}) was not verified; re-observe and retry with a corrected step.`
        stepResult = {
          ...stepResult,
          success: false,
          message,
          error: { code: "unverified", message, retryable: true },
        }
      }
      steps.push(stepResult)
      // An in-flight step cancelled by stop/disconnect ends the batch as
      // cancelled, not as a step failure.
      if (
        !stepResult.success &&
        typeof stepResult.error === "object" &&
        stepResult.error !== null &&
        stepResult.error.code === "action_cancelled"
      ) {
        return {
          httpStatus: 200,
          result: {
            success: false,
            verified: false,
            completed: steps.filter((step) => step.success).length,
            total: batch.steps.length,
            failedAt: index,
            steps,
            message: `Stopped at step ${index + 1} (${step.action}) because computer control was stopped.`,
          },
        }
      }
      if (!stepResult.success && stopOnError) {
        return {
          httpStatus: 200,
          result: {
            success: false,
            verified: false,
            completed: steps.length - 1,
            total: batch.steps.length,
            failedAt: index,
            steps,
            message: `Step ${index + 1} (${step.action}) failed: ${stepResult.message ?? "unknown failure"}`,
          },
        }
      }
    }
    const allVerified = steps.length > 0 && steps.every((entry) => entry.verified)
    return {
      httpStatus: 200,
      result: {
        success: steps.every((step) => step.success),
        verified: allVerified,
        completed: steps.filter((step) => step.success).length,
        total: steps.length,
        steps,
        message: `Completed ${steps.filter((step) => step.success).length} of ${steps.length} step(s).`,
      },
    }
  }

  private async checkExpectation(
    id: string,
    expect: StepExpectation,
    approval: {
      readonly sessionId?: string
      readonly approve?: boolean
      readonly approvedBy?: string
      readonly approvedScopes?: readonly OmniaScope[]
      readonly approvalFingerprint?: string
    },
    output?: { readonly result: ActionResult; readonly stateDelta?: StateDelta },
  ): Promise<{ met: boolean; message: string }> {
    const computer = this.requireComputer(id)
    if (expect.file !== undefined) {
      // The file lives on the server host, so a remote computer cannot
      // verify it locally; checking the wrong machine would report a false
      // result.
      if (computer.driver.backend === "remote") {
        return { met: false, message: "expect.file is only supported for local computers; use a window or text expectation." }
      }
      const operation: OperationInput = { action: "expect.file", resources: [expect.file] }
      const decision = this.permissions.evaluate(["FILES_READ"], {
        ...(approval.sessionId === undefined ? {} : { sessionId: approval.sessionId }),
        approval: {
          approved: approval.approve === true,
          ...(approval.approvedBy === undefined ? {} : { approvedBy: approval.approvedBy }),
          ...(approval.approvedScopes === undefined ? {} : { scopes: approval.approvedScopes }),
          ...(approval.approvalFingerprint === undefined ? {} : { fingerprint: approval.approvalFingerprint }),
        },
        operation,
      })
      if (!decision.allowed) {
        return { met: false, message: "Verifying an expected file needs FILES_READ approval." }
      }
      const exists = await access(expect.file).then(
        () => true,
        () => false,
      )
      return exists
        ? { met: true, message: `Verified the file ${expect.file} exists.` }
        : { met: false, message: `Expected file ${expect.file} does not exist.` }
    }
    const observation = await computer.driver.observe().catch(() => undefined)
    const elements = observation?.elements ?? []
    if (expect.window !== undefined) {
      const needle = expect.window.toLowerCase()
      const found = elements.some(
        (element) => element.role === "window" && String(element.name ?? "").toLowerCase().includes(needle),
      )
      return found
        ? { met: true, message: `Verified a window matching "${expect.window}" is open.` }
        : { met: false, message: `No open window matches "${expect.window}".` }
    }
    if (expect.text !== undefined) {
      const needle = expect.text.toLowerCase()
      const inInterface = elements.some((element) =>
        [element.name, element.text, element.value, element.description]
          .filter((value): value is string => typeof value === "string")
          .some((value) => value.toLowerCase().includes(needle)),
      )
      // The action's own output is observable evidence too: get_cursor reports
      // pointer coordinates, read_text/read_clipboard return the payload, and
      // several actions attach verification or a state-delta summary.
      const resultText =
        output !== undefined && "text" in output.result && typeof output.result.text === "string"
          ? output.result.text
          : undefined
      const inOutput = [
        output?.result.message,
        resultText,
        output?.result.verification?.message,
        output?.stateDelta?.summary,
      ].some((value) => typeof value === "string" && value.toLowerCase().includes(needle))
      return inInterface || inOutput
        ? { met: true, message: `Verified "${expect.text}" is present.` }
        : { met: false, message: `Expected text "${expect.text}" was not found in the interface or the step output.` }
    }
    // FAIL-CLOSED: an expectation this helper does not implement, or an empty
    // one, is not evidence of anything. Reporting met:true here is what let a
    // plan carry a step as verified without a single independent read, so an
    // unimplemented or empty expectation stays explicitly not verified.
    const unimplemented = Object.keys(expect).filter(
      (key) => key !== "file" && key !== "window" && key !== "text",
    )
    return {
      met: false,
      message:
        unimplemented.length === 0
          ? "The step declared no expectation, so there is nothing that could be verified."
          : `This expectation (${unimplemented.join(", ")}) cannot be verified for this computer, so the step stays unverified.`,
    }
  }

  private async settle(computer: ManagedComputer): Promise<Observation | undefined> {
    await new Promise((resolve) => setTimeout(resolve, SETTLE_DELAY_MS))
    return computer.driver.observe().then(
      (observation) => observation,
      () => computer.lastObservation,
    )
  }

  private async resolveApplicationAction(
    computer: ManagedComputer,
    request: ServerActionRequest,
  ): Promise<{ request: ServerActionRequest } | { status: number; error: ActionResult }> {
    if (request.action !== "activate_app" && request.action !== "close_app") return { request }
    const app = (request.app ?? request.text ?? "").trim().toLowerCase()
    if (app.length === 0) {
      return {
        status: 400,
        error: { success: false, status: "rejected", message: `The ${request.action} action requires an app.` },
      }
    }
    const observation = await computer.driver.observe().catch(() => undefined)
    const windows = (observation?.elements ?? []).filter((element) => element.role === "window")
    const scored = windows
      .map((window) => ({ window, score: windowMatchScore(window, app) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
    const topScore = scored[0]?.score ?? 0
    const ties = scored.filter((entry) => entry.score === topScore).map((entry) => entry.window)
    const focusedTie = ties.find((window) => (window.states ?? []).includes("focused"))
    const window = focusedTie ?? ties[0]
    if (!window?.id) {
      const available = (observation?.elements ?? [])
        .filter((element) => element.role === "window")
        .map((element) => element.name)
        .filter((name): name is string => typeof name === "string")
      return {
        status: 404,
        error: {
          success: false,
          status: "unavailable",
          message: `No open window belongs to ${request.app ?? request.text ?? app}.`,
          error: {
            code: "application_not_found",
            message: `No open window belongs to ${app}.`,
            retryable: true,
            details: { windows: available.slice(0, 10) },
          },
        },
      }
    }
    return {
      request: {
        ...request,
        action: request.action === "activate_app" ? "focus" : "close",
        windowResolved: true,
        target: { kind: "element", elementId: window.id },
      },
    }
  }
}

function toComputerAction(request: ServerActionRequest): ComputerAction | undefined {
  const target = request.target
  switch (request.action) {
    case "observe":
    case "find":
    case "read":
      return { type: "observe" }
    case "screenshot":
      return { type: "screenshot", ...(request.region === undefined ? {} : { region: request.region }) }
    case "launch":
    case "launch_app": {
      const applicationId = request.app ?? request.text ?? ""
      return applicationId.length > 0 ? { type: "launch", applicationId } : undefined
    }
    case "open":
    case "open_url":
    case "open_file": {
      const value = request.url ?? request.path ?? request.text ?? ""
      return value.length > 0 ? { type: "open", target: value } : undefined
    }
    case "click":
      return pointOrElement(request)
        ? { type: "click", target: pointOrElement(request)!, ...durationMetadata(request) }
        : undefined
    case "middle_click":
      return pointOrElement(request)
        ? { type: "click", target: pointOrElement(request)!, button: "middle", ...durationMetadata(request) }
        : undefined
    case "menu":
      return undefined
    case "double_click":
    case "doubleclick":
      return pointOrElement(request)
        ? { type: "doubleclick", target: pointOrElement(request)!, ...durationMetadata(request) }
        : undefined
    case "right_click":
    case "rightclick":
      return pointOrElement(request)
        ? { type: "rightclick", target: pointOrElement(request)!, ...durationMetadata(request) }
        : undefined
    case "focus":
      return target ? { type: "focus", target: elementTarget(target) } : undefined
    case "type": {
      if (typeof request.text !== "string") return undefined
      if (target) return { type: "type", target: elementTarget(target), text: request.text }
      const point = pointOrElement(request)
      if (point) return { type: "type", target: point, text: request.text }
      return { type: "type", text: request.text }
    }
    case "set_value":
    case "setvalue":
      return target && typeof request.text === "string"
        ? { type: "setvalue", target: elementTarget(target), value: request.text }
        : undefined
    case "key":
      return typeof request.key === "string" ? { type: "key", key: request.key } : undefined
    case "hotkey":
    case "press_keys": {
      const combo = request.keys !== undefined && request.keys.length > 0 ? request.keys.join("+") : request.key
      return combo !== undefined && combo.length > 0 ? { type: "key", key: combo } : undefined
    }
    case "scroll": {
      const direction =
        request.direction === "up" || request.direction === "down" || request.direction === "left" || request.direction === "right"
          ? request.direction
          : "down"
      const point = pointOrElement(request)
      return {
        type: "scroll",
        direction,
        amount: typeof request.amount === "number" ? request.amount : 3,
        ...(target ? { target: elementTarget(target) } : point ? { target: point } : {}),
        ...durationMetadata(request),
      }
    }
    case "move":
      return pointOrElement(request)
        ? { type: "move", target: pointOrElement(request)!, ...durationMetadata(request) }
        : undefined
    case "drag": {
      const from = dragTarget(request.from)
      const to = dragTarget(request.to)
      return from !== undefined && to !== undefined ? { type: "drag", from, to, ...durationMetadata(request) } : undefined
    }
    case "copy":
      return { type: "copy", ...(target ? { target: elementTarget(target) } : {}) }
    case "paste":
      return {
        type: "paste",
        text: request.text ?? "",
        ...(target ? { target: elementTarget(target) } : {}),
      }
    case "toggle":
      return target ? { type: "toggle", target: elementTarget(target) } : undefined
    case "select":
      return target
        ? {
            type: "select",
            target: elementTarget(target),
            ...(typeof request.text === "string" ? { value: request.text } : {}),
          }
        : undefined
    case "expand":
      return target ? { type: "expand", target: elementTarget(target) } : undefined
    case "collapse":
      return target ? { type: "collapse", target: elementTarget(target) } : undefined
    case "increment":
      return target
        ? {
            type: "increment",
            target: elementTarget(target),
            ...(typeof request.amount === "number" ? { amount: request.amount } : {}),
          }
        : undefined
    case "decrement":
      return target
        ? {
            type: "decrement",
            target: elementTarget(target),
            ...(typeof request.amount === "number" ? { amount: request.amount } : {}),
          }
        : undefined
    case "scroll_into_view":
      return target ? { type: "scroll_into_view", target: elementTarget(target) } : undefined
    case "wait":
      return { type: "wait", ms: typeof request.amount === "number" ? request.amount : 800 }
    case "dismiss":
      return { type: "dismiss" }
    case "close":
      return target ? { type: "close", target: elementTarget(target) } : undefined
    default:
      return undefined
  }
}

function ancestorRoles(element: UIElement, byId: Map<string, UIElement>): string[] {
  const roles: string[] = []
  let parentId = element.parentId
  let guard = 0
  while (parentId !== undefined && guard < 24) {
    const parent = byId.get(parentId)
    if (parent === undefined) break
    if (parent.role !== undefined) roles.push(parent.role)
    parentId = parent.parentId
    guard += 1
  }
  return roles
}

// Menu dependencies expose several controls with the same name (menu bar
// entry, context menu, toolbar button). Prefer the one reached through the
// canonical hierarchy so opening "Insert" selects the menu bar entry instead
// of failing on a tie.
function preferHierarchy<T extends { element: UIElement }>(matches: readonly T[], observation: Observation | undefined): T[] {
  if (matches.length < 2) return [...matches]
  const byId = new Map((observation?.elements ?? []).flatMap((element) => (element.id === undefined ? [] : [[element.id, element] as const])))
  const ranked = matches.map((match) => {
    const roles = ancestorRoles(match.element, byId)
    const rank = roles.includes("menubar") ? 3 : roles.includes("menu") ? 2 : 1
    return { match, rank }
  })
  const best = Math.max(...ranked.map((entry) => entry.rank))
  if (best <= 1) return [...matches]
  const preferred = ranked.filter((entry) => entry.rank === best).map((entry) => entry.match)
  return preferred.length > 0 ? preferred : [...matches]
}

function dragTarget(endpoint: DragEndpoint | undefined): ComputerTarget | undefined {
  if (endpoint === undefined) return undefined
  if (typeof endpoint.elementId === "string" && endpoint.elementId.length > 0) {
    return { kind: "element", elementId: endpoint.elementId }
  }
  if (typeof endpoint.x === "number" && typeof endpoint.y === "number") {
    return { kind: "point", x: endpoint.x, y: endpoint.y }
  }
  return undefined
}

function pointOrElement(request: ServerActionRequest): ComputerTarget | undefined {
  if (typeof request.x === "number" && typeof request.y === "number") {
    return { kind: "point", x: request.x, y: request.y }
  }
  return request.target === undefined ? undefined : elementTarget(request.target)
}

function durationMetadata(request: ServerActionRequest): { metadata?: { durationMs: number } } {
  return typeof request.amount === "number" ? { metadata: { durationMs: request.amount } } : {}
}

function buttonNumber(button: string | undefined): number | undefined {
  if (button === undefined || button === "left") return 1
  if (button === "middle") return 2
  if (button === "right") return 3
  return undefined
}

function observationIncomplete(observation: Observation | undefined): boolean {
  const metadata = observation?.metadata as Record<string, unknown> | undefined
  return metadata?.["truncated"] === true || metadata?.["complete"] === false
}

// ActionResult metadata is a JSON object; a calibration profile is plain data
// but its interface has no index signature, so it is copied explicitly.
function calibrationProfileJson(profile: CalibrationProfile): JsonObject {
  return {
    screen: { width: profile.screen.width, height: profile.screen.height },
    scaleX: profile.scaleX,
    scaleY: profile.scaleY,
    offsetX: profile.offsetX,
    offsetY: profile.offsetY,
    samples: profile.samples,
    measuredAt: profile.measuredAt,
  }
}

// Runtime failure codes whose messages are produced by the browser runtime
// itself; unknown codes keep the generic text so page content or host paths
// never reach the caller.
const BROWSER_SAFE_MESSAGES = new Set([
  "invalid_action",
  "invalid_params",
  "invalid_key",
  "invalid_target",
  "marker_not_found",
  "url_blocked",
  "path_blocked",
  "element_not_found",
  "image_not_found",
  "image_ambiguous",
  "image_verify_failed",
  "tab_limit",
  "tab_not_found",
  "dialog_open",
  "dialog_not_open",
  "dialog_mismatch",
  "download_failed",
  "no_auth_challenge",
  "auth_host_mismatch",
  "auth_required",
  "file_chooser_open",
  "no_file_chooser",
  "upload_failed",
  "no_history",
  "not_running",
  "not_connected",
  "not_available",
  "connection_closed",
  "connection_failed",
  "target_closed",
  "open_failed",
  "timeout",
  "load_timeout",
  "launch_timeout",
  "launch_failed",
  "open_timeout",
  "download_timeout",
])

// Login form discovery, in the order a person would read a sign-in page. The
// password field is matched first and never guessed: if it cannot be
// identified, the action fails closed instead of typing a secret somewhere.
const LOGIN_PASSWORD_QUERIES = ["password", "passwd", "pass code", "current password"] as const
const LOGIN_USERNAME_QUERIES = ["email", "username", "user name", "userid", "login id", "account"] as const
const LOGIN_SUBMIT_QUERIES = ["sign in", "log in", "login", "continue", "submit", "next"] as const

async function resolveLoginField(
browser: BrowserController,
input: {
  readonly spec?: string
  readonly queries: readonly string[]
  readonly role: string
  readonly exclude: ReadonlySet<string>
  readonly tab?: string
  readonly sessionId?: string
},
): Promise<BrowserElementSummary | undefined> {
const spec = input.spec?.trim()
// Page element ids are assigned by the runtime (omnia-<seq>). Anything else
// is treated as a query so the model can pass either form.
if (spec !== undefined && spec.length > 0) {
  if (/^omnia-\d+$/.test(spec)) {
    return input.exclude.has(spec) ? undefined : { id: spec, role: input.role, name: spec }
  }
  const found = await browser
    .find(spec, {
      ...(input.tab === undefined ? {} : { tabId: input.tab }),
      role: input.role,
      limit: 5,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    })
    .catch(() => [] as BrowserElementSummary[])
  return bestLoginField(found, input.exclude)
}
for (const query of input.queries) {
  const found = await browser
    .find(query, {
      ...(input.tab === undefined ? {} : { tabId: input.tab }),
      role: input.role,
      limit: 5,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    })
    .catch(() => [] as BrowserElementSummary[])
  const best = bestLoginField(found, input.exclude)
  if (best !== undefined) return best
}
return undefined
}

function bestLoginField(
found: readonly BrowserElementSummary[],
exclude: ReadonlySet<string>,
): BrowserElementSummary | undefined {
return found
  .filter((entry) => entry.visible !== false && entry.disabled !== true && !exclude.has(entry.id))
  .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))[0]
}

// A submitted login is only proven when the page actually moved past the form:
// a different URL, or the same URL with the password field gone. A rejected
// login re-renders the same form with an error, which is NOT evidence.
function loginLeftForm(
  before: { readonly page: BrowserPageSummary } | { readonly error: string },
  after: { readonly page: BrowserPageSummary } | { readonly error: string },
): boolean {
  if (!("page" in before) || !("page" in after)) return false
  return !sameBrowserUrl(before.page.url, after.page.url)
}


function sameBrowserUrl(left: string, right: string): boolean {
  if (left === right) return true
  try {
    return new URL(left).href === new URL(right).href
  } catch {
    return false
  }
}

function elementTarget(reference: ElementReference): ElementTarget {
  // Preserve the observation binding: the driver's revalidation and the
  // server's stale checks need the observationId the caller resolved against.
  // Dropping it would let a stale or forged ref retarget the action.
  const elementId = reference.elementId ?? reference.id ?? ""
  const observationId = reference.observationId
  // An ElementReference is a union that REQUIRES elementId or id, so the
  // nested reference must carry the id too. A reference built from only
  // kind/role/observationId fails isElementReference, and the action is then
  // rejected as invalid before it ever reaches the driver.
  const needsReference =
    observationId !== undefined || reference.kind !== undefined || reference.role !== undefined
  return {
    kind: "element",
    elementId,
    ...(needsReference
      ? {
          reference: {
            kind: "element" as const,
            elementId,
            ...(observationId === undefined ? {} : { observationId }),
            ...(reference.role === undefined ? {} : { role: reference.role }),
          },
        }
      : {}),
  }
}

function browserDocumentId(elementId: string | undefined): string | undefined {
  if (elementId === undefined || elementId.length === 0) return undefined
  const marker = elementId.lastIndexOf("@")
  if (marker <= 0 || marker === elementId.length - 1) return undefined
  return elementId.slice(marker + 1)
}
