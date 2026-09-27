import type { ComputerUseCapabilities, ComputerUseModel } from "./types"

const GB = 1e9
const OVERHEAD_BYTES = 0.35 * GB

export interface QuantSpec {
  readonly quant: string
  readonly bytes: number
  readonly quality: number
  readonly note: string
}

// UI-TARS 2B is the default local grounding model: it is purpose-built for
// GUI grounding and emits normalized-1000 actions that the computer-use
// pipeline parses directly. It uses its native chat template, so no
// chatTemplate override is set for it (see local.ts per-model gating).
// Moondream 2 stays in the catalog as the describe/inspect fallback: it only
// has to answer "what is this?" with text. Its vision projector is only
// published as f16 upstream; there is no quantized mmproj.
export const MOONDREAM_MODEL_BYTES = 919_494_048
export const MOONDREAM_MMPROJ_BYTES = 910_000_000
export const MOONDREAM_RECOMMENDED_QUANT = "Q4_K"

// Byte sizes verified against bartowski/UI-TARS-2B-SFT-GGUF and the weights
// bundled under packages/desktop/resources/models/computer-use/ui-tars.
// checkFile() in local.ts tolerates files larger than 90% of these values,
// and download() skips files that already exist, so the on-disk weights are
// reused and never re-downloaded.
export const UI_TARS_MODEL_BYTES = 1_117_319_712
export const UI_TARS_MMPROJ_BYTES = 1_331_656_192

export const UI_TARS_QUANTS: readonly QuantSpec[] = [
  { quant: "F32", bytes: 7.11 * GB, quality: 1.0, note: "Full F32 weights; reference quality only." },
  { quant: "F16", bytes: 3.56 * GB, quality: 0.98, note: "Full F16 weights; highest practical quality." },
  { quant: "Q8_0", bytes: 1.89 * GB, quality: 0.96, note: "Extremely high quality, generally unneeded." },
  { quant: "Q6_K_L", bytes: 1.58 * GB, quality: 0.95, note: "Very high quality, near perfect." },
  { quant: "Q6_K", bytes: 1.46 * GB, quality: 0.94, note: "Very high quality, near perfect." },
  { quant: "Q5_K_L", bytes: 1.43 * GB, quality: 0.93, note: "High quality." },
  { quant: "Q5_K_M", bytes: 1.29 * GB, quality: 0.92, note: "High quality." },
  { quant: "Q4_K_L", bytes: 1.29 * GB, quality: 0.91, note: "Good quality." },
  { quant: "Q5_K_S", bytes: 1.26 * GB, quality: 0.9, note: "High quality." },
  { quant: "Q3_K_XL", bytes: 1.18 * GB, quality: 0.85, note: "Lower quality but usable; good for low memory." },
  { quant: "Q4_1", bytes: 1.16 * GB, quality: 0.88, note: "Legacy format; good tokens per watt on Apple silicon." },
  { quant: "Q4_K_M", bytes: 1.12 * GB, quality: 0.9, note: "Default size for most use cases; best CPU and GPU balance." },
  { quant: "Q4_K_S", bytes: 1.07 * GB, quality: 0.88, note: "Slightly lower quality with more space savings." },
  { quant: "Q4_0", bytes: 1.07 * GB, quality: 0.84, note: "Legacy format with online repacking on ARM and AVX CPUs." },
  { quant: "IQ4_NL", bytes: 1.07 * GB, quality: 0.87, note: "Smaller than Q4_K_S with similar performance." },
  { quant: "IQ4_XS", bytes: 1.02 * GB, quality: 0.87, note: "Decent quality, smaller than Q4_K_S." },
  { quant: "Q3_K_L", bytes: 0.98 * GB, quality: 0.82, note: "Lower quality but usable; good for low memory." },
  { quant: "Q2_K_L", bytes: 0.98 * GB, quality: 0.78, note: "Very low quality but surprisingly usable." },
  { quant: "Q3_K_M", bytes: 0.92 * GB, quality: 0.8, note: "Low quality." },
  { quant: "IQ3_M", bytes: 0.88 * GB, quality: 0.79, note: "Medium-low quality with decent performance." },
  { quant: "Q3_K_S", bytes: 0.86 * GB, quality: 0.76, note: "Low quality, not recommended." },
  { quant: "IQ3_XS", bytes: 0.83 * GB, quality: 0.77, note: "Lower quality, slightly better than Q3_K_S." },
  { quant: "Q2_K", bytes: 0.75 * GB, quality: 0.72, note: "Very low quality but surprisingly usable." },
  { quant: "IQ2_M", bytes: 0.7 * GB, quality: 0.7, note: "Relatively low quality for very tight memory." },
]

export const UI_TARS_RECOMMENDED_QUANT = "Q4_K_M"

const MOONDREAM_CAPABILITIES: ComputerUseCapabilities = {
  visualGrounding: true,
  click: true,
  doubleClick: true,
  rightClick: true,
  type: true,
  scroll: true,
  drag: false,
  resize: false,
  keyboardShortcuts: true,
  maxImageWidth: 16384,
  maxImageHeight: 16384,
  local: true,
  supportedPlatforms: ["macos", "windows", "linux"],
  supportedBackends: ["cpu", "vulkan", "cuda", "metal"],
}

const UI_TARS_CAPABILITIES: ComputerUseCapabilities = {
  visualGrounding: true,
  click: true,
  doubleClick: true,
  rightClick: true,
  type: true,
  scroll: true,
  drag: false,
  resize: false,
  keyboardShortcuts: true,
  maxImageWidth: 16384,
  maxImageHeight: 16384,
  local: true,
  supportedPlatforms: ["macos", "windows", "linux"],
  supportedBackends: ["cpu", "vulkan", "cuda", "metal"],
}

const SHOWUI_CAPABILITIES: ComputerUseCapabilities = {
  visualGrounding: true,
  click: true,
  doubleClick: true,
  rightClick: true,
  type: true,
  scroll: true,
  drag: false,
  resize: false,
  keyboardShortcuts: false,
  maxImageWidth: 8192,
  maxImageHeight: 8192,
  local: true,
  supportedPlatforms: ["macos", "windows", "linux"],
  supportedBackends: ["cpu", "cuda", "metal", "vulkan"],
}

const SHOWUI_PI_CAPABILITIES: ComputerUseCapabilities = {
  ...SHOWUI_CAPABILITIES,
  drag: true,
  resize: true,
  keyboardShortcuts: true,
}

export interface CatalogOptions {
  readonly env?: NodeJS.ProcessEnv
}

export function createComputerUseCatalog(options: CatalogOptions = {}): ComputerUseModel[] {
  const env = options.env ?? process.env
  const moondream: ComputerUseModel = {
    id: "moondream-2-q4_k",
    displayName: "Moondream 2 Q4_K",
    provider: "moondream",
    local: true,
    capabilities: MOONDREAM_CAPABILITIES,
    modelSizeBytes: MOONDREAM_MODEL_BYTES,
    estimatedMemoryBytes: Math.round(MOONDREAM_MODEL_BYTES + MOONDREAM_MMPROJ_BYTES + OVERHEAD_BYTES),
    quantization: "q4_k",
    supportedBackends: ["cpu", "vulkan", "cuda", "metal"],
    enabled: true,
    description: "Describes what is on screen and answers questions about it. Describe/inspect fallback; grounding defaults to UI-TARS.",
    source: {
      type: "huggingface",
      repo: "salivosa/moondream2-gguf",
      file: "moondream2-q4_k.gguf",
      mmprojFile: "moondream2-mmproj-f16.gguf",
      mmprojBytes: MOONDREAM_MMPROJ_BYTES,
    },
    coordinateSpace: "normalized-1",
    chatTemplate:
      "{% for message in messages %}{% if message['role'] == 'user' %}<image>\nQuestion: {{ message['content'] }}\n\nAnswer:{% endif %}{% endfor %}",
    quality: 0.88,
    priority: 100,
  }
  const uitars: ComputerUseModel = {
    id: "ui-tars-2b-q4_k_m",
    displayName: "UI-TARS 2B Q4_K_M",
    provider: "ui-tars",
    local: true,
    capabilities: UI_TARS_CAPABILITIES,
    modelSizeBytes: UI_TARS_MODEL_BYTES,
    estimatedMemoryBytes: Math.round(UI_TARS_MODEL_BYTES + UI_TARS_MMPROJ_BYTES + OVERHEAD_BYTES),
    quantization: "q4_k_m",
    supportedBackends: ["cpu", "vulkan", "cuda", "metal"],
    enabled: true,
    recommended: true,
    description: "Purpose-built GUI grounding model. Default for ground/click with normalized-1000 coordinates.",
    source: {
      type: "huggingface",
      repo: "bartowski/UI-TARS-2B-SFT-GGUF",
      file: "UI-TARS-2B-SFT-Q4_K_M.gguf",
      mmprojFile: "mmproj-UI-TARS-2B-SFT-f16.gguf",
      mmprojBytes: UI_TARS_MMPROJ_BYTES,
    },
    coordinateSpace: "normalized-1000",
    quality: 0.9,
    priority: 110,
  }
  const showui: ComputerUseModel = {
    id: "showui-2b",
    displayName: "ShowUI 2B",
    provider: "showui",
    local: true,
    capabilities: SHOWUI_CAPABILITIES,
    estimatedMemoryBytes: Math.round(3.2 * GB),
    quantization: "q4",
    supportedBackends: ["cpu", "cuda", "metal", "vulkan"],
    enabled: true,
    description: "General GUI grounding model. Configure a local or hosted endpoint to enable it.",
    coordinateSpace: "absolute",
    quality: 0.84,
    priority: 40,
  }
  const showuiPi: ComputerUseModel = {
    id: "showui-pi",
    displayName: "ShowUI-π",
    provider: "showui-pi",
    local: true,
    capabilities: SHOWUI_PI_CAPABILITIES,
    estimatedMemoryBytes: Math.round(3.4 * GB),
    quantization: "q4",
    supportedBackends: ["cpu", "cuda", "metal", "vulkan"],
    enabled: true,
    description: "Specialist for drag, resize, and continuous pointer movement.",
    coordinateSpace: "absolute",
    quality: 0.86,
    priority: 45,
  }
  const hosted = hostedModels(env)
  return [uitars, moondream, showui, showuiPi, ...hosted]
}

function hostedModels(env: NodeJS.ProcessEnv): ComputerUseModel[] {
  const url = env.OMNIA_COMPUTER_USE_HOSTED_URL
  if (url === undefined || url.length === 0) return []
  const name = env.OMNIA_COMPUTER_USE_HOSTED_NAME ?? "hosted"
  const model = env.OMNIA_COMPUTER_USE_HOSTED_MODEL ?? "computer-use"
  const entries: ComputerUseModel[] = [
    {
      id: `hosted-${name}`,
      displayName: env.OMNIA_COMPUTER_USE_HOSTED_LABEL ?? `Hosted ${name}`,
      provider: `hosted:${name}`,
      local: false,
      capabilities: {
        ...MOONDREAM_CAPABILITIES,
        local: false,
        supportedBackends: [],
        maxImageWidth: 4096,
        maxImageHeight: 4096,
      },
      quantization: "remote",
      supportedBackends: [],
      enabled: true,
      description: `Remote computer-use endpoint at ${url}.`,
      coordinateSpace: env.OMNIA_COMPUTER_USE_HOSTED_COORDS === "absolute" ? "absolute" : "normalized-1000",
      quality: Number(env.OMNIA_COMPUTER_USE_HOSTED_QUALITY ?? "0.92"),
      priority: 60,
    },
  ]
  return entries.map((entry) => ({ ...entry, id: `${entry.id}-${model}` }))
}

export function findModel(catalog: readonly ComputerUseModel[], id: string): ComputerUseModel | undefined {
  return catalog.find((model) => model.id === id)
}

export function recommendedModel(catalog: readonly ComputerUseModel[]): ComputerUseModel | undefined {
  return catalog.find((model) => model.recommended) ?? catalog.find((model) => model.provider === "ui-tars") ?? catalog.find((model) => model.provider === "moondream")
}
