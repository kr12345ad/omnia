import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CuaAction, CuaBackend, CuaCapabilities, CuaElement } from "../cua/types"
import type { ComputerManager, ServerActionRequest, ServerComputerDriver } from "../server/computers"
import { startOmniaServer } from "../server/server"
import { sessionProof } from "../server/api"
import type { Observation } from "../protocol"
import { LocalModelManager } from "./local"
import { SemanticProvider } from "./providers"
import { bestScore, DefaultComputerUseRouter } from "./router"
import { ComputerUseService, cuaDriverFor } from "./service"
import type {
  ComputerUseCapabilities,
  ComputerUseContext,
  ComputerUseOperation,
  ComputerUseProvider,
  ComputerUseSettings,
  HardwareReport,
  SemanticEnvironment,
  SemanticElement,
} from "./types"

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "omnia-cua-"))
  dirs.push(dir)
  return dir
}

function hardware(): HardwareReport {
  return {
    os: "linux",
    platform: "linux",
    arch: "x64",
    cpuCores: 8,
    memoryTotalBytes: 32 * 1024 ** 3,
    memoryFreeBytes: 24 * 1024 ** 3,
    unifiedMemory: false,
    gpus: [],
    diskFreeBytes: 100 * 1024 ** 3,
    backends: ["cpu"],
  }
}

function settings(overrides: Partial<ComputerUseSettings> = {}): ComputerUseSettings {
  return {
    mode: "automatic",
    allowDownloads: false,
    allowAutoLoad: true,
    allowRemoteScreen: false,
    maxLatencyMs: 120000,
    maxRetries: 1,
    idleUnloadMs: 0,
    ...overrides,
  }
}

function context(overrides: Partial<ComputerUseContext> = {}): ComputerUseContext {
  return {
    computerId: "local",
    requestedOperation: "click",
    platform: "linux",
    ...overrides,
  }
}

function localManager(): LocalModelManager {
  return new LocalModelManager({
    catalog: [],
    modelsDir: tempDir(),
    runtimeDirs: [],
    hardware: hardware(),
    idleUnloadMs: 0,
  })
}

function cuaCapabilities(overrides: Partial<CuaCapabilities> = {}): CuaCapabilities {
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
    actions: [
      "invoke",
      "set_value",
      "focus",
      "scroll_into_view",
      "select",
      "expand",
      "collapse",
      "increment",
      "decrement",
      "show_menu",
      "click",
      "type",
      "key",
      "scroll",
      "drag",
      "window",
    ],
    limits: [],
    ...overrides,
  }
}

const exportElement: SemanticElement = {
  elementId: "atspi:3.5",
  role: "button",
  name: "Export",
  bounds: { x: 10, y: 10, width: 100, height: 30 },
  source: "accessibility",
}

function environment(elements: readonly SemanticElement[], coverage = 0.8): SemanticEnvironment {
  return { coverage, elements }
}

function visionCapabilities(): ComputerUseCapabilities {
  return {
    visualGrounding: true,
    click: true,
    doubleClick: true,
    rightClick: true,
    type: true,
    scroll: true,
    drag: true,
    resize: true,
    keyboardShortcuts: true,
    local: false,
    supportedBackends: ["remote"],
  }
}

function fakeVision(onCall: () => void): ComputerUseProvider {
  return {
    id: "vision-fake",
    name: "Vision fake",
    getCapabilities: async () => visionCapabilities(),
    isAvailable: async () => {
      onCall()
      return true
    },
    estimateCost: async () => ({ usd: 0.01 }),
    estimateLatency: async () => ({ expectedMs: 10 }),
    analyze: async () => {
      onCall()
      return { success: true, provider: "vision-fake", confidence: 0.9, latencyMs: 1 }
    },
  }
}

function observation(): Observation {
  return {
    id: "obs-1",
    backend: "atspi",
    elements: [
      {
        id: "atspi:3.5",
        role: "button",
        name: "Export",
        bounds: { x: 10, y: 10, width: 100, height: 30 },
        states: ["focused"],
        source: "accessibility",
      },
    ],
    metadata: { windowTitle: "Test window" },
  }
}

interface FakeManagerOptions {
  readonly result?: Record<string, unknown>
  readonly onWait?: () => void
  readonly onExecute?: (request: ServerActionRequest) => void
}

function fakeManager(options: FakeManagerOptions = {}): ComputerManager {
  const driver = {
    id: "local",
    backend: "atspi",
    getInfo: async () => ({ id: "local", name: "local", platform: "linux" }),
    capabilities: () => [
      { capability: "cua_snapshot", status: "available" },
      { capability: "cua_refs", status: "available" },
      { capability: "cua_background", status: "available" },
      { capability: "cua_rich_actions", status: "available" },
      { capability: "cua_wait", status: "available" },
    ],
    observe: async () => observation(),
    find: async () => ({ matches: [] }),
    execute: async () => ({ success: true, status: "success", message: "ok" }),
    ...(options.onWait === undefined
      ? {}
      : {
          cuaWait: async () => {
            options.onWait!()
            return { ok: true, waitedMs: 5 }
          },
        }),
  }
  const computer = {
    id: "local",
    driver,
    connectedAt: 0,
    lastSeen: 0,
    grabFrozen: false,
    grabEvents: 0,
    stopSeq: 0,
    stopped: false,
  }
  return {
    ids: () => ["local"],
    get: () => computer,
    execute: async (_computerId: string, request: ServerActionRequest) => {
      options.onExecute?.(request)
      return {
        httpStatus: 200,
        result: {
          success: true,
          status: "success",
          message: "clicked",
          verification: { status: "unverified", verified: false },
          metadata: {
            delivery: "background-ax",
            stateDelta: { focusedRef: "atspi:3.5", changedRefs: ["atspi:3.5"], hasChanges: true, summary: "focus moved" },
          },
          ...options.result,
        },
      }
    },
  } as unknown as ComputerManager
}

function serviceWith(options: { providers: ComputerUseProvider[]; manager?: ComputerManager }): ComputerUseService {
  const local = localManager()
  const router = new DefaultComputerUseRouter({ providers: options.providers, local, settings: () => settings() })
  return new ComputerUseService({
    manager: options.manager ?? fakeManager(),
    local,
    router,
    providers: options.providers,
    catalog: [],
  })
}

function cuaElement(): CuaElement {
  return {
    ref: "atspi:1",
    backendRef: "atspi:1",
    role: "button",
    name: "Export",
    bounds: { x: 10, y: 10, width: 100, height: 30 },
    enabled: true,
    focused: false,
    editable: false,
    actions: ["invoke"],
    states: ["enabled"],
    generation: 1,
  }
}

function cuaServerDriver(): { driver: ServerComputerDriver; executed: CuaAction[] } {
  const executed: CuaAction[] = []
  const backend: CuaBackend = {
    platform: "linux",
    name: "cua-test",
    available: async () => true,
    capabilities: async () => cuaCapabilities(),
    snapshot: async () => ({
      id: "snap-1",
      generation: 1,
      takenAt: 0,
      platform: "linux",
      windows: [],
      elements: [cuaElement()],
      truncated: false,
      warnings: [],
    }),
    find: async () => [cuaElement()],
    execute: async (action) => {
      executed.push(action)
      return { ok: true, action, verified: true, message: "done", delivery: "background-ax", generation: 1 }
    },
    waitFor: async () => ({ ok: true, waitedMs: 3, element: cuaElement() }),
    dispose: async () => undefined,
  }
  const driver = {
    id: "cua-computer",
    backend: "atspi",
    getInfo: async () => ({ id: "cua-computer", name: "Cua", platform: "linux" }),
    capabilities: () => [
      { capability: "cua_snapshot", status: "available" },
      { capability: "cua_refs", status: "available" },
      { capability: "cua_background", status: "available" },
      { capability: "cua_rich_actions", status: "available" },
      { capability: "cua_wait", status: "available" },
    ],
    observe: async () => ({ id: "obs", elements: [] }),
    find: async () => ({ matches: [] }),
    execute: async () => ({ success: true, status: "success", message: "ok" }),
    cua: backend,
  } as unknown as ServerComputerDriver
  return { driver, executed }
}

function plainServerDriver(): ServerComputerDriver {
  return {
    id: "plain-computer",
    backend: "atspi",
    getInfo: async () => ({ id: "plain-computer", name: "Plain", platform: "linux" }),
    capabilities: () => [],
    observe: async () => ({ id: "obs", elements: [] }),
    find: async () => ({ matches: [] }),
    execute: async () => ({ success: true, status: "success", message: "ok" }),
  } as unknown as ServerComputerDriver
}

describe("cua driver adapter", () => {
  test("adapts an engine-shaped backend exposed as `engine`", async () => {
    const driver = {
      engine: {
        backendName: "cua-test",
        available: async () => true,
        capabilities: async () => cuaCapabilities(),
        snapshot: async () => ({
          id: "snap-1",
          generation: 1,
          takenAt: 0,
          platform: "linux",
          windows: [],
          elements: [cuaElement()],
          truncated: false,
          warnings: [],
        }),
        find: async () => [cuaElement()],
        execute: async (action: CuaAction) => ({
          ok: true,
          action,
          verified: true,
          message: "done",
          delivery: "background-ax",
          generation: 1,
        }),
        waitFor: async () => ({ ok: true, waitedMs: 1, element: cuaElement() }),
      },
    }
    const adapter = await cuaDriverFor(driver)
    expect(adapter?.backend).toBe("cua-test")
    expect(adapter?.available).toBe(true)
    expect(adapter?.snapshot).toBeDefined()
    expect(adapter?.find).toBeDefined()
    expect(adapter?.act).toBeDefined()
    expect(adapter?.wait).toBeDefined()
  })
})

describe("cua semantic provider capabilities", () => {
  test("reports drag:false and a cua backend when refs are available", async () => {
    const provider = new SemanticProvider({ cua: () => cuaCapabilities() })
    const capabilities = await provider.getCapabilities()
    expect(capabilities.drag).toBe(false)
    expect(capabilities.resize).toBe(false)
    expect(capabilities.supportedBackends).toContain("cua")
    expect(provider.cuaCapabilities()?.refs).toBe(true)
  })

  test("stays on the native backend without cua capabilities", async () => {
    const provider = new SemanticProvider()
    const capabilities = await provider.getCapabilities()
    expect(capabilities.supportedBackends).toEqual(["native"])
    expect(provider.cuaCapabilities()).toBeUndefined()
  })
})

describe("cua accessibility-first routing", () => {
  test("with zero local models and cua capabilities, ground/click/type/scroll/inspect route semantic", async () => {
    const providers = [new SemanticProvider({ cua: () => cuaCapabilities() })]
    const router = new DefaultComputerUseRouter({ providers, local: localManager(), settings: () => settings() })
    const operations: ComputerUseOperation[] = ["ground", "click", "type", "scroll", "inspect"]
    for (const operation of operations) {
      const decision = await router.route(
        context({ requestedOperation: operation, targetDescription: "Export", semanticContext: environment([exportElement]) }),
      )
      expect(decision.provider).toBe("semantic")
      expect(decision.provider).not.toBe("none")
      expect(decision.reason.join(" ")).toContain("cua")
    }
  })

  test("an explicit element ref match is sufficient at score 1.0", async () => {
    const providers = [new SemanticProvider({ cua: () => cuaCapabilities() })]
    const router = new DefaultComputerUseRouter({ providers, local: localManager(), settings: () => settings() })
    const decision = await router.route(
      context({
        requestedOperation: "click",
        targetDescription: "atspi:3.5",
        semanticContext: environment([{ ...exportElement, name: "Something else" }], 0.1),
      }),
    )
    expect(decision.provider).toBe("semantic")
    expect(bestScore([{ elementId: "atspi:3.5", name: "Something else" }], "atspi:3.5")).toBe(1)
  })

  test("vision providers are never attempted for accessible targets", async () => {
    let visionCalls = 0
    const providers = [new SemanticProvider({ cua: () => cuaCapabilities() }), fakeVision(() => (visionCalls += 1))]
    const router = new DefaultComputerUseRouter({ providers, local: localManager(), settings: () => settings({ allowRemoteScreen: true }) })
    const decision = await router.route(
      context({ requestedOperation: "click", targetDescription: "Export", semanticContext: environment([exportElement]) }),
    )
    expect(decision.provider).toBe("semantic")
    expect(visionCalls).toBe(0)
  })

  test("a canvas target with no semantic match still falls back to vision", async () => {
    let visionCalls = 0
    const providers = [new SemanticProvider({ cua: () => cuaCapabilities() }), fakeVision(() => (visionCalls += 1))]
    const router = new DefaultComputerUseRouter({ providers, local: localManager(), settings: () => settings({ allowRemoteScreen: true }) })
    const canvas: SemanticElement = {
      role: "canvas",
      name: "Drawing canvas",
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      source: "vision",
    }
    const decision = await router.route(
      context({ requestedOperation: "ground", targetDescription: "the blue paint bucket", semanticContext: environment([canvas], 0.1) }),
    )
    expect(decision.provider).toBe("vision-fake")
    expect(visionCalls).toBeGreaterThan(0)
  })

  test("title-bar ban still deflects to none instead of a cua center-click", async () => {
    const providers = [new SemanticProvider({ cua: () => cuaCapabilities() })]
    const router = new DefaultComputerUseRouter({ providers, local: localManager(), settings: () => settings() })
    const decision = await router.route(context({ requestedOperation: "click", targetDescription: "minimize the Omnia window" }))
    expect(decision.provider).toBe("none")
    expect(decision.reason.join(" ")).toContain("title-bar")
  })
})

describe("cua service path", () => {
  test("analysis resolves click/ground/type/scroll/inspect through semantic with no models installed", async () => {
    const service = serviceWith({ providers: [new SemanticProvider()] })
    const click = await service.analyze({ computerId: "local", operation: "click", targetDescription: "Export" })
    expect(click.result.provider).toBe("semantic")
    expect(click.result.success).toBe(true)
    expect(click.result.action?.type).toBe("click")

    const ground = await service.analyze({ computerId: "local", operation: "ground", targetDescription: "Export" })
    expect(ground.result.provider).toBe("semantic")
    expect(ground.result.success).toBe(true)

    const type = await service.analyze({ computerId: "local", operation: "type", targetDescription: "Export", text: "hello" })
    expect(type.result.provider).toBe("semantic")
    expect(type.result.success).toBe(true)

    const scroll = await service.analyze({ computerId: "local", operation: "scroll", targetDescription: "Export" })
    expect(scroll.result.provider).toBe("semantic")
    expect(scroll.result.success).toBe(true)

    const inspect = await service.analyze({ computerId: "local", operation: "inspect", targetDescription: "Export" })
    expect(inspect.result.provider).toBe("semantic")
    expect(inspect.result.success).toBe(true)
    expect(inspect.result.metadata?.elementId).toBe("atspi:3.5")
  })

  test("with cua capabilities and zero installed models every operation executes through the driver without vision", async () => {
    let visionCalls = 0
    const requests: ServerActionRequest[] = []
    const service = serviceWith({
      providers: [new SemanticProvider(), fakeVision(() => (visionCalls += 1))],
      manager: fakeManager({ onExecute: (request) => requests.push(request) }),
    })
    expect(await service.models()).toHaveLength(0)

    const operations: Array<{ operation: ComputerUseOperation; text?: string }> = [
      { operation: "ground" },
      { operation: "click" },
      { operation: "type", text: "hello" },
      { operation: "scroll" },
      { operation: "inspect" },
    ]
    for (const entry of operations) {
      const outcome = await service.perform({
        computerId: "local",
        operation: entry.operation,
        targetDescription: "Export",
        execute: true,
        ...(entry.text === undefined ? {} : { text: entry.text }),
      })
      expect(outcome.analysis.decision.provider).not.toBe("none")
      expect(outcome.analysis.result.provider).toBe("semantic")
      expect(outcome.analysis.result.success).toBe(true)
    }

    expect(visionCalls).toBe(0)
    expect(requests.map((request) => request.action)).toEqual(["click", "click", "type", "scroll"])
    expect(requests.every((request) => request.target?.elementId === "atspi:3.5")).toBe(true)
  })

  test("vision is not attempted for accessible targets at the service layer", async () => {
    let visionCalls = 0
    const service = serviceWith({
      providers: [new SemanticProvider(), fakeVision(() => (visionCalls += 1))],
    })
    const analysis = await service.analyze({ computerId: "local", operation: "click", targetDescription: "Export" })
    expect(analysis.result.provider).toBe("semantic")
    expect(visionCalls).toBe(0)
  })

  test("surfaces delivery, verified, and stateDelta and prefers cua wait_for", async () => {
    let waits = 0
    const service = serviceWith({
      providers: [new SemanticProvider()],
      manager: fakeManager({ onWait: () => (waits += 1) }),
    })
    const outcome = await service.perform({ computerId: "local", operation: "click", targetDescription: "Export", execute: true })
    expect(outcome.analysis.result.provider).toBe("semantic")
    expect(outcome.analysis.result.metadata?.delivery).toBe("background-ax")
    expect(outcome.analysis.result.metadata?.verified).toBe(false)
    expect(outcome.analysis.result.metadata?.waitedMs).toBe(5)
    expect(outcome.analysis.result.metadata?.stateDelta).toEqual({
      focusedRef: "atspi:3.5",
      changedRefs: ["atspi:3.5"],
      hasChanges: true,
      summary: "focus moved",
    })
    expect(waits).toBe(1)
    expect(outcome.execution?.verified).toBe(false)
  })

  test("title-bar ban still returns the keyboard fallback with cua active", async () => {
    const service = serviceWith({ providers: [new SemanticProvider()] })
    const analysis = await service.analyze({ computerId: "local", operation: "click", targetDescription: "minimize the Omnia window" })
    expect(analysis.result.success).toBe(true)
    expect(analysis.result.action).toEqual({ type: "key", key: "Super+Down" })
  })
})

describe("cua server api", () => {
  test("snapshot/find/act/wait go through the driver cua backend with the action gate", async () => {
    const { driver, executed } = cuaServerDriver()
    const server = await startOmniaServer({ token: "cua-token", drivers: [driver] })
    const headers = { authorization: "Bearer cua-token", "content-type": "application/json" }
    const boundHeaders = { ...headers, "x-omnia-session-proof": sessionProof("cua-token", "session-1") }
    try {
      const unauthorized = await fetch(`${server.url}/v1/computers/cua-computer/cua/snapshot`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
      expect(unauthorized.status).toBe(401)

      const snapshot = (await fetch(`${server.url}/v1/computers/cua-computer/cua/snapshot`, {
        method: "POST",
        headers,
        body: JSON.stringify({ app: "Files", maxElements: 10 }),
      }).then((response) => response.json())) as { ok: boolean; snapshot: { id: string; elements: CuaElement[] } }
      expect(snapshot.ok).toBe(true)
      expect(snapshot.snapshot.id).toBe("snap-1")
      expect(snapshot.snapshot.elements[0]?.ref).toBe("atspi:1")

      const found = (await fetch(`${server.url}/v1/computers/cua-computer/cua/find`, {
        method: "POST",
        headers,
        body: JSON.stringify({ query: "Export" }),
      }).then((response) => response.json())) as { ok: boolean; elements: CuaElement[] }
      expect(found.ok).toBe(true)
      expect(found.elements[0]?.ref).toBe("atspi:1")

      const denied = await fetch(`${server.url}/v1/computers/cua-computer/cua/act`, {
        method: "POST",
        headers: boundHeaders,
        body: JSON.stringify({ action: { type: "invoke", ref: "atspi:1" }, sessionId: "session-1" }),
      })
      expect(denied.status).toBe(428)

      const acted = (await fetch(`${server.url}/v1/computers/cua-computer/cua/act`, {
        method: "POST",
        headers: boundHeaders,
        body: JSON.stringify({
          action: { type: "invoke", ref: "atspi:1" },
          sessionId: "session-1",
          approve: true,
          approvedBy: "test",
          approvedScopes: ["UI_CONTROL"],
        }),
      }).then((response) => response.json())) as { ok: boolean; result: { ok: boolean; delivery: string } }
      expect(acted.ok).toBe(true)
      expect(acted.result.delivery).toBe("background-ax")
      expect(executed).toEqual([{ type: "invoke", ref: "atspi:1" }])

      const waited = (await fetch(`${server.url}/v1/computers/cua-computer/cua/wait`, {
        method: "POST",
        headers,
        body: JSON.stringify({ condition: { ref: "atspi:1", timeoutMs: 100 } }),
      }).then((response) => response.json())) as { ok: boolean; result: { waitedMs: number } }
      expect(waited.ok).toBe(true)
      expect(waited.result.waitedMs).toBe(3)
    } finally {
      await server.stop()
    }
  })

  test("returns 501 cua_unavailable when the driver exposes no cua methods", async () => {
    const server = await startOmniaServer({ token: "cua-token", drivers: [plainServerDriver()] })
    try {
      const response = await fetch(`${server.url}/v1/computers/plain-computer/cua/snapshot`, {
        method: "POST",
        headers: { authorization: "Bearer cua-token", "content-type": "application/json" },
        body: "{}",
      })
      expect(response.status).toBe(501)
      const body = (await response.json()) as { ok: boolean; error: { code: string } }
      expect(body.ok).toBe(false)
      expect(body.error.code).toBe("cua_unavailable")
    } finally {
      await server.stop()
    }
  })
})
describe("cua routing fall-through", () => {
  test("cua with zero accessible elements falls through to vision", async () => {
    let visionCalls = 0
    const providers = [new SemanticProvider({ cua: () => cuaCapabilities() }), fakeVision(() => (visionCalls += 1))]
    const router = new DefaultComputerUseRouter({ providers, local: localManager(), settings: () => settings({ allowRemoteScreen: true }) })
    const decision = await router.route(
      context({ requestedOperation: "click", targetDescription: "Export", semanticContext: environment([], 0) }),
    )
    expect(decision.provider).toBe("vision-fake")
    expect(visionCalls).toBeGreaterThan(0)
  })

  test("a cua backend without refs/semantic actions falls through to vision", async () => {
    let visionCalls = 0
    const providers = [
      new SemanticProvider({ cua: () => cuaCapabilities({ refs: false, semanticActions: false }) }),
      fakeVision(() => (visionCalls += 1)),
    ]
    const router = new DefaultComputerUseRouter({ providers, local: localManager(), settings: () => settings({ allowRemoteScreen: true }) })
    const decision = await router.route(
      context({ requestedOperation: "click", targetDescription: "the blue paint bucket", semanticContext: environment([exportElement], 0.2) }),
    )
    expect(decision.provider).toBe("vision-fake")
    expect(visionCalls).toBeGreaterThan(0)
  })

  test("a cua target that semantic cannot resolve falls through to vision", async () => {
    let visionCalls = 0
    const providers = [new SemanticProvider({ cua: () => cuaCapabilities() }), fakeVision(() => (visionCalls += 1))]
    const router = new DefaultComputerUseRouter({ providers, local: localManager(), settings: () => settings({ allowRemoteScreen: true }) })
    const decision = await router.route(
      context({ requestedOperation: "click", targetDescription: "the blue paint bucket", semanticContext: environment([exportElement], 0.8) }),
    )
    expect(decision.provider).toBe("vision-fake")
    expect(visionCalls).toBeGreaterThan(0)
  })
})

describe("cua service execution outcome", () => {
  test("a denied execution is not reported as ok", async () => {
    const manager = fakeManager({
      result: { success: false, status: "rejected", message: "denied", error: { code: "permission_denied", message: "denied" } },
    })
    const service = serviceWith({ providers: [new SemanticProvider()], manager })
    const outcome = await service.perform({
      computerId: "local",
      operation: "click",
      targetDescription: "Export",
      execute: true,
      sessionId: "session-1",
    })
    expect(outcome.analysis.result.success).toBe(false)
    expect(outcome.analysis.result.errorCode).toBe("permission_denied")
    expect(outcome.execution?.outcome.result.success).toBe(false)
  })

  test("a failed execution is not reported as ok", async () => {
    const manager = fakeManager({ result: { success: false, status: "failed", message: "backend failed" } })
    const service = serviceWith({ providers: [new SemanticProvider()], manager })
    const outcome = await service.perform({ computerId: "local", operation: "click", targetDescription: "Export", execute: true })
    expect(outcome.analysis.result.success).toBe(false)
    expect(outcome.analysis.result.errorCode).toBe("execution_failed")
  })
})

describe("computer-use analyze api execution outcome", () => {
  test("analyze returns ok:false when the execution is denied", async () => {
    const driver = {
      id: "plain-computer",
      backend: "atspi",
      getInfo: async () => ({ id: "plain-computer", name: "Plain", platform: "linux" }),
      capabilities: () => [],
      observe: async () => ({
        id: "obs",
        elements: [
          {
            id: "atspi:9",
            role: "button",
            name: "Export",
            bounds: { x: 10, y: 10, width: 100, height: 30 },
            source: "accessibility",
          },
        ],
      }),
      find: async () => ({ matches: [] }),
      execute: async () => ({ success: true, status: "success", message: "ok" }),
    } as unknown as ServerComputerDriver
    const server = await startOmniaServer({
      token: "denied-token",
      drivers: [driver],
      modelsDir: tempDir(),
      llamaDirs: [],
      computerUseFile: join(tempDir(), "computer-use.json"),
    })
    try {
      const response = await fetch(`${server.url}/v1/computer-use/analyze`, {
        method: "POST",
        headers: { authorization: "Bearer denied-token", "content-type": "application/json" },
        body: JSON.stringify({
          computerId: "plain-computer",
          requestedOperation: "click",
          targetDescription: "Export",
          execute: true,
        }),
      })
      const body = (await response.json()) as { ok: boolean; result?: { success: boolean } }
      expect(body.ok).toBe(false)
      expect(body.result?.success).toBe(false)
    } finally {
      await server.stop()
    }
  })
})
