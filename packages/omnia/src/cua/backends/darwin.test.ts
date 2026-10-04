import { describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CuaElement, CuaSnapshot } from "../types"
import {
  buildDarwinSnapshot,
  buildElementRef,
  buildWindowRef,
  canonicalDarwinActions,
  canonicalDarwinRole,
  chooseDarwinAction,
  createDarwinCuaBackend,
  DARWIN_NATIVE_SNAPSHOT_BUDGET_MS,
  DARWIN_NATIVE_SNAPSHOT_TIMEOUT_MS,
  matchesWaitCondition,
  parseDarwinBackendRef,
  slugify,
  type DarwinNativeBridge,
  type DarwinRunner,
} from "./darwin"
import { DARWIN_AX_HELPER } from "./darwin-ax"
import {
  DARWIN_PERMISSION_WARNING,
  darwinClickScript,
  darwinKeyBody,
  parseDarwinResolvedPayload,
  parseDarwinResultPayload,
  parseDarwinScriptOutput,
  parseDarwinSnapshotPayload,
} from "./darwin-script"

const DARWIN_FIXTURE_JSON = `{
  "applications": [
    {
      "name": "TextEdit",
      "pid": 4242,
      "nodes": [
        {
          "index": 0,
          "role": "AXWindow",
          "name": "Untitled",
          "description": "",
          "value": null,
          "states": ["focused"],
          "actions": ["AXRaise"],
          "bounds": { "x": 0, "y": 0, "width": 800, "height": 600 },
          "editable": false,
          "valuePresent": false,
          "children": [
            {
              "index": 0,
              "role": "AXButton",
              "name": "Export",
              "description": "Export the document",
              "value": null,
              "states": ["enabled"],
              "actions": ["AXPress", "AXFocus", "AXScrollToVisible"],
              "bounds": { "x": 10, "y": 20, "width": 80, "height": 24 },
              "editable": false,
              "valuePresent": false,
              "children": []
            },
            {
              "index": 1,
              "role": "AXTextField",
              "name": "Search",
              "description": "Search field",
              "value": "hello",
              "placeholder": "Search the web",
              "states": ["enabled", "focused"],
              "actions": ["AXConfirm", "AXSetValue", "AXFocus"],
              "bounds": { "x": 100, "y": 20, "width": 200, "height": 24 },
              "editable": true,
              "valuePresent": true,
              "children": []
            },
            {
              "index": 2,
              "role": "AXSlider",
              "name": "Volume",
              "value": "40",
              "minValue": 0,
              "maxValue": 100,
              "stepValue": 5,
              "states": ["enabled"],
              "actions": ["AXIncrement", "AXDecrement"],
              "bounds": { "x": 100, "y": 60, "width": 200, "height": 24 },
              "editable": false,
              "valuePresent": true,
              "children": []
            },
            {
              "index": 3,
              "role": "AXPopUpButton",
              "name": "Zoom",
              "states": ["enabled", "collapsed"],
              "actions": ["AXShowMenu", "AXExpand"],
              "bounds": { "x": 320, "y": 20, "width": 120, "height": 24 },
              "editable": false,
              "valuePresent": false,
              "children": []
            }
          ]
        }
      ]
    },
    { "name": "Locked", "pid": 9, "error": "access denied", "nodes": [] }
  ],
  "screen": { "width": 1920, "height": 1080 },
  "truncated": false
}`

const RESOLVED_BUTTON = {
  ok: true,
  role: "AXButton",
  name: "Export",
  states: ["enabled"],
  actions: ["AXPress", "AXFocus"],
  editable: false,
  valuePresent: false,
  bounds: { x: 10, y: 20, width: 80, height: 24 },
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
  | "action"
  | "set_value"
  | "value_step"
  | "focus"
  | "window"
  | "type"
  | "key"
  | "click"
  | "scroll"
  | "drag"
  | "secure"
  | "unknown"

function scriptKind(script: string): ScriptKind {
  if (script.includes("CGSSessionSecureInputPID")) return "secure"
  if (script.includes("processes: processes.length")) return "probe"
  if (script.includes("omniaWalk(")) return "observe"
  if (script.includes("element.value = attempts[i]")) return "set_value"
  if (script.includes("var current = Number(info.value)")) return "value_step"
  if (script.includes("'AXFocused', true")) return "focus"
  if (script.includes("var target = windows[")) return "window"
  if (script.includes("var info = omniaElementInfo(element)")) return "resolve"
  if (script.includes("var result = omniaPerform(se, element,")) return "action"
  if (script.includes("se.keystroke(")) return "type"
  if (script.includes("se.keyCode(")) return "key"
  if (
    script.includes("kCGEventLeftMouseDown") ||
    script.includes("kCGEventRightMouseDown") ||
    script.includes("kCGEventOtherMouseDown")
  ) {
    return "click"
  }
  if (script.includes("CGEventCreateScrollWheelEvent")) return "scroll"
  if (script.includes("kCGEventLeftMouseDragged")) return "drag"
  return "unknown"
}

type ScriptHandler = (script: string) => unknown

interface FakeRunner {
  runner: DarwinRunner
  calls: string[]
}

function createFakeRunner(handlers: Partial<Record<ScriptKind, ScriptHandler>> = {}): FakeRunner {
  const calls: string[] = []
  const runner: DarwinRunner = async (script) => {
    calls.push(script)
    const kind = scriptKind(script)
    const handler = handlers[kind]
    if (handler !== undefined) return { stdout: JSON.stringify(handler(script)), stderr: "" }
    if (kind === "probe") return { stdout: JSON.stringify({ ok: true, processes: 3 }), stderr: "" }
    if (kind === "observe") return { stdout: DARWIN_FIXTURE_JSON, stderr: "" }
    if (kind === "resolve") return { stdout: JSON.stringify(RESOLVED_BUTTON), stderr: "" }
    if (kind === "action") return { stdout: JSON.stringify({ ok: true, method: "perform" }), stderr: "" }
    if (kind === "set_value") {
      return { stdout: JSON.stringify({ ok: true, method: "value", value: "hello" }), stderr: "" }
    }
    if (kind === "value_step") return { stdout: JSON.stringify({ ok: true, method: "value" }), stderr: "" }
    if (kind === "focus") return { stdout: JSON.stringify({ ok: true, method: "focused" }), stderr: "" }
    if (kind === "window") return { stdout: JSON.stringify({ ok: true, method: "raise" }), stderr: "" }
    if (kind === "secure") return { stdout: JSON.stringify({ ok: true, secureInput: false }), stderr: "" }
    if (kind === "type" || kind === "key" || kind === "click" || kind === "scroll" || kind === "drag") {
      return { stdout: JSON.stringify({ ok: true }), stderr: "" }
    }
    return { stdout: JSON.stringify({ ok: false, error: `unsupported ${kind}` }), stderr: "" }
  }
  return { runner, calls }
}

interface NativeCall {
  command: string
  params: Record<string, unknown>
}

type NativeHandler = (params: Record<string, unknown>) => unknown

function createNativeBridge(handlers: Partial<Record<string, NativeHandler>> = {}) {
  const calls: NativeCall[] = []
  const bridge: DarwinNativeBridge = {
    exec: (command, params) => {
      calls.push({ command, params })
      const handler = handlers[command]
      return Promise.resolve(handler === undefined ? undefined : handler(params))
    },
  }
  return { bridge, calls }
}

function fixtureNativePayload() {
  const parsed = parseDarwinSnapshotPayload(JSON.parse(DARWIN_FIXTURE_JSON))
  if (parsed === undefined) throw new Error("fixture did not parse")
  return { ok: true, applications: parsed.applications, screen: parsed.screen, truncated: false }
}

function createHarness(
  options: {
    handlers?: Partial<Record<ScriptKind, ScriptHandler>>
    allowForeground?: boolean
  } = {},
) {
  const fake = createFakeRunner(options.handlers)
  const backend = createDarwinCuaBackend({
    runner: fake.runner,
    ...(options.allowForeground === true ? { allowForeground: true } : {}),
  })
  return { backend, runner: fake }
}

describe("cua darwin refs", () => {
  test("slugifies names deterministically", () => {
    expect(slugify("Export")).toBe("export")
    expect(slugify("  Héllo   Wörld!! ")).toBe("hello-world")
    expect(slugify("")).toBe("unnamed")
    expect(slugify("---")).toBe("unnamed")
    expect(slugify("a".repeat(60))).toBe("a".repeat(32))
  })

  test("builds window and element refs in the documented shape", () => {
    const windowRef = buildWindowRef("TextEdit", "Untitled", 0)
    expect(windowRef).toBe("cua:window/textedit/untitled/0")
    expect(buildElementRef(windowRef, "button", "Export", 1)).toBe(`${windowRef}/button/export/1`)
  })

  test("parses mac backend refs into pid and child path", () => {
    expect(parseDarwinBackendRef("mac:4242:0.3.5")).toEqual({ pid: 4242, path: [0, 3, 5] })
    expect(parseDarwinBackendRef("mac:7:0")).toEqual({ pid: 7, path: [0] })
    expect(parseDarwinBackendRef("win:42.7")).toBeUndefined()
    expect(parseDarwinBackendRef("mac:abc:0")).toBeUndefined()
    expect(parseDarwinBackendRef("mac:1:")).toBeUndefined()
  })
})

describe("cua darwin role and action mapping", () => {
  test("maps AX roles to canonical roles", () => {
    expect(canonicalDarwinRole("AXButton")).toBe("button")
    expect(canonicalDarwinRole("AXTextField")).toBe("textbox")
    expect(canonicalDarwinRole("AXTextArea")).toBe("textbox")
    expect(canonicalDarwinRole("AXStaticText")).toBe("text")
    expect(canonicalDarwinRole("AXPopUpButton")).toBe("combobox")
    expect(canonicalDarwinRole("AXProgressIndicator")).toBe("progressbar")
    expect(canonicalDarwinRole("link")).toBe("link")
    expect(canonicalDarwinRole("AXMystery")).toBe("generic")
  })

  test("maps AX actions to canonical actions in the required order", () => {
    expect(canonicalDarwinActions({ actions: ["AXPress", "AXFocus", "AXScrollToVisible"] })).toEqual([
      "click",
      "focus",
      "scroll_into_view",
    ])
    expect(canonicalDarwinActions({ editable: true, valuePresent: true })).toEqual([
      "set_value",
      "focus",
      "increment",
      "decrement",
    ])
    expect(canonicalDarwinActions({ actions: ["AXShowMenu", "AXExpand", "AXCollapse", "AXSelect"] })).toEqual([
      "select",
      "expand",
      "collapse",
      "show_menu",
    ])
    expect(canonicalDarwinActions({})).toEqual([])
  })

  test("chooses raw AX actions without silently substituting", () => {
    const element = {
      actions: ["click", "show_menu", "expand"],
      attributes: { axActions: "AXPress, AXShowMenu, AXExpand" },
    }
    expect(chooseDarwinAction(undefined, element)).toBe("AXPress")
    expect(chooseDarwinAction("show_menu", element)).toBe("AXShowMenu")
    expect(chooseDarwinAction("collapse", element)).toBeUndefined()
    expect(chooseDarwinAction("AXExpand", element)).toBe("AXExpand")
    expect(chooseDarwinAction("press", { actions: [], attributes: { axActions: "AXPress" } })).toBe("AXPress")
  })

  test("matches wait conditions against element fields", () => {
    const element: CuaElement = {
      ref: "cua:window/textedit/untitled/0/button/export/0",
      backendRef: "mac:4242:0.0",
      role: "button",
      name: "Export",
      text: "Export the document",
      enabled: true,
      focused: false,
      editable: false,
      actions: ["click"],
      states: ["enabled"],
      generation: 1,
    }
    expect(matchesWaitCondition(element, { role: "AXButton" })).toBe(true)
    expect(matchesWaitCondition(element, { name: "exp" })).toBe(true)
    expect(matchesWaitCondition(element, { text: "document" })).toBe(true)
    expect(matchesWaitCondition(element, { state: "enabled" })).toBe(true)
    expect(matchesWaitCondition(element, { role: "button", name: "Save" })).toBe(false)
  })

  test("maps mac key names to System Events key codes", () => {
    expect(darwinKeyBody("return")).toBe("se.keyCode(36)")
    expect(darwinKeyBody("cmd+shift+p")).toBe('se.keystroke("p", { using: ["command down", "shift down"] })')
    expect(darwinKeyBody("nonsense+key")).toBeUndefined()
  })
})

describe("cua darwin parsers", () => {
  test("parses the recorded observe fixture from JSON", () => {
    const payload = parseDarwinSnapshotPayload(JSON.parse(DARWIN_FIXTURE_JSON))
    expect(payload?.applications).toHaveLength(2)
    expect(payload?.screen).toEqual({ width: 1920, height: 1080 })
    const window = payload?.applications[0]?.nodes[0]
    expect(window?.role).toBe("AXWindow")
    expect(window?.children[1]?.placeholder).toBe("Search the web")
    expect(window?.children[2]?.minValue).toBe(0)
    expect(window?.children[2]?.stepValue).toBe(5)
    expect(payload?.applications[1]?.error).toBe("access denied")
  })

  test("filters malformed nodes and rejects non-snapshot payloads", () => {
    const junk = parseDarwinSnapshotPayload({ applications: [{ name: "x", nodes: ["junk", 5, { role: "AXButton" }] }] })
    expect(junk?.applications[0]?.nodes).toHaveLength(1)
    expect(junk?.applications[0]?.nodes[0]?.role).toBe("AXButton")
    expect(parseDarwinSnapshotPayload({ applications: "nope" })).toBeUndefined()
    expect(parseDarwinSnapshotPayload(null)).toBeUndefined()
    expect(parseDarwinSnapshotPayload({ error: "permission", message: "denied" })).toBeUndefined()
    expect(parseDarwinScriptOutput("not json")).toBeUndefined()
    expect(parseDarwinScriptOutput("")).toBeUndefined()
  })

  test("parses resolved and result payloads", () => {
    expect(parseDarwinResolvedPayload(RESOLVED_BUTTON)).toMatchObject({ role: "AXButton", name: "Export" })
    expect(parseDarwinResolvedPayload({ ok: false, error: "target_unreachable" })).toBeUndefined()
    expect(parseDarwinResolvedPayload("nope")).toBeUndefined()
    expect(parseDarwinResultPayload({ ok: true, method: "perform" })).toEqual({ ok: true, method: "perform" })
    expect(parseDarwinResultPayload({ ok: false, error: "boom" })).toEqual({ ok: false, error: "boom" })
    expect(parseDarwinResultPayload({ method: "perform" })).toBeUndefined()
  })

  test("coerces numeric and boolean AX values to strings", () => {
    const payload = parseDarwinSnapshotPayload({
      applications: [
        {
          name: "TextEdit",
          pid: 1,
          nodes: [{ index: 0, role: "AXCheckBox", name: "Bold", value: 1, children: [] }],
        },
      ],
    })
    expect(payload?.applications[0]?.nodes[0]?.value).toBe("1")
    const resolved = parseDarwinResolvedPayload({ ok: true, role: "AXCheckBox", name: "Bold", value: true })
    expect(resolved?.value).toBe("true")
  })
})

describe("cua darwin snapshot building", () => {
  test("builds windows, elements, and stable refs from the AX tree", () => {
    const payload = parseDarwinSnapshotPayload(JSON.parse(DARWIN_FIXTURE_JSON))
    if (payload === undefined) throw new Error("fixture did not parse")
    const snapshot = buildDarwinSnapshot({
      generation: 3,
      takenAt: 1000,
      applications: payload.applications,
      screen: payload.screen,
      maxElements: 20,
    })
    const minimized = buildDarwinSnapshot({
      generation: 4,
      takenAt: 1000,
      applications: payload.applications.map((application) => ({
        ...application,
        nodes: application.nodes.map((node) => ({ ...node, states: [...node.states, "minimized"] })),
      })),
      screen: payload.screen,
      maxElements: 20,
    })
    expect(minimized.windows[0]?.minimized).toBe(true)
    expect(snapshot.windows[0]?.minimized).toBeUndefined()
    expect(snapshot.id).toBe("cap-3")
    expect(snapshot.platform).toBe("darwin")
    expect(snapshot.windows).toHaveLength(1)
    expect(snapshot.windows[0]?.ref).toBe("cua:window/textedit/untitled/0")
    expect(snapshot.windows[0]?.backendRef).toBe("mac:4242:0")
    expect(snapshot.windows[0]?.focused).toBe(true)
    expect(snapshot.warnings.some((warning) => warning.includes("Locked"))).toBe(true)

    const button = requireElement(snapshot, "Export")
    expect(button.ref).toBe("cua:window/textedit/untitled/0/button/export/0")
    expect(button.backendRef).toBe("mac:4242:0.0")
    expect(button.role).toBe("button")
    expect(button.enabled).toBe(true)
    expect(button.focused).toBe(false)
    expect(button.actions).toEqual(["click", "focus", "scroll_into_view"])
    expect(button.attributes?.axRole).toBe("AXButton")
    expect(button.attributes?.axActions).toBe("AXPress, AXFocus, AXScrollToVisible")
    expect(button.bounds).toEqual({ x: 10, y: 20, width: 80, height: 24 })
    expect(button.description).toBe("Export the document")

    const search = requireElement(snapshot, "Search")
    expect(search.role).toBe("textbox")
    expect(search.editable).toBe(true)
    expect(search.value).toBe("hello")
    expect(search.attributes?.placeholder).toBe("Search the web")
    expect(search.actions).toContain("set_value")
    expect(snapshot.focusedRef).toBe(requireElement(snapshot, "Untitled").ref)

    const volume = requireElement(snapshot, "Volume")
    expect(volume.attributes?.min).toBe(0)
    expect(volume.attributes?.max).toBe(100)
    expect(volume.attributes?.step).toBe(5)
    expect(volume.actions).toEqual(["set_value", "focus", "increment", "decrement"])
  })

  test("suffixes occurrences for repeated role and name pairs", () => {
    const parsed = parseDarwinSnapshotPayload(JSON.parse(DARWIN_FIXTURE_JSON))
    if (parsed === undefined) throw new Error("fixture did not parse")
    parsed.applications[0]?.nodes[0]?.children.push({
      index: 4,
      role: "AXButton",
      name: "Export",
      states: ["enabled"],
      actions: ["AXPress"],
      editable: false,
      valuePresent: false,
      children: [],
    })
    const snapshot = buildDarwinSnapshot({
      generation: 1,
      takenAt: 0,
      applications: parsed.applications,
      maxElements: 20,
    })
    const refs = snapshot.elements.filter((element) => element.name === "Export").map((element) => element.ref)
    expect(refs).toEqual([
      "cua:window/textedit/untitled/0/button/export/0",
      "cua:window/textedit/untitled/0/button/export/1",
    ])
  })

  test("truncates at maxElements and reports it", () => {
    const parsed = parseDarwinSnapshotPayload(JSON.parse(DARWIN_FIXTURE_JSON))
    if (parsed === undefined) throw new Error("fixture did not parse")
    const snapshot = buildDarwinSnapshot({
      generation: 2,
      takenAt: 0,
      applications: parsed.applications,
      maxElements: 1,
    })
    expect(snapshot.elements).toHaveLength(1)
    expect(snapshot.truncated).toBe(true)
    expect(snapshot.warnings.some((warning) => warning.includes("truncated"))).toBe(true)
  })
})

describe("cua darwin backend with a fake runner", () => {
  test("available tracks the accessibility probe", async () => {
    expect(await createHarness().backend.available()).toBe(true)
    const missing = createHarness({ handlers: { probe: () => ({ ok: false, error: "not permitted" }) } })
    expect(await missing.backend.available()).toBe(false)
  })

  test("snapshot wires the observe payload into a capture id", async () => {
    const { backend } = createHarness()
    const snapshot = await backend.snapshot()
    expect(snapshot.id).toBe("cap-1")
    expect(snapshot.windows).toHaveLength(1)
    expect(snapshot.elements.length).toBeGreaterThan(0)
    expect(snapshot.screen).toEqual({ width: 1920, height: 1080 })
  })

  test("invoke resolves live refs and reports background delivery", async () => {
    const { backend, runner } = createHarness()
    const snapshot = await backend.snapshot()
    const button = requireElement(snapshot, "Export")
    const result = await backend.execute({ type: "invoke", ref: button.ref })
    expect(result.ok).toBe(true)
    expect(result.delivery).toBe("background-ax")
    expect(result.verified).toBe(true)
    expect(result.error).toBeUndefined()
    expect(runner.calls.filter((script) => scriptKind(script) === "action")).toHaveLength(1)
    expect(runner.calls.filter((script) => scriptKind(script) === "click")).toHaveLength(0)
  })

  test("ref drift is a structured target_mismatch refusal", async () => {
    const { backend } = createHarness({
      handlers: { resolve: () => ({ ...RESOLVED_BUTTON, name: "Save" }) },
    })
    const snapshot = await backend.snapshot()
    const button = requireElement(snapshot, "Export")
    const result = await backend.execute({ type: "invoke", ref: button.ref })
    expect(result.ok).toBe(false)
    expect(result.delivery).toBe("refused")
    expect(result.verified).toBe(false)
    expect(result.error?.code).toBe("target_mismatch")
    expect(result.generation).toBe(snapshot.generation)
  })

  test("unknown refs and missing snapshots refuse before delivery", async () => {
    const { backend } = createHarness()
    const missing = await backend.execute({ type: "invoke", ref: "cua:window/textedit/untitled/0/button/missing/9" })
    expect(missing.error?.code).toBe("no_snapshot")
    await backend.snapshot()
    const stale = await backend.execute({ type: "invoke", ref: "cua:window/textedit/untitled/0/button/missing/9" })
    expect(stale.error?.code).toBe("stale_ref")
  })

  test("invoke refuses when no action exists and the pointer fallback would steal focus", async () => {
    const passive = parseDarwinSnapshotPayload(JSON.parse(DARWIN_FIXTURE_JSON))
    if (passive === undefined) throw new Error("fixture did not parse")
    const button = passive.applications[0]?.nodes[0]?.children[0]
    if (button === undefined) throw new Error("fixture missing button")
    button.actions = []
    const { backend } = createHarness({
      handlers: {
        observe: () => passive,
        resolve: () => ({ ...RESOLVED_BUTTON, actions: [] }),
      },
    })
    const snapshot = await backend.snapshot()
    const element = requireElement(snapshot, "Export")
    const result = await backend.execute({ type: "invoke", ref: element.ref })
    expect(result.ok).toBe(false)
    expect(result.delivery).toBe("refused")
    expect(result.error?.code).toBe("background_unavailable")
  })

  test("invoke falls back to a pointer click when the foreground fallback is allowed", async () => {
    const passive = parseDarwinSnapshotPayload(JSON.parse(DARWIN_FIXTURE_JSON))
    if (passive === undefined) throw new Error("fixture did not parse")
    const button = passive.applications[0]?.nodes[0]?.children[0]
    if (button === undefined) throw new Error("fixture missing button")
    button.actions = []
    const { backend, runner } = createHarness({
      allowForeground: true,
      handlers: {
        observe: () => passive,
        resolve: () => ({ ...RESOLVED_BUTTON, actions: [] }),
      },
    })
    const snapshot = await backend.snapshot()
    const element = requireElement(snapshot, "Export")
    const result = await backend.execute({ type: "invoke", ref: element.ref })
    expect(result.ok).toBe(true)
    expect(result.delivery).toBe("pointer")
    expect(runner.calls.filter((script) => scriptKind(script) === "click")).toHaveLength(1)
  })

  test("invoke refuses an explicitly requested action that is unavailable", async () => {
    const { backend } = createHarness()
    const snapshot = await backend.snapshot()
    const button = requireElement(snapshot, "Export")
    const result = await backend.execute({ type: "invoke", ref: button.ref, action: "show_menu" })
    expect(result.ok).toBe(false)
    expect(result.delivery).toBe("refused")
    expect(result.error?.code).toBe("action_unavailable")
  })

  test("set_value reports background delivery when AX accepts it", async () => {
    const { backend } = createHarness({
      handlers: {
        resolve: () => ({
          ok: true,
          role: "AXTextField",
          name: "Search",
          states: ["enabled"],
          actions: ["AXSetValue"],
          editable: true,
          valuePresent: true,
        }),
      },
    })
    const snapshot = await backend.snapshot()
    const search = requireElement(snapshot, "Search")
    const result = await backend.execute({ type: "set_value", ref: search.ref, value: "hello" })
    expect(result.ok).toBe(true)
    expect(result.delivery).toBe("background-ax")
  })

  test("set_value refuses instead of stealing focus when fallback is disabled", async () => {
    const { backend, runner } = createHarness({
      handlers: {
        resolve: () => ({
          ok: true,
          role: "AXTextField",
          name: "Search",
          states: ["enabled"],
          actions: ["AXSetValue"],
          editable: true,
          valuePresent: true,
        }),
        set_value: () => ({ ok: false, error: "not editable" }),
      },
    })
    const snapshot = await backend.snapshot()
    const search = requireElement(snapshot, "Search")
    const result = await backend.execute({ type: "set_value", ref: search.ref, value: "hello" })
    expect(result.ok).toBe(false)
    expect(result.delivery).toBe("refused")
    expect(result.error?.code).toBe("background_unavailable")
    expect(runner.calls.filter((script) => scriptKind(script) === "focus")).toHaveLength(0)
  })

  test("set_value can fall back to focus when foreground is explicitly allowed", async () => {
    let attempts = 0
    const { backend, runner } = createHarness({
      allowForeground: true,
      handlers: {
        resolve: () => ({
          ok: true,
          role: "AXTextField",
          name: "Search",
          states: ["enabled"],
          actions: ["AXSetValue"],
          editable: true,
          valuePresent: true,
        }),
        set_value: () => {
          attempts += 1
          return attempts === 1 ? { ok: false, error: "needs focus" } : { ok: true, method: "value" }
        },
      },
    })
    const snapshot = await backend.snapshot()
    const search = requireElement(snapshot, "Search")
    const result = await backend.execute({ type: "set_value", ref: search.ref, value: "hello" })
    expect(result.ok).toBe(true)
    expect(result.delivery).toBe("foreground-ax")
    expect(runner.calls.filter((script) => scriptKind(script) === "focus")).toHaveLength(1)
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

  test("drag validates the capture id before sending input", async () => {
    const { backend, runner } = createHarness()
    await backend.snapshot()
    const result = await backend.execute({
      type: "drag",
      from: { x: 0, y: 0 },
      to: { x: 10, y: 10 },
      captureId: "cap-old",
    })
    expect(result.error?.code).toBe("capture_stale")
    expect(runner.calls.filter((script) => scriptKind(script) === "drag")).toHaveLength(0)
  })

  test("window focus reports foreground-ax and verifies against the live title", async () => {
    const { backend } = createHarness({
      handlers: { resolve: () => ({ ok: true, role: "AXWindow", name: "Untitled", states: ["focused"], actions: [] }) },
    })
    const snapshot = await backend.snapshot()
    const window = snapshot.windows[0]
    if (window === undefined) throw new Error("fixture missing window")
    const result = await backend.execute({ type: "window", action: "focus", ref: window.ref })
    expect(result.ok).toBe(true)
    expect(result.delivery).toBe("foreground-ax")
  })

  test("window ref mismatch is a structured refusal", async () => {
    const { backend } = createHarness({
      handlers: { resolve: () => ({ ok: true, role: "AXWindow", name: "Other", states: [], actions: [] }) },
    })
    const snapshot = await backend.snapshot()
    const window = snapshot.windows[0]
    if (window === undefined) throw new Error("fixture missing window")
    const result = await backend.execute({ type: "window", action: "close", ref: window.ref })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe("target_mismatch")
  })

  test("increment falls back to the arrow key only for a focused element", async () => {
    const { backend, runner } = createHarness({
      handlers: {
        resolve: () => ({
          ok: true,
          role: "AXTextField",
          name: "Search",
          states: ["enabled", "focused"],
          actions: [],
          editable: true,
          valuePresent: true,
        }),
        value_step: () => ({ ok: false, error: "no value action" }),
      },
    })
    const snapshot = await backend.snapshot()
    const search = requireElement(snapshot, "Search")
    const result = await backend.execute({ type: "increment", ref: search.ref })
    expect(result.ok).toBe(true)
    expect(result.delivery).toBe("keyboard")
    expect(runner.calls.filter((script) => scriptKind(script) === "key")).toHaveLength(1)
  })

  test("show_menu refuses when unfocused and foreground fallback is off", async () => {
    const { backend, runner } = createHarness({
      handlers: {
        resolve: () => ({
          ok: true,
          role: "AXPopUpButton",
          name: "Zoom",
          states: ["enabled", "collapsed"],
          actions: ["AXShowMenu"],
          editable: false,
          valuePresent: false,
        }),
        action: () => ({ ok: false, error: "no menu" }),
      },
    })
    const snapshot = await backend.snapshot()
    const zoom = requireElement(snapshot, "Zoom")
    const result = await backend.execute({ type: "show_menu", ref: zoom.ref })
    expect(result.ok).toBe(false)
    expect(result.delivery).toBe("refused")
    expect(result.error?.code).toBe("background_unavailable")
    expect(runner.calls.filter((script) => scriptKind(script) === "key")).toHaveLength(0)
  })

  test("waitFor requires two consecutive matching snapshots", async () => {
    let taken = 0
    const { backend } = createHarness({
      handlers: {
        observe: () => {
          taken += 1
          return taken >= 3 ? JSON.parse(DARWIN_FIXTURE_JSON) : { applications: [], truncated: false }
        },
      },
    })
    const result = await backend.waitFor({ name: "Export", timeoutMs: 2000, pollMs: 50 })
    expect(result.ok).toBe(true)
    expect(result.element?.name).toBe("Export")
    expect(taken).toBeGreaterThanOrEqual(4)
  })

  test("waitFor times out cleanly", async () => {
    const { backend } = createHarness({
      handlers: { observe: () => ({ applications: [], truncated: false }) },
    })
    const started = Date.now()
    const result = await backend.waitFor({ name: "Export", timeoutMs: 120, pollMs: 50 })
    expect(result.ok).toBe(false)
    expect(result.element).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(2000)
  })

  test("waitFor accepts a window title only condition", async () => {
    const { backend } = createHarness()
    const result = await backend.waitFor({ windowTitle: "untitled", timeoutMs: 500, pollMs: 50 })
    expect(result.ok).toBe(true)
    expect(result.element).toBeUndefined()
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
    expect(capabilities.limits.some((limit) => limit.includes("Accessibility"))).toBe(true)
  })

  test("backend refuses everything when macOS accessibility is unavailable", async () => {
    const { backend } = createHarness({
      handlers: {
        probe: () => ({ ok: false, error: "not permitted" }),
        observe: () => ({
          error: "permission",
          message:
            "macOS accessibility access is unavailable; grant Omnia permission in System Settings > Privacy & Security > Accessibility.",
        }),
      },
    })
    expect(await backend.available()).toBe(false)
    const capabilities = await backend.capabilities()
    expect(capabilities.snapshot).toBe(false)
    expect(capabilities.semanticActions).toBe(false)
    // Refusals name the exact missing permission, not a generic message.
    expect(capabilities.limits.some((limit) => limit.includes("not permitted"))).toBe(true)
    expect(capabilities.limits.some((limit) => limit.includes("Automation") || limit.includes("Accessibility"))).toBe(true)
    const snapshot = await backend.snapshot()
    expect(snapshot.elements).toHaveLength(0)
    expect(snapshot.warnings.some((warning) => warning.includes("Accessibility"))).toBe(true)
    const result = await backend.execute({ type: "invoke", ref: "cua:window/x/y/0/button/z/0" })
    expect(result.ok).toBe(false)
    expect(result.delivery).toBe("refused")
    expect(result.error?.code).toBe("backend_unavailable")
  })
})

describe("cua darwin native helper fallback", () => {
  test("native snapshot timeout leaves room for the walk budget", () => {
    expect(DARWIN_NATIVE_SNAPSHOT_TIMEOUT_MS).toBeGreaterThan(DARWIN_NATIVE_SNAPSHOT_BUDGET_MS + 1000)
  })

  test("falls back to JXA when the native helper returns a structured failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnia-ax-test-"))
    const helper = join(dir, "ax-helper")
    writeFileSync(helper, '#!/bin/sh\necho \'{"ok":false,"error":"target_unreachable"}\'\n')
    chmodSync(helper, 0o755)
    try {
      const fake = createFakeRunner()
      const backend = createDarwinCuaBackend({ runner: fake.runner, nativeHelper: helper })
      const snapshot = await backend.snapshot()
      const button = requireElement(snapshot, "Export")
      const result = await backend.execute({ type: "invoke", ref: button.ref })
      expect(result.ok).toBe(true)
      expect(result.delivery).toBe("background-ax")
      expect(fake.calls.some((script) => scriptKind(script) === "resolve")).toBe(true)
      expect(fake.calls.some((script) => scriptKind(script) === "action")).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("darwin pointer click scripts", () => {
  test("honors the click count for right and middle buttons", () => {
    const right = darwinClickScript({ x: 5, y: 6 }, "right", 3)
    expect(right).toContain("i <= 3")
    expect(right).toContain("kCGEventRightMouseDown")
    expect(right).toContain("kCGEventRightMouseUp")
    expect(right).toContain("kCGMouseEventClickState, i")

    const middle = darwinClickScript({ x: 5, y: 6 }, "middle", 2)
    expect(middle).toContain("i <= 2")
    expect(middle).toContain("kCGEventOtherMouseDown")
    expect(middle).toContain("kCGEventOtherMouseUp")

    const left = darwinClickScript({ x: 5, y: 6 }, "left", 4)
    expect(left).toContain("i <= 4")
    expect(left).toContain("kCGEventLeftMouseDown")
  })
})

describe("cua darwin truth-layer regressions", () => {
  test("window focus never falls back to frontmost", async () => {
    const { darwinWindowScript } = await import("./darwin-script")
    const script = darwinWindowScript(4242, 0, "focus")
    // The refusal message mentions frontmost; the script must never set it.
    expect(script).not.toMatch(/frontmost\s*=/)
    expect(script).toContain("AXRaise")
  })

  test("type never uses background set_value without focus", async () => {
    const { backend } = createHarness({
      handlers: { resolve: () => ({ ...RESOLVED_BUTTON, role: "AXTextField", name: "Search" }) },
    })
    const snapshot = await backend.snapshot()
    const search = requireElement(snapshot, "Search")
    // Without foreground allowance, typed refs must refuse instead of
    // silently using background set-value.
    const refused = await backend.execute({ type: "type", text: "hi", ref: search.ref })
    expect(refused.ok).toBe(false)
    expect(refused.error?.code).toBe("background_unavailable")
  })

  test("generation-scoped refs refuse stale observations", async () => {
    const { backend } = createHarness()
    const snapshot = await backend.snapshot()
    const button = requireElement(snapshot, "Export")
    const stale = await backend.execute({ type: "invoke", ref: button.ref, observationId: "cap-stale" })
    expect(stale.ok).toBe(false)
    expect(stale.error?.code).toBe("stale_ref")
    const ok = await backend.execute({
      type: "invoke",
      ref: button.ref,
      observationId: snapshot.id,
      generation: snapshot.generation,
    })
    expect(ok.ok).toBe(true)
  })

  test("refuses keyboard input while macOS Secure Input is active", async () => {
    const { backend, runner } = createHarness({
      handlers: { secure: () => ({ ok: true, secureInput: true }) },
    })
    const typed = await backend.execute({ type: "type", text: "secret" })
    expect(typed.ok).toBe(false)
    expect(typed.error?.code).toBe("secure_input")
    const keyed = await backend.execute({ type: "key", keys: ["enter"] })
    expect(keyed.ok).toBe(false)
    expect(keyed.error?.code).toBe("secure_input")
    const dismissed = await backend.execute({ type: "dismiss" })
    expect(dismissed.ok).toBe(false)
    // No key or type script may run while the system discards them silently.
    expect(runner.calls.filter((script) => scriptKind(script) === "type")).toHaveLength(0)
    expect(runner.calls.filter((script) => scriptKind(script) === "key")).toHaveLength(0)
  })

  test("keyboard actions proceed when Secure Input is off", async () => {
    const { backend, runner } = createHarness()
    const result = await backend.execute({ type: "type", text: "hello" })
    expect(result.ok).toBe(true)
    expect(result.error).toBeUndefined()
    expect(runner.calls.filter((script) => scriptKind(script) === "type")).toHaveLength(1)
  })

  test("unknown mac keys fail instead of dropping silently", async () => {
    const { backend } = createHarness()
    const snapshot = await backend.snapshot()
    const result = await backend.execute({ type: "click", point: { x: 5, y: 5 }, captureId: snapshot.id })
    expect(result.ok).toBe(true)
    const badKey = await backend.execute({ type: "key", keys: ["nonsense+key+combo"] })
    expect(badKey.ok).toBe(false)
    expect(badKey.error?.code).toBe("invalid_action")
  })

  test("native helper path is wired (apps probe before JXA)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnia-ax-wired-"))
    const helper = join(dir, "ax-helper")
    writeFileSync(helper, '#!/bin/sh\necho \'{"applications":[]}\'\n')
    chmodSync(helper, 0o755)
    try {
      const fake = createFakeRunner()
      const backend = createDarwinCuaBackend({ runner: fake.runner, nativeHelper: helper })
      // Probe succeeds via native apps even though JXA probe would fail if
      // native were dead; snapshot still wires through JXA fallback for trees.
      const snapshot = await backend.snapshot()
      expect(snapshot.windows).toHaveLength(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("cua darwin permission truthfulness", () => {
  test("surfaces an explicit warning and unavailable state when AX is denied", async () => {
    const denied = {
      ok: false,
      error: "permission",
      code: "kAXErrorAPIDisabled",
      message: DARWIN_PERMISSION_WARNING,
    }
    const { bridge, calls } = createNativeBridge({ generation: () => denied, apps: () => denied })
    const backend = createDarwinCuaBackend({ runner: createFakeRunner().runner, nativeBridge: bridge })
    const snapshot = await backend.snapshot()
    expect(snapshot.elements).toHaveLength(0)
    expect(snapshot.windows).toHaveLength(0)
    expect(snapshot.warnings.some((warning) => warning.includes("Accessibility permission"))).toBe(true)
    expect(snapshot.accessibility).toBe("unavailable")
    // The denial short-circuits before any walk or JXA fallback.
    expect(calls.filter((call) => call.command === "snapshot")).toHaveLength(0)
    expect(await backend.available()).toBe(false)
  })

  test("never returns a silent empty tree", async () => {
    const { bridge } = createNativeBridge({
      generation: () => ({ ok: true, signature: "empty" }),
      snapshot: () => ({ ok: true, applications: [{ name: "Finder", pid: 1, nodes: [] }], truncated: false }),
    })
    const backend = createDarwinCuaBackend({ runner: createFakeRunner().runner, nativeBridge: bridge })
    const snapshot = await backend.snapshot()
    expect(snapshot.windows).toHaveLength(0)
    expect(snapshot.elements).toHaveLength(0)
    expect(snapshot.warnings.length).toBeGreaterThan(0)
    expect(snapshot.accessibility).toBe("degraded")
  })
})

describe("cua darwin focused-app traversal", () => {
  test("requests the frontmost app by default and only filters when asked", async () => {
    const { bridge, calls } = createNativeBridge({
      generation: () => ({ ok: true, signature: "s" }),
      snapshot: () => ({ ok: true, applications: [], truncated: false }),
    })
    const backend = createDarwinCuaBackend({ runner: createFakeRunner().runner, nativeBridge: bridge })
    await backend.snapshot()
    const defaultCall = calls.find((call) => call.command === "generation")
    expect(defaultCall?.params.app).toBeUndefined()
    expect(calls.find((call) => call.command === "snapshot")?.params.app).toBeUndefined()
    await backend.snapshot({ app: "TextEdit" })
    const filtered = calls.filter((call) => call.command === "generation").at(-1)
    expect(filtered?.params.app).toBe("TextEdit")
  })

  test("the native helper trusts only the frontmost app, batch-fetches, and skips hidden leaves", () => {
    expect(DARWIN_AX_HELPER).toContain("AXIsProcessTrustedWithOptions")
    expect(DARWIN_AX_HELPER).toContain("kAXErrorAPIDisabled")
    expect(DARWIN_AX_HELPER).toContain("frontmostApplication")
    expect(DARWIN_AX_HELPER).toContain("AXUIElementCopyMultipleAttributeValues")
    expect(DARWIN_AX_HELPER).toContain("unavailableLeaf")
    expect(DARWIN_AX_HELPER).toContain("kAXHiddenAttribute")
  })
})

describe("cua darwin tree cache", () => {
  test("reuses a warm tree until the window generation changes", async () => {
    let signature = "s1"
    let walks = 0
    const { bridge } = createNativeBridge({
      generation: () => ({ ok: true, signature }),
      snapshot: () => {
        walks += 1
        return fixtureNativePayload()
      },
    })
    const backend = createDarwinCuaBackend({ runner: createFakeRunner().runner, nativeBridge: bridge })
    const first = await backend.snapshot()
    expect(walks).toBe(1)
    const warm = await backend.snapshot()
    expect(walks).toBe(1)
    expect(warm.windows[0]?.ref).toBe(first.windows[0]?.ref)
    expect(warm.generation).toBeGreaterThan(first.generation)
    signature = "s2"
    await backend.snapshot()
    expect(walks).toBe(2)
  })

  test("invalidate forces the next observe to walk again", async () => {
    let walks = 0
    const { bridge } = createNativeBridge({
      generation: () => ({ ok: true, signature: "stable" }),
      snapshot: () => {
        walks += 1
        return fixtureNativePayload()
      },
    })
    const backend = createDarwinCuaBackend({ runner: createFakeRunner().runner, nativeBridge: bridge })
    await backend.snapshot()
    await backend.snapshot()
    expect(walks).toBe(1)
    backend.invalidate?.()
    await backend.snapshot()
    expect(walks).toBe(2)
  })

  test("refreshWindow patches only the target window and skips a full walk", async () => {
    let signature = "s1"
    const { bridge, calls } = createNativeBridge({
      generation: () => ({ ok: true, signature }),
      snapshot: () => fixtureNativePayload(),
      window: () => ({
        ok: true,
        node: {
          index: 0,
          role: "AXWindow",
          name: "Untitled",
          states: ["focused"],
          actions: ["AXRaise"],
          editable: false,
          valuePresent: false,
          bounds: { x: 1, y: 2, width: 300, height: 200 },
          children: [],
        },
      }),
    })
    const backend = createDarwinCuaBackend({ runner: createFakeRunner().runner, nativeBridge: bridge })
    const first = await backend.snapshot()
    const windowRef = first.windows[0]?.ref
    if (windowRef === undefined) throw new Error("fixture missing window")
    signature = "s2"
    const refreshed = await backend.refreshWindow?.(windowRef)
    expect(refreshed?.windows[0]?.title).toBe("Untitled")
    expect(refreshed?.windows[0]?.bounds).toEqual({ x: 1, y: 2, width: 300, height: 200 })
    expect(calls.filter((call) => call.command === "snapshot")).toHaveLength(1)
    expect(calls.filter((call) => call.command === "window")).toHaveLength(1)
  })

  test("refreshWindow refuses a shifted index instead of patching the wrong window", async () => {
    let signature = "s1"
    const { bridge } = createNativeBridge({
      generation: () => ({ ok: true, signature }),
      snapshot: () => fixtureNativePayload(),
      window: () => ({
        ok: true,
        node: {
          index: 0,
          role: "AXWindow",
          name: "Other",
          states: [],
          actions: [],
          editable: false,
          valuePresent: false,
          children: [],
        },
      }),
    })
    const backend = createDarwinCuaBackend({ runner: createFakeRunner().runner, nativeBridge: bridge })
    const first = await backend.snapshot()
    const windowRef = first.windows[0]?.ref
    if (windowRef === undefined) throw new Error("fixture missing window")
    signature = "s2"
    expect(await backend.refreshWindow?.(windowRef)).toBeUndefined()
  })
})

describe("cua darwin helper timeout bound", () => {
  test("bounds a hung helper walk and reports a timeout warning", async () => {
    const bridge: DarwinNativeBridge = {
      exec: (command) =>
        command === "generation"
          ? Promise.resolve({ ok: true, signature: "s" })
          : new Promise(() => {}),
    }
    const backend = createDarwinCuaBackend({
      runner: createFakeRunner().runner,
      nativeBridge: bridge,
      nativeTimeoutMs: 60,
    })
    const started = Date.now()
    const snapshot = await backend.snapshot()
    expect(Date.now() - started).toBeLessThan(1000)
    expect(snapshot.warnings.some((warning) => warning.includes("timed out"))).toBe(true)
    expect(snapshot.accessibility).toBe("degraded")
  })

  test("bounds a hung generation probe before any walk starts", async () => {
    const bridge: DarwinNativeBridge = { exec: () => new Promise(() => {}) }
    const backend = createDarwinCuaBackend({
      runner: createFakeRunner().runner,
      nativeBridge: bridge,
      nativeTimeoutMs: 60,
    })
    const started = Date.now()
    const snapshot = await backend.snapshot()
    expect(Date.now() - started).toBeLessThan(1000)
    expect(snapshot.warnings.some((warning) => warning.includes("timed out"))).toBe(true)
  })
})

describe("cua darwin controller probe", () => {
  test("available is false immediately when the helper reports the denial", async () => {
    const denied = { ok: false, error: "permission", code: "kAXErrorAPIDisabled", message: DARWIN_PERMISSION_WARNING }
    const { bridge, calls } = createNativeBridge({ apps: () => denied })
    const backend = createDarwinCuaBackend({ runner: createFakeRunner().runner, nativeBridge: bridge })
    const started = Date.now()
    expect(await backend.available()).toBe(false)
    expect(Date.now() - started).toBeLessThan(500)
    // No JXA probe fallback after the helper names the missing grant.
    expect(calls.some((call) => call.command === "apps")).toBe(true)
  })
})
