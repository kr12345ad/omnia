import type { CuaCapabilities } from "../cua/types"
import type { LocalModelManager } from "./local"
import { SemanticProvider, type CuaCapabilityProbe } from "./providers"
import { effectiveAllowTitleBarClicks, isCropPath, isTitleBarTarget, isWindowManagementIntent } from "./window-safety"
import type {
  ComputerUseCapabilities,
  ComputerUseContext,
  ComputerUseMode,
  ComputerUseOperation,
  ComputerUseProvider,
  ComputerUseRouter,
  ComputerUseSettings,
  RoutingCandidate,
  RoutingDecision,
  RoutingWeights,
} from "./types"

export const DEFAULT_ROUTING_WEIGHTS: RoutingWeights = {
  capabilityMatch: 0.3,
  quality: 0.25,
  hardwareFit: 0.2,
  latencyScore: 0.1,
  privacyScore: 0.1,
  costScore: 0.05,
}

export interface RouterOptions {
  readonly providers: readonly ComputerUseProvider[]
  readonly local: LocalModelManager
  readonly settings: () => ComputerUseSettings
  readonly weights?: Partial<RoutingWeights>
  readonly cua?: CuaCapabilityProbe
}

const CANVAS_ROLES = new Set([
  "canvas",
  "image",
  "img",
  "picture",
  "bitmap",
  "drawing",
  "drawing area",
  "figure",
  "graphic",
  "graphics",
  "video",
  "svg",
])

const POINTER_HEAVY_OPERATIONS: ReadonlySet<ComputerUseOperation> = new Set(["ground", "drag", "resize"])

export class DefaultComputerUseRouter implements ComputerUseRouter {
  private readonly providers: readonly ComputerUseProvider[]
  private readonly local: LocalModelManager
  private readonly settings: () => ComputerUseSettings
  // The service injects this probe after construction so the router can see
  // `cua_` driver capabilities without widening ComputerUseContext.
  cua: CuaCapabilityProbe | undefined
  readonly weights: RoutingWeights

  constructor(options: RouterOptions) {
    this.providers = options.providers
    this.local = options.local
    this.settings = options.settings
    this.cua = options.cua
    this.weights = { ...DEFAULT_ROUTING_WEIGHTS, ...options.weights }
  }

  async route(context: ComputerUseContext): Promise<RoutingDecision> {
    const settings = this.settings()
    const coverage = context.semanticContext?.coverage ?? 0
    const baseReasons = [`operation ${context.requestedOperation}`, `semantic coverage ${coverage.toFixed(2)}`]
    const semantic = this.providers.find((provider) => provider.id === "semantic")
    const cua = await this.cuaFor(context)
    const semanticCapabilities = semantic === undefined ? undefined : await semantic.getCapabilities()

    const approval = settings.mode === "ask" ? { requiresApproval: true } : {}

    if (this.semanticSufficient(context)) {
      const cuaSupports = cua !== undefined && this.cuaSupports(cua, context)
      if (
        semantic !== undefined &&
        semanticCapabilities !== undefined &&
        (cuaSupports || this.supportsOperation(semanticCapabilities, context.requestedOperation))
      ) {
        return {
          provider: "semantic",
          local: true,
          reason: [
            ...baseReasons,
            cuaSupports
              ? "cua accessibility refs resolve the task without vision"
              : "semantic data resolves the task without vision",
          ],
          candidates: [{ provider: "semantic", local: true, score: 1, factors: { capabilityMatch: 1, quality: 0.9, hardwareFit: 1, latencyScore: 1, privacyScore: 1, costScore: 1 } }],
          semanticCoverage: coverage,
          operation: context.requestedOperation,
          weights: this.weights,
          estimatedLatencyMs: 10,
          estimatedCostUsd: 0,
          ...approval,
        }
      }
    }

    // P0 title-bar ban: window-management intents (minimize/focus) and explicit
    // title-bar targets default to keyboard/semantic instead of vision click.
    // Full-screen UI-TARS grounding cannot resolve 9px Minimize/Close separation.
    const windowManagementDeflect = await this.windowManagementDeflection(context, settings, baseReasons)
    if (windowManagementDeflect !== undefined) {
      return windowManagementDeflect
    }

    // Accessibility-first: when the Cua engine exposes refs, accessible targets
    // stay on the semantic/Cua path even without a local model. Only pointer
    // work on canvas-like or a11y-empty surfaces may reach vision. The branch
    // is gated on the semantic provider being able to actually resolve the
    // target, so a Cua backend with zero accessible elements (or no matching
    // element) falls through to the vision path instead of route-then-fail.
    if (cua !== undefined && semantic !== undefined && this.cuaSupports(cua, context) && this.cuaResolvable(context)) {
      return {
        provider: "semantic",
        local: true,
        reason: [
          ...baseReasons,
          "cua accessibility refs resolve the task without vision",
          "vision is reserved for canvas-like or a11y-empty surfaces",
        ],
        candidates: [{ provider: "semantic", local: true, score: 1, factors: { capabilityMatch: 1, quality: 0.9, hardwareFit: 1, latencyScore: 1, privacyScore: 1, costScore: 1 } }],
        semanticCoverage: coverage,
        operation: context.requestedOperation,
        weights: this.weights,
        estimatedLatencyMs: 10,
        estimatedCostUsd: 0,
        ...approval,
      }
    }

    const specialist = await this.specialistFor(context, settings)
    if (specialist !== undefined) {
      return specialist
    }

    const vision = await this.visionPreference(context, settings)
    if (vision !== undefined) {
      return vision
    }

    const candidates: RoutingCandidate[] = []
    for (const provider of this.providers) {
      if (provider.id === "semantic") continue
      candidates.push(await this.evaluate(provider, context, settings))
    }
    candidates.sort((a, b) => b.score - a.score)

    const winner = candidates.find((candidate) => candidate.score > 0 && candidate.excluded === undefined)
    const blockedByPolicy = candidates.some(
      (candidate) => candidate.excluded !== undefined && /remote screen data|local only/i.test(candidate.excluded),
    )
    if (winner === undefined) {
      return {
        provider: "none",
        local: false,
        reason: [
          ...baseReasons,
          "no eligible computer-use provider",
          ...candidates.flatMap((candidate) => (candidate.excluded === undefined ? [] : [`${candidate.provider}: ${candidate.excluded}`])),
        ],
        candidates,
        semanticCoverage: coverage,
        operation: context.requestedOperation,
        weights: this.weights,
        ...(blockedByPolicy ? { blockedByPolicy: true } : {}),
      }
    }
    const requiresApproval = settings.mode === "ask"
    return {
      provider: winner.provider,
      ...(winner.model === undefined ? {} : { model: winner.model }),
      local: winner.local,
      reason: [
        ...baseReasons,
        this.semanticSufficient(context) ? "semantic resolution unavailable for this operation" : "visual grounding required",
        winner.local ? "local inference selected" : "hosted provider selected",
        ...(winner.factors.quality >= 0.85 ? ["high expected quality"] : []),
      ],
      candidates,
      semanticCoverage: coverage,
      operation: context.requestedOperation,
      weights: this.weights,
      ...(requiresApproval ? { requiresApproval: true } : {}),
    }
  }

  private async specialistFor(context: ComputerUseContext, settings: ComputerUseSettings): Promise<RoutingDecision | undefined> {
    if (context.requestedOperation !== "drag" && context.requestedOperation !== "resize") return undefined
    const provider = this.providers.find((entry) => entry.id === "showui-pi")
    if (provider === undefined) return undefined
    const capabilities = await provider.getCapabilities()
    if (!capabilities.drag && !capabilities.resize) return undefined
    if (!(await provider.isAvailable(context))) return undefined
    const local = capabilities.local
    if (!local && settings.mode === "local_only") return undefined
    if (!local && !this.remoteAllowed(context, settings)) return undefined
    const latency = await provider.estimateLatency(context)
    const maxLatency = context.preferences?.maxLatencyMs ?? settings.maxLatencyMs ?? 8000
    if (latency.expectedMs > maxLatency) return undefined
    const cost = await provider.estimateCost(context)
    return {
      provider: provider.id,
      local,
      reason: [
        `operation ${context.requestedOperation}`,
        "continuous pointer movement requires a specialist model",
        `${provider.id} provides drag and resize actions`,
      ],
      candidates: [
        {
          provider: provider.id,
          local,
          score: 0.95,
          factors: { capabilityMatch: 1, quality: 0.86, hardwareFit: local ? 0.7 : 0.5, latencyScore: 0.9, privacyScore: local ? 1 : 0.4, costScore: local ? 1 : 0.8 },
        },
      ],
      semanticCoverage: context.semanticContext?.coverage ?? 0,
      operation: context.requestedOperation,
      weights: this.weights,
      ...(settings.mode === "ask" ? { requiresApproval: true } : {}),
      estimatedLatencyMs: latency.expectedMs,
      estimatedCostUsd: cost.usd,
    }
  }

  // Default vision split: UI-TARS grounds (ground/click), Moondream describes
  // (inspect/question). Both stay available through generic scoring when the
  // preferred provider is missing; an explicit preferredLocalModel or
  // preferredHostedProvider override always wins over this default.
  private windowManagementBanned(context: ComputerUseContext, settings: ComputerUseSettings): boolean {
    const allowTitleBarClicks = effectiveAllowTitleBarClicks({ preferences: context.preferences, settings })
    if (allowTitleBarClicks) return false
    if (isCropPath(context.image)) return false
    return (
      isWindowManagementIntent(context.targetDescription, undefined) ||
      isTitleBarTarget(context.targetDescription, undefined)
    )
  }

  private async windowManagementDeflection(
    context: ComputerUseContext,
    settings: ComputerUseSettings,
    baseReasons: readonly string[],
  ): Promise<RoutingDecision | undefined> {
    if (!this.windowManagementBanned(context, settings)) return undefined
    const semantic = this.providers.find((provider) => provider.id === "semantic")
    const capabilities = semantic === undefined ? undefined : await semantic.getCapabilities()
    if (
      semantic !== undefined &&
      capabilities !== undefined &&
      this.supportsOperation(capabilities, context.requestedOperation) &&
      (await semantic.isAvailable(context))
    ) {
      return {
        provider: "semantic",
        local: true,
        reason: [
          ...baseReasons,
          "window-management intent defaults to keyboard/semantic instead of full-screen vision click",
          "title-bar ban: 9px Minimize/Close separation vs ±10px UI-TARS jitter; use window_close, window_minimize, window_maximize, or a cropped screenshot",
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
        operation: context.requestedOperation,
        weights: this.weights,
        ...(settings.mode === "ask" ? { requiresApproval: true } : {}),
        estimatedLatencyMs: 10,
        estimatedCostUsd: 0,
      }
    }
    // No semantic element available: do not silently route to UI-TARS.
    // The service layer falls back to a keyboard action (Super+Down, ...);
    // routing here reports that vision is intentionally skipped.
    return {
      provider: "none",
      local: false,
      reason: [
        ...baseReasons,
        "window-management intent requires keyboard/semantic handling; full-screen UI-TARS grounding for title-bar controls is banned",
        "retry with allowTitleBarClicks explicitly enabled, a cropped screenshot around the button, or keyboard fallback (Super+Down, Alt+Space+N)",
      ],
      candidates: [
        {
          provider: "ui-tars",
          local: true,
          score: 0,
          excluded: "title-bar ban: full-screen grounding for window controls is disabled without a crop or explicit opt-in",
          factors: {},
        },
      ],
      semanticCoverage: context.semanticContext?.coverage ?? 0,
      operation: context.requestedOperation,
      weights: this.weights,
    }
  }

  private async visionPreference(context: ComputerUseContext, settings: ComputerUseSettings): Promise<RoutingDecision | undefined> {
    // P0: never prefer UI-TARS for banned title-bar targets via full-screen screenshots.
    if (this.windowManagementBanned(context, settings)) return undefined
    const preferredId =
      context.requestedOperation === "ground" || context.requestedOperation === "click"
        ? "ui-tars"
        : context.requestedOperation === "inspect"
          ? "moondream"
          : undefined
    if (preferredId === undefined) return undefined
    if (context.preferences?.preferredLocalModel !== undefined || settings.preferredLocalModel !== undefined) return undefined
    if (context.preferences?.preferredHostedProvider !== undefined) return undefined
    const provider = this.providers.find((entry) => entry.id === preferredId)
    if (provider === undefined) return undefined
    const capabilities = await provider.getCapabilities()
    if (!this.supportsOperation(capabilities, context.requestedOperation)) return undefined
    if (!(await provider.isAvailable(context))) return undefined
    const local = capabilities.local
    if (!local && settings.mode === "local_only") return undefined
    if (!local && !this.remoteAllowed(context, settings)) return undefined
    if (local && settings.mode === "hosted_only") return undefined
    const installed = this.local.list().filter((status) => status.installed && status.model.enabled !== false && status.model.provider === preferredId)
    if (installed.length === 0) return undefined
    const selected = installed.find((status) => status.model.recommended) ?? installed[0]!
    const maxMemory = context.preferences?.maxMemoryBytes ?? settings.maxMemoryBytes
    if (maxMemory !== undefined && (selected.model.estimatedMemoryBytes ?? 0) > maxMemory) return undefined
    const compatibility = (await this.local.compatibilityReport()).find((entry) => entry.model.id === selected.model.id)?.compatibility
    if (compatibility !== undefined && !compatibility.compatible) return undefined
    const latency = await provider.estimateLatency(context)
    const cost = await provider.estimateCost(context)
    const maxLatency = context.preferences?.maxLatencyMs ?? settings.maxLatencyMs ?? 8000
    if (latency.expectedMs > maxLatency) return undefined
    return {
      provider: provider.id,
      ...(selected === undefined ? {} : { model: selected.model.id }),
      local,
      reason: [
        `operation ${context.requestedOperation}`,
        preferredId === "ui-tars"
          ? "default grounding model for point-and-click actions"
          : "default describe model for inspect/question actions",
      ],
      candidates: [
        {
          provider: provider.id,
          local,
          score: 0.95,
          factors: { capabilityMatch: 1, quality: 0.9, hardwareFit: local ? 1 : 0.5, latencyScore: 0.9, privacyScore: local ? 1 : 0.4, costScore: local ? 1 : 0.8 },
        },
      ],
      semanticCoverage: context.semanticContext?.coverage ?? 0,
      operation: context.requestedOperation,
      weights: this.weights,
      ...(settings.mode === "ask" ? { requiresApproval: true } : {}),
      estimatedLatencyMs: latency.expectedMs,
      estimatedCostUsd: cost.usd,
    }
  }

  private semanticSufficient(context: ComputerUseContext): boolean {
    const environment = context.semanticContext
    if (environment === undefined || environment.elements.length === 0) return false
    const target = context.targetDescription?.trim().toLowerCase() ?? ""
    // An empty target cannot be resolved by the semantic provider (bestMatch
    // rejects an empty query), so coverage alone must not claim sufficiency.
    if (target.length === 0) return false
    // An explicit element ref is authoritative: the caller named a stable id
    // from a prior observation, so no fuzzy threshold applies.
    if (hasElementRef(environment.elements, target)) return true
    const match = bestScore(environment.elements, target)
    // Aligned with providers.ts SEMANTIC_MATCH_THRESHOLD (0.6). The old 0.5
    // let the 0.4 query.includes(name) over-match through as "sufficient"
    // while the provider also returned 0.4, producing false-Verified clicks.
    if (context.requestedOperation === "drag" || context.requestedOperation === "resize") {
      return environment.coverage >= 0.7 && match !== undefined && match >= 0.6
    }
    return match !== undefined && match >= 0.6
  }

  private async cuaFor(context: ComputerUseContext): Promise<CuaCapabilities | undefined> {
    if (this.cua !== undefined) return await this.cua(context)
    const semantic = this.providers.find((provider) => provider.id === "semantic")
    if (semantic instanceof SemanticProvider) return await semantic.cuaCapabilitiesFor(context)
    return undefined
  }

  // With `cua_refs` the semantic provider can address every control by stable
  // ref, including drag/resize on accessible targets. Canvas-like or
  // a11y-empty surfaces stay on the vision path for pointer-heavy work.
  private cuaSupports(cua: CuaCapabilities, context: ComputerUseContext): boolean {
    if (!cua.refs && !cua.semanticActions) return false
    return !this.pointerHeavyOnCanvas(context)
  }

  // The semantic provider still has to resolve the target: an empty a11y tree
  // or a target with no matching accessible element must fall through to
  // vision instead of being answered with a guaranteed provider failure.
  private cuaResolvable(context: ComputerUseContext): boolean {
    const target = context.targetDescription?.trim().toLowerCase() ?? ""
    if (target.length === 0) return false
    const accessible = (context.semanticContext?.elements ?? []).filter((element) => element.source !== "vision")
    if (accessible.length === 0) return false
    const score = bestScore(accessible, target)
    return score !== undefined && score >= SEMANTIC_SUFFICIENT_THRESHOLD
  }

  private pointerHeavyOnCanvas(context: ComputerUseContext): boolean {
    if (!POINTER_HEAVY_OPERATIONS.has(context.requestedOperation)) return false
    return this.canvasLike(context)
  }

  private canvasLike(context: ComputerUseContext): boolean {
    if (isCropPath(context.image)) return true
    const accessible = (context.semanticContext?.elements ?? []).filter(
      (element) => element.source !== "vision" && !CANVAS_ROLES.has((element.role ?? "").toLowerCase()),
    )
    if (accessible.length === 0) return true
    const target = context.targetDescription?.trim().toLowerCase() ?? ""
    if (target.length === 0) return false
    const score = bestScore(accessible, target)
    return score === undefined || score < SEMANTIC_SUFFICIENT_THRESHOLD
  }

  private async evaluate(provider: ComputerUseProvider, context: ComputerUseContext, settings: ComputerUseSettings): Promise<RoutingCandidate> {
    const capabilities = await provider.getCapabilities()
    const local = capabilities.local
    const mode: ComputerUseMode = settings.mode
    const exclude = (reason: string, factors: Readonly<Record<string, number>> = {}): RoutingCandidate => ({
      provider: provider.id,
      local,
      score: 0,
      excluded: reason,
      factors,
    })
    if (mode === "local_only" && !local) return exclude("computer-use mode is local only")
    if (mode === "hosted_only" && local) return exclude("computer-use mode is hosted only")
    if (mode !== "hosted_only" && !local && !this.remoteAllowed(context, settings)) {
      return exclude("remote screen data is disabled by policy")
    }
    if (!this.supportsOperation(capabilities, context.requestedOperation)) {
      return exclude(`operation ${context.requestedOperation} is not supported`)
    }
    const available = await provider.isAvailable(context)
    if (!available) return exclude("provider is not available")

    const latency = await provider.estimateLatency(context)
    const cost = await provider.estimateCost(context)
    const maxLatency = context.preferences?.maxLatencyMs ?? settings.maxLatencyMs ?? 8000
    if (latency.expectedMs > maxLatency) return exclude(`estimated latency ${latency.expectedMs}ms exceeds the ${maxLatency}ms limit`)

    const localModels = this.local.list().filter((status) => status.model.provider === provider.id && status.model.enabled !== false)
    const installed = localModels.filter((status) => status.installed)
    const preferred = context.preferences?.preferredLocalModel ?? settings.preferredLocalModel
    const selected =
      installed.find((status) => status.model.id === preferred) ??
      installed.find((status) => status.model.recommended) ??
      installed.sort((a, b) => (b.model.quality ?? 0) - (a.model.quality ?? 0))[0]
    if (local && selected === undefined) return exclude("no compatible local model is installed")
    const maxMemory = context.preferences?.maxMemoryBytes ?? settings.maxMemoryBytes
    if (local && maxMemory !== undefined && (selected?.model.estimatedMemoryBytes ?? 0) > maxMemory) {
      return exclude("model exceeds the configured maximum memory")
    }
    const compatibility =
      local && selected !== undefined
        ? (await this.local.compatibilityReport()).find((entry) => entry.model.id === selected.model.id)?.compatibility
        : undefined
    if (local && compatibility !== undefined && !compatibility.compatible) {
      return exclude(compatibility.reasons[0] ?? "model is not compatible with this hardware")
    }
    const model = selected?.model ?? this.localModelFor(provider.id)
    const quality = model?.quality ?? 0.8
    const hardwareFit = local ? (compatibility?.backend === undefined || compatibility.backend === "cpu" ? 0.7 : 1) : 0.5
    const latencyScore = Math.max(0, 1 - latency.expectedMs / maxLatency)
    const privacyScore = local ? 1 : 0.4
    const costScore = local ? 1 : Math.max(0, 1 - Math.min(1, cost.usd / 0.05))
    const factors = {
      capabilityMatch: 1,
      quality,
      hardwareFit,
      latencyScore,
      privacyScore,
      costScore,
    }
    const preferenceBonus =
      (preferred !== undefined && model?.id === preferred ? 0.15 : 0) +
      (context.preferences?.preferredHostedProvider !== undefined && provider.id === context.preferences.preferredHostedProvider ? 0.15 : 0)
    const score =
      factors.capabilityMatch * this.weights.capabilityMatch +
      factors.quality * this.weights.quality +
      factors.hardwareFit * this.weights.hardwareFit +
      factors.latencyScore * this.weights.latencyScore +
      factors.privacyScore * this.weights.privacyScore +
      factors.costScore * this.weights.costScore +
      preferenceBonus
    return {
      provider: provider.id,
      ...(model === undefined ? {} : { model: model.id }),
      local,
      score: Number(Math.min(1, score).toFixed(4)),
      factors,
    }
  }

  private remoteAllowed(context: ComputerUseContext, settings: ComputerUseSettings): boolean {
    const privacy = context.privacy
    if (privacy !== undefined) return privacy.mode === "hosted_only" || (privacy.allowRemoteScreen && privacy.mode !== "local_only")
    return settings.mode === "hosted_only" || (settings.allowRemoteScreen && settings.mode !== "local_only")
  }

  private supportsOperation(capabilities: ComputerUseCapabilities, operation: ComputerUseOperation): boolean {
    switch (operation) {
      case "click":
      case "ground":
        return capabilities.click || capabilities.visualGrounding
      case "type":
        return capabilities.type
      case "scroll":
        return capabilities.scroll
      case "drag":
        return capabilities.drag
      case "resize":
        return capabilities.resize || capabilities.drag
      case "inspect":
      case "general":
        return capabilities.visualGrounding
    }
  }

  private localModelFor(providerId: string) {
    return this.local.list().find((status) => status.model.provider === providerId && status.installed)?.model
  }
}

export const SEMANTIC_SUFFICIENT_THRESHOLD = 0.6

export function hasElementRef(elements: readonly { elementId?: string }[], query: string): boolean {
  return elements.some((element) => element.elementId !== undefined && element.elementId.toLowerCase() === query)
}

export function bestScore(
  elements: readonly { name?: string; text?: string; role?: string; elementId?: string }[],
  query: string,
): number | undefined {
  let best: number | undefined
  for (const element of elements) {
    // An exact ref match is definitive and skips fuzzy scoring entirely.
    if (element.elementId !== undefined && element.elementId.toLowerCase() === query) return 1
    const name = (element.name ?? "").toLowerCase()
    const text = (element.text ?? "").toLowerCase()
    const role = (element.role ?? "").toLowerCase()
    // Aligned with providers.ts: element name must contain the query (0.6).
    // Removed the query.includes(name) 0.4 over-match that routed
    // "focus Kitty OC | Quick hello" to a screen-center click.
    const exact = name === query || text === query
    const nameScore = name.length > 0 && name.includes(query) ? 0.6 : 0
    const score = Math.min(1, nameScore + (text.includes(query) ? 0.25 : 0) + (role.includes(query) ? 0.15 : 0) + (exact ? 0.25 : 0))
    if (score > 0 && (best === undefined || score > best)) best = score
  }
  return best
}
