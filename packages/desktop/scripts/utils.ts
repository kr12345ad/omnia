import { $ } from "bun"
import { existsSync } from "node:fs"
import { chmod, copyFile, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const CLI_VERSION = "0.0.0-next-16350"

export type Channel = "dev" | "beta" | "prod"

export function resolveChannel(): Channel {
  const raw = Bun.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
}

export const CLI_BINARIES: Array<{ rustTarget: string; package: string; os: string; cpu: string }> = [
  {
    rustTarget: "aarch64-apple-darwin",
    package: "@opencode-ai/cli-darwin-arm64",
    os: "darwin",
    cpu: "arm64",
  },
  {
    rustTarget: "x86_64-apple-darwin",
    package: "@opencode-ai/cli-darwin-x64-baseline",
    os: "darwin",
    cpu: "x64",
  },
  {
    rustTarget: "aarch64-pc-windows-msvc",
    package: "@opencode-ai/cli-windows-arm64",
    os: "win32",
    cpu: "arm64",
  },
  {
    rustTarget: "x86_64-pc-windows-msvc",
    package: "@opencode-ai/cli-windows-x64-baseline",
    os: "win32",
    cpu: "x64",
  },
  {
    rustTarget: "x86_64-unknown-linux-gnu",
    package: "@opencode-ai/cli-linux-x64-baseline",
    os: "linux",
    cpu: "x64",
  },
  {
    rustTarget: "aarch64-unknown-linux-gnu",
    package: "@opencode-ai/cli-linux-arm64",
    os: "linux",
    cpu: "arm64",
  },
]

export const RUST_TARGET = Bun.env.RUST_TARGET

function nativeTarget() {
  const { platform, arch } = process
  if (platform === "darwin") return arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin"
  if (platform === "win32") return arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc"
  if (platform === "linux") return arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu"
  throw new Error(`Unsupported platform: ${platform}/${arch}`)
}

export function getCurrentCli(target = RUST_TARGET ?? nativeTarget()) {
  const binaryConfig = CLI_BINARIES.find((item) => item.rustTarget === target)
  if (!binaryConfig) throw new Error(`CLI configuration not available for target '${target}'`)

  return binaryConfig
}

export async function downloadCliToResources() {
  const cli = getCurrentCli()
  const directory = await mkdtemp(join(tmpdir(), "opencode-cli-"))
  const dest = windowsify("resources/opencode-cli")
  try {
    await $`bun install --no-save --cwd ${directory} ${`${cli.package}@${CLI_VERSION}`} ${`--os=${cli.os}`} ${`--cpu=${cli.cpu}`}`
    await copyFile(
      join(directory, "node_modules", cli.package, "bin", cli.os === "win32" ? "opencode2.exe" : "opencode2"),
      dest,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
  const staged = stagedCliVersion(await clientVersion())
  if ((await rewriteCliVersion(dest, CLI_VERSION, staged)) === 0) {
    throw new Error(`The staged v2 CLI does not carry its ${CLI_VERSION} version string`)
  }
  console.log(`Staged v2 CLI reports ${staged}`)
  if (process.platform !== "win32") await chmod(dest, 0o755)
  if (process.platform === "win32" && process.env.GITHUB_ACTIONS === "true") {
    await $`pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File ../../script/sign-windows.ps1 ${dest}`
  }
  if (process.platform === "darwin") await $`codesign --force --sign - ${dest}`

  console.log(`Copied ${cli.package} to ${dest}`)
}

// The published CLI tracks its own release train, so a dev build that downloads
// it can disagree with the database schema this checkout migrates to. Build the
// server from the same source instead and fall back to the published binary only
// when the local build is unavailable.
export async function stageLocalCli() {
  const dest = windowsify("resources/opencode-cli")
  const dir = join(import.meta.dirname, "..", "..", "opencode")
  const targetPlatform = process.env.OMNIA_TARGET_PLATFORM ?? process.platform
  const targetArch = process.env.OMNIA_TARGET_ARCH ?? process.arch
  // A cross build must not leave the other platform's binary behind: the
  // package filter copies opencode-cli*, so a stale Linux ELF would ship
  // inside the Windows installer and add hundreds of megabytes.
  await $`rm -f resources/opencode-cli resources/opencode-cli.exe`
  const build = await $`bun script/build.ts --single`
    .cwd(dir)
    .env({ OMNIA_TARGET_PLATFORM: targetPlatform, OMNIA_TARGET_ARCH: targetArch })
    .nothrow()
    .quiet()
  if (build.exitCode !== 0) {
    console.warn("local CLI build failed; staging the published CLI instead")
    await downloadCliToResources()
    return
  }
  const arch = targetArch === "arm64" ? "arm64" : "x64"
  const platform = targetPlatform === "win32" ? "windows" : targetPlatform
  const output = join(dir, "dist", `opencode-${platform}-${arch}`, "bin")
  // Bun appends .exe on Windows; older builds wrote the bare name.
  const binary = [join(output, "opencode.exe"), join(output, "opencode")].find((candidate) => existsSync(candidate))
  if (binary === undefined) throw new Error(`local CLI build did not produce a binary in ${output}`)
  await copyFile(binary, dest)
  if (process.platform !== "win32") await chmod(dest, 0o755)
  if (process.platform === "darwin") await $`codesign --force --sign - ${dest}`
  console.log(`Staged local CLI from ${binary}`)
}

/**
 * Zen's free tier answers HTTP 426 for any client older than 1.18.0, and every
 * published v2 CLI is versioned 0.0.0-<channel>-<build>, which semver sorts
 * below 1.18.0 however new the build is. The stage therefore reports the
 * workspace client version instead. That string is compiled into the binary's
 * fixed-layout bundle, so the replacement carries the build ident trimmed to
 * the original byte length and can be patched in place.
 */
export function stagedCliVersion(version: string, preview = CLI_VERSION) {
  const staged = `${version}-${preview.split("-").slice(1).join("-")}`.slice(0, preview.length)
  if (staged.length !== preview.length || staged.endsWith("-") || staged.endsWith(".")) {
    throw new Error(`Cannot fit client version ${version} into the ${preview.length}-byte v2 CLI version`)
  }
  return staged
}

/**
 * Rewrites every copy of the version in place. Equal byte length keeps the
 * bundle's string offsets intact, which is why the caller must not resize it.
 */
async function rewriteCliVersion(binary: string, from: string, to: string) {
  if (from.length !== to.length) throw new Error(`Rewriting ${from} to ${to} would resize the v2 CLI version`)
  const bytes = Buffer.from(await Bun.file(binary).arrayBuffer())
  const replacement = Buffer.from(to)
  const hits = (() => {
    let found = 0
    for (let at = bytes.indexOf(from); at !== -1; at = bytes.indexOf(from, at + replacement.length)) {
      replacement.copy(bytes, at)
      found++
    }
    return found
  })()
  if (hits > 0) await Bun.write(binary, bytes)
  return hits
}

// The product version the rest of the build reports to providers lives in the
// server package, so the v2 CLI and the sidecar cannot drift apart.
async function clientVersion() {
  const path = join(import.meta.dir, "../../opencode/package.json")
  const pkg = (await Bun.file(path).json()) as { version?: string }
  if (typeof pkg.version !== "string" || pkg.version.length === 0) throw new Error(`${path} has no version`)
  return pkg.version
}

export function windowsify(path: string) {
  if (path.endsWith(".exe")) return path
  const platform = process.env.OMNIA_TARGET_PLATFORM ?? process.platform
  return `${path}${platform === "win32" ? ".exe" : ""}`
}
