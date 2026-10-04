import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, existsSync, rmSync, truncateSync, writeFileSync, chmodSync, mkdirSync } from "node:fs"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startOmniaServer } from "../server/server"
import type { ComputerManager } from "../server/computers"
import { estimateCompatibility, detectHardware } from "./hardware"
import { LocalModelManager } from "./local"
import { CalibrationManager } from "./calibration"
import { parseMoondreamAnswer, parseMoondreamPoint, validateGroundedPoint } from "./providers"
import { createRuntimeCatalog } from "./runtimes"
import { createComputerUseCatalog } from "./models"
import { parseShowUiAction, parseUiTarsAction } from "./parse"
import { bestMatch, createProviders, SEMANTIC_MATCH_THRESHOLD, shouldUseCropPath, titleBarCropFor } from "./providers"
import { SemanticProvider } from "./providers"
import {
  checkCloseGuard,
  checkTitleBarBan,
  extractWindowTitleFragment,
  findKnownClosePoints,
  isMinimizeIntent,
  isTitleBarPoint,
  isTitleBarTarget,
  isWindowFocusIntent,
  isWindowManagementIntent,
  resolveWindowTitleFragment,
  scaleKnownCloseToImage,
  titleBarCropRegion,
  titleBarThresholds,
  windowManagementFallback,
} from "./window-safety"
import { bestScore, DefaultComputerUseRouter, SEMANTIC_SUFFICIENT_THRESHOLD } from "./router"
import { actionRequest, ComputerUseService } from "./service"
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
        targetDescription: "Export",
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

  test("an unverified vision click is refused after one retry (default on)", async () => {
    let calls = 0
    const manager = {
      get: () => undefined,
      ids: () => [],
      execute: async () => {
        calls += 1
        return {
          httpStatus: 200,
          result: {
            success: true,
            status: "success",
            message: "clicked",
            verification: { status: "unverified", verified: false, passed: false },
          },
        }
      },
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
    // Refusing rather than claiming success: the bounded retry ran once.
    expect(calls).toBe(2)
    expect(outcome.analysis.result.success).toBe(false)
    expect(outcome.analysis.result.errorCode).toBe("verification_failed")
    expect(outcome.execution?.verified).toBe(false)
  })

  test("verifyVisionClicks:false preserves the legacy unverified-success path", async () => {
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
    const file = join(tempDir(), "computer-use.json")
    writeFileSync(file, JSON.stringify({ verifyVisionClicks: false }))
    const service = new ComputerUseService({
      manager,
      local,
      catalog,
      providers,
      router: { route: async () => decision(["ui-tars"]) },
      settingsFile: file,
    })
    const outcome = await service.perform({ computerId: "local", operation: "click", sessionId: "session-1" })
    expect(outcome.analysis.result.success).toBe(true)
    expect(outcome.execution?.verified).toBe(false)
  })

  test("a retry that verifies succeeds", async () => {
    let calls = 0
    const manager = {
      get: () => undefined,
      ids: () => [],
      execute: async () => {
        calls += 1
        const verified = calls >= 2
        return {
          httpStatus: 200,
          result: {
            success: true,
            status: "success",
            message: "clicked",
            verification: verified ? { status: "verified", verified: true } : { status: "unverified", verified: false },
          },
        }
      },
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
    expect(calls).toBe(2)
    expect(outcome.analysis.result.success).toBe(true)
    expect(outcome.execution?.verified).toBe(true)
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
  const bytes = new TextEncoder().encode("tiny")

  function tinyModel(sha256: string): ComputerUseModel {
    const base = createComputerUseCatalog().find((entry) => entry.id === "ui-tars-2b-q4_k_m")!
    return {
      ...base,
      id: "tiny-test-model",
      displayName: "Tiny test model",
      modelSizeBytes: bytes.length,
      estimatedMemoryBytes: 4096,
      source: { type: "huggingface", repo: "example/tiny", file: "tiny.gguf", sha256 },
    }
  }

  function tinyManager(model: ComputerUseModel, fetchImpl?: typeof fetch): LocalModelManager {
    return new LocalModelManager({
      catalog: [model],
      modelsDir: tempDir(),
      runtimeDirs: [],
      hardware: hardware(),
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
    })
  }

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

  test("installs a download whose content matches the pinned SHA-256", async () => {
    const digest = createHash("sha256").update(bytes).digest("hex")
    const local = tinyManager(tinyModel(digest), (async () => new Response(bytes)) as unknown as typeof fetch)
    const status = await local.download("tiny-test-model")
    expect(status.state).toBe("INSTALLED")
  })

  test("rejects a download whose content does not match the pinned SHA-256", async () => {
    const local = tinyManager(tinyModel("0".repeat(64)), (async () => new Response(bytes)) as unknown as typeof fetch)
    await expect(local.download("tiny-test-model")).rejects.toThrow("checksum")
    expect(local.status("tiny-test-model")?.state).toBe("FAILED")
  })

  test("fails closed when an artifact has no pinned SHA-256", async () => {
    const bare = { ...tinyModel("0".repeat(64)), source: { type: "huggingface", repo: "example/tiny", file: "tiny.gguf" } }
    const modelsDir = tempDir()
    const dir = join(modelsDir, "computer-use", "ui-tars")
    mkdirSync(dir, { recursive: true })
    const partial = join(dir, "tiny.gguf")
    writeFileSync(partial, "ab")
    const local = new LocalModelManager({ catalog: [bare as unknown as ComputerUseModel], modelsDir, runtimeDirs: [], hardware: hardware() })
    await expect(local.download("tiny-test-model")).rejects.toThrow("no SHA-256 checksum is pinned")
    expect(local.status("tiny-test-model")?.state).toBe("FAILED")
    // The unpinned local file is left untouched rather than deleted.
    expect(existsSync(partial)).toBe(true)
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

describe("titled window-focus routing (Kitty OC | Quick hello regression)", () => {
  const kittyTarget = "the Kitty terminal window titled OC | Quick hello"
  const kittyTask = "focus the kitty terminal"
  const centerElement = {
    role: "window",
    name: "Terminal",
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    source: "accessibility" as const,
  }

  test("thresholds aligned at 0.6", () => {
    expect(SEMANTIC_MATCH_THRESHOLD).toBe(0.6)
    expect(SEMANTIC_SUFFICIENT_THRESHOLD).toBe(0.6)
  })

  test("extractWindowTitleFragment preserves pipe titles quoted-first", () => {
    expect(extractWindowTitleFragment('focus the "OC | Quick hello" window', undefined)).toBe("OC | Quick hello")
    expect(extractWindowTitleFragment(kittyTarget, kittyTask)).toBe("OC | Quick hello")
    expect(extractWindowTitleFragment("focus the kitty terminal", "please focus window named OC | Quick hello")).toBe(
      "OC | Quick hello",
    )
    expect(extractWindowTitleFragment("focus the terminal", undefined)).toBeUndefined()
  })

  test("isWindowFocusIntent routes focus but not in-window clicks", () => {
    expect(isWindowFocusIntent(kittyTarget, kittyTask)).toBe(true)
    expect(isWindowFocusIntent('focus the "OC | Quick hello" window', undefined)).toBe(true)
    // Negative guards: bare click + inner targets never route to focus_window.
    expect(isWindowFocusIntent("click link in Kitty", undefined)).toBe(false)
    expect(isWindowFocusIntent("click the Kitty window to focus it", undefined)).toBe(false)
    expect(isWindowFocusIntent("type text in the Kitty terminal", undefined)).toBe(false)
    expect(isWindowFocusIntent("focus the terminal", undefined)).toBe(false)
  })

  test("resolveWindowTitleFragment prefers exact, then substring, ties to undefined", () => {
    expect(resolveWindowTitleFragment("OC | Quick hello", ["OC | Quick hello", "OC | Other"])).toBe("OC | Quick hello")
    expect(resolveWindowTitleFragment("Quick hello", ["OC | Quick hello"])).toBe("OC | Quick hello")
    // Tie on identical overlap with no exact/substring winner -> undefined (fall back to vision, never wrong focus).
    // Note: fragment order differs so neither candidate contains it as a substring.
    expect(resolveWindowTitleFragment("Quick OC", ["OC Alpha Quick Extra", "OC Beta Quick Extra"])).toBeUndefined()
  })

  test("bestMatch no longer over-matches short names (0.4 removed)", () => {
    // Regression: query.includes("terminal") once scored 0.4 and clicked (960,539).
    const over = bestMatch([centerElement], `${kittyTarget} / ${kittyTask}`)
    expect(over).toBeUndefined()
    // Valid semantic clicks still resolve.
    const valid = bestMatch(
      [{ role: "button", name: "Export", bounds: { x: 10, y: 10, width: 100, height: 30 }, source: "accessibility" as const }],
      "Export",
    )
    expect(valid?.score).toBeGreaterThanOrEqual(0.6)
    expect(valid?.element.name).toBe("Export")
  })

  test("bestScore aligned: no 0.4 over-match for Kitty query", () => {
    const over = bestScore([{ name: "Terminal", role: "window" }], `${kittyTarget} / ${kittyTask}`.toLowerCase())
    expect(over === undefined || over < 0.6).toBe(true)
    const valid = bestScore([{ name: "Export", role: "button" }], "export")
    expect(valid).toBeGreaterThanOrEqual(0.6)
  })

  test("SemanticProvider returns focus_window, never a center-click", async () => {
    const provider = new SemanticProvider()
    const result = await provider.analyze({
      computerId: "local",
      requestedOperation: "click",
      targetDescription: kittyTarget,
      taskContext: kittyTask,
      semanticContext: {
        coverage: 0.8,
        windowTitle: "OC | Quick hello",
        elements: [centerElement],
      },
    })
    expect(result.success).toBe(true)
    expect(result.action?.type).toBe("focus_window")
    expect(result.action?.window).toContain("OC | Quick hello")
    // Must not carry a screen-center click target.
    expect(result.action?.target?.x).toBeUndefined()
    expect(result.confidence).toBe(0.9)
  })

  test("service.analyze routes Kitty focus to focus_window (0 center-clicks)", async () => {
    const catalog = createComputerUseCatalog()
    const local = await localManager(catalog, tempDir())
    const providers = createProviders({ catalog, local, settings: () => settings() })
    const router = new DefaultComputerUseRouter({ providers, local, settings: () => settings() })
    const manager = { ids: () => [], get: () => undefined } as unknown as ComputerManager
    const service = new ComputerUseService({ manager, local, router, providers, catalog })
    const analysis = await service.analyze({
      computerId: "local",
      operation: "click",
      targetDescription: kittyTarget,
      taskContext: kittyTask,
    })
    expect(analysis.result.success).toBe(true)
    expect(analysis.result.action?.type).toBe("focus_window")
    expect(analysis.result.action?.window).toContain("OC | Quick hello")
    expect(analysis.result.action?.target?.x).toBeUndefined()
  })

  test("actionRequest maps focus_window by title", () => {
    expect(actionRequest({ type: "focus_window", window: "OC | Quick hello" })).toEqual({
      action: "focus_window",
      window: "OC | Quick hello",
    })
  })
})

describe("computer-use hardware detection", () => {
  test("does not touch /sys/class/drm on non-linux platforms", async () => {
    const report = await detectHardware({ platform: "win32", arch: "x64", probe: async () => undefined })
    expect(report.platform).toBe("windows")
    expect(report.gpus).toEqual([])
    expect(report.backends).toEqual(["cpu"])
  })

  test("survives an unreadable disk path", async () => {
    const report = await detectHardware({
      platform: "linux",
      arch: "x64",
      diskPath: "/definitely/not/a/path",
      probe: async () => undefined,
    })
    expect(report.diskFreeBytes).toBeUndefined()
  })
})

describe("computer-use settings hardening", () => {
  function serviceWithSettingsFile(file: string): ComputerUseService {
    const catalog = createComputerUseCatalog()
    const providers = createProviders({ catalog, local: new LocalModelManager({ catalog, modelsDir: tempDir(), runtimeDirs: [], hardware: hardware() }), settings: () => settings() })
    return new ComputerUseService({
      manager: { ids: () => [], get: () => undefined } as unknown as ComputerManager,
      local: new LocalModelManager({ catalog, modelsDir: tempDir(), runtimeDirs: [], hardware: hardware() }),
      catalog,
      providers,
      router: { route: async () => { throw new Error("unused") } },
      settingsFile: file,
    })
  }

  test("a corrupt settings file falls back to defaults instead of crashing boot", () => {
    const file = join(tempDir(), "computer-use.json")
    writeFileSync(file, "{ this is not json")
    const service = serviceWithSettingsFile(file)
    expect(service.settings().mode).toBe("automatic")
    expect(service.settings().maxRetries).toBe(1)
    expect(service.settings().allowRemoteScreen).toBe(false)
  })

  test("invalid numeric settings are clamped, not applied", () => {
    const file = join(tempDir(), "computer-use.json")
    writeFileSync(file, JSON.stringify({ maxRetries: -5, idleUnloadMs: -1, maxLatencyMs: 0, maxMemoryBytes: -4 }))
    const service = serviceWithSettingsFile(file)
    expect(service.settings().maxRetries).toBe(0)
    expect(service.settings().idleUnloadMs).toBe(0)
    expect(service.settings().maxLatencyMs).toBe(120000)
    expect(service.settings().maxMemoryBytes).toBeUndefined()
  })

  test("updateSettings clamps maxLatencyMs and maxRetries", () => {
    const file = join(tempDir(), "computer-use.json")
    const service = serviceWithSettingsFile(file)
    const next = service.updateSettings({ maxLatencyMs: -1, maxRetries: 99 })
    expect(next.maxLatencyMs).toBe(120000)
    expect(next.maxRetries).toBe(3)
  })
})

describe("moondream asking must not produce clicks", () => {
  function moondreamProvider() {
    const catalog = createComputerUseCatalog()
    const model = catalog.find((entry) => entry.provider === "moondream")!
    const local = {
      list: () => [{ model, state: "READY" as const, installed: true, loaded: true }],
      runtime: async () => ({ available: true, backend: "cpu", libraryPaths: [] }),
      ensureLoaded: async () => ({ available: true, port: 1, libraryPaths: [] }),
      chat: async () => ({ text: 'The dialog is open. {"x": 0.5, "y": 0.5}' }),
    } as unknown as LocalModelManager
    return createProviders({ catalog, local, settings: () => settings() }).find((provider) => provider.id === "moondream")!
  }

  test("an inspect answer with coordinates returns no action", async () => {
    const result = await moondreamProvider().analyze(
      {
        computerId: "local",
        requestedOperation: "inspect",
        question: "What is shown?",
        screenshot: { width: 100, height: 100 },
      },
      context({ requestedOperation: "inspect" }),
    )
    expect(result.success).toBe(true)
    expect(result.action).toBeUndefined()
  })

  test("a pointing request still returns a click", async () => {
    const result = await moondreamProvider().analyze(
      {
        computerId: "local",
        requestedOperation: "click",
        targetDescription: "Save",
        screenshot: { width: 100, height: 100 },
      },
      context({ requestedOperation: "click" }),
    )
    expect(result.success).toBe(true)
    expect(result.action?.type).toBe("click")
    expect(result.action?.target).toEqual({ x: 50, y: 50 })
  })
})

describe("crop-path validation", () => {
  const cropImage = {
    width: 400,
    height: 120,
    region: { x: 1520, y: 0, width: 400, height: 120 },
    serverCrop: true,
  }
  const closeElement = {
    role: "button",
    name: "Close",
    bounds: { x: 1833, y: 35, width: 20, height: 20 },
    source: "accessibility" as const,
  }

  test("a trusted crop bypasses the title-bar ban", () => {
    expect(validateGroundedPoint({ x: 1834, y: 45, screenshot: cropImage })).toBeUndefined()
  })

  test("the 25px Close guard still applies to crop targets", () => {
    const unsafe = validateGroundedPoint({
      x: 1834,
      y: 45,
      screenshot: cropImage,
      semanticElements: [closeElement],
      targetDescription: "minimize the window",
    })
    expect(unsafe).toContain("guard")
  })

  test("a caller-supplied region is not trusted and does not bypass the ban", () => {
    const callerCrop = { width: 400, height: 120, region: { x: 1520, y: 0, width: 400, height: 120 } }
    expect(validateGroundedPoint({ x: 1834, y: 45, screenshot: callerCrop })).toBeDefined()
  })
})

describe("endpoint vision provider hardening", () => {
  test("a hung endpoint is aborted by the request timeout", async () => {
    process.env.OMNIA_SHOWUI_ENDPOINT = "http://127.0.0.1:1/hang"
    const server = Bun.serve({
      port: 0,
      fetch: () => new Promise<Response>(() => undefined),
    })
    process.env.OMNIA_SHOWUI_ENDPOINT = `http://127.0.0.1:${server.port}/hang`
    try {
      const catalog = createComputerUseCatalog()
      const local = new LocalModelManager({ catalog, modelsDir: tempDir(), runtimeDirs: [], hardware: hardware() })
      const provider = createProviders({ catalog, local, settings: () => settings() }).find((entry) => entry.id === "showui")!
      const started = Date.now()
      const result = await provider.analyze(
        {
          computerId: "local",
          requestedOperation: "click",
          targetDescription: "Save",
          screenshot: { width: 100, height: 100 },
          timeoutMs: 200,
        },
        context(),
      )
      expect(result.success).toBe(false)
      expect(Date.now() - started).toBeLessThan(5000)
    } finally {
      await server.stop(true)
    }
  })

  test("an endpoint HTTP 500 becomes a failed result, not a throw", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("boom", { status: 500 }) })
    process.env.OMNIA_SHOWUI_ENDPOINT = `http://127.0.0.1:${server.port}/ground`
    try {
      const catalog = createComputerUseCatalog()
      const local = new LocalModelManager({ catalog, modelsDir: tempDir(), runtimeDirs: [], hardware: hardware() })
      const provider = createProviders({ catalog, local, settings: () => settings() }).find((entry) => entry.id === "showui")!
      const result = await provider.analyze(
        { computerId: "local", requestedOperation: "click", targetDescription: "Save", screenshot: { width: 100, height: 100 } },
        context(),
      )
      expect(result.success).toBe(false)
      expect(result.reasoning).toContain("HTTP 500")
    } finally {
      await server.stop(true)
    }
  })

  test("hosted_only consents to remote screen while local_only always blocks it", async () => {
    process.env.OMNIA_COMPUTER_USE_HOSTED_URL = "http://127.0.0.1:9/hosted"
    process.env.OMNIA_COMPUTER_USE_HOSTED_NAME = "remote"
    const catalog = createComputerUseCatalog()
    const local = new LocalModelManager({ catalog, modelsDir: tempDir(), runtimeDirs: [], hardware: hardware() })
    const hosted = (mode: ComputerUseSettings["mode"], allowRemoteScreen: boolean) =>
      createProviders({ catalog, local, settings: () => settings({ mode, allowRemoteScreen }) }).find((entry) => entry.id === "hosted:remote")!
    expect(await hosted("hosted_only", false).isAvailable(context())).toBe(true)
    expect(await hosted("automatic", false).isAvailable(context())).toBe(false)
    expect(await hosted("local_only", true).isAvailable(context())).toBe(false)
    expect(await hosted("automatic", true).isAvailable(context())).toBe(true)
    // A per-request privacy mode still wins over the global settings.
    expect(
      await hosted("automatic", true).isAvailable(context({ privacy: { allowRemoteScreen: true, mode: "local_only" } })),
    ).toBe(false)
  })
})
describe("window safety hardening", () => {
  const screen1080 = { width: 1920, height: 1080 }

  test("bare 'close' only counts in a window-control context", () => {
    expect(isTitleBarTarget("close the dialog", undefined)).toBe(false)
    expect(isTitleBarTarget("close the sidebar", undefined)).toBe(false)
    expect(isTitleBarTarget("closest match", undefined)).toBe(false)
    expect(isTitleBarTarget("Close button", undefined)).toBe(true)
    expect(isTitleBarTarget("close window", undefined)).toBe(true)
  })

  test("unminimize is not a minimize intent and gets a restore fallback", () => {
    expect(isMinimizeIntent("unminimize the window", undefined)).toBe(false)
    expect(windowManagementFallback({ targetDescription: "unminimize the window", platform: "linux" })).toEqual({
      type: "key",
      key: "Super+Up",
    })
    expect(windowManagementFallback({ targetDescription: "restore the window", platform: "windows" }).key).toBe("Win+Up")
  })

  test("show desktop and window menu have explicit fallbacks", () => {
    expect(windowManagementFallback({ targetDescription: "show desktop", platform: "windows" })).toEqual({
      type: "key",
      key: "Win+d",
    })
    expect(windowManagementFallback({ targetDescription: "open the window menu", platform: "linux" }).type).toBe("unsupported")
  })

  test("findKnownClosePoints only treats exact close names (or title-bar positions) as Close-X", () => {
    const points = findKnownClosePoints(
      [
        { role: "button", name: "Close sidebar", bounds: { x: 20, y: 500, width: 20, height: 20 }, source: "accessibility" },
        { role: "button", name: "Close", bounds: { x: 1833, y: 35, width: 20, height: 20 }, source: "accessibility" },
      ],
      screen1080,
    )
    expect(points.some((point) => point.x === 30 && point.y === 510)).toBe(false)
    expect(points.some((point) => point.x === 1843 && point.y === 45)).toBe(true)
  })

  test("yThreshold scales with DPI instead of being capped at 120", () => {
    expect(titleBarThresholds(screen1080).yThreshold).toBe(120)
    expect(titleBarThresholds({ width: 3840, height: 2160 }).yThreshold).toBe(240)
    expect(checkTitleBarBan({ point: { x: 3700, y: 200 }, image: { width: 3840, height: 2160 } }).banned).toBe(true)
  })

  test("substring title ties resolve to undefined", () => {
    expect(resolveWindowTitleFragment("Quick hello", ["OC | Quick hello", "Quick hello | Extra"])).toBeUndefined()
    expect(resolveWindowTitleFragment("Quick hello", ["OC | Quick hello"])).toBe("OC | Quick hello")
  })

  test("macOS uses left-side window-control geometry", () => {
    expect(scaleKnownCloseToImage({ width: 1920, height: 1080 }, "macos")).toEqual({ x: 20, y: 20 })
  })
})
describe("parser adversarial fixtures", () => {
  test("multi-action output only parses the first action", () => {
    const parsed = parseUiTarsAction(
      "Action: click(start_box='<|box_start|>(100,100)<|box_end|>')\nAction: type(content='hello')",
      { width: 1000, height: 1000 },
      "normalized-1000",
    )
    expect(parsed?.action.type).toBe("click")
    expect(parsed?.action.target).toEqual({ x: 100, y: 100 })
  })

  test("malformed JSON falls through without throwing", () => {
    expect(parseShowUiAction("{not valid json", { width: 100, height: 100 }, "absolute")).toBeUndefined()
  })

  test("negative coordinates are clamped on screen", () => {
    const parsed = parseUiTarsAction("Action: click(start_box='(-100,-50)')", { width: 1920, height: 1080 }, "normalized-1000")
    expect(parsed?.action.target).toEqual({ x: 0, y: 0 })
  })

  test("absolute coordinates outside the image are rejected, not clamped", () => {
    const image = { width: 100, height: 100 }
    expect(parseShowUiAction('{"action": "click", "coordinate": [-5, 50]}', image, "absolute")?.action.target).toBeUndefined()
    expect(parseShowUiAction('{"action": "click", "coordinate": [100, 50]}', image, "absolute")?.action.target).toBeUndefined()
    expect(parseShowUiAction('{"action": "click", "coordinate": [99, 0]}', image, "absolute")?.action.target).toEqual({ x: 99, y: 0 })
    const crop = { width: 400, height: 120, region: { x: 1520, y: 0, width: 400, height: 120 } }
    expect(parseShowUiAction('{"action": "click", "coordinate": [399, 119]}', crop, "absolute")?.action.target).toEqual({
      x: 1919,
      y: 119,
    })
    expect(parseShowUiAction('{"action": "click", "coordinate": [420, 100]}', crop, "absolute")?.action.target).toBeUndefined()
  })

  test("a drag without an end point does not parse as an executable action", () => {
    expect(parseUiTarsAction("Action: drag(start_box='(10,10)')", { width: 1000, height: 1000 }, "normalized-1000")).toBeUndefined()
  })
})

describe("router contract", () => {
  test("bestMatch resolves a ref-only element without bounds", () => {
    const match = bestMatch([{ elementId: "atspi:3.5", role: "button" }], "atspi:3.5")
    expect(match?.score).toBe(1)
    expect(match?.element.elementId).toBe("atspi:3.5")
  })

  test("ask mode marks semantic fast-path decisions as requiring approval", async () => {
    const catalog = createComputerUseCatalog()
    const local = await localManager(catalog, tempDir())
    const providers = createProviders({ catalog, local, settings: () => settings({ mode: "ask" }) })
    const router = new DefaultComputerUseRouter({ providers, local, settings: () => settings({ mode: "ask" }) })
    const decision = await router.route(
      context({
        targetDescription: "Export",
        semanticContext: {
          coverage: 0.8,
          elements: [{ role: "button", name: "Export", bounds: { x: 10, y: 10, width: 100, height: 30 }, source: "accessibility" }],
        },
      }),
    )
    expect(decision.provider).toBe("semantic")
    expect(decision.requiresApproval).toBe(true)
  })
})

describe("local model load single-flight", () => {
  test("concurrent load calls share one in-flight task", async () => {
    const catalog = createComputerUseCatalog()
    const local = new LocalModelManager({
      catalog,
      modelsDir: tempDir(),
      runtimeDirs: [],
      hardware: hardware(),
    })
    const model = catalog.find((entry) => entry.recommended)!
    const first = local.load(model.id)
    const second = local.load(model.id)
    expect(first).toBe(second)
    const results = await Promise.allSettled([first, second])
    expect(results.every((result) => result.status === "rejected")).toBe(true)
  })
})

describe("coordinate contract: one logical space, screenshot for crop math only", () => {
  function visionProvider(point: { x: number; y: number }): ComputerUseProvider {
    return {
      id: "ui-tars",
      name: "ui-tars",
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
        success: true,
        provider: "ui-tars",
        confidence: 0.9,
        latencyMs: 1,
        action: { type: "click", target: { x: point.x, y: point.y } },
      }),
    }
  }

  function routingTo(provider: string): { route: () => Promise<RoutingDecision> } {
    return {
      route: async () => ({
        provider,
        local: true,
        reason: ["test"],
        candidates: [{ provider, local: true, score: 1, factors: {} }],
        semanticCoverage: 0,
        operation: "click",
        weights: { capabilityMatch: 0.3, quality: 0.25, hardwareFit: 0.2, latencyScore: 0.1, privacyScore: 0.1, costScore: 0.05 },
      }),
    }
  }

  test("retina: screenshot device pixels convert to logical exactly once (~2x miss fixed)", async () => {
    const seen: number[][] = []
    const driver = {
      getInfo: async () => ({ id: "retina", name: "retina", platform: "macos", screen: { width: 960, height: 540 } }),
      observe: async () => ({ id: "obs", elements: [] }),
      execute: async (action: { target?: { kind: string; x?: number; y?: number } | { x?: number; y?: number } }) => {
        const target = action.target as { x?: number; y?: number } | undefined
        if (typeof target?.x === "number" && typeof target?.y === "number") seen.push([target.x, target.y])
        // Point action form: {type:"click", target:{kind:"point",x,y}}
        const point = action as { target?: { kind?: string; x?: number; y?: number } }
        return { success: true, status: "success", message: "ok", verification: { status: "verified", verified: true } }
      },
    }
    // Manager execute path: service calls manager.execute which forwards x/y.
    // Fake the manager to capture the logical request the service built.
    const requests: Array<{ x?: number; y?: number }> = []
    const manager = {
      ids: () => ["retina"],
      get: (id: string) => (id === "retina" ? { id, driver } : undefined),
      execute: async (_id: string, req: { x?: number; y?: number }) => {
        if (typeof req.x === "number" && typeof req.y === "number") requests.push({ x: req.x, y: req.y })
        return {
          httpStatus: 200,
          result: { success: true, status: "success", message: "ok", verification: { status: "verified", verified: true } },
        }
      },
    } as unknown as ComputerManager
    const catalog = createComputerUseCatalog()
    const local = await localManager(catalog, tempDir())
    // Device screenshot is 2x logical: model grounds at device (960,540) center.
    const screenshot = { width: 1920, height: 1080 }
    const service = new ComputerUseService({
      manager,
      local,
      catalog,
      providers: [visionProvider({ x: 960, y: 540 })],
      router: routingTo("ui-tars"),
      settingsFile: join(tempDir(), "computer-use.json"),
    })
    const analysis = await service.analyze({ computerId: "retina", operation: "click", targetDescription: "Save", screenshot })
    expect(analysis.result.success).toBe(true)
    // Exactly once: 960 device -> 480 logical (not 240 on double-convert, not 960 on miss).
    expect(analysis.result.action?.target).toEqual({ x: 480, y: 270 })
    const performed = await service.perform({ computerId: "retina", operation: "click", targetDescription: "Save", screenshot })
    expect(performed.analysis.result.action?.target).toEqual({ x: 480, y: 270 })
    expect(requests[0]).toEqual({ x: 480, y: 270 })
    expect(seen.length).toBe(0)
  })

  test("drag path converts both endpoints once", async () => {
    const manager = {
      ids: () => ["retina"],
      get: () => ({ id: "retina", driver: { getInfo: async () => ({ id: "r", name: "r", platform: "linux", screen: { width: 960, height: 540 } }) } }),
      execute: async () => ({
        httpStatus: 200,
        result: { success: true, status: "success", message: "ok", verification: { status: "verified", verified: true } },
      }),
    } as unknown as ComputerManager
    const catalog = createComputerUseCatalog()
    const local = await localManager(catalog, tempDir())
    const dragProvider: ComputerUseProvider = {
      id: "ui-tars",
      name: "ui-tars",
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
        success: true,
        provider: "ui-tars",
        confidence: 0.9,
        latencyMs: 1,
        action: {
          type: "drag",
          target: { x: 1920, y: 1080 },
          path: [
            { x: 1920, y: 1080 },
            { x: 960, y: 540 },
          ],
        },
      }),
    }
    const service = new ComputerUseService({
      manager,
      local,
      catalog,
      providers: [dragProvider],
      router: routingTo("ui-tars"),
      settingsFile: join(tempDir(), "computer-use.json"),
    })
    const analysis = await service.analyze({
      computerId: "retina",
      operation: "drag",
      targetDescription: "slider",
      screenshot: { width: 1920, height: 1080 },
    })
    expect(analysis.result.action?.target).toEqual({ x: 960, y: 540 })
    expect(analysis.result.action?.path).toEqual([
      { x: 960, y: 540 },
      { x: 480, y: 270 },
    ])
  })
})

describe("calibration applies to visual points (non-identity profile)", () => {
  function visionAt(point: { x: number; y: number }): ComputerUseProvider {
    return {
      id: "ui-tars",
      name: "ui-tars",
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
        success: true,
        provider: "ui-tars",
        confidence: 0.9,
        latencyMs: 1,
        action: { type: "click", target: { x: point.x, y: point.y } },
      }),
    }
  }

  function routingTo(provider: string) {
    return {
      route: async (): Promise<RoutingDecision> => ({
        provider,
        local: true,
        reason: ["test"],
        candidates: [{ provider, local: true, score: 1, factors: {} }],
        semanticCoverage: 0,
        operation: "click",
        weights: { capabilityMatch: 0.3, quality: 0.25, hardwareFit: 0.2, latencyScore: 0.1, privacyScore: 0.1, costScore: 0.05 },
      }),
    }
  }

  test("visual execution routes through the calibration transform", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnia-cal-"))
    const calibration = new CalibrationManager({ file: join(dir, "calibration.json") })
    calibration.save({
      screen: { width: 1920, height: 1080 },
      scaleX: 1,
      scaleY: 1,
      offsetX: 10,
      offsetY: -20,
      samples: 3,
      measuredAt: Date.now(),
    })
    calibration.status({ width: 1920, height: 1080 })
    const requests: Array<{ x?: number; y?: number }> = []
    const manager = {
      ids: () => ["cal"],
      get: () => ({
        id: "cal",
        driver: { getInfo: async () => ({ id: "cal", name: "cal", platform: "linux", screen: { width: 1920, height: 1080 } }) },
      }),
      execute: async (_id: string, req: { x?: number; y?: number }) => {
        requests.push({ x: req.x, y: req.y })
        return {
          httpStatus: 200,
          result: { success: true, status: "success", message: "ok", verification: { status: "verified", verified: true } },
        }
      },
    } as unknown as ComputerManager
    const catalog = createComputerUseCatalog()
    const local = await localManager(catalog, tempDir())
    const service = new ComputerUseService({
      manager,
      local,
      catalog,
      providers: [visionAt({ x: 100, y: 100 })],
      router: routingTo("ui-tars"),
      calibration,
      settingsFile: join(tempDir(), "computer-use.json"),
    })
    const outcome = await service.perform({
      computerId: "cal",
      operation: "click",
      targetDescription: "Save",
      screenshot: { width: 1920, height: 1080 },
    })
    expect(outcome.analysis.result.success).toBe(true)
    // transform is (x-offset)/scale: (100-10, 100+20) = (90,120).
    expect(requests[0]).toEqual({ x: 90, y: 120 })
    expect(outcome.execution?.verified).toBe(true)
  })

  test("a stale calibrated profile refuses instead of executing uncalibrated", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnia-cal-"))
    const calibration = new CalibrationManager({ file: join(dir, "calibration.json") })
    calibration.save({
      screen: { width: 1920, height: 1080 },
      scaleX: 1,
      scaleY: 1,
      offsetX: 10,
      offsetY: 10,
      samples: 3,
      measuredAt: Date.now(),
    })
    let executed = 0
    const manager = {
      ids: () => ["cal"],
      // Controlled machine now reports a different screen: profile inapplicable.
      get: () => ({
        id: "cal",
        driver: { getInfo: async () => ({ id: "cal", name: "cal", platform: "linux", screen: { width: 2560, height: 1440 } }) },
      }),
      execute: async () => {
        executed += 1
        return { httpStatus: 200, result: { success: true, status: "success", message: "ok" } }
      },
    } as unknown as ComputerManager
    const catalog = createComputerUseCatalog()
    const local = await localManager(catalog, tempDir())
    const service = new ComputerUseService({
      manager,
      local,
      catalog,
      providers: [visionAt({ x: 100, y: 100 })],
      router: routingTo("ui-tars"),
      calibration,
      settingsFile: join(tempDir(), "computer-use.json"),
    })
    const outcome = await service.perform({
      computerId: "cal",
      operation: "click",
      targetDescription: "Save",
      screenshot: { width: 1920, height: 1080 },
    })
    expect(executed).toBe(0)
    expect(outcome.analysis.result.success).toBe(false)
    expect(outcome.analysis.result.errorCode).toBe("calibration_stale")
  })
})

describe("platform comes from the controlled machine, host is fallback only", () => {
  function routingNone(): { route: () => Promise<RoutingDecision> } {
    return {
      route: async () => ({
        provider: "none",
        local: false,
        reason: ["test"],
        candidates: [],
        semanticCoverage: 0,
        operation: "click",
        weights: { capabilityMatch: 0.3, quality: 0.25, hardwareFit: 0.2, latencyScore: 0.1, privacyScore: 0.1, costScore: 0.05 },
      }),
    }
  }

  test("driver platform wins over the server host", async () => {
    const catalog = createComputerUseCatalog()
    const local = await localManager(catalog, tempDir())
    const manager = {
      ids: () => ["mac"],
      get: () => ({
        id: "mac",
        driver: { getInfo: async () => ({ id: "mac", name: "mac", platform: "macos", screen: { width: 1920, height: 1080 } }) },
      }),
    } as unknown as ComputerManager
    const service = new ComputerUseService({
      manager,
      local,
      catalog,
      providers: [],
      router: routingNone(),
      settingsFile: join(tempDir(), "computer-use.json"),
    })
    const analysis = await service.analyze({ computerId: "mac", operation: "click", targetDescription: "Save" })
    // Host in CI is linux; the controlled driver says macos and must win.
    expect(analysis.context?.platform).toBe("macos")
  })

  test("unknown driver platform falls back to the host", async () => {
    const catalog = createComputerUseCatalog()
    const local = await localManager(catalog, tempDir())
    const manager = {
      ids: () => ["unknown"],
      get: () => ({ id: "unknown", driver: { getInfo: async () => ({ id: "u", name: "u" }) } }),
    } as unknown as ComputerManager
    const service = new ComputerUseService({
      manager,
      local,
      catalog,
      providers: [],
      router: routingNone(),
      settingsFile: join(tempDir(), "computer-use.json"),
    })
    const analysis = await service.analyze({ computerId: "unknown", operation: "click" })
    const host = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux"
    expect(analysis.context?.platform).toBe(host)
  })

  test("darwin/win32 strings normalize to macos/windows", async () => {
    const catalog = createComputerUseCatalog()
    const local = await localManager(catalog, tempDir())
    for (const [reported, expected] of [
      ["darwin", "macos"],
      ["win32", "windows"],
      ["linux", "linux"],
    ] as const) {
      const manager = {
        ids: () => ["c"],
        get: () => ({ id: "c", driver: { getInfo: async () => ({ id: "c", name: "c", platform: reported }) } }),
      } as unknown as ComputerManager
      const service = new ComputerUseService({
        manager,
        local,
        catalog,
        providers: [],
        router: routingNone(),
        settingsFile: join(tempDir(), "computer-use.json"),
      })
      const analysis = await service.analyze({ computerId: "c", operation: "click" })
      expect(analysis.context?.platform).toBe(expected)
    }
  })
})

describe("title-bar geometry is per-platform (all three)", () => {
  const screen = { width: 1920, height: 1080 }

  test("linux/windows ban top-right, macos bans top-left", () => {
    expect(checkTitleBarBan({ point: { x: 1834, y: 45 }, image: screen, platform: "linux" }).banned).toBe(true)
    expect(checkTitleBarBan({ point: { x: 1834, y: 45 }, image: screen, platform: "windows" }).banned).toBe(true)
    expect(checkTitleBarBan({ point: { x: 1834, y: 45 }, image: screen, platform: "macos" }).banned).toBe(false)
    expect(checkTitleBarBan({ point: { x: 20, y: 20 }, image: screen, platform: "macos" }).banned).toBe(true)
    expect(checkTitleBarBan({ point: { x: 20, y: 20 }, image: screen, platform: "linux" }).banned).toBe(false)
    expect(isTitleBarPoint({ x: 1834, y: 45 }, screen, "linux")).toBe(true)
    expect(isTitleBarPoint({ x: 20, y: 20 }, screen, "macos")).toBe(true)
  })

  test("close guard follows the platform side", () => {
    const linuxCloses = findKnownClosePoints(undefined, screen, "linux")
    const macCloses = findKnownClosePoints(undefined, screen, "macos")
    const windowsCloses = findKnownClosePoints(undefined, screen, "windows")
    expect(linuxCloses[0]).toEqual({ x: 1843, y: 45 })
    expect(windowsCloses[0]).toEqual({ x: 1843, y: 45 })
    expect(macCloses[0]).toEqual({ x: 20, y: 20 })
    expect(checkCloseGuard({ x: 1834, y: 45 }, linuxCloses).safe).toBe(false)
    expect(checkCloseGuard({ x: 20, y: 20 }, macCloses).safe).toBe(false)
  })

  test("crop strip follows the platform side", () => {
    expect(titleBarCropFor(screen, "linux")).toEqual({ x: 1520, y: 0, width: 400, height: 120 })
    expect(titleBarCropFor(screen, "windows")).toEqual({ x: 1520, y: 0, width: 400, height: 120 })
    expect(titleBarCropFor(screen, "macos")).toEqual({ x: 0, y: 0, width: 400, height: 120 })
    expect(titleBarCropRegion(screen, "macos")).toEqual({ x: 0, y: 0, width: 400, height: 120 })
    expect(titleBarCropRegion(screen, "linux")).toEqual({ x: 1520, y: 0, width: 400, height: 120 })
  })

  test("validateGroundedPoint respects macos geometry", () => {
    // Linux top-right point is banned on linux but safe on macos.
    expect(validateGroundedPoint({ x: 1834, y: 45, screenshot: screen, platform: "linux" })).toBeDefined()
    expect(validateGroundedPoint({ x: 1834, y: 45, screenshot: screen, platform: "macos" })).toBeUndefined()
    expect(validateGroundedPoint({ x: 20, y: 20, screenshot: screen, platform: "macos" })).toBeDefined()
  })
})
