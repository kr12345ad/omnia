import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startOmniaServer } from "../server/server"
import { applySubscription, readBillingState, writeBillingState } from "../billing/store"
import { currentPeriod } from "../billing/store"
import type { PlanId } from "../billing/plans"
import { EntitlementGate } from "../cua/entitlements"
import type { Observation } from "../protocol"
import type { ComputerManager, ServerActionRequest } from "../server/computers"
import { LocalModelManager } from "./local"
import { SemanticProvider } from "./providers"
import { DefaultComputerUseRouter } from "./router"
import { ComputerUseService } from "./service"
import type {
  ComputerUseCapabilities,
  ComputerUseOperation,
  ComputerUseProvider,
  ComputerUseResult,
  ComputerUseSettings,
  HardwareReport,
} from "./types"

const PROFILE = "230746284"

type Server = Awaited<ReturnType<typeof startOmniaServer>>

let dir = ""
let previousBillingFile: string | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnia-vision-billing-"))
  previousBillingFile = process.env.OMNIA_BILLING_FILE
  process.env.OMNIA_BILLING_FILE = join(dir, "billing.json")
})

afterEach(() => {
  if (previousBillingFile === undefined) delete process.env.OMNIA_BILLING_FILE
  else process.env.OMNIA_BILLING_FILE = previousBillingFile
  rmSync(dir, { recursive: true, force: true })
})

async function withServer<T>(run: (server: Server) => Promise<T>): Promise<T> {
  const server = await startOmniaServer({
    credentialsFile: join(dir, "credentials.json"),
    authFile: join(dir, "auth.json"),
    superskillFile: join(dir, "superskills.json"),
    memoryFile: join(dir, "memories.json"),
    computerUseFile: join(dir, "computer-use.json"),
  })
  try {
    return await run(server)
  } finally {
    await server.stop()
  }
}

/** Folds a real subscription into the same store the control plane reads. */
function subscribe(plan: PlanId): void {
  const file = join(dir, "billing.json")
  writeBillingState(
    file,
    applySubscription(
      readBillingState(file),
      {
        customerId: `cus_${plan}`,
        subscriptionId: `sub_${plan}`,
        status: "active",
        profileId: PROFILE,
        // The store compares this against Date.now() in milliseconds, so a Stripe
        // seconds value would read as long expired.
        currentPeriodEnd: Date.now() + 30 * 24 * 60 * 60 * 1000,
      },
      plan,
      `evt_${plan}`,
    ).state,
  )
}

/** How many cloud_vision units this profile has actually spent. */
function spentCloudVision(): number {
  const state = readBillingState(join(dir, "billing.json"))
  return state.usage[PROFILE]?.counters[`cloud_vision:${currentPeriod()}`] ?? 0
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
    allowRemoteScreen: true,
    maxLatencyMs: 120000,
    // Two attempts, so a provider fallback chain is exercised by the
    // once-per-action assertion below.
    maxRetries: 1,
    idleUnloadMs: 0,
    ...overrides,
  }
}

const visionCapabilities: ComputerUseCapabilities = {
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

/** `probed` is routing's availability check; `analyzed` is the vision call. */
interface VisionCalls {
  probed: number
  analyzed: number
}

function counter(): VisionCalls {
  return { probed: 0, analyzed: 0 }
}

function visionProvider(id: string, outcome: ComputerUseResult, calls: VisionCalls): ComputerUseProvider {
  return {
    id,
    name: id,
    getCapabilities: async () => visionCapabilities,
    isAvailable: async () => {
      calls.probed += 1
      return true
    },
    estimateCost: async () => ({ usd: 0.01 }),
    estimateLatency: async () => ({ expectedMs: 10 }),
    analyze: async () => {
      calls.analyzed += 1
      return outcome
    },
  }
}

// An ordinary accessible control plus a canvas with no accessibility detail: the
// one shape the router deliberately reserves for vision.
function observation(): Observation {
  return {
    id: "obs-mixed",
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
      {
        id: "canvas-1",
        role: "canvas",
        name: "Drawing canvas",
        bounds: { x: 0, y: 0, width: 800, height: 600 },
        states: [],
        source: "vision",
      },
    ],
  }
}

function manager(executions: ServerActionRequest[]): ComputerManager {
  const driver = {
    id: "local",
    backend: "atspi",
    getInfo: async () => ({ id: "local", name: "local", platform: "linux" }),
    capabilities: () => [{ capability: "cua_snapshot", status: "available" }],
    observe: async () => observation(),
    find: async () => ({ matches: [] }),
    execute: async (action: { type: string }) =>
      action.type === "screenshot"
        ? { success: false, status: "unavailable", message: "no screenshot backend" }
        : { success: true, status: "success", message: "ok" },
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
      executions.push(request)
      return {
        httpStatus: 200,
        result: { success: true, status: "success", message: "clicked", verification: { status: "verified", verified: true } },
      }
    },
  } as unknown as ComputerManager
}

/**
 * The service reads its own settings from disk; the router reads them through
 * the callback below, so both come from the same file.
 */
function settingsFile(): string {
  const file = join(dir, "computer-use-settings.json")
  writeFileSync(file, JSON.stringify(settings()))
  return file
}

interface Harness {
  readonly service: ComputerUseService
  readonly visionCalls: VisionCalls
  readonly executions: ServerActionRequest[]
}

function harness(server: Server, providers: ComputerUseProvider[], visionCalls: VisionCalls): Harness {
  const executions: ServerActionRequest[] = []
  const all = [new SemanticProvider(), ...providers]
  const local = new LocalModelManager({
    catalog: [],
    modelsDir: join(dir, "models"),
    runtimeDirs: [],
    hardware: hardware(),
    idleUnloadMs: 0,
  })
  const file = settingsFile()
  return {
    visionCalls,
    executions,
    service: new ComputerUseService({
      manager: manager(executions),
      local,
      router: new DefaultComputerUseRouter({ providers: all, local, settings: () => settings() }),
      providers: all,
      catalog: [],
      settingsFile: file,
      entitlements: new EntitlementGate({ env: { OMNIA_SERVER_URL: server.url, OMNIA_SERVER_TOKEN: server.token }, profileId: PROFILE }),
    }),
  }
}

const clickCanvas: { computerId: string; operation: ComputerUseOperation; targetDescription: string } = {
  computerId: "local",
  operation: "click",
  targetDescription: "the blue paint bucket",
}

const clickExport: { computerId: string; operation: ComputerUseOperation; targetDescription: string } = {
  computerId: "local",
  operation: "click",
  targetDescription: "Export",
}

describe("cloud_vision enforcement", () => {
  test("the free plan refuses the vision fallback by name and never calls a provider", async () => {
    await withServer(async (server) => {
      const calls = counter()
      const { service } = harness(server, [visionProvider("vision-a", { success: true, provider: "vision-a", confidence: 0.9, latencyMs: 1 }, calls)], calls)
      const analysis = await service.analyze(clickCanvas)
      expect(analysis.result.success).toBe(false)
      expect(analysis.result.errorCode).toBe("capability_required")
      expect(analysis.errorCode).toBe("capability_required")
      expect(analysis.result.metadata?.capability).toBe("cloud_vision")
      expect(analysis.result.metadata?.capabilityCode).toBe("not_entitled")
      expect(String(analysis.result.metadata?.capabilityReason)).toContain("not included in the free plan")
      expect(analysis.result.metadata?.plan).toBe("free")
      // A typed refusal, not a silent empty result, and not a provider call.
      expect(String(analysis.result.reasoning)).toContain("computer_observe")
      expect(analysis.decision.provider).toBe("none")
      expect(analysis.decision.reason.join(" ")).toContain("cloud_vision")
      expect(calls.analyzed).toBe(0)
      expect(spentCloudVision()).toBe(0)
    })
  })

  test("a plan with cloud_vision runs the vision fallback and spends one unit", async () => {
    await withServer(async (server) => {
      subscribe("pro")
      const calls = counter()
      const { service } = harness(server, [visionProvider("vision-a", { success: true, provider: "vision-a", confidence: 0.9, latencyMs: 1 }, calls)], calls)
      const analysis = await service.analyze(clickCanvas)
      expect(analysis.result.success).toBe(true)
      expect(analysis.result.provider).toBe("vision-a")
      expect(calls.analyzed).toBeGreaterThan(0)
      expect(spentCloudVision()).toBe(1)
    })
  })

  test("one action spends one unit even when the provider chain falls back", async () => {
    await withServer(async (server) => {
      subscribe("pro")
      const failing = counter()
      const succeeding = counter()
      const { service } = harness(
        server,
        [
          visionProvider("vision-a", { success: false, provider: "vision-a", confidence: 0, latencyMs: 1 }, failing),
          visionProvider("vision-b", { success: true, provider: "vision-b", confidence: 0.9, latencyMs: 1 }, succeeding),
        ],
        failing,
      )
      const analysis = await service.analyze(clickCanvas)
      expect(analysis.result.provider).toBe("vision-b")
      expect(analysis.fallbacks).toBe(1)
      expect(failing.analyzed).toBeGreaterThan(0)
      expect(succeeding.analyzed).toBeGreaterThan(0)
      // Two providers ran; the action still cost exactly one unit.
      expect(spentCloudVision()).toBe(1)
    })
  })

  test("repeated actions each spend their own unit", async () => {
    await withServer(async (server) => {
      subscribe("pro")
      const calls = counter()
      const { service } = harness(server, [visionProvider("vision-a", { success: true, provider: "vision-a", confidence: 0.9, latencyMs: 1 }, calls)], calls)
      for (let index = 0; index < 4; index += 1) {
        expect((await service.analyze(clickCanvas)).result.success).toBe(true)
      }
      expect(spentCloudVision()).toBe(4)
    })
  })

  test("an unreachable control plane refuses the paid capability but not local observation", async () => {
    const calls = counter()
    const providers = [visionProvider("vision-a", { success: true, provider: "vision-a", confidence: 0.9, latencyMs: 1 }, calls)]
    const executions: ServerActionRequest[] = []
    const all = [new SemanticProvider(), ...providers]
    const local = new LocalModelManager({
      catalog: [],
      modelsDir: join(dir, "models"),
      runtimeDirs: [],
      hardware: hardware(),
      idleUnloadMs: 0,
    })
    const service = new ComputerUseService({
      manager: manager(executions),
      local,
      router: new DefaultComputerUseRouter({ providers: all, local, settings: () => settings() }),
      providers: all,
      catalog: [],
      settingsFile: settingsFile(),
      // A control plane that is configured but not answering.
      entitlements: new EntitlementGate({ env: { OMNIA_SERVER_URL: "http://127.0.0.1:1", OMNIA_SERVER_TOKEN: "t" }, profileId: PROFILE, timeoutMs: 250 }),
    })
    const refused = await service.analyze(clickCanvas)
    expect(refused.result.errorCode).toBe("capability_required")
    expect(refused.result.metadata?.entitlement).toBe("fail-closed")
    expect(calls.analyzed).toBe(0)

    // The accessibility path needs no vision model, so JSON-only observation is
    // untouched by a billing outage.
    const semantic = await service.analyze(clickExport)
    expect(semantic.result.success).toBe(true)
    expect(semantic.result.provider).toBe("semantic")
  })

  test("a semantic action never consults cloud_vision", async () => {
    await withServer(async (server) => {
      subscribe("pro")
      const calls = counter()
      const { service } = harness(server, [visionProvider("vision-a", { success: true, provider: "vision-a", confidence: 0.9, latencyMs: 1 }, calls)], calls)
      const analysis = await service.analyze(clickExport)
      expect(analysis.result.provider).toBe("semantic")
      expect(calls.analyzed).toBe(0)
      expect(spentCloudVision()).toBe(0)
    })
  })

  test("a refused plan never executes; an entitled perform is one action and one unit", async () => {
    await withServer(async (server) => {
      const grounding = { success: true, provider: "vision-a", confidence: 0.9, latencyMs: 1, action: { type: "click", target: { x: 100, y: 200 } } }
      const refusedCalls = counter()
      const refused = harness(server, [visionProvider("vision-a", grounding, refusedCalls)], refusedCalls)
      const denied = await refused.service.perform({ ...clickCanvas, execute: true })
      expect(denied.analysis.result.errorCode).toBe("capability_required")
      // Refused before the driver was asked to move the pointer.
      expect(denied.execution).toBeUndefined()
      expect(refused.executions).toHaveLength(0)
      expect(spentCloudVision()).toBe(0)

      subscribe("pro")
      const allowedCalls = counter()
      const allowed = harness(server, [visionProvider("vision-a", grounding, allowedCalls)], allowedCalls)
      const performed = await allowed.service.perform({ ...clickCanvas, execute: true })
      expect(performed.analysis.result.success).toBe(true)
      expect(performed.execution?.verified).toBe(true)
      expect(allowed.executions).toHaveLength(1)
      // Analysis and execution are one action, so they cost one unit.
      expect(spentCloudVision()).toBe(1)
    })
  })
})
