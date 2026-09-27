import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, truncateSync, writeFileSync, chmodSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startOmniaServer } from "../server/server"
import type { ComputerManager } from "../server/computers"
import { estimateCompatibility } from "./hardware"
import { LocalModelManager } from "./local"
import { parseMoondreamAnswer, parseMoondreamPoint } from "./providers"
import { createRuntimeCatalog } from "./runtimes"
import { createComputerUseCatalog } from "./models"
import { parseShowUiAction, parseUiTarsAction } from "./parse"
import { createProviders, shouldUseCropPath, titleBarCropFor } from "./providers"
import {
  checkCloseGuard,
  checkTitleBarBan,
  findKnownClosePoints,
  isMinimizeIntent,
  isTitleBarTarget,
  isWindowManagementIntent,
  windowManagementFallback,
} from "./window-safety"
import { DefaultComputerUseRouter } from "./router"
import { ComputerUseService } from "./service"
import type {
  ComputerUseContext,
  ComputerUseModel,
  ComputerUseProvider,
  ComputerUseResult,
  ComputerUseSettings,
  HardwareReport,
  RoutingDecision,
} from "./types"

const dirs: string[] = []
const envBackup = { ...process.env }

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  for (const key of ["OMNIA_LLAMA_SERVER", "OMNIA_SHOWUI_ENDPOINT", "OMNIA_SHOWUI_PI_ENDPOINT", "OMNIA_COMPUTER_USE_HOSTED_URL", "OMNIA_COMPUTER_USE_HOSTED_NAME"]) {
    if (envBackup[key] === undefined) delete process.env[key]
    else process.env[key] = envBackup[key]
  }
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "omnia-cu-"))
  dirs.push(dir)
  return dir
}

function fakeRuntime(): string {
  const dir = tempDir()
  const script = join(dir, "llama-server")
  writeFileSync(script, "#!/bin/sh\nexit 0\n")
  chmodSync(script, 0o755)
  return script
}

function installModel(modelsDir: string, model: ComputerUseModel): void {
  const dir = join(modelsDir, "computer-use", model.provider)
  mkdirSync(dir, { recursive: true })
  if (model.source === undefined) return
  const modelFile = join(dir, model.source.file)
  writeFileSync(modelFile, "")
  truncateSync(modelFile, model.modelSizeBytes ?? 1024)
  if (model.source.mmprojFile !== undefined) {
    const mmproj = join(dir, model.source.mmprojFile)
    writeFileSync(mmproj, "")
    truncateSync(mmproj, model.source.mmprojBytes ?? 1024)
  }
}

function hardware(overrides: Partial<HardwareReport> = {}): HardwareReport {
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
    ...overrides,
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
    idleUnloadMs: 300000,
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

async function localManager(catalog: ComputerUseModel[], modelsDir: string, hardwareReport = hardware()): Promise<LocalModelManager> {
  const local = new LocalModelManager({
    catalog,
    modelsDir,
    runtimeDirs: [],
    hardware: hardwareReport,
    idleUnloadMs: 0,
  })
  await local.verifyAll()
  return local
}

describe("computer-use parsing", () => {
  test("parses normalized UI-TARS click coordinates into pixels", () => {
    const parsed = parseUiTarsAction(
      "Action: click(start_box='<|box_start|>(500,250)<|box_end|>')",
      { width: 1920, height: 1080 },
      "normalized-1000",
    )
    expect(parsed?.action.type).toBe("click")
    expect(parsed?.action.target).toEqual({ x: 960, y: 270 })
  })

  test("parses drag with start and end boxes", () => {
    const parsed = parseUiTarsAction(
      "Action: drag(start_box='<|box_start|>(100,100)<|box_end|>', end_box='<|box_start|>(900,800)<|box_end|>')",
      { width: 1000, height: 1000 },
      "normalized-1000",
    )
    expect(parsed?.action.type).toBe("drag")
    expect(parsed?.action.path).toEqual([
      { x: 100, y: 100 },
      { x: 900, y: 800 },
    ])
  })

  test("parses typed text containing spaces", () => {
    const parsed = parseUiTarsAction("Action: type(content='Hello omnia world')", undefined, "normalized-1000")
    expect(parsed?.action).toEqual({ type: "type", text: "Hello omnia world" })
  })

  test("parses hotkeys", () => {
    const parsed = parseUiTarsAction("Action: hotkey(key='ctrl s')", undefined, "normalized-1000")
    expect(parsed?.action).toEqual({ type: "key", key: "ctrl s" })
  })

  test("parses ShowUI JSON actions with absolute coordinates", () => {
    const parsed = parseShowUiAction('{"action": "click", "coordinate": [420, 315]}', { width: 1280, height: 720 }, "absolute")
    expect(parsed?.action.type).toBe("click")
    expect(parsed?.action.target).toEqual({ x: 420, y: 315 })
  })
})

describe("computer-use hardware compatibility", () => {
  test("selects the GPU backend when VRAM fits", () => {
    const model = createComputerUseCatalog().find((entry) => entry.recommended)!
    const report = hardware({ gpus: [{ vendor: "nvidia", name: "RTX", backend: "cuda", vramBytes: 12 * 1024 ** 3 }], backends: ["cpu", "cuda"] })
    const compatibility = estimateCompatibility(model, report, ["cpu", "cuda"])
    expect(compatibility.compatible).toBe(true)
    expect(compatibility.backend).toBe("cuda")
  })

  test("rejects models larger than system memory", () => {
    const model = createComputerUseCatalog().find((entry) => entry.recommended)!
    const compatibility = estimateCompatibility(model, hardware({ memoryTotalBytes: 1 * 1024 ** 3 }), ["cpu"])
    expect(compatibility.compatible).toBe(false)
  })
})

describe("computer-use routing", () => {
  test("semantic coverage resolves the task without a visual model", async () => {
    const catalog = createComputerUseCatalog()
    const local = await localManager(catalog, tempDir())
    const router = new DefaultComputerUseRouter({ providers: createProviders({ catalog, local, settings: () => settings() }), local, settings: () => settings() })
    const decision = await router.route(
      context({
        semanticContext: {
          coverage: 0.8,
          elements: [{ role: "button", name: "Export", bounds: { x: 10, y: 10, width: 100, height: 30 }, source: "accessibility" }],
        },
      }),
    )
    expect(decision.provider).toBe("semantic")
    expect(decision.reason.join(" ")).toContain("semantic")
  })

  test("routes ground/click to the default UI-TARS grounding model", async () => {
    process.env.OMNIA_LLAMA_SERVER = fakeRuntime()
    const catalog = createComputerUseCatalog()
    const modelsDir = tempDir()
    installModel(modelsDir, catalog.find((entry) => entry.id === "ui-tars-2b-q4_k_m")!)
    installModel(modelsDir, catalog.find((entry) => entry.id === "moondream-2-q4_k")!)
    const local = await localManager(catalog, modelsDir)
    const router = new DefaultComputerUseRouter({ providers: createProviders({ catalog, local, settings: () => settings() }), local, settings: () => settings() })
    const decision = await router.route(context({ requestedOperation: "click", targetDescription: "Save button" }))
    expect(decision.provider).toBe("ui-tars")
    expect(decision.local).toBe(true)
    expect(decision.reason.join(" ")).toContain("grounding")
  })

  test("routes inspect/question to the Moondream describe fallback", async () => {
    process.env.OMNIA_LLAMA_SERVER = fakeRuntime()
    const catalog = createComputerUseCatalog()
    const modelsDir = tempDir()
    installModel(modelsDir, catalog.find((entry) => entry.id === "ui-tars-2b-q4_k_m")!)
    installModel(modelsDir, catalog.find((entry) => entry.id === "moondream-2-q4_k")!)
    const local = await localManager(catalog, modelsDir)
    const router = new DefaultComputerUseRouter({ providers: createProviders({ catalog, local, settings: () => settings() }), local, settings: () => settings() })
    const decision = await router.route(context({ requestedOperation: "inspect", targetDescription: "What error is shown?" }))
    expect(decision.provider).toBe("moondream")
    expect(decision.local).toBe(true)
  })

  test("falls back across vision providers when the default grounder is missing", async () => {
    process.env.OMNIA_LLAMA_SERVER = fakeRuntime()
    const catalog = createComputerUseCatalog()
    const modelsDir = tempDir()
    installModel(modelsDir, catalog.find((entry) => entry.id === "moondream-2-q4_k")!)
    const local = await localManager(catalog, modelsDir)
    const router = new DefaultComputerUseRouter({ providers: createProviders({ catalog, local, settings: () => settings() }), local, settings: () => settings() })
    const decision = await router.route(context({ requestedOperation: "click", targetDescription: "Save button" }))
    expect(decision.provider).toBe("moondream")
    expect(decision.local).toBe(true)
  })

  test("routes drag to the ShowUI-π specialist when it is available", async () => {
    process.env.OMNIA_SHOWUI_PI_ENDPOINT = "http://127.0.0.1:9/ground"
    const catalog = createComputerUseCatalog()
    const local = await localManager(catalog, tempDir())
    const router = new DefaultComputerUseRouter({ providers: createProviders({ catalog, local, settings: () => settings() }), local, settings: () => settings() })
    const decision = await router.route(context({ requestedOperation: "drag", targetDescription: "slider" }))
    expect(decision.provider).toBe("showui-pi")
    expect(decision.reason.join(" ")).toContain("specialist")
  })

  test("falls back to a hosted provider when no local model is available", async () => {
    process.env.OMNIA_COMPUTER_USE_HOSTED_URL = "http://127.0.0.1:9/hosted"
    process.env.OMNIA_COMPUTER_USE_HOSTED_NAME = "remote"
    const catalog = createComputerUseCatalog()
    const local = await localManager(catalog, tempDir())
    const router = new DefaultComputerUseRouter({
      providers: createProviders({ catalog, local, settings: () => settings({ allowRemoteScreen: true }) }),
      local,
      settings: () => settings({ allowRemoteScreen: true }),
    })
    const decision = await router.route(context({ requestedOperation: "click" }))
    expect(decision.provider).toBe("hosted:remote")
    expect(decision.local).toBe(false)
  })

  test("blocks remote providers by policy instead of silently routing", async () => {
    process.env.OMNIA_COMPUTER_USE_HOSTED_URL = "http://127.0.0.1:9/hosted"
    const catalog = createComputerUseCatalog()
    const local = await localManager(catalog, tempDir())
    const router = new DefaultComputerUseRouter({ providers: createProviders({ catalog, local, settings: () => settings() }), local, settings: () => settings() })
    const decision = await router.route(context({ requestedOperation: "click" }))
    expect(decision.provider).toBe("none")
    expect(decision.blockedByPolicy).toBe(true)
  })

  test("excludes models that cannot fit in the available memory", async () => {
    process.env.OMNIA_LLAMA_SERVER = fakeRuntime()
    const catalog = createComputerUseCatalog()
    const modelsDir = tempDir()
    installModel(modelsDir, catalog.find((entry) => entry.recommended)!)
    const local = await localManager(catalog, modelsDir, hardware({ memoryTotalBytes: 1 * 1024 ** 3, memoryFreeBytes: 512 * 1024 ** 2 }))
    const router = new DefaultComputerUseRouter({ providers: createProviders({ catalog, local, settings: () => settings() }), local, settings: () => settings() })
    const decision = await router.route(context({ requestedOperation: "click" }))
    expect(decision.provider).toBe("none")
    expect(decision.candidates.some((candidate) => (candidate.excluded ?? "").includes("memory"))).toBe(true)
  })
})

describe("computer-use reliability", () => {
  function fakeProvider(id: string, result: Partial<ComputerUseResult>): ComputerUseProvider {
    return {
      id,
      name: id,
      getCapabilities: async () => ({
        visualGrounding: true,
        click: true,
        doubleClick: true,
        rightClick: true,
        type: true,
        scroll: true,
        drag: true,
        resize: true,
        keyboardShortcuts: true,
        local: true,
        supportedBackends: ["cpu"],
      }),
      isAvailable: async () => true,
      estimateCost: async () => ({ usd: 0 }),
      estimateLatency: async () => ({ expectedMs: 10 }),
      analyze: async () => ({
        success: false,
        provider: id,
        confidence: 0,
        latencyMs: 1,
        ...result,
      }),
    }
  }

  function decision(providers: string[]): RoutingDecision {
    return {
      provider: providers[0]!,
      local: true,
      reason: ["test"],
      candidates: providers.map((provider, index) => ({ provider, local: true, score: 1 - index * 0.1, factors: {} })),
      semanticCoverage: 0,
      operation: "click",
      weights: { capabilityMatch: 0.3, quality: 0.25, hardwareFit: 0.2, latencyScore: 0.1, privacyScore: 0.1, costScore: 0.05 },
    }
  }

  test("a crashing provider falls back to the next eligible provider", async () => {
    const manager = { get: () => undefined, ids: () => [] } as unknown as ComputerManager
    const catalog = createComputerUseCatalog()
    const local = await localManager(catalog, tempDir())
    const providers = [fakeProvider("broken", { success: false, reasoning: "crash" }), fakeProvider("healthy", { success: true, confidence: 0.8 })]
    const service = new ComputerUseService({
      manager,
      local,
      catalog,
      providers,
      router: { route: async () => decision(["broken", "healthy"]) },
      settingsFile: join(tempDir(), "computer-use.json"),
    })
    const analysis = await service.analyze({ computerId: "local", operation: "click" })
    expect(analysis.result.provider).toBe("healthy")
    expect(analysis.fallbacks).toBe(1)
  })

  test("a claimed action that does not verify is reported as unverified", async () => {
    const manager = {
      get: () => undefined,
      ids: () => [],
      execute: async () => ({
        httpStatus: 200,
        result: {
          success: true,
          status: "success",
          message: "clicked",
          verification: { status: "unverified", verified: false, passed: false },
        },
      }),
    } as unknown as ComputerManager
    const catalog = createComputerUseCatalog()
    const local = await localManager(catalog, tempDir())
    const providers = [
      fakeProvider("ui-tars", {
        success: true,
        confidence: 0.9,
        action: { type: "click", target: { x: 10, y: 10 } },
      }),
    ]
    const service = new ComputerUseService({
      manager,
      local,
      catalog,
      providers,
      router: { route: async () => decision(["ui-tars"]) },
      settingsFile: join(tempDir(), "computer-use.json"),
    })
    const outcome = await service.perform({ computerId: "local", operation: "click", sessionId: "session-1" })
    expect(outcome.analysis.result.success).toBe(true)
    expect(outcome.execution?.verified).toBe(false)
  })
})

describe("computer-use server api", () => {
  test("exposes models, status, and settings", async () => {
    const server = await startOmniaServer({ token: "test-token", llamaDirs: [], modelsDir: tempDir() })
    const headers = { authorization: "Bearer test-token" }
    const models = await fetch(`${server.url}/v1/computer-use/models`, { headers }).then((response) => response.json() as Promise<{ ok: boolean; models: unknown[] }>)
    expect(models.ok).toBe(true)
    expect(models.models.length).toBeGreaterThan(2)
    const status = await fetch(`${server.url}/v1/computer-use/status`, { headers }).then((response) => response.json() as Promise<{ ok: boolean; status: { mode: string } }>)
    expect(status.status.mode).toBe("automatic")
    const updated = await fetch(`${server.url}/v1/computer-use/settings`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ mode: "local_only", allowRemoteScreen: false }),
    }).then((response) => response.json() as Promise<{ settings: { mode: string } }>)
    expect(updated.settings.mode).toBe("local_only")
    await server.stop()
  })
})

describe("moondream pointing", () => {
  test("parses normalized coordinates and scales to pixels", () => {
    expect(parseMoondreamPoint('{"x": 0.5, "y": 0.25}')).toEqual({ x: 0.5, y: 0.25 })
    expect(parseMoondreamPoint('The control is at {"x": 500, "y": 250}')).toEqual({ x: 0.5, y: 0.25 })
    expect(parseMoondreamPoint("no coordinates here")).toBeUndefined()
  })

  test("separates an answer from its coordinates", () => {
    expect(parseMoondreamAnswer('The dialog is open. {"x": 0.2, "y": 0.8}')).toEqual({
      answer: "The dialog is open.",
      point: { x: 0.2, y: 0.8 },
    })
    expect(parseMoondreamAnswer("There is no error visible.")).toEqual({ answer: "There is no error visible." })
  })
})

describe("computer-use model downloads", () => {
  test("marks a model failed when the download request fails", async () => {
    const catalog = createComputerUseCatalog()
    const model = catalog.find((entry) => entry.local && entry.recommended && entry.source !== undefined)!
    const local = new LocalModelManager({
      catalog,
      modelsDir: tempDir(),
      runtimeDirs: [],
      hardware: hardware(),
      fetchImpl: (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch,
    })
    await expect(local.download(model.id)).rejects.toThrow("Download failed with HTTP 500")
    const status = local.status(model.id)
    expect(status?.state).toBe("FAILED")
    expect(status?.reason).toContain("500")
  })
})

describe("computer-use runtimes", () => {
  test("catalogs GPU runtimes per platform", () => {
    const runtimes = createRuntimeCatalog("linux-x64")
    const cuda = runtimes.find((entry) => entry.variant === "cuda")
    expect(cuda).toBeDefined()
    expect(cuda?.archives.length).toBe(2)
    expect(cuda?.archives.every((entry) => entry.url.includes("llama.cpp/releases/download"))).toBe(true)
    expect(runtimes.some((entry) => entry.variant === "rocm")).toBe(true)
    expect(createRuntimeCatalog("darwin-arm64").some((entry) => entry.variant === "metal")).toBe(true)
    expect(createRuntimeCatalog("plan9").length).toBe(0)
  })

  test("marks a runtime failed when the download request fails", async () => {
    const local = new LocalModelManager({
      catalog: createComputerUseCatalog(),
      modelsDir: tempDir(),
      runtimeDirs: [],
      runtimeCatalog: createRuntimeCatalog("linux-x64"),
      hardware: hardware(),
      fetchImpl: (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch,
    })
    const cuda = local.listRuntimes().find((entry) => entry.runtime.variant === "cuda")!
    await expect(local.downloadRuntime(cuda.runtime.id)).rejects.toThrow("Download failed with HTTP 500")
    const status = local.listRuntimes().find((entry) => entry.runtime.variant === "cuda")
    expect(status?.state).toBe("FAILED")
    expect(status?.reason).toContain("500")
  })
})

describe("computer-use window safety (P0 title-bar ban)", () => {
  const screen1080 = { width: 1920, height: 1080 }

  test("bans the recorded Minimize point that missed 9px from Close", () => {
    const ban = checkTitleBarBan({ point: { x: 1834, y: 45 }, image: screen1080 })
    expect(ban.banned).toBe(true)
  })

  test("passes a center-screen point", () => {
    const ban = checkTitleBarBan({ point: { x: 960, y: 540 }, image: screen1080 })
    expect(ban.banned).toBe(false)
  })

  test("crop-region screenshots bypass the ban", () => {
    const crop = { ...screen1080, region: { x: 1520, y: 0, width: 400, height: 120 } }
    const ban = checkTitleBarBan({ point: { x: 314, y: 45 }, image: crop })
    expect(ban.banned).toBe(false)
  })

  test("explicit opt-in bypasses the ban", () => {
    const ban = checkTitleBarBan({ point: { x: 1834, y: 45 }, image: screen1080, allowTitleBarClicks: true })
    expect(ban.banned).toBe(false)
  })

  test("rejects points inside the 25px Close guard", () => {
    const closes = findKnownClosePoints(undefined, screen1080)
    expect(checkCloseGuard({ x: 1834, y: 45 }, closes).safe).toBe(false)
    expect(checkCloseGuard({ x: 1828, y: 45 }, closes).safe).toBe(false)
    expect(checkCloseGuard({ x: 1700, y: 45 }, closes).safe).toBe(true)
  })

  test("detects window-management intents", () => {
    expect(isWindowManagementIntent("minimize the Omnia window", undefined)).toBe(true)
    expect(isMinimizeIntent("minimize the Omnia window", undefined)).toBe(true)
    expect(isTitleBarTarget("the Minimize button in the title bar", undefined)).toBe(true)
    expect(isWindowManagementIntent("the Save button", undefined)).toBe(false)
  })

  test("falls back to keyboard instead of a vision click", () => {
    expect(windowManagementFallback({ targetDescription: "minimize the window", platform: "linux" })).toEqual({
      type: "key",
      key: "Super+Down",
    })
    expect(windowManagementFallback({ targetDescription: "minimize the window", platform: "macos" }).key).toBe("Cmd+m")
  })

  test("uses the title-bar crop path for window-control intents", () => {
    const crop = titleBarCropFor(screen1080)
    expect(crop).toEqual({ x: 1520, y: 0, width: 400, height: 120 })
    expect(shouldUseCropPath({ computerId: "local", requestedOperation: "click", targetDescription: "minimize the window" })).toBe(true)
    expect(shouldUseCropPath({ computerId: "local", requestedOperation: "click", targetDescription: "the Save button" })).toBe(false)
  })

  test("minimize intent analyzes to a keyboard action, never a window click", async () => {
    const catalog = createComputerUseCatalog()
    const local = await localManager(catalog, tempDir())
    const providers = createProviders({ catalog, local, settings: () => settings() })
    const router = new DefaultComputerUseRouter({ providers, local, settings: () => settings() })
    const manager = { ids: () => [], get: () => undefined } as unknown as ComputerManager
    const service = new ComputerUseService({ manager, local, router, providers, catalog })
    const analysis = await service.analyze({ computerId: "local", operation: "click", targetDescription: "minimize the Omnia window" })
    // Regression: semantic once matched the window itself and returned a
    // center-click, which can never minimize. Minimize must be keyboard.
    expect(analysis.result.success).toBe(true)
    expect(analysis.result.action).toEqual({ type: "key", key: "Super+Down" })
  })

  test("deflects minimize intents away from full-screen UI-TARS grounding", async () => {
    process.env.OMNIA_LLAMA_SERVER = fakeRuntime()
    const catalog = createComputerUseCatalog()
    const modelsDir = tempDir()
    installModel(modelsDir, catalog.find((entry) => entry.id === "ui-tars-2b-q4_k_m")!)
    const local = await localManager(catalog, modelsDir)
    const router = new DefaultComputerUseRouter({ providers: createProviders({ catalog, local, settings: () => settings() }), local, settings: () => settings() })
    const decision = await router.route(context({ requestedOperation: "click", targetDescription: "minimize the Omnia window" }))
    expect(decision.provider).toBe("none")
    expect(decision.reason.join(" ")).toContain("title-bar")
  })
})
