import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  ActionResult,
  ActionType,
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
import { allowCapability, type DriverAccess } from "./linux"
import { executeShellCommand, runProcess, runProcessWithInput, type ProcessResult } from "./process"

export const WINDOWS_OBSERVE_TIMEOUT_MS = 60000
export const WINDOWS_SCRIPT_TIMEOUT_MS = 30000
export const WINDOWS_MAX_ELEMENTS = 600
export const WINDOWS_MAX_DEPTH = 6

export const WINDOWS_VK: Record<string, number> = {
  return: 0x0d,
  enter: 0x0d,
  tab: 0x09,
  escape: 0x1b,
  esc: 0x1b,
  space: 0x20,
  backspace: 0x08,
  delete: 0x2e,
  insert: 0x2d,
  left: 0x25,
  up: 0x26,
  right: 0x27,
  down: 0x28,
  home: 0x24,
  end: 0x23,
  pageup: 0x21,
  pagedown: 0x22,
  ctrl: 0x11,
  control: 0x11,
  shift: 0x10,
  alt: 0x12,
  win: 0x5b,
  meta: 0x5b,
  cmd: 0x5b,
  f1: 0x70,
  f2: 0x71,
  f3: 0x72,
  f4: 0x73,
  f5: 0x74,
  f6: 0x75,
  f7: 0x76,
  f8: 0x77,
  f9: 0x78,
  f10: 0x79,
  f11: 0x7a,
  f12: 0x7b,
}

export function windowsKeySpec(keys: string): { modifiers: number[]; key: number } | undefined {
  const parts = keys
    .split("+")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0)
  const modifiers: number[] = []
  let key: number | undefined
  for (const part of parts) {
    const vk = WINDOWS_VK[part]
    if (vk === undefined) {
      if ([...part].length === 1) key = part.toUpperCase().charCodeAt(0)
      continue
    }
    if ([0x11, 0x10, 0x12, 0x5b].includes(vk)) modifiers.push(vk)
    else key = vk
  }
  if (key === undefined) return undefined
  return { modifiers, key }
}

export function mapWindowsRole(role: string): string {
  const key = role.replace(/^ControlType\./, "").toLowerCase()
  const table: Record<string, string> = {
    button: "button",
    edit: "textbox",
    text: "label",
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
    progressbar: "progressbar",
    scrollbar: "scrollbar",
    image: "image",
    hyperlink: "link",
    document: "document",
    datagrid: "table",
    dataitem: "cell",
    header: "heading",
    headeritem: "columnheader",
    separator: "separator",
    thumb: "slider",
    statusbar: "statusbar",
    titlebar: "titlebar",
  }
  return table[key] ?? key
}

export function mapWindowsActions(actions: readonly string[]): ActionType[] {
  const table: Record<string, ActionType> = {
    invoke: "click",
    setvalue: "setvalue",
    select: "select",
    toggle: "toggle",
    expand: "expand",
    collapse: "collapse",
    close: "close",
    focus: "focus",
    scroll: "scroll",
  }
  return actions.flatMap((action) => {
    const mapped = table[action.toLowerCase()]
    return mapped === undefined ? [] : [mapped]
  })
}

interface WindowsElementRecord {
  id?: unknown
  parentId?: unknown
  role?: unknown
  name?: unknown
  description?: unknown
  value?: unknown
  enabled?: unknown
  focused?: unknown
  selected?: unknown
  offscreen?: unknown
  bounds?: unknown
  actions?: unknown
  pid?: unknown
}

export function toWindowsElement(record: WindowsElementRecord): UIElement | undefined {
  if (typeof record.id !== "string" || record.id.length === 0) return undefined
  const states: State[] = []
  if (record.focused === true) states.push("focused")
  if (record.selected === true) states.push("selected")
  if (record.enabled === false) states.push("disabled")
  if (record.offscreen === true) states.push("offscreen")
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
  const value =
    typeof record.value === "string" || typeof record.value === "number" || typeof record.value === "boolean"
      ? record.value
      : undefined
  const actions = Array.isArray(record.actions)
    ? record.actions.filter((item): item is string => typeof item === "string")
    : typeof record.actions === "string"
      ? [record.actions]
      : []
  const mappedActions = mapWindowsActions(actions)
  return {
    id: record.id,
    ...(typeof record.parentId === "string" && record.parentId.length > 0 ? { parentId: record.parentId } : {}),
    ...(typeof record.role === "string" && record.role.length > 0 ? { role: mapWindowsRole(record.role) } : {}),
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
      ...(typeof record.pid === "number" ? { pid: record.pid } : {}),
      backend: "windows-uia",
    },
  }
}

export function parseWindowsObservation(text: string): { elements: UIElement[]; error?: string } {
  const trimmed = text.replace(/^\uFEFF/, "").trim()
  if (trimmed.length === 0) return { elements: [], error: "The Windows UI Automation script returned no elements." }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { elements: [], error: "The Windows UI Automation script returned invalid JSON." }
  }
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && "error" in parsed) {
    const record = parsed as { message?: unknown }
    return {
      elements: [],
      error: typeof record.message === "string" ? record.message : "Windows UI Automation is unavailable.",
    }
  }
  const entries = Array.isArray(parsed) ? parsed : [parsed]
  return {
    elements: entries.flatMap((entry) => {
      const element = toWindowsElement((entry ?? {}) as WindowsElementRecord)
      return element === undefined ? [] : [element]
    }),
  }
}

const UIA_PREAMBLE = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
`

const INPUT_PREAMBLE = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class OmniaInput {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@
`

function observeScript(application: string | undefined): string {
  return `
${UIA_PREAMBLE}
$filter = ${application === undefined ? "$null" : `'${application.replace(/'/g, "''")}'`}
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$out = New-Object System.Collections.ArrayList
$max = ${WINDOWS_MAX_ELEMENTS}
$maxDepth = ${WINDOWS_MAX_DEPTH}
function Add-Node($element, $parentId, $depth) {
  if ($out.Count -ge $max -or $depth -gt $maxDepth) { return }
  $current = $element.Current
  $runtime = ($element.GetRuntimeId() -join '.')
  $id = 'win:' + $runtime
  $bounds = $null
  $rect = $current.BoundingRectangle
  if ($rect.Width -gt 0 -and $rect.Height -gt 0) {
    $bounds = [ordered]@{ x = [int]$rect.X; y = [int]$rect.Y; width = [int]$rect.Width; height = [int]$rect.Height }
  }
  $value = $null
  try { $value = $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value } catch { $value = $null }
  $actions = New-Object System.Collections.ArrayList
  try {
    foreach ($pattern in $element.GetSupportedPatterns()) {
      $name = $pattern.ProgrammaticName
      if ($name -like 'InvokePattern*') { [void]$actions.Add('invoke') }
      elseif ($name -like 'ValuePattern*') { [void]$actions.Add('setvalue') }
      elseif ($name -like 'SelectionItemPattern*') { [void]$actions.Add('select') }
      elseif ($name -like 'TogglePattern*') { [void]$actions.Add('toggle') }
      elseif ($name -like 'ExpandCollapsePattern*') { [void]$actions.Add('expand') }
      elseif ($name -like 'WindowPattern*') { [void]$actions.Add('close') }
    }
  } catch {}
  $item = [ordered]@{
    id = $id
    parentId = $parentId
    role = $current.ControlType.ProgrammaticName
    name = $current.Name
    description = $current.HelpText
    value = $value
    enabled = $current.IsEnabled
    focused = $current.HasKeyboardFocus
    selected = $current.IsSelected
    offscreen = $current.IsOffscreen
    bounds = $bounds
    actions = @($actions)
    pid = $current.ProcessId
  }
  if ($filter -eq $null -or ($item.name -ne $null -and $item.name.ToLower().Contains($filter.ToLower()))) {
    [void]$out.Add($item)
  }
  $child = $walker.GetFirstChild($element)
  while ($child -ne $null) {
    Add-Node $child $id ($depth + 1)
    $child = $walker.GetNextSibling($child)
  }
}
Add-Node ([System.Windows.Automation.AutomationElement]::RootElement) $null 0
ConvertTo-Json -InputObject @($out) -Depth 5 -Compress
`
}

function runtimeIdExpression(elementId: string): string | undefined {
  const match = elementId.match(/^win:([\d.]+)$/)
  if (match?.[1] === undefined) return undefined
  const parts = match[1].split(".").filter((part) => part.length > 0)
  if (parts.length === 0) return undefined
  return `@(${parts.join(", ")})`
}

function elementCenterScript(elementId: string): string | undefined {
  const runtime = runtimeIdExpression(elementId)
  if (runtime === undefined) return undefined
  return `
${UIA_PREAMBLE}
$el = [System.Windows.Automation.AutomationElement]::FromRuntimeId(${runtime})
if ($el -eq $null) { 'null' } else {
  $rect = $el.Current.BoundingRectangle
  ConvertTo-Json -InputObject ([ordered]@{ x = [int]($rect.X + $rect.Width / 2); y = [int]($rect.Y + $rect.Height / 2) }) -Compress
}
`
}

function elementPatternScript(elementId: string, pattern: "invoke" | "focus" | "select" | "toggle" | "expand" | "collapse" | "close" | "setvalue", value?: string): string | undefined {
  const runtime = runtimeIdExpression(elementId)
  if (runtime === undefined) return undefined
  const lines: Record<string, string> = {
    invoke: `$el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()`,
    focus: `$el.SetFocus()`,
    select: `$el.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select()`,
    toggle: `$el.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Toggle()`,
    expand: `$el.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Expand()`,
    collapse: `$el.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Collapse()`,
    close: `$el.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).Close()`,
    setvalue: `$el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue(${value === undefined ? "''" : `'${value.replace(/'/g, "''")}'`})`,
  }
  return `
${UIA_PREAMBLE}
$el = [System.Windows.Automation.AutomationElement]::FromRuntimeId(${runtime})
if ($el -eq $null) { 'null' } else {
  ${lines[pattern]}
  '{"ok":true}'
}
`
}

export function mouseScript(
  kind: "click" | "double" | "right" | "middle" | "move" | "down" | "up" | "wheel",
  x?: number,
  y?: number,
  data = 0,
): string {
  const click =
    kind === "click"
      ? `[OmniaInput]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero); [OmniaInput]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)`
      : kind === "double"
        ? `for ($i = 0; $i -lt 2; $i++) { [OmniaInput]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero); [OmniaInput]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 60 }`
        : kind === "right"
          ? `[OmniaInput]::mouse_event(0x0008, 0, 0, 0, [UIntPtr]::Zero); [OmniaInput]::mouse_event(0x0010, 0, 0, 0, [UIntPtr]::Zero)`
          : kind === "middle"
            ? `[OmniaInput]::mouse_event(0x0020, 0, 0, 0, [UIntPtr]::Zero); [OmniaInput]::mouse_event(0x0040, 0, 0, 0, [UIntPtr]::Zero)`
            : kind === "wheel"
              ? `[OmniaInput]::mouse_event(0x0800, 0, 0, ${data}, [UIntPtr]::Zero)`
              : kind === "down"
                ? `[OmniaInput]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)`
                : kind === "up"
                  ? `[OmniaInput]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)`
                  : `[OmniaInput]::mouse_event(0x0001, 0, 0, 0, [UIntPtr]::Zero)`
  // A held/released button must stay at the current pointer position; moving
  // to (0, 0) first would make the press land on whatever is in the corner.
  const move = x === undefined || y === undefined ? "" : `[OmniaInput]::SetCursorPos(${Math.round(x)}, ${Math.round(y)})`
  return `
${INPUT_PREAMBLE}
${move}
${click}
'{"ok":true}'
`
}

function dragScript(from: { x: number; y: number }, to: { x: number; y: number }): string {
  return `
${INPUT_PREAMBLE}
[OmniaInput]::SetCursorPos(${Math.round(from.x)}, ${Math.round(from.y)})
[OmniaInput]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 60
for ($step = 1; $step -le 12; $step++) {
  $x = [int](${Math.round(from.x)} + (${Math.round(to.x)} - ${Math.round(from.x)}) * ($step / 12))
  $y = [int](${Math.round(from.y)} + (${Math.round(to.y)} - ${Math.round(from.y)}) * ($step / 12))
  [OmniaInput]::SetCursorPos($x, $y)
  Start-Sleep -Milliseconds 15
}
[OmniaInput]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
'{"ok":true}'
`
}

function keyboardScript(keys: string): string | undefined {
  const spec = windowsKeySpec(keys)
  if (spec === undefined) return undefined
  const down = spec.modifiers.map((vk) => `[OmniaInput]::keybd_event(${vk}, 0, 0, [UIntPtr]::Zero)`).join("\n")
  const up = [...spec.modifiers].reverse().map((vk) => `[OmniaInput]::keybd_event(${vk}, 0, 2, [UIntPtr]::Zero)`).join("\n")
  return `
${INPUT_PREAMBLE}
${down}
[OmniaInput]::keybd_event(${spec.key}, 0, 0, [UIntPtr]::Zero)
[OmniaInput]::keybd_event(${spec.key}, 0, 2, [UIntPtr]::Zero)
${up}
'{"ok":true}'
`
}

// Clipboard text is read from stdin, never interpolated into the PowerShell
// source. JSON/quote escaping is not sufficient for PowerShell: `"`, backtick,
// and `$(...)` would still be executable if embedded in the command string.
export const WINDOWS_CLIPBOARD_SET_SCRIPT = `
$ErrorActionPreference = 'Stop'
$stdin = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)
Set-Clipboard -Value $stdin.ReadToEnd()
'{"ok":true}'
`

function typeScript(): string {
  return `
$ErrorActionPreference = 'Stop'
$previous = $null
try { $previous = Get-Clipboard -Raw -ErrorAction SilentlyContinue } catch { $previous = $null }
$stdin = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)
$text = $stdin.ReadToEnd()
Set-Clipboard -Value $text
${INPUT_PREAMBLE}
[OmniaInput]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero)
[OmniaInput]::keybd_event(0x56, 0, 0, [UIntPtr]::Zero)
[OmniaInput]::keybd_event(0x56, 0, 2, [UIntPtr]::Zero)
[OmniaInput]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero)
# Give the focused application time to consume the paste before the previous
# clipboard value overwrites it; restoring immediately can race the paste.
$deadline = (Get-Date).AddMilliseconds(1200)
while ((Get-Date) -lt $deadline) {
  $current = $null
  try { $current = Get-Clipboard -Raw -ErrorAction SilentlyContinue } catch {}
  if ($null -eq $current -or $current -ne $text) { break }
  Start-Sleep -Milliseconds 100
}
if ($previous -ne $null) { try { Set-Clipboard -Value $previous } catch {} }
'{"ok":true}'
`
}

function pointerPositionScript(): string {
  return `
Add-Type -AssemblyName System.Windows.Forms
$position = [System.Windows.Forms.Cursor]::Position
ConvertTo-Json -InputObject ([ordered]@{ x = $position.X; y = $position.Y }) -Compress
`
}

function screenshotScript(path: string): string {
  const escaped = path.replace(/'/g, "''")
  return `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$bitmap.Save('${escaped}', [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()
'{"ok":true}'
`
}

export interface WindowsDriverOptions {
  readonly powershell?: string
  readonly inputRunner?: (
    file: string,
    args: readonly string[],
    input: string,
    timeoutMs: number,
  ) => Promise<ProcessResult>
  // Which side of the product is driving this driver. Defaults to `local`.
  readonly access?: DriverAccess
}

export class WindowsHostDriver {
  readonly id = "windows-host"
  readonly backend = "windows-uia"
  private readonly powershell: string
  private readonly inputRunner: NonNullable<WindowsDriverOptions["inputRunner"]>
  private readonly access: DriverAccess

  constructor(options: WindowsDriverOptions = {}) {
    this.powershell = options.powershell ?? "powershell.exe"
    this.inputRunner = options.inputRunner ?? runProcessWithInput
    this.access = options.access ?? {}
  }

  get available(): boolean {
    return process.platform === "win32"
  }

  private script(script: string, timeoutMs = WINDOWS_SCRIPT_TIMEOUT_MS): Promise<ProcessResult> {
    return runProcess(
      this.powershell,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      timeoutMs,
    )
  }

  private scriptWithInput(script: string, input: string, timeoutMs = WINDOWS_SCRIPT_TIMEOUT_MS): Promise<ProcessResult> {
    return this.inputRunner(
      this.powershell,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      input,
      timeoutMs,
    )
  }

  async observe(request?: { applicationId?: string }): Promise<Observation> {
    const result = await this.script(observeScript(request?.applicationId), WINDOWS_OBSERVE_TIMEOUT_MS)
    const parsed = parseWindowsObservation(result.stdout)
    return {
      id: `windows-${Date.now().toString(36)}`,
      timestamp: Date.now(),
      computer: await this.info(),
      environment: { platform: "windows", os: "win32", architecture: process.arch, backend: "windows-uia" },
      elements: parsed.elements,
      capabilities: { accessibility: parsed.error === undefined ? "available" : "degraded" },
      ...(parsed.error === undefined ? {} : { warnings: [parsed.error] }),
    }
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

  private async elementCenter(elementId: string): Promise<{ x: number; y: number } | undefined> {
    const script = elementCenterScript(elementId)
    if (script === undefined) return undefined
    const result = await this.script(script)
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

  private async elementAction(
    elementId: string,
    pattern: "invoke" | "focus" | "select" | "toggle" | "expand" | "collapse" | "close" | "setvalue",
    value?: string,
  ): Promise<ActionResult> {
    const script = elementPatternScript(elementId, pattern, value)
    if (script === undefined) {
      return { success: false, status: "rejected", message: `Element ${elementId} is not a Windows UIA element.` }
    }
    const result = await this.script(script)
    if (result.stdout.trim() === "null") {
      return { success: false, status: "rejected", message: `Element ${elementId} is not in the current UI tree.` }
    }
    if (result.code !== 0) {
      return {
        success: false,
        status: "failed",
        message: result.stderr.trim() || `The Windows UIA ${pattern} action failed.`,
      }
    }
    return { success: true, status: "success", message: `Ran ${pattern} on ${elementId}.` }
  }

  async execute(action: ComputerAction): Promise<ActionResult> {
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
      if (elementId !== undefined) {
        const closed = await this.elementAction(elementId, "close")
        if (closed.success) return { ...closed, observation: await this.observe() }
      }
      return { success: false, status: "unavailable", message: "Closing needs a window target on Windows." }
    }
    if (action.type === "copy") {
      const script = keyboardScript("ctrl+c")
      if (script !== undefined) await this.script(script)
      return { success: true, status: "success", message: "Copied." }
    }
    if (action.type === "paste") {
      if (action.text.length > 0) {
        const written = await this.writeClipboard(action.text)
        if (!written.success) return written
      }
      const script = keyboardScript("ctrl+v")
      if (script !== undefined) await this.script(script)
      return { success: true, status: "success", message: "Pasted." }
    }
    if (action.type === "dismiss") {
      const script = keyboardScript("escape")
      if (script !== undefined) await this.script(script)
      return { success: true, status: "success", message: "Dismissed." }
    }
    if (action.type === "key" || action.type === "keypress") {
      const keys = action.key ?? (action.type === "key" ? action.keys : undefined)
      if (typeof keys !== "string" || keys.length === 0) {
        return { success: false, status: "unavailable", message: "The key action requires a key." }
      }
      const script = keyboardScript(keys)
      if (script === undefined) {
        return { success: false, status: "rejected", message: `The key ${keys} is not supported on Windows.` }
      }
      const result = await this.script(script)
      if (result.code !== 0) return { success: false, status: "failed", message: result.stderr.trim() || "Windows key event failed." }
      return { success: true, status: "success", message: `Pressed ${keys}.` }
    }
    if (action.type === "press_keys" || action.type === "press") {
      const script = keyboardScript(action.keys)
      if (script === undefined) return { success: false, status: "rejected", message: "The key combination is not supported." }
      const result = await this.script(script)
      if (result.code !== 0) return { success: false, status: "failed", message: result.stderr.trim() || "Windows key event failed." }
      return { success: true, status: "success", message: `Pressed ${action.keys}.` }
    }
    if (action.type === "type") {
      const target = action.target
      if (target !== undefined && typeof target === "object" && target.kind === "element") {
        const focused = await this.elementAction(target.elementId, "focus")
        if (!focused.success) return focused
      }
      const result = await this.scriptWithInput(typeScript(), action.text)
      if (result.code !== 0) {
        return { success: false, status: "failed", message: result.stderr.trim() || "Windows typing failed." }
      }
      return { success: true, status: "success", message: `Typed ${action.text.length} characters.`, observation: await this.observe() }
    }
    if (action.type === "setvalue") {
      const target = action.target
      if (target === undefined || typeof target !== "object" || target.kind !== "element") {
        return { success: false, status: "unavailable", message: "Setting a value needs an element target on Windows." }
      }
      const result = await this.elementAction(target.elementId, "setvalue", String(action.value))
      if (!result.success) return result
      return { ...result, observation: await this.observe() }
    }
    if (action.type === "focus") {
      const target = action.target
      if (target === undefined || typeof target !== "object" || target.kind !== "element") {
        return { success: false, status: "unavailable", message: "Focusing needs an element target." }
      }
      const result = await this.elementAction(target.elementId, "focus")
      if (!result.success) return result
      return { ...result, observation: await this.observe() }
    }
    if (action.type === "click" || action.type === "doubleclick" || action.type === "rightclick") {
      const target = action.target
      if (target !== undefined && typeof target === "object" && target.kind === "element") {
        const invoked = await this.elementAction(target.elementId, "invoke")
        if (invoked.success) return { ...invoked, observation: await this.observe() }
      }
      const point = await this.pointOf(action)
      if (point === undefined) {
        return { success: false, status: "rejected", message: `${action.type} needs a point or an element with bounds.` }
      }
      const kind = action.type === "doubleclick" ? "double" : action.type === "rightclick" ? "right" : "click"
      const result = await this.script(mouseScript(kind, point.x, point.y))
      if (result.code !== 0) return { success: false, status: "failed", message: "Windows pointer input failed." }
      return { success: true, status: "success", message: `${kind} at ${Math.round(point.x)},${Math.round(point.y)}.`, observation: await this.observe() }
    }
    if (action.type === "move") {
      const point = await this.pointOf(action)
      if (point === undefined) return { success: false, status: "rejected", message: "A move action needs a target." }
      const result = await this.script(mouseScript("move", point.x, point.y))
      if (result.code !== 0) return { success: false, status: "failed", message: "Windows pointer input failed." }
      return { success: true, status: "success", message: `Moved the pointer to ${Math.round(point.x)},${Math.round(point.y)}.` }
    }
    if (action.type === "scroll") {
      const point = await this.pointOf(action)
      const direction = action.direction ?? "down"
      // Mouse wheel deltas are signed 32-bit DWORDs; clamp the line count so
      // amount * 120 cannot overflow the wParam and wrap to a huge value.
      const amount = Math.max(1, Math.min(120, Math.abs(action.amount ?? 3)))
      const data = direction === "up" ? amount * 120 : direction === "down" ? -amount * 120 : 0
      if (point !== undefined) {
        await this.script(mouseScript("move", point.x, point.y))
      }
      const result = await this.script(mouseScript("wheel", point?.x, point?.y, data))
      if (result.code !== 0) return { success: false, status: "failed", message: "Windows scroll failed." }
      return { success: true, status: "success", message: `Scrolled ${direction}.`, observation: await this.observe() }
    }
    if (action.type === "drag") {
      const from = await this.pointOf({ type: "move", target: action.from } as ComputerAction)
      const to = await this.pointOf({ type: "move", target: action.to } as ComputerAction)
      if (from === undefined || to === undefined) {
        return { success: false, status: "rejected", message: "A drag action needs two resolvable targets." }
      }
      const result = await this.script(dragScript(from, to))
      if (result.code !== 0) return { success: false, status: "failed", message: "Windows drag failed." }
      return { success: true, status: "success", message: "Dragged.", observation: await this.observe() }
    }
    return { success: false, status: "unavailable", message: `Action ${action.type} is not supported on Windows.` }
  }

  async pointerPosition(): Promise<ActionResult & { x?: number; y?: number; held?: boolean }> {
    const result = await this.script(pointerPositionScript())
    try {
      const parsed = JSON.parse(result.stdout.trim()) as { x?: unknown; y?: unknown }
      if (typeof parsed.x !== "number" || typeof parsed.y !== "number") throw new Error("missing")
      return { success: true, status: "success", message: `The pointer is at ${parsed.x},${parsed.y}.`, x: parsed.x, y: parsed.y, held: false }
    } catch {
      return { success: false, status: "unavailable", message: "This Windows runtime cannot read the pointer." }
    }
  }

  async hoverPointer(x: number, y: number, holdMs = 600): Promise<ActionResult> {
    const result = await this.script(mouseScript("move", x, y))
    if (result.code !== 0) return { success: false, status: "failed", message: "Windows pointer input failed." }
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, holdMs)))
    return { success: true, status: "success", message: `Hovered at ${Math.round(x)},${Math.round(y)}.` }
  }

  async mouseDown(): Promise<ActionResult> {
    const result = await this.script(mouseScript("down"))
    return result.code === 0
      ? { success: true, status: "success", message: "Held the mouse button." }
      : { success: false, status: "failed", message: "Windows pointer input failed." }
  }

  async mouseUp(): Promise<ActionResult> {
    const result = await this.script(mouseScript("up"))
    return result.code === 0
      ? { success: true, status: "success", message: "Released the mouse button." }
      : { success: false, status: "failed", message: "Windows pointer input failed." }
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
    return { success: true, status: "success", message: `Read ${text.length} characters.`, text, length: text.length, hash: hashText(text) }
  }

  async readClipboard(): Promise<ActionResult & { text?: string; length?: number; hash?: string }> {
    const denial = allowCapability(this.access, "clipboard")
    if (denial !== undefined) return denial
    const result = await this.script("Get-Clipboard -Raw")
    const text = result.stdout.replace(/\r?\n$/, "")
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
    const denial = allowCapability(this.access, "clipboard")
    if (denial !== undefined) return denial
    const result = await this.scriptWithInput(WINDOWS_CLIPBOARD_SET_SCRIPT, text)
    if (result.code !== 0) return { success: false, status: "failed", message: "Writing the Windows clipboard failed." }
    return { success: true, status: "success", message: `Wrote ${text.length} characters to the clipboard.` }
  }

  async screenshot(): Promise<ActionResult> {
    const path = join(tmpdir(), `omnia-windows-${Date.now().toString(36)}.png`)
    const result = await this.script(screenshotScript(path), 30000)
    if (result.code !== 0) {
      return { success: false, status: "failed", message: result.stderr.trim() || "Windows screen capture failed." }
    }
    return { success: true, status: "success", message: "Captured the screen.", metadata: { path } }
  }

  async launchApp(applicationId: string): Promise<ActionResult> {
    const result = await this.script(`Start-Process -FilePath '${applicationId.replace(/'/g, "''")}'`)
    if (result.code !== 0) {
      return { success: false, status: "failed", message: result.stderr.trim() || `Could not launch ${applicationId}.` }
    }
    return { success: true, status: "success", message: `Launched ${applicationId}.`, observation: await this.observe().catch(() => undefined) }
  }

  async openTarget(target: string): Promise<ActionResult> {
    const result = await this.script(`Start-Process '${target.replace(/'/g, "''")}'`)
    if (result.code !== 0) return { success: false, status: "failed", message: `Could not open ${target}.` }
    return { success: true, status: "success", message: `Opened ${target}.` }
  }

  async releaseStuckKeys(): Promise<ActionResult> {
    const script = `
${INPUT_PREAMBLE}
foreach ($vk in @(0x11, 0x10, 0x12, 0x5b)) { [OmniaInput]::keybd_event([byte]$vk, 0, 2, [UIntPtr]::Zero) }
'{"ok":true}'
`
    const result = await this.script(script)
    return result.code === 0
      ? { success: true, status: "success", message: "Released modifier keys." }
      : { success: false, status: "failed", message: "Releasing modifier keys failed." }
  }

  async runCommand(request: CommandRequest): Promise<ActionResult & { command?: CommandResult }> {
    // Before anything is spawned: a free-plan paired computer never gets as far
    // as a PowerShell process.
    const denial = allowCapability(this.access, "remote_shell")
    if (denial !== undefined) return denial
    return executeShellCommand(request, {
      file: this.powershell,
      args: (command) => ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
    })
  }

  async info(): Promise<ComputerInfo> {
    return {
      id: this.id,
      name: "Windows host",
      platform: "windows",
      os: "win32",
      architecture: process.arch,
      backend: "windows-uia",
      connected: true,
    }
  }

  capabilities(): CapabilitySupport[] {
    return [
      {
        capability: "accessibility",
        status: "available",
        score: 0.8,
        reason: "UI Automation trees are read through System.Windows.Automation on the desktop.",
      },
      {
        capability: "keyboard",
        status: "available",
        score: 0.8,
        reason: "keybd_event input works for the interactive desktop session.",
      },
      {
        capability: "pointer",
        status: "available",
        score: 0.8,
        reason: "user32 pointer input works for the interactive desktop session.",
      },
      {
        capability: "direct_ui_control",
        status: "available",
        score: 0.7,
        reason: "Semantic UIA patterns are used first, with pointer and keyboard fallback.",
      },
      { capability: "screen_read", status: "available", score: 0.9, reason: "The screen is captured through System.Drawing." },
      { capability: "launch", status: "available", score: 0.9, reason: "Applications are launched with Start-Process." },
      { capability: "activate", status: "available", score: 0.8, reason: "Windows are activated with SetForegroundWindow." },
      { capability: "clipboard", status: "available", score: 0.9, reason: "Get-Clipboard and Set-Clipboard provide clipboard text." },
      { capability: "shell", status: "available", score: 0.9, reason: "Shell commands run through PowerShell with captured output." },
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

function hashText(text: string): string {
  let hash = 5381
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0
  }
  return (hash >>> 0).toString(16)
}

export function createWindowsHostDriver(options?: WindowsDriverOptions): HostDriver {
  const host = new WindowsHostDriver(options)
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
