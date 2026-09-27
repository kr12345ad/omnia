import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import type { EventBus } from "../server/events"
import type { ComputerManager, ExecuteOutcome, ServerActionRequest } from "../server/computers"
import type { OmniaScope } from "../server/permissions"
import type { Observation } from "../protocol"
import type { LocalModelManager } from "./local"
import {
  checkCloseGuard,
  checkTitleBarBan,
  effectiveAllowTitleBarClicks,
  findKnownClosePoints,
  isCropPath,
  isTitleBarTarget,
  isWindowManagementIntent,
  windowManagementFallback,
  windowManagementFallbackReason,
} from "./window-safety"
import type {
  ComputerUseAction,
  ComputerUseContext,
  ComputerUseModel,
  ComputerUseModelStatus,
  ComputerUseRuntimeStatus,
  ComputerUseOperation,
  ComputerUseProvider,
  ComputerUseRequest,
  ComputerUseResult,
  ComputerUseRouter,
  ComputerUseSettings,
  ComputerUseStatus,
  ImageReference,
  RoutingDecision,
  SemanticElement,
  SemanticEnvironment,
} from "./types"

export interface ComputerUseServiceOptions {
  readonly manager: ComputerManager
  readonly local: LocalModelManager
  readonly router: ComputerUseRouter
  readonly providers: readonly ComputerUseProvider[]
  readonly catalog: readonly ComputerUseModel[]
  readonly events?: EventBus
  readonly settingsFile?: string
  readonly now?: () => number
}

export interface AnalyzeInput {
  readonly computerId: string
  readonly operation: ComputerUseOperation
  readonly targetDescription?: string
  readonly taskContext?: string
  readonly question?: string
  readonly timeoutMs?: number
  readonly screenshot?: ImageReference
}

export interface PerformInput extends AnalyzeInput {
  readonly sessionId?: string
  readonly execute?: boolean
  readonly approve?: boolean
  readonly approvedBy?: string
  readonly approvedScopes?: readonly OmniaScope[]
}

export interface ComputerUseAnalysis {
  readonly decision: RoutingDecision
  readonly result: ComputerUseResult
  readonly fallbacks: number
  readonly errorCode?: string
}

export interface ComputerUseExecution {
  readonly outcome: ExecuteOutcome
  readonly verified: boolean
}

export interface ComputerUsePerformResult {
  readonly analysis: ComputerUseAnalysis
  readonly execution?: ComputerUseExecution
}

export const DEFAULT_COMPUTER_USE_SETTINGS: ComputerUseSettings = {
  mode: "automatic",
  allowDownloads: false,
  allowAutoLoad: true,
  allowRemoteScreen: false,
  // Local vision on CPU is prompt-bound and can legitimately take tens of
  // seconds; the router still prefers semantic when it is available.
  maxLatencyMs: 120000,
  maxRetries: 1,
  idleUnloadMs: 300000,
}

export class ComputerUseService {
  private readonly options: ComputerUseServiceOptions
  private settingsValue: ComputerUseSettings
  private readonly telemetry = new Map<string, { calls: number; successes: number; failures: number; totalLatencyMs: number }>()
  private readonly now: () => number

  constructor(options: ComputerUseServiceOptions) {
    this.options = options
    this.now = options.now ?? Date.now
    this.settingsValue = loadSettings(options.settingsFile)
    options.local.idleTimeout = this.settingsValue.idleUnloadMs
  }

  settings(): ComputerUseSettings {
    return this.settingsValue
  }

  updateSettings(patch: unknown): ComputerUseSettings {
    const body = typeof patch === "object" && patch !== null ? (patch as Record<string, unknown>) : {}
    const next: ComputerUseSettings = {
      ...this.settingsValue,
      ...(body.mode === "automatic" || body.mode === "local_only" || body.mode === "hosted_only" || body.mode === "ask" ? { mode: body.mode } : {}),
      ...(typeof body.preferredLocalModel === "string" ? { preferredLocalModel: body.preferredLocalModel } : {}),
      ...(typeof body.preferredHostedProvider === "string" ? { preferredHostedProvider: body.preferredHostedProvider } : {}),
      ...(typeof body.allowDownloads === "boolean" ? { allowDownloads: body.allowDownloads } : {}),
      ...(typeof body.allowAutoLoad === "boolean" ? { allowAutoLoad: body.allowAutoLoad } : {}),
      ...(typeof body.allowRemoteScreen === "boolean" ? { allowRemoteScreen: body.allowRemoteScreen } : {}),
      ...(typeof body.maxMemoryBytes === "number" ? { maxMemoryBytes: body.maxMemoryBytes } : {}),
      ...(typeof body.maxLatencyMs === "number" ? { maxLatencyMs: body.maxLatencyMs } : {}),
      ...(typeof body.maxRetries === "number" ? { maxRetries: Math.max(0, Math.min(3, Math.round(body.maxRetries))) } : {}),
      ...(typeof body.idleUnloadMs === "number" ? { idleUnloadMs: Math.max(0, Math.round(body.idleUnloadMs)) } : {}),
      ...(typeof body.allowTitleBarClicks === "boolean" ? { allowTitleBarClicks: body.allowTitleBarClicks } : {}),
    }
    this.settingsValue = next
    this.options.local.idleTimeout = next.idleUnloadMs
    if (this.options.settingsFile !== undefined) {
      mkdirSync(dirname(this.options.settingsFile), { recursive: true })
      writeFileSync(this.options.settingsFile, JSON.stringify(next, null, 2))
    }
    this.options.events?.emit("computer_use.settings", { data: { ...next } })
    return next
  }

  async models(): Promise<ComputerUseModelStatus[]> {
    const local = this.options.local.list()
    const hosted = this.options.catalog
      .filter((model) => !model.local)
      .map((model): ComputerUseModelStatus => ({ model, state: "READY", installed: true, loaded: false, reason: "Hosted provider." }))
    return [...local, ...hosted]
  }

  async providers(): Promise<Array<{ id: string; name: string; local: boolean; available: boolean; reason?: string; capabilities: unknown }>> {
    const context = this.baseContext()
    return Promise.all(
      this.options.providers.map(async (provider) => {
        const capabilities = await provider.getCapabilities()
        const available = await provider.isAvailable(context)
        return {
          id: provider.id,
          name: provider.name,
          local: capabilities.local,
          available,
          capabilities,
          ...(available ? {} : { reason: "Not available on this computer right now." }),
        }
      }),
    )
  }

  async status(): Promise<ComputerUseStatus> {
    const runtime = await this.options.local.runtime()
    const hardware = await this.options.local.hardware()
    const providers = await this.providers()
    const installed = this.options.local.list().filter((status) => status.installed)
    return {
      mode: this.settingsValue.mode,
      semanticAvailable: true,
      localRuntime: {
        available: runtime.available,
        ...(runtime.command === undefined ? {} : { command: runtime.command }),
        ...(runtime.backend === undefined ? {} : { backend: runtime.backend }),
        ...(runtime.reason === undefined ? {} : { reason: runtime.reason }),
      },
      ...(this.options.local.residentModelId() === undefined ? {} : { residentModel: this.options.local.residentModelId() }),
      installedModels: installed.length,
      hardware,
      providers: providers.map((provider) => ({
        id: provider.id,
        name: provider.name,
        local: provider.local,
        available: provider.available,
        ...(provider.reason === undefined ? {} : { reason: provider.reason }),
      })),
    }
  }

  route(context: ComputerUseContext): Promise<RoutingDecision> {
    return this.options.router.route(context)
  }

  async analyze(input: AnalyzeInput): Promise<ComputerUseAnalysis> {
    const context = await this.buildContext(input)
    // P0 fallback: window-management intents (minimize/focus) default to
    // keyboard/semantic instead of full-screen vision clicks. This runs before
    // routing so UI-TARS is never asked to resolve 9px Minimize/Close targets.
    const windowFallback = await this.windowManagementFallback(input, context)
    if (windowFallback !== undefined) return windowFallback
    // P0 ban (pre-grounding): deflect full-screen requests that explicitly
    // target title-bar window controls unless via crop path or opt-in.
    const preBan = checkTitleBarBan({
      targetDescription: input.targetDescription,
      taskContext: input.taskContext,
      image: context.image,
      allowTitleBarClicks: effectiveAllowTitleBarClicks({
        preferences: context.preferences,
        settings: this.settingsValue,
      }),
    })
    // Only pre-ban when there is no grounded point yet AND the target itself
    // names a title-bar control. Generic clicks that merely land in the
    // title-bar are caught post-grounding below.
    if (preBan.banned && isTitleBarTarget(input.targetDescription, input.taskContext)) {
      const decision: RoutingDecision = {
        provider: "none",
        local: false,
        reason: ["title-bar ban: full-screen vision grounding for window controls is disabled", preBan.reason ?? ""],
        candidates: [],
        semanticCoverage: context.semanticContext?.coverage ?? 0,
        operation: input.operation,
        weights: { capabilityMatch: 0.3, quality: 0.25, hardwareFit: 0.2, latencyScore: 0.1, privacyScore: 0.1, costScore: 0.05 },
      }
      return {
        decision,
        fallbacks: 0,
        errorCode: "title_bar_ban",
        result: {
          success: false,
          provider: "none",
          confidence: 0.15,
          reasoning: preBan.reason ?? "Title-bar vision click banned.",
          latencyMs: 0,
        },
      }
    }
    const decision = await this.options.router.route(context)
    this.options.events?.emit("computer_use.routed", {
      data: { provider: decision.provider, model: decision.model, local: decision.local, operation: input.operation, coverage: decision.semanticCoverage },
    })
    if (decision.provider === "none") {
      return {
        decision,
        fallbacks: 0,
        errorCode: decision.blockedByPolicy === true ? "visual_provider_blocked_by_policy" : "no_visual_provider",
        result: {
          success: false,
          provider: "none",
          confidence: 0,
          reasoning: decision.reason.join("; "),
          latencyMs: 0,
        },
      }
    }
    const request: ComputerUseRequest = {
      computerId: input.computerId,
      requestedOperation: input.operation,
      ...(input.targetDescription === undefined ? {} : { targetDescription: input.targetDescription }),
      ...(input.taskContext === undefined ? {} : { taskContext: input.taskContext }),
      ...(input.question === undefined ? {} : { question: input.question }),
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      ...(context.image === undefined ? {} : { screenshot: context.image }),
      ...(context.semanticContext === undefined ? {} : { semanticContext: context.semanticContext }),
    }
    const attempts = this.attemptOrder(decision, input)
    let fallbacks = 0
    let last: ComputerUseResult | undefined
    for (const providerId of attempts) {
      const provider = this.options.providers.find((entry) => entry.id === providerId)
      if (provider === undefined) continue
      const result = await provider.analyze(request, context)
      this.record(provider.id, result)
      if (result.success) {
        // P0 enforcement: never return a risky title-bar click for execution.
        // Ban: full-screen point in the window-control region (unless crop/opt-in).
        // Guard: any point within 25px of Close-X (15px unsafe with ±10px jitter).
        const unsafe = this.validateActionPoint(result, request, context)
        if (unsafe !== undefined) {
          const rejected: ComputerUseResult = {
            success: false,
            provider: result.provider,
            ...(result.model === undefined ? {} : { model: result.model }),
            confidence: 0.15,
            reasoning: unsafe,
            evidence: [...(result.evidence ?? []), "rejected: vision point too close to window controls; requires crop/refine or keyboard fallback"],
            latencyMs: result.latencyMs,
          }
          this.record(provider.id, rejected)
          // Do not fall through to another vision provider for the same
          // risky target; require crop/refine or keyboard/semantic instead.
          return { decision, result: rejected, fallbacks, errorCode: "title_bar_ban" }
        }
        this.options.events?.emit("computer_use.analyzed", {
          data: { provider: result.provider, model: result.model, operation: input.operation, confidence: result.confidence, latencyMs: result.latencyMs, fallbacks },
        })
        return { decision, result, fallbacks }
      }
      last = result
      fallbacks += 1
      if (fallbacks > this.settingsValue.maxRetries) break
    }
    return {
      decision,
      fallbacks,
      result: last ?? { success: false, provider: "none", confidence: 0, reasoning: "No provider produced a result.", latencyMs: 0 },
    }
  }

  async perform(input: PerformInput): Promise<ComputerUsePerformResult> {
    const analysis = await this.analyze(input)
    if (input.execute === false || !analysis.result.success || analysis.result.action === undefined) {
      return { analysis }
    }
    // Defense-in-depth: never execute a risky title-bar click even if a
    // provider bypassed analyze-time validation.
    const unsafe = this.validateActionPoint(
      analysis.result,
      {
        computerId: input.computerId,
        requestedOperation: input.operation,
        ...(input.targetDescription === undefined ? {} : { targetDescription: input.targetDescription }),
        ...(input.taskContext === undefined ? {} : { taskContext: input.taskContext }),
      },
      await this.buildContext(input),
    )
    if (unsafe !== undefined) {
      return {
        analysis: {
          decision: analysis.decision,
          fallbacks: analysis.fallbacks,
          errorCode: "title_bar_ban",
          result: {
            success: false,
            provider: analysis.result.provider,
            ...(analysis.result.model === undefined ? {} : { model: analysis.result.model }),
            confidence: 0.15,
            reasoning: unsafe,
            latencyMs: analysis.result.latencyMs,
          },
        },
      }
    }
    const request = actionRequest(analysis.result.action)
    if (request === undefined) return { analysis }
    const outcome = await this.options.manager.execute(input.computerId, {
      ...request,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.approve === undefined ? {} : { approve: input.approve }),
      ...(input.approvedBy === undefined ? {} : { approvedBy: input.approvedBy }),
      ...(input.approvedScopes === undefined ? {} : { approvedScopes: input.approvedScopes }),
    })
    const verified = isVerified(outcome.result.verification)
    this.options.events?.emit("computer_use.executed", {
      data: {
        provider: analysis.result.provider,
        model: analysis.result.model,
        action: request.action,
        success: outcome.result.success,
        verified,
      },
    })
    return { analysis, execution: { outcome, verified } }
  }

  async loadModel(id: string): Promise<ComputerUseModelStatus> {
    const status = await this.options.local.load(id)
    return status
  }

  async unloadModel(id: string): Promise<boolean> {
    if (this.options.local.residentModelId() !== id) return false
    await this.options.local.unload()
    return true
  }

  async downloadModel(id: string): Promise<ComputerUseModelStatus> {
    if (!this.settingsValue.allowDownloads) {
      throw new Error("Model downloads are disabled in computer-use settings.")
    }
    return this.options.local.download(id)
  }

  removeModel(id: string): Promise<boolean> {
    return this.options.local.remove(id)
  }

  runtimes(): ComputerUseRuntimeStatus[] {
    return this.options.local.listRuntimes()
  }

  async downloadRuntime(id: string): Promise<ComputerUseRuntimeStatus> {
    if (!this.settingsValue.allowDownloads) {
      throw new Error("Model downloads are disabled in computer-use settings.")
    }
    return this.options.local.downloadRuntime(id)
  }

  removeRuntime(id: string): Promise<boolean> {
    return Promise.resolve(this.options.local.removeRuntime(id))
  }

  diagnostics(): Record<string, unknown> {
    return {
      settings: this.settingsValue,
      residentModel: this.options.local.residentModelId(),
      telemetry: Object.fromEntries(
        [...this.telemetry.entries()].map(([provider, entry]) => [
          provider,
          {
            ...entry,
            averageLatencyMs: entry.calls === 0 ? 0 : Math.round(entry.totalLatencyMs / entry.calls),
          },
        ]),
      ),
    }
  }

  // P0: window-management intents bypass vision entirely. Try semantic
  // resolution first (authoritative when present), else return a keyboard
  // fallback (Super+Down / Cmd+M for minimize, Alt+Tab for focus). Never
  // routes to UI-TARS for full-screen title-bar targets unless crop/opt-in.
  private async windowManagementFallback(
    input: AnalyzeInput,
    context: ComputerUseContext,
  ): Promise<ComputerUseAnalysis | undefined> {
    const allowTitleBarClicks = effectiveAllowTitleBarClicks({ preferences: context.preferences, settings: this.settingsValue })
    if (allowTitleBarClicks) return undefined
    if (isCropPath(context.image)) return undefined
    if (!isWindowManagementIntent(input.targetDescription, input.taskContext)) return undefined
    const decision: RoutingDecision = {
      provider: "semantic",
      local: true,
      reason: [
        `operation ${input.operation}`,
        "window-management intent defaults to keyboard/semantic instead of full-screen vision click",
        "title-bar ban: 9px Minimize/Close separation vs ±10px UI-TARS jitter",
      ],
      candidates: [
        {
          provider: "semantic",
          local: true,
          score: 0.95,
          factors: { capabilityMatch: 1, quality: 0.9, hardwareFit: 1, latencyScore: 1, privacyScore: 1, costScore: 1 },
        },
      ],
      semanticCoverage: context.semanticContext?.coverage ?? 0,
      operation: input.operation,
      weights: { capabilityMatch: 0.3, quality: 0.25, hardwareFit: 0.2, latencyScore: 0.1, privacyScore: 0.1, costScore: 0.05 },
    }
    // Prefer semantic resolution when the environment names the window.
    const semantic = this.options.providers.find((entry) => entry.id === "semantic")
    if (semantic !== undefined) {
      const request: ComputerUseRequest = {
        computerId: input.computerId,
        requestedOperation: input.operation,
        ...(input.targetDescription === undefined ? {} : { targetDescription: input.targetDescription }),
        ...(input.taskContext === undefined ? {} : { taskContext: input.taskContext }),
        ...(context.image === undefined ? {} : { screenshot: context.image }),
        ...(context.semanticContext === undefined ? {} : { semanticContext: context.semanticContext }),
      }
      const semanticResult = await semantic.analyze(request, context).catch(() => undefined)
      if (semanticResult?.success === true && semanticResult.action !== undefined) {
        const unsafe = this.validateActionPoint(semanticResult, request, context)
        if (unsafe === undefined) {
          this.record(semantic.id, semanticResult)
          this.options.events?.emit("computer_use.analyzed", {
            data: { provider: semanticResult.provider, operation: input.operation, confidence: semanticResult.confidence, latencyMs: semanticResult.latencyMs, fallbacks: 0 },
          })
          return { decision, result: semanticResult, fallbacks: 0 }
        }
      }
    }
    const action = windowManagementFallback({
      targetDescription: input.targetDescription,
      taskContext: input.taskContext,
      platform: context.platform,
    })
    const reasoning = windowManagementFallbackReason({
      targetDescription: input.targetDescription,
      taskContext: input.taskContext,
      platform: context.platform,
    })
    const result: ComputerUseResult = {
      success: true,
      provider: "semantic",
      action,
      confidence: 0.9,
      reasoning,
      evidence: ["keyboard/semantic fallback for window management; no vision click attempted"],
      latencyMs: 0,
    }
    this.record("semantic", result)
    return { decision, result, fallbacks: 0 }
  }

  // Central P0 validation for any grounded action before it is returned or
  // executed. Returns an error requiring crop/refine when unsafe, undefined
  // when safe. Crop path and explicit allowTitleBarClicks bypass the ban;
  // the 25px Close guard still applies (explicit Close intents exempted).
  private validateActionPoint(
    result: ComputerUseResult,
    request: ComputerUseRequest,
    context: ComputerUseContext,
  ): string | undefined {
    const x = result.action?.target?.x
    const y = result.action?.target?.y
    // Keyboard/semantic fallbacks (key actions) carry no point: always safe.
    if (result.action?.type === "key" || (x === undefined || y === undefined)) return undefined
    const allowTitleBarClicks = effectiveAllowTitleBarClicks({ preferences: context.preferences, settings: this.settingsValue })
    const ban = checkTitleBarBan({
      point: { x, y },
      targetDescription: request.targetDescription,
      taskContext: request.taskContext,
      image: request.screenshot ?? context.image,
      allowTitleBarClicks,
    })
    if (ban.banned) return ban.reason
    const haystack = `${request.targetDescription ?? ""} ${request.taskContext ?? ""}`
    if (/clos(e|ing)\b/i.test(haystack)) return undefined
    const image = request.screenshot ?? context.image
    const closePoints = findKnownClosePoints(request.semanticContext?.elements ?? context.semanticContext?.elements, image)
    const guard = checkCloseGuard({ x, y }, closePoints)
    if (!guard.safe && !allowTitleBarClicks) return guard.reason
    return undefined
  }

  private attemptOrder(decision: RoutingDecision, input: AnalyzeInput): string[] {
    const preferred = this.settingsValue.preferredLocalModel
    const eligible = decision.candidates
      .filter((candidate) => candidate.score > 0 && candidate.excluded === undefined)
      .map((candidate) => candidate.provider)
    const ordered = [decision.provider, ...eligible.filter((provider) => provider !== decision.provider)]
    if (preferred !== undefined && !ordered.includes("ui-tars")) ordered.push("ui-tars")
    return ordered.slice(0, 1 + this.settingsValue.maxRetries)
  }

  private record(provider: string, result: ComputerUseResult): void {
    const entry = this.telemetry.get(provider) ?? { calls: 0, successes: 0, failures: 0, totalLatencyMs: 0 }
    entry.calls += 1
    entry.totalLatencyMs += result.latencyMs
    if (result.success) entry.successes += 1
    else entry.failures += 1
    this.telemetry.set(provider, entry)
  }

  private baseContext(): ComputerUseContext {
    return {
      computerId: this.options.manager.ids()[0] ?? "local",
      requestedOperation: "general",
      platform: process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux",
      privacy: { allowRemoteScreen: this.settingsValue.allowRemoteScreen, mode: this.settingsValue.mode },
    }
  }

  private async buildContext(input: AnalyzeInput): Promise<ComputerUseContext> {
    const platform = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux"
    const semanticContext = await this.semanticEnvironment(input.computerId)
    const image = input.screenshot ?? (await this.capture(input.computerId))
    return {
      computerId: input.computerId,
      requestedOperation: input.operation,
      ...(input.targetDescription === undefined ? {} : { targetDescription: input.targetDescription }),
      platform,
      ...(image === undefined ? {} : { image }),
      ...(semanticContext === undefined ? {} : { semanticContext }),
      privacy: { allowRemoteScreen: this.settingsValue.allowRemoteScreen, mode: this.settingsValue.mode },
      preferences: {
        ...(this.settingsValue.preferredLocalModel === undefined ? {} : { preferredLocalModel: this.settingsValue.preferredLocalModel }),
        ...(this.settingsValue.preferredHostedProvider === undefined ? {} : { preferredHostedProvider: this.settingsValue.preferredHostedProvider }),
        ...(this.settingsValue.maxLatencyMs === undefined ? {} : { maxLatencyMs: this.settingsValue.maxLatencyMs }),
        ...(this.settingsValue.maxMemoryBytes === undefined ? {} : { maxMemoryBytes: this.settingsValue.maxMemoryBytes }),
        allowAutoLoad: this.settingsValue.allowAutoLoad,
        maxRetries: this.settingsValue.maxRetries,
        ...(this.settingsValue.allowTitleBarClicks === undefined ? {} : { allowTitleBarClicks: this.settingsValue.allowTitleBarClicks }),
      },
    }
  }

  private async capture(computerId: string): Promise<ImageReference | undefined> {
    const computer = this.options.manager.get(computerId)
    if (computer === undefined) return undefined
    const captured = await computer.driver.execute({ type: "screenshot" })
    const path = typeof captured.metadata?.path === "string" ? captured.metadata.path : undefined
    if (path === undefined || !existsSync(path)) return undefined
    const size = pngSize(path)
    return { path, width: size?.width ?? 1920, height: size?.height ?? 1080 }
  }

  private async semanticEnvironment(computerId: string): Promise<SemanticEnvironment | undefined> {
    const computer = this.options.manager.get(computerId)
    if (computer === undefined) return undefined
    const observation = await computer.driver.observe().catch(() => undefined as Observation | undefined)
    if (observation === undefined) return undefined
    const elements = (observation.elements ?? []).map((element) => ({
      ...(element.reference?.elementId === undefined && element.id === undefined
        ? {}
        : { elementId: element.reference?.elementId ?? element.id }),
      ...(element.role === undefined ? {} : { role: element.role }),
      ...(element.name === undefined ? {} : { name: element.name }),
      ...(element.text === undefined ? {} : { text: element.text }),
      ...(element.bounds === undefined ? {} : { bounds: element.bounds }),
      ...(element.states === undefined ? {} : { states: element.states }),
      ...(element.source === undefined ? {} : { source: element.source as SemanticElement["source"] }),
    }))
    const controls = elements.filter(
      (element) => element.bounds !== undefined && element.source === "accessibility" && CONTROL_ROLES.has((element.role ?? "").toLowerCase()),
    ).length
    const coverage = Math.min(1, controls / 20)
    const applicationId = typeof observation.metadata?.applicationId === "string" ? observation.metadata.applicationId : undefined
    const windowTitle = typeof observation.metadata?.windowTitle === "string" ? observation.metadata.windowTitle : undefined
    return {
      coverage,
      elements,
      ...(applicationId === undefined ? {} : { applicationId }),
      ...(windowTitle === undefined ? {} : { windowTitle }),
      ...(observation.backend === undefined ? {} : { backend: observation.backend }),
    }
  }
}

const CONTROL_ROLES = new Set([
  "button",
  "push button",
  "toggle button",
  "entry",
  "text",
  "menu item",
  "check box",
  "radio button",
  "combo box",
  "list item",
  "page tab",
  "slider",
  "spin button",
  "link",
  "tree item",
  "table cell",
])

function isVerified(verification: { verified?: boolean; passed?: boolean; ok?: boolean; status?: string } | undefined): boolean {
  if (verification === undefined) return false
  return verification.verified === true || verification.passed === true || verification.ok === true || verification.status === "verified"
}

function actionRequest(action: ComputerUseAction): ServerActionRequest | undefined {
  const x = action.target?.x
  const y = action.target?.y
  const path = action.path
  switch (action.type) {
    case "click":
      return x === undefined || y === undefined ? undefined : { action: "click", x, y }
    case "double_click":
      return x === undefined || y === undefined ? undefined : { action: "doubleclick", x, y }
    case "right_click":
      return x === undefined || y === undefined ? undefined : { action: "rightclick", x, y }
    case "type":
      return action.text === undefined
        ? undefined
        : { action: "type", text: action.text, ...(x === undefined || y === undefined ? {} : { x, y }) }
    case "key":
      return action.key === undefined ? undefined : { action: "key", key: action.key }
    case "scroll":
      return { action: "scroll", direction: action.direction ?? "down", ...(x === undefined || y === undefined ? {} : { x, y }) }
    case "drag":
    case "resize": {
      const from = path?.[0] ?? (x === undefined || y === undefined ? undefined : { x, y })
      const to = path?.[1]
      if (from === undefined || to === undefined) return undefined
      return { action: "drag", from, to }
    }
    default:
      return undefined
  }
}

function pngSize(path: string): { width: number; height: number } | undefined {
  const buffer = readFileSync(path)
  if (buffer.length < 24 || buffer.toString("ascii", 12, 16) !== "IHDR") return undefined
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

function loadSettings(file?: string): ComputerUseSettings {
  if (file === undefined || !existsSync(file)) return DEFAULT_COMPUTER_USE_SETTINGS
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"))
  const body = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {}
  return {
    ...DEFAULT_COMPUTER_USE_SETTINGS,
    ...(body.mode === "automatic" || body.mode === "local_only" || body.mode === "hosted_only" || body.mode === "ask" ? { mode: body.mode } : {}),
    ...(typeof body.preferredLocalModel === "string" ? { preferredLocalModel: body.preferredLocalModel } : {}),
    ...(typeof body.preferredHostedProvider === "string" ? { preferredHostedProvider: body.preferredHostedProvider } : {}),
    ...(typeof body.allowDownloads === "boolean" ? { allowDownloads: body.allowDownloads } : {}),
    ...(typeof body.allowAutoLoad === "boolean" ? { allowAutoLoad: body.allowAutoLoad } : {}),
    ...(typeof body.allowRemoteScreen === "boolean" ? { allowRemoteScreen: body.allowRemoteScreen } : {}),
    ...(typeof body.maxMemoryBytes === "number" ? { maxMemoryBytes: body.maxMemoryBytes } : {}),
    ...(typeof body.maxLatencyMs === "number" ? { maxLatencyMs: body.maxLatencyMs } : {}),
    ...(typeof body.maxRetries === "number" ? { maxRetries: body.maxRetries } : {}),
    ...(typeof body.idleUnloadMs === "number" ? { idleUnloadMs: body.idleUnloadMs } : {}),
    ...(typeof body.allowTitleBarClicks === "boolean" ? { allowTitleBarClicks: body.allowTitleBarClicks } : {}),
  }
}

export function defaultComputerUseSettingsFile(): string {
  return join(homedir(), ".local", "share", "omnia", "computer-use.json")
}
