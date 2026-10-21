import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  enterprisePermissionEnv,
  enterprisePermissions,
  forgetEnterpriseProfile,
  readEnterpriseProfile,
  readEnterpriseProfileFile,
} from "./enterprise"

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function directory(): string {
  const created = mkdtempSync(join(tmpdir(), "omnia-enterprise-profile-"))
  directories.push(created)
  return created
}

// The same shape the build farm writes: the served manifest plus the build's
// own identity.
const profile = {
  kind: "omnia-enterprise-client",
  schema: 1,
  distribution: "omnisciens-omnia",
  version: "1.0.2",
  publishedAt: 1792385298265,
  name: "Omnisciens Omnia",
  appId: "io.omnia.enterprise.omnisciens-omnia",
  server: "http://10.0.0.4:8787/",
  manifestUrl: "http://10.0.0.4:8787/v1/enterprise/public/client/omnisciens-omnia/manifest",
  loginUrl: "http://10.0.0.4:8787/v1/enterprise/public/client/omnisciens-omnia/login",
  org: { name: "Acme", slug: "acme" },
  branding: {
    productName: "Omnisciens Omnia",
    signInHeadline: "Sign in to Omnisciens Omnia",
    primaryColor: "#0a0a0a",
    accentColor: "#2563eb",
    showOmniaBranding: false,
  },
  auth: {
    mode: "sso",
    methods: ["password"],
    sessionHours: 12,
    requireMfa: false,
    allowedEmailDomains: [],
    allowSocialLogin: false,
  },
  features: { shellTool: true, telemetry: false },
  experience: { theme: "dark", density: "compact", homeSurface: "sessions" },
  limits: { maxConcurrentSessions: 4 },
  models: { defaultModel: "opencode/big-pickle", allowed: [], blocked: [] },
  telemetry: { enabled: false, retentionDays: 30 },
  update: { channel: "stable", autoUpdate: true, allowDowngrade: false },
  deployment: { platforms: ["linux-x64"], mode: "lan", offlineBundle: true },
}

describe("enterprise profile", () => {
  test("reads the manifest-shaped build profile", () => {
    const parsed = readEnterpriseProfile(profile)
    expect(parsed?.org).toEqual({ name: "Acme", slug: "acme" })
    expect(parsed?.server).toBe("http://10.0.0.4:8787")
    expect(parsed?.publishedAt).toBe(1792385298265)
    expect(parsed?.experience.theme).toBe("dark")
    expect(parsed?.experience.homeSurface).toBe("sessions")
    expect(parsed?.update.channel).toBe("stable")
    expect(parsed?.deployment.mode).toBe("lan")
    expect(parsed?.branding.showOmniaBranding).toBe(false)
  })

  test("rejects a payload that is not an enterprise client", () => {
    expect(readEnterpriseProfile({ ...profile, kind: "omnia-public" })).toBeUndefined()
    expect(readEnterpriseProfile({ ...profile, schema: 2 })).toBeUndefined()
    expect(readEnterpriseProfile({ ...profile, appId: "" })).toBeUndefined()
    expect(readEnterpriseProfile({ ...profile, server: "   " })).toBeUndefined()
    expect(readEnterpriseProfile(undefined)).toBeUndefined()
  })

  test("normalizes the legacy string org from older installers", () => {
    const parsed = readEnterpriseProfile({ ...profile, org: "Acme" })
    expect(parsed?.org).toEqual({ name: "Acme", slug: "" })
  })

  test("resolves tool permissions and hands them to the engine", () => {
    const root = directory()
    const file = join(root, "enterprise.json")
    writeFileSync(
      file,
      JSON.stringify({
        ...profile,
        // The feature switch is off and the policy asks to allow: off still wins.
        features: { shellTool: false },
        permissions: { bash: "allow", edit: "ask", network: "deny" },
      }),
    )
    process.env.OMNIA_ENTERPRISE_PROFILE = file
    forgetEnterpriseProfile()
    try {
      expect(enterprisePermissions()).toMatchObject({
        read: "allow",
        edit: "ask",
        bash: "deny",
        network: "deny",
        externalDirectory: "allow",
      })
      expect(JSON.parse(enterprisePermissionEnv() ?? "{}")).toEqual({
        read: "allow",
        glob: "allow",
        grep: "allow",
        list: "allow",
        edit: "ask",
        bash: "deny",
        task: "allow",
        webfetch: "deny",
        websearch: "deny",
        external_directory: "allow",
        skill: "allow",
      })
    } finally {
      delete process.env.OMNIA_ENTERPRISE_PROFILE
      forgetEnterpriseProfile()
    }
  })

  test("reads the packaged file and tolerates a missing or invalid one", () => {
    const root = directory()
    const file = join(root, "enterprise.json")
    writeFileSync(file, JSON.stringify(profile))
    expect(readEnterpriseProfileFile(file)?.appId).toBe(profile.appId)
    expect(readEnterpriseProfileFile(join(root, "missing.json"))).toBeUndefined()
    writeFileSync(file, "not json")
    expect(readEnterpriseProfileFile(file)).toBeUndefined()
  })
})
