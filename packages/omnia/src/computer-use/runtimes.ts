import { execFile } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs"
import { basename, join } from "node:path"
import { promisify } from "node:util"
import type { ComputerUseRuntime, ComputerUseRuntimeArchive } from "./types"

const run = promisify(execFile)

// llama.cpp nightly the runtime downloads are pinned to. Bump together with
// the bundled runtimes under packages/desktop/resources/llama when upgrading.
export const LLAMA_RELEASE_TAG = "b11205"

const releaseUrl = (asset: string) =>
  `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_RELEASE_TAG}/${asset}`

const archive = (asset: string, bytes: number): ComputerUseRuntimeArchive => ({ url: releaseUrl(asset), bytes })

export function defaultRuntimePlatform(): string {
  const platform = process.platform === "win32" ? "win" : process.platform === "darwin" ? "darwin" : "linux"
  return `${platform}-${process.arch === "arm64" ? "arm64" : "x64"}`
}

function linuxX64(): ComputerUseRuntime[] {
  return [
    {
      id: "linux-x64-cpu",
      variant: "cpu",
      displayName: "CPU",
      description: "Runs on any x64 Linux computer. Slowest, but needs no GPU.",
      backend: "cpu",
      platforms: ["linux-x64"],
      archives: [archive("llama-b11205-bin-ubuntu-x64.tar.gz", 17403637)],
    },
    {
      id: "linux-x64-cuda",
      variant: "cuda",
      displayName: "CUDA 12.8",
      description: "NVIDIA GPU acceleration. Requires a CUDA 12-capable driver.",
      backend: "cuda",
      platforms: ["linux-x64"],
      archives: [
        archive("llama-b11205-bin-ubuntu-cuda-12.8-x64.tar.gz", 170927888),
        archive("cudart-llama-b11205-bin-ubuntu-cuda-12.8-x64.tar.gz", 594377688),
      ],
    },
    {
      id: "linux-x64-rocm",
      variant: "rocm",
      displayName: "ROCm 10.0",
      description: "AMD GPU acceleration on supported Radeon hardware.",
      backend: "rocm",
      platforms: ["linux-x64"],
      archives: [archive("llama-b11205-bin-ubuntu-rocm-10.0-x64.tar.gz", 240734213)],
    },
    {
      id: "linux-x64-vulkan",
      variant: "vulkan",
      displayName: "Vulkan",
      description: "GPU acceleration through Vulkan for NVIDIA, AMD, and Intel GPUs.",
      backend: "vulkan",
      platforms: ["linux-x64"],
      archives: [archive("llama-b11205-bin-ubuntu-vulkan-x64.tar.gz", 31346600)],
    },
  ]
}

function linuxArm64(): ComputerUseRuntime[] {
  return [
    {
      id: "linux-arm64-cpu",
      variant: "cpu",
      displayName: "CPU",
      description: "Runs on any arm64 Linux computer.",
      backend: "cpu",
      platforms: ["linux-arm64"],
      archives: [archive("llama-b11205-bin-ubuntu-arm64.tar.gz", 16000000)],
    },
    {
      id: "linux-arm64-vulkan",
      variant: "vulkan",
      displayName: "Vulkan",
      description: "GPU acceleration through Vulkan on arm64 Linux.",
      backend: "vulkan",
      platforms: ["linux-arm64"],
      archives: [archive("llama-b11205-bin-ubuntu-vulkan-arm64.tar.gz", 30000000)],
    },
  ]
}

function winX64(): ComputerUseRuntime[] {
  return [
    {
      id: "win-x64-cpu",
      variant: "cpu",
      displayName: "CPU",
      description: "Runs on any x64 Windows computer.",
      backend: "cpu",
      platforms: ["win-x64"],
      archives: [archive("llama-b11205-bin-win-cpu-x64.zip", 19155045)],
    },
    {
      id: "win-x64-cuda",
      variant: "cuda",
      displayName: "CUDA 12.4",
      description: "NVIDIA GPU acceleration. Requires a CUDA 12-capable driver.",
      backend: "cuda",
      platforms: ["win-x64"],
      archives: [
        archive("llama-b11205-bin-win-cuda-12.4-x64.zip", 263077910),
        archive("cudart-llama-bin-win-cuda-12.4-x64.zip", 391443627),
      ],
    },
    {
      id: "win-x64-vulkan",
      variant: "vulkan",
      displayName: "Vulkan",
      description: "GPU acceleration through Vulkan for NVIDIA, AMD, and Intel GPUs.",
      backend: "vulkan",
      platforms: ["win-x64"],
      archives: [archive("llama-b11205-bin-win-vulkan-x64.zip", 33061695)],
    },
  ]
}

function darwinArm64(): ComputerUseRuntime[] {
  return [
    {
      id: "darwin-arm64-metal",
      variant: "metal",
      displayName: "Metal",
      description: "Apple GPU acceleration through Metal.",
      backend: "metal",
      platforms: ["darwin-arm64"],
      archives: [archive("llama-b11205-bin-macos-arm64.tar.gz", 16000000)],
    },
  ]
}

function darwinX64(): ComputerUseRuntime[] {
  return [
    {
      id: "darwin-x64-metal",
      variant: "metal",
      displayName: "Metal",
      description: "Apple GPU acceleration through Metal.",
      backend: "metal",
      platforms: ["darwin-x64"],
      archives: [archive("llama-b11205-bin-macos-x64.tar.gz", 17000000)],
    },
  ]
}

export function createRuntimeCatalog(platform = defaultRuntimePlatform()): ComputerUseRuntime[] {
  if (platform === "linux-x64") return linuxX64()
  if (platform === "linux-arm64") return linuxArm64()
  if (platform === "win-x64") return winX64()
  if (platform === "darwin-arm64") return darwinArm64()
  if (platform === "darwin-x64") return darwinX64()
  return []
}

export function runtimeExecutable(dir: string): string {
  return join(dir, process.platform === "win32" ? "llama-server.exe" : "llama-server")
}

export function runtimeBytes(runtime: ComputerUseRuntime): number {
  return runtime.archives.reduce((total, entry) => total + (entry.bytes ?? 0), 0)
}

export function runtimeBytesOnDisk(dir: string): number | undefined {
  if (!existsSync(dir)) return undefined
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      total += runtimeBytesOnDisk(path) ?? 0
      continue
    }
    total += statSync(path).size
  }
  return total
}

export async function extractArchive(archivePath: string, destination: string): Promise<void> {
  mkdirSync(destination, { recursive: true })
  const escaped = (value: string) => value.replace(/'/g, "''")
  const attempts: Array<[string, string[]]> = archivePath.endsWith(".zip")
    ? [
        ["unzip", ["-o", archivePath, "-d", destination]],
        ["python3", ["-m", "zipfile", "-e", archivePath, destination]],
        [
          "powershell.exe",
          [
            "-NoProfile",
            "-Command",
            `Expand-Archive -LiteralPath '${escaped(archivePath)}' -DestinationPath '${escaped(destination)}' -Force`,
          ],
        ],
      ]
    : [
        ["tar", ["-xzf", archivePath, "-C", destination]],
        ["python3", ["-m", "tarfile", "-e", archivePath, destination]],
      ]
  let lastError: unknown
  for (const [file, args] of attempts) {
    try {
      await run(file, args, { timeout: 900000, maxBuffer: 8 * 1024 * 1024 })
      return
    } catch (error) {
      lastError = error
    }
  }
  throw new Error(
    `Could not extract ${basename(archivePath)}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  )
}

// llama.cpp tarballs unpack into a versioned folder; move that folder's
// contents up so the runtime directory always has llama-server at its root.
export function flattenRuntimeDirectory(directory: string): void {
  if (existsSync(runtimeExecutable(directory))) return
  const entries = readdirSync(directory, { withFileTypes: true })
  const nested = entries.filter((entry) => entry.isDirectory())
  if (nested.length !== 1) return
  const inner = join(directory, nested[0]!.name)
  if (!existsSync(runtimeExecutable(inner))) return
  for (const entry of readdirSync(inner)) {
    renameSync(join(inner, entry), join(directory, entry))
  }
  rmSync(inner, { recursive: true, force: true })
}
