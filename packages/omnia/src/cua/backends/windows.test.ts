import { describe, expect, test } from "bun:test"
import type { CuaElement, CuaSnapshot } from "../types"
import {
  buildElementRef,
  buildWindowRef,
  buildWindowsSnapshot,
  canonicalWindowsActions,
  canonicalWindowsRole,
  chooseWindowsPattern,
  createWindowsCuaBackend,
  matchesWaitCondition,
  parseWindowsBackendRef,
  slugify,
  type WindowsRunner,
} from "./windows"
import {
  WINDOWS_OBSERVE_SCRIPT,
  parseWindowsResolvedPayload,
  parseWindowsResultPayload,
  parseWindowsScriptOutput,
  parseWindowsSnapshotPayload,
  windowsKeySpec,
  windowsPointerClickScript,
} from "./windows-script"

const WINDOWS_FIXTURE_JSON = `{
  "windows": [
    {
      "app": "notepad",
      "pid": 4242,
      "title": "Untitled - Notepad",
      "hwnd": 66000,
      "focused": true,
      "node": {
        "runtimeId": "42.1001",
        "index": 0,
        "role": "ControlType.Window",
        "name": "Untitled - Notepad",
        "description": "",
        "value": null,
        "states": ["focused"],
        "patterns": ["Window", "Transform"],
        "editable": false,
        "valuePresent": false,
        "hwnd": 66000,
        "pid": 4242,
        "bounds": { "x": 0, "y": 0, "width": 800, "height": 600 },
        "children": [
          {
            "runtimeId": "42.1002",
            "index": 0,
            "role": "ControlType.Edit",
            "name": "Text editor",
            "value": "hello",
            "states": [],
            "patterns": ["Value", "Text", "Scroll"],
            "editable": true,
            "valuePresent": true,
            "hwnd": 66000,
            "pid": 4242,
            "bounds": { "x": 10, "y": 40, "width": 700, "height": 500 },
            "children": []
          },
          {
            "runtimeId": "42.1003",
            "index": 1,
            "role": "ControlType.Button",
            "name": "Save",
            "value": null,
            "states": [],
            "patterns": ["Invoke", "LegacyIAccessible"],
            "editable": false,
            "valuePresent": false,
            "hwnd": 66000,
            "pid": 4242,
            "bounds": { "x": 10, "y": 10, "width": 80, "height": 24 },
            "children": []
          },
          {
            "runtimeId": "42.1004",
            "index": 2,
            "role": "ControlType.Slider",
            "name": "Zoom",
            "value": "50",
            "minValue": 0,
            "maxValue": 100,
            "stepValue": 10,
            "states": [],
            "patterns": ["RangeValue"],
            "editable": false,
            "valuePresent": true,
            "hwnd": 66000,
            "pid": 4242,
            "bounds": { "x": 100, "y": 560, "width": 200, "height": 24 },
            "children": []
          },
          {
            "runtimeId": "42.1005",
            "index": 3,
            "role": "ControlType.ComboBox",
            "name": "Font",
            "value": null,
            "states": ["collapsed"],
            "patterns": ["ExpandCollapse", "SelectionItem"],
            "editable": false,
            "valuePresent": false,
            "hwnd": 66000,
            "pid": 4242,
            "bounds": { "x": 320, "y": 560, "width": 160, "height": 24 },
            "children": []
          }
        ]
      }
    },
    {
      "app": "secured",
      "pid": 7,
      "title": "Admin Console",
      "hwnd": 0,
      "focused": false,
      "error": "Access is denied",
      "node": null
    }
  ],
  "screen": { "width": 1920, "height": 1080 },
  "truncated": false,
  "errors": [
    {
      "app": "secured",
      "pid": 7,
      "error": "Access is denied. (Exception from HRESULT: 0x80070005 (E_ACCESSDENIED))",
      "exceptionType": "System.Runtime.InteropServices.COMException"
    }
  ]
}`

const RESOLVED_BUTTON = {
  ok: true,
  role: "ControlType.Button",
  name: "Save",
  states: [],
  patterns: ["Invoke", "LegacyIAccessible"],
  editable: false,
  valuePresent: false,
  hwnd: 66000,
  bounds: { x: 10, y: 10, width: 80, height: 24 },
}

const ELEVATED_FAILURE = {
  ok: false,
  error: "Access is denied. (Exception from HRESULT: 0x80070005 (E_ACCESSDENIED))",
  exceptionType: "System.Runtime.InteropServices.COMException",
}

function requireElement(snapshot: CuaSnapshot, name: string): CuaElement {
  const element = snapshot.elements.find((candidate) => candidate.name === name)
  if (element === undefined) throw new Error(`missing element: ${name}`)
  return element
}

type ScriptKind =
  | "probe"
  | "observe"
  | "resolve"
  | "focus"
  | "invoke"
  | "toggle"
  | "select"
  | "expand"
  | "collapse"
  | "set_value"
  | "range"
  | "scroll_into_view"
  | "show_menu"
  | "semantic_scroll"
  | "window"
  | "post_click"
  | "type"
  | "drag"
  | "pointer_scroll"
  | "pointer_click"
  | "key"
  | "unknown"

function scriptKind(script: string): ScriptKind {
  if (script.includes("uia = ($null -ne $root)")) return "probe"
  if (script.includes("Convert-OmniaNode")) return "observe"
  if (script.includes("$info = Get-OmniaInfo $el")) return "resolve"
  if (script.includes("$el.SetFocus()")) return "focus"
  if (script.includes("$method = 'Invoke'")) return "invoke"
  if (script.includes("$method = 'Toggle'")) return "toggle"
  if (script.includes("$method = 'SelectionItem.Select'")) return "select"
  if (script.includes("$method = 'ExpandCollapse.Expand'")) return "expand"
  if (script.includes("$method = 'ExpandCollapse.Collapse'")) return "collapse"
  if (script.includes("$method = 'Value.SetValue'")) return "set_value"
  if (script.includes("$method = 'RangeValue.SetValue'")) return "range"
  if (script.includes("$method = 'ScrollItem.ScrollIntoView'")) return "scroll_into_view"
  if (script.includes("$method = 'LegacyIAccessible.DoDefaultAction'")) return "show_menu"
  if (script.includes("$method = 'Scroll.Scroll'")) return "semantic_scroll"
  if (script.includes("OmniaWindow")) return "window"
  if (script.includes("OmniaPost")) return "post_click"
  if (script.includes("Set-Clipboard")) return "type"
  if (script.includes("$step / 12")) return "drag"
  if (script.includes("0x0800") || script.includes("0x01000")) return "pointer_scroll"
  if (script.includes("mouse_event(0x0002")) return "pointer_click"
  if (script.includes("keybd_event")) return "key"
  return "unknown"
}

type ScriptHandler = (script: string) => unknown

interface FakeRunner {
  runner: WindowsRunner
  calls: string[]
}

function createFakeRunner(handlers: Partial<Record<ScriptKind, ScriptHandler>> = {}): FakeRunner {
  const calls: string[] = []
  const runner: WindowsRunner = async (script) => {
    calls.push(script)
    const kind = scriptKind(script)
    const handler = handlers[kind]
    if (handler !== undefined) return { stdout: JSON.stringify(handler(script)), stderr: "" }
    if (kind === "probe") return { stdout: JSON.stringify({ ok: true, uia: true }), stderr: "" }
    if (kind === "observe") return { stdout: WINDOWS_FIXTURE_JSON, stderr: "" }
    if (kind === "resolve") return { stdout: JSON.stringify(RESOLVED_BUTTON), stderr: "" }
    if (kind === "invoke") return { stdout: JSON.stringify({ ok: true, method: "Invoke" }), stderr: "" }
    if (kind === "range") return { stdout: JSON.stringify({ ok: true, method: "RangeValue.SetValue" }), stderr: "" }
    if (kind === "set_value") {
      return { stdout: JSON.stringify({ ok: true, method: "Value.SetValue" }), stderr: "" }
    }
    if (kind === "focus") return { stdout: JSON.stringify({ ok: true, method: "SetFocus" }), stderr: "" }
    if (kind === "window") {
      return { stdout: JSON.stringify({ ok: true, method: "SetForegroundWindow" }), stderr: "" }
    }
    if (kind === "post_click") return { stdout: JSON.stringify({ ok: true, method: "PostMessage" }), stderr: "" }
    return { stdout: JSON.stringify({ ok: true, method: kind }), stderr: "" }
  }
  return { runner, calls }
}

function createHarness(
  options: {
    handlers?: Partial<Record<ScriptKind, ScriptHandler>>
    allowForeground?: boolean
  } = {},
) {
  const fake = createFakeRunner(options.handlers)
  const backend = createWindowsCuaBackend({
    runner: fake.runner,
    ...(options.allowForeground === true ? { allowForeground: true } : {}),
  })
  return { backend, runner: fake }
}

describe("cua windows refs", () => {
  test("slugifies names deterministically", () => {
    expect(slugify("Save")).toBe("save")
    expect(slugify("  Héllo   Wörld!! ")).toBe("hello-world")
    expect(slugify("")).toBe("unnamed")
  })

  test("builds window and element refs in the documented shape", () => {
    const windowRef = buildWindowRef("notepad", "Untitled - Notepad", 0)
    expect(windowRef).toBe("cua:window/notepad/untitled-notepad/0")
    expect(buildElementRef(windowRef, "button", "Save", 1)).toBe(`${windowRef}/button/save/1`)
  })

  test("parses UIA runtime id backend refs", () => {
    expect(parseWindowsBackendRef("win:42.1002")).toEqual([42, 1002])
    expect(parseWindowsBackendRef("win:7")).toEqual([7])
    expect(parseWindowsBackendRef("mac:42:0")).toBeUndefined()
    expect(parseWindowsBackendRef("win:abc")).toBeUndefined()
    expect(parseWindowsBackendRef("win:")).toBeUndefined()
  })

  test("exposes the observe script constant", () => {
    expect(WINDOWS_OBSERVE_SCRIPT).toContain("Convert-OmniaNode")
    expect(WINDOWS_OBSERVE_SCRIPT).toContain("UIAutomationClient")
  })
})

describe("cua windows role and action mapping", () => {
  test("maps ControlType names to canonical roles", () => {
    expect(canonicalWindowsRole("ControlType.Button")).toBe("button")
    expect(canonicalWindowsRole("ControlType.Edit")).toBe("textbox")
    expect(canonicalWindowsRole("ControlType.Hyperlink")).toBe("link")
    expect(canonicalWindowsRole("ControlType.DataGrid")).toBe("table")
    expect(canonicalWindowsRole("ControlType.DataItem")).toBe("cell")
    expect(canonicalWindowsRole("ControlType.Custom")).toBe("generic")
    expect(canonicalWindowsRole("ControlType.Spinner")).toBe("spinbutton")
    expect(canonicalWindowsRole("ControlType.Mystery")).toBe("generic")
  })

  test("maps UIA patterns to canonical actions in the required order", () => {
    expect(canonicalWindowsActions({ patterns: ["Invoke", "LegacyIAccessible"] })).toEqual([
      "click",
      "focus",
      "show_menu",
    ])
    expect(canonicalWindowsActions({ patterns: ["Value", "Text"], editable: true })).toEqual([
      "set_value",
      "focus",
    ])
    expect(canonicalWindowsActions({ patterns: ["RangeValue"], valuePresent: true })).toEqual([
      "focus",
      "increment",
      "decrement",
    ])
    expect(canonicalWindowsActions({ patterns: ["ExpandCollapse", "SelectionItem"] })).toEqual([
      "focus",
      "select",
      "expand",
      "collapse",
    ])
    expect(canonicalWindowsActions({})).toEqual([])
  })

  test("chooses UIA patterns without silently substituting", () => {
    const button = {
      actions: ["click", "focus", "show_menu"],
      attributes: { uiaPatterns: "Invoke, LegacyIAccessible" },
    }
    expect(chooseWindowsPattern(undefined, button)).toBe("invoke")
    expect(chooseWindowsPattern("show_menu", button)).toBe("show_menu")
    expect(chooseWindowsPattern("collapse", button)).toBeUndefined()
    const edit = {
      actions: ["set_value", "focus"],
      attributes: { uiaPatterns: "Value, Text, Scroll" },
    }
    expect(chooseWindowsPattern("set_value", edit)).toBe("set_value")
    expect(chooseWindowsPattern("invoke", edit)).toBeUndefined()
  })

  test("maps Windows key combinations to virtual keys", () => {
    expect(windowsKeySpec("ctrl+shift+s")).toEqual({ modifiers: [0x11, 0x10], key: 0x53 })
    expect(windowsKeySpec("F5")).toEqual({ modifiers: [], key: 0x74 })
    expect(windowsKeySpec("pagedown")).toEqual({ modifiers: [], key: 0x22 })
    expect(windowsKeySpec("ctrl")).toBeUndefined()
  })

  test("matches wait conditions against element fields", () => {
    const element: CuaElement = {
      ref: "cua:window/notepad/untitled-notepad/0/button/save/0",
      backendRef: "win:42.1003",
      role: "button",
      name: "Save",
      text: "Save the document",
      enabled: true,
      focused: false,
      editable: false,
      actions: ["click"],
      states: ["enabled"],
      generation: 1,
    }
    expect(matchesWaitCondition(element, { role: "ControlType.Button" })).toBe(true)
    expect(matchesWaitCondition(element, { name: "sav" })).toBe(true)
    expect(matchesWaitCondition(element, { text: "document" })).toBe(true)
    expect(matchesWaitCondition(element, { state: "enabled" })).toBe(true)
    expect(matchesWaitCondition(element, { role: "button", name: "Open" })).toBe(false)
  })
})

describe("cua windows parsers", () => {
  test("parses the recorded observe fixture from JSON text", () => {
    const payload = parseWindowsSnapshotPayload(parseWindowsScriptOutput(WINDOWS_FIXTURE_JSON))
    expect(payload?.windows).toHaveLength(2)
    expect(payload?.screen).toEqual({ width: 1920, height: 1080 })
    expect(payload?.truncated).toBe(false)
    expect(payload?.errors).toHaveLength(1)
    expect(payload?.errors[0]).toContain("Access is denied")
    const node = payload?.windows[0]?.node
    expect(node?.role).toBe("ControlType.Window")
    expect(node?.children[0]?.patterns).toContain("Value")
    expect(node?.children[2]?.minValue).toBe(0)
    expect(node?.children[2]?.stepValue).toBe(10)
    expect(node?.children[1]?.hwnd).toBe(66000)
  })

  test("filters malformed nodes and strips the PowerShell BOM", () => {
    const payload = parseWindowsSnapshotPayload(
      parseWindowsScriptOutput('\uFEFF{"windows":[{"app":"x","node":{"runtimeId":"1.2","role":"ControlType.Button"}},null,5]}'),
    )
    expect(payload?.windows).toHaveLength(1)
    expect(parseWindowsSnapshotPayload({ windows: "nope" })).toBeUndefined()
    expect(parseWindowsSnapshotPayload(null)).toBeUndefined()
    expect(parseWindowsScriptOutput("not json")).toBeUndefined()
    expect(parseWindowsScriptOutput("")).toBeUndefined()
  })

  test("parses resolved and result payloads", () => {
    expect(parseWindowsResolvedPayload(RESOLVED_BUTTON)).toMatchObject({
      role: "ControlType.Button",
      name: "Save",
    })
    expect(parseWindowsResolvedPayload({ ok: false, error: "missing" })).toBeUndefined()
    expect(parseWindowsResolvedPayload("nope")).toBeUndefined()
    expect(parseWindowsResultPayload({ ok: true, method: "Invoke" })).toEqual({ ok: true, method: "Invoke" })
    expect(parseWindowsResultPayload(ELEVATED_FAILURE)).toMatchObject({ ok: false, exceptionType: expect.any(String) })
    expect(parseWindowsResultPayload({ method: "Invoke" })).toBeUndefined()
  })
})

describe("cua windows snapshot building", () => {
  test("builds windows, elements, and stable refs from the UIA tree", () => {
    const payload = parseWindowsSnapshotPayload(JSON.parse(WINDOWS_FIXTURE_JSON))
    if (payload === undefined) throw new Error("fixture did not parse")
    const snapshot = buildWindowsSnapshot({
      generation: 3,
      takenAt: 1000,
      windows: payload.windows,
      screen: payload.screen,
      maxElements: 20,
    })
    // A window the UIA tree marks minimized is exposed with the flag so the
    // engine can verify minimize actions.
    const minimized = buildWindowsSnapshot({
      generation: 4,
      takenAt: 1000,
      windows: payload.windows.map((entry) =>
        entry.node === undefined
          ? entry
          : { ...entry, node: { ...entry.node, states: [...entry.node.states, "minimized"] } },
      ),
      screen: payload.screen,
      maxElements: 20,
    })
    expect(minimized.windows[0]?.minimized).toBe(true)
    expect(snapshot.windows[0]?.minimized).toBeUndefined()
    expect(snapshot.id).toBe("cap-3")
    expect(snapshot.platform).toBe("win32")
    expect(snapshot.windows).toHaveLength(1)
    expect(snapshot.windows[0]?.ref).toBe("cua:window/notepad/untitled-notepad/0")
    expect(snapshot.windows[0]?.backendRef).toBe("win:42.1001")
    expect(snapshot.windows[0]?.focused).toBe(true)
    expect(snapshot.warnings.some((warning) => warning.includes("Access is denied"))).toBe(true)

    const save = requireElement(snapshot, "Save")
    expect(save.ref).toBe("cua:window/notepad/untitled-notepad/0/button/save/0")
    expect(save.backendRef).toBe("win:42.1003")
    expect(save.role).toBe("button")
    expect(save.enabled).toBe(true)
    expect(save.focused).toBe(false)
    expect(save.actions).toEqual(["click", "focus", "show_menu"])
    expect(save.attributes?.uiaRole).toBe("ControlType.Button")
    expect(save.attributes?.uiaPatterns).toBe("Invoke, LegacyIAccessible")
    expect(save.attributes?.hwnd).toBe(66000)
    expect(save.bounds).toEqual({ x: 10, y: 10, width: 80, height: 24 })

    const editor = requireElement(snapshot, "Text editor")
    expect(editor.role).toBe("textbox")
    expect(editor.editable).toBe(true)
    expect(editor.value).toBe("hello")
    expect(editor.actions).toContain("set_value")

    const zoom = requireElement(snapshot, "Zoom")
    expect(zoom.attributes?.min).toBe(0)
    expect(zoom.attributes?.max).toBe(100)
    expect(zoom.attributes?.step).toBe(10)
    expect(zoom.actions).toEqual(["focus", "increment", "decrement"])

    const font = requireElement(snapshot, "Font")
    expect(font.states).toContain("collapsed")
    expect(font.actions).toEqual(["focus", "select", "expand", "collapse"])
  })

  test("suffixes occurrences for repeated role and name pairs", () => {
    const parsed = parseWindowsSnapshotPayload(JSON.parse(WINDOWS_FIXTURE_JSON))
    if (parsed === undefined) throw new Error("fixture did not parse")
    parsed.windows[0]?.node?.children.push({
      runtimeId: "42.1999",
      index: 4,
      role: "ControlType.Button",
      name: "Save",
      states: [],
      patterns: ["Invoke"],
      editable: false,
      valuePresent: false,
      children: [],
    })
    const snapshot = buildWindowsSnapshot({
      generation: 1,
      takenAt: 0,
      windows: parsed.windows,
      maxElements: 20,
    })
    const refs = snapshot.elements.filter((element) => element.name === "Save").map((element) => element.ref)
    expect(refs).toEqual([
      "cua:window/notepad/untitled-notepad/0/button/save/0",
      "cua:window/notepad/untitled-notepad/0/button/save/1",
    ])
  })

  test("truncates at maxElements and reports it", () => {
    const parsed = parseWindowsSnapshotPayload(JSON.parse(WINDOWS_FIXTURE_JSON))
    if (parsed === undefined) throw new Error("fixture did not parse")
    const snapshot = buildWindowsSnapshot({
      generation: 2,
      takenAt: 0,
      windows: parsed.windows,
      maxElements: 1,
    })
    expect(snapshot.elements).toHaveLength(1)
    expect(snapshot.truncated).toBe(true)
    expect(snapshot.warnings.some((warning) => warning.includes("truncated"))).toBe(true)
  })
})

describe("cua windows backend with a fake runner", () => {
  test("available tracks the UIA probe", async () => {
    expect(await createHarness().backend.available()).toBe(true)
    const missing = createHarness({ handlers: { probe: () => ({ ok: false, error: "no UIA" }) } })
    expect(await missing.backend.available()).toBe(false)
  })

  test("snapshot wires the observe payload into a capture id", async () => {
    const { backend } = createHarness()
    const snapshot = await backend.snapshot()
    expect(snapshot.id).toBe("cap-1")
    expect(snapshot.windows).toHaveLength(1)
    expect(snapshot.elements.length).toBeGreaterThan(0)
    expect(snapshot.screen).toEqual({ width: 1920, height: 1080 })
    expect(snapshot.warnings.some((warning) => warning.includes("Access is denied"))).toBe(true)
  })

  test("invoke uses the UIA Invoke pattern and reports background delivery", async () => {
    const { backend, runner } = createHarness()
    const snapshot = await backend.snapshot()
    const save = requireElement(snapshot, "Save")
    const result = await backend.execute({ type: "invoke", ref: save.ref })
    expect(result.ok).toBe(true)
    expect(result.delivery).toBe("background-ax")
    expect(result.verified).toBe(true)
    expect(result.error).toBeUndefined()
    expect(runner.calls.filter((script) => scriptKind(script) === "invoke")).toHaveLength(1)
    expect(runner.calls.filter((script) => scriptKind(script) === "pointer_click")).toHaveLength(0)
  })

  test("invoke falls back to a posted background click when no pattern exists", async () => {
    const passive = parseWindowsSnapshotPayload(JSON.parse(WINDOWS_FIXTURE_JSON))
    if (passive === undefined) throw new Error("fixture did not parse")
    const window = passive.windows[0]
    if (window === undefined || window.node === undefined) throw new Error("fixture missing window")
    window.node.children = [
      {
        runtimeId: "42.2000",
        index: 0,
        role: "ControlType.Pane",
        name: "Canvas",
        states: [],
        patterns: [],
        editable: false,
        valuePresent: false,
        hwnd: 66000,
        pid: 4242,
        bounds: { x: 40, y: 40, width: 400, height: 300 },
        children: [],
      },
    ]
    const { backend, runner } = createHarness({
      handlers: {
        observe: () => passive,
        resolve: () => ({
          ok: true,
          role: "ControlType.Pane",
          name: "Canvas",
          states: [],
          patterns: [],
          editable: false,
          valuePresent: false,
          hwnd: 66000,
          bounds: { x: 40, y: 40, width: 400, height: 300 },
        }),
      },
    })
    const snapshot = await backend.snapshot()
    const canvas = requireElement(snapshot, "Canvas")
    const result = await backend.execute({ type: "invoke", ref: canvas.ref })
    expect(result.ok).toBe(true)
    expect(result.delivery).toBe("pointer")
    expect(runner.calls.filter((script) => scriptKind(script) === "post_click")).toHaveLength(1)
    expect(runner.calls.filter((script) => scriptKind(script) === "pointer_click")).toHaveLength(0)
  })

  test("elevated windows refuse background actions", async () => {
    const { backend } = createHarness({
      handlers: {
        resolve: () => ({
          ok: true,
          role: "ControlType.Button",
          name: "Save",
          states: [],
          patterns: ["Invoke"],
          editable: false,
          valuePresent: false,
          hwnd: 66000,
          bounds: { x: 10, y: 10, width: 80, height: 24 },
        }),
        invoke: () => ELEVATED_FAILURE,
      },
    })
    const snapshot = await backend.snapshot()
    const save = requireElement(snapshot, "Save")
    const result = await backend.execute({ type: "invoke", ref: save.ref })
    expect(result.ok).toBe(false)
    expect(result.delivery).toBe("refused")
    expect(result.error?.code).toBe("background_unavailable")
    expect(result.error?.message).toContain("integrity level")
  })

  test("ref drift is a structured target_mismatch refusal", async () => {
    const { backend } = createHarness({
      handlers: { resolve: () => ({ ...RESOLVED_BUTTON, name: "Open" }) },
    })
    const snapshot = await backend.snapshot()
    const save = requireElement(snapshot, "Save")
    const result = await backend.execute({ type: "invoke", ref: save.ref })
    expect(result.ok).toBe(false)
    expect(result.delivery).toBe("refused")
    expect(result.verified).toBe(false)
    expect(result.error?.code).toBe("target_mismatch")
    expect(result.generation).toBe(snapshot.generation)
  })

  test("unknown refs and missing snapshots refuse before delivery", async () => {
    const { backend } = createHarness()
    const missing = await backend.execute({ type: "invoke", ref: "cua:window/notepad/untitled-notepad/0/button/missing/9" })
    expect(missing.error?.code).toBe("no_snapshot")
    await backend.snapshot()
    const stale = await backend.execute({ type: "invoke", ref: "cua:window/notepad/untitled-notepad/0/button/missing/9" })
    expect(stale.error?.code).toBe("stale_ref")
  })

  test("set_value uses Value.SetValue in the background", async () => {
    const { backend, runner } = createHarness({
      handlers: {
        resolve: () => ({
          ok: true,
          role: "ControlType.Edit",
          name: "Text editor",
          states: [],
          patterns: ["Value", "Text"],
          editable: true,
          valuePresent: true,
          hwnd: 66000,
          bounds: { x: 10, y: 40, width: 700, height: 500 },
        }),
      },
    })
    const snapshot = await backend.snapshot()
    const editor = requireElement(snapshot, "Text editor")
    const result = await backend.execute({ type: "set_value", ref: editor.ref, value: "hello" })
    expect(result.ok).toBe(true)
    expect(result.delivery).toBe("background-ax")
    expect(runner.calls.filter((script) => scriptKind(script) === "set_value")).toHaveLength(1)
    expect(runner.calls.filter((script) => scriptKind(script) === "focus")).toHaveLength(0)
  })

  test("set_value refuses instead of stealing focus when fallback is disabled", async () => {
    const { backend, runner } = createHarness({
      handlers: {
        resolve: () => ({
          ok: true,
          role: "ControlType.Edit",
          name: "Text editor",
          states: [],
          patterns: ["Value", "Text"],
          editable: true,
          valuePresent: true,
          hwnd: 66000,
          bounds: { x: 10, y: 40, width: 700, height: 500 },
        }),
        set_value: () => ({ ok: false, error: "read only" }),
      },
    })
    const snapshot = await backend.snapshot()
    const editor = requireElement(snapshot, "Text editor")
    const result = await backend.execute({ type: "set_value", ref: editor.ref, value: "hello" })
    expect(result.ok).toBe(false)
    expect(result.delivery).toBe("refused")
    expect(result.error?.code).toBe("background_unavailable")
    expect(runner.calls.filter((script) => scriptKind(script) === "focus")).toHaveLength(0)
  })

  test("increment uses the RangeValue pattern in the background", async () => {
    const { backend, runner } = createHarness({
      handlers: {
        resolve: () => ({
          ok: true,
          role: "ControlType.Slider",
          name: "Zoom",
          states: [],
          patterns: ["RangeValue"],
          editable: false,
          valuePresent: true,
          minValue: 0,
          maxValue: 100,
          stepValue: 10,
          hwnd: 66000,
          bounds: { x: 100, y: 560, width: 200, height: 24 },
        }),
      },
    })
    const snapshot = await backend.snapshot()
    const zoom = requireElement(snapshot, "Zoom")
    const result = await backend.execute({ type: "increment", ref: zoom.ref })
    expect(result.ok).toBe(true)
    expect(result.delivery).toBe("background-ax")
    expect(runner.calls.filter((script) => scriptKind(script) === "range")).toHaveLength(1)
    expect(runner.calls.filter((script) => scriptKind(script) === "key")).toHaveLength(0)
  })

  test("scroll uses the Scroll pattern in the background when available", async () => {
    const { backend, runner } = createHarness({
      handlers: {
        resolve: () => ({
          ok: true,
          role: "ControlType.Edit",
          name: "Text editor",
          states: [],
          patterns: ["Value", "Text", "Scroll"],
          editable: true,
          valuePresent: true,
          hwnd: 66000,
          bounds: { x: 10, y: 40, width: 700, height: 500 },
        }),
      },
    })
    const snapshot = await backend.snapshot()
    const editor = requireElement(snapshot, "Text editor")
    const result = await backend.execute({ type: "scroll", direction: "down", amount: 2, ref: editor.ref })
    expect(result.ok).toBe(true)
    expect(result.delivery).toBe("background-ax")
    expect(runner.calls.some((script) => script.includes("$vertical = 1"))).toBe(true)
    expect(runner.calls.filter((script) => scriptKind(script) === "pointer_scroll")).toHaveLength(0)
  })

  test("capture ids are validated and one-use for point actions", async () => {
    const { backend } = createHarness()
    const snapshot = await backend.snapshot()
    const stale = await backend.execute({ type: "click", point: { x: 5, y: 5 }, captureId: "cap-nope" })
    expect(stale.ok).toBe(false)
    expect(stale.error?.code).toBe("capture_stale")
    const first = await backend.execute({ type: "click", point: { x: 5, y: 5 }, captureId: snapshot.id })
    expect(first.ok).toBe(true)
    expect(first.delivery).toBe("pointer")
    const second = await backend.execute({ type: "click", point: { x: 5, y: 5 }, captureId: snapshot.id })
    expect(second.ok).toBe(false)
    expect(second.error?.code).toBe("capture_stale")
  })

  test("click validates the point against the snapshot screen", async () => {
    const { backend } = createHarness()
    const snapshot = await backend.snapshot()
    const result = await backend.execute({ type: "click", point: { x: 5000, y: 10 }, captureId: snapshot.id })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe("invalid_point")
  })

  test("window focus uses user32 and reports foreground-ax", async () => {
    const { backend, runner } = createHarness({
      handlers: {
        resolve: () => ({
          ok: true,
          role: "ControlType.Window",
          name: "Untitled - Notepad",
          states: ["focused"],
          patterns: ["Window", "Transform"],
          editable: false,
          valuePresent: false,
          hwnd: 66000,
        }),
      },
    })
    const snapshot = await backend.snapshot()
    const window = snapshot.windows[0]
    if (window === undefined) throw new Error("fixture missing window")
    const result = await backend.execute({ type: "window", action: "focus", ref: window.ref })
    expect(result.ok).toBe(true)
    expect(result.delivery).toBe("foreground-ax")
    expect(runner.calls.filter((script) => scriptKind(script) === "window")).toHaveLength(1)
  })

  test("window ref mismatch is a structured refusal", async () => {
    const { backend } = createHarness({
      handlers: {
        resolve: () => ({
          ok: true,
          role: "ControlType.Window",
          name: "Somewhere else",
          states: [],
          patterns: ["Window"],
          editable: false,
          valuePresent: false,
          hwnd: 66000,
        }),
      },
    })
    const snapshot = await backend.snapshot()
    const window = snapshot.windows[0]
    if (window === undefined) throw new Error("fixture missing window")
    const result = await backend.execute({ type: "window", action: "close", ref: window.ref })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe("target_mismatch")
  })

  test("increment refuses when unfocused and the foreground fallback is off", async () => {
    const { backend, runner } = createHarness()
    const snapshot = await backend.snapshot()
    const save = requireElement(snapshot, "Save")
    const result = await backend.execute({ type: "increment", ref: save.ref })
    expect(result.ok).toBe(false)
    expect(result.delivery).toBe("refused")
    expect(result.error?.code).toBe("background_unavailable")
    expect(runner.calls.filter((script) => scriptKind(script) === "key")).toHaveLength(0)
  })

  test("increment falls back to the arrow key when foreground is allowed", async () => {
    const { backend, runner } = createHarness({ allowForeground: true })
    const snapshot = await backend.snapshot()
    const save = requireElement(snapshot, "Save")
    const result = await backend.execute({ type: "increment", ref: save.ref })
    expect(result.ok).toBe(true)
    expect(result.delivery).toBe("keyboard")
    expect(runner.calls.filter((script) => scriptKind(script) === "focus")).toHaveLength(1)
    expect(runner.calls.filter((script) => scriptKind(script) === "key")).toHaveLength(1)
  })

  test("waitFor requires two consecutive matching snapshots", async () => {
    let taken = 0
    const { backend } = createHarness({
      handlers: {
        observe: () => {
          taken += 1
          return taken >= 3 ? JSON.parse(WINDOWS_FIXTURE_JSON) : { windows: [], truncated: false, errors: [] }
        },
      },
    })
    const result = await backend.waitFor({ name: "Save", timeoutMs: 2000, pollMs: 50 })
    expect(result.ok).toBe(true)
    expect(result.element?.name).toBe("Save")
    expect(taken).toBeGreaterThanOrEqual(4)
  })

  test("waitFor times out cleanly", async () => {
    const { backend } = createHarness({
      handlers: { observe: () => ({ windows: [], truncated: false, errors: [] }) },
    })
    const started = Date.now()
    const result = await backend.waitFor({ name: "Save", timeoutMs: 120, pollMs: 50 })
    expect(result.ok).toBe(false)
    expect(result.element).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(2000)
  })

  test("capabilities are honest about what is available", async () => {
    const { backend } = createHarness()
    const capabilities = await backend.capabilities()
    expect(capabilities).toMatchObject({
      snapshot: true,
      semanticActions: true,
      backgroundActions: true,
      backgroundInput: false,
      pointer: true,
      keyboard: true,
      clipboard: false,
      windowManagement: true,
      waitFor: true,
      refs: true,
    })
    expect(capabilities.actions).toContain("invoke")
    expect(capabilities.actions).toContain("window")
    expect(capabilities.limits.some((limit) => limit.includes("elevated"))).toBe(true)
    expect(capabilities.limits.some((limit) => limit.includes("interactive desktop"))).toBe(true)
  })

  test("backend refuses everything when UIA is unavailable", async () => {
    const { backend } = createHarness({
      handlers: {
        probe: () => ({ ok: false, error: "no UIA" }),
        observe: () => ({ error: "uia_unavailable", message: "no UIA" }),
      },
    })
    expect(await backend.available()).toBe(false)
    const capabilities = await backend.capabilities()
    expect(capabilities.snapshot).toBe(false)
    expect(capabilities.semanticActions).toBe(false)
    expect(capabilities.limits).toContain("no UIA")
    const snapshot = await backend.snapshot()
    expect(snapshot.elements).toHaveLength(0)
    expect(snapshot.warnings).toContain("no UIA")
    const result = await backend.execute({ type: "invoke", ref: "cua:window/x/y/0/button/z/0" })
    expect(result.ok).toBe(false)
    expect(result.delivery).toBe("refused")
    expect(result.error?.code).toBe("backend_unavailable")
  })

  test("refuses stale observation and generation refs instead of rebinding", async () => {
    const { backend, runner } = createHarness()
    const snapshot = await backend.snapshot()
    const save = requireElement(snapshot, "Save")
    const staleObs = await backend.execute({ type: "invoke", ref: save.ref, observationId: "cap-stale" })
    expect(staleObs.ok).toBe(false)
    expect(staleObs.error?.code).toBe("stale_ref")
    const staleGen = await backend.execute({ type: "invoke", ref: save.ref, generation: snapshot.generation + 5 })
    expect(staleGen.ok).toBe(false)
    expect(staleGen.error?.code).toBe("stale_ref")
    expect(runner.calls.filter((script) => scriptKind(script) === "invoke")).toHaveLength(0)
    const bound = await backend.execute({
      type: "invoke",
      ref: save.ref,
      observationId: snapshot.id,
      generation: snapshot.generation,
    })
    expect(bound.ok).toBe(true)
  })

  test("type into a ref refuses instead of using background set_value", async () => {
    const { backend, runner } = createHarness({
      handlers: {
        resolve: () => ({
          ok: true,
          role: "ControlType.Edit",
          name: "Text editor",
          states: [],
          patterns: ["Value", "Text", "Scroll"],
          editable: true,
          valuePresent: true,
          hwnd: 66000,
          bounds: { x: 10, y: 40, width: 700, height: 500 },
        }),
      },
    })
    const snapshot = await backend.snapshot()
    const editor = requireElement(snapshot, "Text editor")
    const result = await backend.execute({ type: "type", text: "hi", ref: editor.ref })
    expect(result.ok).toBe(false)
    expect(result.delivery).toBe("refused")
    expect(result.error?.code).toBe("background_unavailable")
    expect(runner.calls.filter((script) => scriptKind(script) === "set_value")).toHaveLength(0)
    expect(runner.calls.filter((script) => scriptKind(script) === "type")).toHaveLength(0)
  })
})

describe("windows pointer click scripts", () => {
  test("honors the click count for right and middle buttons", () => {
    const right = windowsPointerClickScript({ x: 5, y: 6 }, "right", 3)
    expect(right).toContain("$i -lt 3")
    expect(right).toContain("mouse_event(0x0008")
    expect(right).toContain("mouse_event(0x0010")

    const middle = windowsPointerClickScript({ x: 5, y: 6 }, "middle", 2)
    expect(middle).toContain("$i -lt 2")
    expect(middle).toContain("mouse_event(0x0020")
    expect(middle).toContain("mouse_event(0x0040")

    const left = windowsPointerClickScript({ x: 5, y: 6 }, "left", 4)
    expect(left).toContain("$i -lt 4")
    expect(left).toContain("mouse_event(0x0002")
  })
})
