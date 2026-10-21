// Building real client installers on the enterprise server.
//
// The control plane used to advertise an enrollment JSON file and call it a
// download. Operators still want that fallback — a small file a managed device
// can pick up — but a distribution should also produce the actual desktop
// package for every platform it lists. This module owns that build farm:
//
//   * it prepares the toolchain the desktop package needs (dependencies, the
//     compiled server bundle and the CLI binary) instead of assuming the host
//     was prepared by hand;
//   * it drives electron-builder once per platform/arch with the same entry
//     point the release workflow uses;
//   * it records every attempt, with a bounded log tail, so the console can
//     show what happened and the manifest can point at a real artifact.
//
// A target that cannot be produced on this host reports why rather than
// silently serving the enrollment fallback as if it were an installer.

import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { delimiter } from "node:path"
import { fileURLToPath } from "node:url"
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, extname, join, resolve, sep } from "node:path"

import type { EnterpriseStore } from "./store"
import type { ClientDistribution, ClientManifest, ClientRelease, Platform } from "./types"

/** Extra directory reserved for build scratch space under the release root. */
const WORK_DIR = ".work"

const TARGETS: Record<Platform, { electron: string; platform: string; arch: string; exts: string[] }> = {
  "macos-arm64": { electron: "darwin", platform: "mac", arch: "arm64", exts: [".dmg", ".zip"] },
  "macos-x64": { electron: "darwin", platform: "mac", arch: "x64", exts: [".dmg", ".zip"] },
  "windows-x64": { electron: "win32", platform: "win", arch: "x64", exts: [".exe"] },
  "linux-x64": { electron: "linux", platform: "linux", arch: "x64", exts: [".AppImage", ".deb", ".rpm"] },
  "linux-arm64": { electron: "linux", platform: "linux", arch: "arm64", exts: [".AppImage", ".deb", ".rpm"] },
}

export interface BuildHost {
  readonly platform: string
  readonly arch: string
  readonly root?: string
  readonly ready: boolean
  readonly reason?: string
}

export interface ReleaseTargetSupport {
  readonly platform: Platform
  readonly supported: boolean
  readonly reason?: string
  readonly artifact: string
}

export interface ReleaseHostStatus {
  readonly host: BuildHost
  readonly targets: ReleaseTargetSupport[]
}

export interface DesktopBuildPlan {
  readonly platform: Platform
  readonly root: string
  readonly slug: string
  readonly version: string
  readonly workDir: string
  /** Root the finished artifact is filed under. */
  readonly workRoot: string
  readonly env: Record<string, string>
  readonly steps: { command: string; args: string[]; label: string }[]
  /**
   * The tenant identity packaged into the client. An installer without this is
   * just the public Omnia app: it reads the public profile, signs into whatever
   * control plane it already knows, and ignores the distribution's policy.
   */
  readonly profile?: BuildProfile
  readonly profilePath?: string
}

/**
 * What a tenant installer carries so it is that organization's client. Every
 * policy field is the manifest the server publishes, field for field, so the
 * baked profile and a live `/manifest` read are the same schema. The build-only
 * fields (application identity and the URLs that produced this artifact) are
 * the only additions; `installers` is dropped because the server owns those
 * URLs and rewrites them as artifacts complete.
 */
export interface BuildProfile extends Omit<ClientManifest, "version" | "deployment"> {
  readonly kind: "omnia-enterprise-client"
  readonly version: string
  readonly appId: string
  readonly server: string
  readonly manifestUrl: string
  readonly loginUrl: string
  readonly deployment: Omit<ClientManifest["deployment"], "installers">
}

/**
 * Each tenant gets its own application identity. Sharing `io.omnia.desktop`
 * gave every build the same userData directory, so installing a tenant client
 * silently adopted the main app's sign-in and local state.
 */
export function tenantAppId(slug: string): string {
  const segment = slug
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return `io.omnia.enterprise.${segment.length === 0 ? "client" : segment}`
}

export function tenantProductName(distribution: ClientDistribution): string {
  const branded = distribution.branding.productName.trim()
  return branded.length > 0 ? branded : distribution.name
}

export interface BuiltArtifact {
  readonly file: string
  readonly bytes: number
  readonly sha256: string
}

export type BuildRunner = (input: {
  readonly plan: DesktopBuildPlan
  readonly onLine: (line: string) => void
}) => Promise<BuiltArtifact>

export interface ReleaseFarmOptions {
  readonly store: EnterpriseStore
  /** Root that holds `<slug>/<version>/<platform>/<artifact>`. */
  readonly outputDir: string
  /** An Omnia source checkout; discovered from this module when omitted. */
  readonly root?: string
  readonly runner?: BuildRunner
  /** Builds run two at a time: packaging is CPU and disk heavy. */
  readonly concurrency?: number
}

/**
 * Find the Omnia checkout that provides `packages/desktop`. A packaged server
 * has none, so the caller can point `OMNIA_BUILD_ROOT` at one.
 */
export function findBuildRoot(from = dirname(fileURLToPath(import.meta.url))): string | undefined {
  const configured = process.env.OMNIA_BUILD_ROOT?.trim()
  if (configured !== undefined && configured.length > 0) {
    const candidate = resolve(configured)
    return existsSync(join(candidate, "packages/desktop/package.json")) ? candidate : undefined
  }
  let current = resolve(from)
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(join(current, "packages/desktop/package.json"))) return current
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
  return undefined
}

export function buildHost(root = findBuildRoot()): BuildHost {
  if (root === undefined || !existsSync(join(root, "packages/desktop/package.json"))) {
    return {
      platform: process.platform,
      arch: process.arch,
      ready: false,
      reason: "No Omnia source checkout was found. Set OMNIA_BUILD_ROOT to the repository that contains packages/desktop.",
    }
  }
  if (findExecutable("bun") === undefined) {
    return { platform: process.platform, arch: process.arch, root, ready: false, reason: "bun is not on PATH." }
  }
  return { platform: process.platform, arch: process.arch, root, ready: true }
}

/**
 * Whether this host can produce each target. macOS packages need a macOS host
 * because signing, notarization and dmg creation call Apple tooling; Windows
 * cross-builds need wine to stamp the executable.
 */
export function targetSupport(host: BuildHost): ReleaseTargetSupport[] {
  return (Object.keys(TARGETS) as Platform[]).map((platform) => {
    const target = TARGETS[platform]
    const artifact = `${target.exts[0]} package`
    if (!host.ready) return { platform, supported: false, reason: host.reason, artifact }
    if (target.electron === "darwin" && process.platform !== "darwin") {
      return { platform, supported: false, reason: "macOS packages must be built on a macOS host.", artifact }
    }
    if (target.electron === "win32" && process.platform !== "win32" && findExecutable("wine") === undefined) {
      return {
        platform,
        supported: false,
        reason: "Windows packages need a Windows host or wine on this host.",
        artifact,
      }
    }
    if (target.electron === "linux" && process.platform !== "linux") {
      return { platform, supported: false, reason: "Linux packages must be built on a Linux host.", artifact }
    }
    return { platform, supported: true, artifact }
  })
}

export function hostStatus(root = findBuildRoot()): ReleaseHostStatus {
  const host = buildHost(root)
  return { host, targets: targetSupport(host) }
}

export function releaseDir(root: string, slug: string, version: string, platform: Platform): string {
  return join(root, safeSegment(slug), safeSegment(version), platform)
}

/** PATH lookup without Bun APIs, so the desktop bundle can typecheck the farm. */
function findExecutable(command: string): string | undefined {
  const suffixes = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""]
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory.length === 0) continue
    for (const suffix of suffixes) {
      const candidate = join(directory, `${command}${suffix}`)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "release"
}

function profilePath(root: string, slug: string, version: string): string {
  return join(root, WORK_DIR, safeSegment(slug), safeSegment(version), "enterprise.json")
}

/** Validate a stored release path. Records are data, so never trust them. */
export function artifactPath(root: string, release: ClientRelease): string | undefined {
  if (release.filename === undefined) return undefined
  const base = releaseDir(root, release.distributionSlug, release.version, release.platform)
  const file = resolve(base, release.filename)
  const prefix = `${resolve(base)}${sep}`
  return file.startsWith(prefix) ? file : undefined
}

export function planBuild(input: {
  readonly platform: Platform
  readonly root: string
  readonly slug: string
  readonly version: string
  readonly workRoot: string
  readonly profile?: BuildProfile
}): DesktopBuildPlan {
  const target = TARGETS[input.platform]
  // Packaging output is scratch space: the finished file is copied out so the
  // release directory only ever holds what the manifest advertises.
  const workDir = join(input.workRoot, WORK_DIR, safeSegment(input.slug), safeSegment(input.version), input.platform)
  const config = join(input.root, "packages/desktop/electron-builder.config.ts")
  // `--publish never` and OMNIA_NO_PUBLISH keep the artifact local; the server,
  // not GitHub, is the distribution point. Signing is disabled because a tenant
  // build cannot hold the publisher's credentials.
  const args = [
    "x",
    "electron-builder",
    `--${target.platform}`,
    `--${target.arch}`,
    "--config",
    config,
    "--publish",
    "never",
    `-c.directories.output=${workDir}`,
    ...(target.electron === "darwin" ? ["-c.mac.identity=null", "-c.mac.notarize=false", "-c.mac.hardenedRuntime=false"] : []),
  ]
  const env: Record<string, string> = {
    OPENCODE_CHANNEL: "prod",
    OMNIA_NO_PUBLISH: "1",
    OMNIA_SKIP_WINDOWS_SIGNING: "1",
    OMNIA_TARGET_PLATFORM: target.electron,
    OMNIA_TARGET_ARCH: target.arch,
    CSC_IDENTITY_AUTO_DISCOVERY: "false",
    ...(input.profile === undefined
      ? {}
      : {
          OMNIA_APP_ID: input.profile.appId,
          OMNIA_PRODUCT_NAME: input.profile.branding.productName.trim() || input.profile.name,
          OMNIA_PACKAGE_NAME: safeSegment(input.profile.distribution),
          OMNIA_ARTIFACT_PREFIX: `omnia-${safeSegment(input.profile.distribution)}`,
          OMNIA_ENTERPRISE_PROFILE: profilePath(input.workRoot, input.slug, input.version),
        }),
    // electron-builder downloads the Electron and app-builder binaries for the
    // target into its own cache. Keep that cache inside the deployment so a
    // LAN-only server works without reaching a shared home directory.
    ELECTRON_BUILDER_CACHE: join(input.workRoot, ".cache"),
  }
  return {
    platform: input.platform,
    root: input.root,
    slug: input.slug,
    version: input.version,
    workDir,
    workRoot: input.workRoot,
    env,
    ...(input.profile === undefined
      ? {}
      : {
          profile: input.profile,
          profilePath: profilePath(input.workRoot, input.slug, input.version),
        }),
    steps: [
      // `bun run build` runs the package's prebuild hook too, which compiles the
      // server bundle and stages the CLI binary the desktop app expects.
      { command: "bun", args: ["run", "build"], label: "Compiling the desktop app" },
      { command: "bun", args, label: `Packaging ${input.platform}` },
    ],
  }
}

/**
 * Install what the desktop build needs before packaging. The server carries the
 * build recipe rather than a copy of every platform toolchain: the only thing
 * it cannot download is the host's own compilers, which `targetSupport` reports.
 */
export function dependencyStatus(root: string): { ready: boolean; reason?: string } {
  if (!existsSync(join(root, "node_modules"))) {
    return { ready: false, reason: "The workspace dependencies are not installed yet." }
  }
  if (
    !existsSync(join(root, "packages/desktop/node_modules/electron-builder")) &&
    !existsSync(join(root, "node_modules/electron-builder"))
  ) {
    return { ready: false, reason: "electron-builder is missing from the workspace dependencies." }
  }
  if (
    !existsSync(join(root, "packages/desktop/node_modules")) &&
    !existsSync(join(root, "node_modules/electron-vite"))
  ) {
    return { ready: false, reason: "The desktop package dependencies are not installed yet." }
  }
  return { ready: true }
}

/** Run one child process, forwarding output lines as they arrive. */
async function stream(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  onLine: (line: string) => void,
): Promise<void> {
  await new Promise<void>((done, fail) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    })
    const forward = (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/)) onLine(line.trimEnd())
    }
    child.stdout.on("data", forward)
    child.stderr.on("data", forward)
    child.on("error", fail)
    child.on("close", (code) => {
      if (code === 0) done()
      else fail(new Error(`${command} ${args.join(" ")} exited with code ${code ?? "unknown"}`))
    })
  })
}

function hashFile(file: string): BuiltArtifact {
  const bytes = readFileSync(file)
  return {
    file,
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }
}

/** Default runner: provision dependencies, compile, package, pick the artifact. */
export const runDesktopBuild: BuildRunner = async ({ plan, onLine }) => {
  const dependencies = dependencyStatus(plan.root)
  if (!dependencies.ready) {
    onLine(`Preparing build dependencies: ${dependencies.reason}`)
    await stream("bun", ["install"], plan.root, plan.env, onLine)
  }
  rmSync(plan.workDir, { recursive: true, force: true })
  mkdirSync(plan.workDir, { recursive: true })
  if (plan.profile !== undefined && plan.profilePath !== undefined) {
    mkdirSync(dirname(plan.profilePath), { recursive: true })
    writeFileSync(plan.profilePath, JSON.stringify(plan.profile, null, 2))
  }
  for (const step of plan.steps) {
    onLine(`$ ${step.command} ${step.args.join(" ")}`)
    await stream(step.command, step.args, join(plan.root, "packages/desktop"), plan.env, (line) => {
      if (line.length > 0) onLine(line)
    })
  }
  const target = TARGETS[plan.platform]
  const produced = readdirSync(plan.workDir)
  const chosen = target.exts
    .map((ext) => produced.find((file) => extname(file).toLowerCase() === ext.toLowerCase()))
    .find((file) => file !== undefined)
  if (chosen === undefined) {
    throw new Error(
      `The build finished but produced no ${target.exts.join(" or ")} artifact. It left: ${produced.join(", ") || "nothing"}.`,
    )
  }
  const source = join(plan.workDir, chosen)
  const destination = join(releaseDir(plan.workRoot, plan.slug, plan.version, plan.platform), chosen)
  mkdirSync(dirname(destination), { recursive: true })
  copyFileSync(source, destination)
  // Keep the work directory out of the way; a failed build keeps its log tail
  // in the release record, not on disk forever.
  rmSync(join(plan.workRoot, WORK_DIR, safeSegment(plan.slug), safeSegment(plan.version)), {
    recursive: true,
    force: true,
  })
  const artifact = hashFile(destination)
  onLine(`Artifact ${chosen} (${artifact.bytes} bytes) sha256 ${artifact.sha256}`)
  return artifact
}

/**
 * The durable side of the build farm: creates release records, runs at most
 * `concurrency` builds at once, and writes every transition back to the store.
 */
function buildProfile(
  store: EnterpriseStore,
  distribution: ClientDistribution,
  version: string,
  serverUrl: string | undefined,
): BuildProfile {
  const server = (serverUrl ?? "").replace(/\/+$/, "")
  const manifest = store.manifest(distribution, server)
  const publicClient = `${server}/v1/enterprise/public/client/${encodeURIComponent(distribution.slug)}`
  return {
    kind: "omnia-enterprise-client",
    ...manifest,
    version,
    appId: tenantAppId(distribution.slug),
    server,
    manifestUrl: server.length === 0 ? "" : `${publicClient}/manifest`,
    loginUrl: server.length === 0 ? "" : `${publicClient}/login`,
    deployment: {
      mode: manifest.deployment.mode,
      platforms: manifest.deployment.platforms,
      offlineBundle: manifest.deployment.offlineBundle,
      ...(manifest.deployment.installerBaseUrl === undefined
        ? {}
        : { installerBaseUrl: manifest.deployment.installerBaseUrl }),
      ...(manifest.deployment.proxyUrl === undefined ? {} : { proxyUrl: manifest.deployment.proxyUrl }),
    },
  }
}

export class ClientReleaseFarm {
  private readonly store: EnterpriseStore
  private readonly outputDir: string
  private readonly root: string | undefined
  private readonly runner: BuildRunner
  private readonly concurrency: number
  private active = 0
  private readonly queue: (() => void)[] = []
  private readonly jobs = new Map<string, Promise<void>>()

  constructor(options: ReleaseFarmOptions) {
    this.store = options.store
    this.outputDir = options.outputDir
    this.root = options.root ?? findBuildRoot()
    this.runner = options.runner ?? runDesktopBuild
    this.concurrency = Math.max(1, options.concurrency ?? 2)
  }

  status(): ReleaseHostStatus {
    return hostStatus(this.root)
  }

  /** Queue one build per platform and return the records immediately. */
  start(
    distribution: ClientDistribution,
    platforms: readonly Platform[],
    actorId?: string,
    serverUrl?: string,
  ): { release: ClientRelease; error?: string }[] {
    const host = this.status()
    const enabled = new Set(distribution.deployment.platforms)
    return platforms.map((platform) => {
      const target = host.targets.find((entry) => entry.platform === platform)
      const release = this.store.startRelease({
        distributionId: distribution.id,
        platform,
        version: distribution.version,
        ...(actorId === undefined ? {} : { actorId }),
      })
      const blocker = !enabled.has(platform)
        ? "This platform is not selected for the distribution."
        : host.host.ready !== true
          ? host.host.reason ?? "This host cannot build clients."
          : target === undefined || !target.supported
            ? target?.reason ?? "This host cannot build that platform."
            : undefined
      if (blocker !== undefined) {
        this.store.failRelease(release.id, blocker)
        return { release: this.store.release(release.id) ?? release, error: blocker }
      }
      this.schedule(release, distribution, serverUrl)
      return { release }
    })
  }

  /** Wait for queued and running builds; used by tests and shutdown. */
  async settled(): Promise<void> {
    await Promise.all([...this.jobs.values()])
  }

  private schedule(release: ClientRelease, distribution: ClientDistribution, serverUrl: string | undefined): void {
    const job = this.enter(async () => {
      this.store.setReleaseStatus(release.id, "building")
      try {
        const plan = planBuild({
          platform: release.platform,
          root: this.root!,
          slug: release.distributionSlug,
          version: release.version,
          workRoot: this.outputDir,
          profile: buildProfile(this.store, distribution, release.version, serverUrl),
        })
        const artifact = await this.runner({
          plan,
          onLine: (line) => this.store.appendReleaseLog(release.id, line),
        })
        this.store.completeRelease(release.id, {
          filename: artifact.file.replace(/^.*[\\/]/, ""),
          bytes: artifact.bytes,
          sha256: artifact.sha256,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.store.appendReleaseLog(release.id, message)
        this.store.failRelease(release.id, message)
      }
    })
    this.jobs.set(release.id, job)
    void job.finally(() => this.jobs.delete(release.id))
  }

  private async enter(task: () => Promise<void>): Promise<void> {
    if (this.active >= this.concurrency) await new Promise<void>((resume) => this.queue.push(resume))
    this.active += 1
    try {
      await task()
    } finally {
      this.active -= 1
      this.queue.shift()?.()
    }
  }
}

/**
 * The small enrollment file a managed device can pick up before the installer.
 * It pins the client to this tenant; it is not an installer, and the manifest
 * now says so explicitly.
 */
export function enrollmentBundle(
  distribution: ClientDistribution,
  platform: Platform,
  baseUrl: string,
  now: number,
): Record<string, unknown> {
  return {
    schema: 1,
    kind: "omnia-enterprise-enrollment",
    platform,
    server: baseUrl,
    mode: distribution.deployment.mode,
    distribution: distribution.slug,
    version: distribution.version,
    manifestUrl: `${baseUrl}/v1/enterprise/public/client/${distribution.slug}/manifest`,
    loginUrl: `${baseUrl}/v1/enterprise/public/client/${distribution.slug}/login`,
    generatedAt: new Date(now).toISOString(),
    notes:
      distribution.deployment.mode === "lan"
        ? "This client reaches the server only on the local network. Pair it on the same network before first use."
        : "This client is pinned to the deployment above and reports usage back to it.",
  }
}

export { TARGETS }
