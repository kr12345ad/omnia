import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openEnterpriseStore } from "../enterprise/store"

// The CLI is exercised as a process, the same way an operator runs it, so the
// flag parser, the store and the printed output are all covered together.

const home = mkdtempSync(join(tmpdir(), "omnia-cli-test-"))
const cliPath = join(import.meta.dir, "cli.ts")

async function cli(...args: string[]) {
  const child = Bun.spawn([process.execPath, cliPath, "--home", home, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { code, stdout, stderr }
}

async function json(...args: string[]) {
  const result = await cli(...args)
  expect(result.code).toBe(0)
  return JSON.parse(result.stdout)
}

afterAll(() => {
  rmSync(home, { recursive: true, force: true })
})

describe("omnia-server cli", () => {
  test("init creates a deployment", async () => {
    const result = await cli("init", "--org", "CLI Co", "--admin", "owner@cli.test", "--mode", "lan")
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("One-time setup link")
  })

  test("people can be created, filtered and grouped without leaking password hashes", async () => {
    const created = await cli("users", "add", "--email", "sam@cli.test", "--name", "Sam", "--role", "manager", "--password", "correct-horse-battery")
    expect(created.code).toBe(0)
    expect(created.stdout).toContain("active")

    await json("groups", "add", "Engineering", "--role", "member", "--models", "gpt-5")
    const updated = await cli("users", "update", "sam@cli.test", "--groups", "Engineering", "--mfa", "on")
    expect(updated.code).toBe(0)

    const people = await json("users", "list", "--role", "manager", "--json")
    expect(people).toHaveLength(1)
    expect(people[0].email).toBe("sam@cli.test")
    expect(people[0].mfaEnabled).toBe(true)
    expect(people[0].groupIds).toHaveLength(1)
    expect(people[0].passwordHash).toBeUndefined()

    const shown = await json("users", "show", "sam@cli.test")
    expect(shown.groups[0].name).toBe("Engineering")
  })

  test("invitations come back as one-time links", async () => {
    const result = await cli("users", "invite", "ada@cli.test", "--name", "Ada", "--role", "auditor")
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("oms_invite_")

    const invites = await json("invites", "list", "--json")
    const invite = invites.find((entry: { email: string }) => entry.email === "ada@cli.test")
    expect(invite?.purpose).toBe("invite")
    expect(invite?.tokenHash).toBeUndefined()
  })

  test("build permissions reach the manifest and invalid rules fail", async () => {
    await json("builds", "create", "Work Desktop", "--slug", "work")
    const updated = await cli(
      "builds",
      "update",
      "work",
      "--permission",
      "bash=deny",
      "--permission",
      "edit=ask",
      "--feature",
      "shellTool=off",
      "--platforms",
      "linux-x64,macos-arm64",
      "--deployment",
      "lan",
    )
    expect(updated.code).toBe(0)

    const manifest = await json("builds", "manifest", "work")
    expect(manifest.permissions.bash).toBe("deny")
    expect(manifest.permissions.edit).toBe("ask")
    expect(manifest.features.shellTool).toBe(false)
    expect(manifest.deployment.platforms).toEqual(["linux-x64", "macos-arm64"])

    const invalid = await cli("builds", "update", "work", "--permission", "bash=sometimes")
    expect(invalid.code).toBe(1)
    expect(invalid.stderr).toContain("allow, ask or deny")
  })

  test("built installers can be copied out for offline handoff", async () => {
    const store = openEnterpriseStore({ file: join(home, "data", "enterprise.json") })
    const distribution = store.distributions().find((entry) => entry.slug === "work")!
    const release = store.startRelease({
      distributionId: distribution.id,
      platform: "linux-x64",
      version: distribution.version,
    })
    const directory = join(home, "data", "releases", "work", distribution.version, "linux-x64")
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, "work.deb"), "fake-installer")
    store.completeRelease(release.id, { filename: "work.deb", bytes: 14, sha256: "abc123" })

    const missing = await cli("builds", "installer", "work", "macos-arm64")
    expect(missing.code).toBe(1)
    expect(missing.stderr).toContain("No ready macos-arm64 installer")

    const out = join(home, "handoff.deb")
    const copied = await cli("builds", "installer", "work", "linux-x64", "--out", out)
    expect(copied.code).toBe(0)
    expect(copied.stdout).toContain("sha256 abc123")
    expect(readFileSync(out, "utf8")).toBe("fake-installer")

    const audit = await json("audit", "--json", "--action", "client.download")
    expect(audit[0].target).toBe("work")
  })

  test("an installer built on another machine can be registered", async () => {
    const source = join(home, "Setup 1.4.0.exe")
    writeFileSync(source, "windows-setup-binary")
    const imported = await cli("builds", "import", "work", "--platform", "windows-x64", "--file", source)
    expect(imported.code).toBe(0)
    expect(imported.stdout).toContain("sha256")

    const releases = await json("builds", "releases", "work", "--json")
    const release = releases.find((entry: { platform: string }) => entry.platform === "windows-x64")
    expect(release?.status).toBe("ready")
    expect(release?.filename).toBe("Setup_1.4.0.exe")

    // The filed artifact is what the published manifest serves, so the copy-out
    // path has to find it under the distribution's current version.
    const out = join(home, "imported.exe")
    const copied = await cli("builds", "installer", "work", "windows-x64", "--out", out)
    expect(copied.code).toBe(0)
    expect(readFileSync(out, "utf8")).toBe("windows-setup-binary")

    const missing = await cli("builds", "import", "work", "--platform", "windows-x64", "--file", join(home, "nope.exe"))
    expect(missing.code).toBe(1)
    expect(missing.stderr).toContain("No installer file")
  })

  test("policy updates merge with the current policy", async () => {
    const updated = await json(
      "policy",
      "set",
      "--model-mode",
      "allowlist",
      "--models",
      "gpt-5,claude-sonnet",
      "--allow-shell",
      "off",
      "--retention-days",
      "30",
    )
    expect(updated.model.mode).toBe("allowlist")
    expect(updated.model.models).toEqual(["gpt-5", "claude-sonnet"])
    expect(updated.tools.allowShell).toBe(false)
    expect(updated.data.retentionDays).toBe(30)
    expect(updated.tools.allowFileWrite).toBe(true)

    const shown = await json("policy", "show")
    expect(shown.model.mode).toBe("allowlist")
  })

  test("audit and usage exports are machine readable", async () => {
    const audit = await cli("audit", "--json", "--limit", "5")
    expect(audit.code).toBe(0)
    const events = JSON.parse(audit.stdout)
    expect(events.length).toBeGreaterThan(0)
    expect(events[0].action).toBeDefined()

    const csv = await cli("audit", "export", "--format", "csv")
    expect(csv.code).toBe(0)
    expect(csv.stdout.split("\n")[0]).toBe("id,at,iso,action,actor_id,actor_email,target,ip,metadata")

    const usage = await json("usage", "--json", "--days", "7")
    expect(usage.windowDays).toBe(7)
    expect(usage.requests).toBe(0)
  })

  test("destructive actions need confirmation", async () => {
    const refused = await cli("builds", "delete", "work")
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain("--force")

    const deleted = await cli("builds", "delete", "work", "--force")
    expect(deleted.code).toBe(0)

    const unknown = await cli("users", "delete", "nobody@cli.test")
    expect(unknown.code).toBe(1)
    expect(unknown.stderr).toContain("No person matches")
  })
})
