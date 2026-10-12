import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ComputerManager, ExecuteOutcome } from "../server/computers"
import type { Observation, UIElement } from "../protocol"
import type { ServerActionRequest } from "../server/computers"
import { createComputerUseCatalog } from "./models"
import { createProviders } from "./providers"
import { DefaultComputerUseRouter } from "./router"
import { actionRequest, ComputerUseService } from "./service"
import type { ComputerUseModel, ComputerUseProvider, ComputerUseSettings, HardwareReport } from "./types"
import { LocalModelManager } from "./local"
import { detectHardware } from "./hardware"

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "omnia-focus-"))
  dirs.push(dir)
  return dir
}

function settings(overrides: Partial<ComputerUseSettings> = {}): ComputerUseSettings {
  return {
    mode: "automatic",
    allowDownloads: false,
    allowAutoLoad: true,
    allowRemoteScreen: false,
    maxLatencyMs: 120000,
    maxRetries: 1,
    idleUnloadMs: 300000,
    ...overrides,
  }
}

function hardware(): HardwareReport {
  const base = { memory: { total: 8 * 1024 ** 3, available: 8 * 1024 ** 3 }, gpus: [], backends: ["cpu"] }
  return base as unknown as HardwareReport
}

async function localManager(catalog: ComputerUseModel[]): Promise<LocalModelManager> {
  const local = new LocalModelManager({
    catalog,
    modelsDir: tempDir(),
    runtimeDirs: [],
    hardware: await detectHardware({ platform: "linux", arch: "x64", probe: async () => undefined }),
    idleUnloadMs: 0,
  })
  await local.verifyAll()
  return local
}

interface FakeWindow {
  readonly id: string
  readonly title: string
  readonly focused?: boolean
}

function observationWithWindows(windows: readonly FakeWindow[], extra: readonly unknown[] = []): Observation {
  return {
    id: "obs-1",
    elements: [
      ...windows.map((window): UIElement => ({
        id: window.id,
        role: "window",
        name: window.title,
        states: window.focused === true ? ["focused"] : [],
      })),
      ...(extra as readonly UIElement[]),
    ],
  }
}

interface FocusManagerOptions {
  readonly observation?: () => Observation
  readonly onExecute?: (request: ServerActionRequest) => void
}

// A computer whose driver only answers observe/getInfo, so every verdict comes
// from what the post-action observation actually shows.
function focusManager(options: FocusManagerOptions): { manager: ComputerManager; executions: ServerActionRequest[] } {
  const executions: ServerActionRequest[] = []
  const driver = {
    id: "local",
    backend: "atspi",
    getInfo: async () => ({ id: "local", name: "local", platform: "linux", screen: { width: 1920, height: 1080 } }),
    observe: async () => options.observation?.(),
  }
  const computer = { id: "local", driver, connectedAt: 0, lastSeen: 0, grabFrozen: false, grabEvents: 0, stopSeq: 0, stopped: false }
  const manager: ComputerManager = {
    ids: () => ["local"],
    get: () => computer,
    execute: async (_computerId: string, request: ServerActionRequest): Promise<ExecuteOutcome> => {
      executions.push(request)
      options.onExecute?.(request)
      return {
        httpStatus: 200,
        result: {
          success: true,
          status: "success",
          message: "done",
          // A provider-style claim of success that the service must not trust on
          // its own: only the post-action observation can confirm it.
          verification: { status: "verified", verified: true },
        },
      }
    },
  } as unknown as ComputerManager
  return { manager, executions }
}

async function serviceFor(manager: ComputerManager, providers?: ComputerUseProvider[]): Promise<ComputerUseService> {
  const catalog = createComputerUseCatalog()
  const local = await localManager(catalog)
  const list = providers ?? createProviders({ catalog, local, settings: () => settings() })
  const router = new DefaultComputerUseRouter({ providers: list, local, settings: () => settings() })
  return new ComputerUseService({ manager, local, router, providers: list, catalog, settingsFile: join(tempDir(), "computer-use.json") })
}

describe("focus-intent routing (window-management fallback)", () => {
  test("a focus intent without a title still routes, to activate_app", async () => {
    const { manager } = focusManager({
      observation: () => observationWithWindows([{ id: "win-1", title: "kitty", focused: true }]),
    })
    const service = await serviceFor(manager)
    const analysis = await service.analyze({ computerId: "local", operation: "click", targetDescription: "focus the kitty terminal" })
    expect(analysis.result.success).toBe(true)
    expect(analysis.result.action?.type).toBe("activate_app")
    expect(analysis.result.action?.window).toBe("kitty")
    // Routing to an application is not a click, and never a center-click.
    expect(analysis.result.action?.target?.x).toBeUndefined()
    expect(actionRequest(analysis.result.action!)).toEqual({ action: "activate_app", app: "kitty" })
    // No provider was asked to ground this intent.
    expect(analysis.result.provider).toBe("semantic")
    expect(analysis.result.confidence).toBeLessThan(1)
  })

  test("a quoted title emits focus_window with the quoted string first", async () => {
    const { manager, executions } = focusManager({})
    const service = await serviceFor(manager)
    const analysis = await service.analyze({ computerId: "local", operation: "click", targetDescription: 'focus the "OC | Quick hello" window' })
    expect(analysis.result.action?.type).toBe("focus_window")
    expect(analysis.result.action?.window).toBe("OC | Quick hello")
    // The full quoted title is the first thing the chain tries, before any
    // pipe-separated fragment.
    expect(analysis.result.evidence?.[0]).toBe("focus_window title: OC | Quick hello")
    expect(actionRequest(analysis.result.action!)).toEqual({ action: "focus_window", window: "OC | Quick hello" })
    expect(executions).toHaveLength(0)
  })

  test("a titled focus intent that resolves to nothing fails loudly instead of clicking", async () => {
    const { manager, executions } = focusManager({
      observation: () => observationWithWindows([{ id: "win-1", title: "Unrelated", focused: true }]),
    })
    const service = await serviceFor(manager)
    const analysis = await service.analyze({
      computerId: "local",
      operation: "click",
      targetDescription: 'focus the window titled "Zz | Missing"',
      taskContext: 'focus the "Zz | Missing" window',
    })
    expect(analysis.result.success).toBe(false)
    expect(analysis.errorCode).toBe("window_not_found")
    expect(analysis.result.errorCode).toBe("window_not_found")
    expect(analysis.result.action).toBeUndefined()
    expect(executions).toHaveLength(0)
  })
})

describe("honest verification of focus results", () => {
  const target = 'focus the "OC | Quick hello" window'

  test("an unconfirmed focus is not_verified with expected and observed", async () => {
    // The provider and the execution both claim verified: the active window is
    // some other window, so the claim must not survive.
    const { manager, executions } = focusManager({
      observation: () => observationWithWindows([{ id: "win-1", title: "OC | Other window", focused: true }]),
    })
    const service = await serviceFor(manager)
    const outcome = await service.perform({ computerId: "local", operation: "click", targetDescription: target, execute: true })
    expect(executions).toHaveLength(1)
    expect(outcome.execution?.verified).toBe(false)
    expect(outcome.analysis.result.metadata?.verified).toBe(false)
    const confirmation = outcome.execution?.confirmation
    expect(confirmation?.status).toBe("not_verified")
    expect(confirmation?.method).toBe("active-window")
    expect(confirmation?.expected?.title).toBe("OC | Quick hello")
    expect(confirmation?.observed?.title).toBe("OC | Other window")
    expect(outcome.analysis.result.metadata?.confirmation).toEqual({
      status: "not_verified",
      method: "active-window",
      expected: { title: "OC | Quick hello", windowId: "win-1" },
      observed: { windowId: "win-1", title: "OC | Other window" },
    })
  })

  test("a focus with no post-action observation is not_verified, never verified", async () => {
    // No observation at all: absence is not proof that the window took focus.
    const { manager, executions } = focusManager({})
    const service = await serviceFor(manager)
    const outcome = await service.perform({ computerId: "local", operation: "click", targetDescription: target, execute: true })
    expect(executions).toHaveLength(1)
    expect(outcome.execution?.verified).toBe(false)
    const confirmation = outcome.execution?.confirmation
    expect(confirmation?.status).toBe("not_verified")
    expect(confirmation?.reason).toBe("no_post_observation")
    expect(confirmation?.expected?.title).toBe("OC | Quick hello")
    expect(confirmation?.observed).toBeUndefined()
  })

  test("a focus confirmed by the active window title is verified", async () => {
    const { manager } = focusManager({
      observation: () => observationWithWindows([{ id: "win-1", title: "kitty — OC | Quick hello", focused: true }]),
    })
    const service = await serviceFor(manager)
    const outcome = await service.perform({ computerId: "local", operation: "click", targetDescription: target, execute: true })
    expect(outcome.execution?.verified).toBe(true)
    expect(outcome.analysis.result.metadata?.verified).toBe(true)
    const confirmation = outcome.execution?.confirmation
    expect(confirmation?.status).toBe("verified")
    expect(confirmation?.expected?.title).toBe("OC | Quick hello")
    expect(confirmation?.observed?.title).toBe("kitty — OC | Quick hello")
    expect(confirmation?.reason).toBeUndefined()
  })

  test("activate_app is confirmed by the resolved window, not by a flag", async () => {
    const { manager } = focusManager({
      observation: () => observationWithWindows([{ id: "win-7", title: "kitty", focused: true }]),
    })
    const service = await serviceFor(manager)
    const outcome = await service.perform({
      computerId: "local",
      operation: "click",
      targetDescription: "focus the kitty terminal",
      execute: true,
    })
    expect(outcome.analysis.result.action?.type).toBe("activate_app")
    expect(outcome.execution?.verified).toBe(true)
    expect(outcome.execution?.confirmation?.method).toBe("active-window")
    expect(outcome.execution?.confirmation?.observed?.windowId).toBe("win-7")
  })
})

describe("honest verification of ref clicks", () => {
  function exportObservation(focused: boolean): Observation {
    return observationWithWindows([{ id: "win-1", title: "Editor", focused: true }], [
      {
        id: "atspi:3.5",
        role: "button",
        name: "Export",
        bounds: { x: 10, y: 10, width: 100, height: 30 },
        states: focused ? ["focused", "enabled"] : ["enabled"],
        source: "accessibility",
      },
    ])
  }

  test("a ref click that changes the element's state is verified", async () => {
    let focused = false
    const { manager, executions } = focusManager({
      observation: () => exportObservation(focused),
      onExecute: () => {
        focused = true
      },
    })
    const service = await serviceFor(manager)
    const outcome = await service.perform({
      computerId: "local",
      operation: "click",
      targetDescription: "Export",
      execute: true,
    })
    expect(executions[0]?.action).toBe("click")
    expect(executions[0]?.target).toEqual({ kind: "element", elementId: "atspi:3.5" })
    expect(outcome.execution?.verified).toBe(true)
    const confirmation = outcome.execution?.confirmation
    expect(confirmation?.status).toBe("verified")
    expect(confirmation?.method).toBe("element-state-change")
    expect(confirmation?.expected?.ref).toBe("atspi:3.5")
    expect(confirmation?.observed?.states).toEqual(["focused", "enabled"])
  })

  test("a ref click with no observable state change is not_verified", async () => {
    const { manager } = focusManager({ observation: () => exportObservation(false) })
    const service = await serviceFor(manager)
    const outcome = await service.perform({ computerId: "local", operation: "click", targetDescription: "Export", execute: true })
    expect(outcome.execution?.verified).toBe(false)
    expect(outcome.analysis.result.metadata?.verified).toBe(false)
    const confirmation = outcome.execution?.confirmation
    expect(confirmation?.status).toBe("not_verified")
    expect(confirmation?.method).toBe("element-state-change")
    expect(confirmation?.reason).toBe("no_state_change_for_ref")
  })

  test("a ref click the observation can no longer be taken for is not_verified", async () => {
    let reads = 0
    const { manager } = focusManager({
      observation: () => {
        reads += 1
        // Analysis and the pre-action read resolve; the post-action read fails.
        if (reads > 2) throw new Error("observe unavailable")
        return exportObservation(false)
      },
    })
    const service = await serviceFor(manager)
    const outcome = await service.perform({ computerId: "local", operation: "click", targetDescription: "Export", execute: true })
    expect(outcome.execution?.verified).toBe(false)
    expect(outcome.execution?.confirmation?.reason).toBe("no_post_observation")
    expect(outcome.execution?.confirmation?.expected?.ref).toBe("atspi:3.5")
    expect(outcome.execution?.confirmation?.observed).toBeUndefined()
  })
})
