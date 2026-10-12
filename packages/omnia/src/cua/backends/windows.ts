import { execFile } from "node:child_process"
import { ROLES } from "../../protocol"
import type { Bounds, Point } from "../../protocol"
import type {
  CuaAction,
  CuaActionResult,
  CuaBackend,
  CuaCapabilities,
  CuaDelivery,
  CuaElement,
  CuaFindQuery,
  CuaPlatform,
  CuaSnapshot,
  CuaSnapshotOptions,
  CuaWaitCondition,
  CuaWaitResult,
  CuaWindow,
} from "../types"
import {
  WINDOWS_MAX_DEPTH,
  WINDOWS_MAX_WINDOWS,
  WINDOWS_OBSERVE_SCRIPT,
  WINDOWS_TIME_BUDGET_MS,
  WINDOWS_PROBE_SCRIPT,
  parseWindowsResolvedPayload,
  parseWindowsResultPayload,
  parseWindowsScriptOutput,
  parseWindowsSnapshotPayload,
  windowsDragScript,
  windowsFocusScript,
  windowsKeyScript,
  windowsObserveScript,
  windowsPatternScript,
  windowsPointerClickScript,
  windowsPostClickScript,
  windowsResolveScript,
  windowsScrollScript,
  windowsTypeScript,
  windowsWindowScript,
  windowsDisplayText,
  type WindowsElementSnapshot,
  type WindowsPattern,
  type WindowsResolvedPayload,
  type WindowsResultPayload,
  type WindowsScrollParams,
  type WindowsWindowAction,
  type WindowsWindowSnapshot,
} from "./windows-script"
import { limitSnapshot } from "./snapshot-limit"

export const WINDOWS_OBSERVE_TIMEOUT_MS = 30000
export const WINDOWS_SCRIPT_TIMEOUT_MS = 15000
// The observe script stops itself at this deadline; the execFile timeout is
// the hard ceiling above it, so a walk that runs out of budget reports a
// truncated tree instead of being killed mid-payload.
export const WINDOWS_OBSERVE_BUDGET_MS = WINDOWS_TIME_BUDGET_MS
const DEFAULT_MAX_ELEMENTS = 1000
const DEFAULT_WAIT_TIMEOUT_MS = 5000
const DEFAULT_WAIT_POLL_MS = 200
const MIN_WAIT_POLL_MS = 50
const PROBE_TTL_MS = 30000

export interface CuaRunResult {
  stdout: string
  stderr: string
}

export type WindowsRunner = (
  script: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<CuaRunResult>

// A per-window share of the desktop element budget. One window with a thousand
// rows must not consume the whole walk and drop every other window from the
// observation, so the build halves the budget across windows before the
// priority limiter sees the tree.
const MAX_ELEMENTS_PER_WINDOW_RATIO = 2
// More windows than the cap can ever mean a walk that stopped early, so the
// tree is reported as truncated rather than silently dropped. The helper script
// stops at the same count, so both layers agree on the bound.
const MAX_WINDOWS = WINDOWS_MAX_WINDOWS
// Aim inset from an element's edge, as a share of its thickness. Long enough to
// leave a provider-drawn, rounded edge without crossing into a neighbour.
const AIM_INSET_RATIO = 0.12

// Role-specific click points for the pointer fallback. The engine's aim layer
// owns the same vocabulary; a backend-level fallback repeats the rule so a
// foreground pointer click never defaults to the center of a bounding box.
const TITLE_BAR_EDGE: Readonly<Record<string, "left" | "right">> = {
  closebutton: "right",
  close: "right",
  minimizebutton: "left",
  minimize: "left",
  maximizebutton: "right",
  maximize: "right",
  restorebutton: "right",
  restore: "right",
}

const SCROLLBAR_ROLES: ReadonlySet<string> = new Set(["scrollbar", "scrollbarbutton", "scrollbargrip"])

const TOGGLE_ROLES: ReadonlySet<string> = new Set([
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "checkbox",
  "checkbutton",
  "radio",
  "radiobutton",
  "switch",
  "togglebutton",
])

const CONTROL_ROLES: ReadonlySet<string> = new Set([
  "button",
  "link",
  "textfield",
  "searchbox",
  "tab",
  "treeitem",
  "slider",
  "spinbutton",
  "combobox",
  "listbox",
  "listitem",
  "option",
  "gridcell",
  "cell",
  "menubutton",
  "splitbutton",
])

// The point a pointer click aims at, chosen from element metadata rather than
// the center of the bounding box: the clickable point UIA computes first, then
// the role-specific inset. The returned strategy is recorded so a bounds-center
// guess is never silent.
export function aimPoint(
  element: Pick<CuaElement, "role" | "bounds">,
  clickablePoint: { x: number; y: number } | undefined,
): { x: number; y: number; strategy: string } | undefined {
  const bounds = element.bounds
  if (bounds === undefined) return undefined
  const clamp = (x: number, y: number) => ({
    x: Math.min(Math.max(Math.round(x), bounds.x), bounds.x + bounds.width),
    y: Math.min(Math.max(Math.round(y), bounds.y), bounds.y + bounds.height),
  })
  if (clickablePoint !== undefined) return { ...clamp(clickablePoint.x, clickablePoint.y), strategy: "provider-hint" }
  const edge = TITLE_BAR_EDGE[element.role]
  if (edge !== undefined) {
    const inset = Math.max(1, Math.round(bounds.width * AIM_INSET_RATIO))
    return {
      ...clamp(edge === "right" ? bounds.x + bounds.width - inset : bounds.x + inset, bounds.y + bounds.height / 2),
      strategy: "role-inset",
    }
  }
  if (SCROLLBAR_ROLES.has(element.role)) {
    const vertical = bounds.height > bounds.width
    const inset = Math.max(1, Math.round((vertical ? bounds.width : bounds.height) * AIM_INSET_RATIO))
    return vertical
      ? { ...clamp(bounds.x + bounds.width - inset, bounds.y + bounds.height / 2), strategy: "role-inset" }
      : { ...clamp(bounds.x + bounds.width / 2, bounds.y + bounds.height - inset), strategy: "role-inset" }
  }
  if (TOGGLE_ROLES.has(element.role) || CONTROL_ROLES.has(element.role)) {
    return { ...clamp(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2), strategy: "control-center" }
  }
  return { ...clamp(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2), strategy: "bounds-center" }
}

function clickablePointAttributes(point: Point | undefined, bounds: Bounds | undefined): Record<string, number> | undefined {
  if (point === undefined || bounds === undefined) return undefined
  if (point.x < bounds.x || point.y < bounds.y) return undefined
  if (point.x > bounds.x + bounds.width || point.y > bounds.y + bounds.height) return undefined
  return { clickablePointX: point.x, clickablePointY: point.y }
}

export function defaultWindowsRunner(
  script: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<CuaRunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script, ...args],
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) reject(error)
        else resolve({ stdout: String(stdout), stderr: String(stderr) })
      },
    )
  })
}

export function slugify(input: string, maxLength = 32): string {
  const slug = input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "")
  return slug.length > 0 ? slug : "unnamed"
}

export function buildWindowRef(app: string, title: string, occurrence: number): string {
  return `cua:window/${slugify(app)}/${slugify(title)}/${occurrence}`
}

export function buildElementRef(windowRef: string, role: string, name: string, occurrence: number): string {
  return `${windowRef}/${slugify(role)}/${slugify(name)}/${occurrence}`
}

export function parseWindowsBackendRef(backendRef: string): number[] | undefined {
  const match = backendRef.match(/^win:([\d.]+)$/)
  if (match === null || match[1] === undefined) return undefined
  const parts = match[1]
    .split(".")
    .map((part) => Number(part))
    .filter((part) => Number.isInteger(part) && part >= 0)
  if (parts.length === 0) return undefined
  return parts
}

const ROLE_ALIASES: Record<string, string> = {
  button: "button",
  edit: "textbox",
  text: "text",
  window: "window",
  pane: "group",
  group: "group",
  list: "list",
  listitem: "listitem",
  menubar: "menubar",
  menu: "menu",
  menuitem: "menuitem",
  tab: "tab",
  tabitem: "tab",
  toolbar: "toolbar",
  tree: "tree",
  treeitem: "treeitem",
  checkbox: "checkbox",
  radiobutton: "radio",
  combobox: "combobox",
  slider: "slider",
  spinner: "spinbutton",
  progressbar: "progressbar",
  scrollbar: "scrollbar",
  image: "img",
  hyperlink: "link",
  document: "document",
  datagrid: "table",
  dataitem: "cell",
  header: "heading",
  headeritem: "columnheader",
  separator: "separator",
  thumb: "slider",
  statusbar: "status",
  titlebar: "titlebar",
  calendar: "grid",
  tooltip: "tooltip",
  custom: "generic",
  semanticzoom: "group",
  appbar: "toolbar",
  textbox: "textbox",
  menuitemcheckbox: "menuitemcheckbox",
  menuitemradio: "menuitemradio",
}

export function canonicalWindowsRole(role: string): string {
  const normalized = role
    .replace(/^ControlType\./i, "")
    .trim()
    .toLowerCase()
    .replaceAll(" ", "")
    .replaceAll("_", "")
  const alias = ROLE_ALIASES[normalized]
  if (alias !== undefined) return alias
  return ROLES.find((candidate) => candidate === normalized) ?? "generic"
}

const ACTION_PATTERN: Record<string, ReadonlyArray<readonly [WindowsPattern, string]>> = {
  click: [
    ["invoke", "invoke"],
    ["show_menu", "legacyiaccessible"],
  ],
  toggle: [["toggle", "toggle"]],
  select: [["select", "selectionitem"]],
  expand: [["expand", "expandcollapse"]],
  collapse: [["collapse", "expandcollapse"]],
  set_value: [["set_value", "value"]],
  increment: [["increment", "rangevalue"]],
  decrement: [["decrement", "rangevalue"]],
  scroll_into_view: [["scroll_into_view", "scrollitem"]],
  show_menu: [["show_menu", "legacyiaccessible"]],
  scroll: [["scroll", "scroll"]],
}

const DIRECT_PATTERN: Record<string, WindowsPattern> = {
  invoke: "invoke",
  toggle: "toggle",
  selectionitem: "select",
  select: "select",
  expandcollapse: "expand",
  expand: "expand",
  collapse: "collapse",
  value: "set_value",
  setvalue: "set_value",
  rangevalue: "increment",
  scrollitem: "scroll_into_view",
  scroll: "scroll",
  legacyiaccessible: "show_menu",
  showmenu: "show_menu",
}

export interface WindowsActionInput {
  patterns?: readonly string[]
  editable?: boolean
  valuePresent?: boolean
}

export function canonicalWindowsActions(input: WindowsActionInput = {}): string[] {
  const raw = new Set((input.patterns ?? []).map((pattern) => pattern.trim().toLowerCase()))
  const has = (name: string) => raw.has(name)
  const candidates: Array<[string, boolean]> = [
    ["click", has("invoke") || has("legacyiaccessible")],
    ["set_value", input.editable === true && has("value")],
    ["focus", raw.size > 0 || input.editable === true],
    ["toggle", has("toggle")],
    ["select", has("selectionitem")],
    ["expand", has("expandcollapse")],
    ["collapse", has("expandcollapse")],
    ["increment", has("rangevalue")],
    ["decrement", has("rangevalue")],
    ["scroll_into_view", has("scrollitem")],
    ["show_menu", has("legacyiaccessible")],
  ]
  return candidates.flatMap(([name, available]) => (available ? [name] : []))
}

export function rawWindowsPatterns(element: Pick<CuaElement, "attributes">): string[] {
  const raw = element.attributes?.uiaPatterns
  if (typeof raw !== "string" || raw.length === 0) return []
  return raw
    .split(",")
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern.length > 0)
}

export function chooseWindowsPattern(
  requested: string | undefined,
  element: Pick<CuaElement, "actions" | "attributes">,
): WindowsPattern | undefined {
  const available = new Set(rawWindowsPatterns(element).map((pattern) => pattern.toLowerCase()))
  const has = (name: string) => available.has(name)
  const requestedKey = requested?.trim().toLowerCase()
  if (requestedKey !== undefined && requestedKey.length > 0) {
    const direct = DIRECT_PATTERN[requestedKey]
    if (direct !== undefined && has(requestedKey)) return direct
    const aliases = ACTION_PATTERN[requestedKey]
    if (aliases !== undefined) {
      for (const [pattern, required] of aliases) {
        if (has(required)) return pattern
      }
    }
    return undefined
  }
  for (const canonical of element.actions) {
    const aliases = ACTION_PATTERN[canonical]
    if (aliases === undefined) continue
    for (const [pattern, required] of aliases) {
      if (has(required)) return pattern
    }
  }
  return undefined
}

function normalizeBounds(bounds: { x: number; y: number; width: number; height: number } | undefined) {
  if (bounds === undefined || bounds.width <= 0 || bounds.height <= 0) return undefined
  return bounds
}

function buildAttributes(
  node: WindowsElementSnapshot,
  bounds: Bounds | undefined,
): Record<string, string | number | boolean> {
  const attributes: Record<string, string | number | boolean> = { uiaRole: node.role }
  if (node.patterns.length > 0) attributes.uiaPatterns = node.patterns.join(", ")
  if (node.value !== undefined && node.value.length > 0) attributes.value = node.value
  if (node.minValue !== undefined) attributes.min = node.minValue
  if (node.maxValue !== undefined) attributes.max = node.maxValue
  if (node.stepValue !== undefined) attributes.step = node.stepValue
  if (node.automationId !== undefined && node.automationId.length > 0) attributes.automationId = node.automationId
  if (node.className !== undefined && node.className.length > 0) attributes.className = node.className
  if (node.hwnd !== undefined && node.hwnd !== 0) attributes.hwnd = node.hwnd
  if (node.pid !== undefined) attributes.pid = node.pid
  const clickable = clickablePointAttributes(node.clickablePoint, bounds)
  if (clickable !== undefined) {
    attributes.clickablePointX = clickable.clickablePointX
    attributes.clickablePointY = clickable.clickablePointY
  }
  return attributes
}

export interface WindowsSnapshotBuildInput {
  generation: number
  takenAt: number
  windows: readonly WindowsWindowSnapshot[]
  screen?: { width: number; height: number }
  maxElements: number
  requestedApp?: string
  helperTruncated?: boolean
  warnings?: readonly string[]
}

interface ElementBuildInput {
  generation: number
  node: WindowsElementSnapshot
  window: CuaWindow
  parentRef: string | undefined
  elementOccurrences: Map<string, number>
  maxElements: number
  windowCounts: Map<string, number>
  windowTruncated: Set<string>
}

function perWindowBudget(maxElements: number): number {
  return Math.max(1, Math.floor(maxElements / MAX_ELEMENTS_PER_WINDOW_RATIO))
}

function addElement(elements: CuaElement[], input: ElementBuildInput): void {
  if (input.windowTruncated.has(input.window.ref)) return
  // Per-window cap: one window with a thousand rows must not consume the whole
  // observe budget and drop every other window from the observation.
  const kept = input.windowCounts.get(input.window.ref) ?? 0
  if (kept >= perWindowBudget(input.maxElements)) {
    input.windowTruncated.add(input.window.ref)
    return
  }
  input.windowCounts.set(input.window.ref, kept + 1)
  const role = canonicalWindowsRole(input.node.role)
  const name = input.node.name ?? ""
  const key = `${input.window.ref}|${role}|${slugify(name)}`
  const occurrence = input.elementOccurrences.get(key) ?? 0
  input.elementOccurrences.set(key, occurrence + 1)
  const bounds = normalizeBounds(input.node.bounds)
  const text = input.node.text ?? windowsDisplayText(input.node.role, input.node.value, input.node.editable)
  const element: CuaElement = {
    ref: buildElementRef(input.window.ref, role, name, occurrence),
    backendRef: `win:${input.node.runtimeId}`,
    role,
    name,
    enabled: !input.node.states.includes("disabled"),
    focused: input.node.states.includes("focused"),
    editable: input.node.editable,
    actions: canonicalWindowsActions({
      patterns: input.node.patterns,
      editable: input.node.editable,
      valuePresent: input.node.valuePresent,
    }),
    states: input.node.states,
    attributes: buildAttributes(input.node, bounds),
    generation: input.generation,
    windowRef: input.window.ref,
    application: input.window.app,
    ...(input.parentRef === undefined ? {} : { parentRef: input.parentRef }),
    ...(text === undefined ? {} : { text }),
    ...(input.node.value === undefined || input.node.value.length === 0 ? {} : { value: input.node.value }),
    ...(input.node.description === undefined || input.node.description.length === 0
      ? {}
      : { description: input.node.description }),
    ...(bounds === undefined ? {} : { bounds }),
  }
  elements.push(element)
  for (const child of input.node.children) {
    addElement(elements, {
      ...input,
      node: child,
      parentRef: element.ref,
    })
  }
}

export function buildWindowsSnapshot(input: WindowsSnapshotBuildInput): CuaSnapshot {
  const windows: CuaWindow[] = []
  const elements: CuaElement[] = []
  const warnings = [...(input.warnings ?? [])]
  let helperTruncated = input.helperTruncated === true
  const windowOccurrences = new Map<string, number>()
  const elementOccurrences = new Map<string, number>()
  const windowCounts = new Map<string, number>()
  const windowTruncated = new Set<string>()
  const appFilter = input.requestedApp?.toLowerCase()

  for (const entry of input.windows) {
    const app = entry.app ?? "unknown"
    if (entry.error !== undefined) {
      warnings.push(`Window ${entry.title ?? app} could not be read: ${entry.error}`)
      continue
    }
    if (entry.node === undefined) continue
    if (appFilter !== undefined && !app.toLowerCase().includes(appFilter)) continue
    if (windows.length >= MAX_WINDOWS) {
      helperTruncated = true
      break
    }
    const title = entry.title ?? entry.node.name ?? app
    const occurrenceKey = `${app}|${title}`
    const occurrence = windowOccurrences.get(occurrenceKey) ?? 0
    windowOccurrences.set(occurrenceKey, occurrence + 1)
    const bounds = normalizeBounds(entry.node.bounds)
    const window: CuaWindow = {
      ref: buildWindowRef(app, title, occurrence),
      backendRef: `win:${entry.node.runtimeId}`,
      app,
      title,
      focused: entry.focused === true || entry.node.states.includes("focused"),
      generation: input.generation,
      ...(entry.node.states.includes("minimized") ? { minimized: true } : {}),
      ...(bounds === undefined ? {} : { bounds }),
    }
    windows.push(window)
    addElement(elements, {
      generation: input.generation,
      node: entry.node,
      window,
      parentRef: undefined,
      elementOccurrences,
      maxElements: input.maxElements,
      windowCounts,
      windowTruncated,
    })
  }

  if (input.requestedApp !== undefined && windows.length === 0) {
    warnings.push(`No application matched "${input.requestedApp}"; no elements are available for this snapshot.`)
  }
  // A window whose subtree hit the per-window cap is missing descendants, so the
  // observation must say so instead of reporting a complete tree.
  if (windowTruncated.size > 0) {
    helperTruncated = true
    for (const ref of windowTruncated) {
      const window = windows.find((candidate) => candidate.ref === ref)
      if (window === undefined) continue
      warnings.push(
        `The window "${window.title}" of ${window.app} was capped at ${perWindowBudget(input.maxElements)} elements; its subtree was truncated before the element budget was applied.`,
      )
    }
  }
  if (helperTruncated && !warnings.some((warning) => warning.includes("accessibility tree was truncated"))) {
    warnings.push(
      "The accessibility tree was truncated before the element budget was applied; some elements are missing.",
    )
  }
  // A zero-element tree must never be indistinguishable from a healthy empty
  // desktop: if no other warning explains the emptiness, say so explicitly.
  if (windows.length === 0 && warnings.length === 0) {
    warnings.push(
      "No accessibility windows were observed; the app may have no open windows or the accessibility tree may be unavailable.",
    )
  }
  return limitSnapshot(
    {
      id: `cap-${input.generation}`,
      generation: input.generation,
      takenAt: input.takenAt,
      platform: "win32",
      windows,
      elements,
      ...(input.screen === undefined ? {} : { screen: input.screen }),
      truncated: helperTruncated,
      warnings,
      accessibility:
        windows.length === 0 || elements.length === 0 || helperTruncated ? "degraded" : "available",
    },
    input.maxElements,
  )
}

export function matchesWaitCondition(element: CuaElement, condition: CuaWaitCondition): boolean {
  if (condition.ref !== undefined && element.ref !== condition.ref) return false
  if (condition.role !== undefined && element.role !== canonicalWindowsRole(condition.role)) return false
  if (condition.name !== undefined && !element.name.toLowerCase().includes(condition.name.toLowerCase())) return false
  if (condition.state !== undefined && !element.states.includes(condition.state)) return false
  if (condition.text !== undefined) {
    const haystack = `${element.name} ${element.text ?? ""} ${element.value ?? ""}`.toLowerCase()
    if (!haystack.includes(condition.text.toLowerCase())) return false
  }
  return true
}

export function hasElementCondition(condition: CuaWaitCondition): boolean {
  return (
    condition.ref !== undefined ||
    condition.role !== undefined ||
    condition.name !== undefined ||
    condition.text !== undefined ||
    condition.state !== undefined
  )
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// A wait must never outlive its deadline, so a poll that cannot finish inside
// the remaining budget is abandoned instead of blocking on the observe timeout.
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms)
    void promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(undefined)
      },
    )
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function success(
  action: CuaAction,
  delivery: CuaDelivery,
  message: string,
  generation: number,
  verified: boolean,
  warnings?: readonly string[],
): CuaActionResult {
  return {
    ok: true,
    action,
    verified,
    message,
    delivery,
    generation,
    ...(warnings === undefined || warnings.length === 0 ? {} : { warnings: [...warnings] }),
  }
}

function refuse(
  action: CuaAction,
  code: string,
  message: string,
  generation: number,
  retryable = false,
): CuaActionResult {
  return {
    ok: false,
    action,
    verified: false,
    message,
    delivery: "refused",
    generation,
    error: { code, message, retryable },
  }
}

function pointInBounds(
  point: { x: number; y: number },
  bounds: { x?: number; y?: number; width: number; height: number },
): boolean {
  const originX = bounds.x ?? 0
  const originY = bounds.y ?? 0
  return point.x >= originX && point.y >= originY && point.x < originX + bounds.width && point.y < originY + bounds.height
}

export interface WindowsCuaBackendOptions {
  runner?: WindowsRunner
  maxElements?: number
  allowForeground?: boolean
}

// Every action type carries the observation/generation pair the engine forwards
// it with, including pointer clicks, so a click aimed from an older observation
// is refused rather than delivered against whatever is on screen now. `key` and
// `dismiss` carry no pair to check.
function windowsBindingOf(action: CuaAction): { observationId?: string; generation?: number } {
  if (action.type === "key" || action.type === "dismiss") return {}
  const scope = action as CuaAction & { observationId?: string; generation?: number }
  return {
    ...(scope.observationId === undefined ? {} : { observationId: scope.observationId }),
    ...(scope.generation === undefined ? {} : { generation: scope.generation }),
  }
}

// A typed refusal naming both ids: the pair the action carries and the pair the
// current snapshot holds. A caller must be able to tell an observation mismatch
// from a generation mismatch without guessing, and no path silently rebinds.
function bindingRefusal(
  action: CuaAction,
  ref: string,
  source: CuaSnapshot,
  binding: { observationId?: string; generation?: number },
  generation: number,
): CuaActionResult | undefined {
  if (binding.observationId === undefined && binding.generation === undefined) return undefined
  const observationMatches = binding.observationId === undefined || binding.observationId === source.id
  const generationMatches = binding.generation === undefined || binding.generation === source.generation
  if (observationMatches && generationMatches) return undefined
  const from = (observed: string | undefined, value: number | undefined) =>
    observed === undefined
      ? value === undefined
        ? "an unknown observation"
        : `generation ${value}`
      : value === undefined
        ? `observation ${observed}`
        : `observation ${observed} (generation ${value})`
  return refuse(
    action,
    "stale_ref",
    `Target ${ref} is from ${from(binding.observationId, binding.generation)}, not the current observation ${source.id} (generation ${source.generation}); re-observe before acting.`,
    generation,
  )
}

interface RefResolution {
  element: CuaElement
  live: WindowsResolvedPayload
  runtimeId: number[]
}

interface WindowResolution {
  window: CuaWindow
  live: WindowsResolvedPayload
  runtimeId: number[]
  hwnd: number | undefined
}

function isRefResolution(value: RefResolution | CuaActionResult): value is RefResolution {
  return "element" in value
}

function isWindowResolution(value: WindowResolution | CuaActionResult): value is WindowResolution {
  return "window" in value
}

class WindowsCuaBackend implements CuaBackend {
  readonly platform: CuaPlatform = "win32"
  readonly name = "cua-windows"
  // The engine needs the backend's default walk budget to decide whether a
  // cached snapshot covers a request.
  readonly defaultMaxElements = DEFAULT_MAX_ELEMENTS
  private readonly maxElements: number
  private readonly allowForeground: boolean
  private readonly runner: WindowsRunner
  private readonly injectedRunner: boolean
  private generation = 0
  private latest: CuaSnapshot | undefined
  private latestCaptureId: string | undefined
  private probeStatus: { ok: boolean; error?: string } | undefined
  private probePending: Promise<{ ok: boolean; error?: string }> | undefined
  private probeCheckedAt = 0

  constructor(options: WindowsCuaBackendOptions = {}) {
    this.maxElements = options.maxElements ?? DEFAULT_MAX_ELEMENTS
    this.allowForeground = options.allowForeground === true
    this.runner = options.runner ?? defaultWindowsRunner
    this.injectedRunner = options.runner !== undefined
  }

  async available(): Promise<boolean> {
    if (process.platform !== "win32" && !this.injectedRunner) return false
    const probe = await this.probe()
    return probe.ok
  }

  async capabilities(): Promise<CuaCapabilities> {
    const probe = await this.probe()
    const uia = probe.ok
    const limits: string[] = []
    if (!uia) limits.push(probe.error ?? "Windows UI Automation is not available in this session.")
    limits.push("requires an interactive desktop session")
    limits.push("elevated windows refuse background actions unless Omnia runs elevated")
    limits.push("background actions never move the cursor; pointer and keyboard fallback is opt-in")
    limits.push("typing uses the clipboard as a paste buffer and restores its previous value on a best-effort basis")
    return {
      snapshot: uia,
      semanticActions: uia,
      backgroundActions: uia,
      backgroundInput: false,
      pointer: uia,
      keyboard: uia,
      clipboard: false,
      screenshot: uia,
      windowManagement: uia,
      waitFor: true,
      refs: true,
      actions: [
        "invoke",
        "set_value",
        "focus",
        "scroll_into_view",
        "select",
        "expand",
        "collapse",
        "increment",
        "decrement",
        "show_menu",
        "dismiss",
        "click",
        "type",
        "key",
        "scroll",
        "drag",
        "window",
      ],
      limits,
    }
  }

  async snapshot(options: CuaSnapshotOptions = {}): Promise<CuaSnapshot> {
    this.generation += 1
    const generation = this.generation
    const takenAt = Date.now()
    const maxElements = options.maxElements ?? this.maxElements
    const script = windowsObserveScript({
      ...(options.app === undefined ? {} : { app: options.app }),
      maxElements: Math.max(1000, maxElements * 2),
      maxDepth: WINDOWS_MAX_DEPTH,
      timeBudgetMs: WINDOWS_OBSERVE_BUDGET_MS,
    })
    const raw = await this.runScript(script, WINDOWS_OBSERVE_TIMEOUT_MS)
    const payload = parseWindowsSnapshotPayload(raw)
    const failure =
      isRecord(raw) && typeof raw.message === "string"
        ? raw.message
        : isRecord(raw) && typeof raw.error === "string"
          ? raw.error
          : undefined
    const warnings =
      payload === undefined
        ? [failure ?? "The Windows UI Automation script did not return a snapshot."]
        : payload.errors
    const built = buildWindowsSnapshot({
      generation,
      takenAt,
      windows: payload?.windows ?? [],
      ...(payload?.screen === undefined ? {} : { screen: payload.screen }),
      maxElements,
      helperTruncated: payload?.truncated === true,
      ...(options.app === undefined ? {} : { requestedApp: options.app }),
      ...(warnings.length === 0 ? {} : { warnings }),
    })
    this.latest = built
    this.latestCaptureId = built.id
    return built
  }

  async find(query: CuaFindQuery, snapshot?: CuaSnapshot): Promise<CuaElement[]> {
    const source = snapshot ?? (await this.snapshot())
    const limit = Math.max(0, Math.min(query.limit ?? 20, 1000))
    const role = query.role === undefined || query.role.length === 0 ? undefined : canonicalWindowsRole(query.role)
    const name = query.name?.toLowerCase()
    const text = query.text?.toLowerCase()
    const windowQuery = query.window?.toLowerCase()
    const windowRefs =
      windowQuery === undefined || windowQuery.length === 0
        ? undefined
        : new Set(
            source.windows
              .filter(
                (window) =>
                  window.title.toLowerCase().includes(windowQuery) || window.app.toLowerCase().includes(windowQuery),
              )
              .map((window) => window.ref),
          )
    return source.elements
      .filter((element) => {
        if (windowRefs !== undefined && (element.windowRef === undefined || !windowRefs.has(element.windowRef))) {
          return false
        }
        if (role !== undefined && element.role !== role) return false
        if (name !== undefined && name.length > 0 && !element.name.toLowerCase().includes(name)) return false
        if (text !== undefined && text.length > 0) {
          const haystack = `${element.name} ${element.text ?? ""} ${element.value ?? ""}`.toLowerCase()
          if (!haystack.includes(text)) return false
        }
        return true
      })
      .slice(0, limit)
  }

  async waitFor(condition: CuaWaitCondition): Promise<CuaWaitResult> {
    const started = Date.now()
    const timeoutMs = Math.max(0, condition.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS)
    // An unbounded poll interval would sleep far past the timeout, and a
    // snapshot that starts with no budget left to finish in can overshoot the
    // deadline by the whole observe timeout; cap both.
    const pollMs = Math.min(1000, Math.max(MIN_WAIT_POLL_MS, condition.pollMs ?? DEFAULT_WAIT_POLL_MS))
    let confirm = false
    let matched: CuaElement | undefined
    while (true) {
      const remaining = timeoutMs - (Date.now() - started)
      if (remaining <= 0) break
      const snapshot = await withTimeout(this.snapshot(), remaining)
      if (snapshot === undefined) break
      const match = this.matchWait(snapshot, condition)
      if (match !== undefined) {
        matched = match.element
        if (confirm) {
          return {
            ok: true,
            ...(match.element === undefined ? {} : { element: match.element }),
            waitedMs: Date.now() - started,
          }
        }
        confirm = true
      } else {
        confirm = false
        matched = undefined
      }
      const sleep = Math.min(pollMs, timeoutMs - (Date.now() - started))
      if (sleep <= 0) break
      await delay(sleep)
    }
    return {
      ok: false,
      ...(matched === undefined ? {} : { element: matched }),
      waitedMs: Date.now() - started,
    }
  }

  async dispose(): Promise<void> {
    this.latest = undefined
    this.latestCaptureId = undefined
  }

  private matchWait(snapshot: CuaSnapshot, condition: CuaWaitCondition): { element?: CuaElement } | undefined {
    const windowTitle = condition.windowTitle?.toLowerCase()
    if (
      windowTitle !== undefined &&
      windowTitle.length > 0 &&
      !snapshot.windows.some((window) => window.title.toLowerCase().includes(windowTitle))
    ) {
      return undefined
    }
    if (!hasElementCondition(condition)) return {}
    const element = snapshot.elements.find((candidate) => matchesWaitCondition(candidate, condition))
    if (element !== undefined) return { element }
    return undefined
  }

  private async runScript(script: string, timeoutMs: number): Promise<unknown> {
    const result = await this.runner(script, [], timeoutMs).catch(() => undefined)
    if (result === undefined) return undefined
    return parseWindowsScriptOutput(result.stdout)
  }

  private probe(): Promise<{ ok: boolean; error?: string }> {
    // Permission/availability can change while the process runs; a cached
    // denial must expire so the backend recovers without a restart.
    if (this.probeStatus !== undefined && Date.now() - this.probeCheckedAt < PROBE_TTL_MS) {
      return Promise.resolve(this.probeStatus)
    }
    if (this.probePending === undefined) {
      this.probePending = this.runScript(WINDOWS_PROBE_SCRIPT, WINDOWS_SCRIPT_TIMEOUT_MS)
        .then((raw) => {
          const status =
            isRecord(raw) && raw.ok === true
              ? { ok: true }
              : {
                  ok: false,
                  error:
                    (isRecord(raw) && typeof raw.error === "string" ? raw.error : undefined) ??
                    "Windows UI Automation is not available in this session.",
                }
          this.probeStatus = status
          this.probeCheckedAt = Date.now()
          return status
        })
        .finally(() => {
          this.probePending = undefined
        })
    }
    return this.probePending
  }

  private captureFailure(
    captureId: string | undefined,
    action: CuaAction,
    generation: number,
  ): CuaActionResult | undefined {
    if (captureId === undefined) return undefined
    if (this.latestCaptureId === undefined || this.latestCaptureId !== captureId) {
      return refuse(
        action,
        "capture_stale",
        `Capture id ${captureId} does not match the latest snapshot; take a new snapshot.`,
        generation,
      )
    }
    return undefined
  }

  private consumeCapture(captureId: string | undefined): void {
    if (captureId !== undefined) this.latestCaptureId = undefined
  }

  private classifyFailure(
    action: CuaAction,
    result: WindowsResultPayload | undefined,
    generation: number,
    fallbackMessage: string,
  ): CuaActionResult {
    const message = result?.error ?? fallbackMessage
    const type = result?.exceptionType ?? ""
    const lower = message.toLowerCase()
    if (
      /UnauthorizedAccessException/i.test(type) ||
      lower.includes("access is denied") ||
      lower.includes("access denied") ||
      lower.includes("0x80070005")
    ) {
      return refuse(
        action,
        "background_unavailable",
        `${message} Background UIA actions are refused across elevation boundaries; run Omnia at the same integrity level.`,
        generation,
      )
    }
    if (/InvalidOperationException/i.test(type)) {
      return refuse(action, "action_unavailable", message, generation)
    }
    return refuse(action, "action_failed", message, generation, true)
  }

  private backgroundSetValueFailure(
    action: CuaAction,
    result: WindowsResultPayload | undefined,
    fallbackMessage: string,
    generation: number,
  ): CuaActionResult {
    const classified = this.classifyFailure(action, result, generation, fallbackMessage)
    // UIA diagnostics (elevation boundaries, unsupported patterns) win; a
    // plain failure keeps the historical background_unavailable code.
    if (classified.error?.code === "action_failed") {
      return refuse(action, "background_unavailable", classified.message, generation)
    }
    return classified
  }

  private bindingStaleness(
    action: CuaAction,
    snapshot: CuaSnapshot | undefined,
    generation: number,
  ): CuaActionResult | undefined {
    const binding = windowsBindingOf(action)
    if (binding.observationId === undefined && binding.generation === undefined) return undefined
    const source = snapshot ?? this.latest
    if (source === undefined) {
      return refuse(action, "no_snapshot", "Take a snapshot before acting on an element ref.", generation)
    }
    const label = "ref" in action && typeof action.ref === "string" ? action.ref : `${action.type} action`
    return bindingRefusal(action, label, source, binding, generation)
  }

  private async expectElement(
    ref: string,
    action: CuaAction,
    snapshot: CuaSnapshot | undefined,
    generation: number,
  ): Promise<RefResolution | CuaActionResult> {
    const source = snapshot ?? this.latest
    if (source === undefined) {
      return refuse(action, "no_snapshot", "Take a snapshot before acting on an element ref.", generation)
    }
    const stale = bindingRefusal(action, ref, source, windowsBindingOf(action), generation)
    if (stale !== undefined) return stale
    const element = source.elements.find((candidate) => candidate.ref === ref)
    if (element === undefined) return refuse(action, "stale_ref", `Unknown element ref: ${ref}`, generation)
    if (!(await this.probe()).ok) {
      return refuse(action, "backend_unavailable", "Windows UI Automation is not available.", generation)
    }
    const runtimeId = parseWindowsBackendRef(element.backendRef)
    if (runtimeId === undefined) {
      return refuse(action, "target_unreachable", `The element at ${ref} has no resolvable UIA identity.`, generation)
    }
    const raw = await this.runScript(windowsResolveScript(runtimeId), WINDOWS_SCRIPT_TIMEOUT_MS)
    const live = parseWindowsResolvedPayload(raw)
    if (live === undefined) {
      const result = parseWindowsResultPayload(raw)
      return this.classifyFailure(action, result, generation, `The element at ${ref} could not be resolved.`)
    }
    if (canonicalWindowsRole(live.role) !== element.role || (live.name ?? "") !== element.name) {
      return refuse(
        action,
        "target_mismatch",
        `The element at ${ref} no longer matches role "${element.role}" and name "${element.name}".`,
        generation,
      )
    }
    return { element, live, runtimeId }
  }

  private async expectWindow(
    ref: string,
    action: CuaAction,
    snapshot: CuaSnapshot | undefined,
    generation: number,
  ): Promise<WindowResolution | CuaActionResult> {
    const source = snapshot ?? this.latest
    if (source === undefined) {
      return refuse(action, "no_snapshot", "Take a snapshot before acting on a window ref.", generation)
    }
    const stale = bindingRefusal(action, ref, source, windowsBindingOf(action), generation)
    if (stale !== undefined) return stale
    const window = source.windows.find((candidate) => candidate.ref === ref)
    if (window === undefined) return refuse(action, "stale_ref", `Unknown window ref: ${ref}`, generation)
    if (!(await this.probe()).ok) {
      return refuse(action, "backend_unavailable", "Windows UI Automation is not available.", generation)
    }
    const runtimeId = parseWindowsBackendRef(window.backendRef)
    if (runtimeId === undefined) {
      return refuse(action, "target_unreachable", `The window at ${ref} has no resolvable UIA identity.`, generation)
    }
    const raw = await this.runScript(windowsResolveScript(runtimeId), WINDOWS_SCRIPT_TIMEOUT_MS)
    const live = parseWindowsResolvedPayload(raw)
    if (live === undefined) {
      const result = parseWindowsResultPayload(raw)
      return this.classifyFailure(action, result, generation, `The window at ${ref} could not be resolved.`)
    }
    if ((live.name ?? "") !== window.title) {
      return refuse(action, "target_mismatch", `The window at ${ref} no longer matches "${window.title}".`, generation)
    }
    return { window, live, runtimeId, hwnd: live.hwnd }
  }

  private async attemptPattern(
    pattern: WindowsPattern,
    action: CuaAction & { ref: string },
    snapshot: CuaSnapshot | undefined,
    generation: number,
    value?: string,
    scroll?: WindowsScrollParams,
  ): Promise<{ result: CuaActionResult } | { resolved: RefResolution; error: string; failure?: WindowsResultPayload }> {
    const resolved = await this.expectElement(action.ref, action, snapshot, generation)
    if (!isRefResolution(resolved)) return { result: resolved }
    const raw = await this.runScript(
      windowsPatternScript(resolved.runtimeId, pattern, value, scroll),
      WINDOWS_SCRIPT_TIMEOUT_MS,
    )
    const result = parseWindowsResultPayload(raw)
    if (result?.ok === true) {
      return {
        result: success(
          action,
          "background-ax",
          `Ran ${result.method ?? pattern} on ${action.ref}.`,
          generation,
          true,
        ),
      }
    }
    return {
      resolved,
      error: result?.error ?? `${pattern} failed.`,
      ...(result === undefined ? {} : { failure: result }),
    }
  }

  private async keyboardOnElement(
    element: CuaElement,
    keys: string,
    action: CuaAction,
    generation: number,
  ): Promise<CuaActionResult | undefined> {
    const runtimeId = parseWindowsBackendRef(element.backendRef)
    if (runtimeId === undefined) return undefined
    if (!element.focused) {
      if (!this.allowForeground) return undefined
      const focused = parseWindowsResultPayload(
        await this.runScript(windowsFocusScript(runtimeId), WINDOWS_SCRIPT_TIMEOUT_MS),
      )
      if (focused?.ok !== true) return undefined
    }
    const script = windowsKeyScript(keys)
    if (script === undefined) return undefined
    const sent = parseWindowsResultPayload(await this.runScript(script, WINDOWS_SCRIPT_TIMEOUT_MS))
    if (sent?.ok !== true) return undefined
    return success(action, "keyboard", `Sent ${keys} to the focused element.`, generation, false)
  }

  private async pointerClickFallback(
    action: CuaAction & { ref: string },
    resolved: RefResolution,
    generation: number,
  ): Promise<CuaActionResult> {
    const bounds = normalizeBounds(resolved.live.bounds ?? resolved.element.bounds)
    if (bounds === undefined) {
      return refuse(action, "background_unavailable", `The element at ${action.ref} has no bounds for a pointer fallback.`, generation)
    }
    // Choose the point from element metadata, never the center of the bounding
    // box by default: UIA's own clickable point first, then the role-specific
    // inset.
    const aim = aimPoint({ ...resolved.element, bounds }, resolved.live.clickablePoint) ?? {
      x: Math.round(bounds.x + bounds.width / 2),
      y: Math.round(bounds.y + bounds.height / 2),
      strategy: "bounds-center",
    }
    const point = { x: aim.x, y: aim.y }
    if (this.allowForeground) {
      const output = parseWindowsResultPayload(
        await this.runScript(windowsPointerClickScript(point, "left", 1), WINDOWS_SCRIPT_TIMEOUT_MS),
      )
      if (output?.ok !== true) {
        return this.classifyFailure(action, output, generation, "The pointer click fallback failed.")
      }
      if (aim.strategy === "bounds-center") {
        return success(
          action,
          "pointer",
          `Clicked ${action.ref} at the center of its bounds (${point.x},${point.y}); no better aim point was reported.`,
          generation,
          false,
          ["aim: bounds-center"],
        )
      }
      return success(action, "pointer", `Clicked ${action.ref} at its ${aim.strategy} (${point.x},${point.y}).`, generation, false)
    }
    const hwnd = resolved.element.attributes?.hwnd
    if (typeof hwnd !== "number" || hwnd === 0) {
      return refuse(
        action,
        "background_unavailable",
        `No UIA pattern exists for ${action.ref} and no window handle is available to post a click.`,
        generation,
      )
    }
    const output = parseWindowsResultPayload(
      await this.runScript(windowsPostClickScript(hwnd, point, "left"), WINDOWS_SCRIPT_TIMEOUT_MS),
    )
    if (output?.ok !== true) {
      return this.classifyFailure(action, output, generation, "The posted click fallback failed.")
    }
    return success(action, "pointer", `Posted a background click to ${action.ref}.`, generation, false)
  }

  private async executeInvoke(
    action: Extract<CuaAction, { type: "invoke" }>,
    snapshot: CuaSnapshot | undefined,
    generation: number,
  ): Promise<CuaActionResult> {
    const resolved = await this.expectElement(action.ref, action, snapshot, generation)
    if (!isRefResolution(resolved)) return resolved
    const pattern = chooseWindowsPattern(action.action, resolved.element)
    if (pattern === undefined) return this.pointerClickFallback(action, resolved, generation)
    const attempt = await this.attemptPattern(pattern, action, snapshot, generation)
    if ("result" in attempt) return attempt.result
    return this.classifyFailure(action, attempt.failure, generation, attempt.error)
  }

  private async executeSetValue(
    action: Extract<CuaAction, { type: "set_value" }>,
    snapshot: CuaSnapshot | undefined,
    generation: number,
  ): Promise<CuaActionResult> {
    const resolved = await this.expectElement(action.ref, action, snapshot, generation)
    if (!isRefResolution(resolved)) return resolved
    const patterns = new Set(resolved.live.patterns.map((pattern) => pattern.toLowerCase()))
    if (patterns.has("value") && resolved.live.editable) {
      const attempt = await this.attemptPattern("set_value", action, snapshot, generation, action.value)
      if ("result" in attempt) return attempt.result
      if (!this.allowForeground) {
        // Keep the background-refusal code, but let classifyFailure surface
        // elevation (UnauthorizedAccessException) and unsupported-pattern
        // diagnostics instead of discarding them.
        return this.backgroundSetValueFailure(action, attempt.failure, attempt.error, generation)
      }
    }
    if (patterns.has("rangevalue") && Number.isFinite(Number(action.value))) {
      const attempt = await this.attemptPattern("set_range", action, snapshot, generation, action.value)
      if ("result" in attempt) return attempt.result
      if (!this.allowForeground) {
        return this.backgroundSetValueFailure(action, attempt.failure, attempt.error, generation)
      }
    }
    if (!this.allowForeground) {
      return refuse(
        action,
        "background_unavailable",
        "Background set-value is not supported by this element and the foreground fallback is disabled.",
        generation,
      )
    }
    const runtimeId = parseWindowsBackendRef(resolved.element.backendRef)
    const focused =
      runtimeId === undefined
        ? undefined
        : parseWindowsResultPayload(await this.runScript(windowsFocusScript(runtimeId), WINDOWS_SCRIPT_TIMEOUT_MS))
    if (focused?.ok !== true) {
      return refuse(action, "focus_failed", focused?.error ?? "Focusing the element failed.", generation, true)
    }
    if (!patterns.has("value")) {
      return refuse(action, "set_value_failed", "The element does not expose a Value pattern.", generation, true)
    }
    const attempt = await this.attemptPattern("set_value", action, snapshot, generation, action.value)
    if ("result" in attempt) return { ...attempt.result, delivery: "foreground-ax" }
    return this.classifyFailure(action, attempt.failure, generation, attempt.error)
  }

  private async executeFocus(
    action: Extract<CuaAction, { type: "focus" }>,
    snapshot: CuaSnapshot | undefined,
    generation: number,
  ): Promise<CuaActionResult> {
    const resolved = await this.expectElement(action.ref, action, snapshot, generation)
    if (!isRefResolution(resolved)) return resolved
    const raw = await this.runScript(
      windowsFocusScript(resolved.runtimeId),
      WINDOWS_SCRIPT_TIMEOUT_MS,
    )
    const result = parseWindowsResultPayload(raw)
    if (result?.ok !== true) {
      return this.classifyFailure(action, result, generation, "Focusing the element failed.")
    }
    return success(action, "foreground-ax", `Focused ${action.ref}.`, generation, true)
  }

  private async executeStatePattern(
    pattern: WindowsPattern,
    action: CuaAction & { ref: string },
    snapshot: CuaSnapshot | undefined,
    generation: number,
    state: string | undefined,
  ): Promise<CuaActionResult> {
    const resolved = await this.expectElement(action.ref, action, snapshot, generation)
    if (!isRefResolution(resolved)) return resolved
    if (state !== undefined && resolved.live.states.includes(state)) {
      return success(action, "background-ax", `${action.ref} is already ${state}.`, generation, true)
    }
    if (!resolved.element.actions.includes(action.type)) {
      return refuse(
        action,
        "action_unavailable",
        `The element at ${action.ref} does not expose the ${pattern} UIA pattern.`,
        generation,
      )
    }
    const attempt = await this.attemptPattern(pattern, action, snapshot, generation)
    if ("result" in attempt) return attempt.result
    return this.classifyFailure(action, attempt.failure, generation, attempt.error)
  }

  private async executeValueStep(
    pattern: "increment" | "decrement",
    key: string,
    action: CuaAction & { ref: string },
    snapshot: CuaSnapshot | undefined,
    generation: number,
  ): Promise<CuaActionResult> {
    const resolved = await this.expectElement(action.ref, action, snapshot, generation)
    if (!isRefResolution(resolved)) return resolved
    if (resolved.element.actions.includes(action.type)) {
      const attempt = await this.attemptPattern(pattern, action, snapshot, generation)
      if ("result" in attempt) return attempt.result
      if (!this.allowForeground) return this.classifyFailure(action, attempt.failure, generation, attempt.error)
    }
    const fallback = await this.keyboardOnElement(resolved.element, key, action, generation)
    if (fallback !== undefined) return fallback
    return refuse(
      action,
      "background_unavailable",
      `${action.type} needs a focused element for the keyboard fallback and no RangeValue pattern is available.`,
      generation,
    )
  }

  private async executeShowMenu(
    action: Extract<CuaAction, { type: "show_menu" }>,
    snapshot: CuaSnapshot | undefined,
    generation: number,
  ): Promise<CuaActionResult> {
    const resolved = await this.expectElement(action.ref, action, snapshot, generation)
    if (!isRefResolution(resolved)) return resolved
    if (resolved.element.actions.includes("show_menu")) {
      const attempt = await this.attemptPattern("show_menu", action, snapshot, generation)
      if ("result" in attempt) return attempt.result
    }
    const fallback = await this.keyboardOnElement(resolved.element, "shift+F10", action, generation)
    if (fallback !== undefined) return fallback
    return refuse(
      action,
      "background_unavailable",
      "show_menu needs a focused element for the Shift+F10 fallback and no LegacyIAccessible pattern is available.",
      generation,
    )
  }

  private async executeClick(
    action: Extract<CuaAction, { type: "click" }>,
    generation: number,
  ): Promise<CuaActionResult> {
    const stale = this.captureFailure(action.captureId, action, generation)
    if (stale !== undefined) return stale
    const bounds = this.latest?.screen
    if (bounds !== undefined && !pointInBounds(action.point, bounds)) {
      return refuse(
        action,
        "invalid_point",
        `Point ${action.point.x},${action.point.y} is outside the ${bounds.width}x${bounds.height} screen.`,
        generation,
      )
    }
    this.consumeCapture(action.captureId)
    const count = Math.max(1, action.count ?? 1)
    const output = parseWindowsResultPayload(
      await this.runScript(
        windowsPointerClickScript(action.point, action.button ?? "left", count),
        WINDOWS_SCRIPT_TIMEOUT_MS,
      ),
    )
    if (output?.ok !== true) {
      return this.classifyFailure(action, output, generation, "The Windows pointer click failed.")
    }
    return success(
      action,
      "pointer",
      `Sent ${action.button ?? "left"} click x${count} at ${action.point.x},${action.point.y}.`,
      generation,
      false,
    )
  }

  private async executeDrag(
    action: Extract<CuaAction, { type: "drag" }>,
    generation: number,
  ): Promise<CuaActionResult> {
    const stale = this.captureFailure(action.captureId, action, generation)
    if (stale !== undefined) return stale
    const bounds = this.latest?.screen
    if (bounds !== undefined && (!pointInBounds(action.from, bounds) || !pointInBounds(action.to, bounds))) {
      return refuse(action, "invalid_point", "The drag start or end point is outside the screen.", generation)
    }
    this.consumeCapture(action.captureId)
    const output = parseWindowsResultPayload(
      await this.runScript(windowsDragScript(action.from, action.to), WINDOWS_SCRIPT_TIMEOUT_MS),
    )
    if (output?.ok !== true) {
      return this.classifyFailure(action, output, generation, "The Windows pointer drag failed.")
    }
    return success(
      action,
      "pointer",
      `Dragged ${action.from.x},${action.from.y} to ${action.to.x},${action.to.y}.`,
      generation,
      false,
    )
  }

  private async executeScroll(
    action: Extract<CuaAction, { type: "scroll" }>,
    snapshot: CuaSnapshot | undefined,
    generation: number,
  ): Promise<CuaActionResult> {
    const amount = Math.max(1, Math.round(action.amount ?? 3))
    const ref = action.ref
    if (ref !== undefined) {
      const target: CuaAction & { ref: string } = { ...action, ref }
      const resolved = await this.expectElement(ref, target, snapshot, generation)
      if (!isRefResolution(resolved)) return resolved
      const hasScrollPattern = rawWindowsPatterns(resolved.element).some(
        (pattern) => pattern.toLowerCase() === "scroll",
      )
      if (hasScrollPattern) {
        const attempt = await this.attemptPattern("scroll", target, snapshot, generation, undefined, {
          direction: action.direction,
          amount,
        })
        if ("result" in attempt) return attempt.result
        // The Scroll pattern is the background path for a ref-scoped scroll.
        // Dropping through to a wheel event moves the real cursor, which the
        // foreground opt-in exists to prevent, so report the pattern failure
        // instead of silently stealing input.
        if (!this.allowForeground) {
          return this.classifyFailure(action, attempt.failure, generation, attempt.error)
        }
      }
      const bounds = normalizeBounds(resolved.live.bounds ?? resolved.element.bounds)
      if (bounds === undefined) {
        return refuse(action, "invalid_target", `The element at ${action.ref} has no bounds to scroll.`, generation)
      }
      const aim = aimPoint({ ...resolved.element, bounds }, resolved.live.clickablePoint) ?? {
        x: Math.round(bounds.x + bounds.width / 2),
        y: Math.round(bounds.y + bounds.height / 2),
        strategy: "bounds-center",
      }
      const point = { x: aim.x, y: aim.y }
      const output = parseWindowsResultPayload(
        await this.runScript(windowsScrollScript(action.direction, amount, point), WINDOWS_SCRIPT_TIMEOUT_MS),
      )
      if (output?.ok !== true) {
        return this.classifyFailure(action, output, generation, "The Windows scroll failed.")
      }
      return success(action, "pointer", `Scrolled ${action.direction} over ${action.ref}.`, generation, false)
    }
    const output = parseWindowsResultPayload(
      await this.runScript(windowsScrollScript(action.direction, amount), WINDOWS_SCRIPT_TIMEOUT_MS),
    )
    if (output?.ok !== true) {
      return this.classifyFailure(action, output, generation, "The Windows scroll failed.")
    }
    return success(action, "pointer", `Scrolled ${action.direction}.`, generation, false)
  }

  private async executeType(
    action: Extract<CuaAction, { type: "type" }>,
    snapshot: CuaSnapshot | undefined,
    generation: number,
  ): Promise<CuaActionResult> {
    if (action.text.length === 0) return success(action, "keyboard", "Nothing to type.", generation, true)
    const ref = action.ref
    if (ref !== undefined) {
      const target: CuaAction & { ref: string } = { ...action, ref }
      const resolved = await this.expectElement(ref, target, snapshot, generation)
      if (!isRefResolution(resolved)) return resolved
      // NO silent type→set_value: typing is always keyboard input after focus.
      if (!this.allowForeground) {
        return refuse(
          action,
          "background_unavailable",
          "Typing into this element needs focus and the foreground fallback is disabled; enable it or type without a ref.",
          generation,
        )
      }
      const runtimeId = parseWindowsBackendRef(resolved.element.backendRef)
      const focused =
        runtimeId === undefined
          ? undefined
          : parseWindowsResultPayload(await this.runScript(windowsFocusScript(runtimeId), WINDOWS_SCRIPT_TIMEOUT_MS))
      if (focused?.ok !== true) {
        return refuse(action, "focus_failed", focused?.error ?? "Focusing the element failed.", generation, true)
      }
    }
    const output = parseWindowsResultPayload(
      await this.runScript(windowsTypeScript(action.text), WINDOWS_SCRIPT_TIMEOUT_MS),
    )
    if (output?.ok !== true) {
      return this.classifyFailure(action, output, generation, "The Windows typing failed.")
    }
    return success(action, "keyboard", `Typed ${action.text.length} characters.`, generation, false)
  }

  private async executeKey(
    action: Extract<CuaAction, { type: "key" }>,
    generation: number,
  ): Promise<CuaActionResult> {
    const keys = action.keys.map((key) => key.trim()).filter((key) => key.length > 0)
    if (keys.length === 0) return refuse(action, "invalid_action", "No keys were requested.", generation)
    const script = windowsKeyScript(keys.join("+"))
    if (script === undefined) {
      return refuse(action, "invalid_action", `Cannot map ${keys.join("+")} to Windows virtual keys.`, generation)
    }
    const output = parseWindowsResultPayload(await this.runScript(script, WINDOWS_SCRIPT_TIMEOUT_MS))
    if (output?.ok !== true) {
      return this.classifyFailure(action, output, generation, "The Windows key event failed.")
    }
    return success(action, "keyboard", `Sent ${keys.join("+")}.`, generation, false)
  }

  // Dismiss mirrors the legacy driver: press Escape to close the focused menu
  // or popup. The engine only verifies it when the follow-up snapshot shows a
  // real state change.
  private async executeDismiss(
    action: Extract<CuaAction, { type: "dismiss" }>,
    generation: number,
  ): Promise<CuaActionResult> {
    const script = windowsKeyScript("escape")
    if (script === undefined) {
      return refuse(action, "invalid_action", "Cannot map Escape to a Windows virtual key.", generation)
    }
    const output = parseWindowsResultPayload(await this.runScript(script, WINDOWS_SCRIPT_TIMEOUT_MS))
    if (output?.ok !== true) {
      return this.classifyFailure(action, output, generation, "The Windows Escape event failed.")
    }
    return success(action, "keyboard", "Pressed Escape to dismiss the focused transient surface.", generation, false)
  }

  private async executeWindow(
    action: Extract<CuaAction, { type: "window" }>,
    snapshot: CuaSnapshot | undefined,
    generation: number,
  ): Promise<CuaActionResult> {
    const resolved = await this.expectWindow(action.ref, action, snapshot, generation)
    if (!isWindowResolution(resolved)) return resolved
    if (resolved.hwnd === undefined || resolved.hwnd === 0) {
      return refuse(
        action,
        "window_action_unavailable",
        `The window at ${action.ref} does not expose a native window handle.`,
        generation,
      )
    }
    const output = parseWindowsResultPayload(
      await this.runScript(
        windowsWindowScript(resolved.hwnd, action.action as WindowsWindowAction),
        WINDOWS_SCRIPT_TIMEOUT_MS,
      ),
    )
    if (output?.ok !== true) {
      return this.classifyFailure(action, output, generation, `The window does not support ${action.action}.`)
    }
    const delivery: CuaDelivery = action.action === "focus" ? "foreground-ax" : "background-ax"
    return success(action, delivery, `Window ${action.action} completed.`, generation, true)
  }

  async execute(action: CuaAction, snapshot?: CuaSnapshot): Promise<CuaActionResult> {
    const generation = this.latest?.generation ?? snapshot?.generation ?? this.generation
    const probe = await this.probe()
    if (!probe.ok) {
      return refuse(action, "backend_unavailable", probe.error ?? "Windows UI Automation is not available.", generation)
    }
    // Refuse the whole action before any delivery when the pair it carries
    // names another observation — including pointer clicks, which are the ones
    // a silently rebound ref would land on the wrong control.
    const stale = this.bindingStaleness(action, snapshot, generation)
    if (stale !== undefined) return stale
    switch (action.type) {
      case "invoke":
        return this.executeInvoke(action, snapshot, generation)
      case "set_value":
        return this.executeSetValue(action, snapshot, generation)
      case "focus":
        return this.executeFocus(action, snapshot, generation)
      case "scroll_into_view":
        return this.executeStatePattern("scroll_into_view", action, snapshot, generation, undefined)
      case "select":
        return this.executeStatePattern("select", action, snapshot, generation, "selected")
      case "expand":
        return this.executeStatePattern("expand", action, snapshot, generation, "expanded")
      case "collapse":
        return this.executeStatePattern("collapse", action, snapshot, generation, "collapsed")
      case "increment":
        return this.executeValueStep("increment", "Up", action, snapshot, generation)
      case "decrement":
        return this.executeValueStep("decrement", "Down", action, snapshot, generation)
      case "show_menu":
        return this.executeShowMenu(action, snapshot, generation)
      case "dismiss":
        return this.executeDismiss(action, generation)
      case "click":
        return this.executeClick(action, generation)
      case "type":
        return this.executeType(action, snapshot, generation)
      case "key":
        return this.executeKey(action, generation)
      case "scroll":
        return this.executeScroll(action, snapshot, generation)
      case "drag":
        return this.executeDrag(action, generation)
      case "window":
        return this.executeWindow(action, snapshot, generation)
      default:
        return refuse(action, "invalid_action", "Unsupported action type.", generation)
    }
  }
}

export function createWindowsCuaBackend(options: WindowsCuaBackendOptions = {}): CuaBackend {
  return new WindowsCuaBackend(options)
}

export function createWindowsBackend(): CuaBackend {
  return new WindowsCuaBackend()
}

export { WINDOWS_OBSERVE_SCRIPT }
