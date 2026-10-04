import { execFile } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs"
import { basename, join } from "node:path"
import { promisify } from "node:util"
import type { ComputerUseRuntime, ComputerUseRuntimeArchive } from "./types"

const run = promisify(execFile)

// llama.cpp nightly the runtime downloads are pinned to. Bump together with
// the bundled runtimes under packages/desktop/resources/llama when upgrading.
// Archive bytes and sha256 pins are the authoritative values from the GitHub
// release API (`assets[].digest`) for that tag.
export const LLAMA_RELEASE_TAG = "b11205"

const releaseUrl = (asset: string) =>
  `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_RELEASE_TAG}/${asset}`

const archive = (asset: string, bytes: number, sha256: string): ComputerUseRuntimeArchive => ({
  url: releaseUrl(asset),
  bytes,
  sha256,
})

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
      archives: [
        archive(
          "llama-b11205-bin-ubuntu-x64.tar.gz",
          17403637,
          "730ea8e54b97735abb46e46747999249719251f29753fcda97b5e2f2f3ea6912",
        ),
      ],
    },
    {
      id: "linux-x64-cuda",
      variant: "cuda",
      displayName: "CUDA 12.8",
      description: "NVIDIA GPU acceleration. Requires a CUDA 12-capable driver.",
      backend: "cuda",
      platforms: ["linux-x64"],
      archives: [
        archive(
          "llama-b11205-bin-ubuntu-cuda-12.8-x64.tar.gz",
          170927888,
          "2922888a8c1c946d829bd6d283ac9cc1b154fff951046a3e5cd74e8582427b56",
        ),
        archive(
          "cudart-llama-b11205-bin-ubuntu-cuda-12.8-x64.tar.gz",
          594377688,
          "d55fd64fd568e91bba77613317f40bba7a6c65d123c7e7f7598364314275a00b",
        ),
      ],
    },
    {
      id: "linux-x64-rocm",
      variant: "rocm",
      displayName: "ROCm 10.0",
      description: "AMD GPU acceleration on supported Radeon hardware.",
      backend: "rocm",
      platforms: ["linux-x64"],
      archives: [
        archive(
          "llama-b11205-bin-ubuntu-rocm-10.0-x64.tar.gz",
          240734213,
          "a276171bf47558b6fe6d3efd79d7af117d65828e171bf4cd27f5b6376b1f428a",
        ),
      ],
    },
    {
      id: "linux-x64-vulkan",
      variant: "vulkan",
      displayName: "Vulkan",
      description: "GPU acceleration through Vulkan for NVIDIA, AMD, and Intel GPUs.",
      backend: "vulkan",
      platforms: ["linux-x64"],
      archives: [
        archive(
          "llama-b11205-bin-ubuntu-vulkan-x64.tar.gz",
          31346600,
          "14bb34d7058693f7679117ec3544a732e0a72405c6a08d60c8961b79393dd309",
        ),
      ],
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
      archives: [
        archive(
          "llama-b11205-bin-ubuntu-arm64.tar.gz",
          13500061,
          "9106753bff55e43c78ff595bf169a6bf01175f3d38f707866a1142553d4c437a",
        ),
      ],
    },
    {
      id: "linux-arm64-vulkan",
      variant: "vulkan",
      displayName: "Vulkan",
      description: "GPU acceleration through Vulkan on arm64 Linux.",
      backend: "vulkan",
      platforms: ["linux-arm64"],
      archives: [
        archive(
          "llama-b11205-bin-ubuntu-vulkan-arm64.tar.gz",
          24668769,
          "7e3b0ac3fd0822e45d865939698b1fa99e3f81cd38ffc3ee85a2bd56f8026ffe",
        ),
      ],
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
      archives: [
        archive(
          "llama-b11205-bin-win-cpu-x64.zip",
          19155045,
          "2a8bf1ff808e8f6d2329f50f7005419a9930d9ecfbeae5047cfff475e87c2db0",
        ),
      ],
    },
    {
      id: "win-x64-cuda",
      variant: "cuda",
      displayName: "CUDA 12.4",
      description: "NVIDIA GPU acceleration. Requires a CUDA 12-capable driver.",
      backend: "cuda",
      platforms: ["win-x64"],
      archives: [
        archive(
          "llama-b11205-bin-win-cuda-12.4-x64.zip",
          263077910,
          "3892b3ba287f570865c880f97de9e2e86d853cbebffab40a19f4ebca1ca3a557",
        ),
        archive(
          "cudart-llama-bin-win-cuda-12.4-x64.zip",
          391443627,
          "8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6",
        ),
      ],
    },
    {
      id: "win-x64-vulkan",
      variant: "vulkan",
      displayName: "Vulkan",
      description: "GPU acceleration through Vulkan for NVIDIA, AMD, and Intel GPUs.",
      backend: "vulkan",
      platforms: ["win-x64"],
      archives: [
        archive(
          "llama-b11205-bin-win-vulkan-x64.zip",
          33061695,
          "f3d08e7e342e2cb96ccddd1a208320c188d0a394844553a40a32c5e9903af563",
        ),
      ],
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
      archives: [
        archive(
          "llama-b11205-bin-macos-arm64.tar.gz",
          11755672,
          "97b06f59ad15e2b4b6044ba7338c4e3f40354c6dc2b9c5cda234e2bd6b9fd65e",
        ),
      ],
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
      archives: [
        archive(
          "llama-b11205-bin-macos-x64.tar.gz",
          11309116,
          "1122a00cf6ce9e9ae687c1b71fef82e2f59bec2bea443f4746d94212b3124db1",
        ),
      ],
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
