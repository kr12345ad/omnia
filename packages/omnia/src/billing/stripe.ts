// Stripe webhook verification and event folding.
//
// This is deliberately the smallest amount of Stripe surface that can be correct:
// there is no SDK dependency, no retry state machine and no API client here. A
// webhook that is not verified with the raw request bytes is a forgery, so the
// signature check happens before the body is parsed and before anything is
// written, and nothing in this file trusts a field it has not type-checked.
//
// The secret is read from the environment and never accepted from a caller.
import { createHmac, timingSafeEqual } from "node:crypto"
import { isPlanId, type PlanId } from "./plans.js"

/** Stripe's own default. Anything older is a replay. */
export const SIGNATURE_TOLERANCE_SECONDS = 300

/**
 * The API version every OUTBOUND Stripe call is pinned to.
 *
 * WHY PINNED, AND WHY THIS ONE:
 *
 * Stripe versions the REST API per account, not per integration. With no
 * `Stripe-Version` header the account's DEFAULT version applies, and Stripe moves
 * that default when the account is upgraded - with no deploy on our side and
 * nothing failing. On 2025-03-31.basil `current_period_end` moved off the
 * subscription object onto `items.data[]`, because a subscription may now hold
 * items with different billing cycles and "the" period stopped meaning anything.
 * Reading only the old location therefore ignores every single event on the new
 * one, and the webhook answers `{ok:true,ignored:true}` for all of them: customers
 * silently dropped to the free plan while still being charged, invisibly.
 *
 * 2024-10-28.acacia is the last version in which the subscription object itself
 * carries `current_period_end`, i.e. the payload shape this code was written
 * against - and it also carries `items.data[].current_period_end`, so the
 * dual-location read below is correct under the pin as well. Pinning therefore
 * freezes a shape we UNDERSTAND rather than one we merely tolerate, and an
 * operator who deliberately moves forward can do it with STRIPE_API_VERSION and
 * no code change.
 */
export const PINNED_STRIPE_API_VERSION = "2024-10-28.acacia"

/** `YYYY-MM-DD.name`, which is every shape Stripe has ever published. */
const API_VERSION_PATTERN = /^\d{4}-\d{2}-\d{2}\.[a-z][a-z0-9]{0,15}$/

/**
 * The version to send: our pin, unless the operator overrode it.
 *
 * The override is validated rather than passed through. This value becomes an
 * outbound header, and an unvalidated string from the environment containing a
 * comma, a space or a newline would either be rejected by Stripe as a malformed
 * request or split into extra headers. An unusable override degrades to the pin
 * rather than throwing: a typo in configuration must not take the money path
 * down, and the pin is known-good.
 */
export function stripeApiVersion(): string {
  const override = process.env.STRIPE_API_VERSION?.trim()
  return override !== undefined && API_VERSION_PATTERN.test(override) ? override : PINNED_STRIPE_API_VERSION
}

/**
 * The headers every outbound Stripe request carries.
 *
 * The version is applied LAST so no call site can drop or override it by
 * forgetting: there is exactly one place that decides which version we speak.
 * The secret is passed in from the environment by the caller and never travels
 * through here.
 */
export function stripeRequestHeaders(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  return { ...extra, "Stripe-Version": stripeApiVersion() }
}

export class StripeSignatureError extends Error {
  readonly code = "invalid_stripe_signature"
  readonly status = 400

  constructor(reason: string) {
    super(`Stripe signature rejected: ${reason}`)
    this.name = "StripeSignatureError"
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8")
  const right = Buffer.from(b, "utf8")
  // timingSafeEqual throws on a length mismatch, and the length of a hex digest
  // is not secret, so compare lengths first and still return false.
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

export interface ParsedSignature {
  readonly timestamp: number
  readonly signatures: readonly string[]
}

/**
 * `Stripe-Signature: t=1492774577,v1=5257a869e7ec...,v0=ignored`
 *
 * Malformed input yields no usable timestamp or no v1 at all, which the verify
 * step turns into a rejection rather than a comparison against "".
 */
export function parseSignatureHeader(header: string | undefined | null): ParsedSignature {
  if (header === undefined || header === null || header.length === 0) {
    throw new StripeSignatureError("the signature header is missing")
  }
  let timestamp: number | undefined
  const signatures: string[] = []
  for (const part of header.split(",")) {
    const separator = part.indexOf("=")
    if (separator <= 0) continue
    const key = part.slice(0, separator).trim()
    const value = part.slice(separator + 1).trim()
    if (key === "t") {
      const parsed = Number(value)
      if (Number.isSafeInteger(parsed) && parsed > 0) timestamp = parsed
      continue
    }
    // v1 carries the signatures; v0 and any future scheme are ignored on purpose.
    if (key === "v1" && value.length > 0) signatures.push(value)
  }
  if (timestamp === undefined) throw new StripeSignatureError("the header carries no timestamp")
  if (signatures.length === 0) throw new StripeSignatureError("the header carries no v1 signature")
  return { timestamp, signatures }
}

/**
 * Verifies the signature over the RAW body.
 *
 * `rawBody` must be the exact bytes Stripe sent. Re-serializing a parsed object
 * changes the key order and whitespace and will not verify.
 */
export function verifyStripeSignature(
  rawBody: string,
  header: string | undefined | null,
  secret: string,
  options: { readonly nowSeconds?: number; readonly toleranceSeconds?: number } = {},
): ParsedSignature {
  if (secret.length === 0) throw new StripeSignatureError("no webhook secret is configured")
  const { timestamp, signatures } = parseSignatureHeader(header)
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000)
  const tolerance = options.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS
  // A clock that is wildly off would otherwise reject every real event, so the
  // skew is bounded rather than absolute.
  if (Math.abs(now - timestamp) > tolerance) {
    throw new StripeSignatureError(`the timestamp is outside the ${tolerance}s tolerance`)
  }
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex")
  if (!signatures.some((candidate) => constantTimeEquals(candidate, expected))) {
    throw new StripeSignatureError("no signature matched")
  }
  return { timestamp, signatures }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** The subscription states Stripe can leave an account in. */
export type SubscriptionStatus =
  | "active"
  | "trialing"
  | "past_due"
  | "canceled"
  | "unpaid"
  | "incomplete"
  | "refunded"

/**
 * Not a Stripe status: our own marker for "the money for this subscription came
 * back". It is deliberately absent from ENTITLING, so a refunded customer
 * resolves to the free plan at once and stays there until a NEWER subscription
 * event says otherwise. A refund may only ever REMOVE access - there is no code
 * path anywhere in this file that grants, extends or restores a plan from one.
 */
export const REFUNDED: SubscriptionStatus = "refunded"

/**
 * States that still entitle the customer. `past_due` is a grace period, and
 * `refunded` is missing on purpose.
 */
const ENTITLING: ReadonlySet<string> = new Set(["active", "trialing", "past_due"])

export interface StripeSubscription {
  readonly customerId: string
  readonly subscriptionId: string
  readonly status: SubscriptionStatus
  /** Which Omnia profile this Stripe customer belongs to. */
  readonly profileId: string
  readonly currentPeriodEnd: number
}

export interface StripeEvent {
  readonly id: string
  readonly type: string
  readonly created: number
  readonly data: unknown
}

export function parseStripeEvent(rawBody: string): StripeEvent {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    throw new StripeSignatureError("the body is not JSON")
  }
  if (!isRecord(parsed)) throw new StripeSignatureError("the body is not an object")
  const { id, type, created, data } = parsed
  if (typeof id !== "string" || id.length === 0 || id.length > 255) {
    throw new StripeSignatureError("the event has no usable id")
  }
  if (typeof type !== "string" || type.length === 0) throw new StripeSignatureError("the event has no type")
  return {
    id,
    type,
    created: typeof created === "number" && Number.isFinite(created) ? created : 0,
    data,
  }
}

/**
 * Folds a subscription event into the subscription it describes.
 *
 * Only the fields this codebase acts on are read, and each is type-checked, so a
 * hostile or simply unexpected payload shape becomes "ignore this event" rather
 * than a plan upgrade nobody paid for.
 */
export function subscriptionFromEvent(event: StripeEvent): StripeSubscription | undefined {
  if (!isRecord(event.data)) return undefined
  const object = event.data.object
  if (!isRecord(object)) return undefined
  const customer = object.customer
  const customerId = typeof customer === "string" ? customer : isRecord(customer) ? customer.id : undefined
  const subscriptionId = typeof object.id === "string" ? object.id : undefined
  const status = typeof object.status === "string" ? object.status : undefined
  const profileId = object.metadata !== undefined && isRecord(object.metadata) ? object.metadata.profileId : undefined
  const periodEnd = periodEndSeconds(object)
  if (
    typeof customerId !== "string" ||
    customerId.length === 0 ||
    typeof subscriptionId !== "string" ||
    subscriptionId.length === 0 ||
    typeof status !== "string" ||
    typeof profileId !== "string" ||
    profileId.length === 0 ||
    periodEnd === undefined
  ) {
    return undefined
  }
  const periodEndMs = periodEnd * 1000
  return {
    customerId,
    subscriptionId,
    status: normalizeStatus(status),
    profileId,
    currentPeriodEnd: Number.isFinite(periodEndMs) ? periodEndMs : 0,
  }
}

/**
 * The end of the paid period, in seconds, from wherever this API version put it.
 *
 * 2024-10-28.acacia and earlier carry `current_period_end` on the subscription
 * object; 2025-03-31.basil and later carry it only on `items.data[]`. Both are
 * read here because reading one location alone means every event in the other
 * shape is silently ignored - the webhook still answers 200, so nothing anywhere
 * reports the loss.
 *
 * When items disagree the LATEST end wins. A subscription with an item on a
 * different cycle is paid through its longest item, and truncating to the
 * earliest would revoke access somebody paid for. The period is not the
 * authority on whether access continues anyway: the plan goes the moment Stripe's
 * own status says so (`canceled`, `unpaid`, and now `refunded`).
 *
 * Neither location present means the event is unusable, and an unusable event is
 * discarded rather than half-applied - the same fail-closed rule as a missing
 * customer or a missing profile.
 */
function periodEndSeconds(object: Record<string, unknown>): number | undefined {
  if (typeof object.current_period_end === "number") return object.current_period_end
  const items = object.items
  if (!isRecord(items) || !Array.isArray(items.data)) return undefined
  return items.data.reduce<number>((latest, item) => {
    const end = isRecord(item) && typeof item.current_period_end === "number" ? item.current_period_end : 0
    return end > latest ? end : latest
  }, 0)
}

/**
 * The price a subscription is actually billed on.
 *
 * `price.id` on the subscription object does not exist in Stripe's payloads -
 * the price lives at `items.data[].price.id` (and a Checkout Session carries its
 * own `price` for the one-time part). Reading only the object-level field meant a
 * genuine `customer.subscription.updated` matched no configured price, the webhook
 * answered 200 {ignored:true}, and the customer's payment was never granted -
 * silently, because a 2xx is exactly what tells Stripe to stop retrying.
 *
 * Every location is read and the FIRST match wins, because an event that carries
 * more than one of them is describing the same purchase.
 */
export function priceIdFromObject(object: Record<string, unknown>): string | undefined {
  const direct = object.price
  if (isRecord(direct) && typeof direct.id === "string" && direct.id.length > 0) return direct.id
  const items = object.items
  if (isRecord(items) && Array.isArray(items.data)) {
    for (const item of items.data) {
      if (!isRecord(item)) continue
      const price = item.price
      if (isRecord(price) && typeof price.id === "string" && price.id.length > 0) return price.id
    }
  }
  return undefined
}

function normalizeStatus(status: string): SubscriptionStatus {
  switch (status) {
    case "active":
    case "trialing":
    case "past_due":
    case "canceled":
    case "unpaid":
    case "incomplete":
      return status
    default:
      return "incomplete"
  }
}

export function entitles(status: SubscriptionStatus): boolean {
  return ENTITLING.has(status)
}

/** Maps a Stripe price id onto a plan. An unknown price grants nothing. */
export function planForPrice(priceId: string, prices: Readonly<Record<string, PlanId>>): PlanId | undefined {
  const plan = prices[priceId]
  return isPlanId(plan) ? plan : undefined
}

/**
 * How far the webhook has got, one watermark per subscription id.
 *
 * `event.created` is parsed and, until now, thrown away, which left ordering to
 * luck. Stripe does NOT promise delivery order, so a cancellation created at
 * 10:00:01 can be delivered after an update created at 10:00:05 and undo it -
 * re-granting a plan somebody cancelled, or reverting a downgrade, with no error
 * anywhere to explain it.
 *
 * Keyed on SUBSCRIPTION ID ONLY, never on profile or customer. That is the whole
 * trick: the legitimate out-of-order case in this codebase is one profile moving
 * from sub_A to sub_B, where the old subscription's cancellation legitimately
 * arrives late and must still be applied to sub_A. A watermark shared across
 * subscriptions would swallow exactly that event and leave a cancelled
 * subscription live.
 *
 * Process-local on purpose. The durable half of replay protection is
 * `processedEvents` in the billing store; this covers the half that store cannot
 * express, namely "a newer event for this subscription already landed". It starts
 * empty after a restart, and an empty ledger can only ever accept an event, never
 * reject a legitimate one.
 */
export interface OrderingLedger {
  /** subscriptionId -> highest `event.created` already applied, in seconds. */
  readonly applied: Map<string, number>
}

/** Bounded, because the keys are remote input and an unbounded map is a leak. */
const MAX_TRACKED_SUBSCRIPTIONS = 5000

export function newOrderingLedger(): OrderingLedger {
  return { applied: new Map() }
}

/**
 * Whether this event is provably older than one already applied.
 *
 * Only a STRICTLY older event is stale. `created` is whole seconds, so two events
 * for one subscription can share a timestamp, and refusing ties would drop a real
 * cancellation that landed in the same second as the update it follows.
 *
 * An event with no usable `created` (0) is never treated as stale: we cannot
 * prove it is old, and refusing events on a guess is how a paying customer loses
 * their plan. Staleness has to be provable to be acted on.
 */
export function superseded(ledger: OrderingLedger, subscriptionId: string, created: number): boolean {
  const applied = ledger.applied.get(subscriptionId)
  return applied !== undefined && created > 0 && created < applied
}

/**
 * Raises the watermark, and ONLY after the new state has been stored.
 *
 * Recording first would make a failed write look applied, so Stripe's retry of
 * that same event would then be rejected as stale and the subscription would be
 * lost for good. A `created` of 0 proves nothing about order, so it moves the
 * watermark in neither direction.
 */
export function recordApplied(ledger: OrderingLedger, subscriptionId: string, created: number): void {
  if (!Number.isSafeInteger(created) || created <= 0) return
  const applied = ledger.applied.get(subscriptionId)
  if (applied !== undefined && applied >= created) return
  ledger.applied.set(subscriptionId, created)
  // Map iteration is insertion-ordered, so the oldest subscription id is the one
  // evicted when the cap is hit.
  while (ledger.applied.size > MAX_TRACKED_SUBSCRIPTIONS) {
    const oldest = ledger.applied.keys().next()
    if (oldest.done === true) return
    ledger.applied.delete(oldest.value)
  }
}

/** Just the two keys a refund needs to identify a subscription we already hold. */
export interface HeldSubscription {
  readonly customerId: string
  readonly subscriptionId: string
}

/**
 * The subscriptions a `charge.refunded` event takes access away from.
 *
 * THE POLICY, and why it is this narrow:
 *
 *   - A charge names a customer and at most an invoice. It does NOT name a
 *     subscription, so the only sound key we hold is the customer id, and every
 *     subscription we hold for that customer is downgraded together. Guessing at
 *     one of them would leave a refunded customer on the plan they did not pay
 *     for.
 *   - Only a FULL refund counts. Stripe fires `charge.refunded` for a partial
 *     refund too, with `refunded: false`, and money back for one invoice must not
 *     revoke a whole plan.
 *   - The result can only ever be used to REMOVE entitlement (see REFUNDED). No
 *     input shape here can grant, extend or restore anything.
 *   - An unknown customer, a missing flag or a payload we cannot read yields no
 *     subscriptions at all, which the caller treats as "nothing to do".
 */
export function refundedSubscriptions(
  event: StripeEvent,
  held: readonly HeldSubscription[],
): readonly HeldSubscription[] {
  if (event.type !== "charge.refunded" || !isRecord(event.data)) return []
  const object = event.data.object
  if (!isRecord(object) || object.refunded !== true) return []
  const customer = object.customer
  const customerId = typeof customer === "string" ? customer : isRecord(customer) ? customer.id : undefined
  if (typeof customerId !== "string" || customerId.length === 0) return []
  return held.filter((entry) => entry.customerId === customerId)
}

/**
 * Whether an event is acknowledged WITHOUT touching entitlements.
 *
 * THE POLICY for `invoice.payment_failed`: Stripe smart-retries a failed payment
 * several times across roughly a week and only then flips the subscription to
 * `unpaid`, which is the signal that actually revokes access. Revoking on the
 * first failed attempt would cut off a customer whose card merely expired for a
 * day - pure support load and chargebacks, for no money saved - so the failure is
 * recorded as seen and left to Stripe's own state machine, which this codebase
 * already honours: `past_due` still entitles as a grace period, `unpaid` does
 * not. The retry Stripe keeps making arrives as a newer subscription event and
 * is applied normally.
 */
export function defersEntitlement(event: StripeEvent): boolean {
  return event.type === "invoice.payment_failed"
}