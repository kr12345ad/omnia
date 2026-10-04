import type { Bounds, Point } from "../../protocol"

export const DARWIN_MAX_ELEMENTS = 1000
export const DARWIN_MAX_DEPTH = 12

// Shared across the native helper, the JXA fallback, and the backend so every
// layer reports the same missing-permission guidance byte for byte.
export const DARWIN_PERMISSION_WARNING =
  "macOS Accessibility permission is not granted for this app; enable it in System Settings > Privacy & Security > Accessibility and relaunch Omnia."

// JSON.stringify output is valid JavaScript except for U+2028/U+2029, which
// are line terminators in JS source and would break the generated script.
function jsString(value: unknown): string {
  return (JSON.stringify(value) ?? "null").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")
}

// Shared JXA helpers embedded into every generated script. Element access is
// wrapped because System Events throws for unsupported attributes on most
// element roles; a missing attribute must degrade to null, not abort the walk.
const DARWIN_HELPERS = `
function omniaAttr(element, name) {
  var attribute = null
  try { attribute = element.attributes.byName(name) } catch (error) { attribute = null }
  if (!attribute) { try { attribute = element.attributes[name] } catch (error) { attribute = null } }
  if (!attribute) return null
  try {
    var value = attribute.value()
    return value === undefined || value === null ? null : value
  } catch (error) {}
  try {
    var value = attribute.value
    return value === undefined || value === null ? null : value
  } catch (error) {}
  return null
}
function omniaNumber(value) {
  if (value === null || value === undefined) return null
  var number = 0
  try { number = Number(value) } catch (error) { return null }
  return isFinite(number) ? number : null
}
function omniaText(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  try { return String(value) } catch (error) { return null }
}
function omniaActions(element) {
  var names = []
  try {
    var actions = element.actions()
    for (var i = 0; i < actions.length; i++) {
      try {
        var name = ''
        try { name = String(actions[i].name()) } catch (error) { name = String(actions[i]) }
        if (name.length > 0 && names.indexOf(name) < 0) names.push(name)
      } catch (error) {}
    }
  } catch (error) {}
  return names
}
function omniaStates(element, role, value) {
  var states = []
  try { if (element.focused() === true) states.push('focused') } catch (error) {}
  try { if (element.selected() === true) states.push('selected') } catch (error) {}
  try { if (element.enabled() === false) states.push('disabled') } catch (error) {}
  try { if (element.attributes.byName('AXSelected').value() === true && states.indexOf('selected') < 0) states.push('selected') } catch (error) {}
  var expanded = omniaAttr(element, 'AXExpanded')
  if (expanded === true) states.push('expanded')
  if (expanded === false) states.push('collapsed')
  if (omniaAttr(element, 'AXHidden') === true) states.push('hidden')
  if (omniaAttr(element, 'AXMinimized') === true) states.push('minimized')
  if (omniaAttr(element, 'AXBusy') === true) states.push('busy')
  if (omniaAttr(element, 'AXRequired') === true) states.push('required')
  var lower = String(role || '').toLowerCase()
  if (lower === 'axcheckbox' || lower === 'axradiobutton') {
    if (value === 1 || value === true || value === '1') states.push('checked')
    else if (value === 2 || value === '2' || value === 'mixed') states.push('mixed')
  }
  return states
}
function omniaBounds(element) {
  var position = null
  var size = null
  try { position = element.position() } catch (error) { position = null }
  try { size = element.size() } catch (error) { size = null }
  if (!position || !size || position.length < 2 || size.length < 2) return null
  var x = omniaNumber(position[0])
  var y = omniaNumber(position[1])
  var width = omniaNumber(size[0])
  var height = omniaNumber(size[1])
  if (x === null || y === null || width === null || height === null) return null
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) }
}
function omniaElementInfo(element) {
  var role = ''
  try { role = String(element.role() || '') } catch (error) { role = '' }
  var subrole = ''
  try { subrole = String(element.subrole() || '') } catch (error) { subrole = '' }
  var name = ''
  try { name = String(element.name() || '') } catch (error) { name = '' }
  var description = ''
  try { description = String(element.description() || '') } catch (error) { description = '' }
  var value = null
  try { value = omniaText(element.value()) } catch (error) { value = null }
  var minValue = omniaNumber(omniaAttr(element, 'AXMinValue'))
  var maxValue = omniaNumber(omniaAttr(element, 'AXMaxValue'))
  var stepValue = omniaNumber(omniaAttr(element, 'AXValueIncrement'))
  if (stepValue === null) stepValue = omniaNumber(omniaAttr(element, 'AXIncrement'))
  var editable = omniaAttr(element, 'AXEditable') === true
  var lowerRole = role.toLowerCase()
  if (lowerRole === 'axtextfield' || lowerRole === 'axtextarea' || lowerRole === 'axsearchfield' || lowerRole === 'axcombobox') editable = true
  return {
    role: role,
    subrole: subrole,
    name: name,
    description: description,
    value: value,
    placeholder: omniaText(omniaAttr(element, 'AXPlaceholderValue')),
    minValue: minValue,
    maxValue: maxValue,
    stepValue: stepValue,
    editable: editable,
    valuePresent: value !== null || minValue !== null || maxValue !== null,
    states: omniaStates(element, role, value),
    actions: omniaActions(element),
    bounds: omniaBounds(element),
  }
}
function omniaElementAt(se, pid, path) {
  var processes = []
  try { processes = se.applicationProcesses.whose({ unixId: pid })() } catch (error) { return null }
  if (!processes || processes.length === 0) return null
  var windows = []
  try { windows = processes[0].windows() } catch (error) { return null }
  var parts = String(path).split('.')
  if (parts.length === 0 || parts[0] === '') return null
  var element = windows[Number(parts[0])]
  if (!element) return null
  for (var i = 1; i < parts.length; i++) {
    var children = []
    try { children = element.uiElements() } catch (error) { return null }
    element = children[Number(parts[i])]
    if (!element) return null
  }
  return element
}
function omniaPerform(se, element, requested) {
  var wanted = String(requested || '')
  if (wanted.length === 0) return { ok: false, error: 'an action name is required' }
  var actions = []
  try { actions = element.actions() } catch (error) { actions = [] }
  var match = null
  var matchName = ''
  for (var i = 0; i < actions.length; i++) {
    var name = ''
    try { name = String(actions[i].name()) } catch (error) { name = String(actions[i]) }
    if (name.length === 0) continue
    if (name.toLowerCase() === wanted.toLowerCase()) {
      match = actions[i]
      matchName = name
      break
    }
    if (match === null && name.replace(/^AX/, '').toLowerCase() === wanted.replace(/^AX/, '').toLowerCase()) {
      match = actions[i]
      matchName = name
    }
  }
  if (match !== null) {
    try { element.actions.byName(matchName).perform(); return { ok: true, method: 'perform' } } catch (error) {}
    try { se.perform(match); return { ok: true, method: 'perform' } } catch (error) {}
    try { match.perform(); return { ok: true, method: 'perform' } } catch (error) {}
  }
  var lower = wanted.toLowerCase().replace(/^ax/, '')
  if (lower === 'press' || lower === 'confirm' || lower === 'open' || lower === 'pick') {
    try { se.click(element); return { ok: true, method: 'click' } } catch (error) {}
  }
  return { ok: false, error: 'the element does not expose ' + wanted }
}
function omniaSetAttribute(element, name, value) {
  try {
    element.attributes.byName(name).value = value
    return true
  } catch (error) {}
  try {
    element.attributes[name].value = value
    return true
  } catch (error) {
    return false
  }
}
`

export interface DarwinObserveOptions {
  app?: string
  maxElements?: number
  maxDepth?: number
  timeBudgetMs?: number
}

export function darwinObserveScript(options: DarwinObserveOptions = {}): string {
  const config = {
    app: options.app ?? null,
    maxElements: options.maxElements ?? DARWIN_MAX_ELEMENTS,
    maxDepth: options.maxDepth ?? DARWIN_MAX_DEPTH,
    timeBudgetMs: options.timeBudgetMs ?? 20000,
  }
  return `
ObjC.import('CoreGraphics')
ObjC.import('ApplicationServices')
${DARWIN_HELPERS}
function omniaTrusted() {
  try { return $.AXIsProcessTrusted() === true } catch (error) { return true }
}
function omniaWalk(element, index, depth, budget) {
  if (budget.count >= budget.maxElements || depth > budget.maxDepth) {
    budget.truncated = true
    return null
  }
  budget.count += 1
  var info = omniaElementInfo(element)
  var node = {
    index: index,
    role: info.role,
    subrole: info.subrole,
    name: info.name,
    description: info.description,
    value: info.value,
    placeholder: info.placeholder,
    minValue: info.minValue,
    maxValue: info.maxValue,
    stepValue: info.stepValue,
    editable: info.editable,
    valuePresent: info.valuePresent,
    states: info.states,
    actions: info.actions,
    bounds: info.bounds,
    children: [],
  }
  var children = []
  try { children = element.uiElements() } catch (error) { children = [] }
  for (var i = 0; i < children.length; i++) {
    var child = omniaWalk(children[i], i, depth + 1, budget)
    if (child !== null) node.children.push(child)
  }
  return node
}
function main() {
  var config = ${jsString(config)}
  var filter = config.app === null ? null : String(config.app).toLowerCase()
  var budget = { count: 0, truncated: false, maxElements: config.maxElements, maxDepth: config.maxDepth }
  if (typeof config.timeBudgetMs !== 'number') config.timeBudgetMs = 20000
  var screen = null
  try {
    var display = $.CGDisplayBounds($.CGMainDisplayID())
    screen = { width: Math.round(Number(display.size.width)), height: Math.round(Number(display.size.height)) }
  } catch (error) {
    screen = null
  }
  if (!omniaTrusted()) return JSON.stringify({ error: 'permission', message: ${jsString(DARWIN_PERMISSION_WARNING)} })
  var se = Application('System Events')
  // Default observation walks only the frontmost application. Enumerating and
  // walking every running app costs one AppleEvent per attribute and routinely
  // exceeds the time budget before the app the user is actually looking at is
  // reached; other apps stay reachable through an explicit app filter.
  var processes = []
  try {
    processes = filter === null ? se.applicationProcesses.whose({ frontmost: true })() : se.applicationProcesses()
  } catch (error) {
    return JSON.stringify({ error: 'permission', message: 'macOS accessibility access is unavailable; grant Omnia permission in System Settings > Privacy & Security > Accessibility.' })
  }
  if (filter === null && processes.length === 0) {
    try {
      var all = se.applicationProcesses()
      for (var f = 0; f < all.length && f < 40; f++) {
        try { if (all[f].frontmost() === true) { processes = [all[f]]; break } } catch (error) {}
      }
    } catch (error) {}
  }
  var startedAt = Date.now()
  var timeBudgetMs = config.timeBudgetMs
  var applications = []
  for (var p = 0; p < processes.length; p++) {
    if (budget.count >= budget.maxElements) {
      budget.truncated = true
      break
    }
    if (Date.now() - startedAt > timeBudgetMs) {
      budget.truncated = true
      break
    }
    var process = processes[p]
    var appName = ''
    try { appName = String(process.name() || '') } catch (error) { continue }
    if (filter !== null && appName.toLowerCase().indexOf(filter) < 0) continue
    var pid = -1
    try { pid = Number(process.unixId()) } catch (error) { pid = -1 }
    var nodes = []
    var windows = []
    try { windows = process.windows() } catch (error) { windows = [] }
    for (var w = 0; w < windows.length; w++) {
      var node = omniaWalk(windows[w], w, 0, budget)
      if (node !== null) nodes.push(node)
    }
    applications.push({ name: appName, pid: pid, nodes: nodes })
  }
  return JSON.stringify({ applications: applications, screen: screen, truncated: budget.truncated })
}
main()
`
}

export const DARWIN_OBSERVE_SCRIPT = darwinObserveScript()

export const DARWIN_PROBE_SCRIPT = `
function main() {
  try {
    ObjC.import('ApplicationServices')
    if ($.AXIsProcessTrusted() !== true) {
      return JSON.stringify({ ok: false, error: 'permission', message: ${jsString(DARWIN_PERMISSION_WARNING)} })
    }
  } catch (error) {}
  try {
    var se = Application('System Events')
    var processes = se.applicationProcesses()
    return JSON.stringify({ ok: true, processes: processes.length })
  } catch (error) {
    return JSON.stringify({ ok: false, error: String(error) })
  }
}
main()
`

export function darwinResolveScript(pid: number, path: readonly number[]): string {
  return `
${DARWIN_HELPERS}
function main() {
  var se = Application('System Events')
  var element = omniaElementAt(se, ${pid}, ${jsString(path.join("."))})
  if (!element) return JSON.stringify({ ok: false, error: 'target_unreachable' })
  var info = omniaElementInfo(element)
  return JSON.stringify({
    ok: true,
    role: info.role,
    subrole: info.subrole,
    name: info.name,
    description: info.description,
    value: info.value,
    placeholder: info.placeholder,
    minValue: info.minValue,
    maxValue: info.maxValue,
    stepValue: info.stepValue,
    editable: info.editable,
    valuePresent: info.valuePresent,
    states: info.states,
    actions: info.actions,
    bounds: info.bounds,
  })
}
main()
`
}

export function darwinActionScript(pid: number, path: readonly number[], action: string): string {
  const fallback =
    action.toLowerCase().replace(/^ax/, "") === "expand"
      ? `if (!result.ok && omniaSetAttribute(element, 'AXExpanded', true)) result = { ok: true, method: 'attribute' }`
      : action.toLowerCase().replace(/^ax/, "") === "collapse"
        ? `if (!result.ok && omniaSetAttribute(element, 'AXExpanded', false)) result = { ok: true, method: 'attribute' }`
        : ""
  return `
${DARWIN_HELPERS}
function main() {
  var se = Application('System Events')
  var element = omniaElementAt(se, ${pid}, ${jsString(path.join("."))})
  if (!element) return JSON.stringify({ ok: false, error: 'target_unreachable' })
  var result = omniaPerform(se, element, ${jsString(action)})
  ${fallback}
  return JSON.stringify(result)
}
main()
`
}

export function darwinSetValueScript(pid: number, path: readonly number[], text: string): string {
  return `
${DARWIN_HELPERS}
function main() {
  var se = Application('System Events')
  var element = omniaElementAt(se, ${pid}, ${jsString(path.join("."))})
  if (!element) return JSON.stringify({ ok: false, error: 'target_unreachable' })
  var text = ${jsString(text)}
  var attempts = [text]
  var number = Number(text)
  if (isFinite(number) && String(text).trim().length > 0) attempts.push(number)
  for (var i = 0; i < attempts.length; i++) {
    try {
      element.value = attempts[i]
      var read = null
      try { read = omniaText(element.value()) } catch (error) { read = null }
      return JSON.stringify({ ok: true, method: 'value', value: read })
    } catch (error) {}
    if (omniaSetAttribute(element, 'AXValue', attempts[i])) return JSON.stringify({ ok: true, method: 'attribute' })
  }
  return JSON.stringify({ ok: false, error: 'background set-value is not supported by this element' })
}
main()
`
}

export function darwinFocusScript(pid: number, path: readonly number[]): string {
  return `
${DARWIN_HELPERS}
function main() {
  var se = Application('System Events')
  var element = omniaElementAt(se, ${pid}, ${jsString(path.join("."))})
  if (!element) return JSON.stringify({ ok: false, error: 'target_unreachable' })
  var performed = omniaPerform(se, element, 'AXFocus')
  if (performed.ok) return JSON.stringify(performed)
  try {
    element.focused = true
    return JSON.stringify({ ok: true, method: 'focused' })
  } catch (error) {}
  if (omniaSetAttribute(element, 'AXFocused', true)) return JSON.stringify({ ok: true, method: 'attribute' })
  return JSON.stringify({ ok: false, error: 'focus is not supported by this element' })
}
main()
`
}

export function darwinValueStepScript(pid: number, path: readonly number[], delta: 1 | -1): string {
  return `
${DARWIN_HELPERS}
function main() {
  var se = Application('System Events')
  var element = omniaElementAt(se, ${pid}, ${jsString(path.join("."))})
  if (!element) return JSON.stringify({ ok: false, error: 'target_unreachable' })
  var action = ${jsString(delta > 0 ? "AXIncrement" : "AXDecrement")}
  var performed = omniaPerform(se, element, action)
  if (performed.ok) return JSON.stringify(performed)
  var info = omniaElementInfo(element)
  var current = Number(info.value)
  if (!isFinite(current)) current = 0
  var step = info.stepValue === null || info.stepValue <= 0 ? 1 : info.stepValue
  var next = current + ${delta > 0 ? "step" : "-step"}
  if (info.minValue !== null) next = Math.max(next, info.minValue)
  if (info.maxValue !== null) next = Math.min(next, info.maxValue)
  try {
    element.value = next
    return JSON.stringify({ ok: true, method: 'value', value: next })
  } catch (error) {}
  if (omniaSetAttribute(element, 'AXValue', next)) return JSON.stringify({ ok: true, method: 'attribute' })
  return JSON.stringify({ ok: false, error: 'the element does not support ' + action })
}
main()
`
}

export type DarwinWindowAction = "focus" | "minimize" | "restore" | "close"

export function darwinWindowScript(pid: number, windowIndex: number, action: DarwinWindowAction): string {
  const body: Record<DarwinWindowAction, string> = {
    focus: `
  // NO silent frontmost fallback: bringing another app forward steals focus
  // and must be an explicit user-approved step, not a hidden side effect of
  // focusing a window. Only AXRaise / AXFocused are attempted here.
  var raised = omniaPerform(se, target, 'AXRaise')
  if (raised.ok) return JSON.stringify({ ok: true, method: 'raise' })
  try {
    target.focused = true
    return JSON.stringify({ ok: true, method: 'focused' })
  } catch (error) {}
  return JSON.stringify({ ok: false, error: 'focus is not supported by this window; frontmost fallback is disabled' })`,
    minimize: `
  var minimized = omniaPerform(se, target, 'AXMinimize')
  if (minimized.ok) return JSON.stringify(minimized)
  try {
    target.minimized = true
    return JSON.stringify({ ok: true, method: 'minimized' })
  } catch (error) {}
  return JSON.stringify({ ok: false, error: 'minimize is not supported by this window' })`,
    restore: `
  try { target.minimized = false } catch (error) {}
  var raised = omniaPerform(se, target, 'AXRaise')
  if (raised.ok) return JSON.stringify({ ok: true, method: 'raise' })
  try {
    target.minimized = false
    return JSON.stringify({ ok: true, method: 'minimized' })
  } catch (error) {}
  return JSON.stringify({ ok: false, error: 'restore is not supported by this window' })`,
    close: `
  var closed = omniaPerform(se, target, 'AXClose')
  if (closed.ok) return JSON.stringify(closed)
  try {
    se.click(target.buttons[0])
    return JSON.stringify({ ok: true, method: 'click' })
  } catch (error) {}
  return JSON.stringify({ ok: false, error: 'close is not supported by this window' })`,
  }
  return `
${DARWIN_HELPERS}
function main() {
  var se = Application('System Events')
  var processes = []
  try { processes = se.applicationProcesses.whose({ unixId: ${pid} })() } catch (error) { return JSON.stringify({ ok: false, error: 'target_unreachable' }) }
  if (!processes || processes.length === 0) return JSON.stringify({ ok: false, error: 'target_unreachable' })
  var proc = processes[0]
  var windows = []
  try { windows = proc.windows() } catch (error) { return JSON.stringify({ ok: false, error: 'target_unreachable' }) }
  var target = windows[${windowIndex}]
  if (!target) return JSON.stringify({ ok: false, error: 'target_unreachable' })
${body[action]}
}
main()
`
}

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

export function darwinKeyBody(keys: string): string | undefined {
  const parts = keys
    .split("+")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0)
  const modifiers: string[] = []
  let key: string | undefined
  let nonModifierCount = 0
  for (const part of parts) {
    const modifier = DARWIN_MODIFIERS[part]
    if (modifier !== undefined) {
      modifiers.push(modifier)
      continue
    }
    key = part
    nonModifierCount += 1
  }
  // A single keyCode/keystroke cannot express several non-modifier keys;
  // keeping the last one would silently drop the rest of the combination.
  if (nonModifierCount > 1) return undefined
  if (key === undefined) return undefined
  const using = modifiers.length === 0 ? "" : `, { using: [${modifiers.map((item) => JSON.stringify(item)).join(", ")}] }`
  const code = DARWIN_KEY_CODES[key]
  if (code !== undefined) return `se.keyCode(${code}${using})`
  if (key.length === 1) return `se.keystroke(${jsString(key)}${using})`
  return undefined
}

export function darwinKeyScript(keys: string): string | undefined {
  const body = darwinKeyBody(keys)
  if (body === undefined) return undefined
  return `
function main() {
  var se = Application('System Events')
  ${body}
  return JSON.stringify({ ok: true })
}
main()
`
}

export function darwinTypeScript(text: string): string {
  const lines = text.split("\n")
  const steps = lines
    .map((line, index) => {
      const enter = index > 0 ? "se.keyCode(36)\n" : ""
      return `${enter}${line.length > 0 ? `se.keystroke(${jsString(line)})\n` : ""}`
    })
    .join("")
  return `
function main() {
  var se = Application('System Events')
  ${steps}
  return JSON.stringify({ ok: true })
}
main()
`
}

// macOS Secure Input (password prompts, Terminal "Secure Keyboard Entry")
// routes keyboard events to the security agent and silently discards synthetic
// ones while System Events still reports success. Probe it explicitly so
// keyboard actions refuse instead of claiming delivery they cannot prove.
export function darwinSecureInputScript(): string {
  return `
function main() {
  var app = Application.currentApplication()
  app.includeStandardAdditions = true
  var output = app.doShellScript('/usr/sbin/ioreg -l -d 1 -k CGSSessionSecureInputPID')
  return JSON.stringify({ ok: true, secureInput: output.indexOf('SecureInputPID') >= 0 })
}
main()
`
}

export function darwinClickScript(point: Point, button: "left" | "right" | "middle" = "left", count = 1): string {
  const clicks = Math.max(1, Math.round(count))
  const left = `
  for (var i = 1; i <= ${clicks}; i++) {
    var down = $.CGEventCreateMouseEvent($(), $.kCGEventLeftMouseDown, point, $.kCGMouseButtonLeft)
    $.CGEventSetIntegerValueField(down, $.kCGMouseEventClickState, i)
    $.CGEventPost($.kCGHIDEventTap, down)
    var up = $.CGEventCreateMouseEvent($(), $.kCGEventLeftMouseUp, point, $.kCGMouseButtonLeft)
    $.CGEventSetIntegerValueField(up, $.kCGMouseEventClickState, i)
    $.CGEventPost($.kCGHIDEventTap, up)
  }`
  const right = `
  for (var i = 1; i <= ${clicks}; i++) {
    var down = $.CGEventCreateMouseEvent($(), $.kCGEventRightMouseDown, point, $.kCGMouseButtonRight)
    $.CGEventSetIntegerValueField(down, $.kCGMouseEventClickState, i)
    $.CGEventPost($.kCGHIDEventTap, down)
    var up = $.CGEventCreateMouseEvent($(), $.kCGEventRightMouseUp, point, $.kCGMouseButtonRight)
    $.CGEventSetIntegerValueField(up, $.kCGMouseEventClickState, i)
    $.CGEventPost($.kCGHIDEventTap, up)
  }`
  const middle = `
  for (var i = 1; i <= ${clicks}; i++) {
    var down = $.CGEventCreateMouseEvent($(), $.kCGEventOtherMouseDown, point, 2)
    $.CGEventSetIntegerValueField(down, $.kCGMouseEventClickState, i)
    $.CGEventPost($.kCGHIDEventTap, down)
    var up = $.CGEventCreateMouseEvent($(), $.kCGEventOtherMouseUp, point, 2)
    $.CGEventSetIntegerValueField(up, $.kCGMouseEventClickState, i)
    $.CGEventPost($.kCGHIDEventTap, up)
  }`
  const body = button === "right" ? right : button === "middle" ? middle : left
  return `
ObjC.import('CoreGraphics')
ObjC.import('Foundation')
function main() {
  var point = $.CGPointMake(${Math.round(point.x)}, ${Math.round(point.y)})
  var move = $.CGEventCreateMouseEvent($(), $.kCGEventMouseMoved, point, $.kCGMouseButtonLeft)
  $.CGEventPost($.kCGHIDEventTap, move)
${body}
  return JSON.stringify({ ok: true })
}
main()
`
}

export function darwinScrollScript(direction: "up" | "down" | "left" | "right", amount: number, point?: Point): string {
  const vertical = direction === "up" ? Math.abs(amount) : direction === "down" ? -Math.abs(amount) : 0
  const horizontal = direction === "left" ? -Math.abs(amount) : direction === "right" ? Math.abs(amount) : 0
  const move =
    point === undefined
      ? ""
      : `
  var point = $.CGPointMake(${Math.round(point.x)}, ${Math.round(point.y)})
  var move = $.CGEventCreateMouseEvent($(), $.kCGEventMouseMoved, point, $.kCGMouseButtonLeft)
  $.CGEventPost($.kCGHIDEventTap, move)`
  return `
ObjC.import('CoreGraphics')
ObjC.import('Foundation')
function main() {${move}
  var event = $.CGEventCreateScrollWheelEvent($(), $.kCGScrollEventUnitLine, 2, ${vertical}, ${horizontal})
  $.CGEventPost($.kCGHIDEventTap, event)
  return JSON.stringify({ ok: true })
}
main()
`
}

export function darwinDragScript(from: Point, to: Point): string {
  return `
ObjC.import('CoreGraphics')
ObjC.import('Foundation')
function main() {
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
  return JSON.stringify({ ok: true })
}
main()
`
}

export interface DarwinElementSnapshot {
  index: number
  role: string
  subrole?: string
  name?: string
  description?: string
  value?: string
  placeholder?: string
  minValue?: number
  maxValue?: number
  stepValue?: number
  editable: boolean
  valuePresent: boolean
  states: string[]
  actions: string[]
  bounds?: Bounds
  children: DarwinElementSnapshot[]
}

export interface DarwinApplicationSnapshot {
  name?: string
  pid?: number
  error?: string
  nodes: DarwinElementSnapshot[]
}

export interface DarwinSnapshotPayload {
  applications: DarwinApplicationSnapshot[]
  screen?: { width: number; height: number }
  truncated: boolean
}

export interface DarwinResolvedPayload {
  role: string
  subrole?: string
  name?: string
  description?: string
  value?: string
  placeholder?: string
  minValue?: number
  maxValue?: number
  stepValue?: number
  editable: boolean
  valuePresent: boolean
  states: string[]
  actions: string[]
  bounds?: Bounds
}

export interface DarwinResultPayload {
  ok: boolean
  error?: string
  method?: string
  value?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string")
}

export function parseDarwinBounds(value: unknown): Bounds | undefined {
  if (!isRecord(value)) return undefined
  const x = finiteNumber(value.x)
  const y = finiteNumber(value.y)
  const width = finiteNumber(value.width)
  const height = finiteNumber(value.height)
  if (x === undefined || y === undefined || width === undefined || height === undefined) return undefined
  return { x, y, width, height }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function optionalValue(value: unknown): string | undefined {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return undefined
}

function optionalNumber(value: unknown): number | undefined {
  return finiteNumber(value)
}

export function parseDarwinNode(value: unknown): DarwinElementSnapshot | undefined {
  if (!isRecord(value)) return undefined
  const bounds = parseDarwinBounds(value.bounds)
  const children = Array.isArray(value.children)
    ? value.children.flatMap((child): DarwinElementSnapshot[] => {
        const parsed = parseDarwinNode(child)
        return parsed === undefined ? [] : [parsed]
      })
    : []
  const subrole = optionalString(value.subrole)
  const name = optionalString(value.name)
  const description = optionalString(value.description)
  const elementValue = optionalValue(value.value)
  const placeholder = optionalString(value.placeholder)
  const minValue = optionalNumber(value.minValue)
  const maxValue = optionalNumber(value.maxValue)
  const stepValue = optionalNumber(value.stepValue)
  return {
    index: Math.trunc(finiteNumber(value.index) ?? 0),
    role: typeof value.role === "string" && value.role.length > 0 ? value.role : "unknown",
    ...(subrole === undefined || subrole.length === 0 ? {} : { subrole }),
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    ...(elementValue === undefined ? {} : { value: elementValue }),
    ...(placeholder === undefined ? {} : { placeholder }),
    ...(minValue === undefined ? {} : { minValue }),
    ...(maxValue === undefined ? {} : { maxValue }),
    ...(stepValue === undefined ? {} : { stepValue }),
    editable: value.editable === true,
    valuePresent: value.valuePresent === true,
    states: stringArray(value.states),
    actions: stringArray(value.actions),
    ...(bounds === undefined ? {} : { bounds }),
    children,
  }
}

export function parseDarwinScriptOutput(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed.length === 0) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

export function parseDarwinSnapshotPayload(value: unknown): DarwinSnapshotPayload | undefined {
  if (isRecord(value) && "error" in value && typeof value.message === "string") return undefined
  if (!isRecord(value) || !Array.isArray(value.applications)) return undefined
  const applications = value.applications.flatMap((application): DarwinApplicationSnapshot[] => {
    if (!isRecord(application)) return []
    const pid = finiteNumber(application.pid)
    const name = optionalString(application.name)
    const error = optionalString(application.error)
    return [
      {
        ...(name === undefined ? {} : { name }),
        ...(pid === undefined ? {} : { pid }),
        ...(error === undefined ? {} : { error }),
        nodes: Array.isArray(application.nodes)
          ? application.nodes.flatMap((node): DarwinElementSnapshot[] => {
              const parsed = parseDarwinNode(node)
              return parsed === undefined ? [] : [parsed]
            })
          : [],
      },
    ]
  })
  const rawScreen = isRecord(value.screen) ? value.screen : undefined
  const width = rawScreen === undefined ? undefined : finiteNumber(rawScreen.width)
  const height = rawScreen === undefined ? undefined : finiteNumber(rawScreen.height)
  const screen = width !== undefined && height !== undefined ? { width, height } : undefined
  return {
    applications,
    ...(screen === undefined ? {} : { screen }),
    truncated: value.truncated === true,
  }
}

export function parseDarwinResolvedPayload(value: unknown): DarwinResolvedPayload | undefined {
  if (!isRecord(value) || value.ok !== true) return undefined
  if (typeof value.role !== "string" || value.role.length === 0) return undefined
  const bounds = parseDarwinBounds(value.bounds)
  const subrole = optionalString(value.subrole)
  const name = optionalString(value.name)
  const description = optionalString(value.description)
  const elementValue = optionalValue(value.value)
  const placeholder = optionalString(value.placeholder)
  const minValue = optionalNumber(value.minValue)
  const maxValue = optionalNumber(value.maxValue)
  const stepValue = optionalNumber(value.stepValue)
  return {
    role: value.role,
    ...(subrole === undefined || subrole.length === 0 ? {} : { subrole }),
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    ...(elementValue === undefined ? {} : { value: elementValue }),
    ...(placeholder === undefined ? {} : { placeholder }),
    ...(minValue === undefined ? {} : { minValue }),
    ...(maxValue === undefined ? {} : { maxValue }),
    ...(stepValue === undefined ? {} : { stepValue }),
    editable: value.editable === true,
    valuePresent: value.valuePresent === true,
    states: stringArray(value.states),
    actions: stringArray(value.actions),
    ...(bounds === undefined ? {} : { bounds }),
  }
}

export function parseDarwinResultPayload(value: unknown): DarwinResultPayload | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.ok !== "boolean") return undefined
  const error = optionalString(value.error)
  const method = optionalString(value.method)
  const resultValue = optionalString(value.value)
  return {
    ok: value.ok,
    ...(error === undefined ? {} : { error }),
    ...(method === undefined ? {} : { method }),
    ...(resultValue === undefined ? {} : { value: resultValue }),
  }
}
