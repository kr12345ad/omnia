export type ComputerUsePlatform = "macos" | "windows" | "linux"

export type ComputerUseOperation = "ground" | "click" | "type" | "scroll" | "drag" | "resize" | "inspect" | "general"

export type ComputerUseMode = "automatic" | "local_only" | "hosted_only" | "ask"

export interface ComputerUseCapabilities {
  readonly visualGrounding: boolean
  readonly click: boolean
  readonly doubleClick: boolean
  readonly rightClick: boolean
  readonly type: boolean
  readonly scroll: boolean
  readonly drag: boolean
  readonly resize: boolean
  readonly keyboardShortcuts: boolean
  readonly maxImageWidth?: number
  readonly maxImageHeight?: number
  readonly local: boolean
  readonly supportedPlatforms?: readonly ComputerUsePlatform[]
  readonly supportedBackends?: readonly string[]
}

export interface ImageReference {
  readonly path?: string
  readonly dataUrl?: string
  readonly width: number
  readonly height: number
  readonly region?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
}

export interface SemanticElement {
  readonly elementId?: string
  readonly role?: string
  readonly name?: string
  readonly text?: string
  readonly bounds?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  readonly states?: readonly string[]
  readonly source?: "accessibility" | "dom" | "native" | "document" | "vision"
}

export interface SemanticEnvironment {
  readonly coverage: number
  readonly applicationId?: string
  readonly windowTitle?: string
  readonly elements: readonly SemanticElement[]
  readonly text?: string
  readonly backend?: string
  readonly conflicts?: readonly SourceConflict[]
}

export interface SourceConflict {
  readonly field: string
  readonly authoritative: string
  readonly source: string
  readonly observed: string
}

export interface ComputerUseContext {
  readonly computerId: string
  readonly requestedOperation: ComputerUseOperation
  readonly targetDescription?: string
  readonly semanticContext?: SemanticEnvironment
  readonly platform?: ComputerUsePlatform
  readonly image?: ImageReference
  readonly privacy?: ComputerUsePrivacy
  readonly preferences?: ComputerUsePreferences
}

export interface ComputerUsePrivacy {
  readonly allowRemoteScreen: boolean
  readonly mode: ComputerUseMode
  readonly sensitive?: boolean
}

export interface ComputerUsePreferences {
  readonly preferredLocalModel?: string
  readonly preferredHostedProvider?: string
  readonly maxLatencyMs?: number
  readonly maxMemoryBytes?: number
  readonly allowDownloads?: boolean
  readonly allowAutoLoad?: boolean
  readonly maxRetries?: number
  readonly allowTitleBarClicks?: boolean
}

export interface ComputerUseRequest {
  readonly computerId: string
  readonly screenshot?: ImageReference
  readonly semanticContext?: SemanticEnvironment
  readonly taskContext?: string
  readonly question?: string
  readonly requestedOperation: ComputerUseOperation
  readonly targetDescription?: string
  readonly preferredProvider?: string
  readonly timeoutMs?: number
}

export interface ComputerUseAction {
  readonly type: string
  readonly target?: {
    readonly x?: number
    readonly y?: number
    readonly width?: number
    readonly height?: number
    readonly label?: string
  }
  readonly text?: string
  readonly key?: string
  readonly direction?: string
  readonly path?: readonly { readonly x: number; readonly y: number }[]
}

export interface ComputerUseResult {
  readonly success: boolean
  readonly provider: string
  readonly model?: string
  readonly action?: ComputerUseAction
  readonly confidence: number
  readonly reasoning?: string
  readonly evidence?: readonly string[]
  readonly latencyMs: number
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface CostEstimate {
  readonly usd: number
  readonly note?: string
}

export interface LatencyEstimate {
  readonly expectedMs: number
  readonly note?: string
}

export interface ComputerUseProvider {
  readonly id: string
  readonly name: string
  getCapabilities(): Promise<ComputerUseCapabilities>
  isAvailable(context: ComputerUseContext): Promise<boolean>
  estimateCost(context: ComputerUseContext): Promise<CostEstimate>
  estimateLatency(context: ComputerUseContext): Promise<LatencyEstimate>
  analyze(request: ComputerUseRequest, context?: ComputerUseContext): Promise<ComputerUseResult>
}

export interface HostedComputerUseProvider extends ComputerUseProvider {
  getModels(): Promise<readonly ComputerUseModel[]>
}

export type ComputerUseModelState =
  | "NOT_INSTALLED"
  | "DOWNLOADING"
  | "INSTALLED"
  | "STARTING"
  | "READY"
  | "LOADING"
  | "UNLOADING"
  | "FAILED"
  | "DISABLED"

export interface ComputerUseModel {
  readonly id: string
  readonly displayName: string
  readonly provider: string
  readonly local: boolean
  readonly capabilities: ComputerUseCapabilities
  readonly modelSizeBytes?: number
  readonly estimatedMemoryBytes?: number
  readonly quantization?: string
  readonly supportedBackends: readonly string[]
  readonly enabled: boolean
  readonly recommended?: boolean
  readonly description?: string
  readonly source?: ComputerUseModelSource
  readonly coordinateSpace?: "normalized-1" | "normalized-1000" | "absolute"
  readonly chatTemplate?: string
  readonly quality?: number
  readonly priority?: number
}

export interface ComputerUseModelSource {
  readonly type: "huggingface"
  readonly repo: string
  readonly file: string
  readonly mmprojFile?: string
  readonly mmprojBytes?: number
}

export interface ComputerUseModelStatus {
  readonly model: ComputerUseModel
  readonly state: ComputerUseModelState
  readonly installed: boolean
  readonly loaded: boolean
  readonly progress?: number
  readonly bytesOnDisk?: number
  readonly runtimeBackend?: string
  readonly reason?: string
  readonly lastUsedAt?: number
}

export type ComputerUseRuntimeVariant = "cpu" | "cuda" | "rocm" | "vulkan" | "metal"

export interface ComputerUseRuntimeArchive {
  readonly url: string
  readonly bytes?: number
}

export interface ComputerUseRuntime {
  readonly id: string
  readonly variant: ComputerUseRuntimeVariant
  readonly displayName: string
  readonly description?: string
  readonly backend: string
  readonly platforms: readonly string[]
  readonly archives: readonly ComputerUseRuntimeArchive[]
}

export interface ComputerUseRuntimeStatus {
  readonly runtime: ComputerUseRuntime
  readonly state: ComputerUseModelState
  readonly installed: boolean
  readonly bundled: boolean
  readonly progress?: number
  readonly bytes?: number
  readonly bytesOnDisk?: number
  readonly reason?: string
}

export interface HardwareGpu {
  readonly vendor: string
  readonly name: string
  readonly vramBytes?: number
  readonly backend: "cuda" | "rocm" | "vulkan" | "metal"
}

export interface HardwareReport {
  readonly os: string
  readonly platform: ComputerUsePlatform
  readonly arch: string
  readonly cpuName?: string
  readonly cpuCores: number
  readonly memoryTotalBytes: number
  readonly memoryFreeBytes: number
  readonly unifiedMemory: boolean
  readonly gpus: readonly HardwareGpu[]
  readonly diskFreeBytes?: number
  readonly backends: readonly string[]
}

export interface ModelCompatibility {
  readonly compatible: boolean
  readonly backend: string
  readonly estimatedMemoryBytes: number
  readonly reasons: readonly string[]
  readonly warnings: readonly string[]
}

export interface RoutingWeights {
  readonly capabilityMatch: number
  readonly quality: number
  readonly hardwareFit: number
  readonly latencyScore: number
  readonly privacyScore: number
  readonly costScore: number
}

export interface RoutingCandidate {
  readonly provider: string
  readonly model?: string
  readonly local: boolean
  readonly score: number
  readonly excluded?: string
  readonly factors: Readonly<Record<string, number>>
}

export interface RoutingDecision {
  readonly provider: string
  readonly model?: string
  readonly local: boolean
  readonly reason: readonly string[]
  readonly candidates: readonly RoutingCandidate[]
  readonly semanticCoverage: number
  readonly operation: ComputerUseOperation
  readonly weights: RoutingWeights
  readonly requiresApproval?: boolean
  readonly estimatedLatencyMs?: number
  readonly estimatedCostUsd?: number
  readonly blockedByPolicy?: boolean
}

export interface ComputerUseRouter {
  route(context: ComputerUseContext): Promise<RoutingDecision>
}

export interface ComputerUseSettings {
  readonly mode: ComputerUseMode
  readonly preferredLocalModel?: string
  readonly preferredHostedProvider?: string
  readonly allowDownloads: boolean
  readonly allowAutoLoad: boolean
  readonly allowRemoteScreen: boolean
  readonly maxMemoryBytes?: number
  readonly maxLatencyMs?: number
  readonly maxRetries: number
  readonly idleUnloadMs: number
  readonly allowTitleBarClicks?: boolean
}

export interface ComputerUseStatus {
  readonly mode: ComputerUseMode
  readonly semanticAvailable: boolean
  readonly localRuntime: {
    readonly available: boolean
    readonly command?: string
    readonly backend?: string
    readonly reason?: string
  }
  readonly residentModel?: string
  readonly installedModels: number
  readonly hardware: HardwareReport
  readonly providers: readonly {
    readonly id: string
    readonly name: string
    readonly local: boolean
    readonly available: boolean
    readonly reason?: string
  }[]
}
