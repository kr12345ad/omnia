import { describe, expect, test } from "bun:test"
import {
  REMOTE_SESSION_LIMIT_CODE,
  RemoteEntitlementGate,
  remoteSessionCeilingMinutes,
  remoteSessionLimit,
} from "./entitlement"

interface ControlPlane {
  readonly plan?: string
  readonly computers?: number
  readonly entitlementStatus?: number
}

function urlOf(input: URL | RequestInfo): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
}

function fakeFetch(plane: ControlPlane, seen: string[] = []): typeof fetch {
  const handler = async (input: URL | RequestInfo): Promise<Response> => {
    const url = urlOf(input)
    seen.push(url)
    if (url.endsWith("/v1/billing/entitlement")) {
      if (plane.entitlementStatus !== undefined) return new Response(JSON.stringify({ ok: false }), { status: plane.entitlementStatus })
      return new Response(JSON.stringify({ ok: true, plan: plane.plan }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    if (url.endsWith("/v1/computers")) {
      return new Response(
        JSON.stringify({ ok: true, computers: Array.from({ length: plane.computers ?? 0 }, (_, index) => ({ id: `c-${index}` })) }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }
    return new Response(JSON.stringify({ ok: false }), { status: 404 })
  }
  return Object.assign(handler, { preconnect: () => undefined })
}

function gate(overrides: Partial<ConstructorParameters<typeof RemoteEntitlementGate>[0]> = {}, http = fakeFetch({ plan: "free", computers: 0 })) {
  return new RemoteEntitlementGate({ endpoint: "http://127.0.0.1:4096", token: "token-1", profileId: "230746284", http, ...overrides })
}

describe("computer allowance", () => {
  test("refuses the fourth computer on free with a reason that names the allowance", async () => {
    const decision = await gate({}, fakeFetch({ plan: "free", computers: 3 })).authorizeComputer()
    expect(decision.allowed).toBe(false)
    expect(decision.code).toBe("computer_allowance_exceeded")
    expect(decision.plan).toBe("free")
    expect(decision.planKnown).toBe(true)
    expect(decision.allowance).toBe(3)
    expect(decision.registered).toBe(3)
    expect(decision.reason).toContain("already has 3 registered computers")
    expect(decision.reason).toContain("free plan allows 3")
  })

  test("allows a computer that still fits inside the free allowance", async () => {
    const decision = await gate({}, fakeFetch({ plan: "free", computers: 2 })).authorizeComputer()
    expect(decision.allowed).toBe(true)
    expect(decision.code).toBe("granted")
    expect(decision.registered).toBe(2)
  })

  test("counts the fifth computer as the limit on pro", async () => {
    const http = fakeFetch({ plan: "pro", computers: 5 })
    expect((await gate({}, http).authorizeComputer()).allowed).toBe(false)
    expect((await gate({}, fakeFetch({ plan: "pro", computers: 4 })).authorizeComputer()).allowed).toBe(true)
  })

  test("never refuses an unlimited plan, whatever is registered", async () => {
    const decision = await gate({}, fakeFetch({ plan: "business", computers: 25 })).authorizeComputer()
    expect(decision.allowed).toBe(true)
    expect(decision.allowance).toBe(Number.POSITIVE_INFINITY)
  })

  test("asks the control plane with its own credential and the signed-in profile", async () => {
    const requests: Array<{ url: string; headers: Headers }> = []
    const http = Object.assign(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        requests.push({ url: urlOf(input), headers: new Headers(init?.headers) })
        return fakeFetch({ plan: "free", computers: 0 })(input, init)
      },
      { preconnect: () => undefined },
    ) as typeof fetch
    await gate({}, http).authorizeComputer()
    expect(requests.map((request) => request.url).sort()).toEqual([
      "http://127.0.0.1:4096/v1/billing/entitlement",
      "http://127.0.0.1:4096/v1/computers",
    ])
    expect(requests[0].headers.get("authorization")).toBe("Bearer token-1")
    expect(requests[0].headers.get("x-omnia-profile")).toBe("230746284")
  })

  test("a wire with no credential enforces nothing and asks nothing", async () => {
    const seen: string[] = []
    const decision = await gate({ token: undefined }, fakeFetch({ plan: "business", computers: 9 }, seen)).authorizeComputer()
    expect(decision.allowed).toBe(true)
    expect(decision.code).toBe("unconfigured")
    expect(decision.origin).toBe("unconfigured")
    expect(seen).toEqual([])
  })

  test("fromEnv resolves the control plane and its credential from the environment", async () => {
    const seen: string[] = []
    const built = RemoteEntitlementGate.fromEnv({
      env: { OMNIA_SERVER_URL: "http://control.test:4096/", OMNIA_SERVER_TOKEN: "token-env" },
      profileId: "230746284",
      http: fakeFetch({ plan: "free", computers: 3 }, seen),
    })
    expect(built.configured).toBe(true)
    const decision = await built.authorizeComputer()
    expect(seen.sort()).toEqual(["http://control.test:4096/v1/billing/entitlement", "http://control.test:4096/v1/computers"])
    expect(decision.allowed).toBe(false)
  })

  test("fromEnv without a token leaves the wire unconfigured rather than guessing", () => {
    const built = RemoteEntitlementGate.fromEnv({ env: { OMNIA_SERVER_URL: "http://control.test:4096" } })
    expect(built.configured).toBe(false)
  })
})

describe("an unreachable control plane", () => {
  const unreachable = () =>
    Object.assign(
      async (input: URL | RequestInfo) => {
        if (urlOf(input).endsWith("/v1/billing/entitlement")) throw new Error("connect ECONNREFUSED")
        return fakeFetch({ computers: 3 })(input)
      },
      { preconnect: () => undefined },
    ) as typeof fetch

  test("fails open to the free allowance and refuses the fourth computer, never to unlimited", async () => {
    const decision = await gate({}, unreachable()).authorizeComputer()
    expect(decision.allowed).toBe(false)
    expect(decision.code).toBe("computer_allowance_exceeded")
    expect(decision.planKnown).toBe(false)
    expect(decision.plan).toBe("free")
    expect(decision.allowance).toBe(3)
    expect(decision.origin).toBe("fail-open")
    expect(decision.reason).toContain("The plan could not be confirmed")
  })

  test("still pairs the computers that fit inside the free allowance", async () => {
    const http = Object.assign(
      async (input: URL | RequestInfo) =>
        urlOf(input).endsWith("/v1/billing/entitlement")
          ? new Response(JSON.stringify({ ok: false }), { status: 503 })
          : fakeFetch({ computers: 2 })(input),
      { preconnect: () => undefined },
    ) as typeof fetch
    const decision = await gate({}, http).authorizeComputer()
    expect(decision.allowed).toBe(true)
    expect(decision.planKnown).toBe(false)
    expect(decision.origin).toBe("fail-open")
  })

  test("does not refuse on an unreadable count, and says so instead of reporting a clean pass", async () => {
    const http = Object.assign(
      async () => {
        throw new Error("connect ECONNREFUSED")
      },
      { preconnect: () => undefined },
    ) as typeof fetch
    const decision = await gate({}, http).authorizeComputer()
    expect(decision.allowed).toBe(true)
    expect(decision.code).toBe("unconfirmed")
    expect(decision.registered).toBeUndefined()
    expect(decision.reason).toContain("could not be read")
  })
})

describe("the remote session ceiling", () => {
  test("is 120 minutes on free and unbounded on the paid plans", () => {
    expect(remoteSessionCeilingMinutes("free")).toBe(120)
    expect(remoteSessionCeilingMinutes("pro")).toBeUndefined()
    expect(remoteSessionCeilingMinutes("business")).toBeUndefined()
    expect(remoteSessionCeilingMinutes("enterprise")).toBeUndefined()
  })

  test("a plan that could not be determined runs under the free ceiling", () => {
    expect(remoteSessionCeilingMinutes()).toBe(120)
  })

  test("a session inside the ceiling is not limited", () => {
    const startedAt = 1_000_000
    expect(remoteSessionLimit({ plan: "free", startedAt, now: startedAt + 119 * 60_000 + 59_999 })).toBeUndefined()
  })

  test("reaching the ceiling exactly ends the session with a resumable reason", () => {
    const startedAt = 1_000_000
    const limit = remoteSessionLimit({ plan: "free", startedAt, now: startedAt + 120 * 60_000 })
    expect(limit?.minutes).toBe(120)
    expect(limit?.reason).toContain("120 minute limit for the free plan")
    expect(limit?.reason).toContain("Reconnect to start a new session")
    expect(REMOTE_SESSION_LIMIT_CODE).toBe("session_limit_reached")
  })

  test("names the fallback when the plan was never confirmed", () => {
    const limit = remoteSessionLimit({ startedAt: 0, now: 120 * 60_000 })
    expect(limit?.reason).toContain("The plan could not be confirmed")
  })

  test("a paid plan is never limited", () => {
    expect(remoteSessionLimit({ plan: "pro", startedAt: 0, now: 60 * 60 * 60_000 })).toBeUndefined()
  })
})
