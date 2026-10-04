import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CredentialStore, type CredentialRule } from "./store"

function storeWith(rule: CredentialRule): CredentialStore {
  const store = new CredentialStore({ file: join(mkdtempSync(join(tmpdir(), "omnia-rule-match-")), "credentials.json") })
  // A wildcard computer is the widest blast radius: every machine asks, so a
  // loose url rule here types the secret anywhere.
  store.save({ computerId: "*", name: "portal", secret: "hunter2", rules: [rule] })
  return store
}

describe("url rule origin boundaries", () => {
  test("a host rule covers its own origin and everything under it", () => {
    const store = storeWith({ kind: "url", match: "https://app.example.com" })
    for (const url of [
      "https://app.example.com",
      "https://app.example.com/",
      "https://app.example.com/login",
      "https://app.example.com/login?next=%2Fhome#form",
      "https://APP.example.com/login",
      // A default port is the same origin, not a different one.
      "https://app.example.com:443/login",
    ]) {
      expect(store.match({ computerId: "local", url })?.credential.name, url).toBe("portal")
    }
  })

  test("a host rule never authorizes a host that merely starts with it", () => {
    const store = storeWith({ kind: "url", match: "https://app.example.com" })
    for (const url of [
      // The pages a raw `startsWith` authorized on an attacker domain.
      "https://app.example.com.evil.tld/login",
      "https://app.example.com.evil.tld",
      // The same page spelled as userinfo: the host is evil.tld.
      "https://app.example.com@evil.tld/login",
      "https://app.example.com:pass@evil.tld/",
      // Neighbours that share a prefix or a suffix.
      "https://sub.app.example.com/login",
      "https://notapp.example.com/login",
      "https://app.example.como/login",
      // The FQDN root marker makes this a different origin than the rule.
      "https://app.example.com./login",
      // A rule is scheme bound: http is a different origin.
      "http://app.example.com/login",
      "https://app.example.com:8443/login",
      // Unrelated spellings must not slip through the parser.
      "app.example.com/login",
      "https://evil.tld/?next=https://app.example.com",
      "",
    ]) {
      expect(store.match({ computerId: "local", url }), url).toBeUndefined()
    }
  })

  test("a path rule matches its own subtree on a slash boundary", () => {
    const store = storeWith({ kind: "url", match: "https://app.example.com/admin" })
    for (const url of [
      "https://app.example.com/admin",
      "https://app.example.com/admin/",
      "https://app.example.com/admin/users",
      "https://app.example.com/admin/users/1",
    ]) {
      expect(store.match({ computerId: "local", url })?.credential.name, url).toBe("portal")
    }
    for (const url of [
      "https://app.example.com/administrator",
      "https://app.example.com/admin.php",
      "https://app.example.com/ADMIN/users",
      "https://app.example.com//admin",
      "https://app.example.com/admin/../public",
      "https://app.example.com/",
    ]) {
      expect(store.match({ computerId: "local", url }), url).toBeUndefined()
    }
  })

  test("a rule carrying userinfo is ambiguous and matches nothing", () => {
    const store = storeWith({ kind: "url", match: "https://app.example.com@evil.tld" })
    expect(store.match({ computerId: "local", url: "https://evil.tld/login" })).toBeUndefined()
    expect(store.match({ computerId: "local", url: "https://app.example.com@evil.tld/login" })).toBeUndefined()
    expect(store.match({ computerId: "local", url: "https://app.example.com/login" })).toBeUndefined()
  })
})

describe("credential rule ranking", () => {
  test("rule kind outranks match length", () => {
    const store = new CredentialStore({
      file: join(mkdtempSync(join(tmpdir(), "omnia-rule-match-")), "credentials.json"),
    })
    store.save({
      computerId: "*",
      name: "url",
      secret: "u",
      rules: [{ kind: "url", match: "https://portal.example/admin/settings/profile/security" }],
    })
    store.save({ computerId: "*", name: "app", secret: "a", rules: [{ kind: "application", match: "Portal" }] })
    store.save({ computerId: "*", name: "cmd", secret: "c", rules: [{ kind: "command", match: "portalctl reload" }] })

    const url = "https://portal.example/admin/settings/profile/security"
    // A 50 character url rule never outranks a 6 character application rule.
    expect(store.match({ computerId: "local", application: "Portal", url })?.credential.name).toBe("app")
    // An exact command outranks both, whatever their length.
    expect(store.match({ computerId: "local", command: "portalctl reload", application: "Portal", url })?.credential.name).toBe(
      "cmd",
    )
    // Without the more specific kinds in the query, the url rule is the match.
    expect(store.match({ computerId: "local", url })?.credential.name).toBe("url")
    expect(store.match({ computerId: "local", command: "portalctl reload" })?.credential.name).toBe("cmd")
    // A query that satisfies nothing matches nothing.
    expect(store.match({ computerId: "local", command: "ls", application: "Files", url: "https://example.com/" })).toBeUndefined()
  })

  test("length still separates rules of the same kind", () => {
    const store = new CredentialStore({
      file: join(mkdtempSync(join(tmpdir(), "omnia-rule-match-")), "credentials.json"),
    })
    store.save({ computerId: "*", name: "portal", secret: "p", rules: [{ kind: "url", match: "https://portal.example" }] })
    store.save({
      computerId: "*",
      name: "admin",
      secret: "a",
      rules: [{ kind: "url", match: "https://portal.example/admin" }],
    })
    const url = "https://portal.example/admin/users"
    expect(store.match({ computerId: "local", url })?.credential.name).toBe("admin")
    expect(store.match({ computerId: "local", url: "https://portal.example/login" })?.credential.name).toBe("portal")
  })
})
