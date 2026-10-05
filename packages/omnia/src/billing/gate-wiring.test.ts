import { describe, expect, test } from "bun:test"
import { BrowserEntitlementGate } from "../browser/entitlement"
import { EntitlementGate as CuaGate } from "../cua/entitlements"
import { RemoteEntitlementGate } from "../remote/entitlement"

// The verifier found this gate posting to http://127.0.0.1 (port 80) and
// sending the bearer in cleartext to whatever was listening there, because the
// desktop sidecar sets OMNIA_SERVER_URL and OMNIA_SERVER_TOKEN but no PORT.
describe("browser gate endpoint resolution", () => {
  test("OMNIA_SERVER_URL wins, exactly as the other gates do", () => {
    const gate = BrowserEntitlementGate.fromEnv({
      OMNIA_SERVER_TOKEN: "secret",
      OMNIA_SERVER_URL: "https://control.example/omnia",
    })
    expect(gate.configured).toBe(true)
    expect((gate as unknown as { endpoint: string }).endpoint).toBe("https://control.example/omnia")
  })

  test("OMNIA_PUBLIC_URL is the fallback", () => {
    const gate = BrowserEntitlementGate.fromEnv({
      OMNIA_SERVER_TOKEN: "secret",
      OMNIA_PUBLIC_URL: "https://public.example/omnia",
    })
    expect((gate as unknown as { endpoint: string }).endpoint).toBe("https://public.example/omnia")
  })

  test("a host with NO port never becomes port 80", () => {
    // This exact shape is what the desktop sidecar produces. It must not guess.
    const gate = BrowserEntitlementGate.fromEnv({ OMNIA_SERVER_TOKEN: "secret", OMNIA_SERVER_HOST: "127.0.0.1" })
    expect(gate.configured).toBe(false)
  })

  test("an unusable port is treated as unconfigured, not as port 80", () => {
    for (const port of ["", "eighty", "8080/tcp", "-1"]) {
      const gate = BrowserEntitlementGate.fromEnv({ OMNIA_SERVER_TOKEN: "secret", OMNIA_SERVER_PORT: port })
      expect(`${port} -> configured=${gate.configured}`).toBe(`${port} -> configured=false`)
    }
  })

  test("a real host:port pair is still honoured", () => {
    const gate = BrowserEntitlementGate.fromEnv({
      OMNIA_SERVER_TOKEN: "secret",
      OMNIA_SERVER_HOST: "127.0.0.1",
      OMNIA_SERVER_PORT: "4311",
    })
    expect((gate as unknown as { endpoint: string }).endpoint).toBe("http://127.0.0.1:4311")
  })

  test("no token means inert", () => {
    expect(BrowserEntitlementGate.fromEnv({ OMNIA_SERVER_URL: "https://x.example" }).configured).toBe(false)
  })
})

describe("cua gate answer validation", () => {
  test("an answer about a different capability is not accepted", async () => {
    const gate = new CuaGate({
      env: { OMNIA_SERVER_URL: "http://127.0.0.1:1", OMNIA_SERVER_TOKEN: "t" },
      // A granted answer for a DIFFERENT capability must not grant this one.
      http: Object.assign(async () =>
        new Response(JSON.stringify({ allowed: true, code: "granted", capability: "browser_automation" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }), { preconnect: () => undefined }) as unknown as typeof fetch,
    })
    const decision = await gate.check("cloud_vision")
    expect(decision.allowed).toBe(false)
  })

  test("a matching echo is accepted", async () => {
    const gate = new CuaGate({
      env: { OMNIA_SERVER_URL: "http://127.0.0.1:1", OMNIA_SERVER_TOKEN: "t" },
      http: Object.assign(async () =>
        new Response(JSON.stringify({ allowed: true, code: "granted", capability: "cloud_vision" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }), { preconnect: () => undefined }) as unknown as typeof fetch,
    })
    expect((await gate.check("cloud_vision")).allowed).toBe(true)
  })
})

describe("remote allowance cannot be bypassed", () => {
  const gate = (status: number) =>
    new RemoteEntitlementGate({
      env: { OMNIA_SERVER_URL: "http://127.0.0.1:1", OMNIA_SERVER_TOKEN: "t" },
      profileId: "230746284",
      http: Object.assign(async () => new Response("{}", { status }), { preconnect: () => undefined }) as unknown as typeof fetch,
    })

  test("a revoked credential cannot pair", async () => {
    // 401 used to collapse into "count unknown", which allowed the claim and so
    // bypassed the computer allowance entirely.
    expect((await gate(401).authorizeComputer()).allowed).toBe(false)
    expect((await gate(403).authorizeComputer()).allowed).toBe(false)
  })

  test("a server error no longer grants unlimited computers", async () => {
    const decision = await gate(500).authorizeComputer()
    expect(decision.allowed).toBe(true)
    // ...but only up to the free allowance, never unbounded.
    expect(decision.allowance).toBe(3)
    expect(decision.origin).toBe("fail-closed")
  })
})