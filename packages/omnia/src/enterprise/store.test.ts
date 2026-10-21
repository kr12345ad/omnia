import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openEnterpriseStore } from "./store"
import { defaultExperience, defaultPermissions } from "./types"

const directories: string[] = []

function store(now = Date.UTC(2026, 9, 18, 12)) {
  const directory = mkdtempSync(join(tmpdir(), "omnia-enterprise-store-"))
  directories.push(directory)
  return openEnterpriseStore({
    file: join(directory, "enterprise.json"),
    orgName: "Acme Robotics",
    adminEmail: "owner@acme.test",
    now: () => now,
  })
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe("policy enforcement", () => {
  test("ages out usage and audit records at the windows the policy publishes", () => {
    const directory = mkdtempSync(join(tmpdir(), "omnia-enterprise-retention-"))
    directories.push(directory)
    let clock = Date.UTC(2026, 0, 1)
    const instance = openEnterpriseStore({
      file: join(directory, "enterprise.json"),
      orgName: "Acme Robotics",
      adminEmail: "owner@acme.test",
      now: () => clock,
    })
    instance.updatePolicies({
      data: { ...instance.policies().data, retentionDays: 30 },
      audit: { ...instance.policies().audit, retentionDays: 90 },
    })
    instance.appendUsage({ userId: "usr_owner", model: "anthropic/claude", inputTokens: 10, outputTokens: 5, costUsd: 0.01 })
    instance.appendAudit({ action: "org.updated" })

    // Nothing is old enough yet.
    expect(instance.prune()).toEqual({ usage: 0, audit: 0 })
    expect(instance.usage()).toHaveLength(1)

    clock += 45 * 24 * 60 * 60 * 1000
    expect(instance.prune()).toEqual({ usage: 1, audit: 0 })
    expect(instance.usage()).toHaveLength(0)
    // The audit trail keeps its own, longer, window.
    expect(instance.auditAll().some((event) => event.action === "org.updated")).toBe(true)

    clock += 60 * 24 * 60 * 60 * 1000
    const auditBefore = instance.auditAll().length
    expect(auditBefore).toBeGreaterThan(0)
    expect(instance.prune()).toEqual({ usage: 0, audit: auditBefore })
    expect(instance.auditAll()).toHaveLength(0)
  })
})

describe("distribution manifest", () => {
  test("normalizes unsupported identity methods to local work accounts", () => {
    const instance = store()
    const created = instance.createDistribution({ name: "Acme Field" })
    const updated = instance.updateDistribution(created.id, {
      auth: {
        mode: "sso",
        methods: ["password", "oidc", "saml"],
        sessionHours: 12,
        requireMfa: false,
        allowedEmailDomains: ["  ACME.test ", ""],
        oidc: { issuer: "https://idp.example", clientId: "x", scopes: "openid", emailClaim: "email", nameClaim: "name", autoCreate: true },
      },
    })
    expect(updated.auth.methods).toEqual(["password"])
    expect(updated.auth.allowedEmailDomains).toEqual(["acme.test"])
    expect(updated.auth.oidc).toBeUndefined()
    const manifest = instance.manifest(updated, "https://console.acme.test")
    expect(manifest.auth.methods).toEqual(["password"])
    expect(manifest.auth.allowSocialLogin).toBe(false)
  })

  test("ships client experience defaults and sanitizes instructions", () => {
    const instance = store()
    const created = instance.createDistribution({ name: "Acme Field" })
    expect(created.experience).toEqual(defaultExperience())
    const updated = instance.updateDistribution(created.id, {
      experience: { ...defaultExperience(), theme: "dark", instructions: "  Use TypeScript.\nPrefer pnpm.  " },
    })
    expect(updated.experience.theme).toBe("dark")
    expect(updated.experience.instructions).toBe("Use TypeScript. Prefer pnpm.")
    const manifest = instance.manifest(updated, "https://console.acme.test")
    expect(manifest.experience).toEqual(updated.experience)
  })

  test("ships tool permissions and lets a disabled capability win", () => {
    const instance = store()
    const created = instance.createDistribution({ name: "Acme Field" })
    expect(created.permissions).toEqual(defaultPermissions())
    const updated = instance.updateDistribution(created.id, {
      features: { ...created.features, shellTool: false },
      permissions: { ...created.permissions, bash: "allow", edit: "ask" },
    })
    // The explicit rule is kept, but the switched-off feature still denies.
    expect(updated.permissions).toMatchObject({ bash: "deny", edit: "ask" })
    const manifest = instance.manifest(updated, "https://console.acme.test")
    expect(manifest.permissions).toEqual(updated.permissions)
    expect(manifest.permissions.read).toBe("allow")
    expect(manifest.permissions.externalDirectory).toBe("allow")
  })

  test("drops unknown permission modes instead of shipping them", () => {
    const instance = store()
    const created = instance.createDistribution({ name: "Acme Field" })
    const updated = instance.updateDistribution(created.id, {
      permissions: { ...created.permissions, edit: "sometimes" as never },
    })
    expect(updated.permissions.edit).toBe("allow")
  })

  test("rebases branding assets onto the address the client reached", () => {
    const instance = store()
    const created = instance.createDistribution({ name: "Acme Field" })
    // An upload is stored under the console's configured address, which may be
    // loopback even when a client reaches the server over the LAN.
    const uploaded = instance.updateDistribution(created.id, {
      branding: {
        ...created.branding,
        logoUrl: "http://127.0.0.1:8787/v1/enterprise/public/assets/logo.png",
      },
    })
    expect(instance.manifest(uploaded, "http://10.0.0.4:8787").branding.logoUrl).toBe(
      "http://10.0.0.4:8787/v1/enterprise/public/assets/logo.png",
    )
    const external = instance.updateDistribution(created.id, {
      branding: { ...uploaded.branding, iconUrl: "https://cdn.example/icon.png" },
    })
    expect(instance.manifest(external, "http://10.0.0.4:8787").branding.iconUrl).toBe(
      "https://cdn.example/icon.png",
    )
  })

  test("keeps session duration within a sane range", () => {
    const instance = store()
    const created = instance.createDistribution({ name: "Acme Field" })
    const updated = instance.updateDistribution(created.id, {
      auth: { ...created.auth, sessionHours: 100_000 },
    })
    expect(updated.auth.sessionHours).toBe(720)
  })

  test("defaults to a LAN deployment that offers enrollment bundles, not installers", () => {
    const instance = store()
    const created = instance.createDistribution({ name: "Acme Field" })
    expect(created.deployment.mode).toBe("lan")
    const manifest = instance.manifest(created, "http://10.0.0.4:8787")
    expect(manifest.deployment.installers).toHaveLength(5)
    expect(manifest.deployment.installers[0]).toMatchObject({
      platform: "macos-arm64",
      kind: "enrollment",
      url: "http://10.0.0.4:8787/v1/enterprise/public/client/acme-field/download/macos-arm64",
    })
  })

  test("drops unknown platforms and network modes instead of shipping them", () => {
    const instance = store()
    const created = instance.createDistribution({ name: "Acme Field" })
    const updated = instance.updateDistribution(created.id, {
      deployment: {
        ...created.deployment,
        platforms: ["linux-x64", "linux-x64", "beos-x86" as never],
        mode: "sneakernet" as never,
      },
    })
    expect(updated.deployment.platforms).toEqual(["linux-x64"])
    expect(updated.deployment.mode).toBe("lan")
  })

  test("will not publish an anywhere build while telemetry is off", () => {
    const instance = store()
    const created = instance.createDistribution({ name: "Acme Field" })
    const everywhere = instance.updateDistribution(created.id, {
      deployment: { ...created.deployment, mode: "public" },
    })
    expect(() => instance.publishDistribution(everywhere.id, "1.0.0", "")).toThrow(/telemetry/i)
    const traced = instance.updateDistribution(everywhere.id, {
      telemetry: { ...everywhere.telemetry, enabled: true },
    })
    expect(instance.publishDistribution(traced.id, "1.0.0", "").status).toBe("published")
  })
})
