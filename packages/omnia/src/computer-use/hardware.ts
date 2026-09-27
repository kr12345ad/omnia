import { execFile } from "node:child_process"
import { readFileSync, readdirSync, statfsSync } from "node:fs"
import { cpus, freemem, homedir, platform as osPlatform, arch as osArch, totalmem } from "node:os"
import { promisify } from "node:util"
import type { ComputerUseModel, HardwareGpu, HardwareReport, ModelCompatibility } from "./types"

const run = promisify(execFile)

export interface DetectHardwareOptions {
  readonly diskPath?: string
  readonly platform?: NodeJS.Platform
  readonly arch?: string
  readonly probe?: (file: string, args: string[]) => Promise<string | undefined>
}

export async function detectHardware(options: DetectHardwareOptions = {}): Promise<HardwareReport> {
  const platform = options.platform ?? osPlatform()
  const arch = options.arch ?? osArch()
  const probe = options.probe ?? defaultProbe
  const gpus = await detectGpus(platform, probe)
  const memoryTotalBytes = totalmem()
  const unifiedMemory = platform === "darwin"
  return {
    os: platform,
    platform: platform === "darwin" ? "macos" : platform === "win32" ? "windows" : "linux",
    arch,
    cpuName: detectCpuName(platform),
    cpuCores: cpus().length,
    memoryTotalBytes,
    memoryFreeBytes: freemem(),
    unifiedMemory,
    gpus,
    diskFreeBytes: detectDiskFree(options.diskPath ?? homedir()),
    backends: ["cpu", ...new Set(gpus.map((gpu) => gpu.backend))],
  }
}

async function defaultProbe(file: string, args: string[]): Promise<string | undefined> {
  const result = await run(file, args, { timeout: 5000 }).catch(() => undefined)
  return result?.stdout
}

async function detectGpus(platform: NodeJS.Platform, probe: DetectHardwareOptions["probe"]): Promise<HardwareGpu[]> {
  if (platform === "darwin") {
    const name = await probe!("system_profiler", ["SPDisplaysDataType", "-json"]).catch(() => undefined)
    const parsed = name === undefined ? undefined : parseAppleGpu(name)
    return [{ vendor: "apple", name: parsed ?? "Apple GPU", backend: "metal" }]
  }
  const nvidia = await probe!("nvidia-smi", [
    "--query-gpu=name,memory.total",
    "--format=csv,noheader,nounits",
  ]).catch(() => undefined)
  const gpus: HardwareGpu[] = []
  if (nvidia !== undefined) {
    for (const line of nvidia.split("\n")) {
      const [name, memory] = line.split(",").map((part) => part.trim())
      if (name === undefined || name.length === 0) continue
      const mib = Number(memory)
      gpus.push({
        vendor: "nvidia",
        name,
        backend: "cuda",
        ...(Number.isFinite(mib) ? { vramBytes: Math.round(mib * 1024 * 1024) } : {}),
      })
    }
  }
  gpus.push(...detectAmdGpus())
  if (gpus.length === 0) {
    const lspci = await probe!("lspci", []).catch(() => undefined)
    const parsed = lspci === undefined ? undefined : parseLspciGpu(lspci)
    if (parsed !== undefined) gpus.push({ vendor: parsed.vendor, name: parsed.name, backend: "vulkan" })
  }
  return gpus
}

function detectAmdGpus(): HardwareGpu[] {
  const dirs = readdirSync("/sys/class/drm").filter((entry) => /^card\d+$/.test(entry))
  return dirs.flatMap((entry) => {
    const base = `/sys/class/drm/${entry}/device`
    const vendor = readText(`${base}/vendor`)
    if (vendor === undefined || vendor.trim() !== "0x1002") return []
    const name = readText(`${base}/product_name`) ?? readText(`${base}/device`)
    const vram = Number(readText(`${base}/mem_info_vram_total`))
    return [
      {
        vendor: "amd",
        name: (name ?? "AMD GPU").trim(),
        backend: "rocm" as const,
        ...(Number.isFinite(vram) && vram > 0 ? { vramBytes: vram } : {}),
      },
    ]
  })
}

function parseAppleGpu(json: string): string | undefined {
  const match = json.match(/"sppci_model"\s*:\s*"([^"]+)"/)
  return match?.[1]
}

function parseLspciGpu(output: string): { vendor: string; name: string } | undefined {
  const line = output.split("\n").find((entry) => /VGA compatible controller|3D controller|Display controller/.test(entry))
  if (line === undefined) return undefined
  const name = line.split(":").slice(2).join(":").trim()
  if (name.length === 0) return undefined
  const vendor = /nvidia/i.test(name)
    ? "nvidia"
    : /amd|advanced micro devices|radeon/i.test(name)
      ? "amd"
      : /intel/i.test(name)
        ? "intel"
        : "unknown"
  return { vendor, name }
}

function detectCpuName(platform: NodeJS.Platform): string | undefined {
  if (platform === "darwin") return undefined
  const info = readText("/proc/cpuinfo")
  if (info === undefined) return undefined
  const match = info.match(/^model name\s*:\s*(.+)$/m)
  return match?.[1]?.trim()
}

function readText(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8")
  } catch {
    return undefined
  }
}

function detectDiskFree(path: string): number | undefined {
  const stats = statfsSync(path)
  return stats.bavail * stats.bsize
}

export function estimateCompatibility(
  model: ComputerUseModel,
  hardware: HardwareReport,
  runtimeBackends: readonly string[] = hardware.backends,
): ModelCompatibility {
  const estimatedMemoryBytes = model.estimatedMemoryBytes ?? model.modelSizeBytes ?? 0
  const reasons: string[] = []
  const warnings: string[] = []
  const gpu = hardware.gpus.find((entry) => runtimeBackends.includes(entry.backend))
  if (gpu !== undefined && gpu.vramBytes !== undefined && gpu.vramBytes >= estimatedMemoryBytes) {
    reasons.push(`${gpu.name} has enough VRAM for ${formatBytes(estimatedMemoryBytes)}.`)
    if (model.supportedBackends.length > 0 && !model.supportedBackends.includes(gpu.backend)) {
      warnings.push(`Model metadata does not list the ${gpu.backend} backend; falling back to CPU.`)
      return cpuCompatibility(model, hardware, estimatedMemoryBytes, reasons, warnings)
    }
    return { compatible: true, backend: gpu.backend, estimatedMemoryBytes, reasons, warnings }
  }
  if (gpu !== undefined && gpu.vramBytes !== undefined) {
    warnings.push(
      `${gpu.name} has ${formatBytes(gpu.vramBytes)} of VRAM, below the ${formatBytes(estimatedMemoryBytes)} estimate; CPU inference will be used.`,
    )
  }
  return cpuCompatibility(model, hardware, estimatedMemoryBytes, reasons, warnings)
}

function cpuCompatibility(
  model: ComputerUseModel,
  hardware: HardwareReport,
  estimatedMemoryBytes: number,
  reasons: string[],
  warnings: string[],
): ModelCompatibility {
  const available = hardware.memoryTotalBytes
  if (available < estimatedMemoryBytes) {
    return {
      compatible: false,
      backend: "cpu",
      estimatedMemoryBytes,
      reasons: [`Requires about ${formatBytes(estimatedMemoryBytes)}; this computer has ${formatBytes(available)} of memory.`],
      warnings,
    }
  }
  reasons.push(`CPU backend with ${formatBytes(available)} of memory.`)
  if (!hardware.unifiedMemory && hardware.memoryFreeBytes < estimatedMemoryBytes * 1.2) {
    warnings.push(
      `Only ${formatBytes(hardware.memoryFreeBytes)} is free right now; close other applications before loading this model.`,
    )
  }
  if (model.supportedBackends.length > 0 && !model.supportedBackends.includes("cpu")) {
    return {
      compatible: false,
      backend: "cpu",
      estimatedMemoryBytes,
      reasons: [`Model does not support the CPU backend (${model.supportedBackends.join(", ")}).`],
      warnings,
    }
  }
  return { compatible: true, backend: "cpu", estimatedMemoryBytes, reasons, warnings }
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const value = bytes / 1024 ** index
  return `${value >= 10 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`
}
