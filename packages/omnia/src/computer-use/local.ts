import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import { createServer } from "node:net"
import { spawn, execFile } from "node:child_process"
import { once } from "node:events"
import type { ChildProcess } from "node:child_process"
import { promisify } from "node:util"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { detectHardware, estimateCompatibility, formatBytes } from "./hardware"
import {
  createRuntimeCatalog,
  extractArchive,
  flattenRuntimeDirectory,
  runtimeBytes,
  runtimeBytesOnDisk,
  runtimeExecutable,
} from "./runtimes"
import type { EventBus } from "../server/events"
import type {
  ComputerUseModel,
  ComputerUseModelState,
  ComputerUseModelStatus,
  ComputerUseRuntime,
  ComputerUseRuntimeStatus,
  HardwareReport,
  ModelCompatibility,
} from "./types"

const run = promisify(execFile)

export interface LocalRuntimeInfo {
  readonly available: boolean
  readonly command?: string
  readonly backend?: string
  readonly reason?: string
  readonly libraryPaths: readonly string[]
}

export interface LocalModelManagerOptions {
  readonly catalog: readonly ComputerUseModel[]
  readonly modelsDir?: string
  readonly modelDirs?: readonly string[]
  readonly runtimeRoot?: string
  readonly runtimeDirs?: readonly string[]
  readonly runtimeCatalog?: readonly ComputerUseRuntime[]
  readonly events?: EventBus
  readonly now?: () => number
  readonly idleUnloadMs?: number
  readonly healthTimeoutMs?: number
  readonly fetchImpl?: typeof fetch
  readonly hardware?: HardwareReport
}

interface ModelRuntimeState {
  state: ComputerUseModelState
  progress?: number
  bytesOnDisk?: number
  reason?: string
  lastUsedAt?: number
}

interface ResidentServer {
  modelId: string
  port: number
  process: ChildProcess
  backend: string
  startedAt: number
  stderr: string[]
}

export class LocalModelManager {
  private readonly catalog: readonly ComputerUseModel[]
  private readonly modelsDir: string
  private readonly modelDirs: readonly string[]
  private readonly runtimeRoot: string
  private readonly runtimeDirs: readonly string[]
  private readonly runtimeCatalog: readonly ComputerUseRuntime[]
  private readonly events?: EventBus
  private readonly now: () => number
  private readonly fetchImpl: typeof fetch
  private readonly healthTimeoutMs: number
  private readonly states = new Map<string, ModelRuntimeState>()
  private readonly runtimeStates = new Map<string, ModelRuntimeState>()
  private readonly compatibility = new Map<string, ModelCompatibility>()
  private readonly hardwareOverride?: HardwareReport
  private runtimeCache?: LocalRuntimeInfo
  private hardwareCache?: HardwareReport
  private resident?: ResidentServer
  private idleTimer?: ReturnType<typeof setTimeout>
  private idleUnloadMs: number
  // Single-flight model loading: concurrent ensureLoaded/load calls must not
  // spawn two llama-server processes for the same model.
  private loadTask: { modelId: string; promise: Promise<ComputerUseModelStatus> } | undefined

  constructor(options: LocalModelManagerOptions) {
    this.catalog = options.catalog.filter((model) => model.local)
    this.modelsDir = options.modelsDir ?? process.env.OMNIA_MODELS_DIR ?? join(homedir(), ".omnia", "models")
    this.modelDirs = options.modelDirs ?? [this.modelsDir]
    this.runtimeRoot = options.runtimeRoot ?? join(dirname(this.modelsDir), "runtimes")
    this.runtimeDirs = options.runtimeDirs ?? defaultRuntimeDirs()
    this.runtimeCatalog = options.runtimeCatalog ?? createRuntimeCatalog()
    this.events = options.events
    this.now = options.now ?? Date.now
    this.fetchImpl = options.fetchImpl ?? fetch
    this.healthTimeoutMs = options.healthTimeoutMs ?? 180000
    this.idleUnloadMs = options.idleUnloadMs ?? 300000
    this.hardwareOverride = options.hardware
    for (const model of this.catalog) this.states.set(model.id, { state: "NOT_INSTALLED" })
  }

  set idleTimeout(ms: number) {
    this.idleUnloadMs = ms
    this.scheduleIdleUnload()
  }

  async hardware(): Promise<HardwareReport> {
    this.hardwareCache = this.hardwareCache ?? this.hardwareOverride ?? (await detectHardware())
    return this.hardwareCache
  }

  async runtime(): Promise<LocalRuntimeInfo> {
    if (this.runtimeCache !== undefined) return this.runtimeCache
    const envCommand = process.env.OMNIA_LLAMA_SERVER
    if (envCommand !== undefined && envCommand.length > 0) {
      const probe = await this.probe(envCommand, [])
      this.runtimeCache = {
        available: probe.ok,
        command: envCommand,
        backend: process.env.OMNIA_LLAMA_BACKEND ?? "cpu",
        libraryPaths: [envCommand.replace(/[/\\][^/\\]+$/, "")],
        ...(probe.ok ? {} : { reason: probe.reason }),
      }
      return this.runtimeCache
    }
    const failures: string[] = []
    for (const dir of this.runtimeDirectories()) {
      const command = join(dir, process.platform === "win32" ? "llama-server.exe" : "llama-server")
      if (!existsSync(command)) continue
      const probe = await this.probe(command, [dir])
      if (probe.ok) {
        this.runtimeCache = { available: true, command, backend: backendFromDir(dir), libraryPaths: [dir] }
        return this.runtimeCache
      }
      failures.push(`${dir}: ${probe.reason ?? "probe failed"}`)
    }
    if (failures.length > 0) {
      this.runtimeCache = {
        available: false,
        reason: `Bundled llama.cpp runtimes could not start on this system (${failures.join("; ")}).`,
        libraryPaths: [],
      }
      return this.runtimeCache
    }
    const onPath = await run(process.platform === "win32" ? "where" : "which", ["llama-server"]).catch(() => undefined)
    const located = onPath?.stdout.split("\n")[0]?.trim()
    if (located !== undefined && located.length > 0) {
      const probe = await this.probe(located, [])
      this.runtimeCache = {
        available: probe.ok,
        command: located,
        backend: process.env.OMNIA_LLAMA_BACKEND ?? "cpu",
        libraryPaths: [],
        ...(probe.ok ? {} : { reason: probe.reason }),
      }
      return this.runtimeCache
    }
    this.runtimeCache = {
      available: false,
      reason: "No llama.cpp runtime is bundled or installed. Run the llama.cpp setup to enable local visual models.",
      libraryPaths: [],
    }
    return this.runtimeCache
  }

  private async probe(command: string, libraryPaths: readonly string[]): Promise<{ ok: boolean; reason?: string }> {
    const env = this.libraryPathsEnv(libraryPaths)
    const result = await run(command, ["--version"], { timeout: 15000, env }).then(
      () => ({ ok: true as const }),
      (error: NodeJS.ErrnoException & { stderr?: string }) => ({
        ok: false as const,
        reason: (error.stderr ?? error.message).split("\n")[0] ?? "Runtime probe failed.",
      }),
    )
    return result
  }

  private libraryPathsEnv(extra: readonly string[]): NodeJS.ProcessEnv {
    const existing = (process.env.LD_LIBRARY_PATH ?? "").split(":").filter((entry) => entry.length > 0)
    const paths = [...extra, ...existing]
    return { ...process.env, ...(paths.length === 0 ? {} : { LD_LIBRARY_PATH: paths.join(":") }) }
  }

  list(): ComputerUseModelStatus[] {
    return this.catalog.map((model) => this.statusOf(model))
  }

  status(modelId: string): ComputerUseModelStatus | undefined {
    const model = this.catalog.find((entry) => entry.id === modelId)
    return model === undefined ? undefined : this.statusOf(model)
  }

  private statusOf(model: ComputerUseModel): ComputerUseModelStatus {
    const state = this.states.get(model.id) ?? { state: "NOT_INSTALLED" as const }
    const files = this.modelFiles(model)
    const installed = this.filesInstalled(model)
    const effective = state.state === "NOT_INSTALLED" && installed ? "INSTALLED" : state.state
    return {
      model,
      state: effective,
      installed,
      loaded: this.resident?.modelId === model.id,
      ...(state.progress === undefined ? {} : { progress: state.progress }),
      ...(state.reason === undefined ? {} : { reason: state.reason }),
      ...(state.lastUsedAt === undefined ? {} : { lastUsedAt: state.lastUsedAt }),
      ...(files.bytesOnDisk === undefined ? {} : { bytesOnDisk: files.bytesOnDisk }),
      ...(this.resident?.modelId === model.id ? { runtimeBackend: this.resident.backend } : {}),
    }
  }

  compatibilityReport(): Promise<Array<{ model: ComputerUseModel; compatibility: ModelCompatibility }>> {
    return this.hardware().then((hardware) =>
      this.catalog.map((model) => {
        const compatibility = this.compatibility.get(model.id) ?? estimateCompatibility(model, hardware, hardware.backends)
        this.compatibility.set(model.id, compatibility)
        return { model, compatibility }
      }),
    )
  }

  async verify(modelId: string): Promise<ComputerUseModelStatus | undefined> {
    const model = this.catalog.find((entry) => entry.id === modelId)
    if (model === undefined) return undefined
    const files = this.modelFiles(model)
    if (!files.model.ok) {
      this.setState(model.id, { state: "NOT_INSTALLED", reason: files.model.reason })
      return this.statusOf(model)
    }
    if (files.mmproj !== undefined && !files.mmproj.ok) {
      this.setState(model.id, { state: "FAILED", reason: files.mmproj.reason })
      return this.statusOf(model)
    }
    this.setState(model.id, { state: "INSTALLED", bytesOnDisk: files.bytesOnDisk })
    return this.statusOf(model)
  }

  async verifyAll(): Promise<void> {
    await Promise.all(this.catalog.map((model) => this.verify(model.id)))
  }

  async download(modelId: string): Promise<ComputerUseModelStatus> {
    const model = this.requireModel(modelId)
    if (model.source === undefined) throw new Error(`${model.displayName} does not have a downloadable build.`)
    if (this.filesInstalled(model)) return (await this.verify(modelId))!
    const dir = this.modelDirectory(model)
    mkdirSync(dir, { recursive: true })
    const files = [
      { file: model.source.file, bytes: model.modelSizeBytes, sha256: model.source.sha256 },
      ...(model.source.mmprojFile === undefined
        ? []
        : [{ file: model.source.mmprojFile, bytes: model.source.mmprojBytes, sha256: model.source.mmprojSha256 }]),
    ]
    const totalBytes = (model.modelSizeBytes ?? 0) + (model.source.mmprojBytes ?? 0)
    let downloaded = 0
    this.setState(model.id, { state: "DOWNLOADING", progress: 0 })
    try {
      for (const entry of files) {
        if (!isSha256Pin(entry.sha256)) {
          throw new Error(`Refusing to download ${entry.file}: no SHA-256 checksum is pinned for this artifact.`)
        }
        const target = join(dir, entry.file)
        // A file that is already present is trusted only after its pinned
        // content hash matches; anything else is replaced by a verified
        // download so an unverified copy can never be treated as installed.
        if (existsSync(target) && statSync(target).size > 0) {
          if ((await sha256File(target)) === entry.sha256.toLowerCase()) {
            downloaded += statSync(target).size
            continue
          }
          rmSync(target, { force: true })
        }
        const url = `https://huggingface.co/${model.source.repo}/resolve/main/${encodeURIComponent(entry.file)}`
        await this.downloadFile(url, target, (bytes) => {
          const progress = totalBytes === 0 ? 0 : Math.min(1, (downloaded + bytes) / totalBytes)
          this.setState(model.id, { state: "DOWNLOADING", progress })
        }, entry.bytes, entry.sha256)
        downloaded += statSync(target).size
      }
    } catch (error) {
      this.setState(model.id, {
        state: "FAILED",
        reason: error instanceof Error ? error.message : "Model download failed.",
      })
      throw error
    }
    return (await this.verify(modelId))!
  }

  private async downloadFile(
    url: string,
    target: string,
    onProgress: (bytes: number) => void,
    expectedBytes: number | undefined,
    expectedSha256: string,
  ): Promise<void> {
    // Fail closed: an artifact without a pinned, well-formed sha256 must never
    // be fetched, let alone installed.
    if (!isSha256Pin(expectedSha256)) {
      throw new Error(`Refusing to download ${url}: no SHA-256 checksum is pinned for this artifact.`)
    }
    const part = `${target}.part`
    try {
      const response = await this.fetchImpl(url, { redirect: "follow" })
      if (!response.ok || response.body === null) {
        throw new Error(`Download failed with HTTP ${response.status}.`)
      }
      let written = 0
      const source = Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream)
      source.on("data", (chunk: Buffer) => {
        written += chunk.length
        onProgress(written)
      })
      await pipeline(source, createWriteStream(part))
      const size = statSync(part).size
      if (expectedBytes !== undefined && size < expectedBytes * 0.9) {
        throw new Error(`The downloaded file is incomplete (${formatBytes(size)} of about ${formatBytes(expectedBytes)}).`)
      }
      const digest = await sha256File(part)
      if (digest !== expectedSha256.toLowerCase()) {
        throw new Error(`The downloaded file failed its checksum verification against the pinned SHA-256 (${url}).`)
      }
      renameSync(part, target)
    } catch (error) {
      // Never leave a partial file behind: the next download would treat it
      // as already-installed.
      rmSync(part, { force: true })
      throw error
    }
  }

  async remove(modelId: string): Promise<boolean> {
    const model = this.requireModel(modelId)
    if (this.resident?.modelId === model.id) await this.unload()
    let removed = false
    for (const root of this.modelDirs) {
      const dir = join(root, "computer-use", model.provider)
      if (!existsSync(dir)) continue
      rmSync(dir, { recursive: true, force: true })
      removed = true
    }
    if (!removed) return false
    this.setState(model.id, { state: "NOT_INSTALLED" })
    return true
  }

  private runtimeDirectories(): string[] {
    const downloaded = this.runtimeCatalog
      .filter((runtime) => existsSync(runtimeExecutable(join(this.runtimeRoot, runtime.id))))
      .map((runtime) => join(this.runtimeRoot, runtime.id))
    return [...downloaded, ...this.runtimeDirs]
  }

  private runtimeStatus(runtime: ComputerUseRuntime): ComputerUseRuntimeStatus {
    const dir = join(this.runtimeRoot, runtime.id)
    const state = this.runtimeStates.get(runtime.id) ?? { state: "NOT_INSTALLED" as const }
    const bundledDir = this.runtimeDirs.find((entry) => backendFromDir(entry) === runtime.backend)
    const downloaded = existsSync(runtimeExecutable(dir))
    const bundled = bundledDir !== undefined && existsSync(runtimeExecutable(bundledDir))
    const installed = downloaded || bundled
    const bytesOnDisk = installed ? runtimeBytesOnDisk(downloaded ? dir : bundledDir!) : undefined
    return {
      runtime,
      state: state.state === "NOT_INSTALLED" && installed ? "INSTALLED" : state.state,
      installed,
      bundled,
      bytes: runtimeBytes(runtime),
      ...(state.progress === undefined ? {} : { progress: state.progress }),
      ...(state.reason === undefined ? {} : { reason: state.reason }),
      ...(bytesOnDisk === undefined ? {} : { bytesOnDisk }),
    }
  }

  listRuntimes(): ComputerUseRuntimeStatus[] {
    return this.runtimeCatalog.map((runtime) => this.runtimeStatus(runtime))
  }

  private requireRuntime(runtimeId: string): ComputerUseRuntime {
    const runtime = this.runtimeCatalog.find((entry) => entry.id === runtimeId)
    if (runtime === undefined) throw new Error(`Unknown computer-use runtime ${runtimeId}.`)
    return runtime
  }

  async downloadRuntime(runtimeId: string): Promise<ComputerUseRuntimeStatus> {
    const runtime = this.requireRuntime(runtimeId)
    const dir = join(this.runtimeRoot, runtime.id)
    const totalBytes = runtimeBytes(runtime)
    let downloaded = 0
    mkdirSync(dir, { recursive: true })
    this.setRuntimeState(runtime.id, { state: "DOWNLOADING", progress: 0 })
    try {
      for (const entry of runtime.archives) {
        const target = join(this.runtimeRoot, `${runtime.id}-${basename(new URL(entry.url).pathname)}`)
        await this.downloadFile(entry.url, target, (bytes) => {
          const progress = totalBytes === 0 ? 0 : Math.min(1, (downloaded + bytes) / totalBytes)
          this.setRuntimeState(runtime.id, { state: "DOWNLOADING", progress })
        }, entry.bytes, entry.sha256)
        downloaded += statSync(target).size
        await extractArchive(target, dir)
        rmSync(target, { force: true })
        flattenRuntimeDirectory(dir)
      }
    } catch (error) {
      this.setRuntimeState(runtime.id, {
        state: "FAILED",
        reason: error instanceof Error ? error.message : "Runtime download failed.",
      })
      throw error
    }
    if (!existsSync(runtimeExecutable(dir))) {
      this.setRuntimeState(runtime.id, { state: "FAILED", reason: "The runtime archive did not contain llama-server." })
      throw new Error("The runtime archive did not contain llama-server.")
    }
    this.setRuntimeState(runtime.id, { state: "INSTALLED", bytesOnDisk: runtimeBytesOnDisk(dir) })
    this.runtimeCache = undefined
    return this.runtimeStatus(runtime)
  }

  removeRuntime(runtimeId: string): boolean {
    const runtime = this.requireRuntime(runtimeId)
    const dir = join(this.runtimeRoot, runtime.id)
    if (!existsSync(dir)) return false
    rmSync(dir, { recursive: true, force: true })
    this.setRuntimeState(runtime.id, { state: "NOT_INSTALLED" })
    this.runtimeCache = undefined
    return true
  }

  private setRuntimeState(
    runtimeId: string,
    patch: Partial<ModelRuntimeState> & { state: ComputerUseModelState },
  ): void {
    const previous = this.runtimeStates.get(runtimeId) ?? { state: "NOT_INSTALLED" as const }
    const next = { ...previous, ...patch }
    this.runtimeStates.set(runtimeId, next)
    this.events?.emit("computer_use.runtime", {
      data: {
        runtimeId,
        state: next.state,
        ...(next.progress === undefined ? {} : { progress: Number(next.progress.toFixed(3)) }),
        ...(next.reason === undefined ? {} : { reason: next.reason }),
      },
    })
  }

  load(modelId: string, options: { auto?: boolean } = {}): Promise<ComputerUseModelStatus> {
    const model = this.requireModel(modelId)
    if (this.resident?.modelId === model.id && this.resident.process.exitCode === null) {
      this.touch()
      return Promise.resolve(this.statusOf(model))
    }
    if (this.loadTask !== undefined) {
      if (this.loadTask.modelId === modelId) return this.loadTask.promise
      // A different model is loading: wait for it to settle, then queue ours.
      return this.loadTask.promise.catch(() => undefined).then(() => this.load(modelId, options))
    }
    const promise = this.performLoad(modelId, options).finally(() => {
      if (this.loadTask?.promise === promise) this.loadTask = undefined
    })
    this.loadTask = { modelId, promise }
    return promise
  }

  private async performLoad(modelId: string, options: { auto?: boolean }): Promise<ComputerUseModelStatus> {
    const model = this.requireModel(modelId)
    if (this.resident?.modelId === model.id && this.resident.process.exitCode === null) {
      this.touch()
      return this.statusOf(model)
    }
    const runtime = await this.runtime()
    if (!runtime.available || runtime.command === undefined) {
      throw new Error(runtime.reason ?? "No llama.cpp runtime is available.")
    }
    const hardware = await this.hardware()
    const compatibility = estimateCompatibility(model, hardware, hardware.backends)
    if (!compatibility.compatible) throw new Error(compatibility.reasons.join(" "))
    const files = this.modelFiles(model)
    if (!files.model.ok) throw new Error(files.model.reason)
    if (this.resident !== undefined) await this.unload()
    this.setState(model.id, { state: "STARTING", reason: options.auto === true ? "Automatic model loading." : undefined })
    const port = await freePort()
    const backend = runtime.backend ?? "cpu"
    // Per-model gating invariant: --mmproj is passed only when the catalog
    // entry declares source.mmprojFile (UI-TARS, Moondream), and
    // --chat-template-file only when the entry declares chatTemplate
    // (Moondream). UI-TARS uses its native template, so no template flag is
    // ever passed for it even though both models share this loader.
    const chatTemplate = this.chatTemplateFile(model)
    const args = [
      "-m",
      files.model.path,
      ...(files.mmproj?.path === undefined ? [] : ["--mmproj", files.mmproj.path]),
      ...(chatTemplate === undefined ? [] : ["--chat-template-file", chatTemplate]),
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "-c",
      "4096",
      "-ngl",
      backend === "cpu" ? "0" : "99",
      "--no-webui",
      "--log-disable",
    ]
    const child = spawn(runtime.command, args, {
      cwd: dirname(files.model.path),
      env: this.libraryPathsEnv(runtime.libraryPaths),
      stdio: ["ignore", "ignore", "pipe"],
    })
    const resident: ResidentServer = {
      modelId: model.id,
      port,
      process: child,
      backend,
      startedAt: this.now(),
      stderr: [],
    }
    child.stderr?.on("data", (chunk: Buffer) => {
      resident.stderr.push(chunk.toString())
      if (resident.stderr.length > 40) resident.stderr.shift()
    })
    this.resident = resident
    this.setState(model.id, { state: "LOADING" })
    const ready = await this.waitForHealth(port)
    if (!ready.ok) {
      await this.unload()
      // Keep the raw stderr tail out of client-visible strings: it can contain
      // filesystem paths and environment details. The reason is already
      // generic; the tail stays in the (now discarded) resident buffer.
      this.setState(model.id, { state: "FAILED", reason: ready.reason })
      throw new Error(`${model.displayName} failed to start: ${ready.reason}`)
    }
    this.setState(model.id, { state: "READY", lastUsedAt: this.now() })
    this.events?.emit("computer_use.model", { data: { modelId: model.id, state: "READY", backend } })
    this.touch()
    return this.statusOf(model)
  }

  private async waitForHealth(port: number): Promise<{ ok: boolean; reason?: string }> {
    const deadline = this.now() + this.healthTimeoutMs
    while (this.now() < deadline) {
      if (this.resident?.process.exitCode !== null && this.resident?.process.exitCode !== undefined) {
        return { ok: false, reason: `The inference server exited with code ${this.resident.process.exitCode}.` }
      }
      const response = await this.fetchImpl(`http://127.0.0.1:${port}/health`).catch(() => undefined)
      if (response?.ok === true) {
        const body = (await response.json().catch(() => ({}))) as { status?: string }
        if (body.status === "ok") return { ok: true }
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    return { ok: false, reason: "Timed out while waiting for the inference server to become ready." }
  }

  async unload(): Promise<void> {
    const resident = this.resident
    if (resident === undefined) return
    this.resident = undefined
    this.clearIdleTimer()
    this.setState(resident.modelId, { state: "UNLOADING" })
    resident.process.kill("SIGTERM")
    const exited = await Promise.race([
      once(resident.process, "exit").then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
    ])
    if (!exited) resident.process.kill("SIGKILL")
    this.setState(resident.modelId, { state: "INSTALLED" })
    this.events?.emit("computer_use.model", { data: { modelId: resident.modelId, state: "INSTALLED" } })
  }

  async ensureLoaded(modelId: string, options: { auto?: boolean } = {}): Promise<LocalRuntimeInfo & { port: number }> {
    const status = this.status(modelId)
    if (status === undefined) throw new Error(`Unknown model ${modelId}.`)
    if (this.resident?.modelId !== modelId || this.resident.process.exitCode !== null) {
      await this.load(modelId, options)
    }
    if (this.resident === undefined) throw new Error(`Model ${modelId} is not loaded.`)
    this.touch()
    const runtime = await this.runtime()
    return { ...runtime, port: this.resident.port }
  }

  chatPort(): number | undefined {
    return this.resident?.port
  }

  residentModelId(): string | undefined {
    return this.resident?.modelId
  }

  async chat(
    messages: readonly { role: string; content: unknown }[],
    options: { maxTokens?: number; temperature?: number; timeoutMs?: number } = {},
  ): Promise<{ text: string; usage?: Record<string, unknown> }> {
    if (this.resident === undefined) throw new Error("No local model is loaded.")
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 120000)
    const response = await this.fetchImpl(`http://127.0.0.1:${this.resident.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages,
        max_tokens: options.maxTokens ?? 512,
        temperature: options.temperature ?? 0,
        stream: false,
      }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer))
    if (!response.ok) throw new Error(`Local inference failed with HTTP ${response.status}.`)
    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>
      usage?: Record<string, unknown>
    }
    const text = body.choices?.[0]?.message?.content ?? ""
    this.touch()
    const residentId = this.resident?.modelId
    const current = residentId === undefined ? undefined : this.states.get(residentId)
    if (residentId !== undefined && current !== undefined) {
      this.states.set(residentId, { ...current, lastUsedAt: this.now() })
    }
    return { text, ...(body.usage === undefined ? {} : { usage: body.usage }) }
  }

  private chatTemplateFile(model: ComputerUseModel): string | undefined {
    if (model.chatTemplate === undefined || model.chatTemplate.length === 0) return undefined
    const file = join(this.modelDirectory(model), "chat-template.jinja")
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, model.chatTemplate)
      return file
    } catch {
      return undefined
    }
  }

  private touch(): void {
    this.scheduleIdleUnload()
  }

  private scheduleIdleUnload(): void {
    this.clearIdleTimer()
    if (this.resident === undefined || this.idleUnloadMs <= 0) return
    this.idleTimer = setTimeout(() => {
      void this.unload()
    }, this.idleUnloadMs)
    this.idleTimer.unref?.()
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer)
    this.idleTimer = undefined
  }

  private requireModel(modelId: string): ComputerUseModel {
    const model = this.catalog.find((entry) => entry.id === modelId)
    if (model === undefined) throw new Error(`Unknown local model ${modelId}.`)
    return model
  }

  private modelDirectory(model: ComputerUseModel): string {
    return join(this.modelsDir, "computer-use", model.provider)
  }

  private modelFiles(model: ComputerUseModel): {
    model: { ok: boolean; path: string; reason: string }
    mmproj?: { ok: boolean; path: string; reason: string }
    bytesOnDisk?: number
  } {
    if (model.source === undefined) {
      return {
        model: { ok: false, path: this.modelDirectory(model), reason: `${model.displayName} has no downloadable files.` },
      }
    }
    let fallback:
      | {
          model: { ok: boolean; path: string; reason: string }
          mmproj?: { ok: boolean; path: string; reason: string }
        }
      | undefined
    for (const root of this.modelDirs) {
      const dir = join(root, "computer-use", model.provider)
      const modelPath = join(dir, model.source.file)
      const modelCheck = checkFile(modelPath, model.modelSizeBytes)
      const mmprojPath = model.source.mmprojFile === undefined ? undefined : join(dir, model.source.mmprojFile)
      const mmprojCheck =
        mmprojPath === undefined
          ? undefined
          : checkFile(mmprojPath, model.source.mmprojBytes)
      const candidate = {
        model: { ...modelCheck, path: modelPath },
        ...(mmprojPath === undefined || mmprojCheck === undefined ? {} : { mmproj: { ...mmprojCheck, path: mmprojPath } }),
      }
      if (modelCheck.ok && (mmprojCheck === undefined || mmprojCheck.ok)) {
        const bytesOnDisk =
          statSync(modelPath).size + (mmprojCheck?.ok === true ? statSync(mmprojPath!).size : 0)
        return { ...candidate, ...(bytesOnDisk === 0 ? {} : { bytesOnDisk }) }
      }
      fallback = fallback ?? candidate
    }
    return (
      fallback ?? {
        model: { ok: false, path: this.modelDirectory(model), reason: `${model.displayName} has no downloadable files.` },
      }
    )
  }

  private filesInstalled(model: ComputerUseModel): boolean {
    const files = this.modelFiles(model)
    return files.model.ok && (files.mmproj === undefined || files.mmproj.ok)
  }

  private setState(modelId: string, patch: Partial<ModelRuntimeState> & { state: ComputerUseModelState }): void {
    const previous = this.states.get(modelId) ?? { state: "NOT_INSTALLED" as const }
    const next = { ...previous, ...patch }
    this.states.set(modelId, next)
    this.events?.emit("computer_use.model", {
      data: {
        modelId,
        state: next.state,
        ...(next.progress === undefined ? {} : { progress: Number(next.progress.toFixed(3)) }),
        ...(next.reason === undefined ? {} : { reason: next.reason }),
      },
    })
  }
}

function checkFile(path: string, expectedBytes?: number): { ok: boolean; reason: string } {
  if (!existsSync(path)) return { ok: false, reason: "Model file is not installed." }
  const size = statSync(path).size
  if (size === 0) return { ok: false, reason: "Model file is empty." }
  if (expectedBytes !== undefined && size < expectedBytes * 0.9) {
    return {
      ok: false,
      reason: `Model file is incomplete (${formatBytes(size)} of about ${formatBytes(expectedBytes)}).`,
    }
  }
  return { ok: true, reason: "" }
}

async function freePort(): Promise<number> {
  const server = createServer()
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  const port = typeof address === "object" && address !== null ? address.port : 0
  server.close()
  return port
}

function backendFromDir(dir: string): string {
  if (/cuda/i.test(dir)) return "cuda"
  if (/vulkan/i.test(dir)) return "vulkan"
  if (/metal/i.test(dir)) return "metal"
  if (/rocm|hip/i.test(dir)) return "rocm"
  return "cpu"
}

function defaultRuntimeDirs(): string[] {
  const root = process.env.OMNIA_LLAMA_DIR
  if (root === undefined || root.length === 0) return []
  try {
    return readdirSync(root)
      .filter((entry) => entry.startsWith("linux") || entry.startsWith("darwin") || entry.startsWith("win"))
      .map((entry) => join(root, entry))
  } catch {
    // A stale/unreadable env dir must not crash the constructor.
    return []
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256")
  const stream = createReadStream(path)
  for await (const chunk of stream) hash.update(chunk as Buffer)
  return hash.digest("hex")
}

function isSha256Pin(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value)
}
