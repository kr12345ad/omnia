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
import { bearerToken, readBodyBytes, isOperatorRequest, isTrustedDesktopRequest, presentsServerToken } from "./api.js"
import { PLANS, isPlanId, type Capability, type PlanId } from "../billing/plans.js"
import {
  StripeSignatureError,
  defersEntitlement,
  entitles,
  newOrderingLedger,
  parseStripeEvent,
  planForPrice,
  disputeChargeId,
  priceIdFromObject,
  recordApplied,
  REFUNDED,
  refundedSubscriptions,
  stripeRequestHeaders,
  subscriptionFromEvent,
  superseded,
  verifyStripeSignature,
  type HeldSubscription,
  type StripeEvent,
} from "../billing/stripe.js"
import {
  applySubscription,
  billingStateReadable,
  check,
  decide,
  readBillingState,
  writeBillingState,
  type BillingState,
} from "../billing/store.js"

// Every outbound call below goes through stripeRequestHeaders(), which is the
// single place that pins the Stripe API version. An unpinned call would silently
// change shape when the account's default version moves.
const STRIPE_API = "https://api.stripe.com/v1"

/**
 * Process-local ordering watermarks, one per subscription id.
 *
 * See `OrderingLedger` in ../billing/stripe.ts for why it is keyed on the
 * subscription and why starting empty after a restart is safe. It is module
 * scoped because the webhook handler is the only writer.
 */
const ordering = newOrderingLedger()

/** Capabilities the caller asked to exercise, used by the metered POST route. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

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
  // The signed-in profile is the ONLY acceptable answer.
  //
  // This used to read an x-omnia-profile header and fall back to body.profileId,
  // which meant any valid bearer - including a thin client token - could name
  // another customer's profile: read their plan, spend their quota, and open a
  // Stripe portal bound to their customer id. A header the caller controls is
  // not an identity.
  // The presented token's own profile wins over every other source. A client
  // token is minted FOR a profile, so reading it answers "who is buying" even
  // when the server itself is signed in as somebody else - or when it is not
  // signed in at all, as in tests. Only when the bearer carries no profile of
  // its own does the server session answer.
  const presented = bearerToken(request)
  const tokenProfile = presented === undefined ? undefined : context.auth.clientTokenProfile(presented)
  if (tokenProfile !== undefined && /^[0-9]{1,32}$/.test(String(tokenProfile.id))) return String(tokenProfile.id)
  const session = context.auth.status().profile
  if (session !== undefined && /^[0-9]{1,32}$/.test(String(session.id))) return String(session.id)
  // No signed-in profile: fall back to a header ONLY when the caller presented
  // the server token, which is the desktop UI's own credential and is not
  // delegable to a third party.
  if (!presentsServerToken(context, request)) return undefined
  const fromHeader = request.headers["x-omnia-profile"]
  const header = Array.isArray(fromHeader) ? fromHeader[0] : fromHeader
  const candidate = typeof header === "string" && header.length > 0 ? header : body.profileId
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > 128) return undefined
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
  // "Readable" has to mean the file actually PARSED. Reporting true for a
  // corrupt file meant the fail-closed policy never armed, so every paid
  // capability came back not_entitled instead of unknown - and the next usage
  // write then rewrote the quarantined data as an empty store, destroying every
  // paid subscription with no alarm and no way back.
  if (!billingStateReadable(file)) return { state: readBillingState(undefined), readable: false }
  try {
    return { state: readBillingState(file), readable: true }
  } catch {
    return { state: readBillingState(undefined), readable: false }
  }
}

function stripeSecret(): string | undefined {
  const key = process.env.STRIPE_SECRET_KEY
  return key !== undefined && key.length > 0 ? key : undefined
}

/**
 * Resolves the customer behind a charge with one pinned API call. Returns
 * undefined when the key is missing, Stripe is unreachable, or the payload
 * does not carry a customer - never guesses, because a wrong attribution
 * revokes somebody else's plan.
 */
async function customerForCharge(chargeId: string): Promise<string | undefined> {
  const secret = stripeSecret()
  if (secret === undefined) return undefined
  try {
    const response = await fetch(`${STRIPE_API}/charges/${encodeURIComponent(chargeId)}`, {
      method: "GET",
      headers: stripeRequestHeaders({ authorization: `Bearer ${secret}` }),
      signal: AbortSignal.timeout(10_000),
    })
    if (response.status !== 200) return undefined
    const body: unknown = await response.json().catch(() => undefined)
    if (!isRecord(body)) return undefined
    const customer = body.customer
    const id = typeof customer === "string" ? customer : isRecord(customer) ? customer.id : undefined
    return typeof id === "string" && id.length > 0 ? id : undefined
  } catch {
    return undefined
  }
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
  /** Stable per profile+plan so a double-clicked button cannot double-charge. */
  readonly idempotencyKey: string
}): Promise<{ readonly url: string } | { readonly error: string }> {
  const form = new URLSearchParams()
  form.set("mode", "subscription")
  form.set("line_items[0][price]", options.priceId)
  form.set("line_items[0][quantity]", "1")
  // The profile id must land ON THE SUBSCRIPTION, not just on the session.
  // Stripe does NOT copy session metadata onto the subscription it creates, so
  // setting only metadata[profileId] here produced subscriptions with no profile
  // and every webhook was silently ignored - checkout appeared to succeed and
  // granted nothing, forever.
  form.set("subscription_data[metadata][profileId]", options.profileId)
  form.set("metadata[profileId]", options.profileId)
  form.set("client_reference_id", options.profileId)
  form.set("success_url", `${options.publicUrl}/?checkout=success`)
  form.set("cancel_url", `${options.publicUrl}/?checkout=cancelled`)
  let response: Response
  try {
    response = await fetch(`${STRIPE_API}/checkout/sessions`, {
      method: "POST",
      headers: stripeRequestHeaders({
        authorization: `Bearer ${options.secret}`,
        "content-type": "application/x-www-form-urlencoded",
        // Without this a second click created a second customer and a second
        // subscription, and "most generous wins" then quietly billed them twice.
        "Idempotency-Key": options.idempotencyKey,
      }),
      body: form.toString(),
      // A hung Stripe call otherwise stalled the request for the runtime's socket
      // timeout, uncancellable.
      signal: AbortSignal.timeout(30_000),
    })
  } catch {
    // A DNS, TLS or socket failure must read as a billing failure, not crash the
    // request into a 500 with a stack trace on a money path.
    return { error: "Could not reach Stripe." }
  }
  const text = await response.text()
  if (!response.ok) return { error: `Stripe rejected the checkout session (HTTP ${response.status}).` }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { error: "Stripe returned a response that was not JSON." }
  }
  return stripeUrl(parsed, "checkout")
}

/**
 * Stripe's own redirect target, or nothing.
 *
 * The response is remote input that ends up in a browser, so it is allowlisted
 * to Stripe's HTTPS hosts. Without this a compromised or spoofed response could
 * hand the user a javascript: URL or an attacker page from a real-looking flow.
 */
function stripeUrl(parsed: unknown, kind: "checkout" | "portal"): { readonly url: string } | { readonly error: string } {
  const url =
    typeof parsed === "object" && parsed !== null && typeof (parsed as { url?: unknown }).url === "string"
      ? (parsed as { url: string }).url
      : undefined
  if (url === undefined || url.length === 0) return { error: `Stripe returned no ${kind} URL.` }
  let parsedUrl: URL
  try {
    parsedUrl = new URL(url)
  } catch {
    return { error: `Stripe returned a ${kind} URL that is not a URL.` }
  }
  const host = parsedUrl.hostname.toLowerCase()
  const allowed = kind === "checkout" ? ["checkout.stripe.com"] : ["billing.stripe.com"]
  if (parsedUrl.protocol !== "https:" || !allowed.includes(host)) {
    return { error: `Stripe returned a ${kind} URL on an unexpected host.` }
  }
  return { url: parsedUrl.toString() }
}

async function createPortalSession(options: {
  readonly secret: string
  readonly customerId: string
  readonly publicUrl: string
}): Promise<{ readonly url: string } | { readonly error: string }> {
  const form = new URLSearchParams()
  form.set("customer", options.customerId)
  form.set("return_url", `${options.publicUrl}/?billing=portal`)
  let response: Response
  try {
    response = await fetch(`${STRIPE_API}/billing_portal/sessions`, {
      method: "POST",
      headers: stripeRequestHeaders({
        authorization: `Bearer ${options.secret}`,
        "content-type": "application/x-www-form-urlencoded",
      }),
      body: form.toString(),
      signal: AbortSignal.timeout(30_000),
    })
  } catch {
    return { error: "Could not reach Stripe." }
  }
  const text = await response.text()
  if (!response.ok) return { error: `Stripe rejected the portal session (HTTP ${response.status}).` }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { error: "Stripe returned a response that was not JSON." }
  }
  return stripeUrl(parsed, "portal")
}

/** Which Stripe events change what. Anything else is acknowledged and ignored. */
function planFromEvent(event: StripeEvent): { readonly plan: PlanId } | undefined {
  const priceId =
    typeof event.data === "object" && event.data !== null
      ? (event.data as { object?: unknown }).object
      : undefined
  // Built so an id can only ever mean ONE plan. The previous object spread let a
  // later key overwrite an earlier one, so setting the pro and business prices to
  // the same value collapsed them and handed a paying "pro" customer the whole
  // business plan, silently, for the pro price.
  const prices: Record<string, PlanId> = {}
  for (const [plan, price] of [
    ["pro", process.env.STRIPE_PRICE_PRO],
    ["business", process.env.STRIPE_PRICE_BUSINESS],
  ] as const) {
    if (price === undefined || price.length === 0) continue
    if (prices[price] !== undefined) {
      // Ambiguous configuration refuses rather than guessing which plan wins.
      return undefined
    }
    prices[price] = plan
  }
  // Read every location Stripe uses, not just a field no real payload carries.
  const id = isRecord(priceId) ? priceIdFromObject(priceId) : undefined
  if (id === undefined) return undefined
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
    if (file === undefined) {
      // Refusing to acknowledge is the point. A 2xx tells Stripe to stop
      // retrying, so acknowledging an event we cannot store takes the customer's
      // money and grants nothing, permanently and with no alarm. A 503 makes
      // Stripe keep delivering until storage exists.
      json(response, 503, { ok: false, error: "Billing storage is not configured, so no plan can be granted." })
      return true
    }
    const { state, readable } = loadState(file)
    if (!readable) {
      // A signed event arriving while the store cannot be parsed must NOT be
      // written: the write would replace the quarantined data with a store
      // holding only this one subscription, silently deleting every other paid
      // account. Refusing here is what keeps a recoverable file recoverable.
      json(response, 503, { ok: false, error: "Billing state could not be read, so the subscription was not applied." })
      return true
    }
    const subscription = subscriptionFromEvent(event)
    const plan = planFromEvent(event)
    if (subscription !== undefined && plan !== undefined) {
      // Ordering, checked BEFORE anything is written. `event.created` was parsed
      // and never used, so an older event delivered after a newer one could undo
      // it - a cancellation landing late would hand the plan back. The check is
      // keyed on the subscription id alone, so events for two different
      // subscriptions may still arrive in any order at all.
      if (superseded(ordering, subscription.subscriptionId, event.created)) {
        json(response, 200, { ok: true, stale: true })
        return true
      }
      const applied = applySubscription(state, subscription, plan.plan, event.id)
      if (!applied.duplicate) {
        try {
          writeBillingState(file, applied.state)
        } catch {
          json(response, 503, { ok: false, error: "Billing state could not be stored." })
          return true
        }
        // Only after the write succeeded: a watermark raised by a write that
        // failed would make Stripe's retry of this very event look stale, and the
        // subscription would be dropped for good.
        recordApplied(ordering, subscription.subscriptionId, event.created)
      }
      json(response, 200, { ok: true, duplicate: applied.duplicate })
      return true
    }
    // A dispute withdraws the money now, with no refund event: the only sound
    // attribution is the disputed charge's customer, which Stripe does not put
    // in the payload, so one pinned lookup resolves it. Failing closed (503)
    // keeps Stripe retrying rather than leaving a disputed plan active.
    const disputedCharge = disputeChargeId(event)
    if (disputedCharge !== undefined) {
      const customerId = await customerForCharge(disputedCharge)
      if (customerId === undefined) {
        json(response, 503, {
          ok: false,
          error: "The disputed charge could not be attributed, so no plan was revoked.",
        })
        return true
      }
      const disputed = state.subscriptions.filter((entry) => entry.customerId === customerId)
      if (disputed.length > 0) {
        try {
          writeBillingState(file, refundSubscriptions(state, disputed, event.id))
        } catch {
          json(response, 503, { ok: false, error: "Billing state could not be stored." })
          return true
        }
        for (const entry of disputed) recordApplied(ordering, entry.subscriptionId, event.created)
      }
      json(response, 200, { ok: true, disputed: disputed.map((entry) => entry.subscriptionId) })
      return true
    }
    // A refunded charge and a failed invoice payment describe no subscription of
    // their own, so they are handled against the subscriptions we already hold.
    // Both were unhandled before, which meant a refunded customer kept their plan
    // until Stripe happened to move the subscription status.
    const refunded = refundedSubscriptions(event, state.subscriptions).filter(
      (entry) => !superseded(ordering, entry.subscriptionId, event.created),
    )
    if (refunded.length > 0) {
      try {
        writeBillingState(file, refundSubscriptions(state, refunded, event.id))
      } catch {
        json(response, 503, { ok: false, error: "Billing state could not be stored." })
        return true
      }
      for (const entry of refunded) recordApplied(ordering, entry.subscriptionId, event.created)
      json(response, 200, { ok: true, refunded: refunded.map((entry) => entry.subscriptionId) })
      return true
    }
    if (defersEntitlement(event)) {
      // Stripe retries the payment itself and only flips the subscription to
      // `unpaid` when it gives up, which is the event that revokes access. See
      // `defersEntitlement` for why the first failed attempt must not cut a
      // customer off.
      json(response, 200, { ok: true, deferred: true, reason: "Payment failed; Stripe will retry." })
      return true
    }
    // Acknowledged on purpose: Stripe retries anything it does not get a 2xx
    // for, and retrying an event we deliberately ignore is pure noise. This is
    // only safe because the two ways to reach here with a REAL purchase - no
    // storage, and no profile on the subscription - are handled above and by
    // the subscription_data metadata respectively.
    json(response, 200, { ok: true, ignored: true })
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
    const now = context.now()
    const plan = decide(state, who, "local_computer", { storeReadable: readable, now }).plan
    const capabilities = Object.fromEntries(
      (Object.keys(PLANS[plan].capabilities) as Capability[]).map((capability) => {
        const decision = decide(state, who, capability, { storeReadable: readable, now })
        const rule = PLANS[plan].capabilities[capability]
        const date = new Date(now)
        const resetsAt = rule.period === "day"
          ? Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1)
          : Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)
        // Always false, and said out loud: this route is a snapshot of what the
        // account has, and asking it what you have must never be what takes it
        // away. The field is here so a caller can tell from the reply alone that
        // nothing was charged, without having to know which route it called.
        return [
          capability,
          {
            allowed: decision.allowed,
            code: decision.code,
            used: decision.used,
            limit: decision.limit,
            metering: rule.metering,
            period: rule.period,
            resetsAt: Number.isFinite(rule.limit) && rule.limit > 0 ? resetsAt : null,
            ...(rule.sessionMinutes === undefined ? {} : { sessionMinutes: rule.sessionMinutes }),
            consumed: false,
          },
        ]
      }),
    )
    const presented = bearerToken(request)
    const profile = presented === undefined ? undefined : context.auth.clientTokenProfile(presented)
    const accountProfile = profile ?? (presentsServerToken(context, request) ? context.auth.status().profile : undefined)
    json(response, 200, {
      ok: true,
      plan,
      computers: PLANS[plan].computers,
      computersUsed: (await context.computers.list()).length,
      ...(accountProfile === undefined ? {} : {
        profile: { login: accountProfile.login, ...(accountProfile.avatarUrl ? { avatarUrl: accountProfile.avatarUrl } : {}) },
      }),
      // Both halves matter: a server with an API key but no webhook secret can
      // take a payment and then never grant the plan, so reporting "configured"
      // on the strength of the key alone is how a customer pays for nothing.
      monthlyUsd: PLANS[plan].monthlyUsd,
      offers: ["pro", "business"].map((id) => ({
        id,
        monthlyUsd: PLANS[id as PlanId].monthlyUsd,
        computers: PLANS[id as PlanId].computers,
      })),
      capabilities,
      billingConfigured: billingConfigured(),
    })
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
    // Spending is the DEFAULT and a read has to be asked for by name. The
    // asymmetry is deliberate and it is the whole safety argument: a call site
    // that never heard of this parameter keeps charging exactly as before, so no
    // enforcement path can stop metering by omission, by a typo, or by a caller
    // that upgrades the server ahead of its own client. Getting it the other way
    // round - charge only when asked - would quietly hand a paid capability away
    // from every gate in the product the first time one was written.
    //
    // Strictly `=== false`, so `consume: "false"`, `0` and `null` all still
    // spend. A truthy value and a missing one are the same answer on purpose.
    const outcome = check(state, who, capability as Capability, {
      storeReadable: readable,
      consume: body.consume !== false,
    })
    let consumed = false
    // Never write usage over a store we could not parse: that would overwrite a
    // quarantined file with an empty one and lose every subscription in it.
    if (outcome.consumed && file !== undefined && readable) {
      try {
        writeBillingState(file, outcome.state)
        consumed = true
      } catch {
        // Failing to persist a counter must not deny a request that was
        // already allowed; the worst case is one un-metered call.
      }
    }
    // `consumed` is reported from what actually landed on disk rather than from
    // what was asked for, so a caller can tell a decision from a preview and a
    // charge that failed to persist from a charge that did not. A read is
    // always false here, which is the property the composer mount and the
    // settings display depend on.
    json(response, outcome.decision.allowed ? 200 : 402, {
      ok: outcome.decision.allowed,
      ...outcome.decision,
      consumed,
    })
    return true
  }

  if (segments[2] === "checkout" && method === "POST") {
    // Starting a purchase, and opening the portal that can change the card or
    // cancel a subscription, must require the SIGNED-IN DESKTOP rather than any
    // token that satisfies isAuthorized - a paired thin client has one. That is
    // isTrustedDesktopRequest and NOT isOperatorRequest: the desktop app holds a
    // client token minted by the sign-in flow, never the server token, so the
    // operator check answered every real purchase with 403 while letting nothing
    // through. Agent-provisioned tokens are still excluded.
    if (!isTrustedDesktopRequest(context, request, body)) {
      json(response, 403, { ok: false, error: "Only the signed-in desktop may manage billing." })
      return true
    }
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
    // Refuse to SELL when the resulting subscription could not be granted. The
    // webhook answers 503 without storage, so charging anyway took the money and
    // then failed to deliver the plan, with Stripe stopping its retries.
    if (billingFile(context) === undefined || !billingStateReadable(billingFile(context))) {
      json(response, 503, { ok: false, error: "Billing storage is not writable on this server, so checkout is unavailable." })
      return true
    }
    const session = await createCheckoutSession({
      secret,
      priceId,
      profileId: who,
      publicUrl,
      idempotencyKey: `omnia-checkout-${plan}-${who}`,
    })
    if ("error" in session) {
      json(response, 502, { ok: false, error: session.error })
      return true
    }
    json(response, 200, { ok: true, url: session.url })
    return true
  }

  if (segments[2] === "portal" && method === "POST") {
    if (!isTrustedDesktopRequest(context, request, body)) {
      json(response, 403, { ok: false, error: "Only the signed-in desktop may manage billing." })
      return true
    }
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
    if (publicUrl.length === 0) {
      json(response, 503, { ok: false, error: "This server has no public URL for Stripe to return to." })
      return true
    }
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

/**
 * Marks refunded subscriptions as no longer entitling, in one write.
 *
 * Folded in place by subscription id, exactly like a subscription update, so the
 * rest of the profile's subscriptions are untouched and the event id is
 * remembered, which makes a replayed refund a no-op. The plan is deliberately
 * left on the record: a refund revokes access, it does not rewrite what somebody
 * bought, so a later, newer subscription event restores the plan without any
 * reconciliation.
 */
function refundSubscriptions(
  state: BillingState,
  refunded: readonly HeldSubscription[],
  eventId: string,
): BillingState {
  const revoked = new Set(refunded.map((entry) => entry.subscriptionId))
  return {
    ...state,
    subscriptions: state.subscriptions.map((entry) =>
      revoked.has(entry.subscriptionId) ? { ...entry, status: REFUNDED } : entry,
    ),
    // Mirrors the store's own cap on remembered event ids.
    processedEvents: [...state.processedEvents, eventId].slice(-1000),
  }
}

/** Exposed so the server can report whether billing is wired up at all. */
export function billingConfigured(): boolean {
  // Every variable a purchase needs, not just the two. Reporting "configured"
  // from the API key and webhook secret alone let a server missing a price id or
  // a storage path advertise itself healthy, take the money, and grant nothing.
  const prices = [process.env.STRIPE_PRICE_PRO, process.env.STRIPE_PRICE_BUSINESS]
  return (
    stripeSecret() !== undefined &&
    (process.env.STRIPE_WEBHOOK_SECRET ?? "").length > 0 &&
    (process.env.OMNIA_PUBLIC_URL ?? "").length > 0 &&
    prices.every((price) => (price ?? "").length > 0) &&
    process.env.STRIPE_PRICE_PRO !== process.env.STRIPE_PRICE_BUSINESS &&
    billingFile({} as never) !== undefined
  )
}

export { entitles, presentsServerToken, isTrustedDesktopRequest }
