import type { Bounds, Point } from "../../protocol"

export const WINDOWS_MAX_ELEMENTS = 1000
export const WINDOWS_MAX_DEPTH = 12

export const WINDOWS_UIA_PREAMBLE = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
`

const WINDOWS_HELPERS = `
function Write-OmniaJson($payload) {
  ConvertTo-Json -InputObject $payload -Depth 32 -Compress
}
function Write-OmniaFailure($error) {
  $type = ''
  try { $type = $error.Exception.GetType().FullName } catch {}
  Write-OmniaJson @{ ok = $false; error = [string]$error.Exception.Message; exceptionType = $type }
}
function Get-OmniaPatterns($element) {
  $names = New-Object System.Collections.ArrayList
  try {
    foreach ($pattern in $element.GetSupportedPatterns()) {
      $name = $pattern.ProgrammaticName
      if ($name -like 'InvokePattern*') { [void]$names.Add('Invoke') }
      elseif ($name -like 'TogglePattern*') { [void]$names.Add('Toggle') }
      elseif ($name -like 'SelectionItemPattern*') { [void]$names.Add('SelectionItem') }
      elseif ($name -like 'ExpandCollapsePattern*') { [void]$names.Add('ExpandCollapse') }
      elseif ($name -like 'ValuePattern*') { [void]$names.Add('Value') }
      elseif ($name -like 'RangeValuePattern*') { [void]$names.Add('RangeValue') }
      elseif ($name -like 'ScrollItemPattern*') { [void]$names.Add('ScrollItem') }
      elseif ($name -like 'ScrollPattern*') { [void]$names.Add('Scroll') }
      elseif ($name -like 'WindowPattern*') { [void]$names.Add('Window') }
      elseif ($name -like 'LegacyIAccessiblePattern*') { [void]$names.Add('LegacyIAccessible') }
      elseif ($name -like 'TransformPattern*') { [void]$names.Add('Transform') }
      elseif ($name -like 'GridItemPattern*') { [void]$names.Add('GridItem') }
    }
  } catch {}
  return @($names)
}
function Get-OmniaInfo($element) {
  $current = $element.Current
  $patterns = Get-OmniaPatterns $element
  $value = $null
  $valuePresent = $false
  $editable = $false
  $minValue = $null
  $maxValue = $null
  $stepValue = $null
  if ($patterns -contains 'Value') {
    try {
      $pattern = $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
      if ($null -ne $pattern.Current.Value) { $value = [string]$pattern.Current.Value }
      $valuePresent = $true
      if (-not $pattern.Current.IsReadOnly) { $editable = $true }
    } catch {}
  }
  if ($patterns -contains 'RangeValue') {
    try {
      $pattern = $element.GetCurrentPattern([System.Windows.Automation.RangeValuePattern]::Pattern)
      $minValue = [double]$pattern.Current.Minimum
      $maxValue = [double]$pattern.Current.Maximum
      $stepValue = [double]$pattern.Current.SmallChange
      $valuePresent = $true
      if (-not $pattern.Current.IsReadOnly) { $editable = $true }
      if ($null -eq $value) { $value = [string]$pattern.Current.Value }
    } catch {}
  }
  if ($patterns -contains 'LegacyIAccessible' -and $null -eq $value) {
    try {
      $pattern = $element.GetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern)
      if ($null -ne $pattern.Current.Value) { $value = [string]$pattern.Current.Value }
    } catch {}
  }
  $states = New-Object System.Collections.ArrayList
  try { if ($current.HasKeyboardFocus) { [void]$states.Add('focused') } } catch {}
  try { if (-not $current.IsEnabled) { [void]$states.Add('disabled') } } catch {}
  try { if ($current.IsOffscreen) { [void]$states.Add('offscreen') } } catch {}
  if ($patterns -contains 'SelectionItem') {
    try {
      if ($element.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Current.IsSelected) { [void]$states.Add('selected') }
    } catch {}
  }
  if ($patterns -contains 'Toggle') {
    try {
      $toggleState = $element.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Current.ToggleState
      if ($toggleState -eq [System.Windows.Automation.ToggleState]::On) { [void]$states.Add('checked') }
      elseif ($toggleState -eq [System.Windows.Automation.ToggleState]::Indeterminate) { [void]$states.Add('mixed') }
    } catch {}
  }
  if ($patterns -contains 'ExpandCollapse') {
    try {
      $expandState = $element.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Current.ExpandCollapseState
      if ($expandState -eq [System.Windows.Automation.ExpandCollapseState]::Expanded) { [void]$states.Add('expanded') }
      elseif ($expandState -eq [System.Windows.Automation.ExpandCollapseState]::Collapsed) { [void]$states.Add('collapsed') }
    } catch {}
  }
  if ($patterns -contains 'Window') {
    try {
      $visual = $element.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).Current.WindowVisualState
      if ($visual -eq [System.Windows.Automation.WindowVisualState]::Minimized) { [void]$states.Add('minimized') }
    } catch {}
  }
  $bounds = $null
  $rect = $current.BoundingRectangle
  if ($rect.Width -gt 0 -and $rect.Height -gt 0) {
    $bounds = [ordered]@{ x = [int]$rect.X; y = [int]$rect.Y; width = [int]$rect.Width; height = [int]$rect.Height }
  }
  return [ordered]@{
    role = $current.ControlType.ProgrammaticName
    name = $current.Name
    description = $current.HelpText
    value = $value
    states = @($states)
    patterns = @($patterns)
    editable = $editable
    valuePresent = $valuePresent
    minValue = $minValue
    maxValue = $maxValue
    stepValue = $stepValue
    bounds = $bounds
    automationId = $current.AutomationId
    className = $current.ClassName
    hwnd = [long]$current.NativeWindowHandle
    pid = $current.ProcessId
  }
}
`

export interface WindowsObserveOptions {
  app?: string
  maxElements?: number
  maxDepth?: number
}

export function windowsObserveScript(options: WindowsObserveOptions = {}): string {
  const config = {
    app: options.app ?? null,
    maxElements: options.maxElements ?? WINDOWS_MAX_ELEMENTS,
    maxDepth: options.maxDepth ?? WINDOWS_MAX_DEPTH,
  }
  return `
${WINDOWS_UIA_PREAMBLE}
${WINDOWS_HELPERS}
$config = ConvertFrom-Json '${JSON.stringify(config).replaceAll("'", "''")}'
$maxElements = [int]$config.maxElements
$maxDepth = [int]$config.maxDepth
$filter = $null
if ($null -ne $config.app -and [string]$config.app -ne '') { $filter = ([string]$config.app).ToLower() }
$script:omniaCount = 0
$script:omniaTruncated = $false
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$root = [System.Windows.Automation.AutomationElement]::RootElement
$focusedPid = -1
try { $focusedPid = [System.Windows.Automation.AutomationElement]::FocusedElement.Current.ProcessId } catch {}
function Convert-OmniaNode($element, [int]$index, [int]$depth, [long]$windowHandle) {
  if ($script:omniaCount -ge $maxElements -or $depth -gt $maxDepth) {
    $script:omniaTruncated = $true
    return $null
  }
  $script:omniaCount = $script:omniaCount + 1
  $info = Get-OmniaInfo $element
  if ($info.hwnd -ne 0) { $windowHandle = $info.hwnd }
  $node = [ordered]@{
    runtimeId = ($element.GetRuntimeId() -join '.')
    index = $index
    role = $info.role
    name = $info.name
    description = $info.description
    value = $info.value
    states = $info.states
    patterns = $info.patterns
    editable = $info.editable
    valuePresent = $info.valuePresent
    minValue = $info.minValue
    maxValue = $info.maxValue
    stepValue = $info.stepValue
    bounds = $info.bounds
    automationId = $info.automationId
    className = $info.className
    hwnd = $windowHandle
    pid = $info.pid
    children = @()
  }
  $node.children = New-Object System.Collections.ArrayList
  $child = $walker.GetFirstChild($element)
  $childIndex = 0
  while ($null -ne $child) {
    $childNode = Convert-OmniaNode $child $childIndex ($depth + 1) $windowHandle
    if ($null -ne $childNode) { [void]$node.children.Add($childNode) }
    $childIndex = $childIndex + 1
    $child = $walker.GetNextSibling($child)
  }
  return $node
}
$windows = New-Object System.Collections.ArrayList
$errors = New-Object System.Collections.ArrayList
$window = $walker.GetFirstChild($root)
while ($null -ne $window -and -not $script:omniaTruncated) {
  $app = $null
  $title = $null
  $processId = 0
  try {
    $current = $window.Current
    $title = $current.Name
    $processId = $current.ProcessId
    try { $app = (Get-Process -Id $processId -ErrorAction Stop).ProcessName } catch { $app = $null }
    $matches = ($null -eq $filter)
    if (-not $matches -and $null -ne $app) { $matches = $app.ToLower().Contains($filter) }
    if (-not $matches -and $null -ne $title) { $matches = $title.ToLower().Contains($filter) }
    if ($matches) {
      $node = Convert-OmniaNode $window 0 0 ([long]$current.NativeWindowHandle)
      if ($null -ne $node) {
        [void]$windows.Add([ordered]@{
          app = $app
          pid = $processId
          title = $title
          hwnd = [long]$current.NativeWindowHandle
          focused = ($processId -eq $focusedPid)
          node = $node
        })
      }
    }
  } catch {
    $type = ''
    try { $type = $_.Exception.GetType().FullName } catch {}
    [void]$errors.Add([ordered]@{ app = $app; pid = $processId; error = [string]$_.Exception.Message; exceptionType = $type })
  }
  $window = $walker.GetNextSibling($window)
}
$screen = $null
try {
  Add-Type -AssemblyName System.Windows.Forms
  $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $screen = [ordered]@{ width = [int]$bounds.Width; height = [int]$bounds.Height }
} catch {}
Write-OmniaJson ([ordered]@{ windows = @($windows); screen = $screen; truncated = $script:omniaTruncated; errors = @($errors) })
`
}

export const WINDOWS_OBSERVE_SCRIPT = windowsObserveScript()

export const WINDOWS_PROBE_SCRIPT = `
${WINDOWS_UIA_PREAMBLE}
${WINDOWS_HELPERS}
try {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  Write-OmniaJson @{ ok = $true; uia = ($null -ne $root); children = @() }
} catch {
  Write-OmniaFailure $_
}
`

export function windowsResolveScript(runtimeId: readonly number[]): string {
  return `
${WINDOWS_UIA_PREAMBLE}
${WINDOWS_HELPERS}
try {
  $el = [System.Windows.Automation.AutomationElement]::FromRuntimeId(@(${runtimeId.join(", ")}))
  if ($null -eq $el) {
    Write-OmniaJson @{ ok = $false; error = 'element is not available'; exceptionType = 'Missing' }
  } else {
    $info = Get-OmniaInfo $el
    Write-OmniaJson @{
      ok = $true
      role = $info.role
      name = $info.name
      description = $info.description
      value = $info.value
      states = $info.states
      patterns = $info.patterns
      editable = $info.editable
      valuePresent = $info.valuePresent
      minValue = $info.minValue
      maxValue = $info.maxValue
      stepValue = $info.stepValue
      bounds = $info.bounds
      hwnd = $info.hwnd
      pid = $info.pid
    }
  }
} catch {
  Write-OmniaFailure $_
}
`
}

function powershellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

export function windowsFocusScript(runtimeId: readonly number[]): string {
  return `
${WINDOWS_UIA_PREAMBLE}
${WINDOWS_HELPERS}
try {
  $el = [System.Windows.Automation.AutomationElement]::FromRuntimeId(@(${runtimeId.join(", ")}))
  if ($null -eq $el) {
    Write-OmniaJson @{ ok = $false; error = 'element is not available'; exceptionType = 'Missing' }
  } else {
    $el.SetFocus()
    Write-OmniaJson @{ ok = $true; method = 'SetFocus' }
  }
} catch {
  Write-OmniaFailure $_
}
`
}

export type WindowsPattern =
  | "invoke"
  | "toggle"
  | "select"
  | "expand"
  | "collapse"
  | "set_value"
  | "set_range"
  | "increment"
  | "decrement"
  | "scroll_into_view"
  | "show_menu"
  | "scroll"

export interface WindowsScrollParams {
  direction: "up" | "down" | "left" | "right"
  amount: number
}

export function windowsPatternScript(
  runtimeId: readonly number[],
  pattern: WindowsPattern,
  value?: string,
  scroll?: WindowsScrollParams,
): string {
  const bodies: Record<WindowsPattern, string> = {
    invoke: `
    $pattern = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $pattern.Invoke()
    $method = 'Invoke'`,
    toggle: `
    $pattern = $el.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
    $pattern.Toggle()
    $method = 'Toggle'`,
    select: `
    $pattern = $el.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
    $pattern.Select()
    $method = 'SelectionItem.Select'`,
    expand: `
    $pattern = $el.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
    $pattern.Expand()
    $method = 'ExpandCollapse.Expand'`,
    collapse: `
    $pattern = $el.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
    $pattern.Collapse()
    $method = 'ExpandCollapse.Collapse'`,
    set_value: `
    $pattern = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    $pattern.SetValue(${powershellQuote(value ?? "")})
    $method = 'Value.SetValue'`,
    set_range: `
    $pattern = $el.GetCurrentPattern([System.Windows.Automation.RangeValuePattern]::Pattern)
    $next = [Math]::Min([Math]::Max([double](${powershellQuote(value ?? "0")}), [double]$pattern.Current.Minimum), [double]$pattern.Current.Maximum)
    $pattern.SetValue($next)
    $method = 'RangeValue.SetValue'`,
    increment: `
    $pattern = $el.GetCurrentPattern([System.Windows.Automation.RangeValuePattern]::Pattern)
    $current = [double]$pattern.Current.Value
    $step = [double]$pattern.Current.SmallChange
    if ($step -le 0) { $step = 1 }
    $next = [Math]::Min([Math]::Max($current + $step, [double]$pattern.Current.Minimum), [double]$pattern.Current.Maximum)
    $pattern.SetValue($next)
    $method = 'RangeValue.SetValue'`,
    decrement: `
    $pattern = $el.GetCurrentPattern([System.Windows.Automation.RangeValuePattern]::Pattern)
    $current = [double]$pattern.Current.Value
    $step = [double]$pattern.Current.SmallChange
    if ($step -le 0) { $step = 1 }
    $next = [Math]::Min([Math]::Max($current - $step, [double]$pattern.Current.Minimum), [double]$pattern.Current.Maximum)
    $pattern.SetValue($next)
    $method = 'RangeValue.SetValue'`,
    scroll_into_view: `
    $pattern = $el.GetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern)
    $pattern.ScrollIntoView()
    $method = 'ScrollItem.ScrollIntoView'`,
    show_menu: `
    $pattern = $el.GetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern)
    $pattern.DoDefaultAction()
    $method = 'LegacyIAccessible.DoDefaultAction'`,
    scroll: `
    $pattern = $el.GetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern)
    $vertical = ${scroll?.direction === "up" ? "-1" : scroll?.direction === "down" ? "1" : "0"}
    $horizontal = ${scroll?.direction === "left" ? "-1" : scroll?.direction === "right" ? "1" : "0"}
    $pattern.Scroll($horizontal, $vertical)
    $method = 'Scroll.Scroll'`,
  }
  return `
${WINDOWS_UIA_PREAMBLE}
${WINDOWS_HELPERS}
try {
  $el = [System.Windows.Automation.AutomationElement]::FromRuntimeId(@(${runtimeId.join(", ")}))
  if ($null -eq $el) {
    Write-OmniaJson @{ ok = $false; error = 'element is not available'; exceptionType = 'Missing' }
  } else {${bodies[pattern]}
    Write-OmniaJson @{ ok = $true; method = $method }
  }
} catch {
  Write-OmniaFailure $_
}
`
}

export type WindowsWindowAction = "focus" | "minimize" | "restore" | "close"

export const WINDOWS_WINDOW_PREAMBLE = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class OmniaWindow {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetFocus(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
}
"@
`

export function windowsWindowScript(hwnd: number, action: WindowsWindowAction): string {
  const bodies: Record<WindowsWindowAction, string> = {
    focus: `
  if ([OmniaWindow]::IsIconic($handle)) { [void][OmniaWindow]::ShowWindow($handle, 9) } else { [void][OmniaWindow]::ShowWindow($handle, 5) }
  [void][OmniaWindow]::SetForegroundWindow($handle)
  [void][OmniaWindow]::SetFocus($handle)
  $method = 'SetForegroundWindow'`,
    minimize: `
  [void][OmniaWindow]::ShowWindow($handle, 6)
  $method = 'ShowWindow(SW_MINIMIZE)'`,
    restore: `
  [void][OmniaWindow]::ShowWindow($handle, 9)
  $method = 'ShowWindow(SW_RESTORE)'`,
    close: `
  [void][OmniaWindow]::PostMessage($handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
  $method = 'WM_CLOSE'`,
  }
  return `
$ErrorActionPreference = 'Stop'
${WINDOWS_WINDOW_PREAMBLE}
try {
  $handle = [IntPtr]::new(${Math.round(hwnd)})
  if ($handle -eq [IntPtr]::Zero) { throw 'the window handle is not available' }
${bodies[action]}
  ConvertTo-Json -InputObject @{ ok = $true; method = $method } -Depth 4 -Compress
} catch {
  $type = ''
  try { $type = $_.Exception.GetType().FullName } catch {}
  ConvertTo-Json -InputObject @{ ok = $false; error = [string]$_.Exception.Message; exceptionType = $type } -Depth 4 -Compress
}
`
}

export function windowsPostClickScript(
  hwnd: number,
  point: Point,
  button: "left" | "right" | "middle" = "left",
): string {
  const messages =
    button === "right"
      ? { down: "0x0204", up: "0x0205", wparam: "2" }
      : button === "middle"
        ? { down: "0x0207", up: "0x0208", wparam: "16" }
        : // WM_LBUTTONDOWN carries MK_LBUTTON in wParam; 0 makes some apps
          // treat the press as a move.
          { down: "0x0201", up: "0x0202", wparam: "1" }
  return `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class OmniaPost {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr hWnd, ref POINT lpPoint);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
}
"@
try {
  $handle = [IntPtr]::new(${Math.round(hwnd)})
  if ($handle -eq [IntPtr]::Zero) { throw 'the window handle is not available' }
  $point = [OmniaPost+POINT]::new()
  $point.X = ${Math.round(point.x)}
  $point.Y = ${Math.round(point.y)}
  [void][OmniaPost]::ScreenToClient($handle, [ref]$point)
  $lparam = [IntPtr](($point.Y -shl 16) -bor ($point.X -band 0xFFFF))
  [void][OmniaPost]::PostMessage($handle, ${messages.down}, [IntPtr]${messages.wparam}, $lparam)
  [void][OmniaPost]::PostMessage($handle, ${messages.up}, [IntPtr]${messages.wparam}, $lparam)
  ConvertTo-Json -InputObject @{ ok = $true; method = 'PostMessage' } -Depth 4 -Compress
} catch {
  $type = ''
  try { $type = $_.Exception.GetType().FullName } catch {}
  ConvertTo-Json -InputObject @{ ok = $false; error = [string]$_.Exception.Message; exceptionType = $type } -Depth 4 -Compress
}
`
}

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
  let nonModifierCount = 0
  for (const part of parts) {
    const vk = WINDOWS_VK[part]
    if (vk === undefined) {
      if (part.length === 1) {
        key = part.toUpperCase().charCodeAt(0)
        nonModifierCount += 1
      }
      continue
    }
    if ([0x11, 0x10, 0x12, 0x5b].includes(vk)) {
      modifiers.push(vk)
      continue
    }
    key = vk
    nonModifierCount += 1
  }
  // One keybd_event pair can only express a single non-modifier key; keeping
  // the last one would silently drop the rest of the combination.
  if (nonModifierCount > 1) return undefined
  if (key === undefined) return undefined
  return { modifiers, key }
}

export const WINDOWS_INPUT_PREAMBLE = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class OmniaInput {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
"@
`

export function windowsKeyScript(keys: string): string | undefined {
  const spec = windowsKeySpec(keys)
  if (spec === undefined) return undefined
  const down = spec.modifiers.map((vk) => `[OmniaInput]::keybd_event(${vk}, 0, 0, [UIntPtr]::Zero)`).join("\n")
  const up = [...spec.modifiers]
    .reverse()
    .map((vk) => `[OmniaInput]::keybd_event(${vk}, 0, 2, [UIntPtr]::Zero)`)
    .join("\n")
  return `
$ErrorActionPreference = 'Stop'
${WINDOWS_INPUT_PREAMBLE}
try {
  ${down}
  [OmniaInput]::keybd_event(${spec.key}, 0, 0, [UIntPtr]::Zero)
  [OmniaInput]::keybd_event(${spec.key}, 0, 2, [UIntPtr]::Zero)
  ${up}
  '{"ok":true,"method":"keybd_event"}'
} catch {
  $type = ''
  try { $type = $_.Exception.GetType().FullName } catch {}
  ConvertTo-Json -InputObject @{ ok = $false; error = [string]$_.Exception.Message; exceptionType = $type } -Depth 4 -Compress
}
`
}

export function windowsTypeScript(text: string): string {
  return `
$ErrorActionPreference = 'Stop'
$previous = $null
try { $previous = Get-Clipboard -Raw -ErrorAction SilentlyContinue } catch { $previous = $null }
Set-Clipboard -Value ${powershellQuote(text)}
${WINDOWS_INPUT_PREAMBLE}
try {
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
    if ($null -eq $current -or $current -ne ${powershellQuote(text)}) { break }
    Start-Sleep -Milliseconds 100
  }
  '{"ok":true,"method":"clipboard-paste"}'
} catch {
  $type = ''
  try { $type = $_.Exception.GetType().FullName } catch {}
  ConvertTo-Json -InputObject @{ ok = $false; error = [string]$_.Exception.Message; exceptionType = $type } -Depth 4 -Compress
} finally {
  if ($null -ne $previous) { try { Set-Clipboard -Value $previous } catch {} }
}
`
}

export function windowsPointerClickScript(
  point: Point,
  button: "left" | "right" | "middle" = "left",
  count = 1,
): string {
  const clicks = Math.max(1, Math.round(count))
  const press =
    button === "right"
      ? `for ($i = 0; $i -lt ${clicks}; $i++) { [OmniaInput]::mouse_event(0x0008, 0, 0, 0, [UIntPtr]::Zero); [OmniaInput]::mouse_event(0x0010, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 40 }`
      : button === "middle"
        ? `for ($i = 0; $i -lt ${clicks}; $i++) { [OmniaInput]::mouse_event(0x0020, 0, 0, 0, [UIntPtr]::Zero); [OmniaInput]::mouse_event(0x0040, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 40 }`
        : `for ($i = 0; $i -lt ${clicks}; $i++) { [OmniaInput]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero); [OmniaInput]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 40 }`
  return `
$ErrorActionPreference = 'Stop'
${WINDOWS_INPUT_PREAMBLE}
try {
  [void][OmniaInput]::SetCursorPos(${Math.round(point.x)}, ${Math.round(point.y)})
  ${press}
  '{"ok":true,"method":"mouse_event"}'
} catch {
  $type = ''
  try { $type = $_.Exception.GetType().FullName } catch {}
  ConvertTo-Json -InputObject @{ ok = $false; error = [string]$_.Exception.Message; exceptionType = $type } -Depth 4 -Compress
}
`
}

export function windowsScrollScript(
  direction: "up" | "down" | "left" | "right",
  amount: number,
  point?: Point,
): string {
  // Wheel deltas are signed 32-bit DWORDs; clamp the line count so the
  // multiplication cannot overflow the wParam.
  const lines = Math.max(1, Math.min(100, Math.round(amount)))
  const move =
    point === undefined ? "" : `[void][OmniaInput]::SetCursorPos(${Math.round(point.x)}, ${Math.round(point.y)})`
  const wheelDown = direction === "up" ? 120 * lines : -120 * lines
  const wheelRight = direction === "left" ? -120 * lines : 120 * lines
  const unsigned = (delta: number) => (delta < 0 ? 0x100000000 + delta : delta)
  const wheel =
    direction === "left" || direction === "right"
      ? `[OmniaInput]::mouse_event(0x01000, 0, 0, ${unsigned(wheelRight)}, [UIntPtr]::Zero)`
      : `[OmniaInput]::mouse_event(0x0800, 0, 0, ${unsigned(wheelDown)}, [UIntPtr]::Zero)`
  return `
$ErrorActionPreference = 'Stop'
${WINDOWS_INPUT_PREAMBLE}
try {
  ${move}
  ${wheel}
  '{"ok":true,"method":"mouse_event"}'
} catch {
  $type = ''
  try { $type = $_.Exception.GetType().FullName } catch {}
  ConvertTo-Json -InputObject @{ ok = $false; error = [string]$_.Exception.Message; exceptionType = $type } -Depth 4 -Compress
}
`
}

export function windowsDragScript(from: Point, to: Point): string {
  return `
$ErrorActionPreference = 'Stop'
${WINDOWS_INPUT_PREAMBLE}
try {
  [void][OmniaInput]::SetCursorPos(${Math.round(from.x)}, ${Math.round(from.y)})
  [OmniaInput]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 60
  for ($step = 1; $step -le 12; $step++) {
    $x = [int](${Math.round(from.x)} + (${Math.round(to.x)} - ${Math.round(from.x)}) * ($step / 12))
    $y = [int](${Math.round(from.y)} + (${Math.round(to.y)} - ${Math.round(from.y)}) * ($step / 12))
    [void][OmniaInput]::SetCursorPos($x, $y)
    Start-Sleep -Milliseconds 15
  }
  [OmniaInput]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  '{"ok":true,"method":"mouse_event"}'
} catch {
  $type = ''
  try { $type = $_.Exception.GetType().FullName } catch {}
  ConvertTo-Json -InputObject @{ ok = $false; error = [string]$_.Exception.Message; exceptionType = $type } -Depth 4 -Compress
}
`
}

export interface WindowsElementSnapshot {
  runtimeId: string
  index: number
  role: string
  name?: string
  description?: string
  value?: string
  states: string[]
  patterns: string[]
  editable: boolean
  valuePresent: boolean
  minValue?: number
  maxValue?: number
  stepValue?: number
  bounds?: Bounds
  automationId?: string
  className?: string
  hwnd?: number
  pid?: number
  children: WindowsElementSnapshot[]
}

export interface WindowsWindowSnapshot {
  app?: string
  pid?: number
  title?: string
  hwnd?: number
  focused?: boolean
  error?: string
  node?: WindowsElementSnapshot
}

export interface WindowsSnapshotPayload {
  windows: WindowsWindowSnapshot[]
  screen?: { width: number; height: number }
  truncated: boolean
  errors: string[]
}

export interface WindowsResolvedPayload {
  role: string
  name?: string
  description?: string
  value?: string
  states: string[]
  patterns: string[]
  editable: boolean
  valuePresent: boolean
  minValue?: number
  maxValue?: number
  stepValue?: number
  bounds?: Bounds
  hwnd?: number
  pid?: number
}

export interface WindowsResultPayload {
  ok: boolean
  error?: string
  exceptionType?: string
  method?: string
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

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

export function parseWindowsBounds(value: unknown): Bounds | undefined {
  if (!isRecord(value)) return undefined
  const x = finiteNumber(value.x)
  const y = finiteNumber(value.y)
  const width = finiteNumber(value.width)
  const height = finiteNumber(value.height)
  if (x === undefined || y === undefined || width === undefined || height === undefined) return undefined
  return { x, y, width, height }
}

function parseWindowsNode(value: unknown): WindowsElementSnapshot | undefined {
  if (!isRecord(value)) return undefined
  const runtimeId = optionalString(value.runtimeId)
  if (runtimeId === undefined || runtimeId.length === 0) return undefined
  const bounds = parseWindowsBounds(value.bounds)
  const name = optionalString(value.name)
  const description = optionalString(value.description)
  const elementValue = optionalString(value.value)
  const automationId = optionalString(value.automationId)
  const className = optionalString(value.className)
  const minValue = finiteNumber(value.minValue)
  const maxValue = finiteNumber(value.maxValue)
  const stepValue = finiteNumber(value.stepValue)
  const hwnd = finiteNumber(value.hwnd)
  const pid = finiteNumber(value.pid)
  return {
    runtimeId,
    index: Math.trunc(finiteNumber(value.index) ?? 0),
    role: typeof value.role === "string" && value.role.length > 0 ? value.role : "unknown",
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    ...(elementValue === undefined ? {} : { value: elementValue }),
    states: stringArray(value.states),
    patterns: stringArray(value.patterns),
    editable: value.editable === true,
    valuePresent: value.valuePresent === true,
    ...(minValue === undefined ? {} : { minValue }),
    ...(maxValue === undefined ? {} : { maxValue }),
    ...(stepValue === undefined ? {} : { stepValue }),
    ...(bounds === undefined ? {} : { bounds }),
    ...(automationId === undefined ? {} : { automationId }),
    ...(className === undefined ? {} : { className }),
    ...(hwnd === undefined ? {} : { hwnd }),
    ...(pid === undefined ? {} : { pid }),
    children: Array.isArray(value.children)
      ? value.children.flatMap((child): WindowsElementSnapshot[] => {
          const parsed = parseWindowsNode(child)
          return parsed === undefined ? [] : [parsed]
        })
      : [],
  }
}

export function parseWindowsScriptOutput(text: string): unknown {
  const trimmed = text.replace(/^\uFEFF/, "").trim()
  if (trimmed.length === 0) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

export function parseWindowsSnapshotPayload(value: unknown): WindowsSnapshotPayload | undefined {
  if (!isRecord(value) || !Array.isArray(value.windows)) return undefined
  const windows = value.windows.flatMap((window): WindowsWindowSnapshot[] => {
    if (!isRecord(window)) return []
    const app = optionalString(window.app)
    const title = optionalString(window.title)
    const error = optionalString(window.error)
    const pid = finiteNumber(window.pid)
    const hwnd = finiteNumber(window.hwnd)
    const node = window.node === undefined || window.node === null ? undefined : parseWindowsNode(window.node)
    return [
      {
        ...(app === undefined ? {} : { app }),
        ...(pid === undefined ? {} : { pid }),
        ...(title === undefined ? {} : { title }),
        ...(hwnd === undefined ? {} : { hwnd }),
        focused: window.focused === true,
        ...(error === undefined ? {} : { error }),
        ...(node === undefined ? {} : { node }),
      },
    ]
  })
  const rawScreen = isRecord(value.screen) ? value.screen : undefined
  const width = rawScreen === undefined ? undefined : finiteNumber(rawScreen.width)
  const height = rawScreen === undefined ? undefined : finiteNumber(rawScreen.height)
  const screen = width !== undefined && height !== undefined ? { width, height } : undefined
  const errors = Array.isArray(value.errors)
    ? value.errors.flatMap((error): string[] => {
        if (typeof error === "string") return [error]
        if (isRecord(error) && typeof error.error === "string") {
          const app = optionalString(error.app)
          return [`${app ?? "a window"} could not be read: ${error.error}`]
        }
        return []
      })
    : []
  return {
    windows,
    ...(screen === undefined ? {} : { screen }),
    truncated: value.truncated === true,
    errors,
  }
}

export function parseWindowsResolvedPayload(value: unknown): WindowsResolvedPayload | undefined {
  if (!isRecord(value) || value.ok !== true) return undefined
  if (typeof value.role !== "string" || value.role.length === 0) return undefined
  const bounds = parseWindowsBounds(value.bounds)
  const name = optionalString(value.name)
  const description = optionalString(value.description)
  const elementValue = optionalString(value.value)
  const minValue = finiteNumber(value.minValue)
  const maxValue = finiteNumber(value.maxValue)
  const stepValue = finiteNumber(value.stepValue)
  const hwnd = finiteNumber(value.hwnd)
  const pid = finiteNumber(value.pid)
  return {
    role: value.role,
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    ...(elementValue === undefined ? {} : { value: elementValue }),
    states: stringArray(value.states),
    patterns: stringArray(value.patterns),
    editable: value.editable === true,
    valuePresent: value.valuePresent === true,
    ...(minValue === undefined ? {} : { minValue }),
    ...(maxValue === undefined ? {} : { maxValue }),
    ...(stepValue === undefined ? {} : { stepValue }),
    ...(bounds === undefined ? {} : { bounds }),
    ...(hwnd === undefined ? {} : { hwnd }),
    ...(pid === undefined ? {} : { pid }),
  }
}

export function parseWindowsResultPayload(value: unknown): WindowsResultPayload | undefined {
  if (!isRecord(value) || typeof value.ok !== "boolean") return undefined
  const error = optionalString(value.error)
  const exceptionType = optionalString(value.exceptionType)
  const method = optionalString(value.method)
  return {
    ok: value.ok,
    ...(error === undefined ? {} : { error }),
    ...(exceptionType === undefined ? {} : { exceptionType }),
    ...(method === undefined ? {} : { method }),
  }
}
