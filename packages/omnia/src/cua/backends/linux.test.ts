import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { utimes } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CuaElement, CuaSnapshot } from "../types"
import type { LinuxSessionType } from "../../daemon/wayland"
import type {
  AtspiApplicationSnapshot,
  AtspiNodeSnapshot,
  AtspiSnapshotPayload,
  HelperLine,
  HelperReady,
  ResolvedElementPayload,
} from "./linux-script"
import { parseHelperLine, parseResolvedPayload, parseSnapshotPayload, LINUX_CUA_SCRIPT } from "./linux-script"
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
  parseWlrRandrGeometry,
  rawAtspiActions,
  resolveLooseElement,
  resolveLooseWindow,
  slugify,
  unionScreenBounds,
  type CuaHelper,
  type CuaRunner,
  type CuaRunResult,
} from "./linux"
import { limitSnapshot } from "./snapshot-limit"

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

// A window whose frame holds one control of every kind an agent acts on, so
// role, state, action, bounds, text, description, and parent mapping are all
// exercised by the same walk.
function nestedControlTree(): AtspiApplicationSnapshot[] {
  return [
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
                  name: "Save",
                  description: "Save the document",
                  states: ["enabled", "focused"],
                  actions: ["click"],
                  bounds: { x: 12, y: 40, width: 90, height: 26 },
                  attributes: {},
                  interfaces: { component: true, action: true, editable: false, value: false },
                  children: [
                    {
                      index: 0,
                      role: "label",
                      name: "Save",
                      states: ["enabled"],
                      actions: [],
                      attributes: {},
                      interfaces: INERT_INTERFACES,
                      children: [],
                    },
                  ],
                },
                {
                  index: 1,
                  role: "entry",
                  name: "Search",
                  text: "the quick brown fox",
                  states: ["enabled", "editable"],
                  actions: [],
                  bounds: { x: 12, y: 80, width: 240, height: 24 },
                  attributes: { placeholder: "Search the web" },
                  interfaces: { component: true, action: false, editable: true, value: false },
                  children: [
                    {
                      index: 0,
                      role: "label",
                      name: "Search",
                      states: ["enabled"],
                      actions: [],
                      attributes: {},
                      interfaces: INERT_INTERFACES,
                      children: [],
                    },
                  ],
                },
                {
                  index: 2,
                  role: "panel",
                  name: "",
                  states: ["enabled"],
                  actions: [],
                  bounds: { x: 12, y: 120, width: 500, height: 200 },
                  attributes: {},
                  interfaces: COMPONENT_INTERFACES,
                  children: [
                    {
                      index: 0,
                      role: "combobox",
                      name: "Colour",
                      states: ["enabled", "expanded"],
                      actions: ["select"],
                      bounds: { x: 20, y: 130, width: 120, height: 24 },
                      attributes: {},
                      interfaces: { component: true, action: true, editable: false, value: true },
                      children: [],
                    },
                    {
                      index: 1,
                      role: "checkbox",
                      name: "Bold",
                      states: ["enabled", "checked"],
                      actions: ["toggle"],
                      bounds: { x: 20, y: 160, width: 120, height: 24 },
                      attributes: {},
                      interfaces: { component: true, action: true, editable: false, value: false },
                      children: [],
                    },
                    {
                      index: 2,
                      role: "pagetab",
                      name: "Details",
                      states: ["enabled", "selected"],
                      actions: ["jump"],
                      bounds: { x: 20, y: 190, width: 120, height: 24 },
                      attributes: {},
                      interfaces: { component: true, action: true, editable: false, value: false },
                      children: [],
                    },
                  ],
                },
                {
                  index: 3,
                  role: "radiobutton",
                  name: "Left",
                  states: ["enabled", "selected"],
                  actions: ["select"],
                  bounds: { x: 12, y: 330, width: 100, height: 20 },
                  attributes: {},
                  interfaces: { component: true, action: true, editable: false, value: false },
                  children: [],
                },
                {
                  index: 4,
                  role: "listitem",
                  name: "Documents",
                  states: ["enabled", "selected"],
                  actions: ["select"],
                  bounds: { x: 12, y: 356, width: 100, height: 20 },
                  attributes: {},
                  interfaces: { component: true, action: true, editable: false, value: false },
                  children: [],
                },
                {
                  index: 5,
                  role: "menuitem",
                  name: "New",
                  states: ["enabled"],
                  actions: ["click"],
                  bounds: { x: 12, y: 380, width: 100, height: 20 },
                  attributes: {},
                  interfaces: { component: true, action: true, editable: false, value: false },
                  children: [],
                },
                {
                  index: 6,
                  role: "slider",
                  name: "Volume",
                  states: ["enabled"],
                  actions: [],
                  bounds: { x: 12, y: 404, width: 100, height: 20 },
                  attributes: { minimum: "0", maximum: "100", step: "5" },
                  interfaces: { component: true, action: false, editable: false, value: true },
                  children: [],
                },
                {
                  index: 7,
                  role: "spinbutton",
                  name: "Zoom",
                  states: ["enabled"],
                  actions: [],
                  bounds: { x: 12, y: 428, width: 100, height: 20 },
                  attributes: { minimum: "0.25", maximum: "4", step: "0.25" },
                  interfaces: { component: true, action: false, editable: false, value: true },
                  children: [],
                },
                {
                  index: 8,
                  role: "treeitem",
                  name: "Chapter 1",
                  states: ["enabled", "selected", "expanded"],
                  actions: ["expand or contract"],
                  bounds: { x: 12, y: 452, width: 100, height: 20 },
                  attributes: {},
                  interfaces: { component: true, action: true, editable: false, value: false },
                  children: [],
                },
                {
                  index: 9,
                  role: "searchbox",
                  name: "Find",
                  states: ["enabled", "editable"],
                  actions: [],
                  bounds: { x: 12, y: 476, width: 100, height: 20 },
                  attributes: {},
                  interfaces: { component: true, action: false, editable: true, value: false },
                  children: [],
                },
              ],
            },
          ],
        },
      ],
    },
  ]
}

// A chain of passive containers `depth` deep with a named control at every
// level, so a depth cut is observable level by level. Children are visited in
// order: container first, then its controls.
function deepChain(depth: number): AtspiApplicationSnapshot[] {
  const button = (name: string): AtspiNodeSnapshot => ({
    index: 0,
    role: "pushbutton",
    name,
    states: ["enabled"],
    actions: ["click"],
    bounds: { x: 1, y: 1, width: 10, height: 10 },
    attributes: {},
    interfaces: { component: true, action: true, editable: false, value: false },
    children: [],
  })
  let node: AtspiNodeSnapshot = button("Leaf 0")
  for (let level = 1; level <= depth; level += 1) {
    node = {
      index: 0,
      role: "panel",
      name: `Level ${level}`,
      states: ["enabled"],
      actions: [],
      bounds: { x: 0, y: 0, width: 400, height: 400 },
      attributes: {},
      interfaces: COMPONENT_INTERFACES,
      children: [node, button(`Leaf ${level}`)],
    }
  }
  return [
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
              name: "Deep",
              states: ["focused"],
              actions: [],
              bounds: { x: 0, y: 0, width: 1024, height: 768 },
              attributes: {},
              interfaces: COMPONENT_INTERFACES,
              children: [node],
            },
          ],
        },
      ],
    },
  ]
}

function wideWindow(count: number): AtspiApplicationSnapshot[] {
  return [
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
              name: "Busy",
              states: ["focused"],
              actions: [],
              bounds: { x: 0, y: 0, width: 1024, height: 768 },
              attributes: {},
              interfaces: COMPONENT_INTERFACES,
              children: Array.from({ length: count }, (_, index) => ({
                index,
                role: "pushbutton",
                name: `Item ${index}`,
                states: ["enabled"],
                actions: ["click"],
                bounds: { x: 0, y: index * 24, width: 80, height: 20 },
                attributes: {},
                interfaces: { component: true, action: true, editable: false, value: false },
                children: [],
              })),
            },
          ],
        },
      ],
    },
  ]
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

  test("discovers nested controls with their states, actions, bounds, and parent chain", () => {
    const snapshot = buildCuaSnapshot({
      generation: 7,
      takenAt: 10,
      applications: nestedControlTree(),
      maxElements: 500,
    })
    expect(snapshot.accessibility).toBe("available")
    const save = requireElement(snapshot, "Save")
    expect(save.role).toBe("button")
    expect(save.states).toEqual(["enabled", "focused"])
    expect(save.enabled).toBe(true)
    expect(save.focused).toBe(true)
    // The raw AT-SPI actions stay in the attributes so invoke can pick one.
    expect(save.attributes?.atspiActions).toBe("click")
    expect(save.actions).toContain("click")
    expect(save.actions).toContain("focus")
    expect(save.description).toBe("Save the document")
    expect(save.bounds).toEqual({ x: 12, y: 40, width: 90, height: 26 })
    expect(save.windowRef).toBe("cua:window/firefox/example-page/0")
    expect(save.generation).toBe(7)
    // Actionable controls below the toolbar keep their ancestry.
    const combo = requireElement(snapshot, "Colour")
    expect(combo.role).toBe("combobox")
    expect(combo.states).toContain("expanded")
    expect(combo.actions).toContain("select")
    expect(combo.actions).toContain("set_value")
    const panelRef = "cua:window/firefox/example-page/0/group/unnamed/0"
    expect(combo.parentRef).toBe(panelRef)
    expect(requireElement(snapshot, "Bold").parentRef).toBe(panelRef)
    expect(requireElement(snapshot, "Details").parentRef).toBe(panelRef)
    expect(requireElement(snapshot, "Details").states).toContain("selected")
    expect(requireElement(snapshot, "Bold").role).toBe("checkbox")
    expect(requireElement(snapshot, "Bold").actions).toEqual(["focus", "toggle", "scroll_into_view"])
    expect(requireElement(snapshot, "Left").role).toBe("radio")
    expect(requireElement(snapshot, "New").role).toBe("menuitem")
    expect(requireElement(snapshot, "Documents").role).toBe("listitem")
    expect(requireElement(snapshot, "Details").role).toBe("tab")
    expect(requireElement(snapshot, "Volume").role).toBe("slider")
    expect(requireElement(snapshot, "Zoom").role).toBe("spinbutton")
    const chapter = requireElement(snapshot, "Chapter 1")
    expect(chapter.role).toBe("treeitem")
    expect(chapter.states).toEqual(["enabled", "selected", "expanded"])
    // Text and value reach the element record instead of being dropped.
    const search = requireElement(snapshot, "Search")
    expect(search.role).toBe("textbox")
    expect(search.editable).toBe(true)
    expect(search.states).toContain("editable")
    expect(search.text).toBe("the quick brown fox")
    expect(search.attributes?.placeholder).toBe("Search the web")
    expect(requireElement(snapshot, "Find").role).toBe("searchbox")
    // The window node itself never becomes a duplicate element.
    expect(snapshot.elements.some((element) => element.role === "window")).toBe(false)
  })

  test("keeps refs stable for the same desktop within a generation", () => {
    const input = { generation: 5, takenAt: 4, applications: nestedControlTree(), maxElements: 500 }
    const first = buildCuaSnapshot(input)
    const second = buildCuaSnapshot(input)
    expect(first.elements.map((element) => element.ref)).toEqual(second.elements.map((element) => element.ref))
    expect(first.elements.every((element) => element.generation === 5)).toBe(true)
    expect(requireElement(first, "Colour").ref).toBe("cua:window/firefox/example-page/0/combobox/colour/0")
    // A new generation re-mints the ids so a stale ref can never look current.
    const next = buildCuaSnapshot({ ...input, generation: 6 })
    expect(next.elements.some((element) => element.generation === 6)).toBe(true)
  })

  test("enforces the element depth bound and reports it as degraded", () => {
    const shallow = buildCuaSnapshot({
      generation: 1,
      takenAt: 0,
      applications: deepChain(3),
      maxElements: 500,
    })
    expect(shallow.accessibility).toBe("available")
    expect(shallow.elements.map((element) => element.name).sort()).toEqual([
      "Leaf 0",
      "Leaf 1",
      "Leaf 2",
      "Leaf 3",
      "Level 1",
      "Level 2",
      "Level 3",
    ])

    const bounded = buildCuaSnapshot({
      generation: 1,
      takenAt: 0,
      applications: deepChain(3),
      maxDepth: 2,
      maxElements: 500,
    })
    expect(bounded.elements.map((element) => element.name).sort()).toEqual(["Leaf 3", "Level 2", "Level 3"])
    expect(bounded.accessibility).toBe("degraded")
    expect(bounded.truncated).toBe(true)
    expect(bounded.warnings.some((warning) => warning.includes("deeper than 2 levels"))).toBe(true)
    // The cut never renumbers or renames a ref that survived it.
    const shallowRefs = new Map(shallow.elements.map((element) => [element.ref, element.name]))
    expect(bounded.elements.every((element) => shallowRefs.get(element.ref) === element.name)).toBe(true)
  })

  test("caps the elements of one window and keeps the shallow controls", () => {
    const applications = wideWindow(6)
    const capped = buildCuaSnapshot({
      generation: 2,
      takenAt: 0,
      applications,
      maxElementsPerWindow: 3,
      maxElements: 500,
    })
    expect(capped.elements).toHaveLength(3)
    expect(capped.elements.map((element) => element.name)).toEqual(["Item 0", "Item 1", "Item 2"])
    expect(capped.accessibility).toBe("degraded")
    expect(capped.truncated).toBe(true)
    expect(capped.windows[0]?.title).toBe("Busy")
    expect(capped.warnings.some((warning) => warning.includes("more than 3 elements"))).toBe(true)
    // A cap is a prefix of the full walk: no ref is renumbered or lost behind it.
    const full = buildCuaSnapshot({ generation: 2, takenAt: 0, applications, maxElements: 500 })
    expect(full.elements.slice(0, 3).map((element) => element.ref)).toEqual(
      capped.elements.map((element) => element.ref),
    )
    expect(full.accessibility).toBe("available")
  })

  test("a window with no element at all is never reported as a healthy read", () => {
    const snapshot = buildCuaSnapshot({
      generation: 9,
      takenAt: 0,
      applications: [
        {
          name: "kitty",
          nodes: [
            {
              index: 0,
              role: "application",
              name: "kitty",
              states: [],
              actions: [],
              bounds: { x: 0, y: 0, width: 800, height: 600 },
              attributes: {},
              interfaces: INERT_INTERFACES,
              children: [
                {
                  index: 0,
                  role: "frame",
                  name: "shell",
                  states: [],
                  actions: [],
                  bounds: { x: 0, y: 0, width: 800, height: 600 },
                  attributes: {},
                  interfaces: COMPONENT_INTERFACES,
                  children: [],
                },
              ],
            },
          ],
        },
      ],
      maxElements: 500,
    })
    expect(snapshot.windows).toHaveLength(1)
    expect(snapshot.elements).toHaveLength(0)
    expect(snapshot.accessibility).toBe("degraded")
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
  allowRebind?: boolean
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
    ...(options.allowRebind === true ? { allowRebind: true } : {}),
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
    expect(helper.calls.map((call) => call.command)).toEqual(["probe", "snapshot", "resolve", "act"])
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
    expect(helper.calls.map((call) => call.command)).toEqual(["probe", "snapshot", "resolve", "set-text", "focus", "set-text"])
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

  test("refuses silent clipboard paste and requires explicit allowClipboardPaste", async () => {
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
            return { stdout: JSON.stringify({ ok: true, typed: 0, skipped: ["☃"] }), stderr: "" }
          }
          return undefined
        },
      })
      // Silent paste is refused: the caller must opt in explicitly.
      const silent = await backend.execute({ type: "type", text: "snow ☃" })
      expect(silent.ok).toBe(false)
      expect(silent.error?.code).toBe("clipboard_paste_required")
      // Explicit opt-in pastes through the clipboard and restores it.
      const explicit = await backend.execute({ type: "type", text: "snow ☃", allowClipboardPaste: true })
      expect(explicit.ok).toBe(true)
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

  test("drops Omnia's own X11 windows from the merged snapshot", async () => {
    const { backend } = createHarness({
      x11Windows: true,
      onRun: windowRunner({
        "0x1": { instance: "firefox", cls: "firefox", title: "Example Page" },
        "0x2": { instance: "io.omnia.desktop", cls: "io.omnia.desktop", title: "Omnia" },
        "0x3": { instance: "omnia", cls: "omnia", title: "Omnia" },
      }),
      handlers: { ...baseHandlers(), snapshot: () => ({ applications: [] }) },
    })
    const snapshot = await backend.snapshot()
    // Omnia's own window is only reachable through X11 here, and it still must
    // not be shown to an agent as the most prominent window on the desktop.
    expect(snapshot.windows.map((window) => window.app)).toEqual(["firefox"])
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
            return { stdout: JSON.stringify({ ok: true, typed: 0, skipped: ["☃"] }), stderr: "" }
          }
          return undefined
        },
      })
      // Silent paste is refused, so no clipboard holder is leaked; dispose is
      // still clean.
      const result = await backend.execute({ type: "type", text: "snow ☃" })
      expect(result.ok).toBe(false)
      expect(result.error?.code).toBe("clipboard_paste_required")
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

  test("accepts negative coordinates when a monitor sits left of the primary", async () => {
    const shifted = atspiSnapshot()
    shifted.screen = { x: -1920, y: 0, width: 1920, height: 1080 }
    const { backend } = createHarness({
      x11Windows: false,
      handlers: { ...baseHandlers(), snapshot: () => shifted, click: () => ({ result: true }) },
    })
    const snapshot = await backend.snapshot()
    expect(snapshot.screen).toEqual({ x: -1920, y: 0, width: 1920, height: 1080 })
    const click = await backend.execute({ type: "click", point: { x: -100, y: 100 }, captureId: snapshot.id })
    expect(click.ok).toBe(true)
    const outside = await backend.execute({ type: "click", point: { x: -2500, y: 100 } })
    expect(outside.ok).toBe(false)
    expect(outside.error?.code).toBe("invalid_point")
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

describe("cua linux focused snapshots and helper cache", () => {
  function focusedAppSnapshot(signature: string): AtspiSnapshotPayload {
    const payload = atspiSnapshot()
    const application = payload.applications[0]
    if (application === undefined) throw new Error("fixture missing application")
    application.key = "pid:42"
    application.signature = signature
    application.index = 0
    const frame = application.nodes[0]?.children[0]
    if (frame === undefined) throw new Error("fixture missing frame")
    for (let index = 0; index < 4; index += 1) {
      frame.children.push({
        index: 10 + index,
        role: "label",
        name: `Note ${index}`,
        states: [],
        actions: [],
        attributes: {},
        interfaces: INERT_INTERFACES,
        children: [],
      })
    }
    return payload
  }

  function focusedHandlers(signature: () => string): FakeHandlerMap {
    return {
      ...baseHandlers(),
      probe: () => ({
        apps: [{ key: "pid:42", signature: signature(), index: 0, name: "firefox", pid: 42 }],
        fallback: false,
        focused: "pid:42",
      }),
      snapshot: () => focusedAppSnapshot(signature()),
    }
  }

  test("walks only the focused application and selects it by active pid", async () => {
    const { backend, helper } = createHarness({
      x11Windows: true,
      handlers: focusedHandlers(() => "s1"),
      onRun: (file, args) => {
        if (file === "xprop" && args[0] === "-root" && args[1] === "_NET_ACTIVE_WINDOW") {
          return { stdout: "_NET_ACTIVE_WINDOW(WINDOW): window id # 0x1\n", stderr: "" }
        }
        if (file === "xprop" && args[0] === "-id" && args[2] === "_NET_WM_PID") {
          return { stdout: "_NET_WM_PID(CARDINAL) = 42\n", stderr: "" }
        }
        return undefined
      },
    })
    await backend.snapshot()
    const params = helper.calls.find((call) => call.command === "snapshot")?.params
    expect(params?.scope).toBe("focused")
    expect(params?.active_pid).toBe(42)
    expect(params?.app).toBeUndefined()
    // The observe budget must not cap the helper walk; find reuses this walk.
    expect(params?.max_nodes).toBeGreaterThan(2000)
  })

  test("reuses the helper walk until the signature changes", async () => {
    let signature = "s1"
    const { backend, helper } = createHarness({ handlers: focusedHandlers(() => signature) })
    const capped = await backend.snapshot({ maxElements: 1 })
    expect(capped.elements.filter((element) => element.role === "button")).toHaveLength(1)
    expect(capped.elements.length).toBeGreaterThanOrEqual(3)
    const full = await backend.snapshot({ maxElements: 10_000 })
    expect(helper.calls.filter((call) => call.command === "snapshot")).toHaveLength(1)
    expect(full.elements.map((element) => element.name)).toContain("Volume")
    signature = "s2"
    await backend.snapshot()
    expect(helper.calls.filter((call) => call.command === "snapshot")).toHaveLength(2)
  })

  test("find filters the cached full walk without another helper call", async () => {
    const { backend, helper } = createHarness({ handlers: focusedHandlers(() => "s1") })
    const small = await backend.snapshot({ maxElements: 1 })
    const full = await backend.snapshot({ maxElements: 10_000 })
    const found = await backend.find({ name: "Volume" }, full)
    expect(found.map((element) => element.name)).toEqual(["Volume"])
    expect(full.elements.length).toBeGreaterThan(small.elements.length)
    expect(helper.calls.filter((call) => call.command === "snapshot")).toHaveLength(1)
  })

  test("refreshWindow forces a fresh focused-app walk and refuses unknown refs", async () => {
    const { backend, helper } = createHarness({ handlers: focusedHandlers(() => "s1") })
    const snapshot = await backend.snapshot()
    const windowRef = snapshot.windows[0]?.ref
    if (windowRef === undefined) throw new Error("fixture missing window")
    const refreshed = await backend.refreshWindow(windowRef)
    expect(refreshed?.windows[0]?.ref).toBe(windowRef)
    const snapshotCalls = helper.calls.filter((call) => call.command === "snapshot")
    expect(snapshotCalls).toHaveLength(2)
    expect(snapshotCalls[1]?.params.force).toBe(true)
    expect(await backend.refreshWindow("cua:window/missing/0")).toBeUndefined()
  })

  test("limitSnapshot retains focused-window controls past the budget", () => {
    const window = "cua:window/app/main/0"
    const control = (name: string, role: string): CuaElement => ({
      ref: `${window}/${role}/${name.toLowerCase()}/0`,
      backendRef: `atspi:0.1.${name.length}`,
      role,
      name,
      enabled: true,
      focused: false,
      editable: false,
      actions: ["click"],
      states: [],
      generation: 1,
      windowRef: window,
    })
    const passive = (name: string): CuaElement => ({
      ref: `${window}/text/${name}/0`,
      backendRef: `atspi:0.2.${name.length}`,
      role: "text",
      name,
      enabled: true,
      focused: false,
      editable: false,
      actions: [],
      states: [],
      generation: 1,
      windowRef: window,
    })
    const snapshot: CuaSnapshot = {
      id: "cap-1",
      generation: 1,
      takenAt: 0,
      platform: "linux",
      windows: [{ ref: window, backendRef: "atspi:0.1", app: "app", title: "Main", focused: true, generation: 1 }],
      elements: [
        control("Bold", "button"),
        control("Left", "switch"),
        control("Justified", "switch"),
        passive("one"),
        passive("two"),
        passive("three"),
      ],
      truncated: false,
      warnings: [],
    }
    const capped = limitSnapshot(snapshot, 2, "atspi:0.1", false)
    expect(capped.elements).toHaveLength(2)
    const retained = limitSnapshot(snapshot, 2, "atspi:0.1", true)
    expect(retained.elements.filter((element) => element.actions.length > 0)).toHaveLength(3)
    expect(retained.elements.some((element) => element.role === "text")).toBe(false)
    expect(retained.truncated).toBe(true)
    expect(retained.warnings.some((warning) => warning.includes("truncated to 3 of 6"))).toBe(true)
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

describe("cua linux truth-layer regressions", () => {
  test("refuses generation/observation mismatches instead of rebinding", async () => {
    const { backend } = createHarness()
    const snapshot = await backend.snapshot()
    const button = requireElement(snapshot, "Export")
    const staleObs = await backend.execute({ type: "invoke", ref: button.ref, observationId: "cap-stale" })
    expect(staleObs.ok).toBe(false)
    expect(staleObs.error?.code).toBe("stale_ref")
    const staleGen = await backend.execute({ type: "invoke", ref: button.ref, generation: 9999 })
    expect(staleGen.ok).toBe(false)
    expect(staleGen.error?.code).toBe("stale_ref")
    const ok = await backend.execute({
      type: "invoke",
      ref: button.ref,
      observationId: snapshot.id,
      generation: snapshot.generation,
    })
    expect(ok.ok).toBe(true)
  })

  test("loose slug re-resolution requires explicit allowRebind", async () => {
    const { backend } = createHarness()
    const snapshot = await backend.snapshot()
    const button = requireElement(snapshot, "Export")
    const shifted = button.ref.replace(/\/0$/, "/7")
    const refused = await backend.execute({ type: "invoke", ref: shifted })
    expect(refused.ok).toBe(false)
    expect(refused.error?.code).toBe("stale_ref")

    const rebound = createHarness({ allowRebind: true })
    const snap2 = await rebound.backend.snapshot()
    const btn2 = requireElement(snap2, "Export")
    const shifted2 = btn2.ref.replace(/\/0$/, "/7")
    // With explicit allowRebind a single remaining candidate may resolve.
    const result = await rebound.backend.execute({ type: "invoke", ref: shifted2, allowRebind: true })
    // Either resolves (single candidate) or refuses as ambiguous, but never
    // silently targets the wrong occurrence.
    expect(["stale_ref", "target_mismatch", undefined]).toContain(result.error?.code ?? undefined)
    await rebound.backend.dispose()
  })

  test("fails instead of silently dropping unknown keys", async () => {
    const { backend } = createHarness({
      onRun: (file, args) => {
        if (file === "python3" && args.includes("type") && args.includes("--check")) {
          return { stdout: JSON.stringify({ ok: true, typed: 0, skipped: [] }), stderr: "" }
        }
        if (file === "python3" && args.includes("type") && args.includes("--text")) {
          return { stdout: JSON.stringify({ ok: true, typed: 1, skipped: [""] }), stderr: "" }
        }
        return undefined
      },
    })
    await backend.snapshot()
    const result = await backend.execute({ type: "type", text: "a" })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe("input_failed")
    expect(result.error?.message).toMatch(/not typed|Unsupported/i)
  })

  test("Wayland per-monitor geometry allows negative origins with one conversion", () => {
    const geometry = parseWlrRandrGeometry(
      JSON.stringify([
        { name: "DP-1", enabled: true, scale: 2, position: { x: -1920, y: 0 }, current_mode: { width: 3840, height: 2160 } },
        { name: "eDP-1", enabled: true, scale: 1, position: { x: 0, y: 0 }, current_mode: { width: 1920, height: 1080 } },
      ]),
    )
    expect(geometry?.scale).toBe(2)
    expect(geometry?.monitors).toHaveLength(2)
    expect(geometry?.monitors?.[0]?.x).toBe(-1920)
    // Logical width is device/scale: exactly one conversion, not two.
    expect(geometry?.monitors?.[0]?.width).toBe(1920)
    expect(geometry?.device?.x).toBe(-3840)
  })
})

// A stub of the pyatspi D-Bus client the helper talks to. The tree, the
// per-node delay, and the failure are driven by the JSON in ATSPI_SPEC, so the
// real script and the real traversal are exercised without a desktop.
const FAKE_ATSPI_SOURCE = `import json
import os
import time

SPEC = json.loads(os.environ.get("ATSPI_SPEC") or "null")


class FakeState:
    def __init__(self, name):
        self.name = name

    def __str__(self):
        return "state_" + self.name


class FakeStateSet:
    def __init__(self, names):
        self.names = list(names)

    def getStates(self):
        return [FakeState(name) for name in self.names]


class FakeRect:
    def __init__(self, bounds):
        self.x = bounds.get("x", 0)
        self.y = bounds.get("y", 0)
        self.width = bounds.get("width", 0)
        self.height = bounds.get("height", 0)


class FakeComponent:
    def __init__(self, spec):
        self.spec = spec

    def getExtents(self, coord=0):
        return FakeRect(self.spec.get("bounds") or {})

    def grabFocus(self):
        return True


class FakeAction:
    def __init__(self, spec):
        self.nActions = len(spec.get("actions") or [])
        self.names = list(spec.get("actions") or [])

    def getName(self, index):
        return self.names[index]

    def doAction(self, index):
        return True


class FakeText:
    def __init__(self, text):
        self.text = text

    def getText(self, start, end):
        if end is None or end < 0:
            return self.text
        return self.text[start:end]


class FakeValue:
    def __init__(self, value):
        self.currentValue = 0.0 if value is None else float(value)
        self.minimumValue = 0.0
        self.maximumValue = 100.0
        self.minimumIncrement = 1.0


class Node:
    def __init__(self, spec):
        self.spec = spec or {}
        self.name = self.spec.get("name", "")
        self.description = self.spec.get("description", "")
        self.children = [Node(child) for child in (self.spec.get("children") or [])]

    def tick(self):
        delay = float(self.spec.get("delay", 0) or 0)
        if delay > 0:
            time.sleep(delay)

    def get_role_name(self):
        self.tick()
        return self.spec.get("role", "unknown")

    def getState(self):
        return FakeStateSet(self.spec.get("states") or [])

    def get_process_id(self):
        return int(self.spec.get("pid", 42))

    def get_child_count(self):
        self.tick()
        if self.spec.get("throws"):
            raise RuntimeError("the stubbed AT-SPI child count failed")
        return len(self.children)

    @property
    def childCount(self):
        if self.spec.get("throws"):
            raise RuntimeError("the stubbed AT-SPI child count failed")
        return len(self.children)

    def get_child_at_index(self, index):
        self.tick()
        if self.spec.get("throws") or self.spec.get("throws_access"):
            raise RuntimeError("the stubbed AT-SPI child access failed")
        if 0 <= index < len(self.children):
            return self.children[index]
        return None

    def getChildAtIndex(self, index):
        return self.get_child_at_index(index)

    def get_extents(self, coord=0):
        self.tick()
        return FakeRect(self.spec.get("bounds") or {})

    def queryComponent(self):
        return FakeComponent(self.spec)

    def queryAction(self):
        return FakeAction(self.spec)

    def get_n_actions(self):
        return len(self.spec.get("actions") or [])

    def get_action_name(self, index):
        return (self.spec.get("actions") or [])[index]

    def get_attributes(self):
        return dict(self.spec.get("attributes") or {})

    def queryText(self):
        text = self.spec.get("text")
        if text is None:
            raise RuntimeError("no text interface")
        return FakeText(text)

    def queryEditableText(self):
        if not self.spec.get("editable"):
            raise RuntimeError("no editable text interface")
        return FakeText(self.spec.get("text", ""))

    def get_text(self, start, end):
        raise RuntimeError("no text interface")

    def queryValue(self):
        return FakeValue(self.spec.get("value"))

    def get_current_value(self):
        raise RuntimeError("no value interface")

    def grab_focus(self):
        return True


class Registry:
    @staticmethod
    def registerEventListener(listener, event_type):
        return True

    @staticmethod
    def pumpQueuedEvents():
        return None

    def getDesktop(self, screen=0):
        return ROOT


ROOT = Node(SPEC)
`

interface HelperProcess {
  request(command: string, params: Record<string, unknown>): Promise<HelperLine>
  dispose(): Promise<void>
}

// Runs the real helper script against a stubbed pyatspi and returns the
// decoded JSON line for each command. The spec drives the fake tree.
function startStubAtspi(spec: unknown): HelperProcess {
  const interpreter = Bun.which("python3") ?? Bun.which("python")
  if (interpreter === null) throw new Error("python is not available")
  const directory = mkdtempSync(join(tmpdir(), "omnia-linux-atspi-"))
  writeFileSync(join(directory, "pyatspi.py"), FAKE_ATSPI_SOURCE)
  writeFileSync(join(directory, "helper.py"), LINUX_CUA_SCRIPT)
  const child = spawn(interpreter, [join(directory, "helper.py")], {
    env: { ...process.env, PYTHONPATH: directory, ATSPI_SPEC: JSON.stringify(spec) },
    stdio: ["pipe", "pipe", "pipe"],
  })
  const waiting: Array<(line: HelperLine) => void> = []
  let buffer = ""
  let settled = false
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8")
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const raw of lines) {
      const trimmed = raw.trim()
      if (trimmed.length === 0) continue
      // The helper emits the payload fields at the top level, so the whole
      // record is the payload just like the persistent helper's line format.
      const line = parseHelperLine(trimmed)
      if (line === undefined || line.ready === true) continue
      const settle = waiting.shift()
      settle?.(line)
    }
  })
  let stderr = ""
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-2000)
  })
  const request = (command: string, params: Record<string, unknown>): Promise<HelperLine> =>
    new Promise((resolve, reject) => {
      if (settled) {
        reject(new Error("the stubbed helper was already disposed"))
        return
      }
      waiting.push(resolve)
      child.stdin.write(`${JSON.stringify({ id: "1", command, params })}\n`)
      const timer = setTimeout(() => {
        const index = waiting.indexOf(resolve)
        if (index >= 0) waiting.splice(index, 1)
        reject(new Error(`the stubbed helper never answered ${command}: ${stderr.trim()}`))
      }, 20000)
      timer.unref?.()
    })
  return {
    request,
    async dispose() {
      settled = true
      child.kill("SIGKILL")
      rmSync(directory, { recursive: true, force: true })
    },
  }
}

// The helper walks the desktop object, so a snapshot payload nests
// application -> frame -> controls.
function childrenOf(response: HelperLine): number {
  const window = (response.payload.applications as Record<string, unknown>[])[0] as Record<string, unknown>
  const application = (window.nodes as Record<string, unknown>[])[0] as Record<string, unknown>
  const frame = (application.children as Record<string, unknown>[])[0] as Record<string, unknown>
  return (frame.children as unknown[]).length
}

function button(spec: Record<string, unknown>): Record<string, unknown> {
  return { states: ["sensitive"], actions: ["click"], ...spec }
}

// The AT-SPI desktop of a window that holds one control of each actionable
// kind. Role names are the raw pyatspi vocabulary ("push button", "combo
// box", ...), which is what the helper receives from D-Bus.
const WINDOW_FRAME: Record<string, unknown> = {
  role: "frame",
  name: "Example page",
  states: ["focused"],
  bounds: { x: 0, y: 0, width: 1024, height: 768 },
  children: [
    button({
      role: "push button",
      name: "Save",
      description: "Save the document",
      states: ["sensitive", "focused"],
      bounds: { x: 12, y: 40, width: 90, height: 26 },
      children: [{ role: "label", name: "Save", text: "Save", children: [] }],
    }),
    {
      role: "entry",
      name: "Search",
      states: ["editable", "focusable"],
      text: "the quick brown fox",
      editable: true,
      attributes: { placeholder: "Search the web" },
      bounds: { x: 12, y: 80, width: 240, height: 24 },
      children: [],
    },
    {
      role: "panel",
      name: "",
      states: ["sensitive"],
      bounds: { x: 12, y: 120, width: 500, height: 200 },
      children: [
        {
          role: "combo box",
          name: "Colour",
          states: ["sensitive", "expanded"],
          actions: ["select"],
          value: 1,
          bounds: { x: 20, y: 130, width: 120, height: 24 },
          children: [],
        },
        {
          role: "check box",
          name: "Bold",
          states: ["sensitive", "checked"],
          actions: ["toggle"],
          bounds: { x: 20, y: 160, width: 120, height: 24 },
          children: [],
        },
        {
          role: "page tab",
          name: "Details",
          states: ["sensitive", "selected"],
          actions: ["jump"],
          bounds: { x: 20, y: 190, width: 120, height: 24 },
          children: [],
        },
      ],
    },
    {
      role: "radio button",
      name: "Left",
      states: ["sensitive", "selected"],
      actions: ["select"],
      bounds: { x: 12, y: 330, width: 100, height: 20 },
      children: [],
    },
    {
      role: "list item",
      name: "Documents",
      states: ["sensitive", "selected"],
      actions: ["select"],
      bounds: { x: 12, y: 356, width: 100, height: 20 },
      children: [],
    },
    {
      role: "menu item",
      name: "New",
      states: ["sensitive"],
      actions: ["click"],
      bounds: { x: 12, y: 380, width: 100, height: 20 },
      children: [],
    },
    {
      role: "slider",
      name: "Volume",
      states: ["sensitive"],
      value: 3,
      bounds: { x: 12, y: 404, width: 100, height: 20 },
      children: [],
    },
    {
      role: "spin button",
      name: "Zoom",
      states: ["sensitive"],
      value: 1,
      bounds: { x: 12, y: 428, width: 100, height: 20 },
      children: [],
    },
    {
      role: "tree item",
      name: "Chapter 1",
      states: ["sensitive", "selected", "expanded"],
      actions: ["expand or contract"],
      bounds: { x: 12, y: 452, width: 100, height: 20 },
      children: [],
    },
    {
      role: "search box",
      name: "Find",
      states: ["sensitive", "editable"],
      editable: true,
      bounds: { x: 12, y: 476, width: 100, height: 20 },
      children: [],
    },
  ],
}

const APPLICATION: Record<string, unknown> = {
  role: "application",
  name: "firefox",
  pid: 42,
  states: ["active"],
  children: [WINDOW_FRAME],
}

const CONTROL_TREE: Record<string, unknown> = { role: "desktop", children: [APPLICATION] }

describe("cua linux helper protocol", () => {
  test("walks a window and discovers every actionable control below it", async () => {
    const helper = startStubAtspi(CONTROL_TREE)
    try {
      const response = await helper.request("snapshot", { scope: "all", max_apps: 4, max_depth: 12, max_nodes: 500 })
      expect(response.ok).toBe(true)
      const payload = parseSnapshotPayload(response.payload)
      expect(payload?.applications).toHaveLength(1)
      expect(payload?.timeout).toBeUndefined()
      const snapshot = buildCuaSnapshot({
        generation: 1,
        takenAt: 0,
        applications: payload?.applications ?? [],
        maxElements: 500,
      })
      expect(snapshot.windows.map((window) => window.title)).toEqual(["Example page"])
      expect(snapshot.accessibility).toBe("available")
      const save = requireElement(snapshot, "Save")
      expect(save.role).toBe("button")
      expect(save.focused).toBe(true)
      // "sensitive" is the canonical AT-SPI state for enabled.
      expect(save.enabled).toBe(true)
      expect(save.states).toContain("focused")
      expect(save.attributes?.atspiRole).toBe("pushbutton")
      expect(save.attributes?.atspiActions).toBe("click")
      expect(save.description).toBe("Save the document")
      expect(save.bounds).toEqual({ x: 12, y: 40, width: 90, height: 26 })
      const search = requireElement(snapshot, "Search")
      expect(search.role).toBe("textbox")
      expect(search.editable).toBe(true)
      expect(search.text).toBe("the quick brown fox")
      expect(search.attributes?.placeholder).toBe("Search the web")
      expect(requireElement(snapshot, "Colour").role).toBe("combobox")
      expect(requireElement(snapshot, "Bold").role).toBe("checkbox")
      expect(requireElement(snapshot, "Details").role).toBe("tab")
      expect(requireElement(snapshot, "Left").role).toBe("radio")
      expect(requireElement(snapshot, "Documents").role).toBe("listitem")
      expect(requireElement(snapshot, "New").role).toBe("menuitem")
      expect(requireElement(snapshot, "Volume").role).toBe("slider")
      expect(requireElement(snapshot, "Zoom").role).toBe("spinbutton")
      const chapter = requireElement(snapshot, "Chapter 1")
      expect(chapter.role).toBe("treeitem")
      expect(chapter.states).toContain("selected")
      expect(chapter.states).toContain("expanded")
      expect(requireElement(snapshot, "Find").role).toBe("searchbox")
      // Controls inside the panel keep their ancestry; the window itself is
      // never duplicated as an element.
      expect(requireElement(snapshot, "Colour").parentRef).toBe("cua:window/firefox/example-page/0/group/unnamed/0")
      expect(snapshot.elements.some((element) => element.role === "window")).toBe(false)
      expect(snapshot.elements.every((element) => element.windowRef === "cua:window/firefox/example-page/0")).toBe(
        true,
      )
    } finally {
      await helper.dispose()
    }
  })

  test("enforces the helper depth bound and reports the cut", async () => {
    const helper = startStubAtspi(CONTROL_TREE)
    try {
      const response = await helper.request("snapshot", { scope: "all", max_depth: 2 })
      expect(response.ok).toBe(true)
      const payload = parseSnapshotPayload(response.payload)
      expect(payload?.truncated).toBe(true)
      const snapshot = buildCuaSnapshot({
        generation: 1,
        takenAt: 0,
        applications: payload?.applications ?? [],
        maxElements: 500,
      })
      expect(snapshot.elements.map((element) => element.name)).toContain("Save")
      // The panel is one level below the frame, its controls are cut.
      expect(snapshot.elements.some((element) => element.name === "Colour")).toBe(false)
    } finally {
      await helper.dispose()
    }
  })

  test("stops the walk when its time budget is spent", async () => {
    // One slow D-Bus round trip per child access: the breadth-first walk
    // collects the shallow controls first and stops instead of grinding
    // through the tail.
    const busy = {
      ...CONTROL_TREE,
      children: [
        {
          ...APPLICATION,
          children: [
            {
              ...WINDOW_FRAME,
              delay: 0.05,
              children: Array.from({ length: 60 }, (_, index) =>
                button({
                  role: "push button",
                  name: `Item ${index}`,
                  bounds: { x: 0, y: index * 24, width: 80, height: 20 },
                }),
              ),
            },
          ],
        },
      ],
    }
    const helper = startStubAtspi(busy)
    try {
      const started = Date.now()
      const response = await helper.request("snapshot", { scope: "all", time_budget: 0.3 })
      const elapsed = Date.now() - started
      expect(response.ok).toBe(true)
      expect(response.payload.timeout).toBe(true)
      expect(response.payload.truncated).toBe(true)
      // The helper walks the desktop, so the payload nests application -> frame
      // -> controls.
      expect(childrenOf(response)).toBeGreaterThan(0)
      expect(childrenOf(response)).toBeLessThan(60)
      // The budget held: the walk never ran past it.
      expect(elapsed).toBeLessThan(4000)
    } finally {
      await helper.dispose()
    }
  })

  test("keeps the other controls when one AT-SPI call throws", async () => {
    const tree = JSON.parse(JSON.stringify(CONTROL_TREE)) as Record<string, unknown>
    const application = (tree.children as Record<string, unknown>[])[0]!
    const frame = (application.children as Record<string, unknown>[])[0]!
    // The panel's children cannot be read: the panel survives, its subtree does
    // not, and nothing else in the window is lost.
    const children = frame.children as Record<string, unknown>[]
    children[2] = { ...children[2]!, throws: true }
    const helper = startStubAtspi(tree)
    try {
      const response = await helper.request("snapshot", { scope: "all" })
      expect(response.ok).toBe(true)
      const payload = parseSnapshotPayload(response.payload)
      const snapshot = buildCuaSnapshot({
        generation: 1,
        takenAt: 0,
        applications: payload?.applications ?? [],
        maxElements: 500,
      })
      expect(requireElement(snapshot, "Save").role).toBe("button")
      expect(requireElement(snapshot, "New").role).toBe("menuitem")
      expect(requireElement(snapshot, "Chapter 1").role).toBe("treeitem")
      // The unreadable panel leaves no controls behind at all, and the walk
      // reports that the tree is incomplete instead of pretending otherwise.
      expect(snapshot.elements.some((element) => element.name === "Colour")).toBe(false)
      expect(snapshot.elements.some((element) => element.role === "group")).toBe(false)
      expect(payload?.truncated).toBe(true)
    } finally {
      await helper.dispose()
    }
  })

  test("an unreadable application is reported as an error instead of a false success", async () => {
    const tree = JSON.parse(JSON.stringify(CONTROL_TREE)) as Record<string, unknown>
    const application = (tree.children as Record<string, unknown>[])[0]!
    const frame = (application.children as Record<string, unknown>[])[0]!
    frame.throws_access = true
    const helper = startStubAtspi(tree)
    try {
      const response = await helper.request("snapshot", { scope: "all" })
      expect(response.ok).toBe(true)
      const payload = parseSnapshotPayload(response.payload)
      expect(payload?.applications[0]?.error).toBeDefined()
      const snapshot = buildCuaSnapshot({
        generation: 1,
        takenAt: 0,
        applications: payload?.applications ?? [],
        maxElements: 500,
      })
      expect(snapshot.windows).toHaveLength(0)
      expect(snapshot.elements).toHaveLength(0)
      // An empty tree is never presented as a healthy read.
      expect(snapshot.accessibility).toBe("degraded")
    } finally {
      await helper.dispose()
    }
  })

  test("a walk that hit its budget is retried instead of being served from the cache", async () => {
    const busy = {
      ...CONTROL_TREE,
      children: [
        {
          ...APPLICATION,
          children: [
            {
              ...WINDOW_FRAME,
              delay: 0.02,
              children: Array.from({ length: 30 }, (_, index) =>
                button({
                  role: "push button",
                  name: `Item ${index}`,
                  bounds: { x: 0, y: index * 24, width: 80, height: 20 },
                }),
              ),
            },
          ],
        },
      ],
    }
    const helper = startStubAtspi(busy)
    try {
      const first = await helper.request("snapshot", { scope: "all", time_budget: 0.1 })
      expect(first.payload.timeout).toBe(true)
      // The helper walks the desktop, so the payload nests application -> frame
      // -> controls.
      const collected = (response: HelperLine): number => childrenOf(response)
      expect(collected(first)).toBeLessThan(30)
      // The second snapshot gets a fresh budget and completes the walk instead
      // of replaying the cached truncated tree.
      const second = await helper.request("snapshot", { scope: "all", time_budget: 30 })
      expect(second.payload.timeout).toBe(false)
      expect(collected(second)).toBe(30)
    } finally {
      await helper.dispose()
    }
  })
})

// One application that registered on the accessibility bus: a focused app from
// another process (native X11, or a toolkit bridge that never loaded) is not
// in this list at all.
function registeredApplication(): Record<string, unknown> {
  return {
    applications: [
      {
        name: "gedit",
        pid: 9,
        nodes: [
          {
            index: 0,
            role: "application",
            name: "gedit",
            states: [],
            actions: [],
            attributes: {},
            interfaces: { component: false, action: false, editable: false, value: false },
            children: [
              {
                index: 1,
                role: "frame",
                name: "notes.txt",
                states: ["focused"],
                actions: [],
                bounds: { x: 0, y: 0, width: 800, height: 600 },
                attributes: {},
                interfaces: { component: true, action: false, editable: false, value: false },
                children: [
                  {
                    index: 0,
                    role: "pushbutton",
                    name: "Undo",
                    states: ["enabled"],
                    actions: ["click"],
                    bounds: { x: 4, y: 4, width: 60, height: 22 },
                    attributes: {},
                    interfaces: { component: true, action: true, editable: false, value: false },
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
    timeout: false,
  }
}

describe("cua linux element discovery and degradation", () => {
  test("collects the controls of registered applications when the focused one has no tree", async () => {
    // The X11 active window belongs to an application that never registered on
    // the accessibility bus, so narrowing to its pid walks nothing. The X11
    // merge would then produce window frames with no controls at all, which is
    // exactly what an agent could not act on.
    const { backend, helper } = createHarness({
      handlers: {
        probe: (params) =>
          params.scope === "focused"
            ? { apps: [], fallback: true, focused: null }
            : {
                apps: [{ key: "pid:9", signature: "v0", index: 0, name: "gedit", pid: 9, cached: false }],
                fallback: false,
                focused: null,
              },
        snapshot: (params) => (params.scope === "focused" ? { applications: [] } : registeredApplication()),
        resolve: () => resolvedElement(),
      },
    })
    const snapshot = await backend.snapshot()
    expect(snapshot.accessibility).toBe("available")
    expect(snapshot.windows.map((window) => window.app)).toEqual(["gedit"])
    expect(snapshot.elements.map((element) => element.name)).toEqual(["Undo"])
    expect(helper.calls.some((call) => call.command === "probe" && call.params.scope === "all")).toBe(true)
    expect(helper.calls.some((call) => call.command === "snapshot" && call.params.scope === "all")).toBe(true)
  })

  test("a walk that hit its time budget is degraded with a warning", async () => {
    const { backend } = createHarness({
      handlers: {
        ...baseHandlers(),
        snapshot: () => ({ ...atspiSnapshot(), timeout: true, truncated: true }),
      },
    })
    const snapshot = await backend.snapshot()
    expect(snapshot.accessibility).toBe("degraded")
    expect(snapshot.truncated).toBe(true)
    expect(snapshot.warnings.some((warning) => warning.includes("1500ms budget"))).toBe(true)
    // The partial tree is still returned rather than thrown away.
    expect(snapshot.elements.length).toBeGreaterThan(0)
  })

  test("a helper that never answers degrades instead of hanging the snapshot", async () => {
    const helper: CuaHelper = {
      ready: Promise.resolve({ ok: true, pyatspi: true, x11: true }),
      exited: false,
      request: (command, _params, timeoutMs) =>
        command === "probe"
          ? Promise.resolve({ ok: false, error: "probe unavailable", payload: {} })
          : new Promise((_resolve, reject) => {
              setTimeout(
                () => reject(new Error("The Linux CUA helper timed out running snapshot.")),
                timeoutMs ?? 15000,
              )
            }),
      async dispose() {},
    }
    const backend = createLinuxBackend({
      helper,
      runner: createFakeRunner().runner,
      accessibility: false,
      x11Windows: false,
      session: "x11",
      display: ":0",
      probeDisplay: false,
    })
    const started = Date.now()
    const snapshot = await backend.snapshot()
    expect(Date.now() - started).toBeLessThan(6000)
    expect(snapshot.accessibility).toBe("degraded")
    expect(snapshot.elements).toHaveLength(0)
    expect(snapshot.warnings.some((warning) => warning.includes("failed or timed out"))).toBe(true)
  }, 10000)

  test("a failing snapshot command never looks like a healthy empty desktop", async () => {
    const { backend } = createHarness({
      handlers: { snapshot: () => ({ ok: false, error: "the accessibility bus closed" }) },
    })
    const snapshot = await backend.snapshot()
    expect(snapshot.accessibility).toBe("degraded")
    expect(snapshot.warnings).toContain("the accessibility bus closed")
  })

  test("a backend with no accessibility tree at all is unavailable", async () => {
    const { backend } = createHarness({ ready: { ok: false, pyatspi: false, error: "pyatspi is not available" } })
    const snapshot = await backend.snapshot()
    expect(snapshot.accessibility).toBe("unavailable")
    expect(snapshot.windows).toHaveLength(0)
  })

  test("a walk that hit its budget is not served from the walk cache", async () => {
    // The next snapshot must be able to complete, so a truncated walk is never
    // remembered as if it were the whole tree.
    let timedOut = true
    let walks = 0
    const { backend, helper } = createHarness({
      handlers: {
        probe: (params) => ({
          apps: [{ key: "pid:42", signature: "v0", index: 0, name: "firefox", pid: 42, cached: false }],
          fallback: false,
          focused: null,
        }),
        snapshot: () => {
          walks += 1
          return { ...atspiSnapshot(), timeout: timedOut, truncated: timedOut }
        },
      },
    })
    const first = await backend.snapshot()
    expect(first.accessibility).toBe("degraded")
    expect(first.warnings.some((warning) => warning.includes("1500ms budget"))).toBe(true)
    timedOut = false
    const second = await backend.snapshot()
    expect(second.accessibility).toBe("available")
    expect(walks).toBe(2)
    expect(helper.calls.filter((call) => call.command === "snapshot")).toHaveLength(2)
  })

})
