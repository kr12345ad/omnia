import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  ClientReleaseFarm,
  artifactPath,
  hostStatus,
  planBuild,
  releaseDir,
  targetSupport,
} from "./releases"
import type { BuildProfile } from "./releases"
import { openEnterpriseStore } from "./store"

const directories: string[] = []

function workspace() {
  const directory = mkdtempSync(join(tmpdir(), "omnia-releases-"))
  directories.push(directory)
  mkdirSync(join(directory, "packages/desktop"), { recursive: true })
  writeFileSync(join(directory, "packages/desktop/package.json"), "{}")
  return directory
}

function fixture() {
  const root = workspace()
  const store = openEnterpriseStore({
    file: join(root, "enterprise.json"),
    orgName: "Acme Robotics",
    adminEmail: "owner@acme.test",
    now: () => Date.UTC(2026, 9, 18, 12),
  })
  const distribution = store.createDistribution({ name: "Acme Field" })
  return { root, store, distribution, outputDir: join(root, "releases") }
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe("build host", () => {
  test("reports a missing checkout instead of pretending a build can start", () => {
    const host = hostStatus("/nonexistent/omnia-checkout")
    expect(host.host.ready).toBe(false)
    expect(host.host.reason).toContain("OMNIA_BUILD_ROOT")
    expect(host.targets.every((target) => !target.supported)).toBe(true)
  })

  test("marks macOS as unbuildable off a macOS host", () => {
    const host = hostStatus(workspace())
    const mac = host.targets.find((target) => target.platform === "macos-arm64")!
    if (process.platform === "darwin") expect(mac.supported).toBe(true)
    else expect(mac.reason).toContain("macOS host")
  })

  test("describes each platform with the artifact it produces", () => {
    const targets = targetSupport(hostStatus(workspace()).host)
    expect(targets.find((target) => target.platform === "windows-x64")?.artifact).toBe(".exe package")
    expect(targets.find((target) => target.platform === "linux-arm64")?.artifact).toBe(".AppImage package")
  })
})

describe("build plan", () => {
  test("packages for the target platform and keeps the artifact local", () => {
    const plan = planBuild({
      platform: "windows-x64",
      root: "/srv/omnia",
      slug: "acme-field",
      version: "1.4.0",
      workRoot: "/var/lib/omnia/releases",
    })
    const packaging = plan.steps[1]!
    expect(packaging.args).toContain("--win")
    expect(packaging.args).toContain("--x64")
    expect(packaging.args).toContain("--publish")
    expect(packaging.args).toContain("never")
    expect(plan.env.OMNIA_TARGET_PLATFORM).toBe("win32")
    expect(plan.env.OMNIA_NO_PUBLISH).toBe("1")
    expect(plan.env.OMNIA_SKIP_WINDOWS_SIGNING).toBe("1")
    expect(plan.workDir).toBe("/var/lib/omnia/releases/.work/acme-field/1.4.0/windows-x64")
  })

  test("keeps a path traversal in a stored filename from escaping the release directory", () => {
    const base = releaseDir("/var/lib/omnia/releases", "acme-field", "1.4.0", "linux-x64")
    expect(
      artifactPath("/var/lib/omnia/releases", {
        id: "rel_1",
        distributionId: "dist_1",
        distributionSlug: "acme-field",
        version: "1.4.0",
        platform: "linux-x64",
        status: "ready",
        startedAt: 0,
        filename: "../../secret.txt",
        log: [],
      }),
    ).toBeUndefined()
    expect(base.endsWith("acme-field/1.4.0/linux-x64")).toBe(true)
  })
})

describe("release farm", () => {
  test("refuses a platform that is not part of the distribution", () => {
    const { root, store, distribution, outputDir } = fixture()
    const narrowed = store.updateDistribution(distribution.id, {
      deployment: { ...distribution.deployment, platforms: ["linux-x64"] },
    })
    const farm = new ClientReleaseFarm({ store, outputDir, root })
    const [result] = farm.start(narrowed, ["windows-x64"])
    expect(result?.release.status).toBe("failed")
    expect(result?.error).toContain("not selected")
  })

  test("records a ready artifact and hands it to the manifest", async () => {
    const { root, store, distribution, outputDir } = fixture()
    const platform = hostStatus(root).targets.find((target) => target.supported)?.platform
    if (platform === undefined) return
    const updated = store.updateDistribution(distribution.id, {
      deployment: { ...distribution.deployment, platforms: [platform] },
      telemetry: { ...distribution.telemetry, enabled: true },
    })
    const published = store.publishDistribution(updated.id, "1.0.0", "First build")
    const farm = new ClientReleaseFarm({
      store,
      outputDir,
      root,
      runner: async ({ plan }) => {
        const file = join(plan.workRoot, plan.slug, plan.version, plan.platform, "installer.bin")
        mkdirSync(join(plan.workRoot, plan.slug, plan.version, plan.platform), { recursive: true })
        writeFileSync(file, "installer")
        return { file, bytes: 9, sha256: "a".repeat(64) }
      },
    })
    const [started] = farm.start(published, [platform])
    expect(started?.release.status).toBe("queued")
    await farm.settled()
    const release = store.release(started!.release.id)!
    expect(release.status).toBe("ready")
    expect(release.filename).toBe("installer.bin")
    expect(release.bytes).toBe(9)
    const manifest = store.manifest(store.distribution(published.id)!, "http://10.0.0.4:8787")
    expect(manifest.deployment.installers[0]).toMatchObject({
      platform,
      kind: "installer",
      available: true,
      bytes: 9,
      sha256: "a".repeat(64),
    })
  })

  test("bakes a profile that follows the served manifest schema exactly", async () => {
    const { root, store, distribution, outputDir } = fixture()
    const platform = hostStatus(root).targets.find((target) => target.supported)?.platform
    if (platform === undefined) return
    const server = "http://10.0.0.4:8787"
    const updated = store.updateDistribution(distribution.id, {
      deployment: { ...distribution.deployment, platforms: [platform] },
      branding: {
        ...distribution.branding,
        productName: "Acme Field",
        logoUrl: "http://127.0.0.1:8787/v1/enterprise/public/assets/logo.png",
      },
      experience: { ...distribution.experience, theme: "dark" },
    })
    const published = store.publishDistribution(updated.id, "2.1.0", "Schema build")
    let captured: BuildProfile | undefined
    const farm = new ClientReleaseFarm({
      store,
      outputDir,
      root,
      runner: async ({ plan }) => {
        captured = plan.profile
        const file = join(plan.workRoot, plan.slug, plan.version, plan.platform, "installer.bin")
        mkdirSync(join(plan.workRoot, plan.slug, plan.version, plan.platform), { recursive: true })
        writeFileSync(file, "installer")
        return { file, bytes: 9, sha256: "a".repeat(64) }
      },
    })
    const [started] = farm.start(published, [platform], undefined, server)
    await farm.settled()
    expect(store.release(started!.release.id)?.status).toBe("ready")

    const profile = captured!
    const manifest = store.manifest(store.distribution(published.id)!, server)
    const shared = [
      "schema",
      "distribution",
      "name",
      "publishedAt",
      "org",
      "branding",
      "auth",
      "features",
      "permissions",
      "experience",
      "limits",
      "models",
      "telemetry",
      "update",
    ] as const
    for (const key of shared) expect(profile[key]).toEqual(manifest[key])
    expect(profile.kind).toBe("omnia-enterprise-client")
    expect(profile.version).toBe("2.1.0")
    expect(profile.appId).toBe("io.omnia.enterprise.acme-field")
    expect(profile.server).toBe(server)
    expect(profile.manifestUrl).toBe(`${server}/v1/enterprise/public/client/acme-field/manifest`)
    expect(profile.loginUrl).toBe(`${server}/v1/enterprise/public/client/acme-field/login`)
    expect(profile.org).toEqual({ name: "Acme Robotics", slug: store.organization().slug })
    expect(profile.experience.theme).toBe("dark")
    expect(profile.branding.logoUrl).toBe(`${server}/v1/enterprise/public/assets/logo.png`)
    expect(profile.deployment).not.toHaveProperty("installers")
    expect(profile.auth).not.toHaveProperty("oidc")
    expect(profile.auth).not.toHaveProperty("saml")
  })

  test("marks a failed runner as failed and keeps the log tail", async () => {
    const { root, store, distribution, outputDir } = fixture()
    const platform = hostStatus(root).targets.find((target) => target.supported)?.platform
    if (platform === undefined) return
    const updated = store.updateDistribution(distribution.id, {
      deployment: { ...distribution.deployment, platforms: [platform] },
    })
    const farm = new ClientReleaseFarm({
      store,
      outputDir,
      root,
      runner: async ({ onLine }) => {
        onLine("npm ERR! missing toolchain")
        throw new Error("packaging failed")
      },
    })
    const [started] = farm.start(updated, [platform])
    await farm.settled()
    const release = store.release(started!.release.id)!
    expect(release.status).toBe("failed")
    expect(release.error).toContain("packaging failed")
    expect(release.log.join("\n")).toContain("missing toolchain")
  })
})

test("build steps have a bounded wait even with inherited output pipes", async () => {
  const { stream } = await import("./releases")
  const started = Date.now()
  await expect(stream("/bin/sh", ["-c", "sleep 20 & wait"], tmpdir(), {}, () => {}, 100)).rejects.toThrow("timed out")
  expect(Date.now() - started).toBeLessThan(3000)
})

test("streamed artifact hash preserves bytes and digest", async () => {
  const { hashFile } = await import("./releases")
  const directory = workspace()
  const file = join(directory, "artifact.bin")
  writeFileSync(file, "abc")
  expect(await hashFile(file)).toEqual({ file, bytes: 3, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" })
})
