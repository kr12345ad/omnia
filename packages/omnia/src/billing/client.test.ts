import { describe, expect, test } from "bun:test"
import {
  BILLING_MAX_TIMEOUT_MS,
  BILLING_TIMEOUT_MS,
  BillingClient,
  resolveBillingEndpoint,
} from "./client"

// The endpoint resolver is tested on its own because it is the function that
// sends a bearer to the wrong host: the desktop sidecar sets OMNIA_SERVER_URL and
// OMNIA_SERVER_TOKEN but no OMNIA_SERVER_PORT, and the gate used to POST to
// http://127.0.0.1 - port 80 - in cleartext to whatever answered there.
describe("endpoint resolution precedence", () => {
  test("OMNIA_SERVER_URL wins over everything", () => {
    expect(
      resolveBillingEndpoint({
        OMNIA_SERVER_URL: "https://control.example/omnia",
        OMNIA_PUBLIC_URL: "https://public.example",
        OMNIA_SERVER_HOST: "10.0.0.1",
        OMNIA_SERVER_PORT: "4311",
      }),
    ).toBe("https://control.example/omnia")
  })

  test("OMNIA_PUBLIC_URL is the fallback", () => {
    expect(
      resolveBillingEndpoint({ OMNIA_PUBLIC_URL: "https://public.example/omnia", OMNIA_SERVER_PORT: "4311" }),
    ).toBe("https://public.example/omnia")
  })

  test("an empty value is skipped, so an empty SERVER_URL still finds PUBLIC_URL", () => {
    expect(resolveBillingEndpoint({ OMNIA_SERVER_URL: "", OMNIA_PUBLIC_URL: "https://public.example" })).toBe(
      "https://public.example",
    )
    expect(resolveBillingEndpoint({ OMNIA_SERVER_URL: "   ", OMNIA_PUBLIC_URL: "https://public.example" })).toBe(
      "https://public.example",
    )
  })

  test("trailing slashes are stripped so path concatenation cannot produce //", () => {
    expect(resolveBillingEndpoint({ OMNIA_SERVER_URL: "https://control.example/omnia///" })).toBe(
      "https://control.example/omnia",
    )
  })

  test("a real host:port pair is honoured", () => {
    expect(resolveBillingEndpoint({ OMNIA_SERVER_HOST: "127.0.0.1", OMNIA_SERVER_PORT: "4311" })).toBe(
      "http://127.0.0.1:4311",
    )
  })

  test("a host alone is NOT port 80", () => {
    // This exact shape is what the desktop sidecar produces when PORT is unset.
    expect(resolveBillingEndpoint({ OMNIA_SERVER_HOST: "127.0.0.1" })).toBeUndefined()
    expect(resolveBillingEndpoint({})).toBeUndefined()
  })

  test("an unusable port is never silently rounded to a real one", () => {
    for (const port of ["", "eighty", "8080/tcp", "-1", "0", "65536", "99999", " 4311x"]) {
      expect(`${JSON.stringify(port)} -> ${String(resolveBillingEndpoint({ OMNIA_SERVER_PORT: port }))}`).toBe(
        `${JSON.stringify(port)} -> undefined`,
      )
    }
  })

  test("port 80 is honoured only when it was asked for explicitly", () => {
    expect(resolveBillingEndpoint({ OMNIA_SERVER_HOST: "example.com", OMNIA_SERVER_PORT: "80" })).toBe(
      "http://example.com:80",
    )
  })

  test("a value that is not a usable origin resolves to nothing rather than to a guess", () => {
    for (const value of ["not a url", "control.example/omnia", "ftp://control.example", "file:///etc/passwd"]) {
      expect(`${value} -> ${String(resolveBillingEndpoint({ OMNIA_SERVER_URL: value }))}`).toBe(`${value} -> undefined`)
    }
  })
})

// The client resolves nothing a caller hands it: an endpoint or a token passed at
// runtime is a way to aim the bearer at a host of the caller's choosing.
describe("unconfigured installs are inert", () => {
  const refused = () => Promise.reject(new Error("the network is down"))

  test("no token means inert, and nothing is asked", async () => {
    let calls = 0
    const client = new BillingClient({
      env: { OMNIA_SERVER_URL: "https://control.example" },
      http: (async () => {
        calls++
        return refused()
      }) as unknown as typeof fetch,
    })
    expect(client.configured).toBe(false)
    const answer = await client.check("vault_login")
    expect(answer.allowed).toBe(true)
    expect(answer.code).toBe("unconfigured")
    expect(answer.origin).toBe("unconfigured")
    expect(answer.planKnown).toBe(false)
    expect(calls).toBe(0)
  })

  test("a host with no port is inert rather than a request to port 80", async () => {
    let calls = 0
    const client = new BillingClient({
      env: { OMNIA_SERVER_TOKEN: "server-token", OMNIA_SERVER_HOST: "127.0.0.1" },
      http: (async () => {
        calls++
        return new Response("{}", { status: 200 })
      }) as unknown as typeof fetch,
    })
    expect(client.endpoint).toBeUndefined()
    expect(client.configured).toBe(false)
    expect((await client.check("vault_login")).code).toBe("unconfigured")
    expect(calls).toBe(0)
  })

  test("a broken endpoint is inert too, and nothing is guessed or asked", async () => {
    // "No usable endpoint" is inert by definition, however unusable: an install
    // with a typo in its port has no control plane to enforce against, and the
    // alternative - refusing - would break a product that never opted into
    // billing. What must never happen is a request to a guessed port.
    for (const env of [
      { OMNIA_SERVER_TOKEN: "server-token", OMNIA_SERVER_PORT: "eighty" },
      { OMNIA_SERVER_TOKEN: "server-token", OMNIA_SERVER_URL: "not a url" },
      { OMNIA_SERVER_TOKEN: "server-token", OMNIA_SERVER_URL: "ftp://control.example" },
    ]) {
      let calls = 0
      const client = new BillingClient({
        env,
        http: (async () => {
          calls++
          return new Response("{}", { status: 200 })
        }) as unknown as typeof fetch,
      })
      expect(client.configured).toBe(false)
      expect(client.endpoint).toBeUndefined()
      const answer = await client.check("vault_login")
      expect(`${JSON.stringify(env)} -> ${answer.code}`).toBe(`${JSON.stringify(env)} -> unconfigured`)
      expect(answer.allowed).toBe(true)
      expect(calls).toBe(0)
    }
  })
})

describe("402 is a decision and 5xx is a failure", () => {
  test("a 402 body is the control plane's own refusal", async () => {
    const client = new BillingClient({
      env: { OMNIA_SERVER_TOKEN: "server-token", OMNIA_SERVER_URL: "https://control.example" },
      http: reply({
        allowed: false,
        code: "not_entitled",
        capability: "vault_login",
        plan: "free",
        used: 0,
        limit: 0,
        metering: "hard",
        reason: "vault_login is not included in the free plan.",
      }, 402),
    })
    const answer = await client.check("vault_login")
    expect(answer.allowed).toBe(false)
    expect(answer.code).toBe("not_entitled")
    expect(answer.origin).toBe("control-plane")
    expect(answer.degraded).toBe(false)
    expect(answer.planKnown).toBe(true)
    // The server's sentence is carried through, so a refusal is explicable.
    expect(answer.reason).toBe("vault_login is not included in the free plan.")
  })

  test("a 200 body is the control plane's own grant", async () => {
    const client = new BillingClient({
      env: { OMNIA_SERVER_TOKEN: "server-token", OMNIA_SERVER_URL: "https://control.example" },
      http: reply({ allowed: true, code: "granted", capability: "cloud_vision", plan: "pro", used: 4, limit: 2_000 }),
    })
    const answer = await client.check("cloud_vision")
    expect(answer.allowed).toBe(true)
    expect(answer.code).toBe("granted")
    expect(answer.used).toBe(4)
    expect(answer.limit).toBe(2_000)
    expect(answer.plan).toBe("pro")
  })

  test("a 5xx is not a decision, on any capability", async () => {
    for (const status of [500, 502, 503]) {
      const client = new BillingClient({
        env: { OMNIA_SERVER_TOKEN: "server-token", OMNIA_SERVER_URL: "https://control.example" },
        http: reply({ allowed: false, code: "not_entitled", capability: "vault_login", reason: "nope" }, status),
      })
      const answer = await client.check("vault_login")
      expect(`HTTP ${status} -> ${answer.code}`).toBe(`HTTP ${status} -> unreachable`)
      expect(answer.degraded).toBe(true)
      expect(answer.origin).toBe("fail-closed")
      expect(answer.allowed).toBe(false)
    }
  })

  test("an unexpected non-402 status is a failure too, not a refusal", async () => {
    // A 401 from a revoked token must not be reported as "not included in your
    // plan": those need different responses from the customer.
    for (const status of [400, 401, 403, 404]) {
      const client = new BillingClient({
        env: { OMNIA_SERVER_TOKEN: "server-token", OMNIA_SERVER_URL: "https://control.example" },
        http: reply({ allowed: false, code: "not_entitled", capability: "vault_login" }, status),
      })
      const answer = await client.check("vault_login")
      expect(`HTTP ${status} -> ${answer.code}`).toBe(`HTTP ${status} -> unreachable`)
      expect(answer.degraded).toBe(true)
    }
  })

  test("a 402 with no readable decision is a failure, not an invented refusal", async () => {
    const client = new BillingClient({
      env: { OMNIA_SERVER_TOKEN: "server-token", OMNIA_SERVER_URL: "https://control.example" },
      http: reply("<html>pay up</html>", 402),
    })
    const answer = await client.check("vault_login")
    expect(answer.code).toBe("unreachable")
    expect(answer.degraded).toBe(true)
  })

  test("a control plane that reports its own unreadable store takes the policy, not its verdict", async () => {
    const client = new BillingClient({
      env: { OMNIA_SERVER_TOKEN: "server-token", OMNIA_SERVER_URL: "https://control.example" },
      http: reply({ allowed: false, code: "unknown", capability: "live_view", plan: "free" }, 402),
    })
    // live_view is SOFT on free: the policy lets it through rather than turning
    // the server's disk error into a refusal.
    const answer = await client.check("live_view")
    expect(answer.code).toBe("unreachable")
    expect(answer.origin).toBe("fail-open")
    expect(answer.allowed).toBe(true)
    expect(answer.plan).toBe("free")
  })
})

describe("the failure policy follows the current plan, not the free plan", () => {
  const broken = () =>
    Object.assign(async () => Promise.reject(new Error("connect ECONNREFUSED")), {
      preconnect: () => undefined,
    }) as unknown as typeof fetch

  test("a hard allowance is refused when billing is unreachable", async () => {
    // vault_login is HARD(3) on free: with unknown counters it cannot be
    // enforced, so serving it would turn an outage into unmetered usage.
    const client = new BillingClient({
      env: { OMNIA_SERVER_TOKEN: "server-token", OMNIA_SERVER_URL: "https://control.example" },
      http: broken(),
    })
    const answer = await client.check("vault_login")
    expect(answer.allowed).toBe(false)
    expect(answer.origin).toBe("fail-closed")
    expect(answer.metering).toBe("hard")
    expect(answer.limit).toBe(3)
    expect(answer.reason).toContain("could not be confirmed")
  })

  test("a soft allowance is allowed when billing is unreachable", async () => {
    // live_view is fair-use (SOFT(20)) and credential_vault is SOFT(1) on free.
    for (const capability of ["live_view", "credential_vault"] as const) {
      const client = new BillingClient({
        env: { OMNIA_SERVER_TOKEN: "server-token", OMNIA_SERVER_URL: "https://control.example" },
        http: broken(),
      })
      const answer = await client.check(capability)
      expect(`${capability} -> ${String(answer.allowed)}/${answer.origin}`).toBe(`${capability} -> true/fail-open`)
      expect(answer.code).toBe("unreachable")
    }
  })

  test("a capability that is not on free at all is refused, not allowed", async () => {
    const client = new BillingClient({
      env: { OMNIA_SERVER_TOKEN: "server-token", OMNIA_SERVER_URL: "https://control.example" },
      http: broken(),
    })
    expect((await client.check("cloud_vision")).allowed).toBe(false)
    expect((await client.check("remote_shell")).allowed).toBe(false)
  })

  test("a paid plan keeps its features through our own outage", async () => {
    // On pro, vault_login and cloud_vision are soft, so an unreadable store must
    // not silently strip a feature somebody has paid for.
    const client = new BillingClient({
      env: { OMNIA_SERVER_TOKEN: "server-token", OMNIA_SERVER_URL: "https://control.example" },
      http: broken(),
      plan: "pro",
    })
    const answer = await client.check("vault_login")
    expect(answer.allowed).toBe(true)
    expect(answer.plan).toBe("pro")
    expect(answer.origin).toBe("fail-open")
  })

  test("the plan the control plane last named is the one the policy uses", async () => {
    // The regression that mattered: a paying customer lost paid features because
    // the rule was evaluated against free. The client learns pro from the answer
    // it got, then applies the policy to pro when the next call fails.
    let healthy = true
    const http = Object.assign(
      async () => {
        if (!healthy) return Promise.reject(new Error("connect ECONNREFUSED"))
        return new Response(
          JSON.stringify({ allowed: true, code: "granted", capability: "cloud_vision", plan: "pro", used: 1, limit: 2_000 }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      },
      { preconnect: () => undefined },
    ) as unknown as typeof fetch
    const client = new BillingClient({
      env: { OMNIA_SERVER_TOKEN: "server-token", OMNIA_SERVER_URL: "https://control.example" },
      http,
    })
    expect(client.knownPlan()).toBe("free")
    expect((await client.check("cloud_vision")).plan).toBe("pro")
    expect(client.knownPlan()).toBe("pro")
    healthy = false
    // cloud_vision is NEVER on free, so a free-keyed policy would refuse this.
    const during = await client.check("cloud_vision")
    expect(during.allowed).toBe(true)
    expect(during.plan).toBe("pro")
    expect(during.planKnown).toBe(true)
  })

  test("a remembered plan can be fed in by wiring that already resolved it", async () => {
    const client = new BillingClient({
      env: { OMNIA_SERVER_TOKEN: "server-token", OMNIA_SERVER_URL: "https://control.example" },
      http: broken(),
    })
    client.rememberPlan("business")
    expect(client.knownPlan()).toBe("business")
    expect((await client.check("vault_login")).allowed).toBe(true)
  })

  test("a bogus plan id cannot widen the policy", async () => {
    const client = new BillingClient({
      env: { OMNIA_SERVER_TOKEN: "server-token", OMNIA_SERVER_URL: "https://control.example" },
      http: reply({ allowed: true, code: "granted", capability: "vault_login", plan: "platinum", metering: "soft" }, 200),
    })
    const answer = await client.check("vault_login")
    expect(answer.plan).toBe("free")
    expect(answer.planKnown).toBe(false)
    // ...and metering comes from the plan matrix, never from the reply.
    expect(answer.metering).toBe("hard")
    client.rememberPlan("platinum")
    expect(client.knownPlan()).toBe("free")
  })
})

describe("the answer must be about the capability that was asked about", () => {
  const asked = "cloud_vision"

  test("a granted answer about another capability is not accepted", async () => {
    const client = new BillingClient({
      env: { OMNIA_SERVER_TOKEN: "server-token", OMNIA_SERVER_URL: "https://control.example" },
      http: reply({ allowed: true, code: "granted", capability: "browser_automation", plan: "enterprise" }, 200),
    })
    const answer = await client.check(asked)
    expect(answer.allowed).toBe(false)
    expect(answer.degraded).toBe(true)
    // enterprise is not remembered from an answer that was never about this
    // capability, so it cannot soften the next failure either.
    expect(client.knownPlan()).toBe("free")
  })

  test("an answer with no capability at all is not accepted either", async () => {
    const client = new BillingClient({
      env: { OMNIA_SERVER_TOKEN: "server-token", OMNIA_SERVER_URL: "https://control.example" },
      http: reply({ allowed: true, code: "granted", plan: "enterprise" }, 200),
    })
    expect((await client.check(asked)).degraded).toBe(true)
  })

  test("a matching echo is accepted", async () => {
    const client = new BillingClient({
      env: { OMNIA_SERVER_TOKEN: "server-token", OMNIA_SERVER_URL: "https://control.example" },
      http: reply({ allowed: true, code: "granted", capability: asked, plan: "pro" }, 200),
    })
    const answer = await client.check(asked)
    expect(answer.allowed).toBe(true)
    expect(answer.degraded).toBe(false)
  })

  test("an unrecognized code is not accepted", async () => {
    const client = new BillingClient({
      env: { OMNIA_SERVER_TOKEN: "server-token", OMNIA_SERVER_URL: "https://control.example" },
      http: reply({ allowed: true, code: "probably_fine", capability: asked }, 200),
    })
    expect((await client.check(asked)).degraded).toBe(true)
  })
})

describe("every request is time-bound", () => {
  test("a transport that never answers cannot hang the caller", async () => {
    // Deliberately ignores AbortSignal: a deadline that is only signalled, not
    // enforced, is how a hung control plane becomes a hung user action.
    const client = new BillingClient({
      env: { OMNIA_SERVER_TOKEN: "server-token", OMNIA_SERVER_URL: "https://control.example" },
      http: (async () => new Promise<Response>(() => undefined)) as unknown as typeof fetch,
      timeoutMs: 40,
    })
    const started = Date.now()
    const answer = await client.check("vault_login")
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(answer.code).toBe("unreachable")
    expect(answer.allowed).toBe(false)
    expect(answer.reason).toContain("did not answer within 40ms")
  })

  test("a transport that rejects on abort takes the same path", async () => {
    const client = new BillingClient({
      env: { OMNIA_SERVER_TOKEN: "server-token", OMNIA_SERVER_URL: "https://control.example" },
      http: ((_url: string, init: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted.")))
        })) as unknown as typeof fetch,
      timeoutMs: 40,
    })
    const answer = await client.check("vault_login")
    expect(answer.code).toBe("unreachable")
    expect(answer.origin).toBe("fail-closed")
  })

  test("a soft capability survives a timeout", async () => {
    const client = new BillingClient({
      env: { OMNIA_SERVER_TOKEN: "server-token", OMNIA_SERVER_URL: "https://control.example" },
      http: (async () => new Promise<Response>(() => undefined)) as unknown as typeof fetch,
      timeoutMs: 40,
    })
    const answer = await client.check("live_view")
    expect(answer.allowed).toBe(true)
    expect(answer.origin).toBe("fail-open")
  })

  test("the default and the ceiling are both bounded", () => {
    expect(BILLING_TIMEOUT_MS).toBeLessThanOrEqual(BILLING_MAX_TIMEOUT_MS)
    expect(BILLING_MAX_TIMEOUT_MS).toBeLessThan(Number.POSITIVE_INFINITY)
  })
})

describe("caching is opt-in and only ever caches a degraded answer", () => {
  const counted = (answers: Array<() => Promise<Response>>) => {
    let calls = 0
    const http = Object.assign(
      async () => {
        const next = answers[Math.min(calls, answers.length - 1)]
        calls++
        return next()
      },
      { preconnect: () => undefined },
    ) as unknown as typeof fetch
    return { http, calls: () => calls }
  }

  test("a real decision is never cached, so a burst of actions spends its own units", async () => {
    const { http, calls } = counted([
      () => grant("cloud_vision", "pro", 1),
      () => grant("cloud_vision", "pro", 2),
    ])
    const client = new BillingClient({
      env: { OMNIA_SERVER_TOKEN: "server-token", OMNIA_SERVER_URL: "https://control.example" },
      http,
      degradedTtlMs: 60_000,
    })
    expect((await client.check("cloud_vision")).used).toBe(1)
    expect((await client.check("cloud_vision")).used).toBe(2)
    expect(calls()).toBe(2)
  })

  test("a degraded answer is reused inside the window and dropped after it", async () => {
    const { http, calls } = counted([() => Promise.reject(new Error("down"))])
    let now = 1_000
    const client = new BillingClient({
      env: { OMNIA_SERVER_TOKEN: "server-token", OMNIA_SERVER_URL: "https://control.example" },
      http,
      degradedTtlMs: 5_000,
      now: () => now,
    })
    await client.check("vault_login")
    await client.check("vault_login")
    expect(calls()).toBe(1)
    now += 5_000
    await client.check("vault_login")
    expect(calls()).toBe(2)
    client.reset()
    await client.check("vault_login")
    expect(calls()).toBe(3)
  })

  test("the cache is off unless a gate asks for it", async () => {
    const { http, calls } = counted([() => Promise.reject(new Error("down"))])
    const client = new BillingClient({
      env: { OMNIA_SERVER_TOKEN: "server-token", OMNIA_SERVER_URL: "https://control.example" },
      http,
    })
    await client.check("vault_login")
    await client.check("vault_login")
    expect(calls()).toBe(2)
  })
})

describe("nothing secret is logged, sent in a body, or put in a reason", () => {
  test("the bearer appears only in the authorization header", async () => {
    const seen: { url: string; init: RequestInit }[] = []
    const client = new BillingClient({
      env: { OMNIA_SERVER_TOKEN: "super-secret-token", OMNIA_SERVER_URL: "https://control.example" },
      profileId: "230746284",
      http: (async (url: string, init: RequestInit) => {
        seen.push({ url, init })
        return new Response(
          JSON.stringify({ allowed: false, code: "not_entitled", capability: "vault_login", plan: "free", reason: "nope" }),
          { status: 402, headers: { "content-type": "application/json" } },
        )
      }) as unknown as typeof fetch,
    })
    const answer = await client.check("vault_login")
    expect(seen).toHaveLength(1)
    expect(seen[0].url).toBe("https://control.example/v1/billing/check")
    expect(seen[0].init.method).toBe("POST")
    const headers = seen[0].init.headers as Record<string, string>
    expect(headers.authorization).toBe("Bearer super-secret-token")
    expect(headers["x-omnia-profile"]).toBe("230746284")
    // The body is the capability and the asking profile, and nothing else.
    expect(JSON.parse(String(seen[0].init.body))).toEqual({ capability: "vault_login", profileId: "230746284" })
    expect(answer.reason).toBe("nope")
  })

  test("a logged refusal names the capability and plan but never the token", async () => {
    const logged: string[] = []
    const client = new BillingClient({
      env: { OMNIA_SERVER_TOKEN: "super-secret-token", OMNIA_SERVER_URL: "https://control.example" },
      log: (message, meta) => logged.push(`${message} ${JSON.stringify(meta ?? {})}`),
      http: (async () => Promise.reject(new Error("down"))) as unknown as typeof fetch,
    })
    await client.check("vault_login")
    expect(logged.length).toBeGreaterThan(0)
    for (const line of logged) {
      expect(line.includes("super-secret-token")).toBe(false)
      expect(line.includes("control.example")).toBe(false)
    }
    expect(logged.some((line) => line.includes("vault_login"))).toBe(true)
  })

  test("a transport error's own text never reaches the user-visible reason", async () => {
    const client = new BillingClient({
      env: { OMNIA_SERVER_TOKEN: "super-secret-token", OMNIA_SERVER_URL: "https://control.example" },
      http: (async () => Promise.reject(new Error("connect ECONNREFUSED super-secret-token"))) as unknown as typeof fetch,
    })
    const answer = await client.check("vault_login")
    expect(answer.reason.includes("super-secret-token")).toBe(false)
    expect(answer.reason).toContain("could not be reached")
  })
})

describe("other billing routes share the transport without sharing the bearer", () => {
  test("a rejected credential is distinguishable from an unreadable one", async () => {
    for (const status of [401, 403]) {
      const client = new BillingClient({
        env: { OMNIA_SERVER_TOKEN: "server-token", OMNIA_SERVER_URL: "https://control.example" },
        http: reply({}, status),
      })
      expect(`HTTP ${status} -> ${(await client.read("/v1/computers")).status}`).toBe(`HTTP ${status} -> revoked`)
    }
    const server = new BillingClient({
      env: { OMNIA_SERVER_TOKEN: "server-token", OMNIA_SERVER_URL: "https://control.example" },
      http: reply({}, 500),
    })
    expect((await server.read("/v1/computers")).status).toBe("failed")
  })

  test("a readable body comes back as a record", async () => {
    const client = new BillingClient({
      env: { OMNIA_SERVER_TOKEN: "server-token", OMNIA_SERVER_URL: "https://control.example" },
      http: reply({ plan: "pro", computers: 5 }, 200),
    })
    const read = await client.read("/v1/billing/entitlement")
    expect(read.status).toBe("ok")
    expect(read.status === "ok" && read.body.plan).toBe("pro")
  })

  test("a path that is not a plain path cannot redirect the bearer", async () => {
    let calls = 0
    const client = new BillingClient({
      env: { OMNIA_SERVER_TOKEN: "server-token", OMNIA_SERVER_URL: "https://control.example" },
      http: (async () => {
        calls++
        return new Response("{}", { status: 200 })
      }) as unknown as typeof fetch,
    })
    for (const path of ["https://attacker.example/v1/billing/check", "//attacker.example/x", "../../etc/passwd"]) {
      expect(`${path} -> ${(await client.read(path)).status}`).toBe(`${path} -> failed`)
    }
    expect(calls).toBe(0)
  })

  test("no token means there is nothing to read", async () => {
    const client = new BillingClient({ env: { OMNIA_SERVER_URL: "https://control.example" } })
    expect((await client.read("/v1/computers")).status).toBe("unconfigured")
  })
})

function reply(body: unknown, status = 200): typeof fetch {
  return Object.assign(
    async () =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    { preconnect: () => undefined },
  ) as unknown as typeof fetch
}

function grant(capability: string, plan: string, used: number): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify({ allowed: true, code: "granted", capability, plan, used, limit: 2_000 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  )
}