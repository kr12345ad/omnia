import { describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  CredentialStore,
  credentialEnv,
  redactSecrets,
  summarizeCredential,
} from "./store"

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), "omnia-credentials-")), "credentials.json")
}

describe("credential store", () => {
  test("saves, lists, and masks credentials without exposing secrets", () => {
    const store = new CredentialStore({ file: tempFile(), now: () => 1000 })
    const saved = store.save({
      computerId: "local",
      name: "sudo",
      kind: "username_password",
      username: "krishnaa",
      secret: "hunter2",
      rules: [{ kind: "command", match: "sudo" }],
      description: "Host sudo password",
    })
    expect(saved.id.length).toBeGreaterThan(0)
    expect(saved.createdAt).toBe(1000)
    const summaries = store.summaries("local")
    expect(summaries).toHaveLength(1)
    expect(summaries[0]?.hasSecret).toBe(true)
    expect("secret" in (summaries[0] as unknown as Record<string, unknown>)).toBe(false)
    expect(summarizeCredential(saved).hasSecret).toBe(true)
    expect(JSON.stringify(summaries)).not.toContain("hunter2")
  })

  test("persists to a 0600 file and reloads", () => {
    const file = tempFile()
    const store = new CredentialStore({ file })
    store.save({ computerId: "local", name: "token", kind: "token", secret: "tok_123", rules: [] })
    const mode = statSync(file).mode & 0o777
    expect(mode).toBe(0o600)
    const reloaded = new CredentialStore({ file })
    expect(reloaded.summaries("local")).toHaveLength(1)
    expect(reloaded.get(reloaded.summaries("local")[0]!.id)?.secret).toBe("tok_123")
  })

  test("updates keep the existing secret when none is provided", () => {
    const store = new CredentialStore({ file: tempFile(), now: () => 1 })
    const saved = store.save({ computerId: "local", name: "sudo", secret: "old", rules: [] })
    const updated = store.save({ id: saved.id, computerId: "local", name: "sudo renamed", rules: [{ kind: "command", match: "sudo" }] })
    expect(updated.secret).toBe("old")
    expect(updated.name).toBe("sudo renamed")
    expect(store.summaries()).toHaveLength(1)
  })

  test("matches the most specific enabled rule for the right computer", () => {
    const store = new CredentialStore({ file: tempFile() })
    store.save({ computerId: "local", name: "generic", secret: "a", rules: [{ kind: "command", match: "sudo" }] })
    store.save({
      computerId: "local",
      name: "specific",
      secret: "b",
      rules: [{ kind: "command", match: "sudo systemctl restart" }],
    })
    store.save({ computerId: "other", name: "elsewhere", secret: "c", rules: [{ kind: "command", match: "sudo systemctl restart" }] })
    const match = store.match({ computerId: "local", command: "sudo systemctl restart nginx" })
    expect(match?.credential.name).toBe("specific")
    expect(store.match({ computerId: "local", command: "sudo ls" })?.credential.name).toBe("generic")
    expect(store.match({ computerId: "local", command: "ls" })).toBeUndefined()
  })

  test("does not inject credentials on substring matches", () => {
    const store = new CredentialStore({ file: tempFile() })
    store.save({ computerId: "local", name: "rm", secret: "r", rules: [{ kind: "command", match: "rm" }] })
    store.save({ computerId: "local", name: "gh", secret: "g", rules: [{ kind: "command", match: "gh" }] })
    expect(store.match({ computerId: "local", command: "format disk" })).toBeUndefined()
    expect(store.match({ computerId: "local", command: "ghostscript file.ps" })).toBeUndefined()
    expect(store.match({ computerId: "local", command: "rm -rf /tmp/x" })?.credential.name).toBe("rm")
    expect(store.match({ computerId: "local", command: "gh auth login" })?.credential.name).toBe("gh")
  })

  test("skips disabled credentials and honors wildcard computers and url rules", () => {
    const store = new CredentialStore({ file: tempFile() })
    store.save({ computerId: "*", name: "portal", secret: "p", rules: [{ kind: "url", match: "https://portal.example" }] })
    const disabled = store.save({ computerId: "*", name: "off", secret: "o", rules: [{ kind: "url", match: "https://portal.example/admin" }], enabled: false })
    const match = store.match({ computerId: "local", url: "https://portal.example/admin" })
    expect(match?.credential.name).toBe("portal")
    expect(disabled.enabled).toBe(false)
  })

  test("url rules match parsed identity, never a string prefix", () => {
    const store = new CredentialStore({ file: tempFile() })
    store.save({ computerId: "*", name: "portal", secret: "p", rules: [{ kind: "url", match: "https://portal.example" }] })
    store.save({ computerId: "*", name: "admin", secret: "a", rules: [{ kind: "url", match: "https://portal.example/admin" }] })
    // The attacker page an old prefix match authorized.
    for (const url of [
      "https://portal.example.evil.tld/login",
      "https://portal.example@evil.tld/login",
      "https://evil.tld/?next=https://portal.example",
      "http://portal.example/login",
      "https://sub.portal.example/login",
      "https://portal.example./login",
      "not a url",
    ]) {
      expect(store.match({ computerId: "local", url }), url).toBeUndefined()
    }
    expect(store.match({ computerId: "local", url: "https://portal.example/login" })?.credential.name).toBe("portal")
    expect(store.match({ computerId: "local", url: "https://portal.example/admin" })?.credential.name).toBe("admin")
    expect(store.match({ computerId: "local", url: "https://portal.example/admin/users" })?.credential.name).toBe("admin")
    // A rule path only covers its own subtree on a `/` boundary.
    expect(store.match({ computerId: "local", url: "https://portal.example/administrator" })?.credential.name).toBe("portal")
  })

  test("ranks rule kind before match length", () => {
    const store = new CredentialStore({ file: tempFile() })
    store.save({
      computerId: "*",
      name: "url",
      secret: "u",
      rules: [{ kind: "url", match: "https://portal.example/admin/settings/profile" }],
    })
    store.save({ computerId: "*", name: "app", secret: "a", rules: [{ kind: "application", match: "Portal" }] })
    const match = store.match({ computerId: "local", application: "Portal", url: "https://portal.example/admin/settings/profile" })
    expect(match?.credential.name).toBe("app")
  })

  test("removes credentials", () => {
    const store = new CredentialStore({ file: tempFile() })
    const saved = store.save({ computerId: "local", name: "temp", secret: "t", rules: [] })
    expect(store.remove(saved.id)).toBe(true)
    expect(store.remove(saved.id)).toBe(false)
    expect(store.summaries()).toHaveLength(0)
  })

  test("builds environment keys and redacts secret output", () => {
    const store = new CredentialStore({ file: tempFile() })
    const credential = store.save({
      computerId: "local",
      name: "login",
      kind: "username_password",
      username: "krishnaa",
      secret: "s3cr3t",
      rules: [],
    })
    expect(credentialEnv(credential)).toEqual({
      OMNIA_CREDENTIAL_USERNAME: "krishnaa",
      OMNIA_CREDENTIAL_PASSWORD: "s3cr3t",
    })
    expect(redactSecrets("password is s3cr3t here", ["s3cr3t"])).toBe("password is [redacted] here")
    expect(redactSecrets("nothing", ["s3cr3t"])).toBe("nothing")
    expect(redactSecrets("code is ab here", ["ab"])).toBe("code is [redacted] here")
    expect(redactSecrets("nothing", [""])).toBe("nothing")
  })

  test("tolerates a missing or malformed file", () => {
    const missing = new CredentialStore({ file: join(tmpdir(), "omnia-credentials-does-not-exist", "credentials.json") })
    expect(missing.summaries()).toHaveLength(0)
  })

  test("quarantines a corrupt vault instead of overwriting it", () => {
    const file = join(mkdtempSync(join(tmpdir(), "omnia-credentials-")), "credentials.json")
    writeFileSync(file, '{"version":1,"credentials":[{"id"')
    const store = new CredentialStore({ file })
    expect(store.summaries()).toHaveLength(0)
    expect(readFileSync(`${file}.corrupt`, "utf8")).toBe('{"version":1,"credentials":[{"id"')
    expect(existsSync(file)).toBe(false)
    store.save({ computerId: "local", name: "fresh", secret: "f", rules: [] })
    expect(statSync(file).mode & 0o777).toBe(0o600)
    // The recovered bytes outlive the fresh vault, and no temp file is left.
    expect(readFileSync(`${file}.corrupt`, "utf8")).toContain('{"id"')
    expect(readdirSync(dirname(file)).filter((entry) => entry.endsWith(".tmp"))).toHaveLength(0)
    expect(new CredentialStore({ file }).get(store.summaries()[0]!.id)?.secret).toBe("f")
  })

  test("quarantines a vault it cannot read instead of overwriting it", () => {
    const file = join(mkdtempSync(join(tmpdir(), "omnia-credentials-")), "credentials.json")
    writeFileSync(file, '{"version":1,"credentials":[{"id":"kept","computerId":"local","name":"n","kind":"password","secret":"s","rules":[]}]}', {
      mode: 0o000,
    })
    const store = new CredentialStore({ file })
    expect(store.summaries()).toHaveLength(0)
    // An unreadable vault is still a vault: the bytes move aside instead of
    // being replaced by the empty one the next save would write.
    expect(existsSync(file)).toBe(false)
    expect(existsSync(`${file}.corrupt`)).toBe(true)
    chmodSync(`${file}.corrupt`, 0o600)
    expect(readFileSync(`${file}.corrupt`, "utf8")).toContain('"kept"')
    expect(new CredentialStore({ file: `${file}.corrupt` }).summaries("local")).toHaveLength(1)
  })

  test("creates a missing parent directory privately", () => {
    const directory = join(mkdtempSync(join(tmpdir(), "omnia-credentials-")), "nested")
    const file = join(directory, "credentials.json")
    const store = new CredentialStore({ file })
    store.save({ computerId: "local", name: "sudo", secret: "s", rules: [] })
    expect(statSync(directory).mode & 0o777).toBe(0o700)
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })
})
