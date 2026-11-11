import { describe, expect, test } from "bun:test"
import type { ComputerAction } from "../protocol"
import { DEFAULT_SNAPSHOT_TTL_MS, CuaEngine, computeStateDelta, refIdentity, scopedRef } from "./engine"
import { StaleRefError } from "./types"
import { CuaHostDriver } from "./host-driver"
import type { CuaLegacyFallbacks } from "./host-driver"
import type {
  CuaAction,
  CuaActionResult,
  CuaBackend,
  CuaCapabilities,
  CuaElement,
  CuaFindQuery,
  CuaPlatform,
  CuaSnapshot,
  CuaSnapshotOptions,
  CuaWaitCondition,
  CuaWaitResult,
  CuaWindow,
} from "./types"

function element(ref: string, overrides: Partial<CuaElement> = {}): CuaElement {
  return {
    ref,
    backendRef: `backend:${ref}`,
    role: "button",
    name: ref,
    enabled: true,
    focused: false,
    editable: false,
    actions: [],
    states: [],
    generation: 1,
    ...overrides,
  }
}

function snapshot(
  id: string,
  generation: number,
  input: { elements?: CuaElement[]; windows?: CuaWindow[]; focusedRef?: string } = {},
): CuaSnapshot {
  return {
    id,
    generation,
    takenAt: 1000,
    platform: "linux",
    windows: input.windows ?? [],
    elements: input.elements ?? [],
    ...(input.focusedRef === undefined ? {} : { focusedRef: input.focusedRef }),
    truncated: false,
    warnings: [],
  }
}

function fakeCapabilities(): CuaCapabilities {
  return {
    snapshot: true,
    semanticActions: true,
    backgroundActions: true,
    backgroundInput: true,
    pointer: true,
    keyboard: true,
    clipboard: true,
    screenshot: true,
    windowManagement: true,
    waitFor: true,
    refs: true,
    actions: ["invoke", "set_value", "focus"],
    limits: [],
  }
}

class FakeBackend implements CuaBackend {
  readonly platform: CuaPlatform = "linux"
  readonly name = "fake-cua"
  readonly executed: CuaAction[] = []
  readonly waits: CuaWaitCondition[] = []
  readonly beforeSnapshots: Array<CuaSnapshot | undefined> = []
  queue: CuaSnapshot[] = []
  result: Partial<CuaActionResult> = {}
  waitResult: CuaWaitResult = { ok: true, waitedMs: 7 }
  disposals = 0
  snapshotDelayMs = 0
  executeDelayMs = 0
  activeExecutions = 0
  maxActiveExecutions = 0
  snapshotCalls = 0
  failWhenDrained = false
  readonly snapshotOptions: Array<CuaSnapshotOptions | undefined> = []
  readonly refreshWindowCalls: string[] = []
  readonly refreshApplicationCalls: string[] = []
  refreshedQueue: CuaSnapshot[] = []
  private taken = 0

  async available(): Promise<boolean> {
    return true
  }

  async capabilities(): Promise<CuaCapabilities> {
    return fakeCapabilities()
  }

  async snapshot(options?: CuaSnapshotOptions): Promise<CuaSnapshot> {
    this.snapshotCalls += 1
    this.snapshotOptions.push(options)
    if (this.snapshotDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.snapshotDelayMs))
    if (this.failWhenDrained && this.taken >= this.queue.length) {
      this.taken += 1
      throw new Error("snapshot unavailable")
    }
    const next = this.queue[Math.min(this.taken, this.queue.length - 1)]
    this.taken += 1
    if (next === undefined) throw new Error("No snapshot queued.")
    return next
  }

  async find(query: CuaFindQuery, snapshot?: CuaSnapshot): Promise<CuaElement[]> {
    const elements = snapshot?.elements ?? []
    return elements.filter((candidate) => query.text === undefined || candidate.name.includes(query.text))
  }

  async execute(action: CuaAction, snapshot?: CuaSnapshot): Promise<CuaActionResult> {
    this.activeExecutions += 1
    this.maxActiveExecutions = Math.max(this.maxActiveExecutions, this.activeExecutions)
    if (this.executeDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.executeDelayMs))
    this.activeExecutions -= 1
    this.executed.push(action)
    this.beforeSnapshots.push(snapshot)
    return {
      ok: true,
      action,
      verified: true,
      message: "fake action",
      delivery: "background-ax",
      generation: 1,
      ...this.result,
    }
  }

  async refreshWindow(ref: string): Promise<CuaSnapshot | undefined> {
    this.refreshWindowCalls.push(ref)
    return this.refreshedQueue.shift()
  }

  async refreshApplication(app: string): Promise<CuaSnapshot | undefined> {
    this.refreshApplicationCalls.push(app)
    return this.refreshedQueue.shift()
  }

  async waitFor(condition: CuaWaitCondition): Promise<CuaWaitResult> {
    this.waits.push(condition)
    return this.waitResult
  }

  async dispose(): Promise<void> {
    this.disposals += 1
  }
}

function engineWith(
  queue: CuaSnapshot[],
  result: Partial<CuaActionResult> = {},
): { engine: CuaEngine; backend: FakeBackend } {
  const backend = new FakeBackend()
  backend.queue = queue
  backend.result = result
  const engine = new CuaEngine({ backend, cacheTtlMs: 0 })
  return { engine, backend }
}

const mainSnapshot = (): CuaSnapshot =>
  snapshot("obs-1", 1, {
    focusedRef: "cua:field",
    windows: [{ ref: "cua:window", backendRef: "win-1", app: "test", title: "Test", focused: true, generation: 1 }],
    elements: [
      element("cua:save", { role: "button", actions: ["click"], bounds: { x: 0, y: 0, width: 40, height: 20 } }),
      element("cua:field", {
        role: "textbox",
        editable: true,
        focused: true,
        bounds: { x: 0, y: 40, width: 100, height: 20 },
      }),
      element("cua:label", { role: "label", name: "Total", text: "Total 42", actions: [] }),
      element("cua:list", { role: "list", bounds: { x: 0, y: 80, width: 100, height: 100 } }),
      element("cua:plain", { role: "generic", actions: [], bounds: { x: 10, y: 200, width: 20, height: 10 } }),
    ].map((item) => ({ ...item, windowRef: "cua:window", application: "test" })),
  })

function driverWith(options: { queue?: CuaSnapshot[]; result?: Partial<CuaActionResult> } = {}): {
  driver: CuaHostDriver
  engine: CuaEngine
  backend: FakeBackend
} {
  const backend = new FakeBackend()
  backend.queue = options.queue ?? [mainSnapshot()]
  backend.result = options.result ?? {}
  // A frozen clock with the production freshness window, so the observation a
  // test reads its refs from stays the one the act path resolves against.
  const engine = new CuaEngine({ backend, cacheTtlMs: DEFAULT_SNAPSHOT_TTL_MS, now: () => 1000 })
  const driver = new CuaHostDriver({ engine })
  return { driver, engine, backend }
}

// Refs are generation-scoped, so a test acts on the ref string the observation
// it read minted rather than the backend's unscoped one.
async function liveRef(driver: CuaHostDriver, ref: string): Promise<string> {
  const observation = await driver.observe()
  const element = (observation.elements ?? []).find((candidate) => refIdentity(candidate.id ?? "") === ref)
  return element?.id ?? ref
}

function window(ref: string, overrides: Partial<CuaWindow> = {}): CuaWindow {
  return { ref, backendRef: `win:${ref}`, app: "test", title: ref, focused: false, generation: 1, ...overrides }
}

describe("cua engine", () => {
  test("takes monotonic generations and reuses a fresh snapshot", async () => {
    const backend = new FakeBackend()
    backend.queue = [snapshot("snap-1", 4), snapshot("snap-2", 4)]
    const engine = new CuaEngine({ backend, cacheTtlMs: 0 })
    const first = await engine.snapshot()
    const second = await engine.snapshot()
    expect(first.id).toBe("snap-1")
    expect(first.generation).toBe(4)
    expect(second.id).toBe("snap-2")
    expect(second.generation).toBe(5)

    const cachedBackend = new FakeBackend()
    cachedBackend.queue = [snapshot("cached", 1)]
    const cached = new CuaEngine({ backend: cachedBackend, cacheTtlMs: 350, now: () => 1000 })
    const a = await cached.snapshot()
    const b = await cached.snapshot()
    expect(b).toBe(a)
  })

  test("rejects stale capture ids for pointer actions", async () => {
    const backend = new FakeBackend()
    backend.queue = [snapshot("capture-1", 1)]
    const engine = new CuaEngine({ backend, cacheTtlMs: 0 })
    const current = await engine.snapshot()

    const refused = await engine.execute({ type: "click", point: { x: 5, y: 5 }, captureId: "capture-0" })
    expect(refused.ok).toBe(false)
    expect(refused.delivery).toBe("refused")
    expect(refused.error?.code).toBe("capture_stale")
    expect(backend.executed).toHaveLength(0)

    const accepted = await engine.execute({ type: "click", point: { x: 5, y: 5 }, captureId: current.id })
    expect(accepted.ok).toBe(true)
    expect(backend.executed).toHaveLength(1)
  })

  test("computes state deltas across snapshots", async () => {
    const before = snapshot("before", 1, {
      focusedRef: "field",
      elements: [element("field", { role: "textbox", editable: true, focused: true }), element("save"), element("old")],
    })
    const after = snapshot("after", 2, {
      focusedRef: "new",
      elements: [
        element("field", { role: "textbox", editable: true, value: "typed" }),
        element("save", { name: "Save as" }),
        element("new"),
      ],
    })

    expect(computeStateDelta(before, after)).toEqual({
      focusedRef: "new",
      addedRefs: ["new"],
      removedRefs: ["old"],
      changedRefs: ["field", "save"],
    })

    const { engine } = engineWith([before, after])
    const result = await engine.execute({ type: "invoke", ref: "save" })
    expect(result.ok).toBe(true)
    // The delta reports the refs the observation each side actually minted:
    // a changed ref belongs to the after-observation, whose scoped ref string
    // differs from the before-observation's.
    expect(result.stateDelta?.changedRefs?.map(refIdentity)).toEqual(["field", "save"])
    expect(result.stateDelta?.focusedRef).toBe(scopedRef("new", 2))
  })

  test("verifies focus", async () => {
    const { engine } = engineWith([
      snapshot("focus-before", 1, {
        focusedRef: "other",
        elements: [element("field", { role: "textbox", editable: true, focused: false })],
      }),
      snapshot("focus-after", 2, {
        focusedRef: "field",
        elements: [element("field", { role: "textbox", editable: true, focused: true })],
      }),
    ])
    const result = await engine.execute({ type: "focus", ref: "field" })
    expect(result.ok).toBe(true)
    expect(result.verified).toBe(true)
  })

  test("keeps ok true but marks an unverified focus with a warning", async () => {
    const { engine } = engineWith([
      snapshot("miss-before", 1, {
        focusedRef: "other",
        elements: [element("field", { role: "textbox", editable: true, focused: false })],
      }),
      snapshot("miss-after", 2, {
        focusedRef: "other",
        elements: [element("field", { role: "textbox", editable: true, focused: false })],
      }),
    ])
    const result = await engine.execute({ type: "focus", ref: "field" })
    expect(result.ok).toBe(true)
    expect(result.verified).toBe(false)
    expect(result.warnings?.some((warning) => warning.includes("focus"))).toBe(true)
  })

  test("verifies set_value from the read-back value", async () => {
    const { engine } = engineWith([
      snapshot("value-before", 1, { elements: [element("field", { role: "textbox", editable: true })] }),
      snapshot("value-after", 2, {
        elements: [element("field", { role: "textbox", editable: true, value: "hello" })],
      }),
    ])
    const result = await engine.execute({ type: "set_value", ref: "field", value: "hello" })
    expect(result.ok).toBe(true)
    expect(result.verified).toBe(true)
  })

  test("verifies window close against the follow-up snapshot", async () => {
    const window: CuaWindow = {
      ref: "cua:window",
      backendRef: "win-1",
      app: "test",
      title: "Test",
      focused: true,
      generation: 1,
    }
    const { engine } = engineWith([
      snapshot("window-before", 1, { windows: [window] }),
      snapshot("window-after", 2, {}),
    ])
    const result = await engine.execute({ type: "window", action: "close", ref: "cua:window" })
    expect(result.ok).toBe(true)
    expect(result.verified).toBe(true)
  })

  test("delegates waitFor to the backend", async () => {
    const { engine, backend } = engineWith([snapshot("wait", 1)])
    const result = await engine.waitFor({ ref: "field", timeoutMs: 25 })
    expect(backend.waits).toEqual([{ ref: "field", timeoutMs: 25 }])
    expect(result).toEqual({ ok: true, waitedMs: 7 })
  })

  test("verifies minimize only from an explicit minimized window state", async () => {
    const { engine } = engineWith([
      snapshot("min-before", 1, { windows: [window("cua:window", { focused: true })] }),
      snapshot("min-after", 2, { windows: [window("cua:window", { minimized: true })] }),
    ])
    const result = await engine.execute({ type: "window", action: "minimize", ref: "cua:window" })
    expect(result.ok).toBe(true)
    expect(result.verified).toBe(true)
  })

  test("does not verify minimize when the window merely lost focus", async () => {
    const { engine } = engineWith([
      snapshot("min-before", 1, { windows: [window("cua:window", { focused: true })] }),
      snapshot("min-after", 2, { windows: [window("cua:window", { focused: false })] }),
    ])
    const result = await engine.execute({ type: "window", action: "minimize", ref: "cua:window" })
    expect(result.ok).toBe(true)
    expect(result.verified).toBe(false)
  })

  test("does not verify minimize when the window vanished", async () => {
    const { engine } = engineWith([
      snapshot("min-before", 1, { windows: [window("cua:window", { focused: true })] }),
      snapshot("min-after", 2, {}),
    ])
    const result = await engine.execute({ type: "window", action: "minimize", ref: "cua:window" })
    expect(result.verified).toBe(false)
  })

  test("requires bounds for maximize and tile verification", async () => {
    const { engine } = engineWith([
      snapshot("max-before", 1, { windows: [window("cua:window", { focused: true })] }),
      snapshot("max-after", 2, { windows: [window("cua:window", { focused: true })] }),
    ])
    const result = await engine.execute({ type: "window", action: "maximize", ref: "cua:window" })
    expect(result.ok).toBe(true)
    expect(result.verified).toBe(false)

    const changed = engineWith([
      snapshot("max-before", 1, {
        windows: [window("cua:window", { focused: true, bounds: { x: 0, y: 0, width: 100, height: 100 } })],
      }),
      snapshot("max-after", 2, {
        windows: [window("cua:window", { focused: true, bounds: { x: 0, y: 0, width: 200, height: 200 } })],
      }),
    ])
    const verified = await changed.engine.execute({ type: "window", action: "maximize", ref: "cua:window" })
    expect(verified.verified).toBe(true)
  })

  test("verifies dismiss when the transient surface leaves the tree", async () => {
    const { engine } = engineWith([
      snapshot("dismiss-before", 1, { elements: [element("cua:menu", { role: "menu" })] }),
      snapshot("dismiss-after", 2, {}),
    ])
    const result = await engine.execute({ type: "dismiss" })
    expect(result.ok).toBe(true)
    expect(result.verified).toBe(true)
    expect(result.stateDelta?.removedRefs).toEqual([scopedRef("cua:menu", 1)])
  })

  test("keeps dismiss ok but unverified when nothing observable changed", async () => {
    const { engine } = engineWith([
      snapshot("dismiss-before", 1, { elements: [element("cua:menu", { role: "menu" })] }),
    ])
    const result = await engine.execute({ type: "dismiss" })
    expect(result.ok).toBe(true)
    expect(result.verified).toBe(false)
    expect(result.warnings?.some((warning) => warning.includes("dismiss"))).toBe(true)
  })

  test("does not verify restore while the window is still minimized", async () => {
    const { engine } = engineWith([
      snapshot("restore-before", 1, { windows: [window("cua:window", { minimized: true })] }),
      snapshot("restore-after", 2, { windows: [window("cua:window", { minimized: true })] }),
    ])
    const result = await engine.execute({ type: "window", action: "restore", ref: "cua:window" })
    expect(result.verified).toBe(false)
  })

  test("click with pointer delivery but no observable change is unverified", async () => {
    const before = snapshot("click-before", 1, { elements: [element("a")] })
    const after = snapshot("click-after", 2, { elements: [element("a")] })
    const { engine } = engineWith([before, after], { delivery: "pointer", verified: false })
    const result = await engine.execute({ type: "click", point: { x: 1, y: 1 } })
    expect(result.ok).toBe(true)
    expect(result.verified).toBe(false)
    expect(result.warnings?.some((warning) => warning.includes("did not confirm"))).toBe(true)
  })

  test("drag verifies only on focus move or delta, never on delivery alone", async () => {
    const before = snapshot("drag-before", 1, { focusedRef: "a", elements: [element("a")] })
    const after = snapshot("drag-after", 2, { focusedRef: "b", elements: [element("a")] })
    const moved = engineWith([before, after], { delivery: "pointer" })
    const verified = await moved.engine.execute({ type: "drag", from: { x: 0, y: 0 }, to: { x: 5, y: 5 } })
    expect(verified.verified).toBe(true)

    const still = engineWith(
      [snapshot("d1", 1, { elements: [element("a")] }), snapshot("d2", 2, { elements: [element("a")] })],
      { delivery: "pointer" },
    )
    const unverified = await still.engine.execute({ type: "drag", from: { x: 0, y: 0 }, to: { x: 5, y: 5 } })
    expect(unverified.verified).toBe(false)
  })

  test("does not count the same focused element in a later generation as a focus move", async () => {
    // Refs are generation-scoped, so the same focused element necessarily carries
    // a different ref string in each observation. Changing the scope is not a
    // move: reading it as one verified every action taken while anything was
    // focused, which is the false-Verified bug.
    const before = snapshot("same-before", 1, {
      focusedRef: "cua:field",
      elements: [element("cua:field", { role: "textbox", editable: true, focused: true }), element("cua:save")],
    })
    const after = snapshot("same-after", 2, {
      focusedRef: "cua:field",
      elements: [element("cua:field", { role: "textbox", editable: true, focused: true }), element("cua:save")],
    })
    const { engine } = engineWith([before, after], { delivery: "pointer" })
    const result = await engine.execute({ type: "click", point: { x: 2, y: 2 } })
    expect(result.ok).toBe(true)
    expect(result.verified).toBe(false)
    expect(result.warnings?.some((warning) => warning.includes("did not confirm"))).toBe(true)
    // Both observations describe the same focused element, so only the scope of
    // its ref differs.
    expect(refIdentity(result.stateDelta?.focusedRef ?? "")).toBe("cua:field")
    expect(result.stateDelta?.focusedRef).toBe(scopedRef("cua:field", 2))
  })

  test("counts a focus move to a different window as an observed change", async () => {
    const before = snapshot("moved-before", 1, {
      windows: [window("cua:window/away"), window("cua:window/here", { focused: true })],
      focusedRef: "cua:window/here",
      elements: [element("cua:item")],
    })
    const after = snapshot("moved-after", 2, {
      windows: [window("cua:window/away", { focused: true }), window("cua:window/here")],
      focusedRef: "cua:window/away",
      elements: [element("cua:item")],
    })
    const { engine } = engineWith([before, after], { delivery: "pointer" })
    const result = await engine.execute({ type: "click", point: { x: 2, y: 2 } })
    expect(result.ok).toBe(true)
    // Nothing in the element tree changed: the focus move is the whole evidence.
    expect(result.stateDelta?.changedRefs).toBeUndefined()
    expect(refIdentity(result.stateDelta?.focusedRef ?? "")).toBe("cua:window/away")
    expect(result.verified).toBe(true)
  })

  test("an action with no observable change is not verified", async () => {
    // A window is focused, as it always is on a real desktop, and nothing about
    // the desktop changes: writing back a value the control already holds leaves
    // the state exactly as it was.
    const before = snapshot("still-before", 1, {
      windows: [window("cua:window", { focused: true })],
      focusedRef: "cua:window",
      elements: [element("cua:field", { role: "textbox", editable: true, value: "ls -la" })],
    })
    const after = snapshot("still-after", 2, {
      windows: [window("cua:window", { focused: true })],
      focusedRef: "cua:window",
      elements: [element("cua:field", { role: "textbox", editable: true, value: "ls -la" })],
    })
    // The backend claims the action verified itself; only the readback counts.
    const { engine } = engineWith([before, after], { delivery: "keyboard", verified: true })
    const result = await engine.execute({ type: "type", text: "ls -la" })
    expect(result.ok).toBe(true)
    expect(result.verified).toBe(false)
    expect(result.warnings?.some((warning) => warning.includes("did not confirm"))).toBe(true)
  })

  test("window close with a missing after-snapshot never verifies", async () => {
    const backend = new FakeBackend()
    backend.queue = [snapshot("close-before", 1, { windows: [window("cua:window", { focused: true })] })]
    backend.failWhenDrained = true
    const engine = new CuaEngine({ backend, cacheTtlMs: 0 })
    const result = await engine.execute({ type: "window", action: "close", ref: "cua:window" })
    expect(result.ok).toBe(true)
    expect(result.verified).toBe(false)
  })

  test("never trusts self-reported verified without independent readback", async () => {
    const before = snapshot("self-before", 1, { elements: [element("a")] })
    const after = snapshot("self-after", 2, { elements: [element("a")] })
    const { engine } = engineWith([before, after], { delivery: "keyboard", verified: true })
    const typed = await engine.execute({ type: "type", text: "hello" })
    expect(typed.ok).toBe(true)
    expect(typed.verified).toBe(false)

    const keyed = await engineWith([before, after], { delivery: "keyboard", verified: true }).engine.execute({
      type: "key",
      keys: ["Enter"],
    })
    expect(keyed.verified).toBe(false)
  })
})

describe("cua snapshot cache", () => {
  test("reuses an option-superset snapshot and re-caps it truthfully", async () => {
    const backend = new FakeBackend()
    const full = snapshot("full", 1, {
      elements: Array.from({ length: 120 }, (_, index) => element(`cua:item-${index}`)),
    })
    backend.queue = [full]
    backend.failWhenDrained = true
    const engine = new CuaEngine({ backend, cacheTtlMs: 1000, now: () => 1000 })
    await engine.snapshot({ maxElements: 10_000 })

    const capped = await engine.snapshot({ maxElements: 10 })
    expect(capped.id).toBe("full")
    expect(capped.elements).toHaveLength(10)
    expect(capped.truncated).toBe(true)
    expect(capped.warnings.some((warning) => warning.includes("truncated to 10 of 120"))).toBe(true)

    const defaulted = await engine.snapshot()
    expect(defaulted.id).toBe("full")
    expect(defaulted.elements).toHaveLength(120)
    expect(defaulted.truncated).toBe(false)
    expect(backend.snapshotCalls).toBe(1)
  })

  test("reuses the exact truncated walk for a repeated request", async () => {
    const backend = new FakeBackend()
    const truncated = snapshot("truncated", 1, {
      elements: Array.from({ length: 12 }, (_, index) => element(`cua:item-${index}`)),
    })
    truncated.truncated = true
    backend.queue = [truncated]
    backend.failWhenDrained = true
    const engine = new CuaEngine({ backend, cacheTtlMs: 1000, now: () => 1000 })
    const first = await engine.snapshot({ maxElements: 10_000 })
    const second = await engine.snapshot({ maxElements: 10_000 })
    expect(second).toBe(first)
    expect(backend.snapshotCalls).toBe(1)
  })

  test("re-walks when the cached snapshot cannot cover a larger budget", async () => {
    const backend = new FakeBackend()
    const capped = snapshot("capped", 1, {
      elements: Array.from({ length: 100 }, (_, index) => element(`cua:item-${index}`)),
    })
    capped.truncated = true
    backend.queue = [
      capped,
      snapshot("bigger", 2, {
        elements: Array.from({ length: 200 }, (_, index) => element(`cua:item-${index}`)),
      }),
    ]
    const engine = new CuaEngine({ backend, cacheTtlMs: 1000, now: () => 1000 })
    await engine.snapshot({ maxElements: 100 })
    const second = await engine.snapshot({ maxElements: 10_000 })
    expect(second.id).toBe("bigger")
    expect(backend.snapshotCalls).toBe(2)
  })

  test("prefers a targeted window refresh over a full verification walk", async () => {
    const backend = new FakeBackend()
    const before = snapshot("before", 1, {
      windows: [window("cua:window", { app: "test", focused: true })],
      elements: [element("cua:save", { windowRef: "cua:window", application: "test", actions: ["click"] })],
    })
    const refreshed = snapshot("refreshed", 2, {
      windows: [window("cua:window", { app: "test", focused: true })],
      elements: [
        element("cua:save", { windowRef: "cua:window", application: "test", actions: ["click"] }),
        element("cua:new", { windowRef: "cua:window", application: "test", role: "listitem" }),
      ],
    })
    backend.queue = [before]
    backend.failWhenDrained = true
    backend.refreshedQueue = [refreshed]
    const engine = new CuaEngine({ backend, cacheTtlMs: 0 })
    const result = await engine.execute({ type: "invoke", ref: "cua:save" })
    expect(backend.refreshWindowCalls).toEqual(["cua:window"])
    expect(backend.snapshotCalls).toBe(1)
    expect(result.verified).toBe(true)
    expect(result.stateDelta?.addedRefs).toEqual([scopedRef("cua:new", 2)])
    expect(engine.latestSnapshot()?.id).toBe("refreshed")
  })

  test("reuses a driver-provided observation instead of re-walking", async () => {
    const backend = new FakeBackend()
    const before = snapshot("before", 1, { focusedRef: "a", elements: [element("a")] })
    backend.queue = [before]
    backend.failWhenDrained = true
    backend.result = { observation: snapshot("driver-after", 2, { focusedRef: "b", elements: [element("a")] }) }
    const engine = new CuaEngine({ backend, cacheTtlMs: 0 })
    const result = await engine.execute({ type: "drag", from: { x: 0, y: 0 }, to: { x: 5, y: 5 } })
    expect(backend.snapshotCalls).toBe(1)
    expect(result.verified).toBe(true)
    expect(result.stateDelta?.focusedRef).toBe(scopedRef("b", 2))
    expect(engine.latestSnapshot()?.id).toBe("driver-after")
  })

  test("does not treat an echoed before-state as a fresh observation", async () => {
    const backend = new FakeBackend()
    const before = snapshot("echo-before", 1, { elements: [element("a")] })
    backend.queue = [before, snapshot("echo-after", 2, { elements: [element("a"), element("b")] })]
    backend.result = { observation: before }
    const engine = new CuaEngine({ backend, cacheTtlMs: 0 })
    const result = await engine.execute({ type: "invoke", ref: "a" })
    expect(backend.snapshotCalls).toBe(2)
    expect(result.verified).toBe(true)
    expect(engine.latestSnapshot()?.id).toBe("echo-after")
  })

  test("does not verify observable change without a before-state", async () => {
    const backend = new FakeBackend()
    backend.failWhenDrained = true
    const engine = new CuaEngine({ backend, cacheTtlMs: 0 })
    const result = await engine.execute({ type: "click", point: { x: 1, y: 1 } })
    expect(result.ok).toBe(true)
    expect(result.verified).toBe(false)
    expect(result.warnings?.some((warning) => warning.includes("pre-action snapshot failed"))).toBe(true)
  })
})

describe("cua host driver", () => {
  test("maps element clicks to invoke actions", async () => {
    const { driver, backend } = driverWith()
    const save = await liveRef(driver, "cua:save")
    const result = await driver.execute({ type: "click", target: { kind: "element", elementId: save } })
    expect(result.success).toBe(true)
    expect(backend.executed.at(-1)).toMatchObject({ type: "invoke", ref: save })
  })

  test("maps point clicks and carries the capture id", async () => {
    const { driver, backend } = driverWith()
    await driver.execute({ type: "click", target: { kind: "point", x: 7, y: 9 } })
    expect(backend.executed.at(-1)).toMatchObject({ type: "click", point: { x: 7, y: 9 }, captureId: "obs-1" })
  })

  test("falls back to a pointer click when an element exposes no action", async () => {
    const { driver, backend } = driverWith()
    const plain = await liveRef(driver, "cua:plain")
    await driver.execute({ type: "click", target: { kind: "element", elementId: plain } })
    expect(backend.executed.at(-1)).toMatchObject({ type: "click", point: { x: 20, y: 205 } })
  })

  test("maps editable type to focus plus type without silent set_value", async () => {
    const { driver, backend } = driverWith()
    const field = await liveRef(driver, "cua:field")
    const editable = await driver.execute({
      type: "type",
      target: { kind: "element", elementId: field },
      text: "hello",
    })
    expect(editable.success).toBe(true)
    // NO silent type→set_value: even editable fields use keyboard input after
    // focus. Explicit setvalue still uses the background set_value path. Focus
    // reads a new observation, so the text is aimed at the ref that observation
    // minted rather than the one focus consumed.
    const shapes = backend.executed.slice(-2)
    expect(shapes[0]).toMatchObject({ type: "focus", ref: field })
    expect(shapes[1]).toMatchObject({ type: "type", text: "hello" })

    // An action reads a new observation, so the second act resolves the ref
    // that observation minted instead of reusing the one focus consumed.
    const save = await liveRef(driver, "cua:save")
    const nonEditable = await driver.execute({
      type: "type",
      target: { kind: "element", elementId: save },
      text: "x",
    })
    expect(nonEditable.success).toBe(true)
    const plainShapes = backend.executed.slice(-2)
    expect(plainShapes[0]).toMatchObject({ type: "focus", ref: save })
    expect(plainShapes[1]).toMatchObject({ type: "type", text: "x" })

    const global = await driver.execute({ type: "type", text: "global" })
    expect(global.success).toBe(true)
    expect(backend.executed.at(-1)).toMatchObject({ type: "type", text: "global" })
  })

  test("maps setvalue to set_value", async () => {
    const { driver, backend } = driverWith()
    const field = await liveRef(driver, "cua:field")
    await driver.execute({ type: "setvalue", target: { kind: "element", elementId: field }, value: 42 })
    expect(backend.executed.at(-1)).toMatchObject({ type: "set_value", ref: field, value: "42" })
  })

  test("maps rich accessibility actions to their cua actions", async () => {
    const { driver, backend } = driverWith()
    const cases: readonly [string, (elementId: string) => ComputerAction][] = [
      ["invoke", (elementId) => ({ type: "toggle", target: { kind: "element", elementId } })],
      ["select", (elementId) => ({ type: "select", target: { kind: "element", elementId } })],
      ["expand", (elementId) => ({ type: "expand", target: { kind: "element", elementId } })],
      ["collapse", (elementId) => ({ type: "collapse", target: { kind: "element", elementId } })],
      ["increment", (elementId) => ({ type: "increment", target: { kind: "element", elementId } })],
      ["decrement", (elementId) => ({ type: "decrement", target: { kind: "element", elementId } })],
      ["scroll_into_view", (elementId) => ({ type: "scroll_into_view", target: { kind: "element", elementId } })],
    ]
    for (const [expected, build] of cases) {
      // Each act read a new observation, so the table re-resolves its target
      // and expects the ref that observation minted.
      const save = await liveRef(driver, "cua:save")
      const result = await driver.execute(build(save))
      expect(result.success, `${expected}: ${result.message}`).toBe(true)
      expect(backend.executed.at(-1)).toMatchObject({ type: expected, ref: save })
    }
  })

  test("maps a targetless protocol dismiss to the cua engine", async () => {
    const { driver, backend } = driverWith()
    const result = await driver.execute({ type: "dismiss" })
    expect(result.success).toBe(true)
    expect(backend.executed.at(-1)).toMatchObject({ type: "dismiss" })
  })

  test("maps focus on a window ref to a window action", async () => {
    const { driver, backend } = driverWith()
    const window = await liveRef(driver, "cua:window")
    await driver.execute({ type: "focus", target: { kind: "element", elementId: window } })
    expect(backend.executed.at(-1)).toMatchObject({ type: "window", action: "focus", ref: window })
  })

  test("maps scroll to a semantic scroll with the element ref", async () => {
    const { driver, backend } = driverWith()
    const list = await liveRef(driver, "cua:list")
    await driver.execute({
      type: "scroll",
      target: { kind: "element", elementId: list },
      direction: "down",
      amount: 3,
    })
    expect(backend.executed.at(-1)).toMatchObject({ type: "scroll", direction: "down", amount: 3, ref: list })
  })

  test("reads element text from the snapshot", async () => {
    const { driver } = driverWith()
    const label = await liveRef(driver, "cua:label")
    const result = await driver.execute({ type: "read", target: { kind: "element", elementId: label } })
    expect(result.success).toBe(true)
    expect("text" in result ? result.text : undefined).toBe("Total 42")

    const text = await driver.readText({ elementId: label })
    expect(text.text).toBe("Total 42")
    expect(text.length).toBe(8)
  })

  test("reads a window's subtree text by window ref", async () => {
    const { driver } = driverWith()
    const window = await liveRef(driver, "cua:window")
    const result = await driver.readText({ elementId: window })
    expect(result.success).toBe(true)
    expect(result.text).toContain("Test")
    expect(result.text).toContain("Total 42")
    expect(result.text).toContain("cua:save")
  })

  test("searches find against a larger snapshot budget than observe", async () => {
    const { driver, backend } = driverWith()
    const result = await driver.find({ query: "cua:save" })
    expect(backend.snapshotOptions.at(-1)?.maxElements).toBeGreaterThan(1000)
    // The ref handed to the agent is scoped to the observation that minted it.
    expect(result.matches?.map((match) => refIdentity(match.element.id ?? ""))).toEqual(["cua:save"])
    expect(result.matches?.map((match) => match.element.id)).toEqual([scopedRef("cua:save", 1)])
    expect(result.matches?.[0]?.element.metadata?.application).toBe("test")
  })

  test("carries the application name on element metadata", async () => {
    const { driver } = driverWith()
    const save = await liveRef(driver, "cua:save")
    const observation = await driver.observe()
    const element = (observation.elements ?? []).find((candidate) => candidate.id === save)
    expect(element?.metadata?.application).toBe("test")
    expect(element?.metadata?.app).toBe("test")
  })

  test("revalidates refs against a fresh snapshot", async () => {
    const { driver } = driverWith()
    const valid = await driver.revalidateTarget({ kind: "element", elementId: "cua:save" })
    expect(valid.valid).toBe(true)
    expect(valid.reference?.observationId).toBe("obs-1")

    const missing = await driver.revalidateTarget({ kind: "element", elementId: "cua:missing" })
    expect(missing.valid).toBe(false)
    expect(missing.reason).toContain("cua:missing")
  })

  test("revalidates a window ref that is not duplicated in the element list", async () => {
    const { driver } = driverWith()
    const windowRef = await driver.revalidateTarget({ kind: "element", elementId: "cua:window" })
    expect(windowRef.valid).toBe(true)
    expect(windowRef.reference?.role).toBe("window")
  })

  test("observe returns UI elements keyed by cua refs", async () => {
    const { driver } = driverWith()
    const observation = await driver.observe()
    const ids = (observation.elements ?? []).map((element) => element.id)
    // Every id is scoped to the observation, and its identity is the backend
    // ref an agent recognizes.
    expect(ids.map((id) => refIdentity(id ?? ""))).toContain("cua:save")
    expect(ids.map((id) => refIdentity(id ?? ""))).toContain("cua:window")
    expect(ids).toContain(scopedRef("cua:save", 1))
    const save = (observation.elements ?? []).find((element) => element.id === scopedRef("cua:save", 1))
    expect(save?.reference?.elementId).toBe(scopedRef("cua:save", 1))
    expect(save?.metadata?.editable).toBe(false)
  })

  test("maps wait conditions through waitFor", async () => {
    const { driver, backend } = driverWith()
    await driver.execute({ type: "wait", condition: "ref:cua:field", timeoutMs: 12 })
    expect(backend.waits.at(-1)).toEqual({ ref: "cua:field", timeoutMs: 12 })
  })

  test("reports legacy and cua capability markers", async () => {
    const { driver } = driverWith()
    const support = await driver.capabilitiesAsync()
    const names = support.map((capability) => capability.capability)
    expect(names).toContain("keyboard")
    expect(names).toContain("cua_snapshot")
    expect(names).toContain("cua_refs")
    expect(names).toContain("cua_background")
    expect(names).toContain("cua_rich_actions")
    expect(names).toContain("cua_wait")
    expect(driver.capabilities.some((capability) => capability.capability === "cua_snapshot")).toBe(true)
  })

  test("refuses a stale observationId instead of rebinding", async () => {
    const { driver, engine } = driverWith()
    const first = await driver.observe()
    const firstSnapshot = engine.latestSnapshot()
    if (firstSnapshot === undefined) throw new Error("no observation")
    const save = (first.elements ?? []).find((element) => refIdentity(element.id ?? "") === "cua:save")
    if (save?.reference === undefined) throw new Error("missing reference")

    // The desktop moved on: the current observation minted new refs, so the old
    // string is simply absent rather than aimed at whatever now occupies it.
    const second = await engine.refresh()
    expect(firstSnapshot.generation).toBeLessThan(second.generation)
    const stale = await driver.execute({ type: "click", target: { kind: "element", elementId: save.id ?? "" } })
    expect(stale.success).toBe(false)
    expect(typeof stale.error === "object" ? stale.error.code : undefined).toBe("target_stale")
    expect(stale.message).toContain("cua:save")

    // A ref that is present but paired with another observation's id or
    // generation is refused by the pair check, naming both observations.
    const current = await driver.observe()
    const currentSnapshot = engine.latestSnapshot()
    if (currentSnapshot === undefined) throw new Error("no observation")
    const liveSave = (current.elements ?? []).find((element) => refIdentity(element.id ?? "") === "cua:save")
    const liveList = (current.elements ?? []).find((element) => refIdentity(element.id ?? "") === "cua:list")
    if (liveSave?.reference === undefined || liveList?.reference === undefined) throw new Error("missing reference")

    const mismatched = await driver.execute({
      type: "click",
      target: {
        kind: "element",
        elementId: liveSave.id ?? "",
        reference: { ...liveSave.reference, observationId: firstSnapshot.id },
      },
    })
    expect(mismatched.success).toBe(false)
    expect(typeof mismatched.error === "object" ? mismatched.error.code : undefined).toBe("target_stale")
    expect(mismatched.message).toContain(firstSnapshot.id)
    expect(mismatched.message).toContain(currentSnapshot.id)

    // Scroll resolves element refs through a different path; the advertised
    // generation identity must be enforced there too.
    const staleScroll = await driver.execute({
      type: "scroll",
      target: { kind: "element", elementId: liveList.id ?? "", reference: { ...liveList.reference, generation: 999 } },
      direction: "down",
    })
    expect(staleScroll.success).toBe(false)
    expect(typeof staleScroll.error === "object" ? staleScroll.error.code : undefined).toBe("target_stale")
    expect(staleScroll.message).toContain("999")

    // A current pair is still honoured, so a refusal is about the observation
    // and not about the driver refusing to act.
    const bound = await driver.execute({
      type: "click",
      target: { kind: "element", elementId: liveSave.id ?? "", reference: { ...liveSave.reference } },
    })
    expect(bound.success, bound.message).toBe(true)
    const latest = engine.latestSnapshot()
    if (latest === undefined) throw new Error("no observation")
    expect(second.generation).toBeLessThan(latest.generation)
  })

  test("does not invoke a first action when no backend action matches a click", async () => {
    const { driver, backend } = driverWith()
    // cua:plain exposes no actions, so a click must be pointer input, never an
    // invoke with an empty action (first-action fallback).
    const plain = await liveRef(driver, "cua:plain")
    const result = await driver.execute({ type: "click", target: { kind: "element", elementId: plain } })
    expect(result.success).toBe(true)
    expect(backend.executed.at(-1)).toMatchObject({ type: "click", point: { x: 20, y: 205 } })
    expect(backend.executed.at(-1)).not.toMatchObject({ type: "invoke" })
  })

  test("find and act share one snapshot budget so valid refs resolve", async () => {
    const { driver, backend } = driverWith()
    const found = await driver.find({ query: "cua:save" })
    expect(backend.snapshotOptions.at(-1)?.maxElements).toBe(10000)
    const ref = found.matches?.[0]?.element.id
    if (ref === undefined) throw new Error("find returned no ref")
    const acted = await driver.execute({ type: "focus", target: { kind: "element", elementId: ref } })
    expect(acted.success).toBe(true)
    // The act-path snapshot used the same large budget, so the valid ref was
    // not truncated away.
    expect(backend.snapshotOptions.some((options) => options?.maxElements === 10000)).toBe(true)
  })
})

describe("cua engine concurrency and capture lifecycle", () => {
  test("shares a single in-flight snapshot between concurrent callers", async () => {
    const backend = new FakeBackend()
    backend.queue = [snapshot("single", 1)]
    backend.snapshotDelayMs = 25
    const engine = new CuaEngine({ backend, cacheTtlMs: 0 })
    const [first, second] = await Promise.all([engine.snapshot(), engine.snapshot()])
    expect(first.id).toBe("single")
    expect(second.id).toBe("single")
    expect(backend.snapshotCalls).toBe(1)
  })

  test("serializes concurrent actions so deltas are not misattributed", async () => {
    const backend = new FakeBackend()
    backend.queue = [snapshot("before", 1), snapshot("after", 2)]
    backend.executeDelayMs = 20
    const engine = new CuaEngine({ backend, cacheTtlMs: 0 })
    await Promise.all([
      engine.execute({ type: "invoke", ref: "cua:save" }),
      engine.execute({ type: "invoke", ref: "cua:save" }),
    ])
    expect(backend.maxActiveExecutions).toBe(1)
    expect(backend.executed).toHaveLength(2)
  })

  test("reuses the captured snapshot as the before-state without a stale refusal", async () => {
    const backend = new FakeBackend()
    backend.queue = [snapshot("capture-1", 1), snapshot("after-1", 2)]
    const engine = new CuaEngine({ backend, cacheTtlMs: 0 })
    const capture = await engine.snapshot()
    const result = await engine.execute({ type: "click", point: { x: 1, y: 1 }, captureId: capture.id })
    expect(result.ok).toBe(true)
    expect(backend.beforeSnapshots[0]?.id).toBe("capture-1")
  })

  test("surfaces verification snapshot failures as warnings", async () => {
    const backend = new FakeBackend()
    backend.queue = [snapshot("before", 1)]
    backend.failWhenDrained = true
    const engine = new CuaEngine({ backend, cacheTtlMs: 0 })
    await engine.snapshot()
    const result = await engine.execute({ type: "invoke", ref: "cua:save" })
    expect(result.ok).toBe(true)
    expect(result.warnings?.some((warning) => warning.includes("verification snapshot failed"))).toBe(true)
  })
})

describe("cua fail-closed verification", () => {
  test("focus never verifies from a backend delta with no after-snapshot", async () => {
    const before = snapshot("delta-before", 1, {
      focusedRef: "other",
      elements: [element("field", { role: "textbox", editable: true, focused: false })],
    })
    const { engine } = engineWith([before], {
      generation: 2,
      delta: { focusedRef: "field", changedRefs: ["field"] },
    })
    const result = await engine.execute({ type: "focus", ref: "field" })
    expect(result.ok).toBe(true)
    expect(result.verified).toBe(false)
    expect(result.stateDelta?.focusedRef).toBe("field")
  })

  test("type with a ref verifies only from the target's own value readback", async () => {
    const before = snapshot("type-before", 1, {
      elements: [element("field", { role: "textbox", editable: true, value: "" })],
    })
    const deltaOnly = engineWith([before], { generation: 2, delta: { changedRefs: ["field"] } })
    const unverified = await deltaOnly.engine.execute({ type: "type", ref: "field", text: "hello" })
    expect(unverified.ok).toBe(true)
    expect(unverified.verified).toBe(false)

    const after = snapshot("type-after", 2, {
      elements: [element("field", { role: "textbox", editable: true, value: "hello" })],
    })
    const { engine } = engineWith([before, after])
    const verified = await engine.execute({ type: "type", ref: "field", text: "hello" })
    expect(verified.verified).toBe(true)
  })

  test("refuses a driver observation at the pre-action generation", async () => {
    const backend = new FakeBackend()
    const before = snapshot("same-before", 7, { elements: [element("a")] })
    backend.queue = [before, snapshot("same-after", 8, { elements: [element("a"), element("b")] })]
    // A same-generation echo under a new id is the backend describing its own
    // action, not a post-action read.
    backend.result = { observation: snapshot("echo", 7, { elements: [element("a"), element("b")] }) }
    const engine = new CuaEngine({ backend, cacheTtlMs: 0 })
    const result = await engine.execute({ type: "invoke", ref: "a" })
    expect(backend.snapshotCalls).toBe(2)
    expect(engine.latestSnapshot()?.id).toBe("same-after")
    expect(result.verified).toBe(true)
  })

  test("legacy pointer and window fallbacks state that they are unverified", async () => {
    const backend = new FakeBackend()
    backend.queue = [mainSnapshot()]
    backend.result = { ok: false, message: "no semantic drag" }
    const driver = new CuaHostDriver({
      engine: new CuaEngine({ backend, cacheTtlMs: 0 }),
      legacy: legacyFallbacks({
        movePointer: async () => ({ success: true, status: "success", message: "moved" }),
        dragPointer: async () => ({ success: true, status: "success", message: "dragged" }),
        closeWindowId: async () => ({ success: true, status: "success", message: "closed" }),
        minimizeWindowId: async () => ({ success: true, status: "success", message: "minimized" }),
        restoreWindowId: async () => ({ success: true, status: "success", message: "restored" }),
      }),
    })
    const dragged = await driver.execute({
      type: "drag",
      from: { kind: "point", x: 0, y: 0 },
      to: { kind: "point", x: 5, y: 5 },
    })
    expect(dragged.success).toBe(true)
    expect(dragged.verification?.status).toBe("unverified")
    expect(dragged.verification?.message).toContain("raw pointer input")

    const closed = await driver.execute({
      type: "close",
      target: { kind: "element", elementId: "x11:0x1400003" },
    })
    expect(closed.verification?.status).toBe("unverified")
    expect(closed.verification?.message).toContain("raw X11 path")

    const minimized = await driver.minimizeWindowId("0x1400004")
    expect(minimized.verification?.status).toBe("unverified")
    expect(minimized.verification?.message).toContain("raw X11 path")
  })

  test("copy and paste refuse an unresolved element ref instead of the global path", async () => {
    const backend = new FakeBackend()
    backend.queue = [mainSnapshot()]
    const driver = new CuaHostDriver({
      engine: new CuaEngine({ backend, cacheTtlMs: 0 }),
      legacy: legacyFallbacks({}),
    })
    const missing = await driver.execute({ type: "copy", target: { kind: "element", elementId: "cua:gone" } })
    expect(missing.success).toBe(false)
    expect(missing.error).toMatchObject({ code: "target_stale" })

    const mismatched = await driver.execute({
      type: "paste",
      text: "hello",
      target: {
        kind: "element",
        elementId: "cua:field",
        reference: { kind: "element", elementId: "cua:field", observationId: "obs-other", generation: 99 },
      },
    })
    expect(mismatched.success).toBe(false)
    expect(mismatched.error).toMatchObject({ code: "target_stale" })
  })
})

// The legacy surface is only exercised for the specific fallbacks under test;
// anything else throws so an accidental global input call is loud.
function legacyFallbacks(overrides: Partial<CuaLegacyFallbacks>): CuaLegacyFallbacks {
  const values: Record<string, unknown> = { ...overrides }
  return new Proxy(values, {
    get: (target, key: string) =>
      key in target ? target[key] : () => async () => { throw new Error(`unexpected legacy call: ${key}`) },
  }) as unknown as CuaLegacyFallbacks
}

describe("cua generation-scoped refs", () => {
  test("gives every snapshot its own observation id and generation", async () => {
    const backend = new FakeBackend()
    // The backend reports the same id and the same generation on both walks:
    // an unchanged desktop still has to produce two distinguishable
    // observations, or a ref from the first would bind in the second.
    backend.queue = [snapshot("obs-1", 1, { elements: [element("cua:save")] })]
    const engine = new CuaEngine({ backend, cacheTtlMs: 0 })
    const first = await engine.snapshot()
    const second = await engine.snapshot()
    expect(first.generation).toBe(1)
    expect(second.generation).toBe(first.generation + 1)
    expect(second.id).not.toBe(first.id)
    expect(second.id.length).toBeGreaterThan(0)
  })

  test("keeps one ref per element across every read inside a generation", async () => {
    const backend = new FakeBackend()
    backend.queue = [snapshot("obs-1", 1, { elements: [element("cua:save"), element("cua:field")] })]
    const engine = new CuaEngine({ backend, cacheTtlMs: 1000, now: () => 1000 })
    const full = await engine.snapshot({ maxElements: 10_000 })
    // A smaller budget re-caps the same observation, and a later read reuses
    // it: both must report the ref the observation minted.
    const capped = await engine.snapshot({ maxElements: 1 })
    const reread = await engine.snapshot()
    const save = (full.elements ?? []).find((element) => refIdentity(element.ref) === "cua:save")
    if (save === undefined) throw new Error("missing element")
    expect(save.ref).toBe(scopedRef("cua:save", 1))
    expect(capped.generation).toBe(full.generation)
    expect(capped.elements).toEqual([save])
    expect(reread.elements).toEqual(full.elements)
    expect(reread.elements.map((element) => element.ref)).toEqual(full.elements.map((element) => element.ref))
  })

  test("mints a different ref for the same element in the next generation", async () => {
    const backend = new FakeBackend()
    backend.queue = [snapshot("obs-1", 1, { elements: [element("cua:save")] })]
    const engine = new CuaEngine({ backend, cacheTtlMs: 0 })
    const first = await engine.snapshot()
    const second = await engine.snapshot()
    expect(first.elements[0]?.ref).toBe(scopedRef("cua:save", 1))
    expect(second.elements[0]?.ref).toBe(scopedRef("cua:save", 2))
    // Same element, different generation: the identity survives, the string does
    // not, so a ref from the first observation is meaningless in the second.
    expect(refIdentity(second.elements[0]?.ref ?? "")).toBe("cua:save")
  })

  test("resolves a ref only inside the observation that minted it", async () => {
    const backend = new FakeBackend()
    backend.queue = [
      snapshot("obs-1", 1, {
        windows: [window("cua:window", { focused: true })],
        elements: [element("cua:save"), element("cua:field")],
      }),
      snapshot("obs-2", 2, {
        windows: [window("cua:window", { focused: true })],
        elements: [element("cua:save"), element("cua:field")],
      }),
    ]
    const engine = new CuaEngine({ backend, cacheTtlMs: 0 })
    const first = await engine.snapshot()
    const second = await engine.snapshot()

    const save = first.elements[0]
    if (save === undefined) throw new Error("missing element")
    expect(engine.resolveRef(first.id, save.ref)).toEqual(save)
    expect(engine.resolveRef(first.id, first.windows[0]?.ref ?? "").role).toBe("window")

    // A ref from the newer observation is absent from the older one, and an
    // unknown observation resolves nothing. Both name the observation and the
    // ref, so a caller can re-observe instead of guessing.
    const refusals = [
      captureError(() => engine.resolveRef(first.id, second.elements[0]?.ref ?? "")),
      captureError(() => engine.resolveRef("obs-unknown", save.ref)),
      captureError(() => engine.resolveRef(first.id, "cua:never-minted")),
      captureError(() => engine.resolveRef(first.id, first.windows[0]?.ref ?? "")),
    ]
    expect(refusals.map((error) => error instanceof StaleRefError)).toEqual([true, true, true, false])

    const error = captureError(() => engine.resolveRef(first.id, second.elements[0]?.ref ?? ""))
    expect(error).toBeInstanceOf(StaleRefError)
    if (!(error instanceof StaleRefError)) throw new Error("wrong error type")
    expect(error.observationId).toBe(first.id)
    expect(error.ref).toBe(second.elements[0]?.ref)
    expect(error.reason).toBe("absent_ref")
    expect(error.message).toContain(first.id)
    expect(error.message).toContain(second.elements[0]?.ref ?? "")

    const unknown = captureError(() => engine.resolveRef("obs-unknown", save.ref))
    if (!(unknown instanceof StaleRefError)) throw new Error("wrong error type")
    expect(unknown.reason).toBe("unknown_observation")
    expect(unknown.message).toContain("obs-unknown")
    expect(unknown.message).toContain(save.ref)
  })

  test("refuses an action bound to another generation before the backend sees it", async () => {
    const backend = new FakeBackend()
    backend.queue = [snapshot("obs-1", 1, { elements: [element("cua:save")] }), snapshot("obs-2", 2)]
    const engine = new CuaEngine({ backend, cacheTtlMs: 0 })
    const first = await engine.snapshot()
    const second = await engine.snapshot()

    const stale = await engine.execute({
      type: "invoke",
      ref: scopedRef("cua:save", first.generation),
      observationId: first.id,
      generation: first.generation,
    })
    expect(stale.ok).toBe(false)
    expect(stale.delivery).toBe("refused")
    expect(stale.error?.code).toBe("stale_ref")
    expect(stale.generation).toBe(second.generation)
    expect(stale.message).toContain(first.id)
    expect(stale.message).toContain(second.id)
    expect(backend.executed).toHaveLength(0)

    // A click cannot be answered without a generation match either, even when
    // its capture id is the current observation.
    const refusedClick = await engine.execute({
      type: "click",
      point: { x: 4, y: 4 },
      captureId: second.id,
      observationId: first.id,
      generation: first.generation,
    })
    expect(refusedClick.ok).toBe(false)
    expect(refusedClick.delivery).toBe("refused")
    expect(refusedClick.error?.code).toBe("stale_ref")
    expect(backend.executed).toHaveLength(0)

    // The current pair still reaches the backend, so a refusal is about the
    // generation and not about the engine refusing to act.
    const current = await engine.execute({
      type: "invoke",
      ref: scopedRef("cua:save", second.generation),
      observationId: second.id,
      generation: second.generation,
    })
    expect(current.ok).toBe(true)
    expect(backend.executed).toHaveLength(1)
  })

  test("forwards the observation pair to the remote computer and rejects a mismatch", async () => {
    const { driver, backend, engine } = driverWith()
    const save = await liveRef(driver, "cua:save")
    const current = engine.latestSnapshot()
    if (current === undefined) throw new Error("no observation")
    const acted = await driver.execute({ type: "click", target: { kind: "element", elementId: save } })
    expect(acted.success).toBe(true)
    // The invoke carries the observation pair, so the remote computer can refuse
    // a ref that no longer belongs to the observation it was minted in.
    expect(backend.executed.at(-1)).toMatchObject({
      type: "invoke",
      ref: save,
      observationId: current.id,
      generation: current.generation,
    })

    // A ref that is still present but paired with another observation is
    // refused by the pair check, and the engine never sees the action.
    const live = await liveRef(driver, "cua:save")
    const mismatched = await driver.execute({
      type: "click",
      target: {
        kind: "element",
        elementId: live,
        reference: { kind: "element", elementId: live, observationId: "obs-elsewhere", generation: 99 },
      },
    })
    expect(mismatched.success).toBe(false)
    expect(typeof mismatched.error === "object" ? mismatched.error.code : undefined).toBe("target_stale")
    expect(mismatched.message).toContain("obs-elsewhere")
    expect(mismatched.message).toContain("99")
    expect(backend.executed).toHaveLength(1)
  })

  test("translates a historical ref into the fresh observation on revalidation", async () => {
    const { driver, engine } = driverWith()
    const first = await driver.observe()
    const staleRef = (first.elements ?? []).find((element) => refIdentity(element.id ?? "") === "cua:save")?.id
    if (staleRef === undefined) throw new Error("missing ref")
    await engine.refresh()
    // Revalidation is the explicit rebind: the historical string is matched by
    // identity and the fresh pair is handed back for the next act.
    const revalidated = await driver.revalidateTarget({ kind: "element", elementId: staleRef })
    expect(revalidated.valid).toBe(true)
    expect(revalidated.reference?.elementId).not.toBe(staleRef)
    expect(revalidated.reference?.observationId).toBe(engine.latestSnapshot()?.id)
    expect(revalidated.reference?.generation).toBe(engine.latestSnapshot()?.generation)
    expect(refIdentity(revalidated.reference?.elementId ?? "")).toBe("cua:save")

    const rebound = await driver.execute({
      type: "focus",
      target: { kind: "element", elementId: revalidated.reference?.elementId ?? "" },
    })
    expect(rebound.success, rebound.message).toBe(true)
  })
})

function captureError(run: () => unknown): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  return undefined
}

for (const platform of ["linux", "darwin", "win32"] as const) {
  test(`${platform}: disposal prevents queued actions and late snapshots`, async () => {
    const backend = new FakeBackend()
    backend.snapshotDelayMs = 30
    backend.queue = [snapshot("late", 1)]
    const engine = new CuaEngine({ backend, platform })
    const capture = engine.snapshot()
    const action = engine.execute({ type: "key", keys: ["Enter"] })
    const outcomes = Promise.allSettled([capture, action])
    await engine.dispose()
    expect((await outcomes).every((r) => r.status === "rejected")).toBe(true)
    expect(engine.latestSnapshot()).toBeUndefined()
    expect(backend.executed).toHaveLength(0)
    await engine.dispose()
    expect(backend.disposals).toBe(1)
  })
}

test("refresh does not reuse a capture started before invalidation", async () => {
  const backend = new FakeBackend()
  backend.snapshotDelayMs = 30
  backend.queue = [snapshot("old", 1), snapshot("new", 2)]
  const engine = new CuaEngine({ backend })
  const pending = engine.snapshot()
  const refreshed = engine.refresh()
  const [first, second] = await Promise.all([pending, refreshed])
  expect(backend.snapshotCalls).toBe(2)
  expect(first.id).toBe(second.id)
  expect(engine.latestSnapshot()?.id).toBe(second.id)
})


test("repeated invalidation bounds snapshot and find without caching stale captures", async () => {
  const backend = new FakeBackend()
  const engine = new CuaEngine({ backend })
  let captures = 0
  backend.snapshot = async () => {
    captures++
    engine.invalidate()
    return snapshot("invalidated", captures)
  }
  await expect(engine.snapshot()).rejects.toThrow("repeatedly invalidated")
  expect(captures).toBe(4)
  await expect(engine.find({ name: "Save" })).rejects.toThrow("repeatedly invalidated")
  expect(captures).toBe(8)
  expect(engine.latestSnapshot()).toBeUndefined()
  backend.snapshot = async () => snapshot("stable", 9)
  expect((await engine.snapshot()).id).toBe("stable")
})
