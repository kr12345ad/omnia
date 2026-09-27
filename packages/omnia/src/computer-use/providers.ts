import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { promisify } from "node:util"
import type { LocalModelManager } from "./local"
import { parseShowUiAction, parseUiTarsAction } from "./parse"
import {
  checkCloseGuard,
  checkTitleBarBan,
  effectiveAllowTitleBarClicks,
  findKnownClosePoints,
} from "./window-safety"
import type {
  ComputerUseAction,
  ComputerUseCapabilities,
  ComputerUseContext,
  ComputerUseMode,
  ComputerUseModel,
  ComputerUseProvider,
  ComputerUseRequest,
  ComputerUseResult,
  CostEstimate,
  HostedComputerUseProvider,
  ImageReference,
  LatencyEstimate,
  SemanticElement,
} from "./types"

const run = promisify(execFile)

export interface ProviderSettings {
  readonly allowAutoLoad: boolean
  readonly allowRemoteScreen: boolean
  readonly mode: string
  readonly preferredLocalModel?: string
  readonly allowTitleBarClicks?: boolean
}

export interface ProviderOptions {
  readonly catalog: readonly ComputerUseModel[]
  readonly local: LocalModelManager
  readonly settings: () => ProviderSettings
  readonly env?: NodeJS.ProcessEnv
}

export function createProviders(options: ProviderOptions): ComputerUseProvider[] {
  const env = options.env ?? process.env
  const providers: ComputerUseProvider[] = [
    new SemanticProvider(),
    new MoondreamProvider(options),
    new UiTarsProvider(options),
    new EndpointVisionProvider("showui", "ShowUI", options, {
      endpoint: env.OMNIA_SHOWUI_ENDPOINT,
      token: env.OMNIA_SHOWUI_TOKEN,
      model: env.OMNIA_SHOWUI_MODEL,
    }),
    new EndpointVisionProvider("showui-pi", "ShowUI-π", options, {
      endpoint: env.OMNIA_SHOWUI_PI_ENDPOINT,
      token: env.OMNIA_SHOWUI_PI_TOKEN,
      model: env.OMNIA_SHOWUI_PI_MODEL,
    }),
    ...hostedProviders(options, env),
  ]
  return providers
}

// P0 title-bar safety: shared validation for vision grounding results.
// Rejects full-screen title-bar clicks (ban) and Minimize points within 25px
// of Close-X (guard). Returns an error message requiring crop/refine, or
// undefined when the point is safe to use. Crop path (screenshot.region) and
// explicit allowTitleBarClicks opt-in bypass the ban; the 25px Close guard
// still applies unless explicitly opted in, because 15px is unsafe with
// ±10px jitter.
export function validateGroundedPoint(options: {
  readonly x?: number
  readonly y?: number
  readonly targetDescription?: string
  readonly taskContext?: string
  readonly screenshot?: import("./types").ImageReference
  readonly semanticElements?: readonly import("./types").SemanticElement[]
  readonly allowTitleBarClicks?: boolean
}): string | undefined {
  const { x, y } = options
  if (x === undefined || y === undefined) return undefined
  const ban = checkTitleBarBan({
    point: { x, y },
    targetDescription: options.targetDescription,
    taskContext: options.taskContext,
    image: options.screenshot,
    allowTitleBarClicks: options.allowTitleBarClicks,
  })
  if (ban.banned) return ban.reason
  // Explicit Close intents are expected to land on Close-X: the ban above
  // already forces them through crop/opt-in, so skip the Minimize-vs-Close
  // guard for them. Every other title-bar point keeps the 25px guard.
  const haystack = `${options.targetDescription ?? ""} ${options.taskContext ?? ""}`
  if (/clos(e|ing)\b/i.test(haystack)) return undefined
  const closePoints = findKnownClosePoints(options.semanticElements, options.screenshot)
  const guard = checkCloseGuard({ x, y }, closePoints)
  if (!guard.safe) {
    if (options.allowTitleBarClicks === true) return undefined
    return guard.reason
  }
  return undefined
}

function allowTitleBarClicksFor(
  options: ProviderOptions,
  context: import("./types").ComputerUseContext | undefined,
): boolean {
  return effectiveAllowTitleBarClicks({ preferences: context?.preferences, settings: options.settings() })
}

export class SemanticProvider implements ComputerUseProvider {
  readonly id = "semantic"
  readonly name = "Omnia semantic environment"

  getCapabilities(): Promise<ComputerUseCapabilities> {
    return Promise.resolve({
      visualGrounding: false,
      click: true,
      doubleClick: true,
      rightClick: true,
      type: true,
      scroll: true,
      drag: true,
      resize: true,
      keyboardShortcuts: true,
      local: true,
      supportedBackends: ["native"],
    })
  }

  isAvailable(context: ComputerUseContext): Promise<boolean> {
    return Promise.resolve((context.semanticContext?.elements.length ?? 0) > 0)
  }

  estimateCost(): Promise<CostEstimate> {
    return Promise.resolve({ usd: 0, note: "Semantic resolution is free." })
  }

  estimateLatency(): Promise<LatencyEstimate> {
    return Promise.resolve({ expectedMs: 10, note: "Native accessibility query." })
  }

  async analyze(request: ComputerUseRequest): Promise<ComputerUseResult> {
    const started = Date.now()
    const elements = request.semanticContext?.elements ?? []
    const match = bestMatch(elements, request.targetDescription ?? "")
    if (match === undefined) {
      return {
        success: false,
        provider: this.id,
        confidence: 0,
        reasoning: "No semantic element matches the target description.",
        latencyMs: Date.now() - started,
      }
    }
    const action = actionForOperation(request.requestedOperation, match.element, request.taskContext)
    return {
      success: action !== undefined,
      provider: this.id,
      action,
      confidence: match.score,
      reasoning: `Semantic match on ${match.element.role ?? "element"} "${match.element.name ?? match.element.text ?? ""}".`,
      evidence: [`source: ${match.element.source ?? "accessibility"}`, `score: ${match.score.toFixed(2)}`],
      latencyMs: Date.now() - started,
      metadata: {
        elementId: match.element.elementId,
        bounds: match.element.bounds,
        exact: match.exact,
      },
    }
  }
}

class MoondreamProvider implements ComputerUseProvider {
  readonly id = "moondream"
  readonly name = "Moondream (local)"
  private readonly options: ProviderOptions

  constructor(options: ProviderOptions) {
    this.options = options
  }

  async getCapabilities(): Promise<ComputerUseCapabilities> {
    return (
      this.model()?.capabilities ?? {
        visualGrounding: true,
        click: true,
        doubleClick: true,
        rightClick: true,
        type: true,
        scroll: true,
        drag: false,
        resize: false,
        keyboardShortcuts: true,
        local: true,
        supportedBackends: ["cpu", "vulkan", "cuda", "metal"],
      }
    )
  }

  async isAvailable(context: ComputerUseContext): Promise<boolean> {
    if (context.platform !== undefined && context.platform !== "linux" && context.platform !== "macos" && context.platform !== "windows") {
      return false
    }
    const runtime = await this.options.local.runtime()
    if (!runtime.available) return false
    return this.model() !== undefined
  }

  estimateCost(): Promise<CostEstimate> {
    return Promise.resolve({ usd: 0, note: "Local inference has no API cost." })
  }

  async estimateLatency(): Promise<LatencyEstimate> {
    const runtime = await this.options.local.runtime()
    return {
      expectedMs: runtime.backend === "cpu" ? 6000 : 1200,
      note: `Local ${runtime.backend ?? "cpu"} pointing inference.`,
    }
  }

  async analyze(request: ComputerUseRequest, context?: ComputerUseContext): Promise<ComputerUseResult> {
    const started = Date.now()
    const effectiveContext = context ?? { computerId: request.computerId, requestedOperation: request.requestedOperation }
    const model = this.selectModel(effectiveContext)
    if (model === undefined) {
      return {
        success: false,
        provider: this.id,
        confidence: 0,
        reasoning: "No Moondream model is installed.",
        latencyMs: Date.now() - started,
      }
    }
    if (request.screenshot === undefined) {
      return {
        success: false,
        provider: this.id,
        model: model.id,
        confidence: 0,
        reasoning: "Pointing requires a screenshot.",
        latencyMs: Date.now() - started,
      }
    }
    try {
      await this.options.local.ensureLoaded(model.id, { auto: this.options.settings().allowAutoLoad })
      const dataUrl = await imageForModel(request.screenshot)
      const asking = request.question !== undefined || request.requestedOperation === "inspect"
      const response = await this.options.local.chat(
        [
          {
            role: "user",
            content: [
              { type: "text", text: asking ? buildQuestionPrompt(request) : buildPointingPrompt(request) },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
        { maxTokens: asking ? 320 : 48, timeoutMs: request.timeoutMs ?? 120000 },
      )
      const answer = parseMoondreamAnswer(response.text)
      const width = request.screenshot.width ?? 1920
      const height = request.screenshot.height ?? 1080
      const action =
        answer.point === undefined
          ? undefined
          : pointingAction(Math.round(answer.point.x * width), Math.round(answer.point.y * height))
      if (action === undefined && !asking) {
        return {
          success: false,
          provider: this.id,
          model: model.id,
          confidence: 0.15,
          reasoning: answer.answer.slice(0, 300),
          evidence: ["The model did not return usable coordinates."],
          latencyMs: Date.now() - started,
          metadata: { raw: response.text.slice(0, 1000), usage: response.usage },
        }
      }
      if (action?.target !== undefined) {
        const unsafe = validateGroundedPoint({
          x: action.target.x,
          y: action.target.y,
          targetDescription: request.targetDescription,
          taskContext: request.taskContext,
          screenshot: request.screenshot,
          semanticElements: request.semanticContext?.elements,
          allowTitleBarClicks: allowTitleBarClicksFor(this.options, context),
        })
        if (unsafe !== undefined) {
          return {
            success: false,
            provider: this.id,
            model: model.id,
            confidence: 0.15,
            reasoning: unsafe,
            evidence: [`rejected point (${action.target.x}, ${action.target.y}): vision grounding too close to window controls`],
            latencyMs: Date.now() - started,
          }
        }
      }
      return {
        success: true,
        provider: this.id,
        model: model.id,
        ...(action === undefined ? {} : { action }),
        confidence: action === undefined ? 0.8 : operationConfidence(0.85, action, request.requestedOperation),
        reasoning: answer.answer.slice(0, 800),
        evidence: action === undefined ? [answer.answer.slice(0, 200)] : [`point (${action.target?.x}, ${action.target?.y})`],
        latencyMs: Date.now() - started,
        metadata: { format: asking ? "answer" : "normalized-1", usage: response.usage },
      }
    } catch (error) {
      return {
        success: false,
        provider: this.id,
        model: model.id,
        confidence: 0,
        reasoning: error instanceof Error ? error.message : "Local inference failed.",
        latencyMs: Date.now() - started,
      }
    }
  }

  private model(): ComputerUseModel | undefined {
    const installed = this.options.local
      .list()
      .filter((status) => status.model.provider === this.id && status.installed)
      .map((status) => status.model)
    return installed.find((entry) => entry.recommended) ?? installed[0] ?? this.options.catalog.find((entry) => entry.provider === this.id)
  }

  private selectModel(context: ComputerUseContext): ComputerUseModel | undefined {
    const settings = this.options.settings()
    const statuses = this.options.local.list().filter((status) => status.installed)
    const compatible = statuses.filter((status) => status.model.provider === this.id)
    if (compatible.length === 0) return undefined
    const preferred =
      compatible.find((status) => status.model.id === (context.preferences?.preferredLocalModel ?? settings.preferredLocalModel)) ??
      compatible.find((status) => status.model.recommended)
    return (preferred ?? compatible[0])?.model
  }
}

// The pointing step only needs normalized coordinates. Moondream answers with
// 0-1 values; scale to the screenshot to get absolute pixels.
export function parseMoondreamPoint(text: string): { x: number; y: number } | undefined {
  const match = text.match(/"x"\s*:\s*(-?\d+(?:\.\d+)?)\s*,\s*"y"\s*:\s*(-?\d+(?:\.\d+)?)/i)
  if (match?.[1] === undefined || match[2] === undefined) return undefined
  const rawX = Number(match[1])
  const rawY = Number(match[2])
  if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) return undefined
  const scale = rawX > 1.5 || rawY > 1.5 ? 1000 : 1
  const x = Math.min(1, Math.max(0, rawX / scale))
  const y = Math.min(1, Math.max(0, rawY / scale))
  return { x, y }
}

export function parseMoondreamAnswer(text: string): { answer: string; point?: { x: number; y: number } } {
  const point = parseMoondreamPoint(text)
  const stripped = text
    .replace(/\{?\s*"x"\s*:\s*-?\d+(?:\.\d+)?\s*,\s*"y"\s*:\s*-?\d+(?:\.\d+)?\s*\}?/gi, "")
    .trim()
  return { answer: stripped.length > 0 ? stripped : text.trim(), ...(point === undefined ? {} : { point }) }
}

function buildQuestionPrompt(request: ComputerUseRequest): string {
  return request.question ?? `Describe ${request.targetDescription ?? "the screen"}.`
}

function buildPointingPrompt(request: ComputerUseRequest): string {
  const target = request.targetDescription ?? instructionFor(request)
  return `Point at ${target.replace(/\.$/, "")}.`
}

function pointingAction(x: number, y: number): ComputerUseAction {
  return { type: "click", target: { x, y } }
}

class UiTarsProvider implements ComputerUseProvider {  readonly id = "ui-tars"
  readonly name = "UI-TARS (local)"
  private readonly options: ProviderOptions

  constructor(options: ProviderOptions) {
    this.options = options
  }

  async getCapabilities(): Promise<ComputerUseCapabilities> {
    return this.model()?.capabilities ?? { ...EMPTY_CAPABILITIES, local: true }
  }

  async isAvailable(context: ComputerUseContext): Promise<boolean> {
    if (context.platform !== undefined && context.platform !== "linux" && context.platform !== "macos" && context.platform !== "windows") {
      return false
    }
    const runtime = await this.options.local.runtime()
    if (!runtime.available) return false
    return this.selectModel(context) !== undefined
  }

  estimateCost(): Promise<CostEstimate> {
    return Promise.resolve({ usd: 0, note: "Local inference has no API cost." })
  }

  async estimateLatency(): Promise<LatencyEstimate> {
    const model = this.model()
    const runtime = await this.options.local.runtime()
    const sizeGb = (model?.modelSizeBytes ?? 1.12 * 1024 ** 3) / 1024 ** 3
    // CPU vision inference is prompt-bound: a full-screen image costs seconds
    // to tens of seconds, so report that honestly instead of a small number.
    const expectedMs = runtime.backend === "cpu" ? 8000 + sizeGb * 20000 : 600 + sizeGb * 400
    return { expectedMs: Math.round(expectedMs), note: `Local ${runtime.backend ?? "cpu"} inference.` }
  }

  async analyze(request: ComputerUseRequest, context?: ComputerUseContext): Promise<ComputerUseResult> {
    const started = Date.now()
    const effectiveContext = context ?? { computerId: request.computerId, requestedOperation: request.requestedOperation }
    const model = this.selectModel(effectiveContext)
    if (model === undefined) {
      return {
        success: false,
        provider: this.id,
        confidence: 0,
        reasoning: "No compatible UI-TARS build is installed.",
        latencyMs: Date.now() - started,
      }
    }
    if (request.screenshot === undefined) {
      return {
        success: false,
        provider: this.id,
        model: model.id,
        confidence: 0,
        reasoning: "Visual grounding requires a screenshot.",
        latencyMs: Date.now() - started,
      }
    }
    try {
      await this.options.local.ensureLoaded(model.id, { auto: this.options.settings().allowAutoLoad })
      if (shouldUseCropPath(request) && request.screenshot.path !== undefined) {
        const cropped = await this.groundInCropRegion(request, model.id, model.coordinateSpace)
        if (cropped !== undefined) return cropped
      }
      const dataUrl = await imageForModel(request.screenshot)
      const prompt = buildUiTarsPrompt(request)
      const response = await this.options.local.chat(
        [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
        { maxTokens: 256, timeoutMs: request.timeoutMs ?? 120000 },
      )
      const parsed = parseUiTarsAction(response.text, request.screenshot, model.coordinateSpace)
      if (parsed === undefined) {
        return {
          success: false,
          provider: this.id,
          model: model.id,
          confidence: 0.15,
          reasoning: response.text.slice(0, 300),
          evidence: ["The model output could not be parsed into an action."],
          latencyMs: Date.now() - started,
          metadata: { raw: response.text.slice(0, 1000), usage: response.usage },
        }
      }
      if (parsed.action.target !== undefined) {
        const unsafe = validateGroundedPoint({
          x: parsed.action.target.x,
          y: parsed.action.target.y,
          targetDescription: request.targetDescription,
          taskContext: request.taskContext,
          screenshot: request.screenshot,
          semanticElements: request.semanticContext?.elements,
          allowTitleBarClicks: allowTitleBarClicksFor(this.options, context),
        })
        if (unsafe !== undefined) {
          return {
            success: false,
            provider: this.id,
            model: model.id,
            confidence: 0.15,
            reasoning: unsafe,
            evidence: [...parsed.evidence, `rejected point (${parsed.action.target.x}, ${parsed.action.target.y})`],
            latencyMs: Date.now() - started,
            metadata: { format: parsed.format, usage: response.usage },
          }
        }
      }
      return {
        success: true,
        provider: this.id,
        model: model.id,
        action: parsed.action,
        confidence: operationConfidence(parsed.confidence, parsed.action, request.requestedOperation),
        reasoning: response.text.slice(0, 300),
        evidence: parsed.evidence,
        latencyMs: Date.now() - started,
        metadata: { format: parsed.format, usage: response.usage },
      }
    } catch (error) {
      return {
        success: false,
        provider: this.id,
        model: model.id,
        confidence: 0,
        reasoning: error instanceof Error ? error.message : "Local inference failed.",
        latencyMs: Date.now() - started,
      }
    }
  }

  // High-resolution crop path for tiny clustered targets (e.g. title-bar
  // window buttons). Crops top-right 400x120 at full resolution as JPEG q90
  // with no 1024 downscale, sends the crop to UI-TARS, and maps raw 0-1000
  // back to absolute pixels via ImageReference.region in parseUiTarsAction.
  // Returns undefined when the crop itself cannot be produced (missing path,
  // ffmpeg unavailable) so the caller falls back to the full-screen path.
  private async groundInCropRegion(
    request: ComputerUseRequest,
    modelId: string,
    coordinateSpace: ComputerUseModel["coordinateSpace"],
  ): Promise<ComputerUseResult | undefined> {
    const started = Date.now()
    const screenshot = request.screenshot
    if (screenshot === undefined || screenshot.path === undefined) return undefined
    const crop = titleBarCropFor(screenshot)
    const cropped = await compressScreenshotHighResCrop(screenshot.path, crop)
    if (cropped === undefined) return undefined
    const cropImage: ImageReference = { width: crop.width, height: crop.height, region: crop, dataUrl: cropped.dataUrl }
    const prompt = buildUiTarsCropPrompt(request, crop)
    const port = this.options.local.chatPort()
    const inferStarted = Date.now()
    const response = await this.options.local.chat(
      [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: cropped.dataUrl } },
          ],
        },
      ],
      { maxTokens: 256, timeoutMs: request.timeoutMs ?? 120000 },
    )
    const inferenceMs = Date.now() - inferStarted
    const raw = extractRawUiTarsPoint(response.text)
    const parsed = parseUiTarsAction(response.text, cropImage, coordinateSpace)
    const target = parsed?.action.target
    const evidence = [
      `crop path: rect (${crop.x},${crop.y}) ${crop.width}x${crop.height}`,
      `image-sha256: ${cropped.sha256}`,
      `raw coords: ${raw === undefined ? "unparsed" : `(${raw.x},${raw.y})`}`,
      `mapped target: ${target === undefined ? "none" : `(${target.x},${target.y})`}`,
      `local inference: ${inferenceMs}ms via http://127.0.0.1:${port ?? "?"}/v1/chat/completions`,
      ...(parsed === undefined ? [] : parsed.evidence),
    ]
    const metadata = {
      path: "crop",
      crop,
      imageSha256: cropped.sha256,
      ...(raw === undefined ? {} : { rawCoordinate: raw }),
      inferenceMs,
      ...(port === undefined ? {} : { endpointPort: port }),
    }
    if (parsed === undefined) {
      return {
        success: false,
        provider: this.id,
        model: modelId,
        confidence: 0.15,
        reasoning: response.text.slice(0, 300),
        evidence,
        latencyMs: Date.now() - started,
        metadata: { ...metadata, raw: response.text.slice(0, 1000), usage: response.usage },
      }
    }
    if (target !== undefined) {
      // Crop path bypasses the full-screen title-bar ban via image.region,
      // but the 25px Minimize-vs-Close guard still applies (explicit Close
      // intents exempted inside validateGroundedPoint).
      const fullScreenImage = request.screenshot
      const unsafe = validateGroundedPoint({
        x: target.x,
        y: target.y,
        targetDescription: request.targetDescription,
        taskContext: request.taskContext,
        screenshot: fullScreenImage,
        semanticElements: request.semanticContext?.elements,
        allowTitleBarClicks: allowTitleBarClicksFor(this.options, undefined),
      })
      if (unsafe !== undefined) {
        return {
          success: false,
          provider: this.id,
          model: modelId,
          confidence: 0.15,
          reasoning: unsafe,
          evidence: [...evidence, `rejected crop target (${target.x}, ${target.y})`],
          latencyMs: Date.now() - started,
          metadata: { ...metadata, format: parsed.format, usage: response.usage },
        }
      }
    }
    return {
      success: true,
      provider: this.id,
      model: modelId,
      action: parsed.action,
      confidence: operationConfidence(parsed.confidence, parsed.action, request.requestedOperation),
      reasoning: response.text.slice(0, 300),
      evidence,
      latencyMs: Date.now() - started,
      metadata: { ...metadata, format: parsed.format, usage: response.usage },
    }
  }

  private model(): ComputerUseModel | undefined {
    const installed = this.options.local
      .list()
      .filter((status) => status.model.provider === "ui-tars" && status.installed)
      .map((status) => status.model)
    return installed.find((entry) => entry.recommended) ?? installed[0] ?? this.options.catalog.find((entry) => entry.provider === "ui-tars")
  }

  private selectModel(context: ComputerUseContext): ComputerUseModel | undefined {
    const settings = this.options.settings()
    const statuses = this.options.local.list().filter((status) => status.installed)
    const compatible = statuses.filter((status) => status.model.provider === "ui-tars")
    if (compatible.length === 0) return undefined
    const preferred =
      compatible.find((status) => status.model.id === (context.preferences?.preferredLocalModel ?? settings.preferredLocalModel)) ??
      compatible.find((status) => status.model.recommended)
    if (preferred !== undefined) return preferred.model
    const maxMemory = context.preferences?.maxMemoryBytes
    const eligible = compatible
      .filter((status) => maxMemory === undefined || (status.model.estimatedMemoryBytes ?? 0) <= maxMemory)
      .sort((a, b) => (a.model.modelSizeBytes ?? 0) - (b.model.modelSizeBytes ?? 0))
    return eligible[0]?.model
  }
}

interface EndpointConfig {
  readonly endpoint?: string
  readonly token?: string
  readonly model?: string
}

class EndpointVisionProvider implements HostedComputerUseProvider {
  readonly id: string
  readonly name: string
  private readonly options: ProviderOptions
  private readonly config: EndpointConfig
  private readonly hosted: boolean

  constructor(id: string, name: string, options: ProviderOptions, config: EndpointConfig, hosted = false) {
    this.id = id
    this.name = name
    this.options = options
    this.config = config
    this.hosted = hosted
  }

  async getCapabilities(): Promise<ComputerUseCapabilities> {
    return this.model()?.capabilities ?? { ...EMPTY_CAPABILITIES, local: !this.hosted }
  }

  isAvailable(context: ComputerUseContext): Promise<boolean> {
    if (this.config.endpoint === undefined || this.config.endpoint.length === 0) return Promise.resolve(false)
    if (!this.hosted) return Promise.resolve(true)
    const settings = this.options.settings()
    const privacy = context.privacy ?? { allowRemoteScreen: settings.allowRemoteScreen, mode: settings.mode as ComputerUseMode }
    return Promise.resolve(privacy.allowRemoteScreen && privacy.mode !== "local_only")
  }

  estimateCost(): Promise<CostEstimate> {
    return Promise.resolve({ usd: this.hosted ? 0.01 : 0, note: this.hosted ? "Remote endpoint pricing varies." : "Local endpoint." })
  }

  estimateLatency(): Promise<LatencyEstimate> {
    return Promise.resolve({ expectedMs: this.hosted ? 1500 : 800 })
  }

  getModels(): Promise<readonly ComputerUseModel[]> {
    const model = this.model()
    return Promise.resolve(model === undefined ? [] : [model])
  }

  async analyze(request: ComputerUseRequest, context?: ComputerUseContext): Promise<ComputerUseResult> {
    const started = Date.now()
    const model = this.model()
    if (this.config.endpoint === undefined) {
      return { success: false, provider: this.id, confidence: 0, reasoning: "No endpoint is configured.", latencyMs: 0 }
    }
    if (request.screenshot === undefined) {
      return { success: false, provider: this.id, confidence: 0, reasoning: "A screenshot is required.", latencyMs: 0 }
    }
    try {
      const response = await fetch(this.config.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.config.token === undefined ? {} : { authorization: `Bearer ${this.config.token}` }),
        },
        body: JSON.stringify({
          model: this.config.model ?? this.id,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: buildVisionPrompt(request) },
                { type: "image_url", image_url: { url: imageToDataUrl(request.screenshot) } },
              ],
            },
          ],
          max_tokens: 256,
          temperature: 0,
        }),
      })
      if (!response.ok) {
        return { success: false, provider: this.id, confidence: 0, reasoning: `Endpoint returned HTTP ${response.status}.`, latencyMs: Date.now() - started }
      }
      const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
      const text = body.choices?.[0]?.message?.content ?? ""
      const parsed = parseShowUiAction(text, request.screenshot, model?.coordinateSpace)
      if (parsed === undefined) {
        return {
          success: false,
          provider: this.id,
          model: model?.id,
          confidence: 0.15,
          reasoning: text.slice(0, 300),
          latencyMs: Date.now() - started,
          metadata: { raw: text.slice(0, 1000) },
        }
      }
      if (parsed.action.target !== undefined) {
        const unsafe = validateGroundedPoint({
          x: parsed.action.target.x,
          y: parsed.action.target.y,
          targetDescription: request.targetDescription,
          taskContext: request.taskContext,
          screenshot: request.screenshot,
          semanticElements: request.semanticContext?.elements,
          allowTitleBarClicks: allowTitleBarClicksFor(this.options, context),
        })
        if (unsafe !== undefined) {
          return {
            success: false,
            provider: this.id,
            model: model?.id,
            confidence: 0.15,
            reasoning: unsafe,
            evidence: [...parsed.evidence, `rejected point (${parsed.action.target.x}, ${parsed.action.target.y})`],
            latencyMs: Date.now() - started,
            metadata: { format: parsed.format },
          }
        }
      }
      return {
        success: true,
        provider: this.id,
        model: model?.id,
        action: parsed.action,
        confidence: operationConfidence(parsed.confidence, parsed.action, request.requestedOperation),
        reasoning: text.slice(0, 300),
        evidence: parsed.evidence,
        latencyMs: Date.now() - started,
        metadata: { format: parsed.format },
      }
    } catch (error) {
      return {
        success: false,
        provider: this.id,
        confidence: 0,
        reasoning: error instanceof Error ? error.message : "Endpoint request failed.",
        latencyMs: Date.now() - started,
      }
    }
  }

  private model(): ComputerUseModel | undefined {
    return this.options.catalog.find((entry) => entry.provider === this.id)
  }
}

function hostedProviders(options: ProviderOptions, env: NodeJS.ProcessEnv): ComputerUseProvider[] {
  return options.catalog
    .filter((model) => !model.local)
    .map((model) => {
      const config: EndpointConfig = {
        endpoint: env.OMNIA_COMPUTER_USE_HOSTED_URL,
        token: env.OMNIA_COMPUTER_USE_HOSTED_API_KEY,
        model: env.OMNIA_COMPUTER_USE_HOSTED_MODEL,
      }
      return new HostedVisionProvider(model.provider, model.displayName, options, config)
    })
}

class HostedVisionProvider extends EndpointVisionProvider {
  constructor(id: string, name: string, options: ProviderOptions, config: EndpointConfig) {
    super(id, name, options, config, true)
  }
}

const EMPTY_CAPABILITIES: ComputerUseCapabilities = {
  visualGrounding: false,
  click: false,
  doubleClick: false,
  rightClick: false,
  type: false,
  scroll: false,
  drag: false,
  resize: false,
  keyboardShortcuts: false,
  local: true,
  supportedBackends: [],
}

export function imageToDataUrl(image: ImageReference): string {
  if (image.dataUrl !== undefined) return image.dataUrl
  if (image.path === undefined) return ""
  const bytes = readFileSync(image.path)
  return `data:image/png;base64,${bytes.toString("base64")}`
}

// Local vision inference is dominated by prompt processing, and a full-screen
// PNG costs far more image tokens than the model needs. Downscale and encode
// to JPEG when ffmpeg is available; the UI-TARS prompt uses 0-1000 normalized
// coordinates, so a smaller image does not change the output space.
async function compressScreenshot(path: string): Promise<string | undefined> {
  const result = await run(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      path,
      "-vf",
      "scale='min(1024,iw)':-2",
      "-frames:v",
      "1",
      "-f",
      "mjpeg",
      "-q:v",
      "4",
      "pipe:1",
    ],
    { timeout: 20000, maxBuffer: 32 * 1024 * 1024, encoding: "buffer" },
  ).catch(() => undefined)
  if (result === undefined) return undefined
  const output = result.stdout as unknown as Buffer
  if (!Buffer.isBuffer(output) || output.length === 0) return undefined
  return `data:image/jpeg;base64,${output.toString("base64")}`
}

// UI-TARS 2B grounding collapses on tiny clustered title-bar buttons when the
// full screen is downscaled to min(1024,iw) JPEG q4 before inference: 0-1000
// normalized coords give 1 unit ~= 1.92px on a 1920px screen, so adjacent
// buttons ~9px apart quantize to the same cell (observed identical (1834,45)
// twice vs Close (1843,45)). The crop path below bypasses the 1024/q4
// downscale for the top-right strip: crop 400x120 at full resolution, encode
// JPEG q90 (ffmpeg mjpeg -q:v 2), and map raw 0-1000 back via the existing
// ImageReference.region offset in parse.ts resolvePoint.
export const TITLE_BAR_CROP_WIDTH = 400
export const TITLE_BAR_CROP_HEIGHT = 120
export const SMALL_TARGET_PX = 30

export interface CropRegion {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export function titleBarCropFor(image: ImageReference): CropRegion {
  const width = Math.min(TITLE_BAR_CROP_WIDTH, image.width)
  const height = Math.min(TITLE_BAR_CROP_HEIGHT, image.height)
  return { x: Math.max(0, image.width - width), y: 0, width, height }
}

const TITLE_BAR_INTENT = /clos(e|ing)|minimi[sz]e|maximi[sz]e|title.?bar|window (control|button|chrome|decoration)|top.?right/i

export function shouldUseCropPath(request: ComputerUseRequest): boolean {
  const text = `${request.targetDescription ?? ""} ${request.taskContext ?? ""}`
  if (TITLE_BAR_INTENT.test(text)) return true
  const elements = request.semanticContext?.elements ?? []
  const query = (request.targetDescription ?? "").trim().toLowerCase()
  for (const element of elements) {
    const bounds = element.bounds
    if (bounds === undefined) continue
    if (bounds.width >= SMALL_TARGET_PX && bounds.height >= SMALL_TARGET_PX) continue
    if (query.length === 0) return true
    const name = (element.name ?? "").toLowerCase()
    const label = (element.text ?? "").toLowerCase()
    if (name.length > 0 && (name.includes(query) || query.includes(name))) return true
    if (label.length > 0 && (label.includes(query) || query.includes(label))) return true
  }
  return false
}

export async function compressScreenshotHighResCrop(
  path: string,
  region: CropRegion,
): Promise<{ dataUrl: string; sha256: string } | undefined> {
  const result = await run(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      path,
      "-vf",
      `crop=${region.width}:${region.height}:${region.x}:${region.y}`,
      "-frames:v",
      "1",
      "-f",
      "mjpeg",
      "-q:v",
      "2",
      "pipe:1",
    ],
    { timeout: 20000, maxBuffer: 32 * 1024 * 1024, encoding: "buffer" },
  ).catch(() => undefined)
  if (result === undefined) return undefined
  const output = result.stdout as unknown as Buffer
  if (!Buffer.isBuffer(output) || output.length === 0) return undefined
  return {
    dataUrl: `data:image/jpeg;base64,${output.toString("base64")}`,
    sha256: createHash("sha256").update(output).digest("hex"),
  }
}

export function extractRawUiTarsPoint(text: string): { x: number; y: number } | undefined {
  const match = text.match(/\(?(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\)?/)
  if (match?.[1] === undefined || match[2] === undefined) return undefined
  const x = Number(match[1])
  const y = Number(match[2])
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined
  return { x, y }
}

async function imageForModel(image: ImageReference): Promise<string> {
  if (image.dataUrl !== undefined) return image.dataUrl
  if (image.path === undefined) return ""
  const compressed = await compressScreenshot(image.path)
  if (compressed !== undefined) return compressed
  return `data:image/png;base64,${readFileSync(image.path).toString("base64")}`
}

function buildUiTarsPrompt(request: ComputerUseRequest): string {
  const semantic = request.semanticContext
  const hints =
    semantic === undefined || semantic.elements.length === 0
      ? ""
      : [
          "",
          "## Semantic context (authoritative when present)",
          ...semantic.elements
            .filter((element) => element.bounds !== undefined)
            .slice(0, 12)
            .map((element) => {
              const bounds = element.bounds!
              return `- ${element.role ?? "element"} "${element.name ?? element.text ?? ""}" at (${bounds.x}, ${bounds.y}) size ${bounds.width}x${bounds.height}`
            }),
        ].join("\n")
  return [
    "You are a GUI agent. You are given a task and a screenshot. Perform the next action to complete the task.",
    "",
    "## Output Format",
    "Action: ...",
    "",
    "## Action Space",
    "click(start_box='<|box_start|>(x,y)<|box_end|>')",
    "left_double(start_box='<|box_start|>(x,y)<|box_end|>')",
    "right_single(start_box='<|box_start|>(x,y)<|box_end|>')",
    "drag(start_box='<|box_start|>(x,y)<|box_end|>', end_box='<|box_start|>(x,y)<|box_end|>')",
    "type(content='')",
    "hotkey(key='')",
    "scroll(start_box='<|box_start|>(x,y)<|box_end|>', direction='down')",
    "wait()",
    "finished()",
    "",
    "Coordinates are normalized to 0-1000 relative to the screenshot.",
    hints,
    "",
    "## User Instruction",
    request.taskContext ?? instructionFor(request),
  ].join("\n")
}

function buildUiTarsCropPrompt(request: ComputerUseRequest, crop: CropRegion): string {
  return [
    "You are a GUI agent. You are given a task and a screenshot. Perform the next action to complete the task.",
    "",
    "## Output Format",
    "Action: ...",
    "",
    "## Action Space",
    "click(start_box='<|box_start|>(x,y)<|box_end|>')",
    "left_double(start_box='<|box_start|>(x,y)<|box_end|>')",
    "right_single(start_box='<|box_start|>(x,y)<|box_end|>')",
    "drag(start_box='<|box_start|>(x,y)<|box_end|>', end_box='<|box_start|>(x,y)<|box_end|>')",
    "type(content='')",
    "hotkey(key='')",
    "scroll(start_box='<|box_start|>(x,y)<|box_end|>', direction='down')",
    "wait()",
    "finished()",
    "",
    "Coordinates are normalized to 0-1000 relative to THIS CROPPED screenshot.",
    `This image is a high-resolution crop of the full screen at (${crop.x}, ${crop.y}) size ${crop.width}x${crop.height}; do not add the offset yourself.`,
    "",
    "## User Instruction",
    request.taskContext ?? instructionFor(request),
  ].join("\n")
}

function buildVisionPrompt(request: ComputerUseRequest): string {
  return [
    "You are a GUI grounding model. Reply with JSON only.",
    'For pointing actions reply {"action": "click", "coordinate": [x, y]} with absolute pixel coordinates.',
    'For drag reply {"action": "drag", "coordinate": [x, y], "end": [x, y]}.',
    'For typing reply {"action": "type", "value": "text"}.',
    "",
    `Operation: ${request.requestedOperation}`,
    `Target: ${request.targetDescription ?? "the described control"}`,
    request.taskContext === undefined ? "" : `Task: ${request.taskContext}`,
  ].join("\n")
}

function instructionFor(request: ComputerUseRequest): string {
  const target = request.targetDescription ?? "the relevant control"
  switch (request.requestedOperation) {
    case "click":
      return `Click ${target}.`
    case "type":
      return `Click ${target} and type the requested text.`
    case "scroll":
      return `Scroll at ${target}.`
    case "drag":
      return `Drag ${target}.`
    case "resize":
      return `Resize ${target}.`
    case "ground":
      return `Point at ${target}.`
    case "inspect":
      return `Describe the state of ${target}.`
    default:
      return `Interact with ${target}.`
  }
}

function operationConfidence(base: number, action: ComputerUseAction, requested: string): number {
  const compatible =
    (requested === "click" && (action.type === "click" || action.type === "double_click" || action.type === "right_click")) ||
    (requested === "drag" && action.type === "drag") ||
    (requested === "type" && action.type === "type") ||
    (requested === "scroll" && action.type === "scroll") ||
    (requested === "ground" && action.target !== undefined) ||
    (requested === "resize" && (action.type === "drag" || action.type === "resize")) ||
    (requested === "inspect" && action.target !== undefined)
  if (compatible) return base
  if (action.type === "wait" || action.type === "finished") return base * 0.5
  return base * 0.6
}

interface ElementMatch {
  readonly element: SemanticElement
  readonly score: number
  readonly exact: boolean
}

function bestMatch(elements: readonly SemanticElement[], description: string): ElementMatch | undefined {
  const query = description.trim().toLowerCase()
  if (query.length === 0) return undefined
  let best: ElementMatch | undefined
  for (const element of elements) {
    if (element.bounds === undefined) continue
    const name = (element.name ?? "").toLowerCase()
    const text = (element.text ?? "").toLowerCase()
    const role = (element.role ?? "").toLowerCase()
    const exact = name === query || text === query
    const nameScore = name.includes(query) ? 0.6 : query.includes(name) && name.length > 2 ? 0.4 : 0
    const textScore = text.includes(query) ? 0.3 : 0
    const roleScore = role.includes(query) ? 0.2 : 0
    const score = Math.min(1, nameScore + textScore + roleScore + (exact ? 0.25 : 0))
    if (score <= 0) continue
    if (best === undefined || score > best.score) best = { element, score, exact }
  }
  return best
}

function actionForOperation(operation: string, element: SemanticElement, text?: string): ComputerUseAction | undefined {
  const bounds = element.bounds
  if (bounds === undefined) return undefined
  const point = { x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 2) }
  switch (operation) {
    case "click":
      return { type: "click", target: { x: point.x, y: point.y, width: bounds.width, height: bounds.height, label: element.name ?? element.text } }
    case "ground":
      return { type: "click", target: { x: point.x, y: point.y, width: bounds.width, height: bounds.height, label: element.name ?? element.text } }
    case "type":
      return { type: "type", text: text ?? "", target: { x: point.x, y: point.y, width: bounds.width, height: bounds.height } }
    case "scroll":
      return { type: "scroll", direction: "down", target: { x: point.x, y: point.y, width: bounds.width, height: bounds.height } }
    case "drag":
      return {
        type: "drag",
        target: { x: point.x, y: point.y, width: bounds.width, height: bounds.height },
        path: [
          { x: point.x, y: point.y },
          { x: Math.round(bounds.x + bounds.width), y: Math.round(bounds.y + bounds.height) },
        ],
      }
    case "inspect":
      return undefined
    default:
      return { type: "click", target: { x: point.x, y: point.y } }
  }
}
