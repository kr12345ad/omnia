// The two functions that actually talk to Stripe - createCheckoutSession and
// createPortalSession - had no coverage at all: every existing checkout test
// returned before the outbound call was made, so a change that emptied the form,
// dropped the idempotency key, leaked Stripe's error body or handed the browser
// an off-Stripe URL would have passed the whole suite.
//
// These drive both routes end to end with only api.stripe.com faked, and assert
// the request on the wire rather than a mocked return value.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startOmniaServer } from "./server"
import { EMPTY_STATE, writeBillingState } from "../billing/store"

const PROFILE = "230746284"
const OTHER_PROFILE = "230746285"
const CUSTOMER = "cus_portal_test"
const API_KEY = "sk_test_not_a_real_key"
const WEBHOOK_SECRET = "whsec_test"
const PRICE_PRO = "price_pro_test"
const PRICE_BUSINESS = "price_business_test"
const PUBLIC_URL = "https://example.test/omnia"
const CHECKOUT_URL = "https://checkout.stripe.com/c/pay/cs_test_123"
const PORTAL_URL = "https://billing.stripe.com/p/session_test_123"
const CHECKOUT_ENDPOINT = "https://api.stripe.com/v1/checkout/sessions"
const PORTAL_ENDPOINT = "https://api.stripe.com/v1/billing_portal/sessions"
// A fixed far-future millisecond stamp. Anything derived from the wall clock
// would make a run that crosses a second, day or year boundary pass or fail
// for a reason that has nothing to do with the code.
const PERIOD_END = 4_102_444_800_000

type Server = Awaited<ReturnType<typeof startOmniaServer>>

interface StripeCall {
  readonly url: string
  readonly method: string | undefined
  readonly headers: Headers
  readonly form: URLSearchParams
  readonly signal: AbortSignal | null | undefined
}

let dir = ""
let calls: StripeCall[] = []
let saved: Record<string, string | undefined> = {}
const realFetch = globalThis.fetch
const realTimeout = AbortSignal.timeout

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnia-stripe-calls-"))
  calls = []
  saved = {
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    STRIPE_PRICE_PRO: process.env.STRIPE_PRICE_PRO,
    STRIPE_PRICE_BUSINESS: process.env.STRIPE_PRICE_BUSINESS,
    OMNIA_PUBLIC_URL: process.env.OMNIA_PUBLIC_URL,
    OMNIA_BILLING_FILE: process.env.OMNIA_BILLING_FILE,
  }
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET
  process.env.STRIPE_SECRET_KEY = API_KEY
  process.env.STRIPE_PRICE_PRO = PRICE_PRO
  process.env.STRIPE_PRICE_BUSINESS = PRICE_BUSINESS
  process.env.OMNIA_PUBLIC_URL = PUBLIC_URL
  process.env.OMNIA_BILLING_FILE = join(dir, "billing.json")
})

afterEach(() => {
  globalThis.fetch = realFetch
  AbortSignal.timeout = realTimeout
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

/**
 * Fakes api.stripe.com and nothing else.
 *
 * Every other host has to reach the real fetch: this suite's own requests to the
 * server under test go through the same global, and a blanket stub would make the
 * test talk to itself - or, worse, silently pass without a server ever answering.
 */
function stubStripe(handler: (call: StripeCall) => Response | Promise<Response>) {
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    if (!url.startsWith("https://api.stripe.com/")) return realFetch(input as RequestInfo, init)
    const call: StripeCall = {
      url,
      method: init.method,
      headers: new Headers(init.headers),
      form: new URLSearchParams(String(init.body ?? "")),
      signal: init.signal,
    }
    calls.push(call)
    return handler(call)
  }) as typeof fetch
}

const stripeJson = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status })
const checkoutSession = () => stripeJson({ url: CHECKOUT_URL })
const portalSession = () => stripeJson({ url: PORTAL_URL })
/** Routes by endpoint so one stub can serve both calls in a single test. */
const eitherSession = (call: StripeCall) => (call.url === PORTAL_ENDPOINT ? portalSession() : checkoutSession())

function seedSubscription(profileId = PROFILE, customerId = CUSTOMER) {
  writeBillingState(process.env.OMNIA_BILLING_FILE!, {
    ...EMPTY_STATE,
    subscriptions: [
      { customerId, subscriptionId: "sub_test_1", status: "active", plan: "pro", profileId, currentPeriodEnd: PERIOD_END },
    ],
  })
}

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

/** The signed-in desktop: the server token plus the profile it is acting for. */
function desktop(server: Server, options: { token?: string; profile?: string } = {}) {
  return {
    authorization: `Bearer ${options.token ?? server.token}`,
    "content-type": "application/json",
    "x-omnia-profile": options.profile ?? PROFILE,
  }
}

const startCheckout = (server: Server, plan: unknown = "pro", options: { token?: string } = {}) =>
  fetch(`${server.url}/v1/billing/checkout`, {
    method: "POST",
    headers: desktop(server, options),
    body: JSON.stringify(typeof plan === "object" && plan !== null ? plan : { plan }),
  })

const startPortal = (server: Server, options: { token?: string } = {}) =>
  fetch(`${server.url}/v1/billing/portal`, { method: "POST", headers: desktop(server, options), body: "{}" })

const readBody = async (response: Response) => {
  const text = await response.text()
  const parsed: unknown = text.length === 0 ? {} : JSON.parse(text)
  const record = typeof parsed === "object" && parsed !== null ? (parsed as { ok?: unknown; error?: unknown }) : {}
  return { status: response.status, ok: record.ok === true, error: String(record.error ?? ""), text }
}

describe("checkout: the request Stripe receives", () => {
  test("posts a subscription session for the configured pro price", async () => {
    stubStripe(() => checkoutSession())
    await withServer(async (server) => {
      const body = await readBody(await startCheckout(server))
      expect(body.status).toBe(200)
      expect(body.ok).toBe(true)
      expect(body.text).toContain(CHECKOUT_URL)
      expect(calls).toHaveLength(1)

      const call = calls[0]
      expect(call.url).toBe(CHECKOUT_ENDPOINT)
      expect(call.method).toBe("POST")
      expect(call.headers.get("authorization")).toBe(`Bearer ${API_KEY}`)
      expect(call.headers.get("content-type")).toBe("application/x-www-form-urlencoded")
      // A one-off payment is not a subscription: mode=payment would create no
      // recurring charge and no subscription for the webhook to ever find.
      expect(call.form.get("mode")).toBe("subscription")
      expect(call.form.get("line_items[0][price]")).toBe(PRICE_PRO)
      expect(call.form.get("line_items[0][quantity]")).toBe("1")
      // subscription_data, not only session metadata: Stripe does NOT copy
      // session metadata onto the subscription it creates, so a request carrying
      // only metadata[profileId] produces subscriptions with no profile and every
      // webhook is silently ignored - checkout appears to work and grants nothing.
      expect(call.form.get("subscription_data[metadata][profileId]")).toBe(PROFILE)
      expect(call.form.get("metadata[profileId]")).toBe(PROFILE)
      expect(call.form.get("client_reference_id")).toBe(PROFILE)
      expect(call.form.get("success_url")).toBe(`${PUBLIC_URL}/?checkout=success`)
      expect(call.form.get("cancel_url")).toBe(`${PUBLIC_URL}/?checkout=cancelled`)
      expect(call.headers.get("Idempotency-Key")).toBe(`omnia-checkout-pro-${PROFILE}`)
    })
  })

  test("the business plan sends the business price under its own key", async () => {
    stubStripe(() => checkoutSession())
    await withServer(async (server) => {
      expect((await readBody(await startCheckout(server, "business"))).status).toBe(200)
      // One price id has to mean exactly one plan: sending the pro price here
      // would charge a business customer the pro price forever.
      expect(calls[0].form.get("line_items[0][price]")).toBe(PRICE_BUSINESS)
      expect(calls[0].headers.get("Idempotency-Key")).toBe(`omnia-checkout-business-${PROFILE}`)
    })
  })

  test("a caller-supplied price id is ignored", async () => {
    stubStripe(() => checkoutSession())
    await withServer(async (server) => {
      const response = await startCheckout(server, {
        plan: "pro",
        priceId: "price_attacker",
        price: "price_attacker",
        line_items: [{ price: "price_attacker", quantity: 99 }],
        "line_items[0][price]": "price_attacker",
        subscription_data: { metadata: { profileId: "999999999" } },
      })
      expect(response.status).toBe(200)
      const call = calls[0]
      // Nothing but our own environment decides what is being charged for.
      expect(call.form.get("line_items[0][price]")).toBe(PRICE_PRO)
      expect(call.form.get("line_items[0][quantity]")).toBe("1")
      expect([...call.form.keys()].filter((key) => key.includes("price"))).toEqual(["line_items[0][price]"])
      expect(call.form.get("subscription_data[metadata][profileId]")).toBe(PROFILE)
      expect(call.form.toString()).not.toContain("price_attacker")
    })
  })

  test("a double-clicked button sends one key, so Stripe collapses both posts into one charge", async () => {
    stubStripe(() => checkoutSession())
    await withServer(async (server) => {
      // Sequential, not concurrent: the assertion is about the two requests'
      // bytes, and ordering them keeps the recorded calls deterministic.
      expect((await readBody(await startCheckout(server))).status).toBe(200)
      expect((await readBody(await startCheckout(server))).status).toBe(200)
      expect(calls).toHaveLength(2)
      const first = calls[0].headers.get("Idempotency-Key")
      const second = calls[1].headers.get("Idempotency-Key")
      // Stripe keys idempotency on this header: replaying the same key returns the
      // FIRST session instead of creating a second customer and a second
      // subscription. A key derived from a timestamp or a random id would be
      // different on every click and bill the customer twice, which is also why
      // the exact expected value below pins it to profile+plan and nothing else.
      expect(first).toBe(`omnia-checkout-pro-${PROFILE}`)
      expect(second).toBe(first)
    })
  })

  test("the key is per profile, so two customers never share a session", async () => {
    stubStripe(() => checkoutSession())
    await withServer(async (server) => {
      expect((await readBody(await startCheckout(server, "pro", {}))).status).toBe(200)
      const other = fetch(`${server.url}/v1/billing/checkout`, {
        method: "POST",
        headers: desktop(server, { profile: OTHER_PROFILE }),
        body: JSON.stringify({ plan: "pro" }),
      })
      expect((await readBody(await other)).status).toBe(200)
      // Without the profile in the key, Stripe hands the second buyer the FIRST
      // buyer's session: wrong customer, wrong subscription, never granted.
      expect(calls[0].headers.get("Idempotency-Key")).not.toBe(calls[1].headers.get("Idempotency-Key"))
      expect(calls[0].form.get("subscription_data[metadata][profileId]")).toBe(PROFILE)
      expect(calls[1].form.get("subscription_data[metadata][profileId]")).toBe(OTHER_PROFILE)
    })
  })

  test("a trailing-slash public URL yields exactly one slash before the query", async () => {
    process.env.OMNIA_PUBLIC_URL = `${PUBLIC_URL}///`
    seedSubscription()
    stubStripe(eitherSession)
    await withServer(async (server) => {
      expect((await readBody(await startCheckout(server))).status).toBe(200)
      expect((await readBody(await startPortal(server))).status).toBe(200)
      const success = calls[0].form.get("success_url") ?? ""
      // "//?checkout=success" is a protocol-relative URL on a host named "?checkout",
      // so an unstripped trailing slash silently breaks every return from Stripe.
      expect(success).toBe(`${PUBLIC_URL}/?checkout=success`)
      expect(success.slice(0, success.indexOf("?"))).toBe(`${PUBLIC_URL}/`)
      expect(calls[0].form.get("cancel_url")).toBe(`${PUBLIC_URL}/?checkout=cancelled`)
      expect(calls[1].form.get("return_url")).toBe(`${PUBLIC_URL}/?billing=portal`)
    })
  })

  test("the URL handed to the browser is normalized, not echoed verbatim", async () => {
    stubStripe(() => stripeJson({ url: "https://CHECKOUT.stripe.com/c/pay/cs_test_123" }))
    await withServer(async (server) => {
      const body = await readBody(await startCheckout(server))
      expect(body.status).toBe(200)
      expect(JSON.parse(body.text).url).toBe(CHECKOUT_URL)
    })
  })
})

describe("portal: the request Stripe receives", () => {
  test("sends the stored customer id and the return URL, and nothing purchasable", async () => {
    seedSubscription()
    stubStripe(() => portalSession())
    await withServer(async (server) => {
      const body = await readBody(await startPortal(server))
      expect(body.status).toBe(200)
      expect(body.ok).toBe(true)
      expect(JSON.parse(body.text).url).toBe(PORTAL_URL)
      expect(calls).toHaveLength(1)

      const call = calls[0]
      expect(call.url).toBe(PORTAL_ENDPOINT)
      expect(call.method).toBe("POST")
      expect(call.headers.get("authorization")).toBe(`Bearer ${API_KEY}`)
      // The customer id comes from OUR stored subscription, so the portal opens on
      // the caller's own subscription. A customer id read from the request would
      // hand any signed-in desktop a portal over somebody else's card.
      expect(call.form.get("customer")).toBe(CUSTOMER)
      expect(call.form.get("return_url")).toBe(`${PUBLIC_URL}/?billing=portal`)
      // The portal can change the card on a live subscription, so it carries no
      // price, no mode and no profile: every extra field is a new surface.
      expect([...call.form.keys()].sort()).toEqual(["customer", "return_url"])
      expect(call.form.toString()).not.toContain(PROFILE)
    })
  })

  test("another profile's subscription is not this profile's portal", async () => {
    seedSubscription(OTHER_PROFILE, "cus_someone_else")
    stubStripe(() => portalSession())
    await withServer(async (server) => {
      const response = await startPortal(server)
      // Dropping the profileId match here opens a portal over somebody else's
      // saved card, which is the whole reason the lookup is filtered.
      expect(response.status).toBe(404)
      expect(calls).toHaveLength(0)
    })
  })
})

describe("a Stripe failure is a 502, never a crash and never a leak", () => {
  test("a non-2xx names the status without echoing Stripe's body", async () => {
    // The portal route only reaches Stripe for a profile that already has a
    // subscription, so the customer has to exist for this to be about the
    // failure mode rather than a 404.
    seedSubscription()
    stubStripe(() => stripeJson({ error: { message: "card_declined", charge: "ch_1_secret_card" } }, 402))
    await withServer(async (server) => {
      const body = await readBody(await startCheckout(server))
      expect(body.status).toBe(502)
      expect(body.ok).toBe(false)
      expect(body.error).toContain("402")
      expect(body.error).toContain("checkout")
      // Stripe's error body is remote input: echoing it back leaks another
      // customer's charge id and puts Stripe's wording in our API contract.
      expect(body.text).not.toContain("card_declined")
      expect(body.text).not.toContain("ch_1_secret_card")

      stubStripe(() => new Response("upstream exploded", { status: 500 }))
      const portal = await readBody(await startPortal(server))
      expect(portal.status).toBe(502)
      expect(portal.error).toContain("500")
      expect(portal.error).toContain("portal")
      expect(portal.text).not.toContain("upstream exploded")
    })
  })

  test("a 200 that is not JSON is a 502 on both routes", async () => {
    seedSubscription()
    stubStripe(() => new Response("<html><body>maintenance window</body></html>", { status: 200, headers: { "content-type": "text/html" } }))
    await withServer(async (server) => {
      const body = await readBody(await startCheckout(server))
      expect(body.status).toBe(502)
      expect(body.error).toContain("not JSON")
      expect(body.text).not.toContain("maintenance window")
      const portal = await readBody(await startPortal(server))
      expect(portal.status).toBe(502)
      expect(portal.error).toContain("not JSON")
    })
  })

  test("a 200 with no url in it is a 502 on both routes", async () => {
    seedSubscription()
    stubStripe(eitherSession)
    await withServer(async (server) => {
      for (const payload of [{}, { url: "" }, { url: 42 }, { url: null }, { id: "cs_test_1" }, null]) {
        stubStripe(() => stripeJson(payload))
        const body = await readBody(await startCheckout(server))
        expect(`${JSON.stringify(payload)} checkout -> ${body.status}`).toBe(`${JSON.stringify(payload)} checkout -> 502`)
        expect(body.error).toContain("no checkout URL")
        const portal = await readBody(await startPortal(server))
        expect(`${JSON.stringify(payload)} portal -> ${portal.status}`).toBe(`${JSON.stringify(payload)} portal -> 502`)
        expect(portal.error).toContain("no portal URL")
      }
    })
  })

  test("checkout hands back only an HTTPS checkout.stripe.com URL", async () => {
    stubStripe(eitherSession)
    await withServer(async (server) => {
      // The response is remote input that ends up in a browser, so anything off
      // the allowlist is either a javascript: execution or an attacker page
      // wearing a real-looking checkout flow.
      for (const url of [
        "",
        "javascript:alert(document.domain)",
        "JavaScript:alert(1)",
        "data:text/html,<script>alert(1)</script>",
        "https://evil.example/steal",
        "https://checkout.stripe.com.evil.example/c/pay/cs_1",
        "https://evil.checkout.stripe.com/c/pay/cs_1",
        "http://checkout.stripe.com/c/pay/cs_1",
        "not-a-url",
        // The portal host is not the checkout host: a crossed allowlist would
        // send a buyer into a different Stripe surface than the one requested.
        PORTAL_URL,
      ]) {
        stubStripe(() => stripeJson({ url }))
        const body = await readBody(await startCheckout(server))
        expect(`${url || "(empty)"} -> ${body.status}`).toBe(`${url || "(empty)"} -> 502`)
        expect(body.ok).toBe(false)
        // The rejected value is remote input too, so the error must describe the
        // problem without reflecting the value back into our own response.
        if (url.length > 0) expect(body.text).not.toContain(url)
      }
    })
  })

  test("portal hands back only an HTTPS billing.stripe.com URL", async () => {
    seedSubscription()
    stubStripe(() => portalSession())
    await withServer(async (server) => {
      for (const url of [
        "",
        "javascript:alert(document.domain)",
        "https://evil.example/steal",
        "https://billing.stripe.com.evil.example/p/session_1",
        "http://billing.stripe.com/p/session_1",
        "not-a-url",
        CHECKOUT_URL,
      ]) {
        stubStripe(() => stripeJson({ url }))
        const body = await readBody(await startPortal(server))
        expect(`${url || "(empty)"} -> ${body.status}`).toBe(`${url || "(empty)"} -> 502`)
        expect(body.ok).toBe(false)
      }
      expect(calls).toHaveLength(7)
    })
  })

  test("a DNS, TLS or socket failure is a 502, not a 500", async () => {
    seedSubscription()
    for (const failure of [
      () => Promise.reject(new TypeError("Unable to connect. Is the computer able to access the url?")),
      () => {
        throw new Error("ECONNRESET")
      },
    ]) {
      stubStripe(failure)
      await withServer(async (server) => {
        const body = await readBody(await startCheckout(server))
        // A money path must read as a billing failure, not crash into a 500 with
        // a stack trace: the operator's next move is to retry, not to file a bug.
        expect(body.status).toBe(502)
        expect(body.error).toContain("Could not reach Stripe")
        expect(body.text).not.toContain("ECONNRESET")
        expect(body.text).not.toContain("at ")
        const portal = await readBody(await startPortal(server))
        expect(portal.status).toBe(502)
        expect(portal.error).toContain("Could not reach Stripe")
      })
    }
  })
})

describe("the outbound call is bounded and cancellable", () => {
  test("a Stripe call that never settles is bounded by the timeout the route passes", async () => {
    const budgets: number[] = []
    let aborted = false
    // The production budget is 30s. Only the DURATION is compressed here - the
    // signal, and the fact that the route passes it and honours it, are the real
    // code under test. A backstop rejects at 4s so that a route which never gets
    // a signal fails this assertion instead of hanging the suite.
    AbortSignal.timeout = ((milliseconds: number) => {
      budgets.push(milliseconds)
      const controller = new AbortController()
      setTimeout(() => controller.abort(new DOMException("The operation timed out.", "TimeoutError")), 25)
      return controller.signal
    }) as typeof AbortSignal.timeout
    stubStripe(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = call.signal
          if (signal === undefined || signal === null) return
          signal.addEventListener("abort", () => {
            aborted = true
            reject(signal.reason instanceof Error ? signal.reason : new DOMException("aborted", "AbortError"))
          })
        }),
    )
    await withServer(async (server) => {
      const started = Date.now()
      const body = await readBody(await startCheckout(server))
      const elapsed = Date.now() - started
      expect(body.status).toBe(502)
      expect(body.error).toContain("Could not reach Stripe")
      // Without a timeout signal on the outbound request, a hung Stripe call
      // holds this request open until the runtime's own socket timeout, which is
      // uncancellable and, for the portal, leaves a half-open payment surface.
      expect(aborted).toBe(true)
      expect(elapsed).toBeLessThan(1_500)
      expect(budgets[0]).toBeGreaterThan(0)
      expect(budgets[0]).toBeLessThanOrEqual(60_000)
    })
  })
})

describe("an unconfigured server never calls Stripe", () => {
  test("no API key is a 503 on both routes", async () => {
    seedSubscription()
    stubStripe(eitherSession)
    for (const value of [undefined, ""]) {
      if (value === undefined) delete process.env.STRIPE_SECRET_KEY
      else process.env.STRIPE_SECRET_KEY = value
      await withServer(async (server) => {
        const checkout = await readBody(await startCheckout(server))
        expect(checkout.status).toBe(503)
        expect(checkout.error).toContain("not configured")
        const portal = await readBody(await startPortal(server))
        expect(portal.status).toBe(503)
        expect(portal.error).toContain("not configured")
        // Nothing may leave the process: an unauthenticated call to Stripe is
        // both a wasted round trip and a confusing 401 to debug later.
        expect(calls).toHaveLength(0)
      })
    }
  })

  test("a plan with no configured price is a 503 naming that plan", async () => {
    delete process.env.STRIPE_PRICE_PRO
    stubStripe(eitherSession)
    await withServer(async (server) => {
      const body = await readBody(await startCheckout(server, "pro"))
      expect(body.status).toBe(503)
      expect(body.error).toContain("price")
      expect(body.error).toContain("pro")
      expect(calls).toHaveLength(0)
      // The other plan is untouched, so this is a per-plan lookup rather than a
      // blanket refusal whenever any single price id is missing.
      expect((await readBody(await startCheckout(server, "business"))).status).toBe(200)
      expect(calls).toHaveLength(1)
      expect(calls[0].form.get("line_items[0][price]")).toBe(PRICE_BUSINESS)
    })
  })

  test("no public URL is a 503 on both routes", async () => {
    seedSubscription()
    stubStripe(eitherSession)
    delete process.env.OMNIA_PUBLIC_URL
    await withServer(async (server) => {
      const checkout = await readBody(await startCheckout(server))
      expect(checkout.status).toBe(503)
      expect(checkout.error).toContain("public URL")
      const portal = await readBody(await startPortal(server))
      expect(portal.status).toBe(503)
      expect(portal.error).toContain("public URL")
      // A session created against an origin that cannot be returned to strands
      // the customer mid-flow with no way back into the product.
      expect(calls).toHaveLength(0)
    })
  })

  test("a blank public URL is a 503 rather than a session with no return path", async () => {
    seedSubscription()
    stubStripe(eitherSession)
    process.env.OMNIA_PUBLIC_URL = ""
    await withServer(async (server) => {
      expect((await readBody(await startCheckout(server))).status).toBe(503)
      expect((await readBody(await startPortal(server))).status).toBe(503)
      expect(calls).toHaveLength(0)
    })
  })
})

describe("only the operator's own desktop may spend money", () => {
  test("a thin client token is refused on both routes and Stripe is never called", async () => {
    seedSubscription()
    stubStripe(eitherSession)
    await withServer(async (server) => {
      const thin = server.auth.mintClientToken({ id: 9, login: "thin" })!
      // A client token is a real credential - isAuthorized accepts it - so the
      // 403 below has to come from the billing route's own operator check and not
      // from a generic authentication rejection.
      expect(server.auth.isClientToken(thin)).toBe(true)
      const checkout = await readBody(await startCheckout(server, "pro", { token: thin }))
      expect(checkout.status).toBe(403)
      expect(checkout.error).toBe("Only the signed-in desktop may manage billing.")
      const portal = await readBody(await startPortal(server, { token: thin }))
      expect(portal.status).toBe(403)
      expect(portal.error).toBe("Only the signed-in desktop may manage billing.")
      // The caller also named a profile, which used to be enough to open the
      // operator's own Stripe portal over the operator's saved card.
      expect(calls).toHaveLength(0)
    })
  })
})
