import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHmac } from "node:crypto"
import { startOmniaServer } from "./server"
import { readBillingState } from "../billing/store"

// Two silent paths charged real money and granted nothing, permanently:
//
//   1. metadata[profileId] was set on the Checkout SESSION. Stripe does not copy
//      session metadata onto the subscription, so the real event carried no
//      profile and was acknowledged with {ignored:true}.
//   2. With no billing file configured the webhook answered 200, which tells
//      Stripe to stop retrying, and threw the subscription away.
//
// These tests fail if either comes back.

const WEBHOOK = "whsec_test"
const PRICE_PRO = "price_pro_test"
const PRICE_BUSINESS = "price_business_test"

type Server = Awaited<ReturnType<typeof startOmniaServer>>
let dir = ""
let saved: Record<string, string | undefined> = {}
const realFetch = globalThis.fetch

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnia-money-"))
  saved = {
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    STRIPE_PRICE_PRO: process.env.STRIPE_PRICE_PRO,
    STRIPE_PRICE_BUSINESS: process.env.STRIPE_PRICE_BUSINESS,
    OMNIA_PUBLIC_URL: process.env.OMNIA_PUBLIC_URL,
    OMNIA_BILLING_FILE: process.env.OMNIA_BILLING_FILE,
  }
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK
  process.env.STRIPE_SECRET_KEY = "sk_test_fake"
  process.env.STRIPE_PRICE_PRO = PRICE_PRO
  process.env.STRIPE_PRICE_BUSINESS = PRICE_BUSINESS
  process.env.OMNIA_PUBLIC_URL = "https://example.test/omnia"
  process.env.OMNIA_BILLING_FILE = join(dir, "billing.json")
})

afterEach(() => {
  globalThis.fetch = realFetch
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // A leftover temp dir must never fail the run.
  }
})

async function withServer<T>(fn: (server: Server) => Promise<T>): Promise<T> {
  const server = await startOmniaServer({
    credentialsFile: join(dir, "credentials.json"),
    authFile: join(dir, "auth.json"),
    superskillFile: join(dir, "superskills.json"),
    memoryFile: join(dir, "memories.json"),
    computerUseFile: join(dir, "computer-use.json"),
  })
  try {
    return await fn(server)
  } finally {
    await server.stop()
  }
}

function sign(body: string): string {
  const t = Math.floor(Date.now() / 1000)
  return `t=${t},v1=${createHmac("sha256", WEBHOOK).update(`${t}.${body}`, "utf8").digest("hex")}`
}

async function deliver(server: Server, event: unknown) {
  const body = JSON.stringify(event)
  return fetch(`${server.url}/v1/billing/stripe/webhook`, {
    method: "POST",
    headers: { "stripe-signature": sign(body) },
    body,
  })
}

const subscription = (over: Record<string, unknown> = {}) => ({
  id: "sub_1",
  customer: "cus_1",
  status: "active",
  current_period_end: 2_000_000_000,
  price: { id: PRICE_PRO },
  metadata: { profileId: "230746284" },
  ...over,
})

/** Stubs only api.stripe.com and leaves every other host on the real fetch. */
function stubStripe(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    if (url.startsWith("https://api.stripe.com/")) return handler(url, init)
    return realFetch(input as RequestInfo, init)
  }) as typeof fetch
}

describe("a real purchase grants a real plan", () => {
  test("checkout puts the profile on the SUBSCRIPTION, not only the session", async () => {
    // Stripe does not copy session metadata onto the subscription, so this exact
    // field is the difference between a working product and silent nothing.
    let sent = ""
    let sentHeaders: Headers | undefined
    stubStripe(async (_url, init) => {
      sent = String(init.body ?? "")
      sentHeaders = new Headers(init.headers)
      return new Response(JSON.stringify({ url: "https://checkout.stripe.com/c/pay/cs_test_123" }), { status: 200 })
    })
    await withServer(async (server) => {
      const response = await fetch(`${server.url}/v1/billing/checkout`, {
        method: "POST",
        headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json", "x-omnia-profile": "230746284" },
        body: JSON.stringify({ plan: "pro" }),
      })
      expect(response.status).toBe(200)
      const decoded = new URLSearchParams(sent)
      expect(decoded.get("subscription_data[metadata][profileId]")).toBe("230746284")
      expect(decoded.get("line_items[0][price]")).toBe(PRICE_PRO)
      // And an idempotency key, so a double-clicked button cannot double-charge.
      expect(sentHeaders?.get("Idempotency-Key")).toBe(`omnia-checkout-pro-230746284`)
    })
  })

  test("the URL handed to the browser is Stripe's, or nothing", async () => {
    for (const [url, expected] of [
      ["https://checkout.stripe.com/c/pay/cs_1", 200],
      ["javascript:alert(1)", 502],
      ["https://evil.example/steal", 502],
      ["", 502],
    ] as const) {
      stubStripe(async () => new Response(JSON.stringify({ url }), { status: 200 }))
      await withServer(async (server) => {
        const response = await fetch(`${server.url}/v1/billing/checkout`, {
          method: "POST",
          headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json", "x-omnia-profile": "230746284" },
          body: JSON.stringify({ plan: "pro" }),
        })
        expect(`${url || "(empty)"} -> ${response.status}`).toBe(`${url || "(empty)"} -> ${expected}`)
      })
    }
  })

  test("a Stripe outage reads as 502, not a 500 with a stack", async () => {
    stubStripe(() => {
      throw new Error("ECONNREFUSED")
    })
    await withServer(async (server) => {
      const response = await fetch(`${server.url}/v1/billing/checkout`, {
        method: "POST",
        headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json", "x-omnia-profile": "230746284" },
        body: JSON.stringify({ plan: "pro" }),
      })
      expect(response.status).toBe(502)
    })
  })

  test("the signed-in desktop reaches checkout and the portal; an agent token does not", async () => {
    await withServer(async (server) => {
      const desktop = server.auth.mintDesktopToken({ id: 11, login: "desktop-user" })!
      const agent = server.auth.mintClientToken({ id: 12, login: "agent" })!
      const headers = (token: string) => ({
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-omnia-profile": "230746284",
      })
      // The test key is fake, so Stripe itself refuses checkout with 502 - and the
      // test profile has no subscription, so the portal answers 404. Both mean
      // "past the credential check", which is what this pins: a credential
      // failure would be 401/403 instead.
      const checkout = await fetch(`${server.url}/v1/billing/checkout`, {
        method: "POST",
        headers: headers(desktop),
        body: JSON.stringify({ plan: "pro" }),
      })
      expect(`checkout desktop -> ${checkout.status}`).toBe("checkout desktop -> 502")
      const portal = await fetch(`${server.url}/v1/billing/portal`, {
        method: "POST",
        headers: headers(desktop),
        body: "{}",
      })
      expect(`portal desktop -> ${portal.status}`).toBe("portal desktop -> 404")
      for (const path of ["/v1/billing/checkout", "/v1/billing/portal"]) {
        const body = path.endsWith("checkout") ? JSON.stringify({ plan: "pro" }) : "{}"
        const denied = await fetch(`${server.url}${path}`, { method: "POST", headers: headers(agent), body })
        expect(`${path} agent -> ${denied.status}`).toBe(`${path} agent -> 403`)
      }
    })
  })

  test("a thin client token cannot open the billing portal", async () => {
    stubStripe(async () => new Response(JSON.stringify({ url: "https://billing.stripe.com/p/session_test" }), { status: 200 }))
    await withServer(async (server) => {
      const body = JSON.stringify({
        subscriptions: [{ customerId: "cus_1", subscriptionId: "sub_1", status: "active", plan: "pro", profileId: "230746284", currentPeriodEnd: 2_000_000_000 }],
      })
      writeFileSync(process.env.OMNIA_BILLING_FILE!, JSON.stringify(body), { mode: 0o600 })
      // A client token satisfies isAuthorized, so before this the portal URL for
      // the operator's customer was reachable by any paired device.
      const thin = server.auth.mintClientToken({ id: 9, login: "thin" })!
      const response = await fetch(`${server.url}/v1/billing/portal`, {
        method: "POST",
        headers: { authorization: `Bearer ${thin}`, "content-type": "application/json", "x-omnia-profile": "230746284" },
        body: "{}",
      })
      expect(response.status).toBe(403)
    })
  })

  test("identical pro and business prices grant nothing rather than the wrong plan", async () => {
    process.env.STRIPE_PRICE_BUSINESS = PRICE_PRO
    await withServer(async (server) => {
      const response = await deliver(server, {
        id: "evt_collision",
        type: "customer.subscription.updated",
        created: 0,
        data: { object: subscription() },
      })
      expect(response.status).toBe(200)
      expect((await response.json()).ignored).toBe(true)
      expect(readBillingState(process.env.OMNIA_BILLING_FILE).subscriptions).toHaveLength(0)
    })
  })
})

describe("money is never taken and then dropped", () => {
  test("with no billing storage the webhook REFUSES so Stripe keeps retrying", async () => {
    delete process.env.OMNIA_BILLING_FILE
    delete process.env.OMNIA_DATA_DIR
    await withServer(async (server) => {
      const response = await deliver(server, {
        id: "evt_no_storage",
        type: "customer.subscription.updated",
        created: 0,
        data: { object: subscription() },
      })
      // 200 here would tell Stripe to stop delivering, and the customer would be
      // charged forever with nothing granted and no alarm anywhere.
      expect(response.status).toBe(503)
      expect((await response.json()).ok).toBe(false)
    })
  })

  test("a corrupt state file fails CLOSED and is never overwritten", async () => {
    const file = join(dir, "billing.json")
    writeFileSync(file, "{ truncated", { mode: 0o600 })
    await withServer(async (server) => {
      const headers = { authorization: `Bearer ${server.token}`, "content-type": "application/json", "x-omnia-profile": "230746284" }
      // A hard-metered capability must be refused as "unknown", never silently
      // answered as if the customer were on the free plan.
      const check = await fetch(`${server.url}/v1/billing/check`, {
        method: "POST",
        headers,
        body: JSON.stringify({ capability: "vault_login" }),
      })
      expect(check.status).toBe(402)
      expect((await check.json()).code).toBe("unknown")
      // The quarantined bytes must still be on disk: a usage write must never
      // replace unreadable state with an empty store.
      expect(readBillingState(file)).toEqual({ subscriptions: [], usage: {}, processedEvents: [] })
    })
  })

  test("the end-to-end path: pay, deliver the real event, get the features", async () => {
    await withServer(async (server) => {
      // 1. Checkout succeeds.
      stubStripe(async () => new Response(JSON.stringify({ url: "https://checkout.stripe.com/c/pay/cs_test" }), { status: 200 }))
      const checkout = await fetch(`${server.url}/v1/billing/checkout`, {
        method: "POST",
        headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json", "x-omnia-profile": "230746284" },
        body: JSON.stringify({ plan: "pro" }),
      })
      expect(checkout.status).toBe(200)

      // 2. Stripe delivers the subscription, with the metadata checkout set.
      globalThis.fetch = realFetch
      const delivered = await deliver(server, {
        id: "evt_real",
        type: "customer.subscription.updated",
        created: 0,
        data: { object: subscription({ metadata: { profileId: "230746284" } }) },
      })
      expect((await delivered.json()).ignored).toBeUndefined()

      // 3. The customer now has the paid capability.
      const check = await fetch(`${server.url}/v1/billing/check`, {
        method: "POST",
        headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json", "x-omnia-profile": "230746284" },
        body: JSON.stringify({ capability: "remote_shell" }),
      })
      expect(check.status).toBe(200)
      expect((await check.json()).plan).toBe("pro")
    })
  })
})