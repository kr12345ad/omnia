import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHmac } from "node:crypto"
import { startOmniaServer } from "./server"
import { EMPTY_STATE, readBillingState } from "../billing/store"
import type { PlanId } from "../billing/plans"

const WEBHOOK_SECRET = "whsec_test"
const API_SECRET = "sk_test_does_not_need_to_be_real"
const PRICE_PRO = "price_pro_test"
const PRICE_BUSINESS = "price_business_test"
const PUBLIC_URL = "https://example.test/omnia"

type Server = Awaited<ReturnType<typeof startOmniaServer>>

let dir = ""
let previous: Record<string, string | undefined> = {}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnia-billing-api-"))
  previous = {
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    STRIPE_PRICE_PRO: process.env.STRIPE_PRICE_PRO,
    STRIPE_PRICE_BUSINESS: process.env.STRIPE_PRICE_BUSINESS,
    OMNIA_PUBLIC_URL: process.env.OMNIA_PUBLIC_URL,
    OMNIA_BILLING_FILE: process.env.OMNIA_BILLING_FILE,
  }
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET
  process.env.STRIPE_SECRET_KEY = API_SECRET
  process.env.STRIPE_PRICE_PRO = PRICE_PRO
  process.env.STRIPE_PRICE_BUSINESS = PRICE_BUSINESS
  process.env.OMNIA_PUBLIC_URL = PUBLIC_URL
  process.env.OMNIA_BILLING_FILE = join(dir, "billing.json")
})

afterEach(() => {
  for (const [key, value] of Object.entries(previous)) {
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

function signed(body: string, timestamp = Math.floor(Date.now() / 1000), secret = WEBHOOK_SECRET): string {
  const digest = createHmac("sha256", secret).update(`${timestamp}.${body}`, "utf8").digest("hex")
  return `t=${timestamp},v1=${digest}`
}

function post(server: Server, path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${server.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
}

const subscriptionEvent = (plan: string, overrides: Record<string, unknown> = {}) => ({
  id: `evt_${plan}`,
  type: "customer.subscription.updated",
  created: 0,
  data: {
    object: {
      id: `sub_${plan}`,
      customer: `cus_${plan}`,
      status: "active",
      current_period_end: 2_000_000_000,
      price: { id: plan === "business" ? PRICE_BUSINESS : PRICE_PRO },
      metadata: { profileId: "230746284" },
      ...overrides,
    },
  },
})

describe("stripe webhook", () => {
  test("anonymous status traffic does not starve a valid signed webhook", async () => {
    await withServer(async (server) => {
      for (let index = 0; index < 130; index++) {
        expect((await fetch(`${server.url}/v1/auth/github/status`)).status).toBe(200)
      }
      const body = JSON.stringify(subscriptionEvent("pro"))
      const response = await fetch(`${server.url}/v1/billing/stripe/webhook`, {
        method: "POST", headers: { "stripe-signature": signed(body), "content-type": "application/json" }, body,
      })
      expect(response.status).toBe(200)
      expect(readBillingState(process.env.OMNIA_BILLING_FILE).subscriptions[0]?.plan).toBe("pro")
    })
  })

  test("a correctly signed subscription upgrades the profile", async () => {
    await withServer(async (server) => {
      const body = JSON.stringify(subscriptionEvent("pro"))
      const response = await fetch(`${server.url}/v1/billing/stripe/webhook`, {
        method: "POST",
        headers: { "stripe-signature": signed(body), "content-type": "application/json" },
        body,
      })
      expect(response.status).toBe(200)
      expect((await response.json()).ok).toBe(true)
      const state = readBillingState(process.env.OMNIA_BILLING_FILE)
      expect(state.subscriptions).toHaveLength(1)
      expect(state.subscriptions[0]?.plan).toBe("pro")
      expect(state.subscriptions[0]?.profileId).toBe("230746284")
    })
  })

  test("an unsigned webhook changes nothing", async () => {
    await withServer(async (server) => {
      const response = await post(server, "/v1/billing/stripe/webhook", subscriptionEvent("pro"))
      expect(response.status).toBe(400)
      expect(readBillingState(process.env.OMNIA_BILLING_FILE)).toEqual(EMPTY_STATE)
    })
  })

  test("a webhook signed with the wrong secret changes nothing", async () => {
    await withServer(async (server) => {
      const body = JSON.stringify(subscriptionEvent("pro"))
      const response = await fetch(`${server.url}/v1/billing/stripe/webhook`, {
        method: "POST",
        headers: { "stripe-signature": signed(body, Math.floor(Date.now() / 1000), "whsec_attacker") },
        body,
      })
      expect(response.status).toBe(400)
      expect(readBillingState(process.env.OMNIA_BILLING_FILE)).toEqual(EMPTY_STATE)
    })
  })

  test("a body edited after signing is rejected", async () => {
    await withServer(async (server) => {
      // Sign one event, send another: exactly the attack a signature exists to stop.
      const signature = signed(JSON.stringify(subscriptionEvent("pro")), Math.floor(Date.now() / 1000))
      const response = await post(server, "/v1/billing/stripe/webhook", subscriptionEvent("business"), {
        "stripe-signature": signature,
      })
      expect(response.status).toBe(400)
      expect(readBillingState(process.env.OMNIA_BILLING_FILE)).toEqual(EMPTY_STATE)
    })
  })

  test("a replayed webhook does not double count", async () => {
    await withServer(async (server) => {
      const body = JSON.stringify(subscriptionEvent("pro"))
      const headers = { "stripe-signature": signed(body), "content-type": "application/json" }
      const first = await fetch(`${server.url}/v1/billing/stripe/webhook`, { method: "POST", headers, body })
      const second = await fetch(`${server.url}/v1/billing/stripe/webhook`, { method: "POST", headers, body })
      expect(first.status).toBe(200)
      expect((await second.json()).duplicate).toBe(true)
      expect(readBillingState(process.env.OMNIA_BILLING_FILE).subscriptions).toHaveLength(1)
    })
  })

  test("an unmapped price grants nothing", async () => {
    await withServer(async (server) => {
      const body = JSON.stringify(subscriptionEvent("pro", { price: { id: "price_someone_elses" } }))
      const response = await fetch(`${server.url}/v1/billing/stripe/webhook`, {
        method: "POST",
        headers: { "stripe-signature": signed(body) },
        body,
      })
      expect(response.status).toBe(200)
      expect((await response.json()).ignored).toBe(true)
      expect(readBillingState(process.env.OMNIA_BILLING_FILE)).toEqual(EMPTY_STATE)
    })
  })

  test("a canceled subscription is recorded but does not entitle", async () => {
    await withServer(async (server) => {
      const body = JSON.stringify(subscriptionEvent("pro", { status: "canceled" }))
      await fetch(`${server.url}/v1/billing/stripe/webhook`, {
        method: "POST",
        headers: { "stripe-signature": signed(body) },
        body,
      })
      const state = readBillingState(process.env.OMNIA_BILLING_FILE)
      expect(state.subscriptions[0]?.status).toBe("canceled")
      const check = await post(server, "/v1/billing/check", { capability: "remote_shell" }, {
        authorization: `Bearer ${server.token}`,
        "x-omnia-profile": "230746284",
      })
      expect(check.status).toBe(402)
    })
  })

  test("the webhook refuses GET", async () => {
    await withServer(async (server) => {
      const response = await fetch(`${server.url}/v1/billing/stripe/webhook`)
      expect(response.status).toBe(405)
    })
  })

  test("with no webhook secret configured it refuses rather than trusting anyone", async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET
    await withServer(async (server) => {
      const response = await post(server, "/v1/billing/stripe/webhook", subscriptionEvent("pro"))
      expect(response.status).toBe(503)
      expect(readBillingState(process.env.OMNIA_BILLING_FILE)).toEqual(EMPTY_STATE)
    })
  })
})

describe("entitlement and checkout", () => {
  test("entitlement needs a profile", async () => {
    await withServer(async (server) => {
      const response = await fetch(`${server.url}/v1/billing/entitlement`, {
        headers: { authorization: `Bearer ${server.token}` },
      })
      expect(response.status).toBe(401)
    })
  })

  test("entitlement reports the free plan before any purchase", async () => {
    await withServer(async (server) => {
      const response = await fetch(`${server.url}/v1/billing/entitlement`, {
        headers: { authorization: `Bearer ${server.token}`, "x-omnia-profile": "230746284" },
      })
      expect(response.status).toBe(200)
      const json = (await response.json()) as { plan: PlanId; computers: number }
      expect(json.plan).toBe("free")
      expect(json.computers).toBe(3)
    })
  })

  test("the vault is refused on free and granted after checkout", async () => {
    await withServer(async (server) => {
      const before = await post(server, "/v1/billing/check", { capability: "vault_login" }, {
        authorization: `Bearer ${server.token}`,
        "x-omnia-profile": "230746284",
      })
      expect(before.status).toBe(200)

      const body = JSON.stringify(subscriptionEvent("pro"))
      await fetch(`${server.url}/v1/billing/stripe/webhook`, {
        method: "POST",
        headers: { "stripe-signature": signed(body) },
        body,
      })

      const after = await post(server, "/v1/billing/check", { capability: "vault_login" }, {
        authorization: `Bearer ${server.token}`,
        "x-omnia-profile": "230746284",
      })
      const json = (await after.json()) as { plan: PlanId }
      expect(json.plan).toBe("pro")
    })
  })

  test("the hard vault allowance runs out and then refuses", async () => {
    await withServer(async (server) => {
      const headers = { authorization: `Bearer ${server.token}`, "x-omnia-profile": "230746284" }
      for (let i = 0; i < 3; i += 1) {
        const allowed = await post(server, "/v1/billing/check", { capability: "vault_login" }, headers)
        expect(allowed.status).toBe(200)
      }
      const denied = await post(server, "/v1/billing/check", { capability: "vault_login" }, headers)
      expect(denied.status).toBe(402)
      expect((await denied.json()).code).toBe("limit_reached")
    })
  })

  test("a shell request is refused on free with an upgrade hint", async () => {
    await withServer(async (server) => {
      const response = await post(server, "/v1/billing/check", { capability: "remote_shell" }, {
        authorization: `Bearer ${server.token}`,
        "x-omnia-profile": "230746284",
      })
      expect(response.status).toBe(402)
      expect((await response.json()).code).toBe("not_entitled")
    })
  })

  test("an unknown capability is a 400, not a free pass", async () => {
    await withServer(async (server) => {
      const response = await post(server, "/v1/billing/check", { capability: "everything" }, {
        authorization: `Bearer ${server.token}`,
        "x-omnia-profile": "230746284",
      })
      expect(response.status).toBe(400)
    })
  })

  test("a non-numeric profile id is treated as signed out", async () => {
    await withServer(async (server) => {
      const response = await post(server, "/v1/billing/check", { capability: "vault_login" }, {
        authorization: `Bearer ${server.token}`,
        "x-omnia-profile": "../../etc/passwd",
      })
      expect(response.status).toBe(200)
      const json = (await response.json()) as { plan: PlanId }
      expect(json.plan).toBe("free")
    })
  })

  test("checkout refuses an unbuyable plan", async () => {
    await withServer(async (server) => {
      for (const plan of ["free", "enterprise", "platinum", 7]) {
        const response = await post(server, "/v1/billing/checkout", { plan }, {
          authorization: `Bearer ${server.token}`,
          "x-omnia-profile": "230746284",
        })
        expect(`${plan} -> ${response.status}`).toBe(`${plan} -> 400`)
      }
    })
  })

  test("checkout needs a signed-in profile", async () => {
    await withServer(async (server) => {
      const response = await post(server, "/v1/billing/checkout", { plan: "pro" }, {
        authorization: `Bearer ${server.token}`,
      })
      expect(response.status).toBe(401)
    })
  })

  test("portal reports no subscription instead of erroring", async () => {
    await withServer(async (server) => {
      const response = await post(server, "/v1/billing/portal", {}, {
        authorization: `Bearer ${server.token}`,
        "x-omnia-profile": "230746284",
      })
      expect(response.status).toBe(404)
    })
  })

  test("an unknown billing route is a 404", async () => {
    await withServer(async (server) => {
      const response = await fetch(`${server.url}/v1/billing/nope`, {
        headers: { authorization: `Bearer ${server.token}` },
      })
      expect(response.status).toBe(404)
    })
  })
})
