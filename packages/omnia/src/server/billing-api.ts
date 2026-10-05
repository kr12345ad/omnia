// Billing routes.
//
// Kept out of api.ts on purpose: this is the money path, so it lives in one
// small file an auditor can read end to end rather than as a hundred lines
// spread through a route table that also serves screenshots.
//
// Three rules hold for every route here:
//
//   1. The Stripe webhook never touches billing state until the signature over
//      the RAW body has been verified. Parsing first would mean acting on bytes
//      nobody authenticated.
//   2. Nothing accepts a secret from a caller. The webhook secret and the API
//      key come from the environment or not at all.
//   3. Entitlements are read through the store's asymmetric failure policy, so a
//      billing outage cannot hand out paid capabilities and cannot break free
//      ones either.
import type { IncomingMessage, ServerResponse } from "node:http"
import type { ApiContext, ParsedRequest } from "./api.js"
import { readBodyBytes, isTrustedDesktopRequest, presentsServerToken } from "./api.js"
import { PLANS, isPlanId, type Capability, type PlanId } from "../billing/plans.js"
import {
  StripeSignatureError,
  entitles,
  parseStripeEvent,
  planForPrice,
  subscriptionFromEvent,
  verifyStripeSignature,
  type StripeEvent,
} from "../billing/stripe.js"
import {
  applySubscription,
  consume,
  decide,
  readBillingState,
  writeBillingState,
  type BillingState,
} from "../billing/store.js"

const STRIPE_API = "https://api.stripe.com/v1"

/** Capabilities the caller asked to exercise, used by the metered POST route. */
const CHECKABLE: ReadonlySet<string> = new Set(Object.keys(PLANS.free.capabilities))

function json(response: ServerResponse, status: number, payload: unknown): void {
  const body = Buffer.from(JSON.stringify(payload), "utf8")
  response.writeHead(status, { "content-type": "application/json", "content-length": String(body.byteLength) })
  response.end(body)
}

/**
 * The signed-in profile, when there is one.
 *
 * Entitlements are per profile, so an unauthenticated caller resolves to the
 * free plan rather than to nobody's plan.
 */
function profileId(context: ApiContext, request: IncomingMessage, body: Record<string, unknown> = {}): string | undefined {
  const fromHeader = request.headers["x-omnia-profile"]
  const header = Array.isArray(fromHeader) ? fromHeader[0] : fromHeader
  const candidate = typeof header === "string" && header.length > 0 ? header : body.profileId
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > 128) return undefined
  // Numeric-only ids are what GitHub returns; anything else is not a profile we
  // ever wrote a subscription against.
  return /^[0-9]{1,32}$/.test(candidate) ? candidate : undefined
}

function billingFile(context: ApiContext): string | undefined {
  const configured = process.env.OMNIA_BILLING_FILE
  if (configured !== undefined && configured.length > 0) return configured
  const dataDir = process.env.OMNIA_DATA_DIR
  return dataDir === undefined || dataDir.length === 0 ? undefined : `${dataDir}/billing.json`
}

/** Reads billing state, reporting whether the read actually succeeded. */
function loadState(file: string | undefined): { state: BillingState; readable: boolean } {
  if (file === undefined) return { state: readBillingState(undefined), readable: false }
  try {
    return { state: readBillingState(file), readable: true }
  } catch {
    // An unreadable store is not fatal: free capabilities keep working, and the
    // hard-metered ones are refused by decide() rather than here.
    return { state: readBillingState(undefined), readable: false }
  }
}

function stripeSecret(): string | undefined {
  const key = process.env.STRIPE_SECRET_KEY
  return key !== undefined && key.length > 0 ? key : undefined
}

function priceIdFor(plan: PlanId): string | undefined {
  const prices: Record<string, string | undefined> = {
    pro: process.env.STRIPE_PRICE_PRO,
    business: process.env.STRIPE_PRICE_BUSINESS,
  }
  const value = prices[plan]
  return value !== undefined && value.length > 0 ? value : undefined
}

/**
 * Creates a Stripe Checkout session with form encoding.
 *
 * Written by hand rather than pulled from the SDK so the request is inspectable:
 * the only caller-controlled values are the price id, which comes from our own
 * environment, and the success/cancel URLs, which are validated against the
 * configured public origin.
 */
async function createCheckoutSession(options: {
  readonly secret: string
  readonly priceId: string
  readonly profileId: string
  readonly publicUrl: string
}): Promise<{ readonly url: string } | { readonly error: string }> {
  const form = new URLSearchParams()
  form.set("mode", "subscription")
  form.set("line_items[0][price]", options.priceId)
  form.set("line_items[0][quantity]", "1")
  // Stripe echoes this back on the subscription, which is how a webhook becomes
  // attributable to a profile.
  form.set("metadata[profileId]", options.profileId)
  form.set("client_reference_id", options.profileId)
  form.set("success_url", `${options.publicUrl}/?checkout=success`)
  form.set("cancel_url", `${options.publicUrl}/?checkout=cancelled`)
  const response = await fetch(`${STRIPE_API}/checkout/sessions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.secret}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  })
  const text = await response.text()
  if (!response.ok) return { error: `Stripe rejected the checkout session (HTTP ${response.status}).` }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { error: "Stripe returned a response that was not JSON." }
  }
  const url =
    typeof parsed === "object" && parsed !== null && typeof (parsed as { url?: unknown }).url === "string"
      ? (parsed as { url: string }).url
      : undefined
  return url === undefined ? { error: "Stripe returned no checkout URL." } : { url }
}

async function createPortalSession(options: {
  readonly secret: string
  readonly customerId: string
  readonly publicUrl: string
}): Promise<{ readonly url: string } | { readonly error: string }> {
  const form = new URLSearchParams()
  form.set("customer", options.customerId)
  form.set("return_url", `${options.publicUrl}/?billing=portal`)
  const response = await fetch(`${STRIPE_API}/billing_portal/sessions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.secret}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  })
  const text = await response.text()
  if (!response.ok) return { error: `Stripe rejected the portal session (HTTP ${response.status}).` }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { error: "Stripe returned a response that was not JSON." }
  }
  const url =
    typeof parsed === "object" && parsed !== null && typeof (parsed as { url?: unknown }).url === "string"
      ? (parsed as { url: string }).url
      : undefined
  return url === undefined ? { error: "Stripe returned no portal URL." } : { url }
}

/** Which Stripe events change what. Anything else is acknowledged and ignored. */
function planFromEvent(event: StripeEvent): { readonly plan: PlanId } | undefined {
  const priceId =
    typeof event.data === "object" && event.data !== null
      ? (event.data as { object?: unknown }).object
      : undefined
  const prices: Readonly<Record<string, PlanId>> = {
    ...(process.env.STRIPE_PRICE_PRO !== undefined && process.env.STRIPE_PRICE_PRO.length > 0
      ? { [process.env.STRIPE_PRICE_PRO]: "pro" as const }
      : {}),
    ...(process.env.STRIPE_PRICE_BUSINESS !== undefined && process.env.STRIPE_PRICE_BUSINESS.length > 0
      ? { [process.env.STRIPE_PRICE_BUSINESS]: "business" as const }
      : {}),
  }
  const object = priceId as { price?: { id?: unknown } } | undefined
  const id = object?.price?.id
  if (typeof id !== "string") return undefined
  const plan = planForPrice(id, prices)
  return plan === undefined ? undefined : { plan }
}

export async function handleBillingRoute(
  context: ApiContext,
  request: IncomingMessage,
  response: ServerResponse,
  parsed: ParsedRequest,
): Promise<boolean> {
  const { method, segments } = parsed
  if (segments[1] !== "billing") return false

  // ---- webhook: unauthenticated by necessity, authenticated by signature ----
  if (segments[2] === "stripe" && segments[3] === "webhook") {
    if (method !== "POST") {
      json(response, 405, { ok: false, error: "The webhook accepts POST only." })
      return true
    }
    const secret = process.env.STRIPE_WEBHOOK_SECRET
    if (secret === undefined || secret.length === 0) {
      json(response, 503, { ok: false, error: "Billing is not configured on this server." })
      return true
    }
    let raw: string
    try {
      raw = (await readBodyBytes(request)).toString("utf8")
    } catch {
      json(response, 413, { ok: false, error: "The webhook body was too large." })
      return true
    }
    // Verified over the raw bytes, before anything is parsed or written.
    try {
      verifyStripeSignature(raw, request.headers["stripe-signature"] as string | undefined, secret)
    } catch (error) {
      const message = error instanceof StripeSignatureError ? error.message : "The signature was rejected."
      json(response, 400, { ok: false, error: message })
      return true
    }
    let event: StripeEvent
    try {
      event = parseStripeEvent(raw)
    } catch (error) {
      json(response, 400, { ok: false, error: error instanceof Error ? error.message : "Unreadable event." })
      return true
    }
    const file = billingFile(context)
    const { state } = loadState(file)
    const subscription = subscriptionFromEvent(event)
    const plan = planFromEvent(event)
    if (subscription === undefined || plan === undefined) {
      // Acknowledged on purpose: Stripe retries anything it does not get a 2xx
      // for, and retrying an event we deliberately ignore is pure noise.
      json(response, 200, { ok: true, ignored: true })
      return true
    }
    const applied = applySubscription(state, subscription, plan.plan, event.id)
    if (!applied.duplicate && file !== undefined) {
      try {
        writeBillingState(file, applied.state)
      } catch {
        json(response, 503, { ok: false, error: "Billing state could not be stored." })
        return true
      }
    }
    json(response, 200, { ok: true, duplicate: applied.duplicate })
    return true
  }

  // Everything below needs a credential, and entitlements additionally require
  // the signed-in desktop so a stray token cannot read somebody's plan.
  const body = method === "POST" ? await safeJson(request) : {}
  const who = profileId(context, request, body)

  if (segments[2] === "entitlement" && segments.length === 3) {
    const file = billingFile(context)
    const { state, readable } = loadState(file)
    if (who === undefined) {
      json(response, 401, { ok: false, error: "Sign in to see your plan." })
      return true
    }
    const plan = decide(state, who, "local_computer", { storeReadable: readable }).plan
    const capabilities = Object.fromEntries(
      (Object.keys(PLANS[plan].capabilities) as Capability[]).map((capability) => {
        const decision = decide(state, who, capability, { storeReadable: readable })
        return [capability, { allowed: decision.allowed, code: decision.code, used: decision.used, limit: decision.limit }]
      }),
    )
    json(response, 200, { ok: true, plan, computers: PLANS[plan].computers, capabilities, billingConfigured: stripeSecret() !== undefined })
    return true
  }

  // Metered capability check. This is what the enforcement call sites use.
  if (segments[2] === "check" && segments.length === 3 && method === "POST") {
    const capability = typeof body.capability === "string" ? body.capability : undefined
    if (capability === undefined || !CHECKABLE.has(capability)) {
      json(response, 400, { ok: false, error: "Unknown capability." })
      return true
    }
    const file = billingFile(context)
    const { state, readable } = loadState(file)
    const decision = decide(state, who, capability as Capability, { storeReadable: readable })
    if (decision.allowed && decision.code === "granted") {
      const next = consume(state, who, capability as Capability)
      if (file !== undefined && who !== undefined) {
        try {
          writeBillingState(file, next)
        } catch {
          // Failing to persist a counter must not deny a request that was
          // already allowed; the worst case is one un-metered call.
        }
      }
    }
    json(response, decision.allowed ? 200 : 402, { ok: decision.allowed, ...decision })
    return true
  }

  if (segments[2] === "checkout" && method === "POST") {
    const secret = stripeSecret()
    if (secret === undefined) {
      json(response, 503, { ok: false, error: "Billing is not configured on this server." })
      return true
    }
    const plan = body.plan
    if (!isPlanId(plan) || plan === "free" || plan === "enterprise") {
      json(response, 400, { ok: false, error: "Choose the pro or business plan." })
      return true
    }
    if (who === undefined) {
      json(response, 401, { ok: false, error: "Sign in before upgrading." })
      return true
    }
    const priceId = priceIdFor(plan)
    if (priceId === undefined) {
      json(response, 503, { ok: false, error: `No Stripe price is configured for the ${plan} plan.` })
      return true
    }
    const publicUrl = (process.env.OMNIA_PUBLIC_URL ?? "").replace(/\/+$/, "")
    if (publicUrl.length === 0) {
      json(response, 503, { ok: false, error: "This server has no public URL for Stripe to return to." })
      return true
    }
    const session = await createCheckoutSession({ secret, priceId, profileId: who, publicUrl })
    if ("error" in session) {
      json(response, 502, { ok: false, error: session.error })
      return true
    }
    json(response, 200, { ok: true, url: session.url })
    return true
  }

  if (segments[2] === "portal" && method === "POST") {
    const secret = stripeSecret()
    if (secret === undefined) {
      json(response, 503, { ok: false, error: "Billing is not configured on this server." })
      return true
    }
    if (who === undefined) {
      json(response, 401, { ok: false, error: "Sign in before managing billing." })
      return true
    }
    const file = billingFile(context)
    const { state } = loadState(file)
    const subscription = state.subscriptions.find((entry) => entry.profileId === who)
    if (subscription === undefined) {
      json(response, 404, { ok: false, error: "This profile has no subscription to manage yet." })
      return true
    }
    const publicUrl = (process.env.OMNIA_PUBLIC_URL ?? "").replace(/\/+$/, "")
    const session = await createPortalSession({ secret, customerId: subscription.customerId, publicUrl })
    if ("error" in session) {
      json(response, 502, { ok: false, error: session.error })
      return true
    }
    json(response, 200, { ok: true, url: session.url })
    return true
  }

  json(response, 404, { ok: false, error: "Unknown billing route." })
  return true
}

async function safeJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await readBodyBytes(request)
      .then((bytes) => JSON.parse(bytes.toString("utf8")))
      .catch(() => undefined)
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/** Exposed so the server can report whether billing is wired up at all. */
export function billingConfigured(): boolean {
  return stripeSecret() !== undefined && (process.env.STRIPE_WEBHOOK_SECRET ?? "").length > 0
}

export { entitles, presentsServerToken, isTrustedDesktopRequest }