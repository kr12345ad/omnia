import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import type { EventBus } from "../server/events"
import type { ComputerManager, ExecuteOutcome, ServerActionRequest } from "../server/computers"
import type { OmniaScope } from "../server/permissions"
import type { Observation } from "../protocol"
import { defaultEntitlementGate, type EntitlementGate } from "../cua/entitlements"
import type {
  CuaAction,
  CuaActionResult,
  CuaBackend,
  CuaCapabilities,
  CuaElement,
  CuaFindQuery,
  CuaSnapshot,
  CuaSnapshotOptions,
  CuaWaitCondition,
  CuaWaitResult,
} from "../cua/types"
import type { LocalModelManager } from "./local"
import type { CalibrationManager } from "./calibration"
import { DefaultComputerUseRouter } from "./router"
import { SemanticProvider } from "./providers"
import {
  checkCloseGuard,
  checkTitleBarBan,
  effectiveAllowTitleBarClicks,
  extractWindowTitleFragment,
  findKnownClosePoints,
  isCropPath,
  isFocusIntent,
  isMinimizeIntent,
  isRestoreIntent,
  isTitleBarPoint,
  isTitleBarTarget,
  isWindowFocusIntent,
  isWindowManagementIntent,
  resolveWindowTitleFragment,
  titleBarThresholds,
  windowManagementFallback,
  windowManagementFallbackReason,
} from "./window-safety"
import type {
  ComputerUseAction,
  ComputerUseContext,
  ComputerUseErrorCode,
  ComputerUseModel,
  ComputerUseModelStatus,
  ComputerUsePlatform,
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
import { isComputerUseErrorCode } from "./types"
import { MATCH_THRESHOLD } from "./match-score"

export interface ComputerUseServiceOptions {
  readonly manager: ComputerManager
  readonly local: LocalModelManager
  readonly router: ComputerUseRouter
  readonly providers: readonly ComputerUseProvider[]
  readonly catalog: readonly ComputerUseModel[]
  readonly events?: EventBus
  readonly settingsFile?: string
  readonly now?: () => number
  // Display calibration for vision point execution. When present, explicit
  // visual points are routed through the same affine transform as every other
  // pointer path; when a calibrated profile exists but is inapplicable to the
  // current screen the service refuses instead of executing uncalibrated.
  readonly calibration?: CalibrationManager
  // Entitlement gate for paid capabilities. Omitted in most embeddings, in
  // which case the process-wide gate resolves from the environment, so
  // enforcement never depends on this constructor being threaded.
  readonly entitlements?: EntitlementGate
}

export interface AnalyzeInput {
  readonly computerId: string
  readonly operation: ComputerUseOperation
  readonly targetDescription?: string
  readonly taskContext?: string
  readonly question?: string
  readonly text?: string
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
  readonly context?: ComputerUseContext
}

export interface ComputerUseExecution {
  readonly outcome: ExecuteOutcome
  readonly verified: boolean
  // Why the verdict is what it is: what the action had to show and what the
  // post-action observation actually showed. An absent observation is
  // `not_verified` with reason "no_post_observation"; it is never a pass.
  readonly confirmation?: ActionConfirmation
}

export interface ActionConfirmation {
  readonly status: "verified" | "not_verified"
  readonly method: "active-window" | "element-state-change" | "execution-verification"
  readonly expected?: {
    readonly title?: string
    readonly ref?: string
    readonly windowId?: string
    readonly states?: readonly string[]
  }
  readonly observed?: {
    readonly title?: string
    readonly ref?: string
    readonly windowId?: string
    readonly states?: readonly string[]
    readonly value?: string
  }
  readonly reason?: string
}

export interface ComputerUsePerformResult {
  readonly analysis: ComputerUseAnalysis
  readonly execution?: ComputerUseExecution
}

export interface CuaDriverAdapter {
  readonly backend?: string
  readonly available: boolean
  readonly capabilities?: CuaCapabilities
  readonly snapshot?: (options?: CuaSnapshotOptions) => Promise<CuaSnapshot>
  readonly find?: (query: CuaFindQuery, snapshot?: CuaSnapshot) => Promise<CuaElement[]>
  readonly act?: (action: CuaAction, snapshot?: CuaSnapshot) => Promise<CuaActionResult>
  readonly wait?: (condition: CuaWaitCondition) => Promise<CuaWaitResult>
}

export interface CuaEngineStatus {
  readonly available: boolean
  readonly backend?: string
  readonly capabilities: readonly string[]
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
    // Wire the per-computer `cua_` capability probe into the semantic provider
    // and the router. Both are constructed before the service in server.ts, so
    // injection here keeps the public constructor contracts unchanged.
    const cuaProbe = (context?: ComputerUseContext) => this.cuaCapabilities(context?.computerId)
    const semantic = options.providers.find((provider) => provider.id === "semantic")
    if (semantic instanceof SemanticProvider) semantic.setCuaProbe(cuaProbe)
    if (options.router instanceof DefaultComputerUseRouter) options.router.cua = cuaProbe
  }

  settings(): ComputerUseSettings {
    return this.settingsValue
  }

  updateSettings(patch: unknown): ComputerUseSettings {
    const body = typeof patch === "object" && patch !== null ? (patch as Record<string, unknown>) : {}
    const next = normalizeSettings({ ...this.settingsValue, ...body }, this.settingsValue)
    this.settingsValue = next
    this.options.local.idleTimeout = next.idleUnloadMs
    if (this.options.settingsFile !== undefined) {
      mkdirSync(dirname(this.options.settingsFile), { recursive: true })
      // Atomic replace so a crash mid-write cannot leave a truncated/corrupt
      // settings file for the next boot to trip over.
      const temporary = `${this.options.settingsFile}.tmp`
      writeFileSync(temporary, JSON.stringify(next, null, 2), { mode: 0o600 })
      renameSync(temporary, this.options.settingsFile)
    }
    this.options.events?.emit("computer_use.settings", { data: { ...next } })
    return next
  }

  async models(): Promise<ComputerUseModelStatus[]> {
    const local = this.options.local.list()
    const context = await this.baseContext()
    const hosted = await Promise.all(
      this.options.catalog
        .filter((model) => !model.local)
        .map(async (model): Promise<ComputerUseModelStatus> => {
          const provider = this.options.providers.find((entry) => entry.id === model.provider)
          const available = provider === undefined ? false : await provider.isAvailable(context)
          return {
            model,
            state: available ? "READY" : "DISABLED",
            installed: available,
            loaded: false,
            reason: available ? "Hosted provider." : "No endpoint is configured for this hosted provider.",
          }
        }),
    )
    return [...local, ...hosted]
  }

  async providers(): Promise<Array<{ id: string; name: string; local: boolean; available: boolean; reason?: string; capabilities: unknown }>> {
    const context = await this.baseContext()
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

  async status(): Promise<ComputerUseStatus & { cua?: CuaEngineStatus }> {
    const runtime = await this.options.local.runtime()
    const hardware = await this.options.local.hardware()
    const providers = await this.providers()
    const installed = this.options.local.list().filter((status) => status.installed)
    const cua = await this.cuaStatus()
    return {
      mode: this.settingsValue.mode,
      semanticAvailable: providers.some((provider) => provider.id === "semantic" && provider.available),
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
      ...(cua === undefined ? {} : { cua }),
    }
  }

  route(context: ComputerUseContext): Promise<RoutingDecision> {
    return this.options.router.route(context)
  }

  cuaDriver(computerId: string): Promise<CuaDriverAdapter | undefined> {
    return cuaDriverFor(this.options.manager.get(computerId)?.driver)
  }

  private async cuaCapabilities(computerId?: string): Promise<CuaCapabilities | undefined> {
    const ids = computerId === undefined ? this.options.manager.ids() : [computerId]
    const reports = await Promise.all(ids.map((id) => cuaCapabilitiesForDriver(this.options.manager.get(id)?.driver)))
    return reports.find((report) => report !== undefined)
  }

  private async cuaStatus(): Promise<CuaEngineStatus | undefined> {
    const reports = await Promise.all(
      this.options.manager.ids().map(async (id) => {
        const driver = this.options.manager.get(id)?.driver
        const names = cuaCapabilityNames(driver)
        const adapter = await cuaDriverFor(driver)
        if (adapter === undefined && names.length === 0) return undefined
        return {
          available: adapter?.available ?? names.length > 0,
          ...(adapter?.backend === undefined ? {} : { backend: adapter.backend }),
          capabilities: names,
        }
      }),
    )
    return reports.find((report) => report !== undefined)
  }

  private async cuaWaitFor(computerId: string, result: ComputerUseResult): Promise<CuaWaitResult | undefined> {
    const adapter = await this.cuaDriver(computerId)
    if (adapter?.wait === undefined || !adapter.available) return undefined
    const condition = waitConditionFor(result)
    if (condition === undefined) return undefined
    return await adapter.wait(condition).catch(() => undefined)
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
      ...(context.platform === undefined ? {} : { platform: context.platform }),
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
        context,
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
        context,
        result: {
          success: false,
          provider: "none",
          confidence: 0,
          reasoning: decision.reason.join("; "),
          latencyMs: 0,
        },
      }
    }
    // The vision fallback is the paid capability. Exactly one cloud_vision
    // check per action, taken here — after routing (so a semantic action never
    // spends a unit) and before any provider runs (so a refusal never depends
    // on which provider the router happened to pick, and a fallback chain
    // cannot turn one action into several checks).
    if (decision.provider !== "semantic") {
      const refusal = await this.refuseWithoutCloudVision(decision, context)
      if (refusal !== undefined) return refusal
    }
    const request: ComputerUseRequest = {
      computerId: input.computerId,
      requestedOperation: input.operation,
      ...(input.targetDescription === undefined ? {} : { targetDescription: input.targetDescription }),
      ...(input.taskContext === undefined ? {} : { taskContext: input.taskContext }),
      ...(input.question === undefined ? {} : { question: input.question }),
      ...(input.text === undefined ? {} : { text: input.text }),
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
      // A throwing provider must not abort the whole analysis: degrade it to a
      // failed result and let the remaining providers in attemptOrder run.
      const result = await provider.analyze(request, context).catch(
        (): ComputerUseResult => ({
          success: false,
          provider: provider.id,
          confidence: 0,
          reasoning: `${provider.name} failed to analyze the request.`,
          latencyMs: 0,
        }),
      )
      this.record(provider.id, result)
      if (result.success) {
        // Single logical-pixel contract: vision models ground in screenshot
        // (device) pixels, but every execution path uses logical pixels.
        // Convert exactly once here; screenshot space stays for crop/region
        // math only (already applied in parse.ts via region offset).
        const logicalScreen = await this.logicalScreenFor(input.computerId)
        const logical = result.action === undefined ? { action: undefined, converted: false as const } : this.toLogicalAction(result.action, context.image, logicalScreen)
        const logicalResult: ComputerUseResult =
          logical.action === undefined || !logical.converted
            ? result
            : {
                ...result,
                action: logical.action,
                evidence: [...(result.evidence ?? []), `retina: screenshot ${context.image?.width}x${context.image?.height} to logical ${logicalScreen?.width}x${logicalScreen?.height}`],
                metadata: { ...(result.metadata ?? {}), logical: true },
              }
        // P0 enforcement: never return a risky title-bar click for execution.
        // Ban: full-screen point in the window-control region (unless crop/opt-in).
        // Guard: any point within 25px of Close-X (15px unsafe with ±10px jitter).
        // Validation runs in logical space with the controlled platform.
        const unsafe = this.validateActionPoint(logicalResult, request, context, logicalScreen)
        if (unsafe !== undefined) {
          // Do not fall through to another vision provider for the same
          // risky target; require crop/refine or keyboard/semantic instead.
          return {
            decision,
            fallbacks,
            errorCode: "title_bar_ban",
            context,
            result: {
              success: false,
              provider: result.provider,
              ...(result.model === undefined ? {} : { model: result.model }),
              confidence: 0.15,
              reasoning: unsafe,
              evidence: [...(result.evidence ?? []), "rejected: vision point too close to window controls; requires crop/refine or keyboard fallback"],
              latencyMs: result.latencyMs,
            },
          }
        }
        this.options.events?.emit("computer_use.analyzed", {
          data: { provider: logicalResult.provider, model: logicalResult.model, operation: input.operation, confidence: logicalResult.confidence, latencyMs: logicalResult.latencyMs, fallbacks },
        })
        return { decision, result: logicalResult, fallbacks, context }
      }
      last = result
      fallbacks += 1
      if (fallbacks > this.settingsValue.maxRetries) break
    }
    return {
      decision,
      fallbacks,
      errorCode: "no_provider_result",
      context,
      result: last ?? { success: false, provider: "none", confidence: 0, reasoning: "No provider produced a result.", latencyMs: 0 },
    }
  }

  async perform(input: PerformInput): Promise<ComputerUsePerformResult> {
    const analysis = await this.analyze(input)
    if (input.execute === false || !analysis.result.success || analysis.result.action === undefined) {
      return { analysis }
    }
    const performContext = analysis.context ?? (await this.buildContext(input))
    const logicalScreen = await this.logicalScreenFor(input.computerId)
    // Defense-in-depth: never execute a risky title-bar click even if a
    // provider bypassed analyze-time validation. Validation runs in logical
    // space with the controlled platform.
    const unsafe = this.validateActionPoint(
      analysis.result,
      {
        computerId: input.computerId,
        requestedOperation: input.operation,
        ...(input.targetDescription === undefined ? {} : { targetDescription: input.targetDescription }),
        ...(input.taskContext === undefined ? {} : { taskContext: input.taskContext }),
      },
      performContext,
      logicalScreen,
    )
    if (unsafe !== undefined) {
      return {
        analysis: {
          decision: analysis.decision,
          fallbacks: analysis.fallbacks,
          errorCode: "title_bar_ban",
          context: analysis.context,
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
    // Calibration: route the (already logical) visual point through the same
    // affine transform as every other pointer path. A calibrated profile that
    // is stale or inapplicable refuses instead of executing uncalibrated.
    const calibrated = this.calibrateAction(analysis.result.action, logicalScreen)
    if ("error" in calibrated) {
      return {
        analysis: {
          decision: analysis.decision,
          fallbacks: analysis.fallbacks,
          errorCode: "calibration_stale",
          context: analysis.context,
          result: {
            ...analysis.result,
            success: false,
            errorCode: "calibration_stale",
            reasoning: calibrated.error,
          },
        },
      }
    }
    const calibratedResult: ComputerUseResult =
      calibrated.action === analysis.result.action
        ? analysis.result
        : {
            ...analysis.result,
            action: calibrated.action,
            evidence: [...(analysis.result.evidence ?? []), "calibration: applied display profile to visual point"],
            metadata: { ...(analysis.result.metadata ?? {}), calibrated: true },
          }
    // Pass the matched accessibility ref through so the driver can execute by
    // stable id instead of replaying pixels.
    const request = calibratedResult.action === undefined ? undefined : actionRequest(calibratedResult.action, calibratedResult.metadata)
    if (request === undefined) {
      // A provider can return success for an action that cannot be expressed as
      // an executable request (for example a drag with no end point). Surface
      // it as a failure instead of reporting a successful no-op.
      return {
        analysis: {
          ...analysis,
          errorCode: "unexecutable_action",
          result: {
            ...analysis.result,
            success: false,
            errorCode: "unexecutable_action",
            reasoning: `${analysis.result.reasoning ?? "The action"} could not be converted into an executable request.`,
          },
        },
      }
    }
    const baseRequest = {
      ...request,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.approve === undefined ? {} : { approve: input.approve }),
      ...(input.approvedBy === undefined ? {} : { approvedBy: input.approvedBy }),
      ...(input.approvedScopes === undefined ? {} : { approvedScopes: input.approvedScopes }),
    }
    // A ref-based action can only be confirmed by reading the element it
    // targeted before and after, so the pre-action read happens here. Vision
    // points and keyboard actions verify through the execution record instead
    // (see confirmExecution).
    const beforeObservation =
      request.target?.kind === "element" ? await this.observeForVerification(input.computerId) : undefined
    const outcome = await this.options.manager.execute(input.computerId, baseRequest)
    // Honest verification: a provider `verified` flag is a claim, not evidence.
    // The verdict comes from a post-action observation, and anything that
    // cannot be confirmed — including "no observation was taken" — is
    // not_verified with what was expected and what was seen attached.
    const confirm = (executed: ExecuteOutcome): Promise<ActionConfirmation> =>
      this.confirmExecution({
        computerId: input.computerId,
        result: calibratedResult,
        outcome: executed,
        context: performContext,
        ...(beforeObservation === undefined ? {} : { before: beforeObservation }),
      })
    let confirmation = await confirm(outcome)
    let verified = confirmation.status === "verified"
    // Prefer the Cua wait_for primitive over sleep+re-observe when the engine
    // exposes it and the action did not verify on its own.
    const waited = verified ? undefined : await this.cuaWaitFor(input.computerId, calibratedResult)
    let finalOutcome = outcome
    let retried = false
    // Bounded post-action verification + one re-observe/retry for
    // vision-driven clicks when unverified (default on). Vision points have no
    // accessibility ref to verify against, so an unverified click must not be
    // claimed as success: re-observe once, retry once, then refuse.
    const verifyEnabled = this.settingsValue.verifyVisionClicks !== false
    if (!verified && verifyEnabled && isVisionPointAction(calibratedResult)) {
      // Re-observe to settle the fresh state before the single retry. A
      // failed observation must not block the retry itself.
      await this.options.manager.get(input.computerId)?.driver.observe?.().catch(() => undefined)
      const retryOutcome = await this.options.manager.execute(input.computerId, baseRequest)
      retried = true
      const retryVerified = isVerified(retryOutcome.result.verification) || retryOutcome.result.metadata?.verified === true
      if (retryVerified) {
        finalOutcome = retryOutcome
        // The reported evidence has to describe the outcome that is reported, so
        // the confirmation comes from the retry and never from the first attempt.
        confirmation = await confirm(retryOutcome)
        verified = confirmation.status === "verified"
      } else if (retryOutcome.result.success === true) {
        // Still unverified after the bounded retry: refuse rather than claim
        // success. The retry outcome becomes the execution for evidence.
        finalOutcome = retryOutcome
        const metadata = retryOutcome.result.metadata ?? {}
        const result: ComputerUseResult = {
          ...calibratedResult,
          success: false,
          errorCode: "verification_failed",
          reasoning: "The vision click did not verify after re-observation and one retry; refusing rather than claiming success. Re-observe with computer_observe and retry with a refined target.",
          metadata: {
            ...calibratedResult.metadata,
            verified: false,
            retried: true,
            executionStatus: retryOutcome.result.status ?? "success",
            ...(typeof metadata.delivery === "string" ? { delivery: metadata.delivery } : {}),
            ...(isRecord(metadata.stateDelta) ? { stateDelta: metadata.stateDelta } : {}),
            ...(waited === undefined ? {} : { waitedMs: waited.waitedMs }),
            confirmation,
          },
        }
        this.options.events?.emit("computer_use.executed", {
          data: {
            provider: calibratedResult.provider,
            model: calibratedResult.model,
            action: request.action,
            success: false,
            verified: false,
            ...(typeof metadata.delivery === "string" ? { delivery: metadata.delivery } : {}),
          },
        })
        return { analysis: { ...analysis, result }, execution: { outcome: finalOutcome, verified: false, confirmation } }
      } else {
        // The retry itself failed at execution: fall through to the normal
        // failure path with the retry outcome.
        finalOutcome = retryOutcome
      }
    }
    const metadata = finalOutcome.result.metadata ?? {}
    const executed = finalOutcome.result.success === true
    const executionError = finalOutcome.result.error
    const executionCode = typeof executionError === "object" && executionError !== null ? executionError.code : undefined
    const errorCode: ComputerUseErrorCode | undefined = executed ? undefined : isComputerUseErrorCode(executionCode) ? executionCode : "execution_failed"
    const errorMessage =
      typeof executionError === "object" && executionError !== null
        ? executionError.message
        : typeof executionError === "string"
          ? executionError
          : undefined
    const result: ComputerUseResult = {
      ...calibratedResult,
      // The execution outcome is authoritative: a denied (403/428) or failed
      // execution must not be reported as ok:true at the API.
      success: calibratedResult.success && executed,
      ...(errorCode === undefined ? {} : { errorCode }),
      ...(executed || errorMessage === undefined ? {} : { reasoning: errorMessage }),
      metadata: {
        ...calibratedResult.metadata,
        verified,
        ...(retried ? { retried: true } : {}),
        executionStatus: finalOutcome.result.status ?? (executed ? "success" : "failed"),
        ...(executionCode === undefined || isComputerUseErrorCode(executionCode) ? {} : { executionErrorCode: executionCode }),
        ...(typeof metadata.delivery === "string" ? { delivery: metadata.delivery } : {}),
        ...(isRecord(metadata.stateDelta) ? { stateDelta: metadata.stateDelta } : {}),
        ...(waited === undefined ? {} : { waitedMs: waited.waitedMs }),
        confirmation,
      },
    }
    this.options.events?.emit("computer_use.executed", {
      data: {
        provider: calibratedResult.provider,
        model: calibratedResult.model,
        action: request.action,
        success: finalOutcome.result.success,
        verified,
        ...(typeof metadata.delivery === "string" ? { delivery: metadata.delivery } : {}),
      },
    })
    return { analysis: { ...analysis, result }, execution: { outcome: finalOutcome, verified, confirmation } }
  }

  // A post-action read of the controlled screen. Prefers the observation the
  // execution itself returned and otherwise takes a fresh one; a failed or
  // unavailable observe resolves to undefined, which the caller must treat as
  // "nothing was observed", never as confirmation.
  private async postActionObservation(computerId: string, outcome: ExecuteOutcome): Promise<Observation | undefined> {
    const observed = outcome.result.observation
    if (observed !== undefined) return observed
    return await this.observeForVerification(computerId)
  }

  private async observeForVerification(computerId: string): Promise<Observation | undefined> {
    const driver = this.options.manager.get(computerId)?.driver
    if (typeof driver?.observe !== "function") return undefined
    return await driver.observe().catch(() => undefined)
  }

  /**
   * Honest verification: a result is `verified` only when a post-action
   * observation confirms it.
   *
   *  - `focus_window` / `activate_app`: the post-action active window (or its
   *    title, case-insensitive) must contain the requested title, or must be
   *    the resolved target window id.
   *  - An action on a resolved ref: the post-action observation must show a
   *    state change attributable to that element (focused / value / states),
   *    compared against the pre-action read.
   *  - Anything else (vision points, keys) falls back to the execution's own
   *    verification record, which the bounded re-observe/retry path above
   *    already refuses when it cannot confirm.
   *
   * The absence of an observation is never a pass: it is `not_verified` with
   * reason "no_post_observation" and whatever was expected attached.
   */
  private async confirmExecution(input: {
    readonly computerId: string
    readonly result: ComputerUseResult
    readonly outcome: ExecuteOutcome
    readonly context: ComputerUseContext
    readonly before?: Observation
  }): Promise<ActionConfirmation> {
    const action = input.result.action
    if (action !== undefined && (action.type === "focus_window" || action.type === "activate_app")) {
      const named = action.window ?? action.text ?? action.target?.label
      // The title the request actually named, not the window the chain resolved
      // to: an over-matched fragment must never verify itself by renaming the
      // expectation to whatever it happened to resolve.
      const requested = typeof input.result.metadata?.focusRequested === "string" && input.result.metadata.focusRequested.length > 0
        ? input.result.metadata.focusRequested
        : named
      return await this.confirmFocus(input, requested, named)
    }
    const ref = typeof input.result.metadata?.elementId === "string" && input.result.metadata.elementId.length > 0
      ? input.result.metadata.elementId
      : undefined
    if (ref !== undefined) return await this.confirmRefChange(input, ref)
    const claimed = isVerified(input.outcome.result.verification) || input.outcome.result.metadata?.verified === true
    return { status: claimed ? "verified" : "not_verified", method: "execution-verification" }
  }

  /**
   * A focus is confirmed only by the post-action active window, and only
   * against the title the request named (`wanted`): the visible title (or the
   * active-window hint) must contain it case-insensitively, or the window the
   * requested title resolves to must be the active one (a renamed or truncated
   * visible title). `resolved` — the window the action actually asked the
   * server to focus — is reported so a mismatch is visible instead of hidden.
   */
  private async confirmFocus(
    input: { readonly computerId: string; readonly outcome: ExecuteOutcome },
    wanted: string | undefined,
    resolved: string | undefined,
  ): Promise<ActionConfirmation> {
    const after = await this.postActionObservation(input.computerId, input.outcome)
    const active = activeWindowFromObservation(after)
    const title = wanted?.trim()
    if (active === undefined) {
      return {
        status: "not_verified",
        method: "active-window",
        reason: "no_post_observation",
        ...(title === undefined ? {} : { expected: { title } }),
      }
    }
    // Authority for the verdict is the requested title; the action's own
    // resolution is evidence of what was attempted, not proof it happened.
    const targetId = windowIdForTitle(after, title)
    const titled = title !== undefined && title.length > 0 && active.title?.toLowerCase().includes(title.toLowerCase()) === true
    const identified = active.id !== undefined && targetId !== undefined && active.id === targetId
    const actedId = windowIdForTitle(after, resolved?.trim())
    return {
      status: titled || identified ? "verified" : "not_verified",
      method: "active-window",
      expected: {
        ...(title === undefined ? {} : { title }),
        ...(actedId === undefined ? {} : { windowId: actedId }),
      },
      observed: {
        ...(active.id === undefined ? {} : { windowId: active.id }),
        ...(active.title === undefined ? {} : { title: active.title }),
      },
    }
  }

  private async confirmRefChange(
    input: {
      readonly computerId: string
      readonly outcome: ExecuteOutcome
      readonly before?: Observation
    },
    ref: string,
  ): Promise<ActionConfirmation> {
    const after = await this.postActionObservation(input.computerId, input.outcome)
    const observed = elementStateById(after, ref)
    if (observed === undefined) {
      // No post-action observation at all (or the element is gone from it):
      // absence is never proof that the click landed.
      return { status: "not_verified", method: "element-state-change", expected: { ref }, reason: "no_post_observation" }
    }
    const before = elementStateById(input.before, ref)
    const changed = before === undefined ? undefined : elementStateChange(before, observed)
    if (changed === undefined) {
      return {
        status: "not_verified",
        method: "element-state-change",
        expected: { ref, ...(before === undefined ? {} : { states: before.states }) },
        observed: { ref, states: observed.states, ...(observed.value === undefined ? {} : { value: observed.value }) },
        reason: "no_state_change_for_ref",
      }
    }
    return {
      status: "verified",
      method: "element-state-change",
      expected: { ref, states: before?.states ?? [] },
      observed: { ref, states: observed.states, ...(observed.value === undefined ? {} : { value: observed.value }) },
    }
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

  /**
   * Refuses the vision fallback when the plan does not include cloud_vision.
   *
   * Returns undefined when the capability is entitled so the caller continues
   * into the provider chain. On refusal it produces a typed failure carrying
   * the capability and the control plane's reason, and it degrades rather than
   * bricks: JSON-only observation (computer_observe / computer_snapshot) needs
   * no vision model and is untouched, so the refusal names it as the way
   * forward instead of reporting an empty observation.
   */
  private async refuseWithoutCloudVision(
    decision: RoutingDecision,
    context: ComputerUseContext,
  ): Promise<ComputerUseAnalysis | undefined> {
    const granted = await this.entitlements().check("cloud_vision")
    if (granted.allowed) return undefined
    const detail = granted.degraded
      ? `${granted.reason} Vision grounding is unavailable while billing cannot be reached.`
      : granted.reason
    return {
      decision: {
        ...decision,
        provider: "none",
        reason: [
          ...decision.reason,
          `cloud_vision is not available: ${detail}`,
          "visual grounding requires cloud_vision; computer_observe still returns the accessibility tree as JSON",
        ],
      },
      fallbacks: 0,
      errorCode: "capability_required",
      context,
      result: {
        success: false,
        provider: "none",
        confidence: 0,
        errorCode: "capability_required",
        reasoning: `Visual grounding needs the cloud_vision capability, which this plan does not include: ${detail} Use computer_observe for JSON-only access to the screen.`,
        latencyMs: 0,
        metadata: {
          capability: "cloud_vision",
          capabilityCode: granted.code,
          capabilityReason: granted.reason,
          entitlement: granted.origin,
          ...(granted.plan === undefined ? {} : { plan: granted.plan }),
        },
      },
    }
  }

  private entitlements(): EntitlementGate {
    return this.options.entitlements ?? defaultEntitlementGate()
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
    // Titled window-focus intents bypass semantic.analyze entirely: the
    // (960,539) regression came from a 0.4 over-match feeding a blind
    // bounds-center click, so a named-window intent never reaches a provider.
    // A focus intent without a title still has to route (it lands on
    // activate_app), so it takes the same chain. The steps below only ever
    // emit a resolvable window action, a P0-safe grounding point on the window
    // body, or a loud failure — never a screen-center click.
    const focusIntent =
      isWindowFocusIntent(input.targetDescription, input.taskContext) ||
      isTitlelessFocusIntent(input.targetDescription, input.taskContext)
    if (focusIntent) {
      return await this.windowFocusRouting(input, context, decision)
    }
    const action = windowManagementFallback({
      targetDescription: input.targetDescription,
      taskContext: input.taskContext,
      platform: context.platform,
    })
    if (action.type === "unsupported") {
      return {
        decision: {
          ...decision,
          provider: "none",
          reason: [...decision.reason, action.text ?? "This window-management intent has no safe keyboard fallback."],
        },
        fallbacks: 0,
        errorCode: "unsupported_window_intent",
        context,
        result: {
          success: false,
          provider: "none",
          confidence: 0.2,
          reasoning: action.text ?? "This window-management intent has no safe keyboard fallback.",
          latencyMs: 0,
        },
      }
    }
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
    return { decision, result, fallbacks: 0, context }
  }

  /**
   * Focus-intent routing. A focus intent never reaches semantic.analyze (its
   * over-match is what produced the (960,539) center-click), so the whole
   * decision is made here:
   *
   *   focus_window(full title) → focus_window(best fragment) → activate_app(app)
   *   → vision-ground the window body (P0-safe, never the title strip)
   *   → fail loudly.
   *
   * An intent that names no title has nothing to resolve, so it skips straight
   * to the application it names. Every step either emits a real window action
   * or stops the chain. A screen-center click is never emitted, and no step
   * claims the window is focused: the post-action observation decides that
   * (see confirmFocus).
   */
  private async windowFocusRouting(
    input: AnalyzeInput,
    context: ComputerUseContext,
    decision: RoutingDecision,
  ): Promise<ComputerUseAnalysis> {
    const titles = await focusTitleCandidates(input.targetDescription, input.taskContext)
    const live = windowTitlesFrom(context)
    // The title the request actually names. An intent that names none ("focus
    // the kitty terminal") has no window to resolve, so it skips the whole
    // title chain and its first step is the application it names. Everything
    // below only ever emits a resolvable window action, a P0-safe grounding
    // point on the window body, or a loud failure — never a screen-center
    // click, and never a claim that the window is focused.
    const requested = extractWindowTitleFragment(input.targetDescription, input.taskContext)
    // Only an intent that names a title runs the title chain; without one there
    // is no window to resolve and the chain starts at the application.
    if (requested !== undefined) {
      const full = titles[0]
      if (full !== undefined) {
        const resolved = resolveWindowTitleFragment(full, live)
        // An unresolved full title still wins when there is no window list to
        // check it against: the server resolves it (or answers window_not_found)
        // authoritatively, and refusing here would refuse every titled intent on
        // a computer with no accessibility tree.
        if (resolved !== undefined || live.length === 0) {
          return this.focusWindowAnalysis(input, decision, context, resolved ?? full, full, requested)
        }
      }
      for (const fragment of titles.slice(1)) {
        const resolved = resolveWindowTitleFragment(fragment, live)
        if (resolved !== undefined) return this.focusWindowAnalysis(input, decision, context, resolved, fragment, requested)
      }
    }
    const app = focusApplication(input.targetDescription, input.taskContext)
    if (app !== undefined) {
      const result: ComputerUseResult = {
        success: true,
        provider: "semantic",
        action: { type: "activate_app", window: app },
        confidence: 0.8,
        reasoning: `Window-focus intent has no resolvable title, so it activates application "${app}" instead of guessing a window.`,
        evidence: [`activate_app: ${app}`, "no title candidate resolved to an open window"],
        metadata: { app, focusIntent: true },
        latencyMs: 0,
      }
      this.record("semantic", result)
      return { decision, result, fallbacks: 0, context }
    }
    const grounded = await this.groundWindowBody(input, context, requested)
    if (grounded !== undefined) {
      const { point, window } = grounded
      const result: ComputerUseResult = {
        success: true,
        provider: "semantic",
        action: { type: "click", target: { x: point.x, y: point.y, label: window.name } },
        confidence: 0.4,
        reasoning: `Window-focus intent could not be resolved by title or application, so it grounds the body of window "${window.name ?? "the target window"}" below the title strip. This is a last resort and is not evidence that the window is focused.`,
        evidence: [
          `aim: bounds-center of the window body (${point.x},${point.y}), never the title strip`,
          "no title candidate or application name resolved to an open window",
        ],
        metadata: { aim: "bounds-center", focusIntent: true, ...(window.elementId === undefined ? {} : { groundedElement: window.elementId }), window: window.name },
        latencyMs: 0,
      }
      this.record("semantic", result)
      return { decision, result, fallbacks: 0, context }
    }
    // Fail loudly: no title, no application, no safe window body to ground.
    // Claiming anything here would be the bug this whole path exists to stop.
    const detail = `${input.targetDescription ?? input.taskContext ?? "focus"}`
    return {
      decision: {
        ...decision,
        provider: "none",
        reason: [
          ...decision.reason,
          "window-focus intent has no resolvable title, application, or safe window body to ground",
        ],
      },
      fallbacks: 0,
      errorCode: "window_not_found",
      context,
      result: {
        success: false,
        provider: "none",
        confidence: 0.15,
        errorCode: "window_not_found",
        reasoning: `The window-focus intent "${detail}" cannot be resolved: no open window matches the named title and no application or safe window body could be derived from it. Observe the screen with computer_observe and name the window by its title, or activate the application directly.`,
        evidence: ["no center-click and no blind window click was attempted for this intent"],
        latencyMs: 0,
      },
    }
  }

  private focusWindowAnalysis(
    input: AnalyzeInput,
    decision: RoutingDecision,
    context: ComputerUseContext,
    window: string,
    tried: string,
    requested: string,
  ): ComputerUseAnalysis {
    const result: ComputerUseResult = {
      success: true,
      provider: "semantic",
      action: { type: "focus_window", window },
      confidence: 0.9,
      reasoning: `Window-focus intent routes to focus_window "${window}" instead of a semantic center-click (named-window intents never click).`,
      evidence: [
        `focus_window title: ${window}`,
        `requested title: ${requested}`,
        ...(tried === requested ? [] : [`resolved from candidate: ${tried}`]),
      ],
      // The title the request named is what post-action verification compares
      // the active window against, so an over-matched candidate cannot verify
      // itself by renaming the expectation.
      metadata: { focusWindow: window, focusRequested: requested, focusIntent: true },
      latencyMs: 0,
    }
    this.record("semantic", result)
    this.options.events?.emit("computer_use.analyzed", {
      data: { provider: result.provider, operation: input.operation, confidence: result.confidence, latencyMs: 0, fallbacks: 0 },
    })
    return { decision, result, fallbacks: 0, context }
  }

  /**
   * Last-resort grounding for a focus intent: a point inside the target
   * window's body, never in the title strip, never the screen center. A
   * window that covers the whole screen has no body to ground (its center is
   * the screen center, which is the wrong-element path this replaces), so it
   * resolves to undefined and the chain fails loudly instead.
   */
  private async groundWindowBody(
    input: AnalyzeInput,
    context: ComputerUseContext,
    requested: string | undefined,
  ): Promise<{ point: { x: number; y: number }; window: SemanticElement } | undefined> {
    const image = context.image
    const logicalScreen = (await this.logicalScreenFor(input.computerId)) ?? image
    if (logicalScreen === undefined) return undefined
    const windows = (context.semanticContext?.elements ?? []).filter((element) => WINDOW_ROLES.has((element.role ?? "").toLowerCase()))
    if (windows.length === 0) return undefined
    const candidates = await titleMatchedWindows(windows, requested)
    if (candidates.length === 0) return undefined
    const closePoints = findKnownClosePoints(context.semanticContext?.elements, image, context.platform)
    const allowed = candidates.flatMap((element) => {
      const point = windowBodyPoint(element, image, context.platform)
      if (point === undefined) return []
      // A window that fills the screen has no usable body: its center is the
      // screen center the (960,539) regression clicked.
      const bounds = element.bounds
      if (
        bounds !== undefined &&
        image !== undefined &&
        bounds.x <= 0 &&
        bounds.y <= 0 &&
        bounds.width >= image.width &&
        bounds.height >= image.height
      ) {
        return []
      }
      const screenCenter = { x: logicalScreen.width / 2, y: logicalScreen.height / 2 }
      if (Math.abs(point.x - screenCenter.x) <= 25 && Math.abs(point.y - screenCenter.y) <= 25) return []
      const guard = checkCloseGuard(point, closePoints)
      return guard.safe ? [{ point, window: element }] : []
    })
    return allowed[0]
  }

  // Central P0 validation for any grounded action before it is returned or
  // executed. Returns an error requiring crop/refine when unsafe, undefined
  // when safe. A trusted server crop or explicit allowTitleBarClicks bypasses
  // the ban; the 25px Close guard still applies (explicit Close intents
  // exempted). Points are always logical pixels; thresholds use the logical
  // screen when known so Retina device pixels never shift the ban region.
  private validateActionPoint(
    result: ComputerUseResult,
    request: ComputerUseRequest,
    context: ComputerUseContext,
    logicalScreen?: { width: number; height: number },
  ): string | undefined {
    const x = result.action?.target?.x
    const y = result.action?.target?.y
    // Keyboard/semantic fallbacks (key/focus_window/activate_app) carry no
    // point: always safe.
    if (result.action?.type === "key" || result.action?.type === "focus_window" || result.action?.type === "activate_app" || (x === undefined || y === undefined))
      return undefined
    const allowTitleBarClicks = effectiveAllowTitleBarClicks({ preferences: context.preferences, settings: this.settingsValue })
    // The provider's own high-resolution crop path marks its result with
    // metadata.path === "crop"; that is a trusted server crop (the caller
    // cannot forge it through the request screenshot region).
    const cropped = result.metadata?.path === "crop"
    const deviceImage = request.screenshot ?? context.image
    // Logical contract: validate in logical space. When the logical screen is
    // known, derive thresholds from it; otherwise fall back to the screenshot
    // size (scale 1). Crop bypass still applies via serverCrop/crop flag.
    const logicalImage =
      logicalScreen === undefined
        ? deviceImage
        : {
            width: logicalScreen.width,
            height: logicalScreen.height,
            ...(deviceImage?.serverCrop === true ? { serverCrop: true as const } : {}),
          }
    const ban = checkTitleBarBan({
      point: { x, y },
      targetDescription: request.targetDescription,
      taskContext: request.taskContext,
      image: logicalImage,
      allowTitleBarClicks,
      crop: cropped,
      ...(context.platform === undefined ? {} : { platform: context.platform }),
    })
    if (ban.banned) return ban.reason
    const haystack = `${request.targetDescription ?? ""} ${request.taskContext ?? ""}`
    if (/clos(e|ing)\b/i.test(haystack)) return undefined
    const closePoints = findKnownClosePoints(
      request.semanticContext?.elements ?? context.semanticContext?.elements,
      logicalImage,
      context.platform,
    )
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
    // A preferred local model only re-orders providers the router actually
    // evaluated; never force-append an excluded or unavailable provider.
    if (preferred !== undefined && !ordered.includes("ui-tars") && eligible.includes("ui-tars")) ordered.push("ui-tars")
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

  private async baseContext(): Promise<ComputerUseContext> {
    const computerId = this.options.manager.ids()[0] ?? "local"
    return {
      computerId,
      requestedOperation: "general",
      platform: await this.platformFor(computerId),
      privacy: { allowRemoteScreen: this.settingsValue.allowRemoteScreen, mode: this.settingsValue.mode },
    }
  }

  private async buildContext(input: AnalyzeInput): Promise<ComputerUseContext> {
    // The controlled machine owns the platform: derive it from the
    // computer/driver first, falling back to the server host only when the
    // driver reports nothing usable.
    const platform = await this.platformFor(input.computerId)
    const semanticContext = await this.semanticEnvironment(input.computerId)
    const image = this.normalizeImage(input.screenshot) ?? (await this.capture(input.computerId))
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

  // Caller-provided screenshots are untrusted input: reject non-finite or
  // non-positive dimensions/regions so NaN targets and forged crop regions
  // cannot reach grounding or disable the title-bar ban.
  private normalizeImage(image: ImageReference | undefined): ImageReference | undefined {
    if (image === undefined) return undefined
    if (!Number.isFinite(image.width) || !Number.isFinite(image.height) || image.width <= 0 || image.height <= 0) return undefined
    if (image.region !== undefined) {
      const { x, y, width, height } = image.region
      if (![x, y, width, height].every((value) => Number.isFinite(value)) || width <= 0 || height <= 0) return undefined
      if (x < 0 || y < 0 || x + width > image.width || y + height > image.height) return undefined
    }
    return image
  }

  // The controlled machine owns the platform. Probe the driver's getInfo
  // first; only when the driver is missing or reports nothing usable fall back
  // to the server host (process.platform). Never infer from the host when the
  // controlled machine is known.
  private async platformFor(computerId?: string): Promise<ComputerUsePlatform> {
    if (computerId !== undefined) {
      const driver = this.options.manager.get(computerId)?.driver as
        | { getInfo?: () => Promise<unknown> }
        | undefined
      if (driver?.getInfo !== undefined) {
        const info = await driver.getInfo().catch(() => undefined)
        const normalized = normalizeDriverPlatform(info)
        if (normalized !== undefined) return normalized
      }
      // Some drivers expose platform only through capabilities or a backend
      // string; treat those as hints before falling back to the host.
      const raw = this.options.manager.get(computerId)?.driver as unknown
      const hinted = normalizeDriverPlatform(raw)
      if (hinted !== undefined) return hinted
    }
    return hostPlatform()
  }

  // Logical screen size of the controlled machine, for Retina conversion and
  // logical-space guards. Checks every shape drivers use: top-level
  // screen/display plus metadata.screen (Linux host driver).
  private async logicalScreenFor(computerId: string): Promise<{ width: number; height: number } | undefined> {
    const driver = this.options.manager.get(computerId)?.driver as
      | { getInfo?: () => Promise<unknown> }
      | undefined
    if (driver?.getInfo === undefined) return undefined
    const info = await driver.getInfo().catch(() => undefined)
    return logicalScreenFromInfo(info)
  }

  // One coordinate contract: vision models ground in screenshot (device)
  // pixels, but execution is always logical pixels. Convert exactly once from
  // device to logical; screenshot space stays for crop/region math only.
  private toLogicalAction(
    action: ComputerUseAction,
    image: ImageReference | undefined,
    logicalScreen: { width: number; height: number } | undefined,
  ): { action: ComputerUseAction; converted: boolean } {
    if (image === undefined || logicalScreen === undefined) return { action, converted: false }
    if (!Number.isFinite(image.width) || !Number.isFinite(image.height) || image.width <= 0 || image.height <= 0) {
      return { action, converted: false }
    }
    if (!Number.isFinite(logicalScreen.width) || !Number.isFinite(logicalScreen.height) || logicalScreen.width <= 0 || logicalScreen.height <= 0) {
      return { action, converted: false }
    }
    const scaleX = logicalScreen.width / image.width
    const scaleY = logicalScreen.height / image.height
    // A scale within 1% is not Retina/HiDPI: skip rounding churn.
    if (Math.abs(scaleX - 1) < 0.01 && Math.abs(scaleY - 1) < 0.01) return { action, converted: false }
    if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || scaleX <= 0 || scaleY <= 0) return { action, converted: false }
    const convert = (point: { x: number; y: number }): { x: number; y: number } => ({
      x: Math.round(point.x * scaleX),
      y: Math.round(point.y * scaleY),
    })
    const target = action.target
    const path = action.path
    if ((target?.x === undefined || target?.y === undefined) && path === undefined) return { action, converted: false }
    return {
      action: {
        ...action,
        ...(target === undefined
          ? {}
          : target.x === undefined || target.y === undefined
            ? { target }
            : { target: { ...target, ...convert({ x: target.x, y: target.y }) } }),
        ...(path === undefined ? {} : { path: path.map(convert) }),
      },
      converted: true,
    }
  }

  // Route an explicit visual point through the same display calibration as
  // every other pointer path. Returns the calibrated point, or an error when
  // a calibrated profile exists but is inapplicable (stale screen/TTL or
  // unknown screen): the caller must refuse rather than execute uncalibrated.
  private calibratePoint(
    point: { x: number; y: number },
    logicalScreen: { width: number; height: number } | undefined,
  ): { point: { x: number; y: number } } | { error: string } {
    const calibration = this.options.calibration
    if (calibration === undefined) return { point }
    const status = calibration.status(logicalScreen)
    if (status.profile === undefined) return { point }
    if (logicalScreen === undefined) {
      return {
        error:
          "A display calibration profile exists but the current screen size is unknown, so the visual point cannot be calibrated. Recalibrate or reset calibration before acting.",
      }
    }
    if (status.stale) {
      return {
        error:
          `The display calibration profile is stale for ${logicalScreen.width}x${logicalScreen.height}; recalibrate before acting on visual points.`,
      }
    }
    return { point: calibration.transform(point.x, point.y, logicalScreen) }
  }

  private calibrateAction(
    action: ComputerUseAction,
    logicalScreen: { width: number; height: number } | undefined,
  ): { action: ComputerUseAction } | { error: string } {
    const target = action.target
    const path = action.path
    if ((target?.x === undefined || target?.y === undefined) && path === undefined) return { action }
    if (target !== undefined && target.x !== undefined && target.y !== undefined) {
      const calibrated = this.calibratePoint({ x: target.x, y: target.y }, logicalScreen)
      if ("error" in calibrated) return calibrated
      const nextTarget = { ...target, x: calibrated.point.x, y: calibrated.point.y }
      if (path === undefined) return { action: { ...action, target: nextTarget } }
      const calibratedPath = path.map((entry) => this.calibratePoint(entry, logicalScreen))
      const failed = calibratedPath.find((entry): entry is { error: string } => "error" in entry)
      if (failed !== undefined) return failed
      return {
        action: {
          ...action,
          target: nextTarget,
          path: calibratedPath.map((entry) => (entry as { point: { x: number; y: number } }).point),
        },
      }
    }
    if (path !== undefined) {
      const calibratedPath = path.map((entry) => this.calibratePoint(entry, logicalScreen))
      const failed = calibratedPath.find((entry): entry is { error: string } => "error" in entry)
      if (failed !== undefined) return failed
      return {
        action: {
          ...action,
          path: calibratedPath.map((entry) => (entry as { point: { x: number; y: number } }).point),
        },
      }
    }
    return { action }
  }

  private async capture(computerId: string): Promise<ImageReference | undefined> {
    const computer = this.options.manager.get(computerId)
    if (computer === undefined) return undefined
    const execute = computer.driver.execute
    if (typeof execute !== "function") return undefined
    const captured = await execute({ type: "screenshot" })
    const path = typeof captured.metadata?.path === "string" ? captured.metadata.path : undefined
    if (path === undefined || !existsSync(path)) return undefined
    const size = pngSize(path)
    if (size !== undefined) return { path, width: size.width, height: size.height }
    // A malformed/unreadable PNG must not silently pretend to be 1920x1080:
    // fall back to the driver-reported screen size, or fail the capture.
    const info = await computer.driver.getInfo?.().catch(() => undefined)
    const screen = logicalScreenFromInfo(info)
    if (screen !== undefined) {
      return { path, width: screen.width, height: screen.height }
    }
    return undefined
  }

  private async semanticEnvironment(computerId: string): Promise<SemanticEnvironment | undefined> {
    const computer = this.options.manager.get(computerId)
    if (computer === undefined) return undefined
    const observe = computer.driver.observe
    if (typeof observe !== "function") return undefined
    const observation = await observe().catch(() => undefined as Observation | undefined)
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
      (element) =>
        element.bounds !== undefined &&
        element.source === "accessibility" &&
        CONTROL_ROLES.has((element.role ?? "").toLowerCase()) &&
        // Text nodes are content, not controls: counting them inflated coverage.
        (element.role ?? "").toLowerCase() !== "text",
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

export function actionRequest(
  action: ComputerUseAction,
  metadata?: Readonly<Record<string, unknown>>,
): ServerActionRequest | undefined {
  const elementId =
    typeof metadata?.elementId === "string" && metadata.elementId.length > 0 ? metadata.elementId : undefined
  const target = elementId === undefined ? undefined : { kind: "element" as const, elementId }
  const x = action.target?.x
  const y = action.target?.y
  const path = action.path
  if (action.type === "focus_window") {
    const window = action.window ?? action.target?.label
    return window === undefined || window.length === 0 ? undefined : { action: "focus_window", window }
  }
  if (action.type === "activate_app") {
    const app = action.window ?? action.text ?? action.target?.label
    return app === undefined || app.length === 0 ? undefined : { action: "activate_app", app }
  }
  if (action.type === "focus") {
    return target === undefined ? undefined : { action: "focus", target }
  }
  switch (action.type) {
    case "click":
      if (target !== undefined) return { action: "click", target }
      return x === undefined || y === undefined ? undefined : { action: "click", x, y }
    case "double_click":
      return x === undefined || y === undefined ? undefined : { action: "doubleclick", x, y }
    case "right_click":
      return x === undefined || y === undefined ? undefined : { action: "rightclick", x, y }
    case "type":
      if (action.text === undefined) return undefined
      if (target !== undefined) return { action: "type", text: action.text, target }
      return { action: "type", text: action.text, ...(x === undefined || y === undefined ? {} : { x, y }) }
    case "key":
      return action.key === undefined ? undefined : { action: "key", key: action.key }
    case "scroll":
      return {
        action: "scroll",
        direction: action.direction ?? "down",
        ...(target !== undefined ? { target } : x === undefined || y === undefined ? {} : { x, y }),
      }
    case "set_value":
      return target !== undefined && action.text !== undefined ? { action: "set_value", target, text: action.text } : undefined
    case "select":
    case "expand":
    case "collapse":
    case "toggle":
    case "increment":
    case "decrement":
    case "scroll_into_view":
    case "menu":
      return target === undefined ? undefined : { action: action.type, target }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// Drivers expose the Cua engine either as a backend object on `cua`/`engine`
// (the frozen CuaBackend contract) or as flat `cua*` methods. Both shapes are
// adapted here so the API and router only ever see one interface.
export async function cuaDriverFor(driver: unknown): Promise<CuaDriverAdapter | undefined> {
  if (!isRecord(driver)) return undefined
  const resolved = await resolveCuaBackend(driver)
  const backend = resolved?.backend
  const capabilities = backend === undefined ? undefined : await backend.capabilities().catch(() => undefined)
  const snapshot =
    typeof driver.cuaSnapshot === "function"
      ? (driver.cuaSnapshot as (options?: CuaSnapshotOptions) => Promise<CuaSnapshot>).bind(driver)
      : backend === undefined
        ? undefined
        : (options?: CuaSnapshotOptions) => backend.snapshot(options)
  const find =
    typeof driver.cuaFind === "function"
      ? (driver.cuaFind as (query: CuaFindQuery, snapshot?: CuaSnapshot) => Promise<CuaElement[]>).bind(driver)
      : backend === undefined
        ? undefined
        : (query: CuaFindQuery, snapshot?: CuaSnapshot) => backend.find(query, snapshot)
  const actMethod = typeof driver.cuaAct === "function" ? driver.cuaAct : driver.cuaExecute
  const act =
    typeof actMethod === "function"
      ? (actMethod as (action: CuaAction, snapshot?: CuaSnapshot) => Promise<CuaActionResult>).bind(driver)
      : backend === undefined
        ? undefined
        : (action: CuaAction, snapshot?: CuaSnapshot) => backend.execute(action, snapshot)
  const waitMethod = typeof driver.cuaWait === "function" ? driver.cuaWait : driver.cuaWaitFor
  const wait =
    typeof waitMethod === "function"
      ? (waitMethod as (condition: CuaWaitCondition) => Promise<CuaWaitResult>).bind(driver)
      : backend === undefined
        ? undefined
        : (condition: CuaWaitCondition) => backend.waitFor(condition)
  if (snapshot === undefined && find === undefined && act === undefined && wait === undefined) return undefined
  const available = backend === undefined ? true : await backend.available().catch(() => false)
  return {
    ...(resolved?.name === undefined ? {} : { backend: resolved.name }),
    available,
    ...(capabilities === undefined ? {} : { capabilities }),
    ...(snapshot === undefined ? {} : { snapshot }),
    ...(find === undefined ? {} : { find }),
    ...(act === undefined ? {} : { act }),
    ...(wait === undefined ? {} : { wait }),
  }
}

export function cuaCapabilityNames(driver: unknown): string[] {
  if (!isRecord(driver) || typeof driver.capabilities !== "function") return []
  const entries = (driver.capabilities as () => unknown).call(driver)
  if (!Array.isArray(entries)) return []
  return entries.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.capability !== "string") return []
    // Presence is the signal: only an explicit `unavailable` hides the engine.
    if (entry.status === "unavailable") return []
    return entry.capability.startsWith("cua_") ? [entry.capability] : []
  })
}

export async function cuaCapabilitiesForDriver(driver: unknown): Promise<CuaCapabilities | undefined> {
  const adapter = await cuaDriverFor(driver)
  if (adapter?.capabilities !== undefined) return adapter.capabilities
  const names = cuaCapabilityNames(driver)
  return names.length === 0 ? undefined : synthesizedCuaCapabilities(names)
}

interface ResolvedCuaBackend {
  readonly backend: CuaBackend
  readonly name?: string
}

async function resolveCuaBackend(driver: Record<string, unknown>): Promise<ResolvedCuaBackend | undefined> {
  const candidate = driver.cua ?? driver.cuaEngine ?? driver.engine ?? driver.cuaBackend
  const value = typeof candidate === "function" ? await (candidate as () => Promise<unknown>)().catch(() => undefined) : candidate
  if (!isRecord(value)) return undefined
  if (
    typeof value.snapshot !== "function" ||
    typeof value.find !== "function" ||
    typeof value.execute !== "function" ||
    typeof value.waitFor !== "function"
  ) {
    return undefined
  }
  const name =
    typeof value.name === "string" ? value.name : typeof value.backendName === "string" ? value.backendName : undefined
  return { backend: value as unknown as CuaBackend, ...(name === undefined ? {} : { name }) }
}

function synthesizedCuaCapabilities(names: readonly string[]): CuaCapabilities {
  const has = (name: string) => names.includes(name)
  return {
    snapshot: has("cua_snapshot"),
    semanticActions: has("cua_rich_actions"),
    backgroundActions: has("cua_background"),
    backgroundInput: has("cua_background"),
    pointer: has("cua_rich_actions") || has("cua_background"),
    keyboard: has("cua_rich_actions") || has("cua_background"),
    clipboard: false,
    screenshot: has("cua_snapshot"),
    windowManagement: has("cua_rich_actions"),
    waitFor: has("cua_wait"),
    refs: has("cua_refs"),
    actions: [],
    limits: [],
  }
}

function waitConditionFor(result: ComputerUseResult): CuaWaitCondition | undefined {
  const ref = typeof result.metadata?.elementId === "string" && result.metadata.elementId.length > 0 ? result.metadata.elementId : undefined
  if (ref !== undefined) return { ref, timeoutMs: 1500, pollMs: 100 }
  const name = result.action?.target?.label
  return name === undefined || name.length === 0 ? undefined : { name, timeoutMs: 1500, pollMs: 100 }
}

function pngSize(path: string): { width: number; height: number } | undefined {
  // Read only the 24-byte PNG header instead of the whole screenshot.
  let descriptor: number | undefined
  try {
    descriptor = openSync(path, "r")
    const header = Buffer.alloc(24)
    const read = readSync(descriptor, header, 0, 24, 0)
    if (read < 24 || header.toString("ascii", 12, 16) !== "IHDR") return undefined
    return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) }
  } catch {
    return undefined
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

function loadSettings(file?: string): ComputerUseSettings {
  if (file === undefined || !existsSync(file)) return DEFAULT_COMPUTER_USE_SETTINGS
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"))
    return normalizeSettings(parsed)
  } catch {
    // A corrupt settings file must never crash boot; fall back to defaults.
    return DEFAULT_COMPUTER_USE_SETTINGS
  }
}

// Settings are untrusted input (file on disk, HTTP body): validate and clamp
// every numeric field so a negative maxRetries cannot produce zero attempts
// and an absurd idleUnloadMs cannot unload a model mid-request. Invalid values
// fall back to the current/default value instead of dropping the field.
function normalizeSettings(input: unknown, base: ComputerUseSettings = DEFAULT_COMPUTER_USE_SETTINGS): ComputerUseSettings {
  const body = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {}
  const maxMemoryBytes = finiteOrUndefined(body.maxMemoryBytes, 0)
  const maxLatencyMs = finiteOrUndefined(body.maxLatencyMs, 1)
  return {
    mode:
      body.mode === "automatic" || body.mode === "local_only" || body.mode === "hosted_only" || body.mode === "ask"
        ? body.mode
        : base.mode,
    ...(typeof body.preferredLocalModel === "string"
      ? { preferredLocalModel: body.preferredLocalModel }
      : base.preferredLocalModel === undefined
        ? {}
        : { preferredLocalModel: base.preferredLocalModel }),
    ...(typeof body.preferredHostedProvider === "string"
      ? { preferredHostedProvider: body.preferredHostedProvider }
      : base.preferredHostedProvider === undefined
        ? {}
        : { preferredHostedProvider: base.preferredHostedProvider }),
    allowDownloads: typeof body.allowDownloads === "boolean" ? body.allowDownloads : base.allowDownloads,
    allowAutoLoad: typeof body.allowAutoLoad === "boolean" ? body.allowAutoLoad : base.allowAutoLoad,
    allowRemoteScreen: typeof body.allowRemoteScreen === "boolean" ? body.allowRemoteScreen : base.allowRemoteScreen,
    ...(maxMemoryBytes === undefined
      ? base.maxMemoryBytes === undefined
        ? {}
        : { maxMemoryBytes: base.maxMemoryBytes }
      : { maxMemoryBytes: Math.round(maxMemoryBytes) }),
    ...(maxLatencyMs === undefined
      ? base.maxLatencyMs === undefined
        ? {}
        : { maxLatencyMs: base.maxLatencyMs }
      : { maxLatencyMs: Math.round(maxLatencyMs) }),
    maxRetries: clampInteger(body.maxRetries, base.maxRetries, 0, 3),
    idleUnloadMs: clampInteger(body.idleUnloadMs, base.idleUnloadMs, 0, 24 * 60 * 60 * 1000),
    ...(typeof body.allowTitleBarClicks === "boolean"
      ? { allowTitleBarClicks: body.allowTitleBarClicks }
      : base.allowTitleBarClicks === undefined
        ? {}
        : { allowTitleBarClicks: base.allowTitleBarClicks }),
    ...(typeof body.verifyVisionClicks === "boolean"
      ? { verifyVisionClicks: body.verifyVisionClicks }
      : base.verifyVisionClicks === undefined
        ? {}
        : { verifyVisionClicks: base.verifyVisionClicks }),
  }
}

function finiteOrUndefined(value: unknown, minimum: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum ? value : undefined
}

function clampInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.max(minimum, Math.min(maximum, Math.round(value)))
}

function hostPlatform(): ComputerUsePlatform {
  return process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux"
}

// Normalize any driver-reported platform string to the computer-use contract.
// Returns undefined when the value is missing or unrecognized so the caller
// falls back to the server host only when the controlled machine is unknown.
function normalizeDriverPlatform(value: unknown): ComputerUsePlatform | undefined {
  const candidates: unknown[] = []
  if (isRecord(value)) {
    const record = value as Record<string, unknown>
    candidates.push(record.platform, record.os, record.backend)
    const screen = record.screen as Record<string, unknown> | undefined
    if (isRecord(record.display)) candidates.push((record.display as Record<string, unknown>).platform)
    if (isRecord(record.metadata)) {
      const metadata = record.metadata as Record<string, unknown>
      candidates.push(metadata.platform, metadata.os)
    }
    if (isRecord(screen)) candidates.push(screen.platform)
    // Linux host driver nests the screen under metadata.screen; the platform
    // itself stays top-level, but also check driver-shaped objects.
    const driver = (record.driver ?? record.backend) as unknown
    if (typeof driver === "string") candidates.push(driver)
  } else if (typeof value === "string") {
    candidates.push(value)
  }
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue
    const normalized = candidate.trim().toLowerCase()
    if (normalized === "macos" || normalized === "darwin" || normalized === "mac" || normalized === "macosx") return "macos"
    if (normalized === "windows" || normalized === "win32" || normalized === "win" || normalized.startsWith("windows")) return "windows"
    if (normalized === "linux" || normalized === "ubuntu" || normalized === "debian" || normalized === "fedora") return "linux"
    if (normalized.includes("macos-ax") || normalized.includes("darwin")) return "macos"
    if (normalized.includes("windows")) return "windows"
    if (normalized.includes("linux") || normalized.includes("at-spi") || normalized.includes("x11") || normalized.includes("wayland")) return "linux"
  }
  return undefined
}

function logicalScreenFromInfo(info: unknown): { width: number; height: number } | undefined {
  if (!isRecord(info)) return undefined
  const record = info as Record<string, unknown>
  const shapes: unknown[] = [record.screen, record.display]
  if (isRecord(record.metadata)) {
    const metadata = record.metadata as Record<string, unknown>
    shapes.push(metadata.screen, metadata.display)
    if (isRecord(metadata.screen)) {
      const nested = metadata.screen as Record<string, unknown>
      shapes.push({ width: nested.width, height: nested.height })
    }
  }
  for (const shape of shapes) {
    if (!isRecord(shape)) continue
    const width = (shape as Record<string, unknown>).width
    const height = (shape as Record<string, unknown>).height
    if (typeof width === "number" && typeof height === "number" && Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      return { width, height }
    }
  }
  return undefined
}

// Vision-driven means an explicit pixel point from a non-semantic provider.
// Semantic refs (elementId), keyboard, and window-management actions verify
// through refs/state and must not enter the vision re-observe/retry path.
function isVisionPointAction(result: ComputerUseResult): boolean {
  if (result.provider === "semantic") return false
  const action = result.action
  if (action === undefined) return false
  if (action.type === "key" || action.type === "focus_window" || action.type === "activate_app") return false
  if (typeof result.metadata?.elementId === "string" && result.metadata.elementId.length > 0) return false
  const x = action.target?.x
  const y = action.target?.y
  if (typeof x === "number" && typeof y === "number") return true
  return action.path !== undefined && action.path.length > 0
}

const WINDOW_ROLES = new Set(["window", "frame", "dialog", "application"])
const TITLE_FRAGMENT_SPLIT = /[|\u2014\u2013]+/
const FOCUS_VERB_PATTERN = /\b(?:focus|activate|raise|switch\s+to|select|bring[\s\S]*?front)\b[:\s]*(.+)/i
const TITLE_INTRO_PATTERN = /\b(?:titled|named|called|with\s+title|title)\b/i
// A quoted span names a window title, not an application: dropping it whole
// stops `focus the "Zz | Missing" window` from activating an app called "Zz".
const QUOTED_SPAN_PATTERN = /"[^"]*"|'[^']*'|\u201c[^\u201d]*\u201d/g
// Nouns that describe the container rather than an application: "focus the
// terminal" must not become activate_app("terminal").
const FOCUS_APP_STOPWORDS = new Set([
  "window",
  "terminal",
  "app",
  "dialog",
  "application",
  "desktop",
  "screen",
  "monitor",
  "workspace",
  "workspaces",
  "the",
  "a",
  "an",
  "to",
  "in",
  "on",
  "it",
  "this",
  "that",
  "back",
  "front",
  "up",
  "and",
  "or",
  "please",
  "now",
  "my",
  "me",
])

// ./title-extract.ts holds the shared pure helpers for focus titles. The
// specifier is indirect on purpose so this file stays self-sufficient while
// that module is still landing: the local implementations below carry the
// behaviour, and the external list is only used when it actually yields
// candidates. Both sides are typed readonly string[].
const TITLE_EXTRACT_MODULE = "./title-extract.js"

interface TitleExtractModule {
  readonly extractTitleCandidates?: (target?: string, task?: string) => readonly string[]
  readonly titleOverlap?: (query: string, title: string) => number
}

async function focusTitleCandidates(target: string | undefined, task: string | undefined): Promise<readonly string[]> {
  const external = (await import(TITLE_EXTRACT_MODULE).catch(() => undefined)) as TitleExtractModule | undefined
  const extract = external?.extractTitleCandidates
  // A module that has not landed yet, or that turns out to take different
  // arguments, degrades to the local list instead of failing the action.
  const claimed =
    typeof extract === "function"
      ? await Promise.resolve()
          .then(() => extract(target, task))
          .catch(() => [] as readonly string[])
      : []
  // The quoted/titled fragment is the most specific request, so it leads; the
  // title-extract views and the pipe/dash fragments follow behind it.
  const local = localTitleCandidates(target, task)
  const candidates = local.length === 0 ? claimed : [local[0], ...claimed, ...local.slice(1)]
  return [
    ...new Set(
      candidates.flatMap((candidate) => (typeof candidate === "string" && candidate.trim().length > 0 ? [candidate.trim()] : [])),
    ),
  ]
}

// Ordered title candidates for a focus intent: the full title first (the most
// specific request), then its pipe/dash-separated fragments, longest first.
// `OC | Quick hello` yields `OC | Quick hello`, `Quick hello`, `OC`.
function localTitleCandidates(target?: string, task?: string): readonly string[] {
  const full = extractWindowTitleFragment(target, task)
  if (full === undefined) return []
  const fragments = full
    .split(TITLE_FRAGMENT_SPLIT)
    .map((fragment) => fragment.trim())
    .filter((fragment) => fragment.length >= 2)
    .sort((left, right) => right.length - left.length)
  return [full, ...fragments.filter((fragment) => fragment.toLowerCase() !== full.toLowerCase())]
}

// Live window titles to resolve a fragment against: windows first, then other
// element names, then the observed window title. No candidates means the caller
// must not guess — it asks the server, which answers authoritatively.
function windowTitlesFrom(context: ComputerUseContext): readonly string[] {
  const elements = context.semanticContext?.elements ?? []
  const names = elements.flatMap((element) => {
    const role = (element.role ?? "").toLowerCase()
    return WINDOW_ROLES.has(role) ? [element.name ?? element.text ?? ""] : []
  })
  const rest = elements
    .filter((element) => !WINDOW_ROLES.has((element.role ?? "").toLowerCase()))
    .flatMap((element) => [element.name ?? "", element.text ?? ""])
  const all = [...names, ...rest, context.semanticContext?.windowTitle ?? ""]
  return [...new Set(all.map((value) => value.trim()).filter((value) => value.length > 0))]
}

// The application a title-less focus intent names: the first non-container word
// of the object phrase. "focus the kitty terminal" -> "kitty".
function focusApplication(target?: string, task?: string): string | undefined {
  for (const source of [target ?? "", task ?? ""]) {
    if (source.trim().length === 0) continue
    const verb = source.match(FOCUS_VERB_PATTERN)?.[1]
    if (verb === undefined) continue
    const intro = verb.search(TITLE_INTRO_PATTERN)
    const phrase = intro >= 0 ? verb.slice(0, intro) : verb
    const token = phrase
      .toLowerCase()
      .replace(QUOTED_SPAN_PATTERN, " ")
      .replace(/["'\u201c\u201d]/g, " ")
      .split(/[^a-z0-9+._-]+/)
      .find((candidate) => candidate.length >= 2 && !FOCUS_APP_STOPWORDS.has(candidate))
    if (token !== undefined) return token
  }
  return undefined
}

// The windows a named title honestly refers to, scored with the same overlap
// the title extractor uses and gated by the shared match threshold. A bare
// `title.includes(fragment)` is the over-match that produced the (960,539)
// click, so a window that does not clear the threshold is not a window to
// click: grounding finds nothing and the chain fails loudly instead.
async function titleMatchedWindows(
  windows: readonly SemanticElement[],
  requested: string | undefined,
): Promise<readonly SemanticElement[]> {
  const wanted = requested?.trim()
  if (wanted === undefined || wanted.length === 0) return windows
  const module = (await import(TITLE_EXTRACT_MODULE).catch(() => undefined)) as TitleExtractModule | undefined
  const overlap = module?.titleOverlap
  if (overlap === undefined) return []
  return windows.filter((element) => overlap(wanted, element.name ?? "") >= MATCH_THRESHOLD)
}

// A point inside the window body: the horizontal center, and vertically the
// body center clamped below the title strip so no focus intent can ever ground
// a window control. Points that stay inside the title strip are rejected.
function windowBodyPoint(
  element: SemanticElement,
  image: ImageReference | undefined,
  platform: ComputerUsePlatform | undefined,
): { x: number; y: number } | undefined {
  const bounds = element.bounds
  if (bounds === undefined || !Number.isFinite(bounds.x) || !Number.isFinite(bounds.y)) return undefined
  if (bounds.width <= 0 || bounds.height <= 0) return undefined
  const { yThreshold } = titleBarThresholds(image, platform)
  const x = Math.round(bounds.x + bounds.width / 2)
  const y = Math.round(Math.max(bounds.y + bounds.height / 2, bounds.y + yThreshold + 8))
  const point = { x: Math.max(0, x), y: Math.max(0, y) }
  return isTitleBarPoint(point, image, platform) ? undefined : point
}

interface ActiveWindow {
  readonly id?: string
  readonly title?: string
}

// A focus intent that names no title ("focus the kitty terminal") still needs
// routing: without it the generic Alt+Tab keyboard fallback would fire. Only
// window-management focus verbs qualify, so minimize/restore/show-desktop and
// in-window clicks keep their existing paths.
function isTitlelessFocusIntent(targetDescription?: string, taskContext?: string): boolean {
  if (isWindowFocusIntent(targetDescription, taskContext)) return false
  if (!isWindowManagementIntent(targetDescription, taskContext)) return false
  if (isMinimizeIntent(targetDescription, taskContext) || isRestoreIntent(targetDescription, taskContext)) return false
  return isFocusIntent(targetDescription, taskContext)
}

// The active window as observed after an action: the focused window element
// when the tree names one, otherwise the observation's active-window hint
// (metadata.activeWindow may be a title or an object with id/title).
function activeWindowFromObservation(observation: Observation | undefined): ActiveWindow | undefined {
  if (observation === undefined) return undefined
  const elements = observation.elements ?? []
  const focused = elements.find(
    (element) => WINDOW_ROLES.has((element.role ?? "").toLowerCase()) && (element.states ?? []).includes("focused"),
  )
  if (focused !== undefined) {
    return {
      ...(focused.id === undefined ? {} : { id: focused.id }),
      ...(focused.name === undefined ? {} : { title: focused.name }),
    }
  }
  const hinted = metadataActiveWindow(observation.metadata)
  if (hinted !== undefined) return hinted
  const title = metadataString(observation.metadata, ["activeWindow", "activeWindowTitle", "windowTitle"])
  return title === undefined ? undefined : { title }
}

function metadataActiveWindow(metadata: Observation["metadata"]): ActiveWindow | undefined {
  const value = isRecord(metadata) ? metadata.activeWindow : undefined
  if (typeof value === "string") return value.trim().length === 0 ? undefined : { title: value.trim() }
  if (!isRecord(value)) return undefined
  const id = typeof value.id === "string" && value.id.length > 0 ? value.id : undefined
  const title = [value.title, value.name].find((entry): entry is string => typeof entry === "string" && entry.length > 0)
  return { ...(id === undefined ? {} : { id }), ...(title === undefined ? {} : { title }) }
}

// The window id a requested title resolves to in this observation. Used so a
// focus is confirmed by the resolved id even when the visible title differs
// (for example a renamed or truncated window title).
function windowIdForTitle(observation: Observation | undefined, title: string | undefined): string | undefined {
  const wanted = title?.trim().toLowerCase()
  if (observation === undefined || wanted === undefined || wanted.length === 0) return undefined
  const matched = (observation.elements ?? []).find(
    (element) => WINDOW_ROLES.has((element.role ?? "").toLowerCase()) && (element.name ?? "").toLowerCase().includes(wanted),
  )
  return matched?.id
}

function metadataString(metadata: Observation["metadata"], keys: readonly string[]): string | undefined {
  if (!isRecord(metadata)) return undefined
  for (const key of keys) {
    const value = metadata[key]
    if (typeof value === "string" && value.trim().length > 0) return value.trim()
  }
  return undefined
}

interface ElementState {
  readonly states: readonly string[]
  readonly value?: string
}

function elementStateById(observation: Observation | undefined, ref: string): ElementState | undefined {
  const element = (observation?.elements ?? []).find(
    (candidate) => candidate.id === ref || candidate.reference?.elementId === ref,
  )
  if (element === undefined) return undefined
  const value =
    typeof element.value === "string"
      ? element.value
      : element.value === undefined
        ? undefined
        : JSON.stringify(element.value)
  return { states: element.states ?? [], ...(value === undefined ? {} : { value }) }
}

// The only proof a ref click landed is a change this element can own: the
// focused state, its value, or its state set. Identical before/after is not
// evidence, and neither is an element the pre-action read never saw.
function elementStateChange(before: ElementState, after: ElementState): { field: string } | undefined {
  const sameStates = before.states.length === after.states.length && before.states.every((state, index) => state === after.states[index])
  if (!sameStates) return { field: after.states.includes("focused") && !before.states.includes("focused") ? "focused" : "states" }
  if (before.value !== after.value) return { field: "value" }
  return undefined
}

export function defaultComputerUseSettingsFile(): string {
  return join(homedir(), ".local", "share", "omnia", "computer-use.json")
}
