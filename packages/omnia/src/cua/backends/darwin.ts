import { execFile } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { ROLES } from "../../protocol"
import { DARWIN_AX_HELPER } from "./darwin-ax"
import { limitSnapshot } from "./snapshot-limit"
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
  DARWIN_MAX_DEPTH,
  DARWIN_OBSERVE_SCRIPT,
  DARWIN_PROBE_SCRIPT,
  darwinActionScript,
  darwinClickScript,
  darwinDragScript,
  darwinFocusScript,
  darwinKeyBody,
  darwinKeyScript,
  darwinObserveScript,
  darwinResolveScript,
  darwinScrollScript,
  darwinSetValueScript,
  darwinTypeScript,
  darwinValueStepScript,
  darwinWindowScript,
  parseDarwinResolvedPayload,
  parseDarwinResultPayload,
  parseDarwinScriptOutput,
  parseDarwinSnapshotPayload,
  type DarwinApplicationSnapshot,
  type DarwinElementSnapshot,
  type DarwinResolvedPayload,
  type DarwinWindowAction,
} from "./darwin-script"

export const DARWIN_OBSERVE_TIMEOUT_MS = 45000
export const DARWIN_SCRIPT_TIMEOUT_MS = 10000
// The native walk stops itself at timeBudgetMs; the execFile kill must stay
// above budget + margin or every native snapshot dies mid-walk and silently
// falls back to the much slower JXA script.
export const DARWIN_NATIVE_SNAPSHOT_BUDGET_MS = 15000
export const DARWIN_NATIVE_SNAPSHOT_TIMEOUT_MS = DARWIN_NATIVE_SNAPSHOT_BUDGET_MS + 5000
const PROBE_TTL_MS = 30000
const DEFAULT_MAX_ELEMENTS = 1000
const DEFAULT_WAIT_TIMEOUT_MS = 5000
const DEFAULT_WAIT_POLL_MS = 200
const MIN_WAIT_POLL_MS = 50

export interface CuaRunResult {
  stdout: string
  stderr: string
}

export type DarwinRunner = (
  script: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<CuaRunResult>

export function defaultDarwinRunner(
  script: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<CuaRunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", script, ...args],
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

export interface DarwinBackendTarget {
  pid: number
  path: number[]
}

export function parseDarwinBackendRef(backendRef: string): DarwinBackendTarget | undefined {
  const match = backendRef.match(/^mac:(\d+):([\d.]+)$/)
  if (match === null || match[1] === undefined || match[2] === undefined) return undefined
  const path = match[2]
    .split(".")
    .map((part) => Number(part))
    .filter((part) => Number.isInteger(part) && part >= 0)
  if (path.length === 0) return undefined
  return { pid: Number(match[1]), path }
}

const ROLE_ALIASES: Record<string, string> = {
  axbutton: "button",
  axcheckbox: "checkbox",
  axradiobutton: "radio",
  axtextfield: "textbox",
  axtextarea: "textbox",
  axsearchfield: "searchbox",
  axstatictext: "text",
  axwindow: "window",
  axsheet: "dialog",
  axdialog: "dialog",
  axmenubar: "menubar",
  axmenu: "menu",
  axmenuitem: "menuitem",
  axmenubutton: "button",
  axpopupbutton: "combobox",
  axcombobox: "combobox",
  axlist: "list",
  axlistbox: "list",
  axrow: "row",
  axcell: "cell",
  axtable: "table",
  axoutline: "tree",
  axslider: "slider",
  axscrollbar: "scrollbar",
  axprogressindicator: "progressbar",
  aximage: "img",
  axlink: "link",
  axtabgroup: "tablist",
  axtabs: "tablist",
  axradiogroup: "group",
  axtoolbar: "toolbar",
  axgroup: "group",
  axscrollarea: "region",
  axsplitgroup: "group",
  axwebarea: "document",
  axheading: "heading",
  axincrementor: "spinbutton",
  axspinner: "spinbutton",
  axapplication: "application",
  axlayoutarea: "group",
  axlayoutitem: "generic",
  axhelp: "tooltip",
  axvalueindicator: "progressbar",
  axbusyindicator: "progressbar",
  axdisclosuretriangle: "button",
  axportal: "window",
}

export function canonicalDarwinRole(role: string): string {
  const normalized = role.trim().toLowerCase().replaceAll(" ", "").replaceAll("_", "")
  const alias = ROLE_ALIASES[normalized]
  if (alias !== undefined) return alias
  const stripped = normalized.replace(/^ax/, "")
  return ROLES.find((candidate) => candidate === stripped) ?? "generic"
}

const ACTION_ALIASES: Record<string, readonly string[]> = {
  click: ["axpress", "press", "axconfirm", "confirm", "axopen", "open", "axpick", "pick", "axclick"],
  select: ["axselect", "select"],
  expand: ["axexpand", "expand"],
  collapse: ["axcollapse", "collapse"],
  increment: ["axincrement", "increment", "axincrease", "increase"],
  decrement: ["axdecrement", "decrement", "axdecrease", "decrease"],
  show_menu: ["axshowmenu", "show menu", "menu", "popup", "pop up"],
  focus: ["axfocus", "focus"],
  scroll_into_view: ["axscrolltovisible", "scrolltovisible", "scroll to visible"],
  close: ["axclose", "close"],
  cancel: ["axcancel", "cancel"],
}

export interface DarwinActionInput {
  actions?: readonly string[]
  editable?: boolean
  valuePresent?: boolean
}

export function canonicalDarwinActions(input: DarwinActionInput = {}): string[] {
  const raw = new Set((input.actions ?? []).map((action) => action.trim().toLowerCase()))
  const has = (canonical: string) => (ACTION_ALIASES[canonical] ?? []).some((alias) => raw.has(alias))
  const candidates: Array<[string, boolean]> = [
    ["click", has("click")],
    ["set_value", input.editable === true || input.valuePresent === true],
    ["focus", has("focus") || input.editable === true || input.valuePresent === true],
    ["select", has("select")],
    ["expand", has("expand")],
    ["collapse", has("collapse")],
    ["increment", has("increment") || input.valuePresent === true],
    ["decrement", has("decrement") || input.valuePresent === true],
    ["scroll_into_view", has("scroll_into_view")],
    ["show_menu", has("show_menu")],
  ]
  return candidates.flatMap(([name, available]) => (available ? [name] : []))
}

export function rawDarwinActions(element: Pick<CuaElement, "attributes">): string[] {
  const raw = element.attributes?.axActions
  if (typeof raw !== "string" || raw.length === 0) return []
  return raw
    .split(",")
    .map((action) => action.trim())
    .filter((action) => action.length > 0)
}

export function chooseDarwinAction(
  requested: string | undefined,
  element: Pick<CuaElement, "actions" | "attributes">,
): string | undefined {
  const rawActions = rawDarwinActions(element)
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
  if (ACTION_ALIASES[requestedLower] !== undefined) {
    const aliases = ACTION_ALIASES[requestedLower]
    const match = rawActions.find((raw) => aliases.includes(raw.toLowerCase()))
    if (match !== undefined) return match
  }
  return rawActions.find((raw) => raw.toLowerCase().replace(/^ax/, "") === requestedLower.replace(/^ax/, ""))
}

function normalizeBounds(bounds: { x: number; y: number; width: number; height: number } | undefined) {
  if (bounds === undefined || bounds.width <= 0 || bounds.height <= 0) return undefined
  return bounds
}

function buildAttributes(node: DarwinElementSnapshot): Record<string, string | number | boolean> {
  const attributes: Record<string, string | number | boolean> = { axRole: node.role }
  if (typeof node.subrole === "string" && node.subrole.length > 0) attributes.axSubrole = node.subrole
  if (node.actions.length > 0) attributes.axActions = node.actions.join(", ")
  if (typeof node.value === "string" && node.value.length > 0) attributes.value = node.value
  if (typeof node.minValue === "number") attributes.min = node.minValue
  if (typeof node.maxValue === "number") attributes.max = node.maxValue
  if (typeof node.stepValue === "number") attributes.step = node.stepValue
  if (typeof node.placeholder === "string" && node.placeholder.length > 0) attributes.placeholder = node.placeholder
  return attributes
}

export interface DarwinSnapshotBuildInput {
  generation: number
  takenAt: number
  applications: readonly DarwinApplicationSnapshot[]
  screen?: { width: number; height: number }
  maxElements: number
  requestedApp?: string
  helperTruncated?: boolean
  warnings?: readonly string[]
}

interface ElementBuildInput {
  generation: number
  pid: number
  node: DarwinElementSnapshot
  window: CuaWindow
  path: readonly number[]
  parentRef: string | undefined
  elementOccurrences: Map<string, number>
}

function addElement(elements: CuaElement[], input: ElementBuildInput): void {
  const role = canonicalDarwinRole(input.node.role)
  const name = input.node.name ?? ""
  const key = `${input.window.ref}|${role}|${slugify(name)}`
  const occurrence = input.elementOccurrences.get(key) ?? 0
  input.elementOccurrences.set(key, occurrence + 1)
  const bounds = normalizeBounds(input.node.bounds)
  const editable = input.node.editable || input.node.states.includes("editable")
  const element: CuaElement = {
    ref: buildElementRef(input.window.ref, role, name, occurrence),
    backendRef: `mac:${input.pid}:${input.path.join(".")}`,
    role,
    name,
    enabled: !input.node.states.includes("disabled"),
    focused: input.node.states.includes("focused"),
    editable,
    actions: canonicalDarwinActions({
      actions: input.node.actions,
      editable,
      valuePresent: input.node.valuePresent,
    }),
    states: input.node.states,
    attributes: buildAttributes(input.node),
    generation: input.generation,
    windowRef: input.window.ref,
    ...(input.parentRef === undefined ? {} : { parentRef: input.parentRef }),
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
      path: [...input.path, child.index],
      parentRef: element.ref,
    })
  }
}

// The observe script reports each application with its top-level windows as
// direct children. Every window becomes a CuaWindow and also a CuaElement so
// that window-scoped refs exist for every element and window actions have a ref.
export function buildDarwinSnapshot(input: DarwinSnapshotBuildInput): CuaSnapshot {
  const windows: CuaWindow[] = []
  const elements: CuaElement[] = []
  const warnings = [...(input.warnings ?? [])]
  const windowOccurrences = new Map<string, number>()
  const elementOccurrences = new Map<string, number>()
  const appFilter = input.requestedApp?.toLowerCase()

  for (const application of input.applications) {
    const appName = application.name ?? "unknown"
    if (application.error !== undefined) {
      warnings.push(`Application ${appName} could not be read: ${application.error}`)
      continue
    }
    if (appFilter !== undefined && !appName.toLowerCase().includes(appFilter)) continue
    const pid = application.pid ?? -1
    for (const node of application.nodes) {
      const title = node.name ?? appName
      const occurrenceKey = `${appName}|${title}`
      const occurrence = windowOccurrences.get(occurrenceKey) ?? 0
      windowOccurrences.set(occurrenceKey, occurrence + 1)
      const bounds = normalizeBounds(node.bounds)
      const window: CuaWindow = {
        ref: buildWindowRef(appName, title, occurrence),
        backendRef: `mac:${pid}:${node.index}`,
        app: appName,
        title,
        focused: node.states.includes("focused"),
        generation: input.generation,
        ...(node.states.includes("minimized") ? { minimized: true } : {}),
        ...(bounds === undefined ? {} : { bounds }),
      }
      windows.push(window)
      addElement(elements, {
        generation: input.generation,
        pid,
        node,
        window,
        path: [node.index],
        parentRef: undefined,
        elementOccurrences,
      })
    }
  }

  if (input.requestedApp !== undefined && windows.length === 0) {
    warnings.push(`No application matched "${input.requestedApp}"; no elements are available for this snapshot.`)
  }
  return limitSnapshot(
    {
      id: `cap-${input.generation}`,
      generation: input.generation,
      takenAt: input.takenAt,
      platform: "darwin",
      windows,
      elements,
      ...(input.screen === undefined ? {} : { screen: input.screen }),
      truncated: input.helperTruncated === true,
      warnings,
    },
    input.maxElements,
  )
}

export function matchesWaitCondition(element: CuaElement, condition: CuaWaitCondition): boolean {
  if (condition.ref !== undefined && element.ref !== condition.ref) return false
  if (condition.role !== undefined && element.role !== canonicalDarwinRole(condition.role)) return false
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

function pointInBounds(point: { x: number; y: number }, bounds: { width: number; height: number }): boolean {
  return point.x >= 0 && point.y >= 0 && point.x < bounds.width && point.y < bounds.height
}

export interface DarwinCuaBackendOptions {
  runner?: DarwinRunner
  maxElements?: number
  allowForeground?: boolean
  nativeHelper?: string
}

interface RefResolution {
  element: CuaElement
  live: DarwinResolvedPayload
  pid: number
  path: number[]
}

interface WindowResolution {
  window: CuaWindow
  live: DarwinResolvedPayload
  pid: number
  windowIndex: number
}

function isRefResolution(value: RefResolution | CuaActionResult): value is RefResolution {
  return "element" in value
}

function isWindowResolution(value: WindowResolution | CuaActionResult): value is WindowResolution {
  return "window" in value
}

const BUTTONS = { left: "left", right: "right", middle: "middle" } as const

class DarwinCuaBackend implements CuaBackend {
  readonly platform: CuaPlatform = "darwin"
  readonly name = "cua-darwin"
  private readonly maxElements: number
  private readonly allowForeground: boolean
  private readonly runner: DarwinRunner
  private readonly nativeHelper: string | undefined
  private nativeHelperPromise: Promise<string | undefined> | undefined
  private readonly injectedRunner: boolean
  private generation = 0
  private latest: CuaSnapshot | undefined
  private latestCaptureId: string | undefined
  private probeStatus: { ok: boolean; error?: string } | undefined
  private probePending: Promise<{ ok: boolean; error?: string }> | undefined
  private probeCheckedAt = 0

  constructor(options: DarwinCuaBackendOptions = {}) {
    this.maxElements = options.maxElements ?? DEFAULT_MAX_ELEMENTS
    this.allowForeground = options.allowForeground === true
    this.runner = options.runner ?? defaultDarwinRunner
    this.injectedRunner = options.runner !== undefined
    this.nativeHelper = options.nativeHelper
  }

  async available(): Promise<boolean> {
    if (process.platform !== "darwin" && !this.injectedRunner) return false
    const probe = await this.probe()
    return probe.ok
  }

  async capabilities(): Promise<CuaCapabilities> {
    const probe = await this.probe()
    const ax = probe.ok
    const limits: string[] = []
    if (!ax) {
      limits.push(
        probe.error ??
          "macOS accessibility access is unavailable; grant Omnia permission in System Settings > Privacy & Security > Accessibility.",
      )
    }
    limits.push("requires Accessibility permission for snapshots, semantic actions, and input")
    limits.push("requires Screen Recording permission for screenshots")
    limits.push("background actions never move the pointer; foreground pointer and keyboard fallback is opt-in")
    limits.push("TCC-protected windows may refuse Accessibility actions")
    return {
      snapshot: ax,
      semanticActions: ax,
      backgroundActions: ax,
      backgroundInput: false,
      pointer: ax,
      keyboard: ax,
      clipboard: false,
      screenshot: existsSync("/usr/sbin/screencapture"),
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

  async snapshot(options: CuaSnapshotOptions = {}): Promise<CuaSnapshot> {
    this.generation += 1
    const generation = this.generation
    const takenAt = Date.now()
    const maxElements = options.maxElements ?? this.maxElements
    const native = await this.runNative(
      "snapshot",
      {
        maxElements: Math.max(400, maxElements * 2),
        maxDepth: DARWIN_MAX_DEPTH,
        timeBudgetMs: DARWIN_NATIVE_SNAPSHOT_BUDGET_MS,
        ...(options.app === undefined ? {} : { app: options.app }),
      },
      DARWIN_NATIVE_SNAPSHOT_TIMEOUT_MS,
    )
    const raw = this.nativeFailed(native)
      ? await this.runScript(
          darwinObserveScript({
            ...(options.app === undefined ? {} : { app: options.app }),
            maxElements: Math.max(400, maxElements * 2),
            maxDepth: DARWIN_MAX_DEPTH,
            timeBudgetMs: 20000,
          }),
          DARWIN_OBSERVE_TIMEOUT_MS,
        )
      : native
    const payload = parseDarwinSnapshotPayload(raw)
    const permission = isRecord(raw) && typeof raw.message === "string" ? raw.message : undefined
    const warnings =
      payload === undefined
        ? [
            permission ??
              "The macOS accessibility script did not return a snapshot; grant Accessibility permission and retry.",
          ]
        : []
    const built = buildDarwinSnapshot({
      generation,
      takenAt,
      applications: payload?.applications ?? [],
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
    const role = query.role === undefined || query.role.length === 0 ? undefined : canonicalDarwinRole(query.role)
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
    const timeoutMs = condition.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS
    const pollMs = Math.max(MIN_WAIT_POLL_MS, condition.pollMs ?? DEFAULT_WAIT_POLL_MS)
    let confirm = false
    let matched: CuaElement | undefined
    while (true) {
      const snapshot = await this.snapshot()
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
      if (Date.now() - started + pollMs > timeoutMs) break
      await delay(pollMs)
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

  // System Events is far too slow for tree walks, so a compiled AX helper is
  // preferred whenever swiftc is available; the JXA scripts stay as fallback.
  private ensureAxHelper(): Promise<string | undefined> {
    if (this.nativeHelper !== undefined) return Promise.resolve(this.nativeHelper)
    if (process.platform !== "darwin") return Promise.resolve(undefined)
    if (this.nativeHelperPromise === undefined) {
      this.nativeHelperPromise = (async () => {
        const bundled =
          process.env.OMNIA_AX_HELPER ??
          ((process as { resourcesPath?: string }).resourcesPath === undefined
            ? undefined
            : join((process as { resourcesPath?: string }).resourcesPath!, "mac", "ax-helper"))
        if (bundled !== undefined && existsSync(bundled)) return bundled
        const dir = join(homedir(), ".omnia", "bin")
        const binary = join(dir, "ax-helper")
        const source = join(dir, "ax-helper.swift")
        const temporary = `${binary}.tmp-${process.pid}`
        try {
          mkdirSync(dir, { recursive: true })
          const current = existsSync(binary) && existsSync(source) ? statSync(binary).mtimeMs >= statSync(source).mtimeMs : false
          if (current) return binary
          writeFileSync(source, DARWIN_AX_HELPER)
          await new Promise<void>((resolve, reject) => {
            execFile(
              "/usr/bin/swiftc",
              ["-O", source, "-o", temporary],
              { timeout: 180000, maxBuffer: 8 * 1024 * 1024 },
              (error) => (error ? reject(error) : resolve()),
            )
          })
          // Compile to a process-unique path and rename atomically: two Omnia
          // processes compiling at once must never execute a half-written
          // binary or race each other's output.
          chmodSync(temporary, 0o755)
          renameSync(temporary, binary)
          return binary
        } catch {
          rmSync(temporary, { force: true })
          return undefined
        }
      })()
    }
    return this.nativeHelperPromise
  }

  private async runNative(
    command: string,
    params: Record<string, unknown>,
    timeoutMs = DARWIN_SCRIPT_TIMEOUT_MS,
  ): Promise<unknown> {
    const helper = await this.ensureAxHelper()
    if (helper === undefined) return undefined
    const stdout = await new Promise<string | undefined>((resolve) => {
      execFile(
        helper,
        [command, JSON.stringify(params)],
        { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
        (error, out) => resolve(error ? undefined : String(out)),
      )
    })
    if (stdout === undefined) return undefined
    return parseDarwinScriptOutput(stdout)
  }

  // A native helper that ran but returned {ok:false} is a structured failure;
  // the JXA fallback must still run, otherwise it is unreachable exactly when
  // the helper is present but cannot complete the command.
  private nativeFailed(raw: unknown): boolean {
    return raw === undefined || (isRecord(raw) && raw.ok !== true)
  }

  private async resolveTarget(pid: number, path: readonly number[]): Promise<unknown> {
    const native = await this.runNative("resolve", { pid, path: [...path] })
    if (!this.nativeFailed(native)) return native
    return this.runScript(darwinResolveScript(pid, path), DARWIN_SCRIPT_TIMEOUT_MS)
  }

  private async performTarget(pid: number, path: readonly number[], action: string): Promise<unknown> {
    const native = await this.runNative("act", { pid, path: [...path], action })
    if (!this.nativeFailed(native)) return native
    return this.runScript(darwinActionScript(pid, path, action), DARWIN_SCRIPT_TIMEOUT_MS)
  }

  private async setValueTarget(pid: number, path: readonly number[], value: string): Promise<unknown> {
    const native = await this.runNative("setvalue", { pid, path: [...path], value })
    if (!this.nativeFailed(native)) return native
    return this.runScript(darwinSetValueScript(pid, path, value), DARWIN_SCRIPT_TIMEOUT_MS)
  }

  private async focusTarget(pid: number, path: readonly number[]): Promise<unknown> {
    const native = await this.runNative("focus", { pid, path: [...path] })
    if (!this.nativeFailed(native)) return native
    return this.runScript(darwinFocusScript(pid, path), DARWIN_SCRIPT_TIMEOUT_MS)
  }

  private async runScript(script: string, timeoutMs: number): Promise<unknown> {
    const result = await this.runner(script, [], timeoutMs).catch(() => undefined)
    if (result === undefined) return undefined
    return parseDarwinScriptOutput(result.stdout)
  }

  private probe(): Promise<{ ok: boolean; error?: string }> {
    // Permission grants happen in System Settings while Omnia runs; a cached
    // denial must expire so the backend recovers without a restart.
    if (this.probeStatus !== undefined && Date.now() - this.probeCheckedAt < PROBE_TTL_MS) {
      return Promise.resolve(this.probeStatus)
    }
    if (this.probePending === undefined) {
      this.probePending = this.runScript(DARWIN_PROBE_SCRIPT, DARWIN_SCRIPT_TIMEOUT_MS)
        .then((raw) => {
          const status =
            isRecord(raw) && raw.ok === true
              ? { ok: true }
              : {
                  ok: false,
                  error:
                    (isRecord(raw) && typeof raw.error === "string" ? raw.error : undefined) ??
                    "macOS accessibility access is unavailable; grant Omnia permission in System Settings > Privacy & Security > Accessibility.",
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
    const element = source.elements.find((candidate) => candidate.ref === ref)
    if (element === undefined) return refuse(action, "stale_ref", `Unknown element ref: ${ref}`, generation)
    if (!(await this.probe()).ok) {
      return refuse(action, "backend_unavailable", "macOS accessibility access is not available.", generation)
    }
    const target = parseDarwinBackendRef(element.backendRef)
    if (target === undefined) {
      return refuse(action, "target_unreachable", `The element at ${ref} has no resolvable macOS identity.`, generation)
    }
    const raw = await this.resolveTarget(target.pid, target.path)
    const live = parseDarwinResolvedPayload(raw)
    if (live === undefined) {
      return refuse(action, "target_unreachable", `The element at ${ref} could not be resolved.`, generation)
    }
    if (canonicalDarwinRole(live.role) !== element.role || (live.name ?? "") !== element.name) {
      return refuse(
        action,
        "target_mismatch",
        `The element at ${ref} no longer matches role "${element.role}" and name "${element.name}".`,
        generation,
      )
    }
    return { element, live, pid: target.pid, path: target.path }
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
    const window = source.windows.find((candidate) => candidate.ref === ref)
    if (window === undefined) return refuse(action, "stale_ref", `Unknown window ref: ${ref}`, generation)
    if (!(await this.probe()).ok) {
      return refuse(action, "backend_unavailable", "macOS accessibility access is not available.", generation)
    }
    const target = parseDarwinBackendRef(window.backendRef)
    if (target === undefined) {
      return refuse(action, "target_unreachable", `The window at ${ref} has no resolvable macOS identity.`, generation)
    }
    const raw = await this.resolveTarget(target.pid, target.path)
    const live = parseDarwinResolvedPayload(raw)
    if (live === undefined) {
      return refuse(action, "target_unreachable", `The window at ${ref} could not be resolved.`, generation)
    }
    if ((live.name ?? "") !== window.title) {
      return refuse(action, "target_mismatch", `The window at ${ref} no longer matches "${window.title}".`, generation)
    }
    return { window, live, pid: target.pid, windowIndex: target.path[0] ?? 0 }
  }

  private async attemptAction(
    action: CuaAction & { ref: string },
    rawAction: string,
    snapshot: CuaSnapshot | undefined,
    generation: number,
  ): Promise<{ result: CuaActionResult } | { resolved: RefResolution; error: string }> {
    const resolved = await this.expectElement(action.ref, action, snapshot, generation)
    if (!isRefResolution(resolved)) return { result: resolved }
const raw = await this.performTarget(resolved.pid, resolved.path, rawAction)
    const result = parseDarwinResultPayload(raw)
    if (result?.ok === true) {
      return {
        result: success(action, "background-ax", `Ran ${rawAction} on ${action.ref}.`, generation, true),
      }
    }
    return { resolved, error: result?.error ?? `${rawAction} failed.` }
  }

  private async keyboardOnElement(
    element: CuaElement,
    keys: string,
    action: CuaAction,
    generation: number,
  ): Promise<CuaActionResult | undefined> {
    const target = parseDarwinBackendRef(element.backendRef)
    if (target === undefined) return undefined
    if (!element.focused) {
      if (!this.allowForeground) return undefined
      const focused = parseDarwinResultPayload(
        await this.focusTarget(target.pid, target.path),
      )
      if (focused?.ok !== true) return undefined
    }
    const script = darwinKeyScript(keys)
    if (script === undefined) return undefined
    const sent = parseDarwinResultPayload(await this.runScript(script, DARWIN_SCRIPT_TIMEOUT_MS))
    if (sent?.ok !== true) return undefined
    return success(action, "keyboard", `Sent ${keys} to the focused element.`, generation, false)
  }

  private async executeSemantic(
    rawAction: string,
    action: CuaAction & { ref: string },
    snapshot: CuaSnapshot | undefined,
    generation: number,
  ): Promise<CuaActionResult> {
    const attempt = await this.attemptAction(action, rawAction, snapshot, generation)
    if ("result" in attempt) return attempt.result
    return refuse(action, "action_failed", attempt.error, generation, true)
  }

  private async executePointerFallback(
    action: CuaAction & { ref: string },
    snapshot: CuaSnapshot | undefined,
    generation: number,
  ): Promise<CuaActionResult> {
    const resolved = await this.expectElement(action.ref, action, snapshot, generation)
    if (!isRefResolution(resolved)) return resolved
    const bounds = normalizeBounds(resolved.live.bounds)
    if (bounds === undefined) {
      return refuse(action, "action_unavailable", `The element at ${action.ref} has no bounds to click.`, generation)
    }
    if (!this.allowForeground) {
      return refuse(
        action,
        "background_unavailable",
        `No accessibility action exists for ${action.type} on ${action.ref}; a pointer fallback would steal focus.`,
        generation,
      )
    }
    const point = { x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 2) }
    const output = parseDarwinResultPayload(
      await this.runScript(darwinClickScript(point, "left", 1), DARWIN_SCRIPT_TIMEOUT_MS),
    )
    if (output?.ok !== true) return refuse(action, "input_failed", "The pointer fallback failed.", generation, true)
    return success(action, "pointer", `Clicked ${action.ref} at its center.`, generation, false)
  }

  private async executeValueStep(
    delta: 1 | -1,
    key: string,
    action: CuaAction & { ref: string },
    snapshot: CuaSnapshot | undefined,
    generation: number,
  ): Promise<CuaActionResult> {
    const resolved = await this.expectElement(action.ref, action, snapshot, generation)
    if (!isRefResolution(resolved)) return resolved
    const raw = await this.runScript(
      darwinValueStepScript(resolved.pid, resolved.path, delta),
      DARWIN_SCRIPT_TIMEOUT_MS,
    )
    const result = parseDarwinResultPayload(raw)
    if (result?.ok === true) {
      return success(
        action,
        "background-ax",
        `${delta > 0 ? "Incremented" : "Decremented"} ${action.ref}.`,
        generation,
        true,
      )
    }
    const fallback = await this.keyboardOnElement(resolved.element, key, action, generation)
    if (fallback !== undefined) return fallback
    return refuse(
      action,
      "background_unavailable",
      `${action.type} needs a focused element for the keyboard fallback; ${result?.error ?? "no value action"}`,
      generation,
    )
  }

  private async executeShowMenu(
    action: CuaAction & { ref: string },
    snapshot: CuaSnapshot | undefined,
    generation: number,
  ): Promise<CuaActionResult> {
    const attempt = await this.attemptAction(action, "AXShowMenu", snapshot, generation)
    if ("result" in attempt) return attempt.result
    const fallback = await this.keyboardOnElement(attempt.resolved.element, "shift+F10", action, generation)
    if (fallback !== undefined) return fallback
    return refuse(
      action,
      "background_unavailable",
      `show_menu needs a focused element for the keyboard fallback; ${attempt.error}`,
      generation,
    )
  }

  private async executeInvoke(
    action: Extract<CuaAction, { type: "invoke" }>,
    snapshot: CuaSnapshot | undefined,
    generation: number,
  ): Promise<CuaActionResult> {
    const resolved = await this.expectElement(action.ref, action, snapshot, generation)
    if (!isRefResolution(resolved)) return resolved
    const rawAction = chooseDarwinAction(action.action, resolved.element)
    if (rawAction === undefined) {
      if (action.action === undefined || action.action.trim().length === 0) {
        return this.executePointerFallback(action, snapshot, generation)
      }
      return refuse(
        action,
        "action_unavailable",
        `The element at ${action.ref} does not expose an accessibility action for "${action.action}".`,
        generation,
      )
    }
    return this.executeSemantic(rawAction, action, snapshot, generation)
  }

  private async executeSetValue(
    action: Extract<CuaAction, { type: "set_value" }>,
    snapshot: CuaSnapshot | undefined,
    generation: number,
  ): Promise<CuaActionResult> {
    const resolved = await this.expectElement(action.ref, action, snapshot, generation)
    if (!isRefResolution(resolved)) return resolved
    const raw = await this.runScript(
      darwinSetValueScript(resolved.pid, resolved.path, action.value),
      DARWIN_SCRIPT_TIMEOUT_MS,
    )
    const result = parseDarwinResultPayload(raw)
    if (result?.ok === true) {
      return success(action, "background-ax", `Set the value of ${action.ref} in the background.`, generation, true)
    }
    if (!this.allowForeground) {
      return refuse(
        action,
        "background_unavailable",
        result?.error ?? "Background set-value is not supported by this element.",
        generation,
      )
    }
    const focused = parseDarwinResultPayload(
      await this.focusTarget(resolved.pid, resolved.path),
    )
    if (focused?.ok !== true) {
      return refuse(action, "focus_failed", focused?.error ?? "Focusing the element failed.", generation, true)
    }
    const retry = parseDarwinResultPayload(
      await this.setValueTarget(resolved.pid, resolved.path, action.value),
    )
    if (retry?.ok === true) {
      return success(action, "foreground-ax", `Focused then set the value of ${action.ref}.`, generation, true)
    }
    return refuse(action, "set_value_failed", retry?.error ?? "Set-value failed after focusing.", generation, true)
  }

  private async executeFocus(
    action: Extract<CuaAction, { type: "focus" }>,
    snapshot: CuaSnapshot | undefined,
    generation: number,
  ): Promise<CuaActionResult> {
    const resolved = await this.expectElement(action.ref, action, snapshot, generation)
    if (!isRefResolution(resolved)) return resolved
    const result = parseDarwinResultPayload(
      await this.focusTarget(resolved.pid, resolved.path),
    )
    if (result?.ok !== true) {
      return refuse(action, "focus_failed", result?.error ?? "Focusing the element failed.", generation, true)
    }
    return success(action, "foreground-ax", `Focused ${action.ref}.`, generation, true)
  }

  private async executeScrollIntoView(
    action: Extract<CuaAction, { type: "scroll_into_view" }>,
    snapshot: CuaSnapshot | undefined,
    generation: number,
  ): Promise<CuaActionResult> {
    const resolved = await this.expectElement(action.ref, action, snapshot, generation)
    if (!isRefResolution(resolved)) return resolved
    const rawAction = chooseDarwinAction("scroll_into_view", resolved.element)
    if (rawAction === undefined) {
      return refuse(
        action,
        "action_unavailable",
        `The element at ${action.ref} does not expose AXScrollToVisible.`,
        generation,
      )
    }
    return this.executeSemantic(rawAction, action, snapshot, generation)
  }

  private async executeSelect(
    action: Extract<CuaAction, { type: "select" }>,
    snapshot: CuaSnapshot | undefined,
    generation: number,
  ): Promise<CuaActionResult> {
    const resolved = await this.expectElement(action.ref, action, snapshot, generation)
    if (!isRefResolution(resolved)) return resolved
    const rawAction = chooseDarwinAction("select", resolved.element)
    if (rawAction === undefined) return this.executePointerFallback(action, snapshot, generation)
    return this.executeSemantic(rawAction, action, snapshot, generation)
  }

  private async executeExpandCollapse(
    action: Extract<CuaAction, { type: "expand" | "collapse" }>,
    snapshot: CuaSnapshot | undefined,
    generation: number,
  ): Promise<CuaActionResult> {
    const resolved = await this.expectElement(action.ref, action, snapshot, generation)
    if (!isRefResolution(resolved)) return resolved
    if (action.type === "expand" && resolved.live.states.includes("expanded")) {
      return success(action, "background-ax", `${action.ref} is already expanded.`, generation, true)
    }
    if (action.type === "collapse" && resolved.live.states.includes("collapsed")) {
      return success(action, "background-ax", `${action.ref} is already collapsed.`, generation, true)
    }
    const rawAction = chooseDarwinAction(action.type, resolved.element)
    if (rawAction === undefined) return this.executePointerFallback(action, snapshot, generation)
    return this.executeSemantic(rawAction, action, snapshot, generation)
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
    const button = BUTTONS[action.button ?? "left"]
    const count = Math.max(1, action.count ?? 1)
    const output = parseDarwinResultPayload(
      await this.runScript(darwinClickScript(action.point, button, count), DARWIN_SCRIPT_TIMEOUT_MS),
    )
    if (output?.ok !== true) return refuse(action, "input_failed", "The macOS pointer click failed.", generation, true)
    this.consumeCapture(action.captureId)
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
    const output = parseDarwinResultPayload(
      await this.runScript(darwinDragScript(action.from, action.to), DARWIN_SCRIPT_TIMEOUT_MS),
    )
    if (output?.ok !== true) return refuse(action, "input_failed", "The macOS pointer drag failed.", generation, true)
    this.consumeCapture(action.captureId)
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
    if (point !== undefined) {
      const bounds = this.latest?.screen
      if (bounds !== undefined && !pointInBounds(point, bounds)) {
        return refuse(action, "invalid_point", "The scroll target is outside the screen.", generation)
      }
    }
    const output = parseDarwinResultPayload(
      await this.runScript(darwinScrollScript(action.direction, amount, point), DARWIN_SCRIPT_TIMEOUT_MS),
    )
    if (output?.ok !== true) return refuse(action, "input_failed", "The macOS scroll failed.", generation, true)
    return success(action, "pointer", `Scrolled ${action.direction}.`, generation, false)
  }

  private async executeType(
    action: Extract<CuaAction, { type: "type" }>,
    snapshot: CuaSnapshot | undefined,
    generation: number,
  ): Promise<CuaActionResult> {
    if (action.text.length === 0) return success(action, "keyboard", "Nothing to type.", generation, true)
    if (action.ref !== undefined) {
      const resolved = await this.expectElement(action.ref, action, snapshot, generation)
      if (!isRefResolution(resolved)) return resolved
      const editable = resolved.element.editable || resolved.element.actions.includes("set_value")
      if (editable) {
        const raw = await this.runScript(
          darwinSetValueScript(resolved.pid, resolved.path, action.text),
          DARWIN_SCRIPT_TIMEOUT_MS,
        )
        const result = parseDarwinResultPayload(raw)
        if (result?.ok === true) {
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
            result?.error ?? "Background text input is not supported by this element.",
            generation,
          )
        }
      } else if (!this.allowForeground) {
        return refuse(
          action,
          "background_unavailable",
          "Typing into this element needs focus; enable the foreground fallback or type without a ref.",
          generation,
        )
      }
      const focused = parseDarwinResultPayload(
        await this.focusTarget(resolved.pid, resolved.path),
      )
      if (focused?.ok !== true) {
        return refuse(action, "focus_failed", focused?.error ?? "Focusing the element failed.", generation, true)
      }
    }
    const output = parseDarwinResultPayload(
      await this.runScript(darwinTypeScript(action.text), DARWIN_SCRIPT_TIMEOUT_MS),
    )
    if (output?.ok !== true) return refuse(action, "input_failed", "The macOS typing failed.", generation, true)
    return success(action, "keyboard", `Typed ${action.text.length} characters.`, generation, false)
  }

  private async executeKey(
    action: Extract<CuaAction, { type: "key" }>,
    generation: number,
  ): Promise<CuaActionResult> {
    const keys = action.keys.map((key) => key.trim()).filter((key) => key.length > 0)
    if (keys.length === 0) return refuse(action, "invalid_action", "No keys were requested.", generation)
    const script = darwinKeyScript(keys.join("+"))
    if (script === undefined) {
      return refuse(action, "invalid_action", `Cannot map ${keys.join("+")} to macOS key codes.`, generation)
    }
    const output = parseDarwinResultPayload(await this.runScript(script, DARWIN_SCRIPT_TIMEOUT_MS))
    if (output?.ok !== true) return refuse(action, "input_failed", "The macOS key event failed.", generation, true)
    return success(action, "keyboard", `Sent ${keys.join("+")}.`, generation, false)
  }

  // Dismiss mirrors the legacy driver: press Escape to close the focused menu
  // or popup. The engine only verifies it when the follow-up snapshot shows a
  // real state change.
  private async executeDismiss(
    action: Extract<CuaAction, { type: "dismiss" }>,
    generation: number,
  ): Promise<CuaActionResult> {
    const script = darwinKeyScript("escape")
    if (script === undefined) {
      return refuse(action, "invalid_action", "Cannot map Escape to a macOS key code.", generation)
    }
    const output = parseDarwinResultPayload(await this.runScript(script, DARWIN_SCRIPT_TIMEOUT_MS))
    if (output?.ok !== true) return refuse(action, "input_failed", "The macOS Escape event failed.", generation, true)
    return success(action, "keyboard", "Pressed Escape to dismiss the focused transient surface.", generation, false)
  }

  private async executeWindow(
    action: Extract<CuaAction, { type: "window" }>,
    snapshot: CuaSnapshot | undefined,
    generation: number,
  ): Promise<CuaActionResult> {
    const resolved = await this.expectWindow(action.ref, action, snapshot, generation)
    if (!isWindowResolution(resolved)) return resolved
    const raw = await this.runScript(
      darwinWindowScript(resolved.pid, resolved.windowIndex, action.action as DarwinWindowAction),
      DARWIN_SCRIPT_TIMEOUT_MS,
    )
    const result = parseDarwinResultPayload(raw)
    if (result?.ok !== true) {
      return refuse(
        action,
        "window_action_unavailable",
        result?.error ?? `The window does not support ${action.action}.`,
        generation,
        true,
      )
    }
    const delivery: CuaDelivery = action.action === "focus" ? "foreground-ax" : "background-ax"
    return success(action, delivery, `Window ${action.action} completed.`, generation, true)
  }

  async execute(action: CuaAction, snapshot?: CuaSnapshot): Promise<CuaActionResult> {
    const generation = this.latest?.generation ?? snapshot?.generation ?? this.generation
    const probe = await this.probe()
    if (!probe.ok) {
      return refuse(action, "backend_unavailable", probe.error ?? "macOS accessibility access is not available.", generation)
    }
    switch (action.type) {
      case "invoke":
        return this.executeInvoke(action, snapshot, generation)
      case "set_value":
        return this.executeSetValue(action, snapshot, generation)
      case "focus":
        return this.executeFocus(action, snapshot, generation)
      case "scroll_into_view":
        return this.executeScrollIntoView(action, snapshot, generation)
      case "select":
        return this.executeSelect(action, snapshot, generation)
      case "expand":
      case "collapse":
        return this.executeExpandCollapse(action, snapshot, generation)
      case "increment":
        return this.executeValueStep(1, "Up", action, snapshot, generation)
      case "decrement":
        return this.executeValueStep(-1, "Down", action, snapshot, generation)
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

export function createDarwinCuaBackend(options: DarwinCuaBackendOptions = {}): CuaBackend {
  return new DarwinCuaBackend(options)
}

export function createDarwinBackend(): CuaBackend {
  return new DarwinCuaBackend()
}

export { DARWIN_OBSERVE_SCRIPT, darwinKeyBody }
