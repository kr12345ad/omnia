import { existsSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  ActionResult,
  ActionType,
  CapabilityState,
  CapabilitySupport,
  CommandRequest,
  CommandResult,
  ComputerAction,
  ComputerInfo,
  ElementReference,
  FindMatch,
  FindRequest,
  FindResult,
  Observation,
  State,
  UIElement,
} from "../protocol"
import { retrieveElements } from "../retrieval"
import type { HostDriver, HostRevalidation } from "./host-driver"
import { executeShellCommand, runProcess, runProcessWithInput, type ProcessResult } from "./process"

export const DARWIN_OBSERVE_TIMEOUT_MS = 45000
export const DARWIN_SCRIPT_TIMEOUT_MS = 20000
export const DARWIN_MAX_ELEMENTS = 600
export const DARWIN_MAX_DEPTH = 6

export const DARWIN_KEY_CODES: Record<string, number> = {
  return: 36,
  enter: 76,
  tab: 48,
  escape: 53,
  esc: 53,
  space: 49,
  delete: 51,
  backspace: 51,
  forwarddelete: 117,
  left: 123,
  right: 124,
  down: 125,
  up: 126,
  home: 115,
  end: 119,
  pageup: 116,
  pagedown: 121,
  f1: 122,
  f2: 120,
  f3: 99,
  f4: 118,
  f5: 96,
  f6: 97,
  f7: 98,
  f8: 100,
  f9: 101,
  f10: 109,
  f11: 103,
  f12: 111,
}

const DARWIN_MODIFIERS: Record<string, string> = {
  ctrl: "control down",
  control: "control down",
  cmd: "command down",
  command: "command down",
  meta: "command down",
  super: "command down",
  shift: "shift down",
  alt: "option down",
  option: "option down",
}

// JSON.stringify is valid JavaScript except for U+2028/U+2029, which are line
// terminators in JS source and would break generated osascript bodies.
function jsString(value: string): string {
  return JSON.stringify(value).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")
}

export function darwinKeyScript(keys: string): string | undefined {
  const parts = keys
    .split("+")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0)
  const modifiers: string[] = []
  let key: string | undefined
  for (const part of parts) {
    const modifier = DARWIN_MODIFIERS[part]
    if (modifier !== undefined) {
      modifiers.push(modifier)
      continue
    }
    key = part
  }
  if (key === undefined) return undefined
  const using = modifiers.length === 0 ? "" : `, { using: [${modifiers.map((item) => jsString(item)).join(", ")}] }`
  const code = DARWIN_KEY_CODES[key]
  if (code !== undefined) return `se.keyCode(${code}${using})`
  if ([...key].length === 1) return `se.keystroke(${jsString(key)}${using})`
  return undefined
}

export function mapDarwinRole(role: string): string {
  const key = role.replace(/^AX/, "").toLowerCase()
  const table: Record<string, string> = {
    button: "button",
    checkbox: "checkbox",
    radiobutton: "radio",
    textfield: "textbox",
    textarea: "textbox",
    statictext: "label",
    window: "window",
    sheet: "dialog",
    dialog: "dialog",
    menu: "menu",
    menubar: "menubar",
    menuitem: "menuitem",
    menuuitem: "menuitem",
    popupbutton: "combobox",
    combobox: "combobox",
    list: "list",
    row: "row",
    cell: "cell",
    table: "table",
    outline: "tree",
    slider: "slider",
    scrollbar: "scrollbar",
    progressindicator: "progressbar",
    image: "image",
    link: "link",
    tabgroup: "tablist",
    radiogroup: "radiogroup",
    toolbar: "toolbar",
    group: "group",
    scrollarea: "scrollpane",
    splitgroup: "splitpane",
    webarea: "document",
  }
  return table[key] ?? key
}

export function mapDarwinActions(actions: readonly string[]): ActionType[] {
  const table: Record<string, ActionType> = {
    axpress: "click",
    axconfirm: "click",
    axopen: "click",
    axpick: "click",
    axshowmenu: "rightclick",
    axincrement: "increment",
    axdecrement: "decrement",
    axsetvalue: "setvalue",
    axvaluechanged: "setvalue",
    axfocus: "focus",
    axclose: "close",
    axexpand: "expand",
    axcollapse: "collapse",
    axselect: "select",
    axcancel: "dismiss",
  }
  return actions.flatMap((action) => {
    const mapped = table[action.toLowerCase()]
    return mapped === undefined ? [] : [mapped]
  })
}

interface DarwinElementRecord {
  id?: unknown
  parentId?: unknown
  role?: unknown
  name?: unknown
  description?: unknown
  value?: unknown
  enabled?: unknown
  focused?: unknown
  selected?: unknown
  bounds?: unknown
  actions?: unknown
  app?: unknown
  pid?: unknown
  window?: unknown
}

export function toDarwinElement(record: DarwinElementRecord): UIElement | undefined {
  if (typeof record.id !== "string" || record.id.length === 0) return undefined
  const states: State[] = []
  if (record.focused === true) states.push("focused")
  if (record.selected === true) states.push("selected")
  if (record.enabled === false) states.push("disabled")
  const bounds =
    typeof record.bounds === "object" &&
    record.bounds !== null &&
    typeof (record.bounds as { x?: unknown }).x === "number"
      ? {
          x: Number((record.bounds as { x: number }).x),
          y: Number((record.bounds as { y: number }).y),
          width: Number((record.bounds as { width: number }).width),
          height: Number((record.bounds as { height: number }).height),
        }
      : undefined
  const value = typeof record.value === "string" || typeof record.value === "number" || typeof record.value === "boolean"
    ? record.value
    : undefined
  const actions = Array.isArray(record.actions)
    ? record.actions.filter((item): item is string => typeof item === "string")
    : []
  const mappedActions = mapDarwinActions(actions)
  return {
    id: record.id,
    ...(typeof record.parentId === "string" && record.parentId.length > 0 ? { parentId: record.parentId } : {}),
    ...(typeof record.role === "string" && record.role.length > 0 ? { role: mapDarwinRole(record.role) } : {}),
    ...(typeof record.name === "string" && record.name.length > 0 ? { name: record.name.slice(0, 300) } : {}),
    ...(typeof record.description === "string" && record.description.length > 0
      ? { description: record.description.slice(0, 300) }
      : {}),
    ...(value === undefined ? {} : { value }),
    ...(bounds === undefined ? {} : { bounds }),
    ...(states.length === 0 ? {} : { states }),
    ...(mappedActions.length === 0 ? {} : { actions: mappedActions }),
    source: "accessibility",
    metadata: {
      ...(typeof record.app === "string" ? { application: record.app } : {}),
      ...(typeof record.pid === "number" ? { pid: record.pid } : {}),
      ...(record.window === true ? { window: true } : {}),
      backend: "macos-ax",
    },
  }
}

export function parseDarwinObservation(text: string): { elements: UIElement[]; error?: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text.trim())
  } catch {
    return { elements: [], error: "The macOS accessibility script returned invalid JSON." }
  }
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    const record = parsed as { error?: unknown; message?: unknown }
    return {
      elements: [],
      error:
        typeof record.message === "string"
          ? record.message
          : "macOS accessibility access is unavailable; grant Omnia permission in System Settings > Privacy & Security > Accessibility.",
    }
  }
  if (!Array.isArray(parsed)) return { elements: [], error: "The macOS accessibility script returned no elements." }
  return {
    elements: parsed.flatMap((entry) => {
      const element = toDarwinElement((entry ?? {}) as DarwinElementRecord)
      return element === undefined ? [] : [element]
    }),
  }
}

function observeScript(application: string | undefined): string {
  return `
ObjC.import('Foundation')
ObjC.import('ApplicationServices')
function main() {
  try {
    if ($.AXIsProcessTrusted() !== true) {
      return JSON.stringify({ error: 'permission', message: 'macOS Accessibility permission is not granted for this app; enable it in System Settings > Privacy & Security > Accessibility and relaunch Omnia.' })
    }
  } catch (error) {}
  var se = Application('System Events')
  var filter = ${application === undefined ? "null" : jsString(application)}
  var out = []
  var count = 0
  var maxElements = ${DARWIN_MAX_ELEMENTS}
  var maxDepth = ${DARWIN_MAX_DEPTH}
  var processes = []
  try {
    processes = se.applicationProcesses()
  } catch (error) {
    return JSON.stringify({ error: 'permission', message: 'macOS accessibility access is unavailable; grant Omnia permission in System Settings > Privacy & Security > Accessibility.' })
  }
  for (var p = 0; p < processes.length; p++) {
    if (count >= maxElements) break
    var process = processes[p]
    var name = ''
    var pid = -1
    var frontmost = false
    var windows = []
    try { name = String(process.name() || '') } catch (error) { continue }
    if (filter !== null && name.toLowerCase().indexOf(String(filter).toLowerCase()) < 0) continue
    try { pid = Number(process.unixId()) } catch (error) { pid = -1 }
    try { frontmost = process.frontmost() === true } catch (error) { frontmost = false }
    try { windows = process.windows() } catch (error) { windows = [] }
    for (var w = 0; w < windows.length && count < maxElements; w++) {
      walk(windows[w], 'mac:' + pid + ':' + w, 'mac:' + pid + ':root', 0)
    }
  }
  function walk(element, id, parentId, depth) {
    if (depth > maxDepth || count >= maxElements) return
    count += 1
    var role = ''
    var title = ''
    var description = ''
    var value = null
    var position = null
    var size = null
    var enabled = true
    var focused = false
    var selected = false
    var actions = []
    try { role = String(element.role() || '') } catch (error) { role = '' }
    try { title = String(element.name() || '') } catch (error) { title = '' }
    try { description = String(element.description() || '') } catch (error) { description = '' }
    try { value = element.value() } catch (error) { value = null }
    try { position = element.position() } catch (error) { position = null }
    try { size = element.size() } catch (error) { size = null }
    try { enabled = element.enabled() !== false } catch (error) { enabled = true }
    try { focused = element.focused() === true } catch (error) { focused = false }
    try { selected = element.selected() === true } catch (error) { selected = false }
    try {
      actions = element.actions().map(function (action) {
        try { return String(action.name ? action.name() : action) } catch (error) { return '' }
      }).filter(function (item) { return item.length > 0 })
    } catch (error) { actions = [] }
    var bounds = null
    if (position && size && position.length >= 2 && size.length >= 2) {
      bounds = { x: Math.round(Number(position[0])), y: Math.round(Number(position[1])), width: Math.round(Number(size[0])), height: Math.round(Number(size[1])) }
    }
    out.push({
      id: id,
      parentId: parentId,
      role: role,
      name: title,
      description: description,
      value: (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') ? value : null,
      enabled: enabled,
      focused: focused,
      selected: selected,
      bounds: bounds,
      actions: actions,
      app: name,
      pid: pid,
      frontmost: frontmost,
      window: role === 'AXWindow',
    })
    var children = []
    try { children = element.uiElements() } catch (error) { children = [] }
    for (var i = 0; i < children.length; i++) {
      walk(children[i], id + '.' + i, id, depth + 1)
    }
  }
  return JSON.stringify(out)
}
main()
`
}

function elementBoundsScript(pid: number, path: string): string {
  return `
function main() {
  var se = Application('System Events')
  var processes = []
  try { processes = se.applicationProcesses.whose({ unixId: ${pid} })() } catch (error) { return JSON.stringify(null) }
  if (!processes || processes.length === 0) return JSON.stringify(null)
  var windows = []
  try { windows = processes[0].windows() } catch (error) { return JSON.stringify(null) }
  var parts = ${jsString(path)}.split('.')
  var current = windows[Number(parts[0])]
  if (!current) return JSON.stringify(null)
  for (var i = 1; i < parts.length; i++) {
    var children = []
    try { children = current.uiElements() } catch (error) { return JSON.stringify(null) }
    current = children[Number(parts[i])]
    if (!current) return JSON.stringify(null)
  }
  var position = null
  var size = null
  try { position = current.position() } catch (error) { position = null }
  try { size = current.size() } catch (error) { size = null }
  if (!position || !size) return JSON.stringify(null)
  return JSON.stringify({ x: Number(position[0]) + Number(size[0]) / 2, y: Number(position[1]) + Number(size[1]) / 2 })
}
main()
`
}

function pointMouseScript(kind: "click" | "double" | "right" | "middle" | "move" | "down" | "up", x: number, y: number): string {
  const setup = `
var point = $.CGPointMake(${Math.round(x)}, ${Math.round(y)})
function postMouse(type, button) {
  var event = $.CGEventCreateMouseEvent($(), type, point, button)
  $.CGEventPost($.kCGHIDEventTap, event)
}
`
  if (kind === "move") return `${setup}\npostMouse($.kCGEventMouseMoved, $.kCGMouseButtonLeft)\nJSON.stringify({ ok: true })`
  if (kind === "down") return `${setup}\npostMouse($.kCGEventLeftMouseDown, $.kCGMouseButtonLeft)\nJSON.stringify({ ok: true })`
  if (kind === "up") return `${setup}\npostMouse($.kCGEventLeftMouseUp, $.kCGMouseButtonLeft)\nJSON.stringify({ ok: true })`
  if (kind === "right")
    return `${setup}\npostMouse($.kCGEventRightMouseDown, $.kCGMouseButtonRight)\npostMouse($.kCGEventRightMouseUp, $.kCGMouseButtonRight)\nJSON.stringify({ ok: true })`
  if (kind === "middle")
    return `${setup}\npostMouse($.kCGEventOtherMouseDown, 2)\npostMouse($.kCGEventOtherMouseUp, 2)\nJSON.stringify({ ok: true })`
  const count = kind === "double" ? 2 : 1
  return `${setup}
for (var i = 1; i <= ${count}; i++) {
  var down = $.CGEventCreateMouseEvent($(), $.kCGEventLeftMouseDown, point, $.kCGMouseButtonLeft)
  $.CGEventSetIntegerValueField(down, $.kCGMouseEventClickState, i)
  $.CGEventPost($.kCGHIDEventTap, down)
  var up = $.CGEventCreateMouseEvent($(), $.kCGEventLeftMouseUp, point, $.kCGMouseButtonLeft)
  $.CGEventSetIntegerValueField(up, $.kCGMouseEventClickState, i)
  $.CGEventPost($.kCGHIDEventTap, up)
}
JSON.stringify({ ok: true })`
}

function dragScript(from: { x: number; y: number }, to: { x: number; y: number }): string {
  return `
ObjC.import('CoreGraphics')
ObjC.import('Foundation')
var start = $.CGPointMake(${Math.round(from.x)}, ${Math.round(from.y)})
var end = $.CGPointMake(${Math.round(to.x)}, ${Math.round(to.y)})
function post(type, point, button) {
  var event = $.CGEventCreateMouseEvent($(), type, point, button)
  $.CGEventPost($.kCGHIDEventTap, event)
}
post($.kCGEventMouseMoved, start, $.kCGMouseButtonLeft)
post($.kCGEventLeftMouseDown, start, $.kCGMouseButtonLeft)
for (var step = 1; step <= 12; step++) {
  var x = start.x + (end.x - start.x) * (step / 12)
  var y = start.y + (end.y - start.y) * (step / 12)
  post($.kCGEventLeftMouseDragged, $.CGPointMake(x, y), $.kCGMouseButtonLeft)
}
post($.kCGEventLeftMouseUp, end, $.kCGMouseButtonLeft)
JSON.stringify({ ok: true })
`
}

function scrollScript(x: number, y: number, direction: string, amount: number): string {
  const delta = direction === "up" ? Math.abs(amount) : direction === "down" ? -Math.abs(amount) : 0
  const horizontal = direction === "left" ? -Math.abs(amount) : direction === "right" ? Math.abs(amount) : 0
  return `
ObjC.import('CoreGraphics')
ObjC.import('Foundation')
var point = $.CGPointMake(${Math.round(x)}, ${Math.round(y)})
var move = $.CGEventCreateMouseEvent($(), $.kCGEventMouseMoved, point, $.kCGMouseButtonLeft)
$.CGEventPost($.kCGHIDEventTap, move)
var vertical = $.CGEventCreateScrollWheelEvent($(), $.kCGScrollEventUnitLine, 2, ${delta}, ${horizontal})
$.CGEventPost($.kCGHIDEventTap, vertical)
JSON.stringify({ ok: true })
`
}

function keystrokeScript(text: string): string {
  const lines = text.split("\n")
  const steps = lines
    .map((line, index) => {
      const enter = index > 0 ? "se.keyCode(36)\n" : ""
      return `${enter}${line.length > 0 ? `se.keystroke(${jsString(line)})\n` : ""}`
    })
    .join("")
  return `
var se = Application('System Events')
${steps}JSON.stringify({ ok: true })
`
}

function hashText(text: string): string {
  let hash = 5381
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0
  }
  return (hash >>> 0).toString(16)
}

function keyCodeScript(keys: string): string | undefined {
  const body = darwinKeyScript(keys)
  if (body === undefined) return undefined
  return `
var se = Application('System Events')
${body}
JSON.stringify({ ok: true })
`
}

function pointerPositionScript(): string {
  return `
ObjC.import('CoreGraphics')
ObjC.import('Foundation')
var location = $.CGEventGetLocation($.CGEventCreate($()))
JSON.stringify({ x: Math.round(Number(location.x)), y: Math.round(Number(location.y)) })
`
}

export interface DarwinDriverOptions {
  readonly osascript?: string
  readonly screencapture?: string
  readonly ioreg?: string
  readonly shell?: string
}

const SECURE_INPUT_TTL_MS = 500
const KEYBOARD_ACTIONS = new Set<ActionType>([
  "type",
  "key",
  "keypress",
  "press_keys",
  "press",
  "dismiss",
  "copy",
  "paste",
  "setvalue",
])

function trustScript(): string {
  return `
ObjC.import('ApplicationServices')
function main() {
  try { return JSON.stringify({ trusted: $.AXIsProcessTrusted() === true }) } catch (error) { return JSON.stringify({ trusted: null }) }
}
main()
`
}

export class DarwinHostDriver {
  readonly id = "darwin-host"
  readonly backend = "macos-ax"
  private readonly osascript: string
  private readonly screencapture: string
  private readonly ioreg: string
  private readonly shell: string
  private secureInput: { at: number; active: boolean } | undefined
  // Honest accessibility capability: the static "available" claim used to
  // survive a revoked grant, so callers trusted capabilities that the tree
  // could not satisfy. Unknown until the cheap trust probe answers.
  private accessibility: CapabilityState = "unknown"

  constructor(options: DarwinDriverOptions = {}) {
    this.osascript = options.osascript ?? "/usr/bin/osascript"
    this.screencapture = options.screencapture ?? "/usr/sbin/screencapture"
    this.ioreg = options.ioreg ?? "/usr/sbin/ioreg"
    this.shell = options.shell ?? "/bin/zsh"
    void this.refreshAccessibility()
  }

  private async refreshAccessibility(): Promise<void> {
    if (!this.available) return
    const result = await this.script(trustScript(), DARWIN_SCRIPT_TIMEOUT_MS)
    if (result.code !== 0) return
    try {
      const parsed = JSON.parse(result.stdout.trim()) as { trusted?: unknown }
      if (parsed.trusted === true) this.accessibility = "available"
      else if (parsed.trusted === false) this.accessibility = "unavailable"
    } catch {
      // A process that cannot answer the trust probe leaves the state unknown.
    }
  }

  // macOS Secure Input routes keyboard events to the security agent and
  // silently discards synthetic ones while osascript still exits 0. Probe the
  // system state (cached briefly) so keyboard actions refuse instead of
  // reporting delivery that never happened.
  private async secureInputRefusal(action: ComputerAction): Promise<ActionResult | undefined> {
    if (!KEYBOARD_ACTIONS.has(action.type)) return undefined
    const cached = this.secureInput
    const active =
      cached !== undefined && Date.now() - cached.at < SECURE_INPUT_TTL_MS
        ? cached.active
        : await runProcess(
            this.ioreg,
            ["-l", "-d", "1", "-k", "CGSSessionSecureInputPID"],
            DARWIN_SCRIPT_TIMEOUT_MS,
          ).then((result) => {
            const value = result.code === 0 && result.stdout.includes("SecureInputPID")
            this.secureInput = { at: Date.now(), active: value }
            return value
          })
    if (!active) return undefined
    return {
      success: false,
      status: "rejected",
      message:
        "macOS Secure Input is active; keyboard events are discarded by the system. Finish the secure prompt (or disable Secure Keyboard Entry) and retry.",
      error: { code: "secure_input", message: "macOS Secure Input is active.", retryable: true },
    }
  }

  get available(): boolean {
    return process.platform === "darwin" && existsSync(this.osascript)
  }

  private script(script: string, timeoutMs = DARWIN_SCRIPT_TIMEOUT_MS): Promise<ProcessResult> {
    return runProcess(this.osascript, ["-l", "JavaScript", "-e", script], timeoutMs)
  }

  async observe(request?: { applicationId?: string }): Promise<Observation> {
    const result = await this.script(observeScript(request?.applicationId), DARWIN_OBSERVE_TIMEOUT_MS)
    const parsed = parseDarwinObservation(result.stdout)
    // A zero-element tree is never reported as plain success: either the
    // permission is missing (unavailable) or the result is degraded and
    // carries an explicit warning.
    const denied = parsed.error !== undefined && /permission|accessibility|not granted/i.test(parsed.error)
    const empty = parsed.error === undefined && parsed.elements.length === 0
    const warnings =
      parsed.error !== undefined
        ? [parsed.error]
        : empty
          ? [
              "No accessibility elements were observed; the desktop may be empty or the accessibility tree may be unavailable.",
            ]
          : undefined
    this.accessibility = parsed.error === undefined ? (empty ? "degraded" : "available") : denied ? "unavailable" : "degraded"
    const observation: Observation = {
      id: `macos-${Date.now().toString(36)}`,
      timestamp: Date.now(),
      computer: await this.info(),
      environment: { platform: "macos", os: "darwin", architecture: process.arch, backend: "macos-ax" },
      elements: parsed.elements,
      capabilities: {
        accessibility: parsed.error === undefined ? (empty ? "degraded" : "available") : denied ? "unavailable" : "degraded",
      },
      ...(warnings === undefined ? {} : { warnings }),
    }
    return observation
  }

  async find(request: FindRequest): Promise<FindResult> {
    const observation = await this.observe()
    const result = retrieveElements(observation.elements ?? [], {
      query: request.query,
      role: request.role,
      name: request.name,
      limit: request.limit ?? 10,
    })
    const matches: FindMatch[] = result.matches.map((match) => ({
      element: match.element,
      score: match.score,
      ...(match.reference === undefined ? {} : { reference: match.reference }),
      reason: match.reason,
    }))
    return {
      query: request.query,
      matches,
      results: matches,
      elements: matches.map((match) => match.element),
      references: matches.flatMap((match) => (match.reference === undefined ? [] : [match.reference])),
      observation,
      truncated: result.truncated,
      metadata: { strategy: "deterministic-semantic" },
    }
  }

  private elementPath(elementId: string): { pid: number; path: string } | undefined {
    const match = elementId.match(/^mac:(\d+):(.+)$/)
    if (!match?.[1] || !match[2]) return undefined
    return { pid: Number(match[1]), path: match[2] }
  }

  private async elementCenter(elementId: string): Promise<{ x: number; y: number } | undefined> {
    const target = this.elementPath(elementId)
    if (target === undefined || target.path === "root") return undefined
    const result = await this.script(elementBoundsScript(target.pid, target.path))
    try {
      const parsed = JSON.parse(result.stdout.trim()) as { x?: unknown; y?: unknown } | null
      if (parsed === null || typeof parsed.x !== "number" || typeof parsed.y !== "number") return undefined
      return { x: parsed.x, y: parsed.y }
    } catch {
      return undefined
    }
  }

  private async pointOf(action: ComputerAction): Promise<{ x: number; y: number } | undefined> {
    const target = action.target
    if (target !== undefined && typeof target === "object" && target.kind === "point") {
      return { x: target.x, y: target.y }
    }
    if (target !== undefined && typeof target === "object" && target.kind === "element") {
      return this.elementCenter(target.elementId)
    }
    return undefined
  }

  private async clickPoint(
    x: number,
    y: number,
    kind: "click" | "double" | "right" | "middle" | "move" | "down" | "up",
    durationMs: number,
  ): Promise<ActionResult> {
    if (kind === "move" && durationMs > 0) {
      const steps = Math.max(2, Math.min(24, Math.round(durationMs / 24)))
      const start = await this.pointerPosition().catch(() => undefined)
      if (start?.success === true && typeof start.x === "number" && typeof start.y === "number") {
        for (let step = 1; step <= steps; step += 1) {
          const t = step / steps
          const result = await this.script(
            pointMouseScript("move", start.x + (x - start.x) * t, start.y + (y - start.y) * t),
          )
          if (result.code !== 0) break
          await new Promise((resolve) => setTimeout(resolve, Math.max(1, Math.round(durationMs / steps))))
        }
        return { success: true, status: "success", message: `Moved the pointer to ${Math.round(x)},${Math.round(y)}.` }
      }
    }
    const result = await this.script(pointMouseScript(kind, x, y))
    if (result.code !== 0) {
      return {
        success: false,
        status: "failed",
        message: "The macOS pointer event failed; grant Omnia accessibility permission.",
        error: { code: "input_failed", message: result.stderr.trim() || "macOS pointer event failed.", retryable: true },
      }
    }
    return { success: true, status: "success", message: `Pointer ${kind} at ${Math.round(x)},${Math.round(y)}.` }
  }

  async execute(action: ComputerAction): Promise<ActionResult> {
    const secure = await this.secureInputRefusal(action)
    if (secure !== undefined) return secure
    if (action.type === "observe" || action.type === "find") {
      return { success: true, status: "success", message: "Observation captured.", observation: await this.observe() }
    }
    if (action.type === "wait") {
      const requested = typeof action.ms === "number" && action.ms > 0 ? Math.min(action.ms, 30000) : 800
      await new Promise((resolve) => setTimeout(resolve, requested))
      return { success: true, status: "success", message: `Waited ${requested}ms.`, observation: await this.observe() }
    }
    if (action.type === "screenshot") return this.screenshot()
    if (action.type === "read") {
      const elementId = action.target !== undefined && typeof action.target === "object" && action.target.kind === "element"
        ? action.target.elementId
        : undefined
      if (elementId !== undefined) return this.readText({ elementId })
      return { success: true, status: "success", message: "Observation captured.", observation: await this.observe() }
    }
    if (action.type === "launch") return this.launchApp(action.applicationId)
    if (action.type === "open") return this.openTarget(action.target)
    if (action.type === "close") {
      const elementId = action.target !== undefined && typeof action.target === "object" && action.target.kind === "element"
        ? action.target.elementId
        : undefined
      if (elementId === undefined) {
        return { success: false, status: "unavailable", message: "Closing needs a window target on macOS." }
      }
      const target = this.elementPath(elementId)
      if (target === undefined || target.path.includes(".")) {
        return { success: false, status: "unavailable", message: "Closing needs a window target on macOS." }
      }
      const script = `
var se = Application('System Events')
var processes = se.applicationProcesses.whose({ unixId: ${target.pid} })()
if (processes && processes.length > 0) {
  try { processes[0].windows[${Number(target.path)}].buttons[0].click() } catch (error) {}
}
JSON.stringify({ ok: true })
`
      await this.script(script)
      return { success: true, status: "success", message: "Asked the window to close.", observation: await this.observe() }
    }
    if (action.type === "copy") {
      const key = keyCodeScript("cmd+c")
      if (key !== undefined) await this.script(key)
      return { success: true, status: "success", message: "Copied." }
    }
    if (action.type === "paste") {
      if (action.text.length > 0) {
        const written = await this.writeClipboard(action.text)
        if (!written.success) return written
      }
      const key = keyCodeScript("cmd+v")
      if (key !== undefined) await this.script(key)
      return { success: true, status: "success", message: "Pasted." }
    }
    if (action.type === "dismiss") {
      const key = keyCodeScript("escape")
      if (key !== undefined) await this.script(key)
      return { success: true, status: "success", message: "Dismissed." }
    }
    if (action.type === "key" || action.type === "keypress") {
      const keys = action.key ?? (action.type === "key" ? action.keys : undefined)
      if (typeof keys !== "string" || keys.length === 0) {
        return { success: false, status: "unavailable", message: "The key action requires a key." }
      }
      const script = keyCodeScript(keys)
      if (script === undefined) {
        return { success: false, status: "rejected", message: `The key ${keys} is not supported on macOS.` }
      }
      const result = await this.script(script)
      if (result.code !== 0) {
        return { success: false, status: "failed", message: result.stderr.trim() || "macOS key event failed." }
      }
      return { success: true, status: "success", message: `Pressed ${keys}.` }
    }
    if (action.type === "press_keys" || action.type === "press") {
      const script = keyCodeScript(action.keys)
      if (script === undefined) return { success: false, status: "rejected", message: "The key combination is not supported." }
      await this.script(script)
      return { success: true, status: "success", message: `Pressed ${action.keys}.` }
    }
    if (action.type === "type") {
      const target = action.target
      if (target !== undefined && typeof target === "object" && target.kind === "element") {
        const center = await this.elementCenter(target.elementId)
        // NO typing into whatever happens to be frontmost: an element target
        // that cannot be located is a refusal, not a global keystroke.
        if (center === undefined) {
          return {
            success: false,
            status: "rejected",
            message: `Target ${target.elementId} could not be located to focus for typing.`,
            error: { code: "target_stale", message: "The typing target could not be located.", retryable: true },
          }
        }
        const focused = await this.clickPoint(center.x, center.y, "click", 0)
        if (!focused.success) return focused
      }
      const result = await this.script(keystrokeScript(action.text))
      if (result.code !== 0) {
        return { success: false, status: "failed", message: result.stderr.trim() || "macOS typing failed." }
      }
      return { success: true, status: "success", message: `Typed ${action.text.length} characters.`, observation: await this.observe() }
    }
    if (action.type === "setvalue") {
      const target = action.target
      if (target === undefined || typeof target !== "object" || target.kind !== "element") {
        return { success: false, status: "unavailable", message: "Setting a value needs an element target on macOS." }
      }
      const center = await this.elementCenter(target.elementId)
      if (center === undefined) {
        return { success: false, status: "rejected", message: `Target ${target.elementId} has no bounds.` }
      }
      await this.clickPoint(center.x, center.y, "click", 0)
      const select = keyCodeScript("cmd+a")
      if (select !== undefined) await this.script(select)
      const result = await this.script(keystrokeScript(String(action.value)))
      if (result.code !== 0) return { success: false, status: "failed", message: "macOS set value failed." }
      return { success: true, status: "success", message: "Set the value.", observation: await this.observe() }
    }
    if (action.type === "focus") {
      const target = action.target
      if (target === undefined || typeof target !== "object" || target.kind !== "element") {
        return { success: false, status: "unavailable", message: "Focusing needs an element target." }
      }
      const center = await this.elementCenter(target.elementId)
      if (center === undefined) {
        return { success: false, status: "rejected", message: `Target ${target.elementId} has no bounds.` }
      }
      await this.clickPoint(center.x, center.y, "click", 0)
      return { success: true, status: "success", message: "Focused the control.", observation: await this.observe() }
    }
    if (action.type === "click" || action.type === "doubleclick" || action.type === "rightclick") {
      const point = await this.pointOf(action)
      if (point === undefined) {
        return { success: false, status: "rejected", message: `${action.type} needs a point or an element with bounds.` }
      }
      const kind = action.type === "doubleclick" ? "double" : action.type === "rightclick" ? "right" : "click"
      const result = await this.clickPoint(point.x, point.y, kind, 240)
      if (!result.success) return result
      return { ...result, observation: await this.observe() }
    }
    if (action.type === "move") {
      const point = await this.pointOf(action)
      if (point === undefined) return { success: false, status: "rejected", message: "A move action needs a target." }
      return this.clickPoint(point.x, point.y, "move", 200)
    }
    if (action.type === "scroll") {
      const target = (await this.pointOf(action)) ?? (await this.pointerPosition())
      const direction = action.direction ?? "down"
      const amount = action.amount ?? 3
      const result = await this.script(scrollScript(target.x ?? 0, target.y ?? 0, direction, amount))
      if (result.code !== 0) return { success: false, status: "failed", message: "macOS scroll failed." }
      return { success: true, status: "success", message: `Scrolled ${direction}.`, observation: await this.observe() }
    }
    if (action.type === "drag") {
      const from = await this.pointOf({ type: "move", target: action.from } as ComputerAction)
      const to = await this.pointOf({ type: "move", target: action.to } as ComputerAction)
      if (from === undefined || to === undefined) {
        return { success: false, status: "rejected", message: "A drag action needs two resolvable targets." }
      }
      const result = await this.script(dragScript(from, to))
      if (result.code !== 0) return { success: false, status: "failed", message: "macOS drag failed." }
      return { success: true, status: "success", message: "Dragged.", observation: await this.observe() }
    }
    return { success: false, status: "unavailable", message: `Action ${action.type} is not supported on macOS.` }
  }

  async pointerPosition(): Promise<ActionResult & { x?: number; y?: number; held?: boolean }> {
    const result = await this.script(pointerPositionScript())
    try {
      const parsed = JSON.parse(result.stdout.trim()) as { x?: unknown; y?: unknown }
      if (typeof parsed.x !== "number" || typeof parsed.y !== "number") throw new Error("missing")
      return { success: true, status: "success", message: `The pointer is at ${parsed.x},${parsed.y}.`, x: parsed.x, y: parsed.y, held: false }
    } catch {
      return { success: false, status: "unavailable", message: "This macOS runtime cannot read the pointer." }
    }
  }

  async hoverPointer(x: number, y: number, holdMs = 600): Promise<ActionResult> {
    const result = await this.clickPoint(x, y, "move", 240)
    if (!result.success) return result
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, holdMs)))
    return result
  }

  async mouseDown(): Promise<ActionResult> {
    const position = await this.pointerPosition().catch(() => undefined)
    const x = position?.success === true && typeof position.x === "number" ? position.x : 0
    const y = position?.success === true && typeof position.y === "number" ? position.y : 0
    return this.clickPoint(x, y, "down", 0)
  }

  async mouseUp(): Promise<ActionResult> {
    const position = await this.pointerPosition().catch(() => undefined)
    const x = position?.success === true && typeof position.x === "number" ? position.x : 0
    const y = position?.success === true && typeof position.y === "number" ? position.y : 0
    return this.clickPoint(x, y, "up", 0)
  }

  async readText(input: { elementId?: string; application?: string; limit?: number }): Promise<
    ActionResult & { text?: string; length?: number; hash?: string }
  > {
    const observation = await this.observe(input.application === undefined ? undefined : { applicationId: input.application })
    const element =
      input.elementId === undefined
        ? (observation.elements ?? []).find((candidate) => (candidate.states ?? []).includes("focused"))
        : (observation.elements ?? []).find((candidate) => candidate.id === input.elementId)
    if (element === undefined) {
      return { success: false, status: "rejected", message: "The requested text target is not in the current observation." }
    }
    const text = [element.name, element.description, typeof element.value === "string" ? element.value : undefined]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .join("\n")
      .slice(0, input.limit ?? 4000)
    return {
      success: true,
      status: "success",
      message: `Read ${text.length} characters.`,
      text,
      length: text.length,
      hash: hashText(text),
    }
  }

  async readClipboard(): Promise<ActionResult & { text?: string; length?: number; hash?: string }> {
    const result = await runProcess("/usr/bin/pbpaste", [], 5000)
    const text = result.stdout
    return {
      success: true,
      status: "success",
      message: `Read ${text.length} clipboard characters.`,
      text,
      length: text.length,
      hash: hashText(text),
    }
  }

  async writeClipboard(text: string): Promise<ActionResult> {
    const result = await runProcessWithInput("/usr/bin/pbcopy", [], text, 5000)
    if (result.code !== 0) return { success: false, status: "failed", message: "Writing the macOS clipboard failed." }
    return { success: true, status: "success", message: `Wrote ${text.length} characters to the clipboard.` }
  }

  async screenshot(): Promise<ActionResult> {
    const path = join(tmpdir(), `omnia-macos-${Date.now().toString(36)}.png`)
    const result = await runProcess(this.screencapture, ["-x", "-t", "png", path], 20000)
    if (result.code !== 0) {
      return {
        success: false,
        status: "unavailable",
        message: "Screen capture failed; grant Omnia Screen Recording permission in System Settings.",
      }
    }
    return { success: true, status: "success", message: "Captured the screen.", metadata: { path } }
  }

  async launchApp(applicationId: string): Promise<ActionResult> {
    const result = await runProcess("/usr/bin/open", ["-a", applicationId], 10000)
    if (result.code !== 0) {
      const fallback = await runProcess("/usr/bin/open", [applicationId], 10000)
      if (fallback.code !== 0) {
        return { success: false, status: "failed", message: `Could not launch ${applicationId} on macOS.` }
      }
    }
    return { success: true, status: "success", message: `Launched ${applicationId}.`, observation: await this.observe().catch(() => undefined) }
  }

  async openTarget(target: string): Promise<ActionResult> {
    const result = await runProcess("/usr/bin/open", [target], 10000)
    if (result.code !== 0) return { success: false, status: "failed", message: `Could not open ${target}.` }
    return { success: true, status: "success", message: `Opened ${target}.` }
  }

  async releaseStuckKeys(): Promise<ActionResult> {
    return { success: true, status: "success", message: "macOS does not latch modifier keys; nothing to release." }
  }

  async runCommand(request: CommandRequest): Promise<ActionResult & { command?: CommandResult }> {
    if (request.cwd !== undefined && request.cwd.length > 0) {
      if (!existsSync(request.cwd) || !statSync(request.cwd).isDirectory()) {
        return {
          success: false,
          status: "failed",
          message: `The working directory does not exist: ${request.cwd}`,
          error: { code: "invalid_cwd", message: `The working directory does not exist: ${request.cwd}`, retryable: false },
        }
      }
    }
    // A command must not be able to replace the loader or the environment the
    // runtime depends on (mirroring the Linux boundary; DYLD_* is the macOS
    // equivalent of LD_*).
    const forbidden = new Set(["PATH", "DISPLAY", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "NODE_OPTIONS"])
    const unsafe = Object.keys(request.env ?? {}).find((key) => forbidden.has(key.toUpperCase()))
    if (unsafe !== undefined) {
      return {
        success: false,
        status: "failed",
        message: `The command environment cannot override ${unsafe}.`,
        error: {
          code: "invalid_env",
          message: `The command environment cannot override ${unsafe}.`,
          retryable: false,
        },
      }
    }
    return executeShellCommand(request, { file: this.shell, args: (command) => ["-lc", command] })
  }

  async info(): Promise<ComputerInfo> {
    return {
      id: this.id,
      name: "macOS host",
      platform: "macos",
      os: "darwin",
      architecture: process.arch,
      backend: "macos-ax",
      connected: true,
    }
  }

  capabilities(): CapabilitySupport[] {
    return [
      {
        capability: "accessibility",
        status: this.accessibility,
        score: this.accessibility === "available" ? 0.8 : 0,
        reason:
          this.accessibility === "unavailable"
            ? "macOS Accessibility permission is not granted for this app; enable it in System Settings > Privacy & Security > Accessibility and relaunch Omnia."
            : "AXUIElement trees are read through System Events; System Settings > Privacy & Security > Accessibility must allow Omnia.",
      },
      {
        capability: "keyboard",
        status: "available",
        score: 0.85,
        reason: "System Events keystrokes and key codes work for any app once accessibility permission is granted.",
      },
      {
        capability: "pointer",
        status: "available",
        score: 0.85,
        reason: "CoreGraphics pointer events work for any app once accessibility permission is granted.",
      },
      {
        capability: "direct_ui_control",
        status: "available",
        score: 0.7,
        reason: "Semantic element targets are resolved to AX positions and driven with pointer and keyboard events.",
      },
      { capability: "screen_read", status: "available", score: 0.9, reason: "screencapture is always available; Screen Recording permission is required." },
      { capability: "launch", status: "available", score: 0.9, reason: "Applications are launched with open -a." },
      { capability: "activate", status: "available", score: 0.8, reason: "Applications are activated with open -a." },
      { capability: "clipboard", status: "available", score: 0.9, reason: "pbpaste and pbcopy provide clipboard text." },
      { capability: "shell", status: "available", score: 0.9, reason: "Shell commands run through /bin/zsh with captured output." },
    ]
  }

  async revalidateTarget(reference: ElementReference): Promise<HostRevalidation> {
    const id = reference.elementId ?? reference.id
    if (!id) return { valid: false, reason: "The reference has no element identifier." }
    const observation = await this.observe()
    const element = observation.elements?.find((candidate) => candidate.id === id)
    if (!element) return { valid: false, reason: `Element ${id} is not present in the current observation.` }
    return {
      valid: true,
      reference: {
        kind: "element",
        elementId: id,
        ...(observation.id === undefined ? {} : { observationId: observation.id }),
        ...(element.role === undefined ? {} : { role: element.role }),
      },
    }
  }

  dispose(): void {}
}

export function createDarwinHostDriver(options?: DarwinDriverOptions): HostDriver {
  const host = new DarwinHostDriver(options)
  return {
    id: host.id,
    backend: host.backend,
    get capabilities() {
      return host.capabilities()
    },
    getInfo: () => host.info(),
    observe: (request) =>
      host.observe(request !== undefined && typeof request.applicationId === "string" ? { applicationId: request.applicationId } : undefined),
    find: (request) => host.find(request),
    execute: (action) => host.execute(action),
    readText: (input) => host.readText(input),
    readClipboard: () => host.readClipboard(),
    writeClipboard: (text) => host.writeClipboard(text),
    pointerPosition: () => host.pointerPosition(),
    hoverPointer: (x, y, holdMs) => host.hoverPointer(x, y, holdMs),
    mouseDown: () => host.mouseDown(),
    mouseUp: () => host.mouseUp(),
    releaseStuckKeys: () => host.releaseStuckKeys(),
    runCommand: (request) => host.runCommand(request),
    dispose: () => host.dispose(),
    revalidateTarget: (reference) => host.revalidateTarget(reference),
  }
}
