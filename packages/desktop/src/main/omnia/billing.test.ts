import { plugin } from "bun"
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test"

// billing.ts reaches Electron through ipcMain. Substitute that narrow surface
// and capture the handlers so the IPC layer can be driven the way the renderer
// would. The signed-in session is stubbed per test instead of read off disk:
// another test file in this directory loads the real auth-session module first,
// and every module in the process then shares the Electron instance it saw.
const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()

const fakeElectron = {
  app: { getPath: () => "", isPackaged: false, on: () => undefined, once: () => undefined },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    },
  },
}

plugin({
  name: "omnia-billing-electron",
  setup(build) {
    build.module("electron", () => ({ exports: { ...fakeElectron, default: fakeElectron }, loader: "object" }))
  },
})

const controlPlane = "https://control.example/omnia"
let session: { url: string; clientToken: string } | undefined
let profileId: string | undefined

mock.module("./remote-agent", () => ({ readControlPlaneUrl: () => controlPlane }))
mock.module("./auth-session", () => ({
  readAuthSession: () => session,
  readSessionProfileId: () => profileId,
}))

const billing = await import("./billing")
billing.registerBillingIpcHandlers()

type CapturedRequest = { url: string; method: string; headers: Headers; body: Record<string, unknown> }
const requests: CapturedRequest[] = []
let responses: Response[] = []
let failure: Error | undefined
const originalFetch = globalThis.fetch

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

beforeEach(() => {
  requests.length = 0
  responses = []
  failure = undefined
  session = { url: controlPlane, clientToken: "client-token" }
  profileId = "7"
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : {},
    })
    if (failure) throw failure
    return responses.shift() ?? jsonResponse({ ok: true })
  }) as unknown as typeof fetch
})

afterAll(() => {
  globalThis.fetch = originalFetch
  mock.restore()
})

describe("billing routes", () => {
  test("reads the entitlement over the signed-in control-plane session", async () => {
    responses = [
      jsonResponse({
        ok: true,
        plan: "pro",
        computers: 5,
        billingConfigured: true,
        capabilities: { input_freeze: { allowed: true, code: "granted", used: 2, limit: 99 } },
      }),
    ]

    expect(await billing.readBillingEntitlement()).toEqual({
      plan: "pro",
      computers: 5,
      billingConfigured: true,
      monthlyUsd: 0,
      capabilities: { input_freeze: { allowed: true, code: "granted", used: 2, limit: 99 } },
    })
    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe(`${controlPlane}/v1/billing/entitlement`)
    expect(requests[0].method).toBe("GET")
    expect(requests[0].headers.get("authorization")).toBe("Bearer client-token")
    // Entitlements are keyed by profile and the token does not carry one.
    expect(requests[0].headers.get("x-omnia-profile")).toBe("7")
  })

  test("starts a checkout for the requested plan and returns its URL", async () => {
    responses = [jsonResponse({ ok: true, url: "https://checkout.stripe.com/c/pay/pro" })]
    expect(await billing.startBillingCheckout("pro")).toBe("https://checkout.stripe.com/c/pay/pro")
    expect(requests[0].url).toBe(`${controlPlane}/v1/billing/checkout`)
    expect(requests[0].method).toBe("POST")
    expect(requests[0].body).toEqual({ plan: "pro" })
    expect(requests[0].headers.get("x-omnia-profile")).toBe("7")

    responses = [jsonResponse({ ok: true, url: "https://billing.stripe.com/p/session" })]
    expect(await billing.startBillingPortal()).toBe("https://billing.stripe.com/p/session")
    expect(requests[1].url).toBe(`${controlPlane}/v1/billing/portal`)
    expect(requests[1].method).toBe("POST")
  })

  test("reads a metered check as an answer, including a refusal", async () => {
    responses = [
      jsonResponse({ ok: false, allowed: false, code: "not_entitled", reason: "clipboard is not included" }, 402),
    ]

    const refused = await billing.checkBillingCapability("clipboard")
    expect(refused.allowed).toBe(false)
    expect(refused.code).toBe("not_entitled")
    expect(refused.plan).toBe("free")
    expect(refused.reason).toBe("clipboard is not included")
    expect(requests[0].url).toBe(`${controlPlane}/v1/billing/check`)
    expect(requests[0].body).toEqual({ capability: "clipboard" })
  })

  test("falls back to the free plan rather than inventing one the server did not send", async () => {
    responses = [jsonResponse({ ok: true, plan: "platinum", computers: 3, billingConfigured: true, capabilities: {} })]
    expect((await billing.readBillingEntitlement()).plan).toBe("free")
  })
})

describe("billing failures", () => {
  test("surfaces a refused checkout as the server's own sentence", async () => {
    responses = [jsonResponse({ ok: false, error: "Billing is not configured on this server." }, 503)]

    // The refusal is the answer, not an exception the caller has to interpret:
    // it must read as a sentence rather than as the raw JSON body.
    await expect(billing.startBillingCheckout("business")).rejects.toThrow("Billing is not configured on this server.")
  })

  test("reports a checkout that comes back without a URL", async () => {
    responses = [jsonResponse({ ok: true })]
    await expect(billing.startBillingCheckout("pro")).rejects.toThrow("did not return a checkout URL")
  })

  test("asks for no session before the user signs in", async () => {
    session = undefined
    await expect(billing.readBillingEntitlement()).rejects.toThrow("Sign in")
    expect(requests).toHaveLength(0)
  })
})

describe("account state", () => {
  test("reports billing being unconfigured instead of swallowing it", async () => {
    responses = [jsonResponse({ ok: true, plan: "free", computers: 3, billingConfigured: false, capabilities: {} })]

    expect(await billing.readBillingAccount()).toEqual({
      plan: "free",
      billingConfigured: false,
      notice: "unconfigured",
    })
  })

  test("reports a configured account with its real plan", async () => {
    responses = [jsonResponse({ ok: true, plan: "business", computers: 99, billingConfigured: true, capabilities: {} })]

    expect(await billing.readBillingAccount()).toEqual({
      plan: "business",
      billingConfigured: true,
      notice: undefined,
    })
  })

  test("reports signed out without asking the server", async () => {
    session = undefined
    expect(await billing.readBillingAccount()).toEqual({
      plan: undefined,
      billingConfigured: false,
      notice: "signed_out",
    })
    expect(requests).toHaveLength(0)
  })

  test("treats a rejected profile as signed out and a dead server as unreachable", async () => {
    responses = [jsonResponse({ ok: false, error: "Sign in to see your plan." }, 401)]
    expect((await billing.readBillingAccount()).notice).toBe("signed_out")

    responses = []
    failure = new TypeError("fetch failed")
    expect(await billing.readBillingAccount()).toEqual({
      plan: undefined,
      billingConfigured: false,
      notice: "unreachable",
    })
  })
})

describe("account gating", () => {
  const free = { plan: "free", billingConfigured: true, notice: undefined } as const
  const blocked = [
    { account: { plan: "free", billingConfigured: false, notice: "unconfigured" } },
    { account: { plan: undefined, billingConfigured: false, notice: "signed_out" } },
    { account: { plan: undefined, billingConfigured: false, notice: "unreachable" } },
  ] as const

  test("offers an upgrade only from a lower tier", () => {
    expect(billing.canUpgradeTo(free, "pro")).toBe(true)
    expect(billing.canUpgradeTo(free, "business")).toBe(true)
    expect(billing.canUpgradeTo({ ...free, plan: "pro" }, "pro")).toBe(false)
    expect(billing.canUpgradeTo({ ...free, plan: "pro" }, "business")).toBe(true)
    expect(billing.canUpgradeTo({ ...free, plan: "business" }, "business")).toBe(false)
    // Enterprise outranks the paid tiers without carrying a price.
    expect(billing.canUpgradeTo({ ...free, plan: "enterprise" }, "business")).toBe(false)
    expect(billing.canManageBilling({ ...free, plan: "enterprise" })).toBe(true)
  })

  test("withholds every action the server would refuse", () => {
    for (const entry of blocked) {
      expect(billing.canUpgradeTo(entry.account, "pro")).toBe(false)
      expect(billing.canUpgradeTo(entry.account, "business")).toBe(false)
      expect(billing.canManageBilling(entry.account)).toBe(false)
    }
  })
})

describe("billing IPC handlers", () => {
  test("serves the renderer over the control-plane session", async () => {
    responses = [jsonResponse({ ok: true, plan: "pro", computers: 5, billingConfigured: true, capabilities: {} })]
    expect(await handlers.get(billing.BILLING_CHANNELS.entitlement)!({})).toMatchObject({ plan: "pro" })

    responses = [jsonResponse({ ok: true, url: "https://checkout.stripe.com/c/pay/pro" })]
    expect(await handlers.get(billing.BILLING_CHANNELS.checkout)!({}, "pro")).toBe(
      "https://checkout.stripe.com/c/pay/pro",
    )
    expect(requests.at(-1)?.body).toEqual({ plan: "pro" })

    responses = [jsonResponse({ ok: true, url: "https://billing.stripe.com/p/session" })]
    expect(await handlers.get(billing.BILLING_CHANNELS.portal)!({})).toBe("https://billing.stripe.com/p/session")
  })

  test("rejects a capability or plan the server does not sell", async () => {
    await expect(handlers.get(billing.BILLING_CHANNELS.check)!({}, "teleport")).rejects.toThrow(
      "Unknown billing capability",
    )
    await expect(handlers.get(billing.BILLING_CHANNELS.checkout)!({}, "enterprise")).rejects.toThrow(
      "Choose the pro or business plan.",
    )
    expect(requests).toHaveLength(0)
  })
})
