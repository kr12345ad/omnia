import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CuaEngine, refIdentity } from "../cua/engine"
import { buildElementRef, buildWindowRef, slugify } from "../cua/backends/linux"
import { CuaHostDriver, type CuaLegacyFallbacks } from "../cua/host-driver"
import type {
  CuaAction,
  CuaActionResult,
  CuaBackend,
  CuaElement,
  CuaFindQuery,
  CuaSnapshot,
  CuaWaitResult,
} from "../cua/types"
import type { ActionResult, Bounds, ComputerAction, Observation, Point } from "../protocol"
import type { ServerComputerDriver } from "../server/computers"
import { startOmniaServer } from "../server/server"
import { readComputerUseTrail, type ComputerUseRecord } from "../security/journal"
import { CENTER_CLICK_TOLERANCE_PX, HONEST_VERIFY_TRIAL_NAME, runAllTrials } from "./live-harness/index"
import { createLiveAdapters } from "./live-harness/run"
import { liveHarnessSkipReason } from "./live-harness/desktop-gate"
import type { HarnessAct, HarnessObserve, HarnessRequest } from "./live-harness/index"
import { actionRequest, ComputerUseService } from "./service"
import { SemanticProvider } from "./providers"
import { MATCH_THRESHOLD, scoreMatch } from "./match-score"
import { CLOSE_GUARD_DISTANCE_PX, checkTitleBarBan, describeAimRisk, evaluateClickRisk } from "./window-safety"

// End-to-end proof of the reliability contract in docs/computer-use-reliability.md,
// on one synthetic desktop.
//
// The desktop is driven through the real code paths: a Cua backend stands in for
// KDE/X11, a real CuaEngine mints generation-scoped refs over it, the real
// CuaHostDriver adapts protocol actions onto that engine, and the real Omnia
// server wires it to the semantic provider, the router, the computer-use
// service, the permission gate, and the computer-use audit journal. Nothing in
// this file re-implements a rule the production code owns: every assertion is
// about what the stack did, and what the desktop actually received.
//
// Covered end to end: the seven claims the strategist rollout asked for, plus
// two findings the run surfaced (pinned at the bottom with file and line, not
// fixed). The one path that cannot be driven here is the real-desktop arm of the
// live harness: building those adapters is what reaches a display, so it stays
// gated on OMNIA_LIVE_HARNESS=1 plus a DISPLAY, and the last claim asserts that
// gate reports a skip instead of synthesising input.

const COMPUTER_ID = "synthetic-desktop"
const KITTY_TITLE = "OC | Quick hello"
const EDITOR_TITLE = "Editor"
const COMMAND_NAME = "Command"
const SCROLLBAR_NAME = "Scrollbar"
const MINIMIZE_NAME = "Minimize"
const CLOSE_NAME = "Close"
const APPROVER = "reliability-e2e"

// Minimize (1834,45) and Close (1843,45) are 9px apart, exactly as documented in
// window-safety.ts. The kitty window is deliberately off-centre so a
// screen-centre click is provably a wrong-target click.
const SCREEN = { width: 1920, height: 1080 }
const KITTY_BOUNDS: Bounds = { x: 1180, y: 30, width: 740, height: 900 }
const EDITOR_BOUNDS: Bounds = { x: 60, y: 120, width: 800, height: 700 }
const COMMAND_BOUNDS: Bounds = { x: 1196, y: 132, width: 700, height: 24 }
const SCROLLBAR_BOUNDS: Bounds = { x: 1900, y: 120, width: 16, height: 800 }
const MINIMIZE_BOUNDS: Bounds = { x: 1826, y: 39, width: 16, height: 12 }
const CLOSE_BOUNDS: Bounds = { x: 1835, y: 39, width: 16, height: 12 }
const MINIMIZE_POINT: Point = { x: 1834, y: 45 }
const CLOSE_POINT: Point = { x: 1843, y: 45 }
const SCREEN_CENTER: Point = { x: 960, y: 539 }
const FOCUS_INTENT = `focus the kitty window titled "${KITTY_TITLE}"`

interface DesktopWindow {
  readonly key: string
  readonly app: string
  readonly title: string
  readonly bounds: Bounds
  focused: boolean
  minimized: boolean
  closed: boolean
}

interface DesktopElement {
  readonly key: string
  readonly window: string
  readonly role: string
  readonly name: string
  readonly bounds: Bounds
  readonly actions: readonly string[]
  readonly editable: boolean
  value: string | undefined
  focused: boolean
}

function containsPoint(bounds: Bounds, point: Point): boolean {
  return point.x >= bounds.x && point.x <= bounds.x + bounds.width && point.y >= bounds.y && point.y <= bounds.y + bounds.height
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function createDesktop() {
  const windows: DesktopWindow[] = [
    { key: "kitty", app: "kitty", title: KITTY_TITLE, bounds: KITTY_BOUNDS, focused: false, minimized: false, closed: false },
    { key: "soffice", app: "soffice", title: EDITOR_TITLE, bounds: EDITOR_BOUNDS, focused: true, minimized: false, closed: false },
  ]
  const elements: DesktopElement[] = [
    { key: "command", window: "kitty", role: "textfield", name: COMMAND_NAME, bounds: COMMAND_BOUNDS, actions: ["focus", "setvalue"], editable: true, value: "ls -la", focused: false },
    { key: "scrollbar", window: "kitty", role: "scrollbar", name: SCROLLBAR_NAME, bounds: SCROLLBAR_BOUNDS, actions: ["scroll"], editable: false, value: undefined, focused: false },
    { key: "minimize", window: "kitty", role: "button", name: MINIMIZE_NAME, bounds: MINIMIZE_BOUNDS, actions: ["click"], editable: false, value: undefined, focused: false },
    { key: "close", window: "kitty", role: "button", name: CLOSE_NAME, bounds: CLOSE_BOUNDS, actions: ["click"], editable: false, value: undefined, focused: false },
  ]
  const actions: CuaAction[] = []
  const clicks: Point[] = []
  let pointer: Point | undefined
  let focusBroken = false
  let captures = 0

  const liveWindows = () => windows.filter((window) => !window.closed)
  const windowOf = (key: string) => windows.find((window) => window.key === key)
  const elementOf = (key: string) => elements.find((element) => element.key === key)

  const windowRef = (key: string) => {
    const window = windowOf(key)
    return window === undefined ? "" : buildWindowRef(window.app, window.title, windows.indexOf(window))
  }
  const refs = new Map<string, { kind: "window" | "element"; key: string }>()
  const lookup = (ref: string) => refs.get(ref.slice(0, ref.lastIndexOf("@g")))

  function activateWindow(key: string | undefined): void {
    for (const window of windows) window.focused = window.key === key && !window.closed
  }
  function focusWindow(key: string | undefined): void {
    activateWindow(key)
    for (const element of elements) element.focused = false
  }
  function focusElement(key: string | undefined): void {
    const element = key === undefined ? undefined : elementOf(key)
    if (element === undefined) return
    activateWindow(element.window)
    for (const candidate of elements) candidate.focused = candidate.key === key
  }
  function closeWindow(key: string | undefined): void {
    const window = key === undefined ? undefined : windowOf(key)
    if (window === undefined) return
    window.closed = true
    window.focused = false
    focusWindow(windows.find((candidate) => !candidate.closed)?.key)
  }
  function minimizeWindow(key: string | undefined): void {
    const window = key === undefined ? undefined : windowOf(key)
    if (window === undefined) return
    window.minimized = true
    focusWindow(windows.find((candidate) => !candidate.closed && candidate.key !== key)?.key)
  }

  // A pointer click is applied the way a real desktop applies it: the control
  // under the point acts. Closing or minimizing the kitty window is therefore
  // observable, so a wrong-target click cannot pass silently.
  function applyClick(point: Point): void {
    pointer = point
    clicks.push(point)
    const element = elements.filter((candidate) => containsPoint(candidate.bounds, point)).at(-1)
    if (element !== undefined) {
      if (element.key === "close") return closeWindow(element.window)
      if (element.key === "minimize") return minimizeWindow(element.window)
      return focusElement(element.key)
    }
    const window = liveWindows().find((candidate) => containsPoint(candidate.bounds, point))
    if (window !== undefined) focusWindow(window.key)
  }

  function execute(action: CuaAction): CuaActionResult {
    actions.push(action)
    switch (action.type) {
      case "window":
        if (action.action === "focus" && !focusBroken) focusWindow(lookup(action.ref)?.key)
        if (action.action === "minimize") minimizeWindow(lookup(action.ref)?.key)
        if (action.action === "close") closeWindow(lookup(action.ref)?.key)
        if (action.action === "restore") {
          const key = lookup(action.ref)?.key
          const window = key === undefined ? undefined : windowOf(key)
          if (window !== undefined) {
            window.minimized = false
            focusWindow(key)
          }
        }
        break
      case "focus":
        focusElement(lookup(action.ref)?.key)
        break
      case "click":
        applyClick(action.point)
        break
      case "set_value": {
        const element = elementOf(lookup(action.ref)?.key ?? "")
        if (element !== undefined) element.value = action.value
        break
      }
      case "type": {
        const key = action.ref === undefined ? undefined : lookup(action.ref)?.key
        const element = key === undefined ? elements.find((candidate) => candidate.focused) : elementOf(key)
        if (element !== undefined) element.value = action.text
        break
      }
      case "invoke":
        focusElement(lookup(action.ref)?.key)
        break
      case "scroll":
      case "drag":
      case "key":
      case "dismiss":
      case "show_menu":
      case "select":
      case "expand":
      case "collapse":
      case "increment":
      case "decrement":
      case "scroll_into_view":
        break
    }
    return {
      ok: true,
      action,
      verified: false,
      message: `synthetic desktop handled ${action.type}`,
      delivery: action.type === "click" ? "pointer" : "background-ax",
      generation: 0,
    }
  }

  function snapshot(): CuaSnapshot {
    captures += 1
    const windowRefs = new Map<string, string>()
    const windowRecords = windows.flatMap((window, index) => {
      if (window.closed) return []
      const ref = buildWindowRef(window.app, window.title, index)
      windowRefs.set(window.key, ref)
      refs.set(ref, { kind: "window", key: window.key })
      return [
        {
          ref,
          backendRef: `x11:${window.key}`,
          app: window.app,
          title: window.title,
          bounds: window.bounds,
          focused: window.focused,
          ...(window.minimized ? { minimized: true } : {}),
          generation: 0,
        },
      ]
    })
    const elementRefs = new Map<string, string>()
    const occurrences = new Map<string, number>()
    const elementRecords = elements.flatMap((element) => {
      const owner = windowRefs.get(element.window)
      if (owner === undefined) return []
      const slot = `${owner}/${slugify(element.role)}/${slugify(element.name)}`
      const occurrence = occurrences.get(slot) ?? 0
      occurrences.set(slot, occurrence + 1)
      const ref = buildElementRef(owner, element.role, element.name, occurrence)
      elementRefs.set(element.key, ref)
      refs.set(ref, { kind: "element", key: element.key })
      const application = windowOf(element.window)?.app
      return [
        {
          ref,
          backendRef: `atspi:${element.key}`,
          role: element.role,
          name: element.name,
          ...(element.value === undefined ? {} : { value: element.value }),
          bounds: element.bounds,
          enabled: true,
          focused: element.focused,
          editable: element.editable,
          actions: [...element.actions],
          states: element.focused ? ["focused"] : [],
          windowRef: owner,
          ...(application === undefined ? {} : { application }),
          generation: 0,
        } satisfies CuaElement,
      ]
    })
    // The focused node, exactly as snapshot-limit.ts derives it: a focused
    // element wins, otherwise the focused window.
    const focusedElement = elements.find((element) => element.focused)
    const focusedWindow = liveWindows().find((window) => window.focused)
    const focusedRef =
      (focusedElement === undefined ? undefined : elementRefs.get(focusedElement.key)) ??
      (focusedWindow === undefined ? undefined : windowRefs.get(focusedWindow.key))
    return {
      id: `desk-${captures}`,
      generation: 0,
      takenAt: Date.now(),
      platform: "linux",
      screen: SCREEN,
      windows: windowRecords,
      elements: elementRecords,
      ...(focusedRef === undefined ? {} : { focusedRef }),
      truncated: false,
      warnings: [],
      accessibility: "available",
    }
  }

  const backend: CuaBackend = {
    platform: "linux",
    name: "omnia-synthetic-desktop",
    available: async () => true,
    capabilities: async () => ({
      snapshot: true,
      semanticActions: true,
      backgroundActions: true,
      backgroundInput: false,
      pointer: true,
      keyboard: true,
      clipboard: false,
      screenshot: false,
      windowManagement: true,
      waitFor: true,
      refs: true,
      actions: ["invoke", "set_value", "focus", "click", "type", "key", "scroll", "window"],
      limits: [],
    }),
    snapshot: async () => snapshot(),
    find: async (query: CuaFindQuery, current?: CuaSnapshot) =>
      (current?.elements ?? []).filter((element) => {
        if (query.name !== undefined && element.name !== query.name) return false
        if (query.role !== undefined && element.role !== query.role) return false
        if (query.text !== undefined && element.text !== query.text) return false
        return true
      }),
    execute: async (action) => execute(action),
    waitFor: async (): Promise<CuaWaitResult> => ({ ok: false, waitedMs: 0 }),
    dispose: async () => {},
  }

  return {
    backend,
    actions,
    clicks,
    windowRef,
    activeWindowTitle: () => liveWindows().find((window) => window.focused)?.title,
    activeWindowBackendRef: () => {
      const window = liveWindows().find((candidate) => candidate.focused)
      return window === undefined ? undefined : `x11:${window.key}`
    },
    breakFocus: () => {
      focusBroken = true
    },
    healFocus: () => {
      focusBroken = false
    },
    pointerPosition: () => pointer,
    reset: () => {
      for (const window of windows) {
        window.focused = window.key === "soffice"
        window.minimized = false
        window.closed = false
      }
      for (const element of elements) {
        element.focused = false
        element.value = element.key === "command" ? "ls -la" : undefined
      }
      actions.length = 0
      clicks.length = 0
      pointer = undefined
      focusBroken = false
    },
  }
}

const desktop = createDesktop()
const engine = new CuaEngine({ backend: desktop.backend, cacheTtlMs: 60_000 })

// Any legacy call the synthetic desktop does not implement fails loudly: an
// unexpected fallback must not quietly satisfy a test.
function legacyFallbacks(overrides: Partial<CuaLegacyFallbacks>): CuaLegacyFallbacks {
  const values: Record<string, unknown> = { ...overrides }
  return new Proxy(values, {
    get: (target, key: string) =>
      key in target ? target[key] : () => async () => { throw new Error(`unexpected legacy call: ${key}`) },
  }) as unknown as CuaLegacyFallbacks
}

const hostDriver = new CuaHostDriver({
  engine,
  platform: "linux",
  legacy: legacyFallbacks({
    capabilities: () => [{ capability: "accessibility", status: "available" }],
    info: async () => ({
      id: COMPUTER_ID,
      name: "Synthetic KDE desktop",
      platform: "linux",
      backend: "linux-at-spi",
      connected: true,
      screen: SCREEN,
    }),
    activeWindowId: async () => desktop.activeWindowBackendRef(),
    pointerPosition: async () => ({
      success: true,
      status: "success",
      message: "Pointer position.",
      ...(desktop.pointerPosition() === undefined ? {} : desktop.pointerPosition()),
    }),
    captureScreen: async () => ({
      success: false,
      status: "unavailable",
      message: "The synthetic desktop takes no screenshots.",
    }),
  }),
})

const driver: ServerComputerDriver = {
  id: COMPUTER_ID,
  backend: hostDriver.backend,
  cua: engine,
  capabilities: () => hostDriver.capabilities,
  getInfo: () => hostDriver.getInfo(),
  observe: (request) => hostDriver.observe(request),
  find: (request) => hostDriver.find(request),
  execute: (action) => hostDriver.execute(action),
  revalidateTarget: (reference) => hostDriver.revalidateTarget(reference),
  pointerPosition: () => hostDriver.pointerPosition(),
  dispose: () => hostDriver.dispose(),
}

type Server = Awaited<ReturnType<typeof startOmniaServer>>
const dirs: string[] = []

afterAll(async () => {
  await server?.stop()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

let server: Server
let auditFile: string

const approval = {
  approve: true,
  approvedBy: APPROVER,
  approvedScopes: ["UI_CONTROL", "KEYBOARD", "POINTER"] as const,
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "omnia-reliability-e2e-"))
  dirs.push(dir)
  auditFile = join(dir, "computer-use.jsonl")
  server = await startOmniaServer({
    drivers: [driver],
    computerUseFile: join(dir, "computer-use-settings.json"),
    computerUseAuditFile: auditFile,
    credentialsFile: join(dir, "credentials.json"),
    authFile: join(dir, "auth.json"),
    superskillFile: join(dir, "superskills.json"),
    memoryFile: join(dir, "memories.json"),
    permissions: { UI_READ: "granted", UI_CONTROL: "granted", POINTER: "granted", KEYBOARD: "granted", SCREEN_READ: "granted" },
  })
}, 30_000)

function resetDesktop(): void {
  desktop.reset()
  engine.invalidate()
}

function service(): ComputerUseService {
  return server.computerUse
}

async function observe(): Promise<Observation> {
  return await server.computers.observe(COMPUTER_ID)
}

function elementNamed(observation: Observation, name: string) {
  return (observation.elements ?? []).find((element) => element.name === name)
}

function idOf(observation: Observation): string {
  const id = observation.id
  if (id === undefined || id.length === 0) throw new Error("the observation carries no id")
  return id
}

function generationOf(observation: Observation): number {
  const generation = observation.metadata?.generation
  if (typeof generation !== "number") throw new Error("the observation carries no generation")
  return generation
}

// An ActionResult error is a bare string or a structured error.
function errorOf(result: { error?: unknown }): { code?: string; message?: string } {
  const error = result.error
  if (typeof error === "string") return { message: error }
  if (typeof error === "object" && error !== null) {
    const record = error as { code?: unknown; message?: unknown }
    return {
      ...(typeof record.code === "string" ? { code: record.code } : {}),
      ...(typeof record.message === "string" ? { message: record.message } : {}),
    }
  }
  return {}
}

function refOf(metadata: Readonly<Record<string, unknown>> | undefined): string {
  const elementId = metadata?.elementId
  if (typeof elementId !== "string" || elementId.length === 0) throw new Error("the analysis resolved no element ref")
  return elementId
}

function trail(): readonly ComputerUseRecord[] {
  return readComputerUseTrail(auditFile).records
}

function latestRecord(): ComputerUseRecord {
  const records = trail()
  const record = records[records.length - 1]
  if (record === undefined) throw new Error("the computer-use audit journal holds no records")
  return record
}

// The harness adapters, in the shape the live CLI builds them (live-harness/run.ts):
// observe reads the desktop through the driver, and act drives it. A named
// target is resolved by the semantic layer first — the router, the semantic
// provider and window-safety decide what the name means and whether the
// resolved point may be clicked — and the resolved ref is delivered the way the
// tool delivers it. A ref the caller supplies is delivered with the observation
// binding it came from, so the generation gate can refuse it.
interface ActOutcome {
  readonly ok: boolean
  readonly verified: boolean
  readonly refused?: string
  readonly detail?: string
}

function referenceFor(request: HarnessRequest) {
  return {
    kind: "element" as const,
    elementId: request.ref ?? "",
    ...(request.observationId === undefined ? {} : { observationId: request.observationId }),
    ...(request.generation === undefined ? {} : { generation: request.generation }),
  }
}

function actionFor(request: HarnessRequest): ComputerAction {
  if (request.kind === "focus") return { type: "focus", target: referenceFor(request) }
  if (request.kind === "click") return { type: "click", target: referenceFor(request) }
  return { type: "type", target: referenceFor(request), text: request.value ?? "" }
}

function refusalOf(result: { error?: unknown; message?: string }): string {
  return errorOf(result).message ?? result.message ?? "the tool refused the action"
}

function fromResult(result: ActionResult): ActOutcome {
  return {
    ok: result.success,
    verified: result.verification?.verified === true,
    ...(result.status === "rejected" ? { refused: refusalOf(result) } : {}),
    ...(result.message === undefined ? {} : { detail: result.message }),
  }
}

function harnessObservation(observation: Observation) {
  const elements = (observation.elements ?? []).flatMap((element) =>
    element.id === undefined
      ? []
      : [
          {
            ref: element.id,
            ...(element.name === undefined ? {} : { name: element.name }),
            ...(element.role === undefined ? {} : { role: element.role }),
            ...(element.text === undefined ? {} : { text: element.text }),
            ...(element.value === undefined
              ? {}
              : { value: typeof element.value === "string" ? element.value : JSON.stringify(element.value) }),
            ...(element.bounds === undefined ? {} : { bounds: { ...element.bounds } }),
            ...(element.states === undefined ? {} : { states: [...element.states] }),
          },
        ],
  )
  const active = (observation.elements ?? []).find(
    (element) => element.role === "window" && (element.states ?? []).includes("focused"),
  )
  const generation = observation.metadata?.generation
  return {
    ...(observation.id === undefined ? {} : { observationId: observation.id }),
    ...(typeof generation === "number" ? { generation } : {}),
    ...(active?.name === undefined ? {} : { activeWindowTitle: active.name }),
    screen: SCREEN,
    elements,
  }
}

const harnessObserve: HarnessObserve = async (request) => {
  if (request?.fresh === true) engine.invalidate()
  return harnessObservation(await driver.observe())
}

async function actOnDesktop(request: HarnessRequest): Promise<ActOutcome> {
  if (request.ref !== undefined) return fromResult(await driver.execute(actionFor(request)))
  if (request.kind === "focus") {
    const performed = await service().perform({
      computerId: COMPUTER_ID,
      operation: "click",
      targetDescription: `focus the window titled "${request.name}"`,
      execute: true,
      ...approval,
    })
    return {
      ok: performed.analysis.result.success,
      verified: performed.execution?.verified === true,
      detail: performed.analysis.result.reasoning,
    }
  }
  const analysis = await service().analyze({
    computerId: COMPUTER_ID,
    operation: request.kind === "set-value" ? "type" : "click",
    ...(request.kind === "set-value" ? { text: request.value ?? "" } : {}),
    targetDescription: request.name,
  })
  const ref = typeof analysis.result.metadata?.elementId === "string" ? analysis.result.metadata.elementId : undefined
  if (ref === undefined) {
    return { ok: false, verified: false, refused: analysis.result.reasoning ?? "the target could not be resolved" }
  }
  return fromResult(await driver.execute({ type: "click", target: { kind: "element", elementId: ref } }))
}

const harnessAct: HarnessAct = async (request) => {
  const clicks = desktop.clicks.length
  const outcome = await actOnDesktop(request)
  const clicked = desktop.clicks.length > clicks ? desktop.clicks[desktop.clicks.length - 1] : undefined
  return {
    ok: outcome.ok,
    claimed: outcome.verified ? "verified" : "not_verified",
    ...(clicked === undefined ? {} : { clicked }),
    ...(outcome.refused === undefined ? {} : { refused: outcome.refused }),
    ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
  }
}

// Every pointer input the desktop ever received must stay clear of both window
// controls and of the screen centre: that is the guard, and that tolerance,
// whose absence produced the P0.
function expectNoWindowControlClick(): void {
  const pointer = desktop.pointerPosition()
  for (const point of [...desktop.clicks, ...(pointer === undefined ? [] : [pointer])]) {
    expect(containsPoint(MINIMIZE_BOUNDS, point)).toBe(false)
    expect(containsPoint(CLOSE_BOUNDS, point)).toBe(false)
    expect(distance(point, MINIMIZE_POINT)).toBeGreaterThan(CLOSE_GUARD_DISTANCE_PX)
    expect(distance(point, CLOSE_POINT)).toBeGreaterThan(CLOSE_GUARD_DISTANCE_PX)
    expect(distance(point, SCREEN_CENTER)).toBeGreaterThan(CENTER_CLICK_TOLERANCE_PX)
  }
}


describe("claim 1 — the original P0 is impossible", () => {
  test("a titled focus intent routes to focus_window and the pointer never moves", async () => {
    resetDesktop()
    expect(desktop.activeWindowTitle()).toBe(EDITOR_TITLE)

    const analysis = await service().analyze({
      computerId: COMPUTER_ID,
      operation: "click",
      targetDescription: FOCUS_INTENT,
    })
    expect(analysis.decision.provider).toBe("semantic")
    expect(analysis.result.provider).toBe("semantic")
    expect(analysis.result.action).toEqual({ type: "focus_window", window: KITTY_TITLE })
    expect(actionRequest(analysis.result.action!)).toEqual({ action: "focus_window", window: KITTY_TITLE })
    // The title the request named is what verification compares against, so an
    // over-matched candidate can never verify itself by renaming the expectation.
    expect(analysis.result.metadata?.focusRequested).toBe(KITTY_TITLE)
    // Analysis alone dispatches nothing.
    expect(desktop.actions).toEqual([])

    const performed = await service().perform({
      computerId: COMPUTER_ID,
      operation: "click",
      targetDescription: FOCUS_INTENT,
      execute: true,
      ...approval,
    })
    expect(performed.analysis.result.action).toEqual({ type: "focus_window", window: KITTY_TITLE })
    // The window action, and only that, reached the desktop.
    expect(desktop.actions).toHaveLength(1)
    expect(desktop.actions[0]).toMatchObject({
      type: "window",
      action: "focus",
      ref: `${desktop.windowRef("kitty")}@g1`,
    })
    // No pointer input at all: not (960,539), not Minimize, not Close.
    expect(desktop.clicks).toEqual([])
    expect(desktop.pointerPosition()).toBeUndefined()
    expectNoWindowControlClick()

    // The focus is confirmed by the active window, not by a claim.
    expect(performed.execution?.verified).toBe(true)
    expect(performed.execution?.confirmation).toMatchObject({
      status: "verified",
      method: "active-window",
      expected: { title: KITTY_TITLE },
      observed: { title: KITTY_TITLE },
    })
    expect(desktop.activeWindowTitle()).toBe(KITTY_TITLE)
  }, 20_000)

  test("a click aimed at a window control never reaches the desktop", async () => {
    resetDesktop()
    // Minimize is a window-management intent: it becomes the keyboard fallback,
    // never a title-bar click.
    const minimized = await service().perform({
      computerId: COMPUTER_ID,
      operation: "click",
      targetDescription: `minimize the ${MINIMIZE_NAME} button of the kitty window`,
      execute: true,
      ...approval,
    })
    expect(minimized.analysis.result.action).toEqual({ type: "key", key: "Super+Down" })
    expect(minimized.analysis.result.action?.target).toBeUndefined()
    // The desktop received the keyboard fallback and no pointer input at all.
    expect(desktop.actions).toEqual([{ type: "key", keys: ["Super", "Down"] }])
    expect(desktop.clicks).toEqual([])
    expect(desktop.pointerPosition()).toBeUndefined()
    expect(desktop.activeWindowTitle()).toBe(EDITOR_TITLE)

    // Close is not classified as a title-bar target, so the semantic provider
    // resolves it — and window-safety refuses the point before anything is sent.
    const delivered = desktop.actions.length
    const closed = await service().analyze({ computerId: COMPUTER_ID, operation: "click", targetDescription: CLOSE_NAME })
    expect(closed.errorCode).toBe("title_bar_ban")
    expect(closed.result.success).toBe(false)
    expect(closed.result.action).toBeUndefined()
    expect(desktop.actions).toHaveLength(delivered)
    expect(desktop.clicks).toEqual([])
    expect(desktop.activeWindowTitle()).toBe(EDITOR_TITLE)
  }, 20_000)
})

describe("claim 2 — a vague query never clicks", () => {
  test('"window" and "terminal" produce no action and a clarification', async () => {
    resetDesktop()
    const semantic = new SemanticProvider()
    for (const query of ["window", "terminal"]) {
      const analysis = await service().analyze({ computerId: COMPUTER_ID, operation: "click", targetDescription: query })
      expect(analysis.result.success).toBe(false)
      expect(analysis.result.action).toBeUndefined()
      // Whatever the router decided, the answer is a typed refusal that says so.
      expect(analysis.errorCode).toBeDefined()
      expect(analysis.result.reasoning ?? "").not.toBe("")

      // The semantic layer, asked the same question, answers with a clarification
      // rather than a guess.
      const direct = await semantic.analyze({
        computerId: COMPUTER_ID,
        requestedOperation: "click",
        targetDescription: query,
        semanticContext: analysis.context?.semanticContext,
      })
      expect(direct.success).toBe(false)
      expect(direct.action).toBeUndefined()
      expect(direct.confidence).toBe(0)
      expect(direct.reasoning).toBe("No semantic element matches the target description.")
    }
    // Neither vague query touched the desktop, and no pixel was ever synthesised.
    expect(desktop.actions).toEqual([])
    expect(desktop.clicks).toEqual([])
    expect(desktop.pointerPosition()).toBeUndefined()
  })

  test("the shared scorer no longer lets a query contain an element name", () => {
    // The old rule scored `query.includes(name)` at 0.4, which is what let a
    // "window" element hide inside a long focus query and feed the centre click.
    expect(MATCH_THRESHOLD).toBe(0.6)
    expect(scoreMatch("focus the kitty window", { name: "window", role: "window" })).toBe(0)
    expect(scoreMatch("focus the terminal", { name: "terminal", role: "terminal" })).toBe(0)
    expect(scoreMatch(`focus the window titled ${KITTY_TITLE}`, { name: "window", role: "window" })).toBe(0)
    // A whole-token query against a control that really carries it still matches.
    expect(scoreMatch(COMMAND_NAME, { name: COMMAND_NAME, role: "textfield" })).toBeGreaterThanOrEqual(MATCH_THRESHOLD)
  })
})

describe("claim 3 — a resolved ref click carries a real aim", () => {
  test("the click lands on the control the element itself names, and the trail records that aim", async () => {
    resetDesktop()
    const analysis = await service().analyze({ computerId: COMPUTER_ID, operation: "click", targetDescription: COMMAND_NAME })
    expect(analysis.result.action?.type).toBe("click")
    const ref = refOf(analysis.result.metadata)
    // The semantic provider resolved the control, so the action it emits is the
    // element's own actionable centre and window-safety accepts that point.
    expect(analysis.result.action?.target).toMatchObject({ x: 1546, y: 144, label: COMMAND_NAME })
    expect(checkTitleBarBan({ point: { x: 1546, y: 144 }, targetDescription: COMMAND_NAME }).banned).toBe(false)

    // Delivered against the resolved ref, the click lands exactly on that aim.
    const delivered = await driver.execute({ type: "click", target: { kind: "element", elementId: ref } })
    expect(delivered.metadata?.delivery).toBe("pointer")
    expect(desktop.clicks).toEqual([{ x: 1546, y: 144 }])
    expect(delivered.verification?.verified).toBe(true)
    expectNoWindowControlClick()

    // The audit trail records the aim and the strategy that chose it: the aim is
    // the journal's own computation over the resolved element's metadata.
    const observation = await observe()
    const command = elementNamed(observation, COMMAND_NAME)
    await server.computers.execute(COMPUTER_ID, {
      action: "click",
      target: { kind: "element", elementId: idOf(command!), observationId: idOf(observation), generation: generationOf(observation) },
      ...approval,
    })
    const record = latestRecord()
    expect(record.aim).toEqual({ x: 1546, y: 144, strategy: "control-center" })
    expect(["control-center", "focus-point", "role-inset"]).toContain(record.aim!.strategy)
    expectNoWindowControlClick()
  }, 20_000)

  test("a scrollbar is aimed from its role, not from the centre of its bounds", async () => {
    resetDesktop()
    const analysis = await service().analyze({ computerId: COMPUTER_ID, operation: "scroll", targetDescription: SCROLLBAR_NAME })
    const ref = refOf(analysis.result.metadata)
    const clicks = desktop.clicks.length
    await driver.execute({ type: "scroll", direction: "down", target: { kind: "element", elementId: ref } })
    // A semantic scroll is not a pointer click at all.
    expect(desktop.clicks).toHaveLength(clicks)

    const observation = await observe()
    const scrollbar = elementNamed(observation, SCROLLBAR_NAME)
    await server.computers.execute(COMPUTER_ID, {
      action: "scroll",
      direction: "down",
      target: { kind: "element", elementId: idOf(scrollbar!), observationId: idOf(observation), generation: generationOf(observation) },
      ...approval,
    })
    const record = latestRecord()
    expect(record.aim?.strategy).toBe("role-inset")
    expect(record.aim?.x).toBeGreaterThan(SCROLLBAR_BOUNDS.x)
    expect(record.aim?.x).toBeLessThan(SCROLLBAR_BOUNDS.x + SCROLLBAR_BOUNDS.width)
    expectNoWindowControlClick()
  }, 20_000)

  test("window-safety refuses the bounds-centre guess on a titled control", () => {
    const element = { elementRole: "button", elementName: MINIMIZE_NAME, bounds: MINIMIZE_BOUNDS, windowTitle: KITTY_TITLE }
    const guess = { x: MINIMIZE_POINT.x, y: MINIMIZE_POINT.y, strategy: "bounds-center" } as const
    const risk = evaluateClickRisk({ aim: guess, ...element })
    expect(risk.risk).toBe("high")
    expect(risk.reason).toContain("center-guess on a titled control")
    const ban = checkTitleBarBan({ aim: guess, ...element, targetDescription: FOCUS_INTENT })
    expect(ban.banned).toBe(true)
    expect(ban.reason).toContain("center-guess on a titled control")
    // The aim risk is named for what it is wherever it is judged.
    expect(describeAimRisk(guess)).toContain("bounds-center")
    // The role inset is the only strategy that may address a window control.
    const inset = { x: MINIMIZE_BOUNDS.x + 2, y: MINIMIZE_POINT.y, strategy: "role-inset" } as const
    expect(evaluateClickRisk({ aim: inset, elementRole: "minimizebutton", elementName: MINIMIZE_NAME, bounds: MINIMIZE_BOUNDS, windowTitle: KITTY_TITLE }).risk).toBe("low")
  })
})

describe("claim 4 — verification is honest", () => {
  test("a focus that does not change the active window is not_verified with expected and observed", async () => {
    resetDesktop()
    desktop.breakFocus()
    const performed = await service().perform({
      computerId: COMPUTER_ID,
      operation: "click",
      targetDescription: FOCUS_INTENT,
      execute: true,
      ...approval,
    })
    // The action was delivered: a delivery is not a verification.
    expect(performed.execution?.outcome.result.success).toBe(true)
    expect(performed.execution?.verified).toBe(false)
    expect(performed.analysis.result.metadata?.verified).toBe(false)
    const confirmation = performed.execution?.confirmation
    expect(confirmation?.status).toBe("not_verified")
    expect(confirmation?.method).toBe("active-window")
    expect(confirmation?.expected?.title).toBe(KITTY_TITLE)
    expect(confirmation?.observed?.title).toBe(EDITOR_TITLE)
    // The journal records the same verdict, from the observation that was read.
    const record = latestRecord()
    expect(record.result.status).toBe("not_verified")
    expect(record.result.method).toBe("atspi-focus")
    expect(record.result.reason).toContain(EDITOR_TITLE)
    desktop.healFocus()
    expect(desktop.activeWindowTitle()).toBe(EDITOR_TITLE)
  }, 20_000)
})

describe("claim 5 — stale refs are refused", () => {
  test("a ref from an older generation is refused naming both ids, and no click is sent", async () => {
    resetDesktop()
    const first = await observe()
    const command = elementNamed(first, COMMAND_NAME)!
    const ref = idOf(command!)
    const observationId = idOf(first)
    const generation = generationOf(first)

    // Age the desktop: a newer observation is now the current one.
    engine.invalidate()
    const current = await observe()
    const currentGeneration = generationOf(current)
    expect(currentGeneration).toBeGreaterThan(generation)
    expect(idOf(current)).not.toBe(observationId)

    const clicks = desktop.clicks.length
    expectNoWindowControlClick()

    // The engine refuses the ref outright and names both observations.
    const refused = await engine.execute({ type: "invoke", ref, observationId, generation })
    expect(refused.ok).toBe(false)
    expect(refused.verified).toBe(false)
    expect(refused.delivery).toBe("refused")
    expect(refused.error?.code).toBe("stale_ref")
    expect(refused.message).toContain(ref)
    expect(refused.message).toContain(observationId)
    expect(refused.message).toContain(`generation ${generation}`)
    expect(refused.message).toContain(idOf(current))
    expect(refused.message).toContain(`generation ${currentGeneration}`)
    expect(desktop.clicks).toHaveLength(clicks)

    // The manager route refuses the same pair and journals it with both ids.
    const outcome = await server.computers.execute(COMPUTER_ID, {
      action: "click",
      target: { kind: "element", elementId: ref, observationId, generation },
      ...approval,
    })
    expect(outcome.result.success).toBe(false)
    expect(outcome.result.status).toBe("rejected")
    expect(errorOf(outcome.result).code).toBe("target_stale")
    expect(desktop.clicks).toHaveLength(clicks)
    const record = latestRecord()
    expect(record.ref).toBe(ref)
    expect(record.observationId).toBe(observationId)
    expect(record.generation).toBe(generation)
    expect(record.result.status).toBe("not_verified")
    expect(record.permission.allowed).toBe(true)

    // A current ref bound to an older observation is refused the same way, and
    // the refusal names the observation it came from and the current one.
    const latest = await driver.observe()
    const live = elementNamed(latest, COMMAND_NAME)!
    expect(idOf(live!)).not.toBe(ref)
    const rebound = await driver.execute({
      type: "click",
      target: { kind: "element", elementId: idOf(live!), reference: { kind: "element", elementId: idOf(live!), observationId, generation } },
    })
    expect(rebound.success).toBe(false)
    expect(errorOf(rebound).code).toBe("target_stale")
    const reboundError = errorOf(rebound)
    expect(reboundError.message).toContain(observationId)
    expect(reboundError.message).toContain(`generation ${generation}`)
    expect(reboundError.message).toContain(idOf(latest))
    expect(reboundError.message).toContain(`generation ${generationOf(latest)}`)
    expect(desktop.clicks).toHaveLength(clicks)
    expectNoWindowControlClick()
  }, 20_000)
})

describe("claim 6 — the audit trail", () => {
  test("every action leaves a record with its aim, its permission, and its verdict", async () => {
    resetDesktop()
    const before = trail().length

    // A focus resolved by window title.
    const focused = await service().perform({
      computerId: COMPUTER_ID,
      operation: "click",
      targetDescription: FOCUS_INTENT,
      execute: true,
      ...approval,
    })
    expect(focused.execution?.verified).toBe(true)

    // A click on a resolved ref, bound to the observation it was resolved against.
    const observation = await observe()
    const command = elementNamed(observation, COMMAND_NAME)!
    await server.computers.execute(COMPUTER_ID, {
      action: "click",
      target: { kind: "element", elementId: idOf(command!), observationId: idOf(observation), generation: generationOf(observation) },
      ...approval,
    })

    // An action the permission gate refuses before the desktop is touched.
    await server.computers.execute(COMPUTER_ID, { action: "copy" })

    const records = trail().slice(before)
    expect(records).toHaveLength(3)
    for (const record of records) {
      expect(record.type).toBe("computer_use.action")
      expect(record.computerId).toBe(COMPUTER_ID)
      expect(record.action.length).toBeGreaterThan(0)
      expect(record.generation).toBeGreaterThan(0)
      expect(["verified", "not_verified"]).toContain(record.result.status)
    }

    const [focusRecord, clickRecord, deniedRecord] = records
    // The window action: a permission decision and an honest verdict. The journal
    // sees the request before the server resolves the window, so the window
    // itself is not named in the record (reported, not fixed).
    expect(focusRecord!.action).toBe("focus_window")
    expect(focusRecord!.permission.allowed).toBe(true)
    expect(focusRecord!.permission.status).toBe("allowed")
    expect(focusRecord!.permission.by).toBe(APPROVER)
    expect(focusRecord!.result.status).toBe("verified")

    // The ref click: every field the contract asks for. The action is now
    // delivered against the reference revalidation returns, so the verdict is
    // the delivered click's own: the post-action read confirms the focus moved
    // to the control that was clicked.
    expect(clickRecord!.ref).toBe(idOf(command!))
    expect(clickRecord!.observationId).toBe(idOf(observation))
    expect(clickRecord!.generation).toBe(generationOf(observation))
    expect(clickRecord!.aim).toEqual({ x: 1546, y: 144, strategy: "control-center" })
    expect(clickRecord!.permission.allowed).toBe(true)
    expect(clickRecord!.permission.scopes).toContain("UI_CONTROL")
    expect(clickRecord!.result.status).toBe("verified")
    expect(clickRecord!.result.method).toBe("cua-snapshot")

    // A refusal is a permission outcome, not a click that happened.
    expect(deniedRecord!.action).toBe("copy")
    expect(deniedRecord!.permission.allowed).toBe(false)
    expect(deniedRecord!.permission.status).toBe("prompt")
    expect(deniedRecord!.permission.scopes).toContain("CLIPBOARD_WRITE")
    expect(deniedRecord!.ref).toBeUndefined()
    expect(deniedRecord!.result.status).toBe("not_verified")

    // The journal chain verifies: the trail was not tampered with.
    expect(readComputerUseTrail(auditFile).chain).toBe("ok")
    expect(readComputerUseTrail(auditFile, { computerId: COMPUTER_ID }).total).toBeGreaterThanOrEqual(3)
  }, 20_000)

  test("a window action's record names the window it was delivered to", async () => {
    resetDesktop()
    const performed = await service().perform({
      computerId: COMPUTER_ID,
      operation: "click",
      targetDescription: FOCUS_INTENT,
      execute: true,
      ...approval,
    })
    expect(performed.execution?.verified).toBe(true)

    // The window action is traced by the window, not by a pointer: the title the
    // request named (mapped in server/server.ts) and the window element id the
    // manager resolved the title to and delivered to (read from the
    // execution's own resolved target in security/journal.ts). The caller named
    // no element, so no element ref is invented for it, and a window is raised
    // rather than aimed at, so no aim is invented either.
    const record = latestRecord()
    expect(record.action).toBe("focus_window")
    expect(record.window).toBe(KITTY_TITLE)
    expect(record.ref).toBeUndefined()
    expect(record.aim).toBeUndefined()
    expect(record.windowId?.startsWith(`${desktop.windowRef("kitty")}@g`)).toBe(true)
    expect(record.result.status).toBe("verified")
  }, 20_000)
})

describe("claim 7 — the live harness trials", () => {
  test("the trials pass on the same synthetic desktop, including the honest-verify trial", async () => {
    resetDesktop()
    const report = await runAllTrials({
      act: harnessAct,
      observe: harnessObserve,
      platform: "linux",
      env: { DISPLAY: ":0" },
      title: KITTY_TITLE,
      controlName: COMMAND_NAME,
    })
    expect(report.trials.map((trial) => trial.name)).toEqual([
      "active window contains target title",
      "no blind screen-center click on off-center target",
      "click lands on the named control",
      "click stays clear of the Close button",
      "honest verification: no observed change means not_verified",
      "honest verification: a confirmed change may claim verified",
      "stale ref is refused",
      "a stale ref never clicks another element",
    ])
    const outcomes = report.trials.map((trial) => trial.outcome)
    // Eight trials pass: the focus trial, both wrong-target guards, the Close
    // guard, both honest-verify scenarios, and both stale-ref trials.
    expect(outcomes.filter((outcome) => outcome === "pass")).toHaveLength(8)
    expect(report.errors).toBe(0)
    // The honest-verify trial's change-free scenario: the engine compares the
    // focused node by identity, so a re-scoped focus is not a move and the
    // set-value of an unchanged value reports not_verified.
    const honest = report.trials.find((trial) => trial.name === HONEST_VERIFY_TRIAL_NAME)
    expect(honest?.outcome).toBe("pass")
    expect(honest?.evidence).toMatchObject({ scenario: "set-value to the current value", status: "not_verified", changed: false })
    // The desktop was really driven: the named control was clicked, and never a
    // window control or the screen centre.
    expect(desktop.clicks).toContainEqual({ x: 1546, y: 144 })
    expectNoWindowControlClick()
  }, 30_000)

  test("the live arm is skipped without a display instead of faking a pass", () => {
    // The real adapters are the only code that can reach a display, so they are
    // gated on both an explicit arm and a DISPLAY. Without a display the CLI
    // reports a skip and builds no driver at all.
    expect(liveHarnessSkipReason({ OMNIA_LIVE_HARNESS: "1" })).toBe("DISPLAY is unset or empty")
    expect(createLiveAdapters({ OMNIA_LIVE_HARNESS: "1" })).toBeUndefined()
    expect(liveHarnessSkipReason({})).toBe("OMNIA_LIVE_HARNESS is not set to 1")
  })
})

// Findings this test surfaced against the production code. Each is pinned here
// with its file and line rather than fixed, because this file owns no source
// outside itself.
describe("known gaps, pinned instead of fixed", () => {
  test("the manager acts on the reference revalidation returns, so an element-ref action is delivered", async () => {
    resetDesktop()
    // This was a pinned gap: server/computers.ts re-validated an element target
    // and used only `revalidation.valid`, discarding the fresh reference the
    // driver returned for exactly this purpose. CuaHostDriver.revalidateTarget
    // (cua/host-driver.ts) invalidates the engine cache and captures a new
    // generation first, so the ref the caller resolved from generation N is no
    // longer resolvable when the action is dispatched against generation N+1:
    // resolveElement matches the exact scoped ref string, while retargetElement
    // already resolves by identity. The manager now dispatches the action
    // against the reference revalidation returned, so the same element is acted
    // on in the new generation instead of the action being refused with nothing
    // delivered. A ref bound to an observation that is no longer the current
    // one is still refused, naming both observations (claim 5).
    const observation = await observe()
    const command = elementNamed(observation, COMMAND_NAME)!
    const outcome = await server.computers.execute(COMPUTER_ID, {
      action: "click",
      target: { kind: "element", elementId: idOf(command!), observationId: idOf(observation), generation: generationOf(observation) },
      ...approval,
    })
    // The action is delivered, not refused: the click lands on the control the
    // ref named, and the post-action read confirms it.
    expect(outcome.result.success).toBe(true)
    expect(desktop.clicks).toEqual([{ x: 1546, y: 144 }])
    expect(outcome.result.verification?.verified).toBe(true)
    expect(outcome.result.verification?.method).toBe("cua-snapshot")
    expectNoWindowControlClick()
    // The audit trail still names what the caller resolved, the aim that was
    // chosen, and the verdict the delivered action earned.
    const record = latestRecord()
    expect(record.ref).toBe(idOf(command!))
    expect(record.observationId).toBe(idOf(observation))
    expect(record.generation).toBe(generationOf(observation))
    expect(record.aim).toEqual({ x: 1546, y: 144, strategy: "control-center" })
    expect(record.result.status).toBe("verified")
    expect(record.permission.allowed).toBe(true)
  }, 20_000)

  test("a change-free action is not claimed verified", async () => {
    resetDesktop()
    // A window is focused, as it always is on a real desktop, and nothing about
    // the desktop changes: the only honest verdict for the actions below is
    // not_verified.
    //
    // This was the false-Verified bug: cua/engine.ts:302-303 compared
    // `before.focusedRef !== after.focusedRef`, but every capture re-scopes refs
    // to its own generation, so two captures of the same focused node always
    // differ. `focusedMoved` was therefore always true, `observedChange` was
    // true, and the action verified although nothing changed. The comparison is
    // now on the refs' identity — as computeStateDelta already does for the
    // element lists — so a focus move is only a move between different nodes.
    const observation = await driver.observe()
    const scrollbar = elementNamed(observation, SCROLLBAR_NAME)!
    const scrolled = await driver.execute({
      type: "scroll",
      direction: "down",
      target: { kind: "element", elementId: idOf(scrollbar!) },
    })
    expect(scrolled.success).toBe(true)
    // The delta names the focused node of the after-observation: the same Editor
    // window in both captures, so only the generation scope differs and no
    // focus move is owed.
    const delta = scrolled.metadata?.stateDelta as { focusedRef?: string } | undefined
    expect(refIdentity(delta?.focusedRef ?? "")).toBe(`cua:window/soffice/editor/1`)
    expect(scrolled.verification?.verified).toBe(false)
    expect(scrolled.verification?.status).toBe("unverified")

    // The same holds for the harness's own scenario: writing the value a
    // control already holds.
    const command = elementNamed(await driver.observe(), COMMAND_NAME)!
    const typed = await driver.execute({
      type: "type",
      target: { kind: "element", elementId: idOf(command!) },
      text: typeof command!.value === "string" ? command!.value : JSON.stringify(command!.value ?? ""),
    })
    expect(typed.success).toBe(true)
    expect(typed.verification?.verified).toBe(false)
    expectNoWindowControlClick()
  }, 20_000)
})
