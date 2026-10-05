import { describe, expect, test } from "bun:test"
import { EntitlementGate, EntitlementRefusedError, isEntitlementRefusedError } from "./entitlements"
import type { Capability } from "../billing/plans"

interface Recorded {
  readonly capability: string
  readonly profile: string | undefined
  readonly body: unknown
}

function reply(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } })
}

function refusal(capability: Capability, extra: Record<string, unknown> = {}): Response {
  return reply(
    {
      ok: false,
      allowed: false,
      code: "not_entitled",
      plan: "free",
      capability,
      used: 0,
      limit: 0,
      metering: "hard",
      reason: `${capability} is not included in the free plan.`,
      ...extra,
    },
    402,
  )
}

function granted(capability: Capability, extra: Record<string, unknown> = {}): Response {
  return reply({
    ok: true,
    allowed: true,
    code: "granted",
    plan: "pro",
    capability,
    used: 3,
    limit: 2000,
    metering: "soft",
    reason: `${capability} is included in the pro plan.`,
    ...extra,
  })
}

interface Harness {
  readonly gate: EntitlementGate
  readonly calls: Recorded[]
}

function gate(handler: (call: Recorded) => Response | Promise<Response>, options: Record<string, unknown> = {}): Harness {
  const calls: Recorded[] = []
  const http = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body: unknown = JSON.parse(String(init?.body ?? "{}"))
    const call: Recorded = {
      capability: String((body as { capability?: unknown }).capability ?? ""),
      profile: (init?.headers as Record<string, string> | undefined)?.["x-omnia-profile"],
      body,
    }
    calls.push(call)
    return handler(call)
  }) as unknown as typeof fetch
  return {
    calls,
    // authFile is pointed at a path that cannot exist so the developer's own
    // sign-in state cannot decide a test.
    gate: new EntitlementGate({ endpoint: "http://control.test", authFile: "/nonexistent/auth.json", http, ...options }),
  }
}

describe("entitlement gate failure policy", () => {
  test("a paid capability fails closed when the control plane is unreachable", async () => {
    const harness = gate(() => {
      throw new Error("ECONNREFUSED")
    })
    const decision = await harness.gate.check("cloud_vision")
    expect(decision.allowed).toBe(false)
    expect(decision.origin).toBe("fail-closed")
    expect(decision.degraded).toBe(true)
    expect(decision.capability).toBe("cloud_vision")
    expect(decision.reason).toContain("ECONNREFUSED")
  })

  test("a free capability fails open when the control plane is unreachable", async () => {
    const harness = gate(() => {
      throw new Error("ECONNREFUSED")
    })
    const decision = await harness.gate.check("live_view")
    expect(decision.allowed).toBe(true)
    expect(decision.origin).toBe("fail-open")
    expect(decision.degraded).toBe(true)
    expect(decision.reason).toContain("ECONNREFUSED")
  })

  test("a 5xx is a failure, not a decision", async () => {
    const harness = gate(() => reply({ ok: false, error: "boom" }, 503))
    expect((await harness.gate.check("cloud_vision")).origin).toBe("fail-closed")
    expect((await harness.gate.check("live_view")).origin).toBe("fail-open")
  })

  test("an unreadable answer is a failure, not a decision", async () => {
    const harness = gate(() => new Response("<html>gateway</html>", { status: 200 }))
    const decision = await harness.gate.check("cloud_vision")
    expect(decision.allowed).toBe(false)
    expect(decision.origin).toBe("fail-closed")
    expect(decision.reason).toContain("unreadable decision")
  })

  test("an install with no control plane has nothing to enforce against", async () => {
    const calls: Recorded[] = []
    const local = new EntitlementGate({
      env: {},
      authFile: "/nonexistent/auth.json",
      http: (async () => {
        throw new Error("must not be called")
      }) as unknown as typeof fetch,
    })
    const decision = await local.check("cloud_vision")
    expect(decision.allowed).toBe(true)
    expect(decision.code).toBe("unconfigured")
    expect(decision.degraded).toBe(true)
    expect(calls).toHaveLength(0)
  })

  test("a fallback answer is reused during an outage and released after it", async () => {
    let at = 0
    const harness = gate(
      () => {
        throw new Error("ECONNREFUSED")
      },
      { now: () => at },
    )
    expect((await harness.gate.check("cloud_vision")).origin).toBe("fail-closed")
    expect((await harness.gate.check("cloud_vision")).origin).toBe("fail-closed")
    expect(harness.calls).toHaveLength(1)
    at = 60_000
    await harness.gate.check("cloud_vision")
    expect(harness.calls).toHaveLength(2)
  })
})

describe("entitlement gate decisions", () => {
  test("a real decision is never cached: every action spends its own unit", async () => {
    const harness = gate((call) => granted(call.capability as Capability))
    await harness.gate.check("cloud_vision")
    await harness.gate.check("cloud_vision")
    await harness.gate.check("cloud_vision")
    expect(harness.calls).toHaveLength(3)
  })

  test("concurrent actions each pay for themselves", async () => {
    const harness = gate((call) => granted(call.capability as Capability))
    await Promise.all([
      harness.gate.check("cloud_vision"),
      harness.gate.check("cloud_vision"),
      harness.gate.check("cloud_vision"),
    ])
    expect(harness.calls).toHaveLength(3)
  })

  test("each capability is metered separately", async () => {
    const harness = gate((call) => granted(call.capability as Capability))
    await harness.gate.check("cloud_vision")
    await harness.gate.check("live_view")
    expect(harness.calls.map((call) => call.capability)).toEqual(["cloud_vision", "live_view"])
  })

  test("a refusal carries the capability and the control plane's reason", async () => {
    const harness = gate((call) => refusal(call.capability as Capability))
    const decision = await harness.gate.check("cloud_vision")
    expect(decision.allowed).toBe(false)
    expect(decision.code).toBe("not_entitled")
    expect(decision.plan).toBe("free")
    expect(decision.used).toBe(0)
    expect(decision.limit).toBe(0)
    expect(decision.origin).toBe("control-plane")
    expect(decision.degraded).toBe(false)
    expect(decision.reason).toBe("cloud_vision is not included in the free plan.")
  })

  test("authorize throws a typed refusal that names the capability", async () => {
    const harness = gate((call) => refusal(call.capability as Capability))
    const thrown = await harness.gate.authorize("cloud_vision").catch((error: unknown) => error)
    expect(isEntitlementRefusedError(thrown)).toBe(true)
    const refusalError = thrown as EntitlementRefusedError
    expect(refusalError.capability).toBe("cloud_vision")
    expect(refusalError.decision.reason).toContain("not included in the free plan")
    expect(refusalError.message).toContain("cloud_vision")
  })

  test("the signed-in profile is sent so the check resolves a subscription", async () => {
    const harness = gate((call) => granted(call.capability as Capability), { profileId: "230746284" })
    await harness.gate.check("cloud_vision")
    expect(harness.calls[0]?.profile).toBe("230746284")
    expect(harness.calls[0]?.body).toEqual({ capability: "cloud_vision", profileId: "230746284" })
  })

  test("a soft allowance past its limit is reported as granted", async () => {
    const harness = gate(() =>
      reply({
        ok: true,
        allowed: true,
        code: "limit_reached",
        plan: "free",
        capability: "live_view",
        used: 20,
        limit: 20,
        metering: "soft",
        reason: "live_view is past its fair-use allowance (20/20); it still works on free.",
      }),
    )
    const decision = await harness.gate.check("live_view")
    expect(decision.allowed).toBe(true)
    expect(decision.code).toBe("limit_reached")
    expect(decision.used).toBe(20)
  })

  test("the endpoint falls back to the loopback origin the server was started on", async () => {
    const seen: string[] = []
    const local = new EntitlementGate({
      env: { OMNIA_SERVER_PORT: "4096", OMNIA_SERVER_HOST: "127.0.0.1" },
      authFile: "/nonexistent/auth.json",
      http: (async (url: string) => {
        seen.push(String(url))
        return granted("cloud_vision")
      }) as unknown as typeof fetch,
    })
    await local.check("cloud_vision")
    expect(seen).toEqual(["http://127.0.0.1:4096/v1/billing/check"])
  })
})
