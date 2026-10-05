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
export type SubscriptionStatus = "active" | "trialing" | "past_due" | "canceled" | "unpaid" | "incomplete"

/** States that still entitle the customer. `past_due` is a grace period. */
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
  const periodEnd = object.current_period_end
  if (
    typeof customerId !== "string" ||
    customerId.length === 0 ||
    typeof subscriptionId !== "string" ||
    subscriptionId.length === 0 ||
    typeof status !== "string" ||
    typeof profileId !== "string" ||
    profileId.length === 0 ||
    typeof periodEnd !== "number"
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