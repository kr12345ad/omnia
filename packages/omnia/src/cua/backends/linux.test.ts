import { describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { utimes } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CuaElement, CuaSnapshot } from "../types"
import type { LinuxSessionType } from "../../daemon/wayland"
import type { AtspiNodeSnapshot, AtspiSnapshotPayload, HelperReady, ResolvedElementPayload } from "./linux-script"
import { parseHelperLine, parseResolvedPayload, parseSnapshotPayload } from "./linux-script"
import {
  appMatchesFragment,
  buildCuaSnapshot,
  buildElementRef,
  buildWindowRef,
  canonicalActions,
  canonicalRole,
  chooseRawAction,
  createLinuxBackend,
  createPersistentHelper,
  matchX11WindowId,
  matchesWaitCondition,
  parseAtspiPath,
  rawAtspiActions,
  resolveLooseElement,
  resolveLooseWindow,
  slugify,
  unionScreenBounds,
  type CuaHelper,
  type CuaRunner,
  type CuaRunResult,
} from "./linux"

const INERT_INTERFACES = { component: false, action: false, editable: false, value: false }
const COMPONENT_INTERFACES = { component: true, action: false, editable: false, value: false }

function atspiSnapshot(): AtspiSnapshotPayload {
  return {
    applications: [
      {
        name: "firefox",
        pid: 42,
        nodes: [
          {
            index: 0,
            role: "application",
            name: "firefox",
            states: [],
            actions: [],
            attributes: {},
            interfaces: INERT_INTERFACES,
            children: [
              {
                index: 1,
                role: "frame",
                name: "Example page",
                states: ["focused"],
                actions: [],
                bounds: { x: 0, y: 0, width: 1024, height: 768 },
                attributes: {},
                interfaces: COMPONENT_INTERFACES,
                children: [
                  {
                    index: 0,
                    role: "pushbutton",
                    name: "Export",
                    states: ["enabled"],
                    actions: ["click"],
                    bounds: { x: 10, y: 20, width: 80, height: 24 },
                    attributes: {},
                    interfaces: { component: true, action: true, editable: false, value: false },
                    children: [],
                  },
                  {
                    index: 1,
                    role: "entry",
                    name: "Search",
                    states: ["enabled", "editable"],
                    actions: [],
                    bounds: { x: 100, y: 20, width: 200, height: 24 },
                    attributes: { placeholder: "Search the web" },
                    interfaces: { component: true, action: false, editable: true, value: false },
                    children: [],
                  },
                  {
                    index: 2,
                    role: "slider",
                    name: "Volume",
                    states: ["enabled"],
                    actions: [],
                    bounds: { x: 100, y: 60, width: 200, height: 24 },
                    attributes: { minimum: "0", maximum: "100", step: "5" },
                    interfaces: { component: true, action: false, editable: false, value: true },
                    children: [],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
    screen: { width: 1920, height: 1080 },
    truncated: false,
  }
}

function resolvedElement(overrides: Partial<ResolvedElementPayload> = {}): ResolvedElementPayload {
  return {
    role: "pushbutton",
    name: "Export",
    states: ["enabled"],
    actions: ["click"],
    attributes: {},
    interfaces: { component: true, action: true, editable: false, value: false },
    ...overrides,
  }
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

type FakeHandler = (params: Record<string, unknown>) => unknown | Promise<unknown>

interface FakeHelper {
  helper: CuaHelper
  calls: Array<{ command: string; params: Record<string, unknown> }>
}

function createFakeHelper(handlers: Record<string, FakeHandler> = {}, ready: Partial<HelperReady> = {}): FakeHelper {
  const calls: Array<{ command: string; params: Record<string, unknown> }> = []
  const helper: CuaHelper = {
    ready: Promise.resolve({
      ok: ready.ok !== false,
      pyatspi: ready.pyatspi !== false,
      x11: ready.x11 !== false,
      ...(typeof ready.error === "string" ? { error: ready.error } : {}),
    }),
    exited: false,
    async request(command, params = {}) {
      calls.push({ command, params })
      const handler = handlers[command]
      if (handler === undefined) return { ok: false, error: `unsupported command: ${command}`, payload: {} }
      const payload = await handler(params)
      const record = isRecordValue(payload) ? payload : {}
      return {
        ok: record.ok !== false,
        ...(typeof record.error === "string" ? { error: record.error } : {}),
        payload: record,
      }
    },
    async dispose() {},
  }
  return { helper, calls }
}

interface FakeRunner {
  runner: CuaRunner
  calls: Array<{ file: string; args: string[] }>
}

function createFakeRunner(
  options: {
    which?: readonly string[]
    onRun?: (file: string, args: readonly string[]) => CuaRunResult | undefined
  } = {},
): FakeRunner {
  const calls: Array<{ file: string; args: string[] }> = []
  const which = new Set(options.which ?? [])
  const runner: CuaRunner = async (file, args) => {
    calls.push({ file, args: [...args] })
    if (file === "which") {
      if (which.has(args[0] ?? "")) return { stdout: `/usr/bin/${args[0]}\n`, stderr: "" }
      throw new Error(`${args[0]} not found`)
    }
    const custom = options.onRun?.(file, args)
    if (custom !== undefined) return custom
    return { stdout: JSON.stringify({ ok: true }), stderr: "" }
  }
  return { runner, calls }
}

function requireElement(snapshot: CuaSnapshot, name: string): CuaElement {
  const element = snapshot.elements.find((candidate) => candidate.name === name)
  if (element === undefined) throw new Error(`missing element: ${name}`)
  return element
}

describe("cua linux refs", () => {
  test("slugifies names deterministically", () => {
    expect(slugify("Export")).toBe("export")
    expect(slugify("  Héllo   Wörld!! ")).toBe("hello-world")
    expect(slugify("")).toBe("unnamed")
    expect(slugify("---")).toBe("unnamed")
    expect(slugify("a".repeat(60))).toBe("a".repeat(32))
    expect(slugify("names ending in dashes --")).toBe("names-ending-in-dashes")
  })

  test("builds window and element refs in the documented shape", () => {
    const windowRef = buildWindowRef("firefox", "Example page", 0)
    expect(windowRef).toBe("cua:window/firefox/example-page/0")
    expect(buildElementRef(windowRef, "button", "Export", 1)).toBe(`${windowRef}/button/export/1`)
    expect(buildElementRef(windowRef, "window", "Example page", 0)).toBe(`${windowRef}/window/example-page/0`)
  })

  test("parses and rejects atspi backend paths", () => {
    expect(parseAtspiPath("atspi:0.3.5")).toEqual([0, 3, 5])
    expect(parseAtspiPath("atspi:4")).toEqual([4])
    expect(parseAtspiPath("x11:0x1")).toEqual([])
    expect(parseAtspiPath("atspi:")).toEqual([])
  })
})

describe("cua linux role and action mapping", () => {
  test("maps AT-SPI role names to canonical roles", () => {
    expect(canonicalRole("pushbutton")).toBe("button")
    expect(canonicalRole("push button")).toBe("button")
    expect(canonicalRole("frame")).toBe("window")
    expect(canonicalRole("entry")).toBe("textbox")
    expect(canonicalRole("page tab")).toBe("tab")
    expect(canonicalRole("check box")).toBe("checkbox")
    expect(canonicalRole("window")).toBe("window")
    expect(canonicalRole("mystery role")).toBe("generic")
  })

  test("maps AT-SPI actions to canonical actions in the required order", () => {
    expect(canonicalActions({ actions: ["click"], hasComponent: true })).toEqual(["click", "focus", "scroll_into_view"])
    expect(canonicalActions({ actions: ["expand or contract"] })).toEqual(["expand", "collapse"])
    expect(canonicalActions({ editable: true, hasValue: true })).toEqual(["set_value", "increment", "decrement"])
    expect(canonicalActions({ actions: ["toggle", "select", "show menu"], hasComponent: true })).toEqual([
      "focus",
      "toggle",
      "select",
      "scroll_into_view",
      "show_menu",
    ])
    expect(canonicalActions({})).toEqual([])
  })

  test("chooses raw AT-SPI actions without silently substituting", () => {
    const element = {
      actions: ["click", "toggle", "show_menu"],
      attributes: { atspiActions: "Press, Check, Popup" },
    }
    expect(rawAtspiActions(element)).toEqual(["Press", "Check", "Popup"])
    expect(chooseRawAction(undefined, element)).toBe("Press")
    expect(chooseRawAction("toggle", element)).toBe("Check")
    expect(chooseRawAction("show_menu", element)).toBe("Popup")
    expect(chooseRawAction("show_menu", { actions: ["click"], attributes: { atspiActions: "Press" } })).toBeUndefined()
    expect(chooseRawAction("nonsense", { actions: [], attributes: {} })).toBeUndefined()
    expect(chooseRawAction("Press", element)).toBe("Press")
  })

  test("matches wait conditions against element fields", () => {
    const element: CuaElement = {
      ref: "cua:window/firefox/example-page/0/button/export/0",
      backendRef: "atspi:0.1.0.0",
      role: "button",
      name: "Export",
      text: "Export the current page",
      enabled: true,
      focused: false,
      editable: false,
      actions: ["click"],
      states: ["enabled"],
      generation: 1,
    }
    expect(matchesWaitCondition(element, { role: "pushbutton" })).toBe(true)
    expect(matchesWaitCondition(element, { name: "exp" })).toBe(true)
    expect(matchesWaitCondition(element, { text: "current page" })).toBe(true)
    expect(matchesWaitCondition(element, { state: "enabled" })).toBe(true)
    expect(matchesWaitCondition(element, { role: "button", name: "Save" })).toBe(false)
  })
})

describe("cua linux helper line parsers", () => {
  test("parses helper envelopes and ready lines", () => {
    expect(parseHelperLine('{"id":"1","ok":true,"result":true}')).toMatchObject({ id: "1", ok: true })
    expect(
      parseHelperLine('{"ready":true,"ok":false,"pyatspi":false,"error":"pyatspi is not available"}'),
    ).toMatchObject({
      ready: true,
      ok: false,
      pyatspi: false,
      error: "pyatspi is not available",
    })
    expect(parseHelperLine('{"id":"2","ok":false,"error":"boom"}')).toMatchObject({ id: "2", ok: false, error: "boom" })
    expect(parseHelperLine("not json")).toBeUndefined()
    expect(parseHelperLine("[]")).toBeUndefined()
    expect(parseHelperLine("42")).toBeUndefined()
  })

  test("parses snapshot payloads and filters malformed nodes", () => {
    const payload = parseSnapshotPayload(atspiSnapshot())
    expect(payload?.applications).toHaveLength(1)
    expect(payload?.screen).toEqual({ width: 1920, height: 1080 })
    expect(payload?.applications[0]?.nodes[0]?.children[0]?.role).toBe("frame")
    expect(payload?.applications[0]?.nodes[0]?.children[0]?.children[0]?.role).toBe("pushbutton")
    const junk = parseSnapshotPayload({ applications: [{ name: "x", nodes: ["junk", 5, { role: "button" }] }] })
    expect(junk?.applications[0]?.nodes).toHaveLength(1)
    expect(parseSnapshotPayload({ applications: "nope" })).toBeUndefined()
    expect(parseSnapshotPayload(null)).toBeUndefined()
  })

  test("parses resolved element payloads and rejects junk", () => {
    expect(parseResolvedPayload(resolvedElement())).toMatchObject({ role: "pushbutton", name: "Export" })
    expect(parseResolvedPayload({ role: "button", bounds: { x: 1, y: 2, width: 3, height: 4 } })?.bounds).toEqual({
      x: 1,
      y: 2,
      width: 3,
      height: 4,
    })
    expect(parseResolvedPayload({ role: "button", bounds: { x: "bad" } })?.bounds).toBeUndefined()
    expect(parseResolvedPayload({ name: "no role" })).toBeUndefined()
    expect(parseResolvedPayload("nope")).toBeUndefined()
  })
})
describe("cua linux snapshot building", () => {
  test("builds windows, elements, and stable refs from the AT-SPI tree", () => {
    const snapshot = buildCuaSnapshot({
      generation: 3,
      takenAt: 1000,
      applications: atspiSnapshot().applications,
      screen: { width: 1920, height: 1080 },
      maxElements: 10,
    })
    expect(snapshot.id).toBe("cap-3")
    expect(snapshot.generation).toBe(3)
    expect(snapshot.platform).toBe("linux")
    expect(snapshot.windows).toHaveLength(1)
    expect(snapshot.windows[0]?.ref).toBe("cua:window/firefox/example-page/0")
    expect(snapshot.windows[0]?.app).toBe("firefox")
    expect(snapshot.windows[0]?.focused).toBe(true)
    const button = requireElement(snapshot, "Export")
    expect(button.ref).toBe("cua:window/firefox/example-page/0/button/export/0")
    expect(button.role).toBe("button")
    expect(button.generation).toBe(3)
    expect(button.enabled).toBe(true)
    expect(button.focused).toBe(false)
    expect(button.actions).toEqual(["click", "focus", "scroll_into_view"])
    expect(button.attributes?.atspiActions).toBe("click")
    expect(button.attributes?.atspiRole).toBe("pushbutton")
    expect(button.bounds).toEqual({ x: 10, y: 20, width: 80, height: 24 })
    const entry = requireElement(snapshot, "Search")
    expect(entry.role).toBe("textbox")
    expect(entry.editable).toBe(true)
    expect(entry.value).toBeUndefined()
    expect(entry.attributes?.placeholder).toBe("Search the web")
    expect(entry.actions).toContain("set_value")
    const slider = requireElement(snapshot, "Volume")
    expect(slider.attributes?.min).toBe(0)
    expect(slider.attributes?.max).toBe(100)
    expect(slider.attributes?.step).toBe(5)
    expect(slider.actions).toEqual(["set_value", "focus", "increment", "decrement", "scroll_into_view"])
    // The window itself is the canonical focused record; no duplicate
    // window-role element exists for the frame node.
    expect(snapshot.focusedRef).toBe("cua:window/firefox/example-page/0")
    expect(snapshot.elements.some((element) => element.role === "window")).toBe(false)
  })

  test("suffixes occurrences for repeated role and name pairs", () => {
    const applications = atspiSnapshot().applications
    applications[0]?.nodes[0]?.children[0]?.children.push({
      index: 2,
      role: "pushbutton",
      name: "Export",
      states: ["enabled"],
      actions: ["click"],
      bounds: { x: 10, y: 60, width: 80, height: 24 },
      attributes: {},
      interfaces: { component: true, action: true, editable: false, value: false },
      children: [],
    })
    const snapshot = buildCuaSnapshot({
      generation: 1,
      takenAt: 0,
      applications,
      screen: { width: 1920, height: 1080 },
      maxElements: 10,
    })
    const refs = snapshot.elements.filter((element) => element.name === "Export").map((element) => element.ref)
    expect(refs).toEqual([
      "cua:window/firefox/example-page/0/button/export/0",
      "cua:window/firefox/example-page/0/button/export/1",
    ])
  })

  test("keeps minimized windows with a minimized marker", () => {
    const applications = atspiSnapshot().applications
    const frame = applications[0]?.nodes[0]?.children[0]
    if (frame === undefined) throw new Error("fixture missing frame")
    frame.states = ["enabled", "iconified"]
    const snapshot = buildCuaSnapshot({ generation: 1, takenAt: 0, applications, maxElements: 10 })
    expect(snapshot.windows).toHaveLength(1)
    expect(snapshot.windows[0]?.minimized).toBe(true)
  })

  test("truncates at maxElements and reports the selected and total counts", () => {
    const snapshot = buildCuaSnapshot({
      generation: 2,
      takenAt: 0,
      applications: atspiSnapshot().applications,
      maxElements: 1,
    })
    expect(snapshot.elements).toHaveLength(1)
    expect(snapshot.truncated).toBe(true)
    expect(snapshot.warnings.some((warning) => warning.includes("truncated to 1 of 3"))).toBe(true)
  })

  test("reports helper truncation separately from the element budget", () => {
    const snapshot = buildCuaSnapshot({
      generation: 2,
      takenAt: 0,
      applications: atspiSnapshot().applications,
      maxElements: 50,
      helperTruncated: true,
    })
    expect(snapshot.truncated).toBe(true)
    expect(snapshot.warnings.some((warning) => warning.includes("accessibility tree was truncated"))).toBe(true)
    expect(snapshot.warnings.some((warning) => warning.includes("truncated to"))).toBe(false)
  })

  test("tags every element and window with its application name", () => {
    const snapshot = buildCuaSnapshot({
      generation: 1,
      takenAt: 0,
      applications: atspiSnapshot().applications,
      maxElements: 50,
    })
    expect(snapshot.windows[0]?.app).toBe("firefox")
    expect(snapshot.elements.length).toBeGreaterThan(0)
    expect(snapshot.elements.every((element) => element.application === "firefox")).toBe(true)
  })

  test("matches requested apps through aliases and normalization", () => {
    expect(appMatchesFragment("browser", "firefox")).toBe(true)
    expect(appMatchesFragment("files", "dolphin")).toBe(true)
    expect(appMatchesFragment("dolphin", "org.kde.dolphin")).toBe(true)
    expect(appMatchesFragment("terminal", "kitty")).toBe(true)
    expect(appMatchesFragment("  DOLPHIN  ", "dolphin")).toBe(true)
    expect(appMatchesFragment("dolphin", "firefox")).toBe(false)
    expect(appMatchesFragment(undefined, "firefox")).toBe(true)
  })

  test("keeps interactive controls ahead of menu noise when limiting", () => {
    const applications = atspiSnapshot().applications
    const frame = applications[0]?.nodes[0]?.children[0]
    if (frame === undefined) throw new Error("fixture missing frame")
    const menu: AtspiNodeSnapshot[] = Array.from({ length: 8 }, (_, index) => ({
      index,
      role: "menuitem",
      name: `Menu ${index}`,
      states: ["enabled"],
      actions: [],
      attributes: {},
      interfaces: INERT_INTERFACES,
      children: [],
    }))
    frame.children = [
      ...menu,
      ...frame.children,
      {
        index: 50,
        role: "listitem",
        name: "Documents",
        states: ["enabled"],
        actions: ["click"],
        bounds: { x: 10, y: 200, width: 100, height: 20 },
        attributes: {},
        interfaces: INERT_INTERFACES,
        children: [],
      },
    ]
    const snapshot = buildCuaSnapshot({
      generation: 1,
      takenAt: 0,
      applications,
      maxElements: 4,
    })
    const names = snapshot.elements.map((element) => element.name)
    expect(names).toContain("Export")
    expect(names).toContain("Documents")
    expect(names.some((name) => name.startsWith("Menu"))).toBe(false)
    expect(snapshot.warnings.some((warning) => warning.includes("truncated to 4 of"))).toBe(true)
  })
})

type FakeHandlerMap = Record<string, FakeHandler>

function baseHandlers(resolved: ResolvedElementPayload = resolvedElement()): FakeHandlerMap {
  return {
    snapshot: () => atspiSnapshot(),
    resolve: () => resolved,
    act: () => ({ result: true }),
  }
}

function emptySnapshot(): Record<string, unknown> {
  return { applications: [], screen: { width: 1920, height: 1080 }, truncated: false }
}

interface HarnessOptions {
  handlers?: FakeHandlerMap
  ready?: Partial<HelperReady>
  which?: readonly string[]
  allowForeground?: boolean
  x11Windows?: boolean
  session?: LinuxSessionType
  interpreter?: string
  display?: string
  onRun?: (file: string, args: readonly string[]) => CuaRunResult | undefined
}

function createHarness(options: HarnessOptions = {}) {
  const fakeHelper = createFakeHelper(options.handlers ?? baseHandlers(), options.ready)
  const fakeRunner = createFakeRunner({ which: options.which, onRun: options.onRun })
  const backend = createLinuxBackend({
    helper: fakeHelper.helper,
    runner: fakeRunner.runner,
    accessibility: false,
    x11Windows: options.x11Windows === true,
    session: options.session ?? "x11",
    display: options.display ?? ":0",
    probeDisplay: false,
    ...(options.interpreter === undefined ? {} : { interpreter: options.interpreter }),
    ...(options.allowForeground === true ? { allowForeground: true } : {}),
  })
  return { backend, helper: fakeHelper, runner: fakeRunner }
}

describe("cua linux backend with a fake helper", () => {
  test("available tracks helper readiness", async () => {
    expect(await createHarness().backend.available()).toBe(true)
    const missing = createHarness({ ready: { ok: false, pyatspi: false, error: "pyatspi is not available" } })
    expect(await missing.backend.available()).toBe(false)
  })

  test("snapshot wires helper payloads into a capture id", async () => {
    const { backend } = createHarness()
    const snapshot = await backend.snapshot()
    expect(snapshot.id).toBe("cap-1")
    expect(snapshot.windows).toHaveLength(1)
    expect(snapshot.elements.length).toBeGreaterThan(0)
    expect(snapshot.screen).toEqual({ width: 1920, height: 1080 })
  })

  test("invoke resolves live refs and reports background delivery", async () => {
    const { backend, helper, runner } = createHarness()
    const snapshot = await backend.snapshot()
    const button = requireElement(snapshot, "Export")
    const result = await backend.execute({ type: "invoke", ref: button.ref })
    expect(result.ok).toBe(true)
    expect(result.delivery).toBe("background-ax")
    expect(result.verified).toBe(true)
    expect(result.error).toBeUndefined()
    expect(helper.calls.map((call) => call.command)).toEqual(["snapshot", "resolve", "act"])
    expect(runner.calls).toHaveLength(0)
  })

  test("ref mismatch is a structured refusal", async () => {
    const { backend } = createHarness({
      handlers: { ...baseHandlers(), resolve: () => resolvedElement({ name: "Save" }) },
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

  test("unknown refs and missing snapshots are refused before any delivery", async () => {
    const { backend } = createHarness()
    const missing = await backend.execute({ type: "invoke", ref: "cua:window/firefox/example-page/0/button/missing/9" })
    expect(missing.error?.code).toBe("no_snapshot")
    await backend.snapshot()
    const stale = await backend.execute({ type: "invoke", ref: "cua:window/firefox/example-page/0/button/missing/9" })
    expect(stale.error?.code).toBe("stale_ref")
  })

  test("invoke refuses an unavailable action", async () => {
    const { backend } = createHarness()
    const snapshot = await backend.snapshot()
    const button = requireElement(snapshot, "Export")
    const result = await backend.execute({ type: "invoke", ref: button.ref, action: "show_menu" })
    expect(result.ok).toBe(false)
    expect(result.delivery).toBe("refused")
    expect(result.error?.code).toBe("action_unavailable")
  })

  test("set_value refuses instead of silently stealing focus", async () => {
    const { backend, helper, runner } = createHarness({
      handlers: {
        ...baseHandlers(
          resolvedElement({
            role: "entry",
            name: "Search",
            states: ["enabled", "editable"],
            actions: [],
            interfaces: { component: true, action: false, editable: true, value: false },
          }),
        ),
        "set-text": () => ({ ok: false, error: "not editable" }),
      },
    })
    const snapshot = await backend.snapshot()
    const entry = requireElement(snapshot, "Search")
    const result = await backend.execute({ type: "set_value", ref: entry.ref, value: "hello" })
    expect(result.ok).toBe(false)
    expect(result.delivery).toBe("refused")
    expect(result.error?.code).toBe("background_unavailable")
    expect(helper.calls.some((call) => call.command === "focus")).toBe(false)
    expect(runner.calls).toHaveLength(0)
  })

  test("set_value reports background delivery when the helper accepts it", async () => {
    const entryPayload = resolvedElement({
      role: "entry",
      name: "Search",
      states: ["enabled", "editable"],
      actions: [],
      interfaces: { component: true, action: false, editable: true, value: false },
    })
    const { backend, helper } = createHarness({
      handlers: { ...baseHandlers(entryPayload), "set-text": () => ({ result: true }) },
    })
    const snapshot = await backend.snapshot()
    const entry = requireElement(snapshot, "Search")
    const result = await backend.execute({ type: "set_value", ref: entry.ref, value: "hello" })
    expect(result.ok).toBe(true)
    expect(result.delivery).toBe("background-ax")
    expect(helper.calls.some((call) => call.command === "focus")).toBe(false)
  })

  test("set_value reports foreground-ax after an explicit focus fallback", async () => {
    let attempts = 0
    const { backend, helper } = createHarness({
      allowForeground: true,
      handlers: {
        ...baseHandlers(
          resolvedElement({
            role: "entry",
            name: "Search",
            states: ["enabled", "editable"],
            actions: [],
            interfaces: { component: true, action: false, editable: true, value: false },
          }),
        ),
        "set-text": () => {
          attempts += 1
          return attempts === 1 ? { ok: false, error: "needs focus" } : { result: true }
        },
        focus: () => ({ result: true }),
      },
    })
    const snapshot = await backend.snapshot()
    const entry = requireElement(snapshot, "Search")
    const result = await backend.execute({ type: "set_value", ref: entry.ref, value: "hello" })
    expect(result.ok).toBe(true)
    expect(result.delivery).toBe("foreground-ax")
    expect(helper.calls.map((call) => call.command)).toEqual(["snapshot", "resolve", "set-text", "focus", "set-text"])
  })

  test("capture ids are validated and one-use for point actions", async () => {
    const { backend } = createHarness({ handlers: { ...baseHandlers(), click: () => ({ result: true }) } })
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
    const { backend } = createHarness({ handlers: { ...baseHandlers(), click: () => ({ result: true }) } })
    const snapshot = await backend.snapshot()
    const result = await backend.execute({
      type: "click",
      point: { x: 5000, y: 10 },
      captureId: snapshot.id,
    })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe("invalid_point")
  })

  test("drag validates the capture id before sending input", async () => {
    const { backend, helper } = createHarness({ handlers: { ...baseHandlers(), drag: () => ({ result: true }) } })
    await backend.snapshot()
    const result = await backend.execute({
      type: "drag",
      from: { x: 0, y: 0 },
      to: { x: 10, y: 10 },
      captureId: "cap-old",
    })
    expect(result.error?.code).toBe("capture_stale")
    expect(helper.calls.some((call) => call.command === "drag")).toBe(false)
  })

  test("window focus reports foreground-ax", async () => {
    const { backend } = createHarness({
      handlers: {
        ...baseHandlers(resolvedElement({ role: "frame", name: "Example page" })),
        window: () => ({ result: true }),
      },
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
      handlers: {
        ...baseHandlers(resolvedElement({ role: "frame", name: "Other window" })),
        window: () => ({ result: true }),
      },
    })
    const snapshot = await backend.snapshot()
    const window = snapshot.windows[0]
    if (window === undefined) throw new Error("fixture missing window")
    const result = await backend.execute({ type: "window", action: "close", ref: window.ref })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe("target_mismatch")
  })

  test("increment falls back to an arrow key only for a focused element", async () => {
    const focused = atspiSnapshot()
    const frame = focused.applications[0]?.nodes[0]?.children[0]
    if (frame === undefined) throw new Error("fixture missing frame")
    frame.states = ["enabled"]
    const slider = frame.children.find((child) => child.name === "Volume")
    if (slider === undefined) throw new Error("fixture missing slider")
    slider.states = ["enabled", "focused"]
    const { backend, helper, runner } = createHarness({
      handlers: {
        ...baseHandlers(),
        snapshot: () => focused,
        resolve: () => resolvedElement({ role: "slider", name: "Volume", states: ["enabled", "focused"] }),
        increment: () => ({ ok: false, error: "not a value" }),
      },
    })
    const snapshot = await backend.snapshot()
    const volume = requireElement(snapshot, "Volume")
    const result = await backend.execute({ type: "increment", ref: volume.ref })
    expect(result.ok).toBe(true)
    expect(result.delivery).toBe("keyboard")
    expect(helper.calls.some((call) => call.command === "increment")).toBe(true)
    expect(runner.calls.some((call) => call.file === "python3" && call.args.includes("key"))).toBe(true)
  })

  test("show_menu refuses when the element is unfocused and foreground fallback is off", async () => {
    const { backend, runner } = createHarness({
      handlers: { ...baseHandlers(), "show-menu": () => ({ ok: false, error: "no menu" }) },
    })
    const snapshot = await backend.snapshot()
    const button = requireElement(snapshot, "Export")
    const result = await backend.execute({ type: "show_menu", ref: button.ref })
    expect(result.ok).toBe(false)
    expect(result.delivery).toBe("refused")
    expect(result.error?.code).toBe("background_unavailable")
    expect(runner.calls).toHaveLength(0)
  })

  test("waitFor requires two consecutive matching snapshots", async () => {
    let taken = 0
    const { backend } = createHarness({
      handlers: {
        snapshot: () => {
          taken += 1
          return taken >= 3 ? atspiSnapshot() : emptySnapshot()
        },
      },
    })
    const result = await backend.waitFor({ name: "Export", timeoutMs: 2000, pollMs: 50 })
    expect(result.ok).toBe(true)
    expect(result.element?.name).toBe("Export")
    expect(result.waitedMs).toBeGreaterThanOrEqual(0)
    expect(taken).toBeGreaterThanOrEqual(4)
  })

  test("waitFor times out cleanly", async () => {
    const { backend } = createHarness({ handlers: { snapshot: () => emptySnapshot() } })
    const started = Date.now()
    const result = await backend.waitFor({ name: "Export", timeoutMs: 120, pollMs: 50 })
    expect(result.ok).toBe(false)
    expect(result.element).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(2000)
  })

  test("waitFor accepts a window title only condition", async () => {
    const { backend } = createHarness()
    const result = await backend.waitFor({ windowTitle: "example", timeoutMs: 500, pollMs: 50 })
    expect(result.ok).toBe(true)
    expect(result.element).toBeUndefined()
  })

  test("backend is unavailable when pyatspi is missing", async () => {
    const { backend } = createHarness({ ready: { ok: false, pyatspi: false, error: "pyatspi is not available" } })
    expect(await backend.available()).toBe(false)
    const capabilities = await backend.capabilities()
    expect(capabilities.snapshot).toBe(false)
    expect(capabilities.semanticActions).toBe(false)
    expect(capabilities.limits).toContain("pyatspi is not available")
    const snapshot = await backend.snapshot()
    expect(snapshot.warnings).toContain("pyatspi is not available")
    expect(snapshot.elements).toHaveLength(0)
    const result = await backend.execute({ type: "invoke", ref: "cua:window/x/y/0/button/z/0" })
    expect(result.ok).toBe(false)
    expect(result.delivery).toBe("refused")
    expect(result.error?.code).toBe("backend_unavailable")
  })

  test("capabilities are honest about what is available", async () => {
    const { backend } = createHarness({ which: ["ffmpeg"] })
    const capabilities = await backend.capabilities()
    expect(capabilities).toMatchObject({
      snapshot: true,
      semanticActions: true,
      backgroundActions: true,
      backgroundInput: false,
      pointer: true,
      keyboard: true,
      clipboard: true,
      screenshot: true,
      windowManagement: true,
      waitFor: true,
      refs: true,
    })
    expect(capabilities.actions).toContain("invoke")
    expect(capabilities.actions).toContain("window")
    expect(capabilities.limits.some((limit) => limit.includes("never fall back"))).toBe(true)
  })

  test("preserves the helper transport cause on act and set-text round trips", async () => {
    const { backend } = createHarness({
      handlers: {
        ...baseHandlers(),
        act: () => {
          throw new Error("The Linux CUA helper timed out running act.")
        },
      },
    })
    const snapshot = await backend.snapshot()
    const button = requireElement(snapshot, "Export")
    const result = await backend.execute({ type: "invoke", ref: button.ref })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe("helper_timeout")
    expect(result.error?.message).toContain("timed out running act")
  })

  test("preserves the helper transport cause when set-text rejects", async () => {
    const { backend } = createHarness({
      handlers: {
        ...baseHandlers(
          resolvedElement({
            role: "entry",
            name: "Search",
            states: ["enabled", "editable"],
            actions: [],
            interfaces: { component: true, action: false, editable: true, value: false },
          }),
        ),
        "set-text": () => {
          throw new Error("The Linux CUA helper is not running.")
        },
      },
    })
    const snapshot = await backend.snapshot()
    const entry = requireElement(snapshot, "Search")
    const result = await backend.execute({ type: "set_value", ref: entry.ref, value: "hello" })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe("helper_exited")
    expect(result.error?.message).toContain("not running")
  })

  test("window identity accepts a mutated or truncated live title", async () => {
    const { backend } = createHarness({
      handlers: {
        ...baseHandlers(resolvedElement({ role: "frame", name: "Example page — Mozilla Firefox" })),
        window: () => ({ result: true }),
      },
    })
    const snapshot = await backend.snapshot()
    const window = snapshot.windows[0]
    if (window === undefined) throw new Error("fixture missing window")
    const result = await backend.execute({ type: "window", action: "focus", ref: window.ref })
    expect(result.ok).toBe(true)
    expect(result.delivery).toBe("foreground-ax")
  })

  test("Wayland hotkeys use the AT-SPI helper instead of requiring ydotool", async () => {
    const { backend, helper } = createHarness({
      session: "wayland",
      handlers: { ...baseHandlers(), key: () => ({ result: true }) },
    })
    const result = await backend.execute({ type: "key", keys: ["ctrl", "v"] })
    expect(result.ok).toBe(true)
    expect(helper.calls.some((call) => call.command === "key" && call.params.keys === "ctrl+v")).toBe(true)
  })

  test("wait deadline caps the remaining budget before a full snapshot", async () => {
    let snapshots = 0
    const { backend } = createHarness({
      handlers: {
        snapshot: async () => {
          snapshots += 1
          await new Promise((resolve) => setTimeout(resolve, 200))
          return emptySnapshot()
        },
      },
    })
    const started = Date.now()
    const result = await backend.waitFor({ name: "Nope", timeoutMs: 80, pollMs: 50 })
    expect(result.ok).toBe(false)
    expect(Date.now() - started).toBeLessThan(200)
    expect(snapshots).toBe(1)
  })

  test("converts Wayland logical coordinates to device pixels before injection", async () => {
    const { backend, runner } = createHarness({
      session: "wayland",
      which: ["ydotool"],
      onRun: (file, args) => {
        if (file === "wlr-randr" && args[0] === "--json") {
          return {
            stdout: JSON.stringify([
              {
                name: "eDP-1",
                enabled: true,
                scale: 2,
                position: { x: 0, y: 0 },
                current_mode: { width: 3840, height: 2160 },
              },
            ]),
            stderr: "",
          }
        }
        return undefined
      },
    })
    const result = await backend.execute({ type: "click", point: { x: 100, y: 50 }, button: "left" })
    expect(result.ok).toBe(true)
    const move = runner.calls.find(
      (call) => call.file === "ydotool" && call.args[0] === "mousemove",
    )
    expect(move?.args).toEqual(["mousemove", "--absolute", "-x", "200", "-y", "100"])
  })

  test("refuses a Wayland point that is outside the device screen after conversion", async () => {
    const { backend } = createHarness({
      session: "wayland",
      which: ["ydotool"],
      onRun: (file, args) => {
        if (file === "wlr-randr" && args[0] === "--json") {
          return {
            stdout: JSON.stringify([
              {
                name: "eDP-1",
                enabled: true,
                scale: 2,
                position: { x: 0, y: 0 },
                current_mode: { width: 800, height: 600 },
              },
            ]),
            stderr: "",
          }
        }
        return undefined
      },
    })
    const result = await backend.execute({ type: "click", point: { x: 500, y: 50 }, button: "left" })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe("invalid_point")
    expect(result.error?.message).toContain("device screen")
  })

  test("pastes unsupported characters through the clipboard and restores it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "omnia-fake-python-"))
    const interpreter = join(directory, "fake-python")
    writeFileSync(interpreter, "#!/bin/sh\ncat > /dev/null\nexit 0\n")
    chmodSync(interpreter, 0o755)
    try {
      const { backend, runner } = createHarness({
        interpreter,
        onRun: (_file, args) => {
          if (args[0] === "-c" && args[2] === "get") {
            return {
              stdout: JSON.stringify({ ok: true, text: "previous", length: 8, hash: "abc", complete: true }),
              stderr: "",
            }
          }
          if (args[0] === "-c" && args[2] === "type" && args.includes("--check")) {
            return { stdout: JSON.stringify({ ok: true, typed: 0, skipped: ["\u2603"] }), stderr: "" }
          }
          return undefined
        },
      })
      const result = await backend.execute({ type: "type", text: "snow \u2603" })
      expect(result.ok).toBe(true)
      const typed = runner.calls.filter((call) => call.args[2] === "type" && !call.args.includes("--check"))
      expect(typed).toHaveLength(0)
      expect(runner.calls.some((call) => call.args[2] === "key" && call.args.includes("ctrl+v"))).toBe(true)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }, 10000)
})

describe("cua linux loose refs and x11 matching", () => {
  test("loose refs resolve the requested occurrence for duplicates", () => {
    const applications = atspiSnapshot().applications
    applications[0]?.nodes[0]?.children[0]?.children.push({
      index: 2,
      role: "pushbutton",
      name: "Export",
      states: ["enabled"],
      actions: ["click"],
      bounds: { x: 10, y: 60, width: 80, height: 24 },
      attributes: {},
      interfaces: { component: true, action: true, editable: false, value: false },
      children: [],
    })
    const snapshot = buildCuaSnapshot({ generation: 1, takenAt: 0, applications, maxElements: 10 })
    const exports = snapshot.elements.filter((element) => element.name === "Export")
    expect(exports).toHaveLength(2)
    expect(resolveLooseElement(snapshot, exports[1]!.ref)?.ref).toBe(exports[1]!.ref)
    expect(resolveLooseElement(snapshot, exports[0]!.ref)?.ref).toBe(exports[0]!.ref)
    const ambiguous = exports[1]!.ref.replace(/\/1$/, "/7")
    expect(resolveLooseElement(snapshot, ambiguous)).toBeUndefined()
  })

  test("a shifted occurrence still resolves when only one candidate remains", () => {
    const applications = atspiSnapshot().applications
    applications[0]?.nodes[0]?.children[0]?.children.push({
      index: 2,
      role: "pushbutton",
      name: "Export",
      states: ["enabled"],
      actions: ["click"],
      bounds: { x: 10, y: 60, width: 80, height: 24 },
      attributes: {},
      interfaces: { component: true, action: true, editable: false, value: false },
      children: [],
    })
    const before = buildCuaSnapshot({ generation: 1, takenAt: 0, applications, maxElements: 10 })
    const second = before.elements.filter((element) => element.name === "Export")[1]!
    const single = buildCuaSnapshot({
      generation: 2,
      takenAt: 1,
      applications: atspiSnapshot().applications,
      maxElements: 10,
    })
    expect(resolveLooseElement(single, second.ref)?.name).toBe("Export")
  })

  test("window refs keep occurrence ordering for duplicate titles", () => {
    const snapshot = buildCuaSnapshot({
      generation: 1,
      takenAt: 0,
      applications: [
        {
          name: "app",
          nodes: [
            {
              index: 0,
              role: "application",
              name: "app",
              states: [],
              actions: [],
              attributes: {},
              interfaces: INERT_INTERFACES,
              children: [
                {
                  index: 0,
                  role: "frame",
                  name: "Same",
                  states: [],
                  actions: [],
                  bounds: { x: 0, y: 0, width: 100, height: 100 },
                  attributes: {},
                  interfaces: COMPONENT_INTERFACES,
                  children: [],
                },
                {
                  index: 1,
                  role: "frame",
                  name: "Same",
                  states: [],
                  actions: [],
                  bounds: { x: 100, y: 0, width: 100, height: 100 },
                  attributes: {},
                  interfaces: COMPONENT_INTERFACES,
                  children: [],
                },
              ],
            },
          ],
        },
      ],
      maxElements: 10,
    })
    expect(snapshot.windows.map((window) => window.ref)).toEqual([
      "cua:window/app/same/0",
      "cua:window/app/same/1",
    ])
    expect(resolveLooseWindow(snapshot, "cua:window/app/same/1")?.ref).toBe("cua:window/app/same/1")
  })

  test("matchX11WindowId refuses ambiguous exact titles", () => {
    const windows = [
      { id: "0x1", instance: "a", cls: "firefox", title: "Example page", active: false, x: 0, y: 0, width: 10, height: 10 },
      { id: "0x2", instance: "a", cls: "firefox", title: "Example page", active: false, x: 0, y: 0, width: 10, height: 10 },
    ]
    expect(matchX11WindowId(windows, { title: "Example page", app: "firefox" })).toBeUndefined()
    expect(matchX11WindowId([windows[0]!], { title: "Example page", app: "firefox" })).toBe("0x1")
    expect(matchX11WindowId(windows, { title: "example page", app: "other" })).toBeUndefined()
    expect(matchX11WindowId(windows, { title: "Example", app: "firefox" })).toBeUndefined()
  })

  test("matchX11WindowId accepts a unique prefix when the live title mutates", () => {
    const windows = [
      {
        id: "0x1",
        instance: "Navigator",
        cls: "firefox",
        title: "Example page — Mozilla Firefox",
        active: false,
        x: 0,
        y: 0,
        width: 10,
        height: 10,
      },
    ]
    expect(matchX11WindowId(windows, { title: "Example page", app: "firefox" })).toBe("0x1")
    expect(matchX11WindowId(windows, { title: "Example page — Mozilla Firefox", app: "firefox" })).toBe("0x1")
    // Fragments shorter than the prefix floor are never treated as prefixes.
    expect(matchX11WindowId(windows, { title: "Ex", app: "firefox" })).toBeUndefined()
    // A prefix that matches two windows is ambiguous and must be refused.
    const duplicated = [windows[0], { ...windows[0], id: "0x2", title: "Example page — second window" }]
    expect(matchX11WindowId(duplicated, { title: "Example page", app: "firefox" })).toBeUndefined()
  })
})

describe("cua linux persistent helper lifecycle", () => {
  test("reports exit and rejects requests immediately instead of queueing", async () => {
    const helper = createPersistentHelper({ interpreter: "/bin/true" })
    const ready = await helper.ready
    expect(ready.ok).toBe(false)
    expect(helper.exited).toBe(true)
    await expect(helper.request("snapshot")).rejects.toThrow("not running")
  })

  test("dispose is idempotent and rejects late requests", async () => {
    const helper = createPersistentHelper({ interpreter: "/bin/sh" })
    await helper.dispose()
    await helper.dispose()
    expect(helper.exited).toBe(true)
    await expect(helper.request("snapshot")).rejects.toThrow("disposed")
  })

  test("a crashed helper is dropped and restarts are gated by backoff", async () => {
    const backend = createLinuxBackend({
      runner: createFakeRunner().runner,
      interpreter: "/bin/true",
      accessibility: false,
      x11Windows: false,
      session: "x11",
      display: ":0",
      probeDisplay: false,
    })
    const first = await backend.snapshot()
    expect(first.elements).toHaveLength(0)
    const second = await backend.snapshot()
    expect(second.elements).toHaveLength(0)
    expect(await backend.available()).toBe(false)
  })

  test("restarts a helper that dies mid-request and replays the request once", async () => {
    const live = createFakeHelper(baseHandlers())
    let served = 0
    let exited = false
    const dying: CuaHelper = {
      ready: Promise.resolve({ ok: true, pyatspi: true, x11: true }),
      get exited() {
        return exited
      },
      request(command, params) {
        served += 1
        if (served > 1) {
          exited = true
          return Promise.reject(new Error("The Linux CUA helper is not running."))
        }
        return live.helper.request(command, params)
      },
      async dispose() {},
    }
    const created: CuaHelper[] = [dying, live.helper]
    let spawns = 0
    const backend = createLinuxBackend({
      createHelper: () => {
        spawns += 1
        return created.shift() ?? live.helper
      },
      runner: createFakeRunner().runner,
      accessibility: false,
      x11Windows: false,
      session: "x11",
      display: ":0",
      probeDisplay: false,
    })
    try {
      // The first snapshot is served by a helper that is about to crash.
      const first = await backend.snapshot()
      expect(first.windows).toHaveLength(1)
      // The crash happens while serving the second snapshot; the request is
      // replayed against a fresh helper instead of surfacing "not running".
      const second = await backend.snapshot()
      expect(second.windows).toHaveLength(1)
      expect(second.warnings.some((warning) => warning.includes("snapshot command failed"))).toBe(false)
      expect(spawns).toBe(2)
      expect(live.calls.filter((call) => call.command === "snapshot")).toHaveLength(2)
    } finally {
      await backend.dispose()
    }
  })

  test("readiness times out without resolving when the helper never signals", async () => {
    const directory = mkdtempSync(join(tmpdir(), "omnia-silent-helper-"))
    const interpreter = join(directory, "silent-helper")
    writeFileSync(interpreter, "#!/bin/sh\nwhile true; do sleep 1; done\n")
    chmodSync(interpreter, 0o755)
    const helper = createPersistentHelper({ interpreter })
    try {
      const settled = await Promise.race([
        helper.ready.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
      ])
      expect(settled).toBe(false)
      expect(helper.exited).toBe(false)
    } finally {
      await helper.dispose()
      rmSync(directory, { recursive: true, force: true })
    }
    expect(helper.exited).toBe(true)
  })

  test("requests racing a helper exit reject instead of crashing on EPIPE", async () => {
    const helper = createPersistentHelper({ interpreter: "/bin/sh" })
    const results = await Promise.allSettled([
      helper.request("snapshot"),
      helper.request("snapshot"),
      helper.request("snapshot"),
    ])
    for (const result of results) {
      expect(result.status).toBe("rejected")
    }
    await helper.dispose()
  }, 10000)

  test("dispose racing an in-flight request rejects the request", async () => {
    const directory = mkdtempSync(join(tmpdir(), "omnia-dispose-race-"))
    const interpreter = join(directory, "silent-helper")
    writeFileSync(interpreter, "#!/bin/sh\nwhile true; do sleep 1; done\n")
    chmodSync(interpreter, 0o755)
    try {
      const helper = createPersistentHelper({ interpreter })
      const pending = helper.request("snapshot", {}, 30000)
      await helper.dispose()
      await expect(pending).rejects.toThrow("disposed")
      expect(helper.exited).toBe(true)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe("cua linux merged X11 budget", () => {
  function x11Runner() {
    return (file: string, args: readonly string[]): CuaRunResult | undefined => {
      if (file === "xprop" && args[0] === "-root" && args[1] === "_NET_CLIENT_LIST") {
        return { stdout: "_NET_CLIENT_LIST(WINDOW): window id # 0x1\n", stderr: "" }
      }
      if (file === "xprop" && args[0] === "-root" && args[1] === "_NET_ACTIVE_WINDOW") {
        return { stdout: "_NET_ACTIVE_WINDOW(WINDOW): window id # 0x1\n", stderr: "" }
      }
      if (file === "xprop" && args[0] === "-id") {
        return { stdout: 'WM_CLASS(STRING) = "xterm", "XTerm"\nWM_NAME(STRING) = "Term"\n', stderr: "" }
      }
      if (file === "xwininfo" && args[0] === "-id") {
        return { stdout: "  Absolute upper-left X: 0\n  Absolute upper-left Y: 0\n  Width: 100\n  Height: 100\n", stderr: "" }
      }
      return undefined
    }
  }

  test("keeps merged X11 windows available when the element budget is tiny", async () => {
    const { backend } = createHarness({ x11Windows: true, onRun: x11Runner() })
    const snapshot = await backend.snapshot({ maxElements: 2 })
    expect(snapshot.elements.length).toBeLessThanOrEqual(2)
    expect(snapshot.truncated).toBe(true)
    const merged = snapshot.windows.find((window) => window.backendRef === "x11:0x1")
    expect(merged).toBeDefined()
    // The window is projected by toObservation; a second element copy with the
    // same ref would make title-based focus ambiguous.
    expect(snapshot.elements.some((element) => element.ref === merged?.ref)).toBe(false)
  })

  test("ambiguous X11 titles refuse window actions instead of guessing", async () => {
    const { backend } = createHarness({
      x11Windows: true,
      handlers: {
        ...baseHandlers(resolvedElement({ role: "frame", name: "Example page" })),
      },
      onRun: (file, args) => {
        if (file === "xprop" && args[0] === "-root" && args[1] === "_NET_CLIENT_LIST") {
          return { stdout: "_NET_CLIENT_LIST(WINDOW): window id # 0x1, 0x2\n", stderr: "" }
        }
        if (file === "xprop" && args[0] === "-root" && args[1] === "_NET_ACTIVE_WINDOW") {
          return { stdout: "_NET_ACTIVE_WINDOW(WINDOW): window id # 0x1\n", stderr: "" }
        }
        if (file === "xprop" && args[0] === "-id") {
          return { stdout: 'WM_CLASS(STRING) = "Navigator", "firefox"\nWM_NAME(STRING) = "Example page"\n', stderr: "" }
        }
        if (file === "xwininfo" && args[0] === "-id") {
          return { stdout: "  Absolute upper-left X: 0\n  Absolute upper-left Y: 0\n  Width: 100\n  Height: 100\n", stderr: "" }
        }
        return undefined
      },
    })
    const snapshot = await backend.snapshot()
    const window = snapshot.windows[0]
    if (window === undefined) throw new Error("fixture missing window")
    const result = await backend.execute({ type: "window", action: "close", ref: window.ref })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe("window_action_unavailable")
  })
})

describe("cua linux X11 app filtering and dedupe", () => {
  function windowRunner(
    windows: Readonly<Record<string, { instance: string; cls: string; title: string }>>,
  ): (file: string, args: readonly string[]) => CuaRunResult | undefined {
    const ids = Object.keys(windows)
    return (file, args) => {
      if (file === "xprop" && args[0] === "-root" && args[1] === "_NET_CLIENT_LIST") {
        return { stdout: `_NET_CLIENT_LIST(WINDOW): window id # ${ids.join(", ")}\n`, stderr: "" }
      }
      if (file === "xprop" && args[0] === "-root" && args[1] === "_NET_ACTIVE_WINDOW") {
        return { stdout: `_NET_ACTIVE_WINDOW(WINDOW): window id # ${ids[0]}\n`, stderr: "" }
      }
      if (file === "xprop" && args[0] === "-id") {
        const window = windows[args[1] ?? ""]
        if (window === undefined) return undefined
        return {
          stdout: `WM_CLASS(STRING) = "${window.instance}", "${window.cls}"\nWM_NAME(STRING) = "${window.title}"\n`,
          stderr: "",
        }
      }
      if (file === "xwininfo" && args[0] === "-id") {
        return {
          stdout: "  Absolute upper-left X: 0\n  Absolute upper-left Y: 0\n  Width: 100\n  Height: 100\n",
          stderr: "",
        }
      }
      return undefined
    }
  }

  test("keeps only X11 windows that match the requested app", async () => {
    const { backend } = createHarness({
      x11Windows: true,
      onRun: windowRunner({
        "0x1": { instance: "dolphin", cls: "dolphin", title: "Downloads" },
        "0x2": { instance: "kitty", cls: "kitty", title: "Term" },
      }),
    })
    // "files" is an alias of the X11 class "dolphin".
    const filtered = await backend.snapshot({ app: "files" })
    expect(filtered.windows.map((window) => window.app)).toEqual(["dolphin"])
    expect(filtered.windows[0]?.title).toBe("Downloads")
    expect(filtered.warnings.some((warning) => warning.startsWith("No application matched"))).toBe(false)
    const unfiltered = await backend.snapshot()
    expect(unfiltered.windows.map((window) => window.app).sort()).toEqual(["dolphin", "firefox", "kitty"])
  })

  test("dedupes an X11 window against an AT-SPI window with a normalized title", async () => {
    const { backend } = createHarness({
      x11Windows: true,
      onRun: windowRunner({
        "0x1": { instance: "Navigator", cls: "firefox", title: "Example Page" },
      }),
    })
    const snapshot = await backend.snapshot()
    expect(snapshot.windows).toHaveLength(1)
    expect(snapshot.windows[0]?.backendRef).toBe("atspi:0.1")
    expect(snapshot.windows.some((window) => window.backendRef.startsWith("x11:"))).toBe(false)
  })
})

describe("cua linux X11 merge ordering", () => {
  function multiWindowRunner(): (file: string, args: readonly string[]) => CuaRunResult | undefined {
    return (file, args) => {
      if (file === "xprop" && args[0] === "-root" && args[1] === "_NET_CLIENT_LIST") {
        return { stdout: "_NET_CLIENT_LIST(WINDOW): window id # 0x1, 0x2\n", stderr: "" }
      }
      if (file === "xprop" && args[0] === "-root" && args[1] === "_NET_ACTIVE_WINDOW") {
        return { stdout: "_NET_ACTIVE_WINDOW(WINDOW): window id # 0x2\n", stderr: "" }
      }
      if (file === "xprop" && args[0] === "-id") {
        const title = args[1] === "0x2" ? "Active Terminal" : "Background Terminal"
        return { stdout: `WM_CLASS(STRING) = "xterm", "XTerm"\nWM_NAME(STRING) = "${title}"\n`, stderr: "" }
      }
      if (file === "xwininfo" && args[0] === "-id") {
        return {
          stdout: "  Absolute upper-left X: 0\n  Absolute upper-left Y: 0\n  Width: 100\n  Height: 100\n",
          stderr: "",
        }
      }
      return undefined
    }
  }

  test("puts the active X11 window first in the merged snapshot", async () => {
    const { backend } = createHarness({ x11Windows: true, onRun: multiWindowRunner() })
    const snapshot = await backend.snapshot()
    expect(snapshot.windows.map((window) => window.backendRef)).toContain("x11:0x2")
    expect(snapshot.windows[0]?.backendRef).toBe("x11:0x2")
    expect(snapshot.windows[0]?.focused).toBe(true)
  })
})

describe("cua linux screenshot retention", () => {
  test("prunes old screenshots and keeps fresh ones", async () => {
    const { backend } = createHarness({
      onRun: (file, args) => {
        if (file === "grim") {
          const target = args[args.length - 1]
          if (target !== undefined) writeFileSync(target, "png")
          return { stdout: "", stderr: "" }
        }
        return undefined
      },
    })
    const directory = tmpdir()
    const old = join(directory, `omnia-cua-${Date.now()}-old.png`)
    const fresh = join(directory, `omnia-cua-${Date.now()}-fresh.png`)
    writeFileSync(old, "old")
    writeFileSync(fresh, "fresh")
    const past = new Date(Date.now() - 2 * 60 * 60 * 1000)
    await utimes(old, past, past)
    let captured: string | undefined
    try {
      const result = await backend.capture()
      expect(result.ok).toBe(true)
      captured = result.path
      expect(existsSync(old)).toBe(false)
      expect(existsSync(fresh)).toBe(true)
    } finally {
      rmSync(old, { force: true })
      rmSync(fresh, { force: true })
      if (captured !== undefined) rmSync(captured, { force: true })
    }
  })

  test("dispose cleans up clipboard holders without throwing", async () => {
    const directory = mkdtempSync(join(tmpdir(), "omnia-fake-python-"))
    const interpreter = join(directory, "fake-python")
    writeFileSync(interpreter, "#!/bin/sh\ncat > /dev/null\nexit 0\n")
    chmodSync(interpreter, 0o755)
    try {
      const { backend } = createHarness({
        interpreter,
        onRun: (_file, args) => {
          if (args[0] === "-c" && args[2] === "get") {
            return { stdout: JSON.stringify({ ok: true, text: "", complete: false }), stderr: "" }
          }
          if (args[0] === "-c" && args[2] === "type" && args.includes("--check")) {
            return { stdout: JSON.stringify({ ok: true, typed: 0, skipped: ["\u2603"] }), stderr: "" }
          }
          return undefined
        },
      })
      const result = await backend.execute({ type: "type", text: "snow \u2603" })
      expect(result.ok).toBe(true)
      await backend.dispose()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }, 10000)
})

describe("cua linux screen bounds", () => {
  test("unions the X11 root with the helper extents instead of shrinking", () => {
    expect(unionScreenBounds({ width: 1024, height: 768 }, { width: 1920, height: 1080 })).toEqual({
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
    })
    expect(
      unionScreenBounds(
        { x: -1920, y: 0, width: 1920, height: 1080 },
        { x: 0, y: 0, width: 1024, height: 768 },
      ),
    ).toEqual({ x: -1920, y: 0, width: 2944, height: 1080 })
  })

  test("accepts element centers on the real X11 desktop over a phantom helper screen", async () => {
    const phantom = atspiSnapshot()
    phantom.screen = { x: 0, y: 0, width: 1024, height: 768 }
    const { backend, runner } = createHarness({
      x11Windows: true,
      handlers: { ...baseHandlers(), snapshot: () => phantom, click: () => ({ result: true }) },
      onRun: (file, args) => {
        if (file === "xrandr" && args[0] === "--listmonitors") {
          return { stdout: "Monitors: 1\n 0: +*HDMI-0 1920/527x1080/296+0+0  HDMI-0\n", stderr: "" }
        }
        return undefined
      },
    })
    const snapshot = await backend.snapshot()
    expect(snapshot.screen).toEqual({ x: 0, y: 0, width: 1920, height: 1080 })
    const click = await backend.execute({ type: "click", point: { x: 1500, y: 500 }, captureId: snapshot.id })
    expect(click.ok).toBe(true)
    const beyond = await backend.execute({ type: "click", point: { x: 2500, y: 500 } })
    expect(beyond.ok).toBe(false)
    expect(beyond.error?.code).toBe("invalid_point")
    expect(runner.calls.some((call) => call.file === "xrandr")).toBe(true)
  })

  test("falls back to xwininfo -root when xrandr reports nothing", async () => {
    const phantom = atspiSnapshot()
    phantom.screen = { x: 0, y: 0, width: 1024, height: 768 }
    const { backend } = createHarness({
      x11Windows: true,
      handlers: { ...baseHandlers(), snapshot: () => phantom, click: () => ({ result: true }) },
      onRun: (file, args) => {
        if (file === "xwininfo" && args[0] === "-root") {
          return {
            stdout: "Absolute upper-left X: 0\nAbsolute upper-left Y: 0\nWidth: 1920\nHeight: 1080\n",
            stderr: "",
          }
        }
        return undefined
      },
    })
    const snapshot = await backend.snapshot()
    expect(snapshot.screen).toEqual({ x: 0, y: 0, width: 1920, height: 1080 })
  })

  test("keeps the helper extents when X11 geometry is unavailable", async () => {
    const phantom = atspiSnapshot()
    phantom.screen = { x: 0, y: 0, width: 1024, height: 768 }
    const { backend } = createHarness({
      x11Windows: true,
      handlers: { ...baseHandlers(), snapshot: () => phantom },
    })
    const snapshot = await backend.snapshot()
    expect(snapshot.screen).toEqual({ x: 0, y: 0, width: 1024, height: 768 })
  })
})

describe("cua linux dismiss", () => {
  test("presses Escape through the XTest keyboard path", async () => {
    const { backend, runner } = createHarness()
    await backend.snapshot()
    const result = await backend.execute({ type: "dismiss" })
    expect(result.ok).toBe(true)
    expect(result.delivery).toBe("keyboard")
    expect(runner.calls.some((call) => call.args.includes("Escape"))).toBe(true)
  })

  test("reports dismiss in capabilities", async () => {
    const { backend } = createHarness()
    expect((await backend.capabilities()).actions).toContain("dismiss")
  })
})

describe("cua linux window focus authority", () => {
  function focusRunner(isActive: () => boolean, onActivate: () => void = () => undefined) {
    return (file: string, args: readonly string[]): CuaRunResult | undefined => {
      if (file === "xprop" && args[0] === "-root" && args[1] === "_NET_CLIENT_LIST") {
        return { stdout: "_NET_CLIENT_LIST(WINDOW): window id # 0x1\n", stderr: "" }
      }
      if (file === "xprop" && args[0] === "-root" && args[1] === "_NET_ACTIVE_WINDOW") {
        return { stdout: `_NET_ACTIVE_WINDOW(WINDOW): window id # ${isActive() ? "0x1" : "0x9"}\n`, stderr: "" }
      }
      if (file === "xprop" && args[0] === "-id") {
        return {
          stdout: 'WM_CLASS(STRING) = "Navigator", "firefox"\nWM_NAME(STRING) = "Example page"\n',
          stderr: "",
        }
      }
      if (file === "xwininfo" && args[0] === "-id") {
        return {
          stdout: "  Absolute upper-left X: 0\n  Absolute upper-left Y: 0\n  Width: 100\n  Height: 100\n",
          stderr: "",
        }
      }
      if (file === "python3" && args.includes("activate")) {
        onActivate()
        return { stdout: JSON.stringify({ ok: true }), stderr: "" }
      }
      return undefined
    }
  }

  test("raises the AT-SPI window through X11 and verifies the active window", async () => {
    let activated = false
    const { backend } = createHarness({
      x11Windows: true,
      handlers: {
        ...baseHandlers(resolvedElement({ role: "frame", name: "Example page" })),
        window: () => ({ result: true }),
      },
      onRun: focusRunner(
        () => activated,
        () => {
          activated = true
        },
      ),
    })
    const snapshot = await backend.snapshot()
    const window = snapshot.windows[0]
    if (window === undefined) throw new Error("fixture missing window")
    const result = await backend.execute({ type: "window", action: "focus", ref: window.ref })
    expect(result.ok).toBe(true)
    expect(result.verified).toBe(true)
    expect(result.delivery).toBe("foreground-ax")
  })

  test("marks only the WM-active window focused even when AT-SPI disagrees", async () => {
    const { backend } = createHarness({ x11Windows: true, onRun: focusRunner(() => false) })
    const snapshot = await backend.snapshot()
    expect(snapshot.windows).toHaveLength(1)
    expect(snapshot.windows[0]?.focused).toBe(false)
  })

  test("stays honest when the WM keeps the Omnia window active", async () => {
    const { backend } = createHarness({
      x11Windows: true,
      handlers: {
        ...baseHandlers(resolvedElement({ role: "frame", name: "Example page" })),
        window: () => ({ result: true }),
      },
      onRun: focusRunner(() => false),
    })
    const snapshot = await backend.snapshot()
    const window = snapshot.windows[0]
    if (window === undefined) throw new Error("fixture missing window")
    const result = await backend.execute({ type: "window", action: "focus", ref: window.ref })
    expect(result.ok).toBe(true)
    expect(result.verified).toBe(false)
    expect(result.warnings?.some((warning) => warning.includes("active window is still 0x9"))).toBe(true)
  })
})

describe("cua linux window identity", () => {
  function frame(
    index: number,
    name: string,
    bounds: { x: number; y: number; width: number; height: number },
    states: string[] = [],
    children: AtspiNodeSnapshot[] = [],
  ): AtspiNodeSnapshot {
    return {
      index,
      role: "frame",
      name,
      states,
      actions: [],
      bounds,
      attributes: {},
      interfaces: COMPONENT_INTERFACES,
      children,
    }
  }

  function app(name: string, frames: AtspiNodeSnapshot[]): AtspiNodeSnapshot {
    return {
      index: 0,
      role: "application",
      name,
      states: [],
      actions: [],
      attributes: {},
      interfaces: INERT_INTERFACES,
      children: frames,
    }
  }

  test("keeps distinct refs and windowRefs for frames whose titles slug the same", () => {
    const snapshot = buildCuaSnapshot({
      generation: 1,
      takenAt: 0,
      applications: [
        {
          name: "Dolphin",
          nodes: [
            app("Dolphin", [
              frame(0, "opencode", { x: 0, y: 0, width: 100, height: 100 }, [], [
                {
                  index: 0,
                  role: "pushbutton",
                  name: "Open Folder",
                  states: [],
                  actions: ["click"],
                  bounds: { x: 10, y: 10, width: 20, height: 20 },
                  attributes: {},
                  interfaces: COMPONENT_INTERFACES,
                  children: [],
                },
              ]),
              frame(1, "OpenCode", { x: 200, y: 0, width: 100, height: 100 }, [], [
                {
                  index: 0,
                  role: "pushbutton",
                  name: "Open Folder",
                  states: [],
                  actions: ["click"],
                  bounds: { x: 210, y: 10, width: 20, height: 20 },
                  attributes: {},
                  interfaces: COMPONENT_INTERFACES,
                  children: [],
                },
              ]),
            ]),
          ],
        },
      ],
      maxElements: 20,
    })
    expect(snapshot.windows.map((window) => window.ref)).toEqual([
      "cua:window/dolphin/opencode/0",
      "cua:window/dolphin/opencode/1",
    ])
    expect(snapshot.elements.filter((element) => element.name === "Open Folder").map((element) => element.windowRef)).toEqual([
      "cua:window/dolphin/opencode/0",
      "cua:window/dolphin/opencode/1",
    ])
  })

  test("splits nested frames into distinct windows with their own windowRefs", () => {
    const button = (index: number): AtspiNodeSnapshot => ({
      index,
      role: "pushbutton",
      name: "Open Folder",
      states: [],
      actions: ["click"],
      bounds: { x: 10, y: 10, width: 20, height: 20 },
      attributes: {},
      interfaces: COMPONENT_INTERFACES,
      children: [],
    })
    const snapshot = buildCuaSnapshot({
      generation: 1,
      takenAt: 0,
      applications: [
        {
          name: "Dolphin",
          nodes: [
            app("Dolphin", [
              frame(0, "opencode", { x: 0, y: 0, width: 400, height: 300 }, [], [
                frame(0, "Default Project", { x: 10, y: 10, width: 100, height: 100 }, [], [button(0)]),
                frame(1, "Downloads", { x: 150, y: 10, width: 100, height: 100 }, [], [button(0)]),
              ]),
            ]),
          ],
        },
      ],
      maxElements: 20,
    })
    expect(snapshot.windows.map((window) => window.ref)).toEqual([
      "cua:window/dolphin/opencode/0",
      "cua:window/dolphin/default-project/0",
      "cua:window/dolphin/downloads/0",
    ])
    expect(
      snapshot.elements.filter((element) => element.name === "Open Folder").map((element) => element.windowRef),
    ).toEqual(["cua:window/dolphin/default-project/0", "cua:window/dolphin/downloads/0"])
    // Every element belongs to a declared window, and the nested window nodes
    // are not also listed as window-role elements.
    const windowRefs = new Set(snapshot.windows.map((window) => window.ref))
    expect(snapshot.elements.every((element) => element.windowRef !== undefined && windowRefs.has(element.windowRef))).toBe(
      true,
    )
    expect(snapshot.elements.some((element) => element.role === "window")).toBe(false)
  })

  test("does not split web iframes or tagged in-page dialogs into windows", () => {
    const snapshot = buildCuaSnapshot({
      generation: 1,
      takenAt: 0,
      applications: [
        {
          name: "firefox",
          nodes: [
            app("firefox", [
              frame(0, "Example page", { x: 0, y: 0, width: 800, height: 600 }, [], [
                {
                  index: 0,
                  role: "internalframe",
                  name: "Sign in with Google",
                  states: [],
                  actions: [],
                  bounds: { x: 100, y: 100, width: 300, height: 200 },
                  attributes: { tag: "iframe" },
                  interfaces: COMPONENT_INTERFACES,
                  children: [
                    {
                      index: 0,
                      role: "pushbutton",
                      name: "Open Folder",
                      states: [],
                      actions: ["click"],
                      bounds: { x: 110, y: 110, width: 20, height: 20 },
                      attributes: {},
                      interfaces: COMPONENT_INTERFACES,
                      children: [],
                    },
                  ],
                },
                {
                  index: 1,
                  role: "dialog",
                  name: "Free models",
                  states: [],
                  actions: [],
                  bounds: { x: 200, y: 100, width: 300, height: 400 },
                  attributes: { tag: "div" },
                  interfaces: COMPONENT_INTERFACES,
                  children: [],
                },
              ]),
            ]),
          ],
        },
      ],
      maxElements: 20,
    })
    expect(snapshot.windows.map((window) => window.ref)).toEqual(["cua:window/firefox/example-page/0"])
    expect(snapshot.elements.some((element) => element.role === "window" && element.name === "Sign in with Google")).toBe(
      false,
    )
    expect(requireElement(snapshot, "Open Folder").windowRef).toBe("cua:window/firefox/example-page/0")
  })

  test("keeps a same-title client area inside its frame window", () => {
    const snapshot = buildCuaSnapshot({
      generation: 1,
      takenAt: 0,
      applications: [
        {
          name: "Dolphin",
          nodes: [
            app("Dolphin", [
              frame(0, "opencode", { x: 0, y: 0, width: 400, height: 300 }, [], [
                frame(0, "opencode", { x: 0, y: 28, width: 400, height: 272 }, ["focused"], [
                  {
                    index: 0,
                    role: "pushbutton",
                    name: "Open Folder",
                    states: [],
                    actions: ["click"],
                    bounds: { x: 10, y: 30, width: 20, height: 20 },
                    attributes: {},
                    interfaces: COMPONENT_INTERFACES,
                    children: [],
                  },
                ]),
              ]),
            ]),
          ],
        },
      ],
      maxElements: 20,
    })
    expect(snapshot.windows.map((window) => window.ref)).toEqual(["cua:window/dolphin/opencode/0"])
    expect(requireElement(snapshot, "Open Folder").windowRef).toBe("cua:window/dolphin/opencode/0")
    // Exactly one window record and no second window-role element means
    // title-based focus cannot be ambiguous.
    expect(snapshot.windows.filter((window) => window.title === "opencode")).toHaveLength(1)
    expect(snapshot.elements.some((element) => element.role === "window")).toBe(false)
  })

  test("assigns unique occurrences across slug-equivalent AT-SPI and X11 apps", async () => {
    const { backend } = createHarness({
      x11Windows: true,
      onRun: (file, args) => {
        if (file === "xprop" && args[0] === "-root" && args[1] === "_NET_CLIENT_LIST") {
          return { stdout: "_NET_CLIENT_LIST(WINDOW): window id # 0x1\n", stderr: "" }
        }
        if (file === "xprop" && args[0] === "-root" && args[1] === "_NET_ACTIVE_WINDOW") {
          return { stdout: "_NET_ACTIVE_WINDOW(WINDOW): window id # 0x9\n", stderr: "" }
        }
        if (file === "xprop" && args[0] === "-id") {
          return { stdout: 'WM_CLASS(STRING) = "Navigator", "firefox"\nWM_NAME(STRING) = "Example page"\n', stderr: "" }
        }
        if (file === "xwininfo" && args[0] === "-id") {
          return {
            stdout: "  Absolute upper-left X: 0\n  Absolute upper-left Y: 5000\n  Width: 100\n  Height: 100\n",
            stderr: "",
          }
        }
        return undefined
      },
    })
    const snapshot = await backend.snapshot()
    expect(snapshot.windows.map((window) => window.ref)).toEqual([
      "cua:window/firefox/example-page/0",
      "cua:window/firefox/example-page/1",
    ])
  })

  test("dedupes an X11 window against a minimized AT-SPI window with stale bounds", async () => {
    const minimized = atspiSnapshot()
    // atspiSnapshot names the app "firefox" (lowercase); the X11 class matches.
    const frameNode = minimized.applications[0]?.nodes[0]?.children[0]
    if (frameNode === undefined) throw new Error("fixture missing frame")
    frameNode.states = ["iconified"]
    frameNode.bounds = { x: 0, y: 5000, width: 100, height: 100 }
    const { backend } = createHarness({
      x11Windows: true,
      handlers: { ...baseHandlers(), snapshot: () => minimized },
      onRun: (file, args) => {
        if (file === "xprop" && args[0] === "-root" && args[1] === "_NET_CLIENT_LIST") {
          return { stdout: "_NET_CLIENT_LIST(WINDOW): window id # 0x1\n", stderr: "" }
        }
        if (file === "xprop" && args[0] === "-root" && args[1] === "_NET_ACTIVE_WINDOW") {
          return { stdout: "_NET_ACTIVE_WINDOW(WINDOW): window id # 0x1\n", stderr: "" }
        }
        if (file === "xprop" && args[0] === "-id") {
          return { stdout: 'WM_CLASS(STRING) = "Navigator", "firefox"\nWM_NAME(STRING) = "Example page"\n', stderr: "" }
        }
        if (file === "xwininfo" && args[0] === "-id") {
          return {
            stdout: "  Absolute upper-left X: 0\n  Absolute upper-left Y: 0\n  Width: 100\n  Height: 100\n",
            stderr: "",
          }
        }
        return undefined
      },
    })
    const snapshot = await backend.snapshot()
    expect(snapshot.windows).toHaveLength(1)
    expect(snapshot.windows[0]?.backendRef).toBe("atspi:0.1")
    expect(snapshot.windows[0]?.minimized).toBe(true)
  })
})

const integrationDisplay = process.env.DISPLAY
const hasIntegrationDisplay = integrationDisplay !== undefined && integrationDisplay.length > 0
const describeIntegration = hasIntegrationDisplay ? describe : describe.skip
// Injecting real input into a live desktop is only safe when the display is an
// isolated X server (Xvfb); require an explicit opt-in so `bun test` on a
// developer's session never sends keys anywhere.
const describeInputIntegration =
  hasIntegrationDisplay && process.env.OMNIA_CUA_XTEST_INTEGRATION === "1" ? describe : describe.skip

describeIntegration("cua linux integration", () => {
  test("snapshots the desktop when pyatspi is available", async () => {
    const backend = createLinuxBackend()
    try {
      if (!(await backend.available())) return
      const snapshot = await backend.snapshot({ maxElements: 50 })
      expect(snapshot.platform).toBe("linux")
      expect(snapshot.generation).toBeGreaterThan(0)
      expect(snapshot.id).toBe(`cap-${snapshot.generation}`)
      expect(Array.isArray(snapshot.elements)).toBe(true)
      expect(Array.isArray(snapshot.windows)).toBe(true)
      expect((await backend.capabilities()).snapshot).toBe(true)
    } finally {
      await backend.dispose()
    }
  })
})

describeInputIntegration("cua linux XTest integration", () => {
  test("sends a key through the X11 input helper", async () => {
    const backend = createLinuxBackend()
    try {
      const result = await backend.execute({ type: "key", keys: ["ctrl", "c"] })
      expect(result.ok).toBe(true)
      expect(result.delivery).toBe("keyboard")
    } finally {
      await backend.dispose()
    }
  }, 30000)
})
