import { execFile, spawn, type ChildProcess } from "node:child_process"
import { readdir, stat, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ROLES, type Bounds } from "../../protocol"
import { CLIPBOARD_SCRIPT } from "../../daemon/clipboard-script"
import { LinuxHostDriver, parseXrandrMonitors, parseXwininfo, type X11Window } from "../../daemon/linux"
import { createJsonLineHelper } from "../../daemon/persistent-helper"
import { XTEST_SCRIPT } from "../../daemon/xtest-script"
import {
  detectSessionType,
  ydotoolButtonCodes,
  ydotoolKeySequence,
  ydotoolMoveArgs,
  type LinuxSessionType,
} from "../../daemon/wayland"
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
  LINUX_CUA_SCRIPT,
  parseHelperLine,
  parseResolvedPayload,
  parseSnapshotPayload,
  type AtspiApplicationSnapshot,
  type AtspiNodeSnapshot,
  type HelperLine,
  type HelperReady,
  type ResolvedElementPayload,
} from "./linux-script"
import { limitSnapshot } from "./snapshot-limit"

export const CUA_TYPE_CHUNK_SIZE = 400
const DEFAULT_MAX_ELEMENTS = 1000
const DEFAULT_WAIT_TIMEOUT_MS = 5000
const DEFAULT_WAIT_POLL_MS = 200
const MIN_WAIT_POLL_MS = 50
const HELPER_TIMEOUT_MS = 15000
const PROBE_TIMEOUT_MS = 5000
const CAPTURE_TIMEOUT_MS = 20000
const MAX_HELPER_APPS = 40
const MAX_HELPER_DEPTH = 16
const MAX_HELPER_NODES = 20000
const HELPER_RESTART_BACKOFF_MS = 500
const HELPER_RESTART_MAX_MS = 5000
const CAPTURE_RETRY_MS = 30000
const SCALE_RETRY_MS = 30000
const CLIPBOARD_TIMEOUT_MS = 20000
const SCREENSHOT_PREFIX = "omnia-cua"

export interface CuaRunResult {
  stdout: string
  stderr: string
}

export type CuaRunner = (
  file: string,
  args: readonly string[],
  timeoutMs: number,
  env?: Record<string, string>,
) => Promise<CuaRunResult>

export function defaultCuaRunner(
  file: string,
  args: readonly string[],
  timeoutMs: number,
  env?: Record<string, string>,
): Promise<CuaRunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true, env: { ...process.env, ...env } },
      (error, stdout, stderr) => {
        if (error) reject(error)
        else resolve({ stdout: String(stdout), stderr: String(stderr) })
      },
    )
  })
}

export interface CuaHelper {
  readonly ready: Promise<HelperReady>
  // True once the child process has exited or failed to spawn. Callers can
  // reject immediately instead of queueing a request that can never complete.
  readonly exited: boolean
  request(command: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<HelperLine>
  dispose(): Promise<void>
}

const MAX_HELPER_OUTPUT_BYTES = 8 * 1024 * 1024

// Spawns the persistent python helper once and multiplexes JSON-line requests
// over its stdin/stdout. The transport lives in daemon/persistent-helper.ts so
// the daemon AT-SPI helper shares the same lifecycle (ready, exit, backoff,
// dispose) instead of drifting.
export function createPersistentHelper(options: { display?: string; interpreter?: string } = {}): CuaHelper {
  const helper = createJsonLineHelper({
    script: LINUX_CUA_SCRIPT,
    label: "The Linux CUA helper",
    maxOutputBytes: MAX_HELPER_OUTPUT_BYTES,
    ...(options.display === undefined ? {} : { display: options.display }),
    ...(options.interpreter === undefined ? {} : { interpreter: options.interpreter }),
  })
  return {
    ready: helper.ready.then((line) => ({
      ok: line.ok && line.payload.pyatspi !== false,
      pyatspi: line.payload.pyatspi === true,
      x11: line.payload.x11 === true,
      ...(line.error === undefined ? {} : { error: line.error }),
    })),
    get exited() {
      return helper.exited
    },
    request: (command, params, timeoutMs) => helper.request(command, params, timeoutMs),
    dispose: () => helper.dispose(),
  }
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

// Refs embed the app/title/role/name slugs, so a ref whose occurrence index
// shifted (a dialog opened, a window reordered) can still be re-resolved
// against a fresh snapshot instead of forcing a full re-observe loop. The
// occurrence index is still authoritative: when duplicates exist, picking the
// first match would silently target the wrong widget.
function pickOccurrence<T>(matches: readonly T[], occurrence: number): T | undefined {
  if (matches.length === 0) return undefined
  if (Number.isInteger(occurrence) && occurrence >= 0 && occurrence < matches.length) return matches[occurrence]
  // A shifted index is only safe when a single candidate remains; otherwise
  // the reference is ambiguous and must be refused rather than guessed.
  return matches.length === 1 ? matches[0] : undefined
}

export function resolveLooseWindow(snapshot: CuaSnapshot, ref: string): CuaWindow | undefined {
  const parts = ref.split("/")
  if (parts[0] !== "cua:window" || parts.length < 4) return undefined
  const app = parts[1]
  const title = parts[2]
  return pickOccurrence(
    snapshot.windows.filter((window) => slugify(window.app) === app && slugify(window.title) === title),
    Number(parts[3]),
  )
}

export function resolveLooseElement(snapshot: CuaSnapshot, ref: string): CuaElement | undefined {
  const parts = ref.split("/")
  if (parts[0] !== "cua:window" || parts.length < 7) return undefined
  const window = resolveLooseWindow(snapshot, ref)
  if (window === undefined) return undefined
  const role = parts[4]
  const name = parts[5]
  return pickOccurrence(
    snapshot.elements.filter(
      (element) =>
        element.windowRef === window.ref && slugify(element.role) === role && slugify(element.name) === name,
    ),
    Number(parts[6]),
  )
}

export function parseAtspiPath(backendRef: string): number[] {
  if (!backendRef.startsWith("atspi:")) return []
  const raw = backendRef.slice("atspi:".length)
  if (raw.length === 0) return []
  return raw
    .split(".")
    .map((part) => Number(part))
    .filter((part) => Number.isInteger(part) && part >= 0)
}

const MIN_TITLE_PREFIX_LENGTH = 3

// Exact titles are authoritative; a unique prefix is accepted when the live
// title was truncated or grew since the snapshot. Short fragments are never
// treated as prefixes, and ambiguity is refused downstream.
export function windowTitleMatches(expected: string, live: string | undefined): boolean {
  const left = expected.trim().toLowerCase()
  const right = (live ?? "").trim().toLowerCase()
  if (left.length === 0 || right.length === 0) return false
  if (left === right) return true
  if (left.length < MIN_TITLE_PREFIX_LENGTH || right.length < MIN_TITLE_PREFIX_LENGTH) return false
  return left.startsWith(right) || right.startsWith(left)
}

function pickUniqueTitleMatch(candidates: readonly X11Window[], app: string): string | undefined {
  if (candidates.length === 1) return candidates[0].id
  const sameApp = candidates.filter((candidate) => candidate.cls.trim().toLowerCase() === app)
  return sameApp.length === 1 ? sameApp[0].id : undefined
}

// Exact titles win; when the live title mutates or is truncated by the window
// manager, a unique prefix match is still accepted so actions are not stranded.
// Ambiguous prefixes are refused rather than guessed, because closing or
// minimizing the wrong window is worse than a structured refusal.
export function matchX11WindowId(
  windows: readonly X11Window[],
  window: Pick<CuaWindow, "title" | "app">,
): string | undefined {
  const title = window.title.trim().toLowerCase()
  if (title.length === 0) return undefined
  const app = window.app.trim().toLowerCase()
  const exact = windows.filter((candidate) => candidate.title.trim().toLowerCase() === title)
  const exactPick = pickUniqueTitleMatch(exact, app)
  if (exactPick !== undefined) return exactPick
  const prefix = windows.filter((candidate) => windowTitleMatches(window.title, candidate.title))
  return pickUniqueTitleMatch(prefix, app)
}

const ROLE_ALIASES: Record<string, string> = {
  pushbutton: "button",
  button: "button",
  togglebutton: "switch",
  checkbox: "checkbox",
  checkmenuitem: "menuitemcheckbox",
  radiobutton: "radio",
  radiomenuitem: "menuitemradio",
  entry: "textbox",
  passwordtext: "textbox",
  searchbox: "searchbox",
  combobox: "combobox",
  spinbutton: "spinbutton",
  slider: "slider",
  scrollbar: "scrollbar",
  progressbar: "progressbar",
  levelbar: "progressbar",
  list: "list",
  listitem: "listitem",
  menu: "menu",
  popupmenu: "menu",
  menubar: "menubar",
  menuitem: "menuitem",
  frame: "window",
  window: "window",
  internalframe: "window",
  desktopframe: "window",
  dialog: "dialog",
  filechooser: "dialog",
  colorchooser: "dialog",
  fontchooser: "dialog",
  optionpane: "alertdialog",
  alert: "alert",
  alertdialog: "alertdialog",
  documentframe: "document",
  documenttext: "document",
  documentweb: "document",
  documentemail: "document",
  documentspreadsheet: "document",
  documentpresentation: "document",
  table: "table",
  tablecell: "cell",
  cell: "cell",
  tablecolumnheader: "columnheader",
  columnheader: "columnheader",
  tablerowheader: "rowheader",
  rowheader: "rowheader",
  treetable: "tree",
  tree: "tree",
  treeitem: "treeitem",
  pagetab: "tab",
  pagetablist: "tablist",
  tab: "tab",
  tablist: "tablist",
  toolbar: "toolbar",
  statusbar: "status",
  infobar: "status",
  notification: "status",
  status: "status",
  tooltip: "tooltip",
  titlebar: "titlebar",
  separator: "separator",
  link: "link",
  image: "img",
  icon: "img",
  label: "text",
  text: "text",
  paragraph: "text",
  heading: "heading",
  article: "article",
  document: "document",
  form: "form",
  application: "application",
  log: "log",
  marquee: "marquee",
  timer: "timer",
  panel: "group",
  group: "group",
  region: "region",
  grid: "grid",
  scrollpane: "region",
}

export function canonicalRole(role: string): string {
  const normalized = role.trim().toLowerCase().replaceAll(" ", "").replaceAll("_", "")
  const alias = ROLE_ALIASES[normalized]
  if (alias !== undefined) return alias
  return ROLES.find((candidate) => candidate === normalized) ?? "generic"
}

const ACTION_ALIASES: Record<string, readonly string[]> = {
  click: ["click", "press", "activate", "jump", "open", "do default", "click an item"],
  toggle: ["toggle", "check", "uncheck"],
  select: ["select", "select item"],
  expand: ["expand", "expand or contract"],
  collapse: ["collapse", "expand or contract"],
  increment: ["increase", "increment"],
  decrement: ["decrease", "decrement"],
  show_menu: ["show menu", "menu", "popup", "pop up", "context menu"],
  focus: ["focus", "grab focus", "set focus"],
}

export interface CanonicalActionInput {
  actions?: readonly string[]
  states?: readonly string[]
  editable?: boolean
  hasValue?: boolean
  hasComponent?: boolean
}

export function canonicalActions(input: CanonicalActionInput = {}): string[] {
  const raw = new Set((input.actions ?? []).map((action) => action.trim().toLowerCase()))
  const has = (canonical: string) => (ACTION_ALIASES[canonical] ?? []).some((alias) => raw.has(alias))
  const candidates: Array<[string, boolean]> = [
    ["click", has("click")],
    ["set_value", input.editable === true || input.hasValue === true],
    ["focus", input.hasComponent === true || has("focus")],
    ["toggle", has("toggle")],
    ["select", has("select")],
    ["expand", raw.has("expand") || raw.has("expand or contract")],
    ["collapse", raw.has("collapse") || raw.has("expand or contract")],
    ["increment", has("increment") || input.hasValue === true],
    ["decrement", has("decrement") || input.hasValue === true],
    ["scroll_into_view", input.hasComponent === true],
    ["show_menu", has("show_menu")],
  ]
  return candidates.flatMap(([name, available]) => (available ? [name] : []))
}

export function rawAtspiActions(element: Pick<CuaElement, "attributes">): string[] {
  const raw = element.attributes?.atspiActions
  if (typeof raw !== "string" || raw.length === 0) return []
  return raw
    .split(",")
    .map((action) => action.trim())
    .filter((action) => action.length > 0)
}

export function chooseRawAction(
  requested: string | undefined,
  element: Pick<CuaElement, "actions" | "attributes">,
): string | undefined {
  const rawActions = rawAtspiActions(element)
  if (requested === undefined || requested.trim().length === 0) {
    for (const canonical of element.actions) {
      const aliases = ACTION_ALIASES[canonical] ?? []
      const match = rawActions.find((raw) => aliases.includes(raw.toLowerCase()))
      if (match !== undefined) return match
    }
    return undefined
  }
  const requestedLower = requested.trim().toLowerCase()
  const direct = rawActions.find((raw) => raw.toLowerCase() === requestedLower)
  if (direct !== undefined) return direct
  const aliases = ACTION_ALIASES[requestedLower]
  if (aliases === undefined) return undefined
  return rawActions.find((raw) => aliases.includes(raw.toLowerCase()))
}
export interface CuaSnapshotBuildInput {
  focusedWindowBackendRef?: string
  generation: number
  takenAt: number
  applications: readonly AtspiApplicationSnapshot[]
  screen?: { x?: number; y?: number; width: number; height: number }
  maxElements: number
  requestedApp?: string
  helperTruncated?: boolean
  warnings?: readonly string[]
}

function atspiBackendRef(path: readonly number[]): string {
  return `atspi:${path.join(".")}`
}

function normalizeBounds(bounds: Bounds | undefined): Bounds | undefined {
  if (bounds === undefined || bounds.width <= 0 || bounds.height <= 0) return undefined
  return bounds
}

function numberAttribute(value: string | undefined): number | undefined {
  if (value === undefined || value.length === 0) return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return undefined
  // Uninitialized AT-SPI doubles (4.65e-310) are not real values; zero is.
  if (parsed !== 0 && (Math.abs(parsed) < 1e-100 || Math.abs(parsed) > 1e100)) return undefined
  return parsed
}

function buildAttributes(node: AtspiNodeSnapshot): Record<string, string | number | boolean> {
  const attributes: Record<string, string | number | boolean> = { atspiRole: node.role, ...node.attributes }
  if (node.actions.length > 0) attributes.atspiActions = node.actions.join(", ")
  if (node.value !== undefined && node.value.length > 0) attributes.value = node.value
  const min = numberAttribute(node.attributes.minimum ?? node.attributes.min)
  const max = numberAttribute(node.attributes.maximum ?? node.attributes.max)
  const step = numberAttribute(node.attributes.step ?? node.attributes.minimumincrement)
  const placeholder = node.attributes.placeholder ?? node.attributes["placeholder-text"]
  if (min !== undefined) attributes.min = min
  if (max !== undefined) attributes.max = max
  if (step !== undefined) attributes.step = step
  if (placeholder !== undefined && placeholder.length > 0) attributes.placeholder = placeholder
  return attributes
}

interface SnapshotBuildContext {
  generation: number
  app: string
  windows: CuaWindow[]
  elements: CuaElement[]
  windowOccurrences: Map<string, number>
  elementOccurrences: Map<string, number>
}

function addElement(
  context: SnapshotBuildContext,
  window: CuaWindow,
  node: AtspiNodeSnapshot,
  path: readonly number[],
  parentRef: string | undefined,
): void {
  const role = canonicalRole(node.role)
  const name = node.name ?? ""
  const key = `${window.ref}|${role}|${slugify(name)}`
  const occurrence = context.elementOccurrences.get(key) ?? 0
  context.elementOccurrences.set(key, occurrence + 1)
  const bounds = normalizeBounds(node.bounds)
  const element: CuaElement = {
    ref: buildElementRef(window.ref, role, name, occurrence),
    backendRef: atspiBackendRef(path),
    role,
    name,
    enabled: !node.states.includes("disabled"),
    focused: node.states.includes("focused"),
    editable: node.interfaces.editable || node.states.includes("editable"),
    actions: canonicalActions({
      actions: node.actions,
      states: node.states,
      editable: node.interfaces.editable,
      hasValue: node.interfaces.value,
      hasComponent: node.interfaces.component,
    }),
    states: node.states,
    attributes: buildAttributes(node),
    generation: context.generation,
    windowRef: window.ref,
    application: window.app,
    ...(parentRef === undefined ? {} : { parentRef }),
    ...(node.text === undefined || node.text.length === 0 ? {} : { text: node.text }),
    ...(node.value === undefined || node.value.length === 0 ? {} : { value: node.value }),
    ...(node.description === undefined || node.description.length === 0 ? {} : { description: node.description }),
    ...(bounds === undefined ? {} : { bounds }),
  }
  context.elements.push(element)
  for (const child of node.children) {
    addChild(context, window, child, [...path, child.index], element.ref)
  }
}

function addWindow(context: SnapshotBuildContext, node: AtspiNodeSnapshot, path: readonly number[]): void {
  const title = node.name ?? context.app
  const occurrenceKey = windowOccurrenceKey(context.app, title)
  const occurrence = context.windowOccurrences.get(occurrenceKey) ?? 0
  context.windowOccurrences.set(occurrenceKey, occurrence + 1)
  const bounds = normalizeBounds(node.bounds)
  const window: CuaWindow = {
    ref: buildWindowRef(context.app, title, occurrence),
    backendRef: atspiBackendRef(path),
    app: context.app,
    title,
    focused: node.states.includes("focused"),
    generation: context.generation,
    ...(isMinimizedWindow(node) ? { minimized: true } : {}),
    ...(bounds === undefined ? {} : { bounds }),
  }
  context.windows.push(window)
  // The CuaWindow is the canonical record for the window node, and the host
  // driver projects it as the window element, so no element is emitted for
  // this node. A second window-role element with the same name would make
  // title-based focus ambiguous.
  for (const child of node.children) {
    addChild(context, window, child, [...path, child.index], undefined)
  }
}

// Nested window/dialog nodes own their own accessibility subtree, so they
// start a new window boundary instead of merging into the first window. A
// client area that repeats its frame title, and unnamed toolkit roots, are
// continuations of the current window rather than windows of their own.
// Web content is not a window boundary either: Gecko/Chromium expose iframes
// as "internalframe" (which canonicalizes to window) and tag every DOM node,
// so an in-page dialog must not become a phantom window.
function startsWindowBoundary(node: AtspiNodeSnapshot, window: CuaWindow): boolean {
  if (!isWindowNode(node)) return false
  if (node.role.trim().toLowerCase().replaceAll(" ", "").replaceAll("_", "") === "internalframe") return false
  if (typeof node.attributes.tag === "string" && node.attributes.tag.length > 0) return false
  const name = (node.name ?? "").trim()
  if (name.length === 0) return false
  return normalizedWindowTitle(name) !== normalizedWindowTitle(window.title)
}

function addChild(
  context: SnapshotBuildContext,
  window: CuaWindow,
  node: AtspiNodeSnapshot,
  path: readonly number[],
  parentRef: string | undefined,
): void {
  if (isWindowNode(node)) {
    if (startsWindowBoundary(node, window)) {
      addWindow(context, node, path)
      return
    }
    // A continuation window (frame client area, unnamed toolkit root) is
    // walked through without emitting an element: a second window-role record
    // with the same name would make title-based focus ambiguous.
    for (const child of node.children) {
      addChild(context, window, child, [...path, child.index], parentRef)
    }
    return
  }
  addElement(context, window, node, path, parentRef)
}

// The AT-SPI desktop exposes applications, and each application exposes its
// top-level frames as direct children. Every direct child becomes a window so
// that every element has a stable window-scoped ref, and frame actions (close,
// activate) resolve through the window ref.
// Omnia's own windows must never pollute an agent's observation; the agent
// would otherwise see its own UI as the most prominent application.
function isSelfApplication(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.includes("io.omnia") || lower === "omnia" || lower.includes("omnia.desktop")
}

// Minimized/iconified windows stay in the snapshot marked with
// minimized:true so a minimize action can be verified against an explicit
// state; only nodes with no usable geometry and no name are dropped.
function isHiddenWindow(node: AtspiNodeSnapshot): boolean {
  return normalizeBounds(node.bounds) === undefined && (node.name ?? "").length === 0
}

function isMinimizedWindow(node: AtspiNodeSnapshot): boolean {
  return node.states.includes("iconified") || node.states.includes("minimized") || node.states.includes("hidden")
}

function hasFocusedNode(node: AtspiNodeSnapshot): boolean {
  return node.states.includes("focused") || node.children.some((child) => hasFocusedNode(child))
}

const WINDOW_ROLES = new Set(["window", "dialog", "alertdialog"])

// Only real top-level windows become CuaWindows; panels, fillers, and other
// direct children of an application would otherwise pollute the window list
// and consume the element budget without being actionable.
function isWindowNode(node: AtspiNodeSnapshot): boolean {
  return WINDOW_ROLES.has(canonicalRole(node.role))
}

// Mirrors the alias table in src/server/computers.ts so a filtered observe
// matches the same app vocabulary the server uses for window queries.
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

function appAliasTerms(fragment: string): string[] {
  const terms = new Set<string>([fragment])
  for (const alias of APP_ALIASES[fragment] ?? []) terms.add(alias)
  for (const [key, values] of Object.entries(APP_ALIASES)) {
    if (values.includes(fragment)) terms.add(key)
  }
  return [...terms]
}

// X11 window classes and AT-SPI application names rarely match exactly
// ("files" vs "dolphin", "browser" vs "firefox"), so the requested app is
// matched through the same aliases and normalization as the AT-SPI filter.
export function appMatchesFragment(fragment: string | undefined, ...values: readonly string[]): boolean {
  const requested = fragment?.trim().toLowerCase() ?? ""
  if (requested.length === 0) return true
  const candidates = values.map((value) => value.trim().toLowerCase()).filter((value) => value.length > 0)
  return appAliasTerms(requested).some((term) => candidates.some((candidate) => candidate.includes(term)))
}

function normalizedWindowTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ")
}

// Occurrence keys must be built from the same slugged components as the window
// ref, otherwise two frames whose raw app/title differ only by case or
// punctuation share occurrence 0 and collide on an identical ref while their
// element trees merge under it.
function windowOccurrenceKey(app: string, title: string): string {
  return `${slugify(app)}|${slugify(title)}`
}

// The screen is the union of every geometry source so a stale or partial
// helper extent can never shrink the clickable area below the real desktop.
export function unionScreenBounds(
  left: { x?: number; y?: number; width: number; height: number },
  right: { x?: number; y?: number; width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  const leftX = left.x ?? 0
  const leftY = left.y ?? 0
  const rightX = right.x ?? 0
  const rightY = right.y ?? 0
  const x = Math.min(leftX, rightX)
  const y = Math.min(leftY, rightY)
  return {
    x,
    y,
    width: Math.max(leftX + left.width, rightX + right.width) - x,
    height: Math.max(leftY + left.height, rightY + right.height) - y,
  }
}

function boundsOverlap(left: Bounds | undefined, right: Bounds | undefined): boolean {
  if (left === undefined || right === undefined) return false
  if (left.width <= 0 || left.height <= 0 || right.width <= 0 || right.height <= 0) return false
  return (
    left.x < right.x + right.width &&
    right.x < left.x + left.width &&
    left.y < right.y + right.height &&
    right.y < left.y + left.height
  )
}

// The AT-SPI window is authoritative because it owns the accessibility
// subtree, so an X11 record is dropped when a window with the same normalized
// title (and overlapping bounds when both report geometry) already exists,
// even when the X11 class name and AT-SPI application name differ. A minimized
// AT-SPI window reports stale/offscreen geometry, so its title alone is the
// duplicate signal or the X11 record would resurrect it as a second ref.
function duplicatesWindow(existing: readonly CuaWindow[], title: string, bounds: Bounds): boolean {
  const normalized = normalizedWindowTitle(title)
  return existing.some((candidate) => {
    if (normalized.length === 0) {
      return candidate.title.trim().length === 0 && boundsOverlap(candidate.bounds, bounds)
    }
    if (normalizedWindowTitle(candidate.title) !== normalized) return false
    if (candidate.minimized === true) return true
    if (candidate.bounds === undefined || bounds.width <= 0 || bounds.height <= 0) return true
    return boundsOverlap(candidate.bounds, bounds)
  })
}

export function buildCuaSnapshot(input: CuaSnapshotBuildInput): CuaSnapshot {
  const windows: CuaWindow[] = []
  const elements: CuaElement[] = []
  const warnings = [...(input.warnings ?? [])]
  const windowOccurrences = new Map<string, number>()
  const elementOccurrences = new Map<string, number>()
  const appFilter = input.requestedApp

  const visible = input.applications.filter((application) => {
    if (application.error !== undefined) return false
    const name = application.name ?? "unknown"
    if (isSelfApplication(name)) return false
    if (appFilter !== undefined && !appMatchesFragment(appFilter, name)) return false
    return true
  })

  // Rank the application that owns the focused window first so the agent's
  // target window is never buried behind background applications.
  const focusedAppIndex = visible.findIndex((application) => application.nodes.some((root) => hasFocusedNode(root)))
  const ordered = focusedAppIndex > 0
    ? [visible[focusedAppIndex]!, ...visible.filter((_, index) => index !== focusedAppIndex)]
    : visible

  for (const application of ordered) {
    const context: SnapshotBuildContext = {
      generation: input.generation,
      app: application.name ?? "unknown",
      windows,
      elements,
      windowOccurrences,
      elementOccurrences,
    }
    for (const root of application.nodes) {
      const children = [...root.children].sort((a, b) => {
        const aFocused = a.states.includes("focused") ? 0 : 1
        const bFocused = b.states.includes("focused") ? 0 : 1
        return aFocused - bFocused
      })
      for (const child of children) {
        if (isHiddenWindow(child) || !isWindowNode(child)) continue
        addWindow(context, child, [root.index, child.index])
      }
    }
  }

  if (input.requestedApp !== undefined && windows.length === 0) {
    warnings.push(`No application matched "${input.requestedApp}"; no elements are available for this snapshot.`)
  }
  const full: CuaSnapshot = {
    id: `cap-${input.generation}`,
    generation: input.generation,
    takenAt: input.takenAt,
    platform: "linux",
    windows,
    elements,
    ...(input.screen === undefined ? {} : { screen: input.screen }),
    truncated: input.helperTruncated === true,
    warnings,
  }
  return limitSnapshot(full, input.maxElements, input.focusedWindowBackendRef)
}

export function matchesWaitCondition(element: CuaElement, condition: CuaWaitCondition): boolean {
  if (condition.ref !== undefined && element.ref !== condition.ref) return false
  if (condition.role !== undefined && element.role !== canonicalRole(condition.role)) return false
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

function segmentGraphemes(text: string): string[] {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })
  return [...segmenter.segment(text)].map((part) => part.segment)
}

export interface LinuxCuaBackendOptions {
  display?: string
  maxElements?: number
  helper?: CuaHelper
  // Test seam for helper lifecycle coverage: supplies a fresh helper on every
  // restart so the restart-on-demand path can be exercised without a real
  // python process.
  createHelper?: () => CuaHelper
  runner?: CuaRunner
  session?: LinuxSessionType
  allowForeground?: boolean
  accessibility?: boolean
  x11Windows?: boolean
  interpreter?: string
  // Tests use a fake runner and no X server; production keeps the socket
  // probe on so a stale DISPLAY is not reported as available.
  probeDisplay?: boolean
}

interface RefResolution {
  element: CuaElement
  live: ResolvedElementPayload
  path: number[]
}

interface WindowResolution {
  window: CuaWindow
  live: ResolvedElementPayload
  path: number[]
}

function isRefResolution(value: RefResolution | CuaActionResult): value is RefResolution {
  return "element" in value
}

function isWindowResolution(value: WindowResolution | CuaActionResult): value is WindowResolution {
  return "window" in value
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

function title(xid: string): string {
  return `window ${xid}`
}

// Helper transport failures get their own codes so callers can tell a hung or
// crashed helper apart from a genuine action failure.
function helperErrorCode(error: string | undefined): string {
  if (error !== undefined && /timed out/i.test(error)) return "helper_timeout"
  if (error !== undefined && /not running|disposed|exited/i.test(error)) return "helper_exited"
  return "action_failed"
}

function parseClipboardValue(stdout: string): string | undefined {
  const line = parseHelperLine(stdout.trim())
  if (line === undefined || !line.ok || line.payload.complete === false) return undefined
  return typeof line.payload.text === "string" ? line.payload.text : undefined
}

export interface WaylandGeometry {
  scale: number
  device?: { x: number; y: number; width: number; height: number }
}

// wlr-randr --json reports the logical output position but a device-pixel mode
// size; used to derive the HiDPI conversion and the real device bounds.
export function parseWlrRandrGeometry(output: string): WaylandGeometry | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    return undefined
  }
  if (!Array.isArray(parsed)) return undefined
  let scale = 0
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue
    const record = entry as Record<string, unknown>
    if (record.enabled === false) continue
    const entryScale = typeof record.scale === "number" && Number.isFinite(record.scale) ? record.scale : 0
    if (entryScale > 0) scale = Math.max(scale, entryScale)
    const mode = record.current_mode
    if (typeof mode !== "object" || mode === null) continue
    const modeRecord = mode as Record<string, unknown>
    const width = typeof modeRecord.width === "number" ? modeRecord.width : undefined
    const height = typeof modeRecord.height === "number" ? modeRecord.height : undefined
    if (width === undefined || height === undefined || width <= 0 || height <= 0) continue
    const position = record.position
    const positionRecord = typeof position === "object" && position !== null ? (position as Record<string, unknown>) : {}
    const x = typeof positionRecord.x === "number" && Number.isFinite(positionRecord.x) ? positionRecord.x : 0
    const y = typeof positionRecord.y === "number" && Number.isFinite(positionRecord.y) ? positionRecord.y : 0
    const deviceX = Math.round(x * (entryScale > 0 ? entryScale : 1))
    const deviceY = Math.round(y * (entryScale > 0 ? entryScale : 1))
    minX = Math.min(minX, deviceX)
    minY = Math.min(minY, deviceY)
    maxX = Math.max(maxX, deviceX + width)
    maxY = Math.max(maxY, deviceY + height)
  }
  if (scale <= 0) return undefined
  const device =
    Number.isFinite(minX) && Number.isFinite(minY) && maxX > minX && maxY > minY
      ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
      : undefined
  return { scale, ...(device === undefined ? {} : { device }) }
}

export function scalePointToDevice(
  point: { x: number; y: number },
  scale: number,
): { x: number; y: number } {
  const factor = Number.isFinite(scale) && scale > 0 ? scale : 1
  return { x: Math.round(point.x * factor), y: Math.round(point.y * factor) }
}

function pointInBounds(
  point: { x: number; y: number },
  bounds: { x?: number; y?: number; width: number; height: number },
): boolean {
  const originX = bounds.x ?? 0
  const originY = bounds.y ?? 0
  return (
    point.x >= originX &&
    point.y >= originY &&
    point.x < originX + bounds.width &&
    point.y < originY + bounds.height
  )
}

function chunkText(text: string, size: number): string[] {
  if (text.length === 0) return [""]
  const chunks: string[] = []
  let current = ""
  for (const grapheme of segmentGraphemes(text)) {
    if (current.length > 0 && current.length + grapheme.length > size) {
      chunks.push(current)
      current = ""
    }
    current += grapheme
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

const BUTTON_CODES = { left: 1, middle: 2, right: 3 } as const

export class LinuxCuaBackend implements CuaBackend {
  readonly platform: CuaPlatform = "linux"
  readonly name = "cua-linux"
  private readonly display: string | undefined
  private readonly maxElements: number
  private readonly allowForeground: boolean
  private readonly runner: CuaRunner
  private readonly injectedHelper: CuaHelper | undefined
  private readonly createHelper: (() => CuaHelper) | undefined
  private readonly session: LinuxSessionType
  private readonly checkAccessibility: boolean
  private readonly mergeWindows: boolean
  private readonly interpreter: string | undefined
  private readonly probeDisplay: boolean
  private helper: CuaHelper | undefined
  private helperPending: Promise<CuaHelper | undefined> | undefined
  private helperFailures = 0
  private helperRetryAt = 0
  // True once a request has completed against the current helper. A helper
  // that dies after it has served is restarted and the request replayed; one
  // that has never served stays behind the crash backoff so a crash loop
  // cannot spawn a process per request.
  private helperServed = false
  private pythonPromise: Promise<string> | undefined
  private disposed = false
  private generation = 0
  private latest: CuaSnapshot | undefined
  private latestCaptureId: string | undefined
  private captureStatus: boolean | undefined
  private captureCheckedAt = 0
  private capturePending: Promise<boolean> | undefined
  private ydotoolStatus: boolean | undefined
  private ydotoolPending: Promise<boolean> | undefined
  private x11Driver: LinuxHostDriver | undefined
  private a11yChecked = false
  private a11yWarning: string | undefined
  private waylandGeometry: WaylandGeometry | undefined
  private waylandGeometryCheckedAt = 0
  private waylandGeometryPending: Promise<WaylandGeometry> | undefined
  private clipboardHolders = new Set<ChildProcess>()

  constructor(options: LinuxCuaBackendOptions = {}) {
    this.display = options.display ?? process.env.DISPLAY
    this.maxElements = options.maxElements ?? DEFAULT_MAX_ELEMENTS
    this.allowForeground = options.allowForeground === true
    this.runner = options.runner ?? defaultCuaRunner
    this.injectedHelper = options.helper
    this.createHelper = options.createHelper
    this.session = options.session ?? detectSessionType()
    this.checkAccessibility = options.accessibility !== false
    this.mergeWindows = options.x11Windows !== false
    this.interpreter = options.interpreter
    this.probeDisplay = options.probeDisplay !== false
  }

  async available(): Promise<boolean> {
    if (process.platform !== "linux" && this.injectedHelper === undefined) return false
    const readiness = await this.readiness()
    return readiness.ok
  }

  async capabilities(): Promise<CuaCapabilities> {
    const readiness = await this.readiness()
    const ax = readiness.ok
    const wayland = this.session === "wayland"
    const ydotool = wayland ? await this.ydotoolAvailable() : false
    const pointer = wayland ? ydotool : this.session === "x11"
    // AT-SPI keyboard events do not need the pointer backend, so a Wayland
    // session with pyatspi but no ydotool still has a working keyboard.
    const keyboard = wayland ? ydotool || ax : this.session === "x11"
    const screenshot = await this.captureAvailable()
    const limits: string[] = []
    if (!ax) limits.push(readiness.error ?? "pyatspi is missing; snapshots and semantic actions are unavailable.")
    if (wayland)
      limits.push("raw background pointer input unavailable on Wayland; pointer input uses ydotool when installed")
    if (wayland && !pointer)
      limits.push("ydotool is not installed; keyboard and pointer fallbacks are limited on Wayland")
    if (wayland && ax && !pointer)
      limits.push("keyboard input still works through AT-SPI key events")
    if (!screenshot) limits.push("no screenshot backend found; install spectacle, grim, or ffmpeg")
    if (ax) limits.push("semantic refusals never fall back silently to pointer or keyboard input")
    if (ax && this.session === "x11")
      limits.push("windows without an accessibility tree are managed through X11 window properties")
    if (this.a11yWarning !== undefined) limits.push(this.a11yWarning)
    return {
      snapshot: ax,
      semanticActions: ax,
      backgroundActions: ax,
      backgroundInput: false,
      pointer,
      keyboard,
      // Clipboard text/image handling is provided by the host driver on Linux.
      clipboard: true,
      screenshot,
      windowManagement: ax,
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

  private legacyX11(): LinuxHostDriver {
    this.x11Driver =
      this.x11Driver ??
      new LinuxHostDriver({
        runner: this.runner,
        ...(this.display === undefined ? {} : { display: this.display }),
        session: this.session,
        probeDisplay: this.probeDisplay,
      })
    return this.x11Driver
  }

  // The AT-SPI bus only exposes applications when accessibility is enabled.
  // Sessions with toolkit-accessibility=false register nothing, so every
  // snapshot would be empty; flip the setting once, best effort.
  private async ensureAccessibility(): Promise<void> {
    if (this.a11yChecked || !this.checkAccessibility || this.session === "wayland") return
    this.a11yChecked = true
    const current = await this.runner(
      "gsettings",
      ["get", "org.gnome.desktop.interface", "toolkit-accessibility"],
      PROBE_TIMEOUT_MS,
    ).catch(() => undefined)
    if (current?.stdout.trim() === "true") return
    const changed = await this.runner(
      "gsettings",
      ["set", "org.gnome.desktop.interface", "toolkit-accessibility", "true"],
      PROBE_TIMEOUT_MS,
    ).then(
      () => true,
      () => false,
    )
    if (!changed) {
      this.a11yWarning =
        "Accessibility could not be enabled through gsettings; applications that do not expose an AT-SPI tree will be missing from snapshots."
    }
  }

  // The AT-SPI window title must match an X11 window exactly: a substring
  // fallback can pick a different window with a similar title, and the caller
  // then closes or minimizes the wrong one.
  private async x11WindowIdFor(window: CuaWindow): Promise<string | undefined> {
    return matchX11WindowId(await this.x11Windows(), window)
  }

  private async x11Windows(): Promise<X11Window[]> {
    if (!this.mergeWindows || this.session === "wayland") return []
    return this.legacyX11()
      .windows()
      .catch(() => [])
  }

  // Applications without an accessibility tree (Kitty, games, canvas UIs)
  // still need window refs so focus, minimize, and close keep working. Merge
  // the X11 window list into the snapshot when AT-SPI has nothing equivalent.
  // Windows are not duplicated into the element list: `toObservation` already
  // projects every CuaWindow as an element, and a second copy with the same ref
  // would make the observation ambiguous.
  private async mergeX11Windows(snapshot: CuaSnapshot, requestedApp?: string): Promise<CuaSnapshot> {
    const windows = await this.x11Windows()
    if (windows.length === 0) return snapshot
    const additions: CuaWindow[] = []
    for (const window of windows) {
      const title = window.title.length > 0 ? window.title : window.cls.length > 0 ? window.cls : window.id
      const app = window.cls
      if (!appMatchesFragment(requestedApp, app, title)) continue
      const bounds = { x: window.x, y: window.y, width: window.width, height: window.height }
      if (duplicatesWindow([...snapshot.windows, ...additions], title, bounds)) continue
      const occurrenceKey = windowOccurrenceKey(app, title)
      const occurrence = [...snapshot.windows, ...additions].filter(
        (candidate) => windowOccurrenceKey(candidate.app, candidate.title) === occurrenceKey,
      ).length
      additions.push({
        ref: buildWindowRef(app, title, occurrence),
        backendRef: `x11:${window.id}`,
        app,
        title,
        bounds,
        focused: window.active,
        generation: snapshot.generation,
      })
    }
    if (additions.length === 0) return snapshot
    return { ...snapshot, windows: [...snapshot.windows, ...additions] }
  }

  async snapshot(options: CuaSnapshotOptions = {}): Promise<CuaSnapshot> {
    this.generation += 1
    const generation = this.generation
    const takenAt = Date.now()
    const maxElements = options.maxElements ?? this.maxElements
    await this.ensureAccessibility()
    const helper = await this.ensureHelper()
    const readiness = helper === undefined ? undefined : await withTimeout(helper.ready, PROBE_TIMEOUT_MS)
    if (helper === undefined || readiness?.ok !== true) {
      const empty: CuaSnapshot = {
        id: `cap-${generation}`,
        generation,
        takenAt,
        platform: this.platform,
        windows: [],
        elements: [],
        truncated: false,
        warnings: [
          readiness?.error ?? "The Linux accessibility helper is not available.",
          ...(this.a11yWarning === undefined ? [] : [this.a11yWarning]),
        ],
      }
      this.latest = empty
      this.latestCaptureId = empty.id
      return empty
    }
    const response = (
      await this.requestHelper("snapshot", {
        max_apps: MAX_HELPER_APPS,
        max_depth: MAX_HELPER_DEPTH,
        max_nodes: Math.min(MAX_HELPER_NODES, Math.max(1000, maxElements * 2)),
        ...(options.app === undefined ? {} : { app: options.app }),
      })
    ).response
    const payload = response === undefined ? undefined : parseSnapshotPayload(response.payload)
    const warnings =
      response === undefined
        ? ["The snapshot command failed or timed out."]
        : response.ok
          ? []
          : [response.error ?? "The snapshot command failed."]
    // The helper's desktop extents can be a stale 1024x768 while the X11 root
    // is larger; store the union so observations and point validation agree on
    // the real desktop instead of permanently shrinking to the helper value.
    const helperScreen = payload?.screen
    const x11Screen = this.session === "x11" && this.mergeWindows ? await this.x11RootBounds() : undefined
    const screen =
      helperScreen === undefined
        ? x11Screen
        : x11Screen === undefined
          ? helperScreen
          : unionScreenBounds(helperScreen, x11Screen)
    const built = buildCuaSnapshot({
      generation,
      takenAt,
      applications: payload?.applications ?? [],
      ...(screen === undefined ? {} : { screen }),
      // Build without a budget first so X11 windows merge before the element
      // budget is applied; the priority selection below then sees the complete
      // window list.
      maxElements: Number.MAX_SAFE_INTEGER,
      helperTruncated: payload?.truncated === true,
      ...(options.app === undefined ? {} : { requestedApp: options.app }),
      ...(warnings.length === 0 ? {} : { warnings }),
    })
    const mergedRaw = await this.mergeX11Windows(built, options.app)
    // The AT-SPI build cannot know that an X11 window will satisfy the app
    // filter, so its no-match warning is stale once the merge succeeds.
    const merged =
      built.windows.length === 0 && mergedRaw.windows.length > 0
        ? {
            ...mergedRaw,
            warnings: mergedRaw.warnings.filter((warning) => !warning.startsWith("No application matched")),
          }
        : mergedRaw
    const limited = limitSnapshot(merged, maxElements)
    // Put the active window first so observe/truncation never buries it.
    const activeWindow =
      this.session === "x11" && this.mergeWindows
        ? await this.legacyX11().activeWindowId().catch(() => undefined)
        : undefined
    const activeRef =
      activeWindow === undefined ? undefined : await this.activeWindowRef(limited.windows, activeWindow)
    const ordered =
      activeRef === undefined
        ? limited
        : {
            ...limited,
            windows: [
              limited.windows.find((window) => window.ref === activeRef)!,
              ...limited.windows.filter((window) => window.ref !== activeRef),
            ],
          }
    // The WM's active window is the only authority for focus on X11. AT-SPI can
    // report a toolkit-focused window while the WM still has another window
    // active (often Omnia), so replacing the flags keeps focus verification
    // honest instead of trusting the toolkit.
    const focused =
      activeWindow === undefined
        ? ordered
        : { ...ordered, windows: ordered.windows.map((window) => ({ ...window, focused: window.ref === activeRef })) }
    this.latest = focused
    this.latestCaptureId = focused.id
    return focused
  }

  private async activeWindowRef(windows: readonly CuaWindow[], activeId: string): Promise<string | undefined> {
    const direct = windows.find((window) => window.backendRef === `x11:${activeId}`)
    if (direct !== undefined) return direct.ref
    // An AT-SPI window that uniquely matches the active X11 window by title is
    // the same window, even though its own focused state may lag the WM.
    const x11 = await this.x11Windows()
    return windows.find(
      (window) => window.backendRef.startsWith("atspi:") && matchX11WindowId(x11, window) === activeId,
    )?.ref
  }

  async find(query: CuaFindQuery, snapshot?: CuaSnapshot): Promise<CuaElement[]> {
    const source = snapshot ?? (await this.snapshot())
    const limit = Math.max(0, Math.min(query.limit ?? 20, 1000))
    const role = query.role === undefined || query.role.length === 0 ? undefined : canonicalRole(query.role)
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
    // An unbounded poll interval would sleep far past the timeout; cap it and
    // never start a poll that cannot finish inside the remaining budget.
    const pollMs = Math.min(1000, Math.max(MIN_WAIT_POLL_MS, condition.pollMs ?? DEFAULT_WAIT_POLL_MS))
    let confirm = false
    while (true) {
      // Never start a full snapshot without enough budget left to finish it,
      // and cap the snapshot itself at the remaining budget so a slow walk
      // cannot overshoot the deadline.
      const remaining = timeoutMs - (Date.now() - started)
      if (remaining <= 0) break
      const snapshot = await withTimeout(this.snapshot(), remaining)
      if (snapshot === undefined) break
      const match = await this.matchWait(snapshot, condition)
      if (match !== undefined) {
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
      }
      const sleep = Math.min(pollMs, timeoutMs - (Date.now() - started))
      if (sleep <= 0) break
      await delay(sleep)
    }
    // A single unconfirmed match is not a success; reporting the element with
    // ok:false invites callers to act on a target that was never stable.
    return { ok: false, waitedMs: Date.now() - started }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.helperServed = false
    this.x11Driver?.dispose()
    this.x11Driver = undefined
    const pending = this.helperPending
    this.helperPending = undefined
    const helper =
      this.helper ?? (pending === undefined ? undefined : await pending.catch(() => undefined))
    this.helper = undefined
    if (this.injectedHelper === undefined && helper !== undefined) await helper.dispose().catch(() => undefined)
    for (const holder of this.clipboardHolders) holder.kill("SIGTERM")
    this.clipboardHolders.clear()
    this.latest = undefined
    this.latestCaptureId = undefined
  }
  private env(): Record<string, string> {
    return this.display === undefined ? {} : { DISPLAY: this.display }
  }

  // Both the response and the transport error are kept so a helper timeout or
  // crash is reported as its own cause instead of being collapsed into a
  // generic "the action failed" refusal.
  private helperRequest(
    helper: CuaHelper | undefined,
    command: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<{ response?: HelperLine; transportError?: string }> {
    if (helper === undefined) {
      return Promise.resolve({ transportError: "The Linux accessibility helper is not available." })
    }
    return helper.request(command, params, timeoutMs).then(
      (response) => ({ response }),
      (error: unknown) => ({
        transportError: error instanceof Error ? error.message : "The Linux CUA helper failed.",
      }),
    )
  }

  // Every persistent-helper request goes through here so a process that dies
  // between commands is replaced transparently and the request replayed once
  // instead of surfacing "helper process failed". A helper that had served at
  // least one request is restarted immediately; a helper that dies before
  // serving anything stays behind the normal crash backoff.
  private async requestHelper(
    command: string,
    params: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<{ response?: HelperLine; transportError?: string }> {
    const helper = await this.ensureHelper()
    const first = await this.helperRequest(helper, command, params, timeoutMs)
    if (first.response !== undefined) {
      this.helperServed = true
      return first
    }
    if (
      this.injectedHelper !== undefined ||
      this.disposed ||
      helper === undefined ||
      this.helper !== helper ||
      !this.helperServed
    ) {
      return first
    }
    // The helper died while it was serving requests. Count the crash but let
    // this one replay spawn immediately so the caller never sees the gap.
    this.helper = undefined
    this.helperServed = false
    this.noteHelperFailure()
    this.helperRetryAt = 0
    const retry = await this.helperRequest(await this.ensureHelper(), command, params, timeoutMs)
    if (retry.response !== undefined) this.helperServed = true
    return retry
  }

  // Prefer python3 but accept a python-only install; the helper is python, so
  // resolving it explicitly gives a clear dependency error instead of ENOENT.
  private resolvePython(): Promise<string> {
    this.pythonPromise =
      this.pythonPromise ??
      (async () => {
        for (const candidate of ["python3", "python"]) {
          const found = await this.runner("which", [candidate], PROBE_TIMEOUT_MS, this.env()).then(
            () => true,
            () => false,
          )
          if (found) return candidate
        }
        return "python3"
      })()
    return this.pythonPromise
  }

  private noteHelperFailure(): void {
    this.helperFailures += 1
    const backoff = Math.min(
      HELPER_RESTART_BACKOFF_MS * 2 ** Math.min(this.helperFailures - 1, 4),
      HELPER_RESTART_MAX_MS,
    )
    this.helperRetryAt = Date.now() + backoff
  }

  private ensureHelper(): Promise<CuaHelper | undefined> {
    if (this.injectedHelper !== undefined) return Promise.resolve(this.injectedHelper)
    if (this.disposed) return Promise.resolve(undefined)
    if (this.helper !== undefined) {
      if (!this.helper.exited) return Promise.resolve(this.helper)
      // The helper crashed; drop it and gate the restart behind a backoff so a
      // crash loop cannot spawn a new python process on every request.
      this.helper = undefined
      this.noteHelperFailure()
    }
    if (this.helperPending !== undefined) return this.helperPending
    if (Date.now() < this.helperRetryAt) return Promise.resolve(undefined)
    this.helperPending = Promise.resolve()
      .then(async () => {
        if (this.createHelper !== undefined) return this.createHelper()
        const interpreter = this.interpreter ?? (await this.resolvePython())
        return createPersistentHelper({
          ...(this.display === undefined ? {} : { display: this.display }),
          interpreter,
        })
      })
      .then((helper) => {
        if (this.disposed) {
          // dispose() ran while the helper was spawning; kill the late helper
          // instead of leaking an orphan process.
          void helper.dispose()
          return undefined
        }
        this.helper = helper
        this.helperFailures = 0
        this.helperRetryAt = 0
        this.helperServed = false
        return helper
      })
      .catch(() => {
        this.noteHelperFailure()
        return undefined
      })
      .finally(() => {
        this.helperPending = undefined
      })
    return this.helperPending
  }

  private async readiness(): Promise<HelperReady> {
    const helper = await this.ensureHelper()
    if (helper === undefined) {
      return { ok: false, pyatspi: false, x11: false, error: "The Linux CUA helper could not be started." }
    }
    const ready = await withTimeout(helper.ready, PROBE_TIMEOUT_MS)
    return ready ?? { ok: false, pyatspi: false, x11: false, error: "The Linux CUA helper did not report readiness." }
  }

  private async readElementText(element: CuaElement): Promise<string | undefined> {
    const response = (
      await this.requestHelper("read-text", { path: parseAtspiPath(element.backendRef), limit: 200000 })
    ).response
    if (response === undefined || !response.ok) return undefined
    return typeof response.payload.text === "string" ? response.payload.text : undefined
  }

  private async matchWait(
    snapshot: CuaSnapshot,
    condition: CuaWaitCondition,
  ): Promise<{ element?: CuaElement } | undefined> {
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
    if (condition.ref === undefined || condition.text === undefined) return undefined
    const refElement = snapshot.elements.find((candidate) => candidate.ref === condition.ref)
    if (refElement === undefined) return undefined
    const text = await this.readElementText(refElement)
    if (text === undefined || !text.toLowerCase().includes(condition.text.toLowerCase())) return undefined
    return { element: refElement }
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
    const element =
      source.elements.find((candidate) => candidate.ref === ref) ?? resolveLooseElement(source, ref)
    if (element === undefined) return refuse(action, "stale_ref", `Unknown element ref: ${ref}`, generation)
    if ((await this.ensureHelper()) === undefined) {
      return refuse(action, "backend_unavailable", "The Linux accessibility helper is not available.", generation)
    }
    const path = parseAtspiPath(element.backendRef)
    const resolved = await this.requestHelper("resolve", { path })
    if (resolved.response === undefined) {
      const message = resolved.transportError ?? "The Linux CUA helper failed."
      return refuse(action, helperErrorCode(message), message, generation, true)
    }
    const live = !resolved.response.ok ? undefined : parseResolvedPayload(resolved.response.payload)
    if (live === undefined) {
      return refuse(action, "target_unreachable", `The element at ${ref} could not be resolved.`, generation)
    }
    if (canonicalRole(live.role) !== element.role || (live.name ?? "") !== element.name) {
      return refuse(
        action,
        "target_mismatch",
        `The element at ${ref} no longer matches role "${element.role}" and name "${element.name}".`,
        generation,
      )
    }
    return { element, live, path }
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
    const window = source.windows.find((candidate) => candidate.ref === ref) ?? resolveLooseWindow(source, ref)
    if (window === undefined) return refuse(action, "stale_ref", `Unknown window ref: ${ref}`, generation)
    if ((await this.ensureHelper()) === undefined) {
      return refuse(action, "backend_unavailable", "The Linux accessibility helper is not available.", generation)
    }
    const path = parseAtspiPath(window.backendRef)
    const resolved = await this.requestHelper("resolve", { path })
    if (resolved.response === undefined) {
      const message = resolved.transportError ?? "The Linux CUA helper failed."
      return refuse(action, helperErrorCode(message), message, generation, true)
    }
    const live = !resolved.response.ok ? undefined : parseResolvedPayload(resolved.response.payload)
    if (live === undefined) {
      return refuse(action, "target_unreachable", `The window at ${ref} could not be resolved.`, generation)
    }
    if (!windowTitleMatches(window.title, live.name)) {
      return refuse(action, "target_mismatch", `The window at ${ref} no longer matches "${window.title}".`, generation)
    }
    return { window, live, path }
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

  // The real X11 root geometry from xrandr/xwininfo. The AT-SPI desktop extents
  // can be stale or report a phantom 1024x768 while the root window is larger,
  // so this is the authoritative source for point validation on X11.
  private async x11RootBounds(): Promise<{ x?: number; y?: number; width: number; height: number } | undefined> {
    const monitors = await this.runner("xrandr", ["--listmonitors"], PROBE_TIMEOUT_MS, this.env()).catch(
      () => undefined,
    )
    const virtual = monitors === undefined ? undefined : parseXrandrMonitors(monitors.stdout)
    if (virtual !== undefined) return virtual
    const root = await this.runner("xwininfo", ["-root"], PROBE_TIMEOUT_MS, this.env()).catch(() => undefined)
    if (root === undefined) return undefined
    return parseXwininfo(root.stdout)
  }

  // Never let the helper's extents shrink the screen: the union of the real X11
  // root and the AT-SPI extents accepts the full desktop even when one source
  // is stale or only covers the primary monitor.
  private async screenBounds(): Promise<{ x?: number; y?: number; width: number; height: number } | undefined> {
    const atspi = this.latest?.screen
    if (this.session === "wayland" || !this.mergeWindows) return atspi
    const x11 = await this.x11RootBounds()
    if (x11 === undefined) return atspi
    if (atspi === undefined) return x11
    return unionScreenBounds(atspi, x11)
  }

  private async runXTest(args: readonly string[]): Promise<{ ok: boolean; error?: string; skipped?: string[] }> {
    const result = await this.runner(await this.resolvePython(), ["-c", XTEST_SCRIPT, ...args], HELPER_TIMEOUT_MS, this.env()).catch(
      () => undefined,
    )
    if (result === undefined) return { ok: false, error: "The X11 input helper failed to run." }
    const line = parseHelperLine(result.stdout.trim())
    if (line !== undefined && line.ok) {
      const skipped = Array.isArray(line.payload.skipped)
        ? line.payload.skipped.filter((value): value is string => typeof value === "string")
        : []
      return { ok: true, ...(skipped.length === 0 ? {} : { skipped }) }
    }
    return { ok: false, error: line?.error ?? "The X11 input helper returned invalid output." }
  }

  // Wayland input runs one ydotool process per step; without a deadline a long
  // drag can spend minutes spawning processes with no way to cancel.
  private async runYdotool(
    commands: readonly (readonly string[])[],
    budgetMs = 30000,
  ): Promise<{ ok: boolean; error?: string }> {
    const deadline = Date.now() + budgetMs
    for (const command of commands) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) return { ok: false, error: "Wayland input exceeded its deadline." }
      const ran = await this.runner("ydotool", [...command], Math.min(HELPER_TIMEOUT_MS, remaining), this.env()).then(
        () => true,
        () => false,
      )
      if (!ran) return { ok: false, error: `Wayland input failed: ydotool ${command.join(" ")} did not run.` }
    }
    return { ok: true }
  }

  // `which ydotool` only proves the binary exists; the daemon socket may still
  // be missing, in which case every action would fail after capabilities
  // reported input as available. A no-op type probe connects to the daemon and
  // sends nothing.
  private ydotoolAvailable(): Promise<boolean> {
    if (this.session !== "wayland") return Promise.resolve(false)
    if (this.ydotoolStatus !== undefined) return Promise.resolve(this.ydotoolStatus)
    if (this.ydotoolPending === undefined) {
      this.ydotoolPending = this.runner("which", ["ydotool"], PROBE_TIMEOUT_MS, this.env())
        .then(
          () =>
            this.runner("ydotool", ["type", ""], PROBE_TIMEOUT_MS, this.env()).then(
              () => true,
              () => false,
            ),
          () => false,
        )
        .then((available) => {
          this.ydotoolStatus = available
          return available
        })
    }
    return this.ydotoolPending
  }

  // Accessibility bounds and pointer coordinates are logical pixels, but
  // ydotool injects device pixels. On a HiDPI or fractionally scaled Wayland
  // desktop the scale has to be applied before injection or every click lands
  // at the wrong place.
  private waylandScale(): Promise<WaylandGeometry> {
    if (this.session !== "wayland") return Promise.resolve({ scale: 1 })
    if (this.waylandGeometry !== undefined && Date.now() - this.waylandGeometryCheckedAt < SCALE_RETRY_MS) {
      return Promise.resolve(this.waylandGeometry)
    }
    if (this.waylandGeometryPending === undefined) {
      this.waylandGeometryPending = this.probeWaylandGeometry()
        .then((geometry) => {
          this.waylandGeometry = geometry
          this.waylandGeometryCheckedAt = Date.now()
          return geometry
        })
        .finally(() => {
          this.waylandGeometryPending = undefined
        })
    }
    return this.waylandGeometryPending
  }

  private async probeWaylandGeometry(): Promise<WaylandGeometry> {
    const wlr = await this.runner("wlr-randr", ["--json"], PROBE_TIMEOUT_MS, this.env()).catch(() => undefined)
    if (wlr !== undefined) {
      const parsed = parseWlrRandrGeometry(wlr.stdout)
      if (parsed !== undefined) return parsed
    }
    const gsettings = await this.runner(
      "gsettings",
      ["get", "org.gnome.desktop.interface", "scaling-factor"],
      PROBE_TIMEOUT_MS,
      this.env(),
    ).catch(() => undefined)
    const factor = gsettings === undefined ? undefined : Number(gsettings.stdout.trim())
    if (factor !== undefined && Number.isFinite(factor) && factor > 1) return { scale: factor }
    return { scale: 1 }
  }

  private async devicePoint(
    point: { x: number; y: number },
    screen: { x?: number; y?: number; width: number; height: number } | undefined,
  ): Promise<{ device: { x: number; y: number }; error?: string }> {
    const geometry = await this.waylandScale()
    const device = scalePointToDevice(point, geometry.scale)
    const bounds =
      geometry.device ??
      (screen === undefined || geometry.scale === 1
        ? screen
        : {
            x: Math.round((screen.x ?? 0) * geometry.scale),
            y: Math.round((screen.y ?? 0) * geometry.scale),
            width: Math.round(screen.width * geometry.scale),
            height: Math.round(screen.height * geometry.scale),
          })
    if (bounds !== undefined && !pointInBounds(device, bounds)) {
      return {
        device,
        error: `Point ${point.x},${point.y} converts to ${device.x},${device.y} outside the ${bounds.width}x${bounds.height} device screen.`,
      }
    }
    return { device }
  }

  private captureAvailable(): Promise<boolean> {
    // A transient capture failure must not poison capabilities for the whole
    // process lifetime; re-probe after a cooldown.
    if (this.captureStatus !== undefined && Date.now() - this.captureCheckedAt < CAPTURE_RETRY_MS) {
      return Promise.resolve(this.captureStatus)
    }
    if (this.capturePending === undefined) {
      this.capturePending = this.probeCapture().then((available) => {
        this.captureStatus = available
        this.captureCheckedAt = Date.now()
        return available
      })
    }
    return this.capturePending
  }

  private async probeCapture(): Promise<boolean> {
    const found = await Promise.all(
      ["spectacle", "grim", "ffmpeg"].map((file) =>
        this.runner("which", [file], PROBE_TIMEOUT_MS, this.env()).then(
          () => true,
          () => false,
        ),
      ),
    )
    return found.some((available) => available)
  }

  // Internal screenshot helper. CuaSnapshot has no screenshot field and
  // CuaAction has no screenshot variant, so this stays off the frozen
  // interface and only feeds the screenshot capability flag.
  async capture(region?: Bounds): Promise<{ ok: boolean; path?: string; backend?: string; error?: string }> {
    const file = join(tmpdir(), `${SCREENSHOT_PREFIX}-${Date.now()}.png`)
    const screen = region === undefined ? await this.screenBounds() : undefined
    const width = region?.width ?? screen?.width
    const height = region?.height ?? screen?.height
    const x = region?.x ?? screen?.x ?? 0
    const y = region?.y ?? screen?.y ?? 0
    const hasRegion = width !== undefined && height !== undefined
    const candidates: Array<{ file: string; args: string[] }> = [
      ...(region === undefined ? [{ file: "spectacle", args: ["-b", "-n", "-o", file] }] : []),
      // grim rejects "undefinedxundefined"; a region capture needs real dims.
      ...(hasRegion ? [{ file: "grim", args: ["-g", `${x},${y} ${width}x${height}`, file] }] : [{ file: "grim", args: [file] }]),
      ...(hasRegion && this.display !== undefined
        ? [
            {
              file: "ffmpeg",
              args: [
                "-loglevel",
                "error",
                "-f",
                "x11grab",
                "-video_size",
                `${width}x${height}`,
                "-i",
                `${this.display}+${x},${y}`,
                "-frames:v",
                "1",
                "-y",
                file,
              ],
            },
          ]
        : []),
    ]
    for (const candidate of candidates) {
      const ran = await this.runner(candidate.file, candidate.args, CAPTURE_TIMEOUT_MS, this.env()).then(
        () => true,
        () => false,
      )
      if (!ran) continue
      const info = await stat(file).catch(() => undefined)
      if (info === undefined || info.size === 0) continue
      this.captureStatus = true
      this.captureCheckedAt = Date.now()
      await this.pruneScreenshots()
      return { ok: true, path: file, backend: candidate.file }
    }
    this.captureStatus = undefined
    this.captureCheckedAt = 0
    return { ok: false, error: "No screen capture backend is available." }
  }

  private async pruneScreenshots(): Promise<void> {
    const directory = tmpdir()
    const entries = await readdir(directory).catch(() => undefined)
    if (entries === undefined) return
    const cutoff = Date.now() - 60 * 60 * 1000
    await Promise.all(
      entries
        .filter((entry) => entry.startsWith(`${SCREENSHOT_PREFIX}-`) && entry.endsWith(".png"))
        .map(async (entry) => {
          const path = join(directory, entry)
          const info = await stat(path).catch(() => undefined)
          if (info !== undefined && info.mtimeMs < cutoff) await unlink(path).catch(() => undefined)
        }),
    )
  }

  private async typeText(text: string): Promise<{ ok: boolean; error?: string; skipped?: string[] }> {
    if (this.session === "wayland") {
      // Prefer AT-SPI character events (no ydotool daemon needed); fall back
      // to ydotool for non-ASCII and toolkits that ignore synthetic key events.
      if ((await this.readiness()).ok) {
        // Grapheme clusters (emoji, combining marks) must be sent whole.
        let typedLength = 0
        let typed = true
        let atspiError: string | undefined
        for (const grapheme of segmentGraphemes(text)) {
          const response = await this.requestHelper("key", { keys: grapheme })
          if (response.response === undefined || !response.response.ok) {
            atspiError = response.response?.error ?? response.transportError
            typed = false
            break
          }
          typedLength += grapheme.length
        }
        if (typed) return { ok: true }
        // The AT-SPI path typed a prefix; only send the remaining suffix
        // through ydotool or the prefix would be duplicated.
        if (!(await this.ydotoolAvailable())) {
          return {
            ok: false,
            error:
              atspiError === undefined
                ? "Wayland text input needs accessibility or ydotool."
                : `${atspiError}; ydotool is not available either.`,
          }
        }
        const remainder = text.slice(typedLength)
        for (const chunk of chunkText(remainder, CUA_TYPE_CHUNK_SIZE)) {
          const ran = await this.runYdotool([["type", chunk]])
          if (!ran.ok) return { ok: false, error: ran.error }
        }
        return { ok: true }
      }
      if (!(await this.ydotoolAvailable())) {
        return { ok: false, error: "Wayland text input needs accessibility or ydotool." }
      }
      for (const chunk of chunkText(text, CUA_TYPE_CHUNK_SIZE)) {
        const ran = await this.runYdotool([["type", chunk]])
        if (!ran.ok) return { ok: false, error: ran.error }
      }
      return { ok: true }
    }
    // Characters the X11 keyboard layout cannot express (emoji, symbols
    // without a keycode) are detected before typing, then the whole text is
    // pasted through the clipboard so the result is not a silently truncated
    // string. The previous clipboard content is restored afterwards.
    const unsupported: string[] = []
    for (const chunk of chunkText(text, CUA_TYPE_CHUNK_SIZE)) {
      const check = await this.runXTest(["type", "--check", "--text", chunk])
      if (!check.ok) return { ok: false, error: check.error }
      if (check.skipped !== undefined) unsupported.push(...check.skipped)
    }
    if (unsupported.length > 0) {
      const pasted = await this.pasteText(text)
      if (pasted.ok) return { ok: true }
    }
    const skipped: string[] = [...unsupported]
    for (const chunk of chunkText(text, CUA_TYPE_CHUNK_SIZE)) {
      const xtest = await this.runXTest(["type", "--text", chunk])
      if (!xtest.ok) return { ok: false, error: xtest.error }
      if (xtest.skipped !== undefined) skipped.push(...xtest.skipped)
    }
    return { ok: true, ...(skipped.length === 0 ? {} : { skipped }) }
  }

  private spawnClipboardHolder(
    python: string,
    args: readonly string[],
    input: string,
  ): Promise<{ ok: boolean; error?: string }> {
    while (this.clipboardHolders.size >= 4) {
      const oldest = this.clipboardHolders.values().next().value
      if (oldest === undefined) break
      this.clipboardHolders.delete(oldest)
      oldest.kill("SIGTERM")
    }
    return new Promise((resolve) => {
      const child = spawn(python, [...args], {
        detached: true,
        stdio: ["pipe", "ignore", "ignore"],
        env: { ...process.env, ...this.env() },
      })
      this.clipboardHolders.add(child)
      child.once("exit", () => this.clipboardHolders.delete(child))
      child.once("error", (error) => resolve({ ok: false, error: error.message }))
      child.once("spawn", () => {
        child.unref()
        resolve({ ok: true })
      })
      child.stdin?.on("error", () => undefined)
      child.stdin?.end(input)
    })
  }

  private async pasteText(text: string): Promise<{ ok: boolean; error?: string }> {
    const python = this.interpreter ?? (await this.resolvePython())
    const previous = await this.runner(python, ["-c", CLIPBOARD_SCRIPT, "get"], CLIPBOARD_TIMEOUT_MS, this.env())
      .then((result) => parseClipboardValue(result.stdout), () => undefined)
    const written = await this.spawnClipboardHolder(
      python,
      ["-c", CLIPBOARD_SCRIPT, "set", "--stdin", "--hold", "25"],
      text,
    )
    if (!written.ok) return { ok: false, error: written.error ?? "Could not write the clipboard." }
    const pasted = await this.runXTest(["key", "--keys", "ctrl+v"])
    if (!pasted.ok) return { ok: false, error: pasted.error }
    if (previous !== undefined) {
      // Give the focused application time to consume the paste before the
      // previous clipboard content takes ownership back.
      await delay(500)
      await this.spawnClipboardHolder(
        python,
        ["-c", CLIPBOARD_SCRIPT, "set", "--stdin", "--hold", "25"],
        previous,
      )
    }
    return { ok: true }
  }

  private async sendKeys(keys: string, axReady: boolean): Promise<{ ok: boolean; error?: string }> {
    if (this.session === "wayland") {
      // AT-SPI key events travel through the accessibility bus and work on
      // Wayland without a ydotool daemon. The shared key plan holds named
      // modifiers for the whole sequence, so hotkeys work here too.
      let atspiError: string | undefined
      if (axReady) {
        const response = await this.requestHelper("key", { keys })
        if (response.response !== undefined && response.response.ok) return { ok: true }
        atspiError = response.response?.error ?? response.transportError
      }
      const sequence = ydotoolKeySequence(keys)
      if (sequence === undefined) {
        return {
          ok: false,
          error:
            atspiError === undefined
              ? `Cannot map ${keys} to key codes; accessibility cannot express modifiers.`
              : `${atspiError} Cannot map ${keys} to key codes either.`,
        }
      }
      return this.runYdotool(sequence)
    }
    const xtest = await this.runXTest(["key", "--keys", keys])
    if (xtest.ok) return { ok: true }
    if (!axReady) return { ok: false, error: xtest.error ?? "Keyboard input failed." }
    const attempt = await this.requestHelper("key", { keys })
    if (attempt.response !== undefined && attempt.response.ok) return { ok: true }
    return {
      ok: false,
      error: attempt.response?.error ?? attempt.transportError ?? xtest.error ?? "Keyboard input failed.",
    }
  }

  private async keyboardOnElement(
    element: CuaElement,
    keys: string,
    action: CuaAction,
    generation: number,
    axReady: boolean,
  ): Promise<CuaActionResult | undefined> {
    if (!element.focused) {
      if (!this.allowForeground || !axReady) return undefined
      const focused = await this.requestHelper("focus", { path: parseAtspiPath(element.backendRef) })
      if (focused.response === undefined || !focused.response.ok) return undefined
    }
    const sent = await this.sendKeys(keys, axReady)
    if (!sent.ok) return undefined
    return success(action, "keyboard", `Sent ${keys} to the focused element.`, generation, false)
  }

  private async attemptSemantic(
    command: string,
    action: CuaAction & { ref: string },
    snapshot: CuaSnapshot | undefined,
    generation: number,
    axReady: boolean,
  ): Promise<{ result: CuaActionResult } | { resolved: RefResolution; error: string }> {
    if (!axReady) {
      return {
        result: refuse(action, "backend_unavailable", "The Linux accessibility helper is not available.", generation),
      }
    }
    const resolved = await this.expectElement(action.ref, action, snapshot, generation)
    if (!isRefResolution(resolved)) return { result: resolved }
    const attempt = await this.requestHelper(command, { path: resolved.path })
    if (attempt.response !== undefined && attempt.response.ok) {
      return {
        result: success(
          action,
          "background-ax",
          `Completed ${command} on ${action.ref}.`,
          generation,
          attempt.response.payload.result !== false,
        ),
      }
    }
    return { resolved, error: attempt.response?.error ?? attempt.transportError ?? `${command} failed.` }
  }

  private async executeSemantic(
    command: string,
    action: CuaAction & { ref: string },
    snapshot: CuaSnapshot | undefined,
    generation: number,
    axReady: boolean,
  ): Promise<CuaActionResult> {
    const attempt = await this.attemptSemantic(command, action, snapshot, generation, axReady)
    if ("result" in attempt) return attempt.result
    return refuse(action, helperErrorCode(attempt.error), attempt.error, generation, true)
  }

  private async executeValueStep(
    command: "increment" | "decrement",
    key: string,
    action: CuaAction & { ref: string },
    snapshot: CuaSnapshot | undefined,
    generation: number,
    axReady: boolean,
  ): Promise<CuaActionResult> {
    const attempt = await this.attemptSemantic(command, action, snapshot, generation, axReady)
    if ("result" in attempt) return attempt.result
    const fallback = await this.keyboardOnElement(attempt.resolved.element, key, action, generation, axReady)
    if (fallback !== undefined) return fallback
    return refuse(
      action,
      "background_unavailable",
      `${command} needs a focused element for the keyboard fallback; ${attempt.error}`,
      generation,
    )
  }

  private async executeShowMenu(
    action: CuaAction & { ref: string },
    snapshot: CuaSnapshot | undefined,
    generation: number,
    axReady: boolean,
  ): Promise<CuaActionResult> {
    const attempt = await this.attemptSemantic("show-menu", action, snapshot, generation, axReady)
    if ("result" in attempt) return attempt.result
    const fallback = await this.keyboardOnElement(attempt.resolved.element, "shift+F10", action, generation, axReady)
    if (fallback !== undefined) return fallback
    return refuse(
      action,
      "background_unavailable",
      `show_menu needs a focused element for the Shift+F10 fallback; ${attempt.error}`,
      generation,
    )
  }

  // Dismiss mirrors the legacy drivers: press Escape, which closes the focused
  // menu, popup, or transient surface. The engine only verifies it when the
  // follow-up snapshot shows the surface actually disappeared.
  private async executeDismiss(
    action: Extract<CuaAction, { type: "dismiss" }>,
    generation: number,
    axReady: boolean,
  ): Promise<CuaActionResult> {
    const sent = await this.sendKeys("Escape", axReady)
    if (!sent.ok) return refuse(action, "input_failed", sent.error ?? "Escape failed.", generation, true)
    return success(action, "keyboard", "Pressed Escape to dismiss the focused transient surface.", generation, false)
  }

  private async executeInvoke(
    action: Extract<CuaAction, { type: "invoke" }>,
    snapshot: CuaSnapshot | undefined,
    generation: number,
    axReady: boolean,
  ): Promise<CuaActionResult> {
    if (!axReady) {
      return refuse(action, "backend_unavailable", "The Linux accessibility helper is not available.", generation)
    }
    const resolved = await this.expectElement(action.ref, action, snapshot, generation)
    if (!isRefResolution(resolved)) return resolved
    const raw = chooseRawAction(action.action, resolved.element)
    if (raw === undefined) {
      return refuse(
        action,
        "action_unavailable",
        `The element at ${action.ref} does not expose an AT-SPI action for "${action.action ?? "invoke"}".`,
        generation,
      )
    }
    const attempt = await this.requestHelper("act", { path: resolved.path, action: raw })
    if (attempt.response === undefined || !attempt.response.ok) {
      const failure = attempt.response?.error ?? attempt.transportError ?? `AT-SPI action ${raw} failed.`
      return refuse(action, helperErrorCode(attempt.transportError ?? attempt.response?.error), failure, generation, true)
    }
    return success(action, "background-ax", `Invoked ${raw}.`, generation, attempt.response.payload.result !== false)
  }

  private async executeSetValue(
    action: Extract<CuaAction, { type: "set_value" }>,
    snapshot: CuaSnapshot | undefined,
    generation: number,
    axReady: boolean,
  ): Promise<CuaActionResult> {
    if (!axReady) {
      return refuse(action, "backend_unavailable", "The Linux accessibility helper is not available.", generation)
    }
    const resolved = await this.expectElement(action.ref, action, snapshot, generation)
    if (!isRefResolution(resolved)) return resolved
    if ((await this.ensureHelper()) === undefined) {
      return refuse(action, "backend_unavailable", "The Linux accessibility helper is not available.", generation)
    }
    const attempt = await this.requestHelper("set-text", { path: resolved.path, text: action.value })
    if (attempt.response !== undefined && attempt.response.ok && attempt.response.payload.result !== false) {
      return success(action, "background-ax", `Set the value of ${action.ref} in the background.`, generation, true)
    }
    if (!this.allowForeground) {
      const failure = attempt.response?.error ?? attempt.transportError ?? "Background set-text is not supported by this element."
      return refuse(
        action,
        attempt.transportError === undefined ? "background_unavailable" : helperErrorCode(attempt.transportError),
        failure,
        generation,
        attempt.transportError !== undefined,
      )
    }
    const focused = await this.requestHelper("focus", { path: resolved.path })
    if (focused.response === undefined || !focused.response.ok) {
      const failure = focused.response?.error ?? focused.transportError ?? "Focusing the element failed."
      return refuse(action, helperErrorCode(focused.transportError), failure, generation, true)
    }
    const retry = await this.requestHelper("set-text", { path: resolved.path, text: action.value })
    if (retry.response !== undefined && retry.response.ok && retry.response.payload.result !== false) {
      return success(action, "foreground-ax", `Focused then set the value of ${action.ref}.`, generation, true)
    }
    return refuse(
      action,
      helperErrorCode(retry.transportError),
      retry.response?.error ?? retry.transportError ?? "Set-text failed after focusing the element.",
      generation,
      true,
    )
  }

  private async executeFocus(
    action: Extract<CuaAction, { type: "focus" }>,
    snapshot: CuaSnapshot | undefined,
    generation: number,
    axReady: boolean,
  ): Promise<CuaActionResult> {
    if (!axReady) {
      return refuse(action, "backend_unavailable", "The Linux accessibility helper is not available.", generation)
    }
    const resolved = await this.expectElement(action.ref, action, snapshot, generation)
    if (!isRefResolution(resolved)) return resolved
    const attempt = await this.requestHelper("focus", { path: resolved.path })
    if (attempt.response === undefined || !attempt.response.ok) {
      const failure = attempt.response?.error ?? attempt.transportError ?? "Focusing the element failed."
      return refuse(action, helperErrorCode(attempt.transportError), failure, generation, true)
    }
    return success(action, "foreground-ax", `Focused ${action.ref}.`, generation, attempt.response.payload.result !== false)
  }
  private async executeClick(
    action: Extract<CuaAction, { type: "click" }>,
    generation: number,
    axReady: boolean,
  ): Promise<CuaActionResult> {
    const stale = this.captureFailure(action.captureId, action, generation)
    if (stale !== undefined) return stale
    const bounds = await this.screenBounds()
    if (bounds !== undefined && !pointInBounds(action.point, bounds)) {
      return refuse(
        action,
        "invalid_point",
        `Point ${action.point.x},${action.point.y} is outside the ${bounds.width}x${bounds.height} screen.`,
        generation,
      )
    }
    const button = BUTTON_CODES[action.button ?? "left"]
    const count = Math.max(1, action.count ?? 1)
    const label = `${action.button ?? "left"} click x${count} at ${action.point.x},${action.point.y}`
    if (this.session === "wayland") {
      if (!(await this.ydotoolAvailable())) {
        return refuse(
          action,
          "operation_unavailable",
          "Wayland pointer input needs ydotool and its daemon.",
          generation,
        )
      }
      const converted = await this.devicePoint(action.point, bounds)
      if (converted.error !== undefined) {
        return refuse(action, "invalid_point", converted.error, generation)
      }
      const codes = ydotoolButtonCodes(button)
      const sequence: string[][] = [ydotoolMoveArgs(converted.device.x, converted.device.y)]
      for (let press = 0; press < count; press += 1) {
        sequence.push(["click", String(codes.down)], ["click", String(codes.up)])
      }
      const ran = await this.runYdotool(sequence)
      if (!ran.ok) return refuse(action, "input_failed", ran.error ?? "Wayland click failed.", generation, true)
      this.consumeCapture(action.captureId)
      return success(action, "pointer", `Sent ${label} through ydotool.`, generation, false)
    }
    const helperClick = axReady
      ? (await this.requestHelper("click", { x: action.point.x, y: action.point.y, button, count })).response
      : undefined
    if (helperClick !== undefined && helperClick.ok) {
      this.consumeCapture(action.captureId)
      return success(action, "pointer", `Sent ${label} through the AT-SPI helper XTest bridge.`, generation, false)
    }
    const xtest = await this.runXTest([
      "click",
      "--x",
      String(action.point.x),
      "--y",
      String(action.point.y),
      "--button",
      String(button),
      "--count",
      String(count),
    ])
    if (xtest.ok) {
      this.consumeCapture(action.captureId)
      return success(action, "pointer", `Sent ${label} through XTest.`, generation, false)
    }
    return refuse(
      action,
      "input_failed",
      xtest.error ?? helperClick?.error ?? "Pointer click failed.",
      generation,
      true,
    )
  }

  private async executeDrag(
    action: Extract<CuaAction, { type: "drag" }>,
    generation: number,
    axReady: boolean,
  ): Promise<CuaActionResult> {
    const stale = this.captureFailure(action.captureId, action, generation)
    if (stale !== undefined) return stale
    const bounds = await this.screenBounds()
    if (bounds !== undefined && (!pointInBounds(action.from, bounds) || !pointInBounds(action.to, bounds))) {
      return refuse(action, "invalid_point", "The drag start or end point is outside the screen.", generation)
    }
    const label = `drag ${action.from.x},${action.from.y} to ${action.to.x},${action.to.y}`
    if (this.session === "wayland") {
      if (!(await this.ydotoolAvailable())) {
        return refuse(
          action,
          "operation_unavailable",
          "Wayland pointer input needs ydotool and its daemon.",
          generation,
        )
      }
      const from = await this.devicePoint(action.from, bounds)
      if (from.error !== undefined) return refuse(action, "invalid_point", from.error, generation)
      const to = await this.devicePoint(action.to, bounds)
      if (to.error !== undefined) return refuse(action, "invalid_point", to.error, generation)
      const codes = ydotoolButtonCodes(1)
      const steps = 10
      const sequence: string[][] = [ydotoolMoveArgs(from.device.x, from.device.y), ["click", String(codes.down)]]
      for (let step = 1; step <= steps; step += 1) {
        sequence.push(
          ydotoolMoveArgs(
            from.device.x + ((to.device.x - from.device.x) * step) / steps,
            from.device.y + ((to.device.y - from.device.y) * step) / steps,
          ),
        )
      }
      sequence.push(["click", String(codes.up)])
      const ran = await this.runYdotool(sequence)
      if (!ran.ok) return refuse(action, "input_failed", ran.error ?? "Wayland drag failed.", generation, true)
      this.consumeCapture(action.captureId)
      return success(action, "pointer", `Sent ${label} through ydotool.`, generation, false)
    }
    const helperDrag = axReady
      ? (
          await this.requestHelper("drag", {
            from_x: action.from.x,
            from_y: action.from.y,
            to_x: action.to.x,
            to_y: action.to.y,
          })
        ).response
      : undefined
    if (helperDrag !== undefined && helperDrag.ok) {
      this.consumeCapture(action.captureId)
      return success(action, "pointer", `Sent ${label} through the AT-SPI helper XTest bridge.`, generation, false)
    }
    const xtest = await this.runXTest([
      "drag",
      "--from-x",
      String(action.from.x),
      "--from-y",
      String(action.from.y),
      "--to-x",
      String(action.to.x),
      "--to-y",
      String(action.to.y),
    ])
    if (xtest.ok) {
      this.consumeCapture(action.captureId)
      return success(action, "pointer", `Sent ${label} through XTest.`, generation, false)
    }
    return refuse(action, "input_failed", xtest.error ?? helperDrag?.error ?? "Pointer drag failed.", generation, true)
  }

  private async executeScroll(
    action: Extract<CuaAction, { type: "scroll" }>,
    snapshot: CuaSnapshot | undefined,
    generation: number,
    axReady: boolean,
  ): Promise<CuaActionResult> {
    const amount = Math.max(1, Math.round(action.amount ?? 3))
    let point: { x: number; y: number } | undefined
    if (action.ref !== undefined) {
      const resolved = await this.expectElement(action.ref, action, snapshot, generation)
      if (!isRefResolution(resolved)) return resolved
      const bounds = normalizeBounds(resolved.live.bounds)
      if (bounds === undefined) {
        return refuse(action, "invalid_target", `The element at ${action.ref} has no bounds to scroll.`, generation)
      }
      point = { x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 2) }
    }
    if (this.session === "wayland") {
      return refuse(
        action,
        "operation_unavailable",
        "Pointer scrolling is unavailable on Wayland; use keyboard scrolling with Page Up and Page Down.",
        generation,
      )
    }
    const params = {
      direction: action.direction,
      amount,
      ...(point === undefined ? {} : { x: point.x, y: point.y }),
    }
    const helperScroll = axReady ? (await this.requestHelper("scroll", params)).response : undefined
    if (helperScroll !== undefined && helperScroll.ok) {
      return success(action, "pointer", `Scrolled ${action.direction} through XTest.`, generation, false)
    }
    const xtest = await this.runXTest([
      "scroll",
      "--direction",
      action.direction,
      "--amount",
      String(amount),
      ...(point === undefined ? [] : ["--x", String(point.x), "--y", String(point.y)]),
    ])
    if (xtest.ok) return success(action, "pointer", `Scrolled ${action.direction} through XTest.`, generation, false)
    return refuse(
      action,
      "input_failed",
      xtest.error ?? helperScroll?.error ?? "Pointer scroll failed.",
      generation,
      true,
    )
  }

  private async executeType(
    action: Extract<CuaAction, { type: "type" }>,
    snapshot: CuaSnapshot | undefined,
    generation: number,
    axReady: boolean,
  ): Promise<CuaActionResult> {
    if (action.text.length === 0) return success(action, "keyboard", "Nothing to type.", generation, true)
    if (action.ref !== undefined) {
      if (!axReady) {
        return refuse(action, "backend_unavailable", "The Linux accessibility helper is not available.", generation)
      }
      const resolved = await this.expectElement(action.ref, action, snapshot, generation)
      if (!isRefResolution(resolved)) return resolved
      if ((await this.ensureHelper()) === undefined) {
        return refuse(action, "backend_unavailable", "The Linux accessibility helper is not available.", generation)
      }
      const editable = resolved.element.editable || resolved.element.actions.includes("set_value")
      if (editable) {
        const response = (await this.requestHelper("set-text", { path: resolved.path, text: action.text })).response
        if (response !== undefined && response.ok && response.payload.result !== false) {
          return success(
            action,
            "background-ax",
            `Typed ${action.text.length} characters in the background.`,
            generation,
            true,
          )
        }
        if (!this.allowForeground) {
          return refuse(
            action,
            "background_unavailable",
            response?.error ?? "Background text input is not supported by this element.",
            generation,
          )
        }
        const focused = (await this.requestHelper("focus", { path: resolved.path })).response
        if (focused === undefined || !focused.ok) {
          return refuse(action, "focus_failed", focused?.error ?? "Focusing the element failed.", generation, true)
        }
      } else if (!this.allowForeground) {
        return refuse(
          action,
          "background_unavailable",
          "Typing into this element needs focus; enable foreground fallback or type without a ref.",
          generation,
        )
      } else {
        const focused = (await this.requestHelper("focus", { path: resolved.path })).response
        if (focused === undefined || !focused.ok) {
          return refuse(action, "focus_failed", focused?.error ?? "Focusing the element failed.", generation, true)
        }
      }
    }
    const typed = await this.typeText(action.text)
    if (!typed.ok) return refuse(action, "input_failed", typed.error ?? "Text input failed.", generation, true)
    return success(
      action,
      "keyboard",
      `Typed ${action.text.length} characters.`,
      generation,
      false,
      typed.skipped === undefined
        ? undefined
        : [`Unsupported characters were skipped: ${typed.skipped.slice(0, 20).join(" ")}`],
    )
  }

  private async executeKey(
    action: Extract<CuaAction, { type: "key" }>,
    generation: number,
    axReady: boolean,
  ): Promise<CuaActionResult> {
    const keys = action.keys.map((key) => key.trim()).filter((key) => key.length > 0)
    if (keys.length === 0) return refuse(action, "invalid_action", "No keys were requested.", generation)
    const sent = await this.sendKeys(keys.join("+"), axReady)
    if (!sent.ok) return refuse(action, "input_failed", sent.error ?? "Keyboard input failed.", generation, true)
    return success(action, "keyboard", `Sent ${keys.join("+")}.`, generation, false)
  }

  // X11 focus is verified against the window manager's active window, not the
  // toolkit's focused state: AT-SPI activate does not raise a window at the WM
  // level, so only a matching _NET_ACTIVE_WINDOW proves focus actually moved.
  private async verifyX11Focus(
    xid: string,
    action: Extract<CuaAction, { type: "window" }>,
    generation: number,
    message: string,
  ): Promise<CuaActionResult> {
    const legacy = this.legacyX11()
    // KWin applies activation asynchronously; poll briefly before declaring
    // the focus request unverified.
    let active = await legacy.activeWindowId().catch(() => undefined)
    for (let attempt = 0; active !== xid && attempt < 10; attempt += 1) {
      await delay(100)
      active = await legacy.activeWindowId().catch(() => undefined)
    }
    if (active !== xid) {
      return {
        ...success(action, "foreground-ax", message, generation, false),
        warnings: [
          `The window manager did not focus ${title(xid)}; the active window is still ${active ?? "unknown"}. Do not send input to this window until focus is verified.`,
        ],
      }
    }
    return success(action, "foreground-ax", message, generation, true)
  }

  private async executeWindow(
    action: Extract<CuaAction, { type: "window" }>,
    snapshot: CuaSnapshot | undefined,
    generation: number,
    axReady: boolean,
  ): Promise<CuaActionResult> {
    const source = snapshot ?? this.latest
    const known = source?.windows.find((candidate) => candidate.ref === action.ref)
    // maximize, unmaximize, tile, and move need an X11 window id even when the
    // window came from AT-SPI, so they resolve by title against the X11 list.
    const managed = action.action === "maximize" || action.action === "unmaximize" || action.action === "tile" || action.action === "move"
    if (known !== undefined && (known.backendRef.startsWith("x11:") || managed)) {
      const xid = known.backendRef.startsWith("x11:")
        ? known.backendRef.slice("x11:".length)
        : await this.x11WindowIdFor(known)
      if (xid === undefined) {
        return refuse(
          action,
          "window_action_unavailable",
          `No X11 window uniquely matches ${known.title}; refusing to act on an ambiguous title.`,
          generation,
          true,
        )
      }
      const legacy = this.legacyX11()
      if (action.action === "focus") {
        const activated = await legacy.activateWindowId(xid)
        if (activated.success !== true) {
          return refuse(
            action,
            "window_action_unavailable",
            activated.message ?? "Window activation failed.",
            generation,
            true,
          )
        }
        return this.verifyX11Focus(xid, action, generation, activated.message ?? `Window focus completed.`)
      }
      const result =
        action.action === "minimize"
          ? await legacy.minimizeWindowId(xid)
          : action.action === "restore"
            ? await legacy.restoreWindowId(xid)
            : action.action === "close"
              ? await legacy.closeWindowId(xid)
              : action.action === "maximize"
                ? await legacy.maximizeWindowId(xid)
                : action.action === "unmaximize"
                  ? await legacy.maximizeWindowId(xid, true)
                  : action.action === "tile"
                    ? await legacy.tileWindowId(xid, action.position ?? "left")
                    : await legacy.moveWindowId(xid, {
                        x: action.x,
                        y: action.y,
                        width: action.width,
                        height: action.height,
                      })
      const message = result.message ?? `Window ${action.action} completed.`
      if (result.success !== true) {
        return refuse(action, "window_action_unavailable", message, generation, true)
      }
      return success(action, "background-ax", message, generation, true)
    }
    if (!axReady) {
      return refuse(action, "backend_unavailable", "The Linux accessibility helper is not available.", generation)
    }
    const resolved = await this.expectWindow(action.ref, action, snapshot, generation)
    if (!isWindowResolution(resolved)) return resolved
    const request = action.action === "focus" ? "activate" : action.action
    const response = (await this.requestHelper("window", { path: resolved.path, action: request })).response
    if (response === undefined || !response.ok) {
      // Many toolkits (LibreOffice, Dolphin) expose no AT-SPI window actions.
      // Fall back to the X11 window manager, matched by title.
      const window = source?.windows.find((candidate) => candidate.ref === action.ref)
      const xid = window === undefined ? undefined : await this.x11WindowIdFor(window)
      if (xid !== undefined) {
        const legacy = this.legacyX11()
        if (action.action === "focus") {
          const activated = await legacy.activateWindowId(xid)
          if (activated.success !== true) {
            return refuse(
              action,
              "window_action_unavailable",
              activated.message ?? "Window activation failed.",
              generation,
              true,
            )
          }
          return this.verifyX11Focus(
            xid,
            action,
            generation,
            activated.message ?? "Window focus completed through X11.",
          )
        }
        const result =
          action.action === "minimize"
            ? await legacy.minimizeWindowId(xid)
            : action.action === "restore"
              ? await legacy.restoreWindowId(xid)
              : await legacy.closeWindowId(xid)
        if (result.success === true) {
          return success(
            action,
            "background-ax",
            result.message ?? `Window ${action.action} completed through X11.`,
            generation,
            true,
          )
        }
      }
      return refuse(
        action,
        "window_action_unavailable",
        response?.error ?? `The window does not support ${request}.`,
        generation,
        true,
      )
    }
    if (action.action === "focus") {
      // AT-SPI activate only sets toolkit focus; the WM may keep another
      // window active (often Omnia itself). Raise and activate through X11 and
      // verify _NET_ACTIVE_WINDOW before reporting the focus as trustworthy.
      const window = source?.windows.find((candidate) => candidate.ref === action.ref)
      const xid = window === undefined ? undefined : await this.x11WindowIdFor(window)
      if (xid !== undefined) {
        const activated = await this.legacyX11().activateWindowId(xid)
        return this.verifyX11Focus(
          xid,
          action,
          generation,
          activated.message ?? "Window focus completed.",
        )
      }
    }
    return success(
      action,
      action.action === "focus" ? "foreground-ax" : "background-ax",
      `Window ${action.action} completed.`,
      generation,
      response.payload.result !== false,
    )
  }

  async execute(action: CuaAction, snapshot?: CuaSnapshot): Promise<CuaActionResult> {
    const generation = this.latest?.generation ?? snapshot?.generation ?? this.generation
    const axReady = (await this.readiness()).ok
    switch (action.type) {
      case "invoke":
        return this.executeInvoke(action, snapshot, generation, axReady)
      case "set_value":
        return this.executeSetValue(action, snapshot, generation, axReady)
      case "focus":
        return this.executeFocus(action, snapshot, generation, axReady)
      case "scroll_into_view":
        return this.executeSemantic("scroll-into-view", action, snapshot, generation, axReady)
      case "select":
        return this.executeSemantic("select", action, snapshot, generation, axReady)
      case "expand":
        return this.executeSemantic("expand", action, snapshot, generation, axReady)
      case "collapse":
        return this.executeSemantic("collapse", action, snapshot, generation, axReady)
      case "increment":
        return this.executeValueStep("increment", "Up", action, snapshot, generation, axReady)
      case "decrement":
        return this.executeValueStep("decrement", "Down", action, snapshot, generation, axReady)
      case "show_menu":
        return this.executeShowMenu(action, snapshot, generation, axReady)
      case "dismiss":
        return this.executeDismiss(action, generation, axReady)
      case "click":
        return this.executeClick(action, generation, axReady)
      case "type":
        return this.executeType(action, snapshot, generation, axReady)
      case "key":
        return this.executeKey(action, generation, axReady)
      case "scroll":
        return this.executeScroll(action, snapshot, generation, axReady)
      case "drag":
        return this.executeDrag(action, generation, axReady)
      case "window":
        return this.executeWindow(action, snapshot, generation, axReady)
      default:
        return refuse(action, "invalid_action", "Unsupported action type.", generation)
    }
  }
}

export function createLinuxBackend(options: LinuxCuaBackendOptions = {}): LinuxCuaBackend {
  return new LinuxCuaBackend(options)
}
