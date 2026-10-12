import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  ALWAYS_ON_RELIABILITY,
  EntitlementGate,
  EntitlementRefusedError,
  METERED_CAPABILITIES,
  isEntitlementRefusedError,
  isMeteredCapability,
  isUnmeteredCapabilityError,
} from "./entitlements"
import type { EntitlementGateOptions } from "./entitlements"
import { PLANS } from "../billing/plans"
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

/**
 * The gate is pointed at a control plane the way production points it: through
 * the environment. There is deliberately no endpoint or token option, so a test
 * that wants a different control plane hands over a different environment.
 *
 * authFile is pointed at a path that cannot exist unless a test supplies one, so
 * the developer's own sign-in state cannot decide a test.
 */
function gate(
  handler: (call: Recorded) => Response | Promise<Response>,
  options: Partial<EntitlementGateOptions> = {},
): Harness {
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
    gate: new EntitlementGate({
      env: { OMNIA_SERVER_URL: "http://control.test", OMNIA_SERVER_TOKEN: "token-1" },
      authFile: "/nonexistent/auth.json",
      http,
      ...options,
    }),
  }
}

interface Harness {
  readonly gate: EntitlementGate
  readonly calls: Recorded[]
}

/** A writable stand-in for the auth file sign-in and sign-out rewrite. */
const dir = mkdtempSync(join(tmpdir(), "omnia-entitlement-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

let counter = 0

function authFile(): string {
  const file = join(dir, `auth-${String(counter++)}.json`)
  return file
}

function signedIn(file: string, id: number): void {
  writeFileSync(file, JSON.stringify({ profile: { id } }))
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
    // The transport's own text never reaches a user-visible reason, and the plan
    // it was refused against is the one the client knows about.
    expect(decision.reason).toContain("could not be reached")
    expect(decision.reason).not.toContain("ECONNREFUSED")
    expect(decision.metering).toBe("hard")
  })

  test("a 5xx is a failure, not a decision", async () => {
    const harness = gate(() => reply({ ok: false, error: "boom" }, 503))
    expect((await harness.gate.check("cloud_vision")).origin).toBe("fail-closed")
    // live_view is hard-metered on free, so a 5xx fails closed for it too; the
    // fail-open side of the policy is pinned by the metered-set test below.
    expect((await harness.gate.check("live_view")).origin).toBe("fail-closed")
  })

  test("this gate has no fail-open capability, because it only meters paid capacity", async () => {
    // The fail-open half of the failure policy is real and belongs to the
    // client: a soft allowance keeps working through an outage so a Stripe
    // incident cannot brick the app somebody is already using. It is pinned in
    // ../billing/client.test.ts and ../billing/enforcement-contract.test.ts.
    //
    // What matters HERE is that the CUA gate has no such capability to begin
    // with. cloud_vision is not on free at all and live_view is a hard
    // allowance, so a billing outage refuses both rather than handing out
    // capacity nobody paid for - and neither of them is a free user's safe path
    // (see ALWAYS_ON_RELIABILITY), so refusing them costs nobody safety.
    expect(METERED_CAPABILITIES).toEqual(["cloud_vision", "live_view"])
    expect(PLANS.free.capabilities.cloud_vision.metering).toBe("hard")
    expect(PLANS.free.capabilities.cloud_vision.limit).toBe(0)
    expect(PLANS.free.capabilities.live_view.metering).toBe("hard")
    expect(PLANS.free.capabilities.live_view.limit).toBe(500)
  })

  test("a refusal answered with 402 is a decision, not a failure", async () => {
    const harness = gate((call) => refusal(call.capability as Capability))
    const decision = await harness.gate.check("cloud_vision")
    expect(decision.code).toBe("not_entitled")
    expect(decision.origin).toBe("control-plane")
    expect(decision.degraded).toBe(false)
  })

  test("an unreadable answer is a failure, not a decision", async () => {
    const harness = gate(() => new Response("<html>gateway</html>", { status: 200 }))
    const decision = await harness.gate.check("cloud_vision")
    expect(decision.allowed).toBe(false)
    expect(decision.origin).toBe("fail-closed")
    expect(decision.reason).toContain("unreadable answer")
  })

  test("an install with no control plane has nothing to enforce against", async () => {
    const calls: Recorded[] = []
    const local = new EntitlementGate({
      env: {},
      authFile: "/nonexistent/auth.json",
      http: (async () => {
        calls.push({ capability: "", profile: undefined, body: undefined })
        throw new Error("must not be called")
      }) as unknown as typeof fetch,
    })
    const decision = await local.check("cloud_vision")
    expect(decision.allowed).toBe(true)
    expect(decision.code).toBe("unconfigured")
    expect(decision.origin).toBe("unconfigured")
    expect(decision.degraded).toBe(true)
    expect(calls).toHaveLength(0)
  })

  test("a host with no usable endpoint is inert rather than a request to port 80", async () => {
    // A token with a host but no port is what the desktop sidecar produces. It
    // used to mean "http://127.0.0.1" here, which POSTed the bearer in cleartext
    // to whatever answered on 80.
    let calls = 0
    const local = new EntitlementGate({
      env: { OMNIA_SERVER_TOKEN: "token-1", OMNIA_SERVER_HOST: "127.0.0.1" },
      authFile: "/nonexistent/auth.json",
      http: (async () => {
        calls++
        return granted("cloud_vision")
      }) as unknown as typeof fetch,
    })
    expect((await local.check("cloud_vision")).code).toBe("unconfigured")
    expect(calls).toBe(0)
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

  test("the control plane is resolved from the environment exactly as the client resolves it", async () => {
    const seen: string[] = []
    const local = new EntitlementGate({
      env: { OMNIA_SERVER_TOKEN: "token-1", OMNIA_SERVER_PORT: "4096", OMNIA_SERVER_HOST: "127.0.0.1" },
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

describe("the profile a check is about", () => {
  test("is read per check, so a sign-in is not billed to the previous profile", async () => {
    const file = authFile()
    signedIn(file, 111)
    const harness = gate((call) => granted(call.capability as Capability), { authFile: file })
    await harness.gate.check("cloud_vision")
    // Sign out and sign in as somebody else, exactly as the auth file records it.
    signedIn(file, 222)
    await harness.gate.check("cloud_vision")
    expect(harness.calls.map((call) => call.profile)).toEqual(["111", "222"])
    rmSync(file)
    await harness.gate.check("cloud_vision")
    expect(harness.calls.map((call) => call.profile)).toEqual(["111", "222", undefined])
  })

  test("keys the fallback cache by profile, so one profile's refusal is not served to the next", async () => {
    const file = authFile()
    signedIn(file, 111)
    // The clock never moves, so the degraded cache is still warm for the profile
    // that filled it. A second check for THAT profile must be free; a check for a
    // different profile must not be answered from it.
    const harness = gate(
      () => {
        throw new Error("ECONNREFUSED")
      },
      { authFile: file, now: () => 0 },
    )
    expect((await harness.gate.check("cloud_vision")).origin).toBe("fail-closed")
    expect((await harness.gate.check("cloud_vision")).origin).toBe("fail-closed")
    expect(harness.calls).toHaveLength(1)
    signedIn(file, 222)
    expect((await harness.gate.check("cloud_vision")).origin).toBe("fail-closed")
    expect(harness.calls).toHaveLength(2)
    expect(harness.calls[1]?.profile).toBe("222")
  })
})

// The rule that keeps the gate out of the safety path: it may meter paid
// CAPACITY and nothing else, so a refund can never take away honest
// verification, ref resolution, aim computation, a stale-ref refusal or the
// bounds-centre warning.
describe("what the gate may meter", () => {
  /** A gate that would grant anything, and counts how often it is asked. */
  function permissiveGate(): { gate: EntitlementGate; asked: () => number } {
    let asked = 0
    return {
      asked: () => asked,
      gate: new EntitlementGate({
        env: { OMNIA_SERVER_URL: "http://control.test", OMNIA_SERVER_TOKEN: "token-1" },
        authFile: "/nonexistent/auth.json",
        http: (async () => {
          asked += 1
          return granted("cloud_vision")
        }) as unknown as typeof fetch,
      }),
    }
  }

  test("the metered set is paid capacity and nothing else", () => {
    expect(METERED_CAPABILITIES).toEqual(["cloud_vision", "live_view"])
    for (const capability of METERED_CAPABILITIES) expect(isMeteredCapability(capability)).toBe(true)
    for (const capability of ["clipboard", "input_freeze", "subagents", "remote_shell"] as const) {
      expect(`${capability} -> ${isMeteredCapability(capability)}`).toBe(`${capability} -> false`)
    }
  })

  test("the behaviours that must work on every tier are named, so the claim is checkable", () => {
    expect(ALWAYS_ON_RELIABILITY).toEqual([
      "honest-verification",
      "ref-resolution",
      "aim-computation",
      "stale-ref-refusal",
      "center-guess-warning",
    ])
    // None of them is a capability the gate could be asked about.
    const metered = new Set<string>(METERED_CAPABILITIES)
    for (const behaviour of ALWAYS_ON_RELIABILITY) expect(metered.has(behaviour)).toBe(false)
  })

  test("a capability outside the metered set is refused as a call-site bug, and never asked about", async () => {
    const permissive = permissiveGate()
    // Every capability the plan matrix knows about that is NOT metered capacity.
    const unmetered = (Object.keys(PLANS.free.capabilities) as Capability[]).filter(
      (capability) => !isMeteredCapability(capability),
    )
    expect(unmetered.length).toBeGreaterThan(0)
    for (const capability of unmetered) {
      const thrown = await permissive.gate.check(capability).catch((error: unknown) => error)
      expect(isUnmeteredCapabilityError(thrown)).toBe(true)
      expect((thrown as { capability: Capability }).capability).toBe(capability)
      const authorized = await permissive.gate.authorize(capability).catch((error: unknown) => error)
      expect(isUnmeteredCapabilityError(authorized)).toBe(true)
    }
    // Nothing was put to the control plane, so the outage cache is untouched too.
    expect(permissive.asked()).toBe(0)
  })

  test("the safety and interoperability basics the free plan already grants cannot be metered", async () => {
    // Input freeze, the clipboard, local and remote control and subagents are
    // unlimited on free because charging for them made the free tier hostile.
    // A future plan-matrix edit must not be able to turn any of them into a
    // refusal here, which is what a metered-capability call site would do.
    const basics = (Object.keys(PLANS.free.capabilities) as Capability[])
      .filter(
        (capability) =>
          PLANS.free.capabilities[capability].metering === "soft" &&
          PLANS.free.capabilities[capability].limit === Number.POSITIVE_INFINITY,
      )
      .sort()
    expect(basics).toEqual(["clipboard", "input_freeze", "local_computer", "remote_computer", "subagents"])
    for (const capability of basics) expect(`${capability} meterable -> ${isMeteredCapability(capability)}`).toBe(`${capability} meterable -> false`)
  })

  test("metered capacity still refuses on free, by name, with the paid path named", async () => {
    // The other half of the same rule: what IS metered is still metered, so the
    // gate is not simply inert. A free refusal is typed and specific.
    const harness = gate((call) => refusal(call.capability as Capability))
    const cloud = await harness.gate.check("cloud_vision")
    expect(cloud.allowed).toBe(false)
    expect(cloud.code).toBe("not_entitled")
    expect(cloud.plan).toBe("free")
    const error = await harness.gate.authorize("live_view").catch((error: unknown) => error)
    expect(isEntitlementRefusedError(error)).toBe(true)
    expect((error as EntitlementRefusedError).capability).toBe("live_view")
  })
})