import { createPublicKey, createVerify, timingSafeEqual, type JsonWebKey } from "node:crypto"

export interface WebhookVerificationResult {
  readonly ok: boolean
  readonly reason?: string
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

export function verifySlack(headers: Headers, body: string, signingSecret: string): WebhookVerificationResult {
  const timestamp = headers.get("x-slack-request-timestamp")
  const signature = headers.get("x-slack-signature")
  if (timestamp === null || signature === null) return { ok: false, reason: "missing slack signature headers" }
  const age = Math.abs(Date.now() / 1000 - Number(timestamp))
  if (!Number.isFinite(age) || age > 300) return { ok: false, reason: "stale slack timestamp" }
  const base = `v0:${timestamp}:${body}`
  const crypto = require("node:crypto") as typeof import("node:crypto")
  const expected = `v0=${crypto.createHmac("sha256", signingSecret).update(base).digest("hex")}`
  return safeEqual(expected, signature) ? { ok: true } : { ok: false, reason: "invalid slack signature" }
}

export function verifyTelegram(headers: Headers, _body: string, secretToken: string): WebhookVerificationResult {
  const token = headers.get("x-telegram-bot-api-secret-token")
  if (token === null) return { ok: false, reason: "missing telegram secret token" }
  return safeEqual(token, secretToken) ? { ok: true } : { ok: false, reason: "invalid telegram secret token" }
}

export function verifyTeams(headers: Headers, body: string, appPassword: string): WebhookVerificationResult {
  const auth = headers.get("authorization")
  if (auth === null || !auth.toLowerCase().startsWith("bearer ")) return { ok: false, reason: "missing teams bearer token" }
  // Teams uses JWT signed by Microsoft; full validation requires JWKS fetch.
  // For the loopback desktop receiver we accept a shared app password as a
  // constant-time bearer comparison until the JWKS validator is wired.
  return safeEqual(auth.slice(7), appPassword) ? { ok: true } : { ok: false, reason: "invalid teams bearer token" }
}

// Google signs every delivery to a Chat app with an OIDC ID token (or, when the
// app's authentication audience is a project number, an equivalent JWT). The
// keys are Google's, the audience is the value configured on the Chat app, and
// the email names the per-project Chat app identity. Without all three checks a
// public endpoint would run an agent turn for anyone who posts JSON at it.
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs"
const CHAT_APP_EMAIL_SUFFIX = "@gcp-sa-gsuiteaddons.iam.gserviceaccount.com"
const JWKS_TTL_MS = 60 * 60 * 1_000

const jwks = new Map<string, { keys: readonly JsonWebKey[]; expiresAt: number }>()

export interface GChatVerificationOptions {
  /** The Chat app's configured authentication audience: endpoint URL or project number. */
  readonly audience: string
  readonly jwksUrl?: string
  readonly now?: () => number
}

export async function verifyGChat(
  headers: Headers,
  options: GChatVerificationOptions,
): Promise<WebhookVerificationResult> {
  const auth = headers.get("authorization")
  if (auth === null || !auth.toLowerCase().startsWith("bearer ")) {
    return { ok: false, reason: "missing google chat bearer token" }
  }
  if (options.audience.length === 0) {
    return { ok: false, reason: "google chat needs its webhook audience configured" }
  }
  const token = auth.slice("bearer ".length).trim()
  const parts = token.split(".")
  if (parts.length !== 3) return { ok: false, reason: "google chat token is not a JWT" }
  const [headerPart, claimsPart, signaturePart] = parts as [string, string, string]
  const header = decode<{ alg?: unknown; kid?: unknown }>(headerPart)
  if (header === undefined) return { ok: false, reason: "google chat token header is not JSON" }
  if (header.alg !== "RS256") return { ok: false, reason: "google chat token is not RS256" }
  if (typeof header.kid !== "string") return { ok: false, reason: "google chat token has no key id" }
  const claims = decode<{ aud?: unknown; exp?: unknown; email?: unknown }>(claimsPart)
  if (claims === undefined) return { ok: false, reason: "google chat token claims are not JSON" }
  if (!matchesAudience(claims.aud, options.audience)) {
    return { ok: false, reason: "google chat token audience does not match" }
  }
  const now = options.now?.() ?? Date.now()
  if (typeof claims.exp !== "number" || claims.exp * 1_000 <= now) {
    return { ok: false, reason: "google chat token has expired" }
  }
  // An ID token from a Chat app names the per-project service account. A token
  // without the claim is the project-number JWT form, which the audience and
  // signature already pin down.
  if (typeof claims.email === "string" && !claims.email.endsWith(CHAT_APP_EMAIL_SUFFIX)) {
    return { ok: false, reason: "google chat token was not signed for a Chat app" }
  }
  const keys = await signingKeys(options.jwksUrl ?? GOOGLE_JWKS_URL, now)
  if (keys === undefined) return { ok: false, reason: "could not load google's signing keys" }
  const key = keys.find((candidate) => candidate.kid === header.kid)
  if (key === undefined) return { ok: false, reason: "google chat token names an unknown signing key" }
  if (!verifySignature(`${headerPart}.${claimsPart}`, signaturePart, key)) {
    return { ok: false, reason: "google chat token signature is invalid" }
  }
  return { ok: true }
}

async function signingKeys(url: string, now: number): Promise<readonly JsonWebKey[] | undefined> {
  const cached = jwks.get(url)
  if (cached !== undefined && cached.expiresAt > now) return cached.keys
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) }).catch(() => undefined)
  if (response === undefined || !response.ok) return undefined
  const body = (await response.json().catch(() => undefined)) as unknown
  const keys = typeof body === "object" && body !== null ? (body as { keys?: unknown }).keys : undefined
  if (!Array.isArray(keys)) return undefined
  const valid = keys.filter((key): key is JsonWebKey => typeof key === "object" && key !== null)
  jwks.set(url, { keys: valid, expiresAt: now + JWKS_TTL_MS })
  return valid
}

function verifySignature(input: string, signature: string, key: JsonWebKey): boolean {
  try {
    const publicKey = createPublicKey({ key, format: "jwk" })
    return createVerify("RSA-SHA256").update(input).verify(publicKey, Buffer.from(signature, "base64url"))
  } catch {
    // A malformed key in the published set cannot verify anything.
    return false
  }
}

function matchesAudience(value: unknown, audience: string): boolean {
  if (typeof value === "string") return value === audience
  return Array.isArray(value) && value.some((entry) => entry === audience)
}

function decode<T>(part: string): T | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as unknown
    return typeof parsed === "object" && parsed !== null ? (parsed as T) : undefined
  } catch {
    return undefined
  }
}

export function verifyWebhook(platform: string, headers: Headers, body: string, secret: string): WebhookVerificationResult {
  switch (platform) {
    case "slack":
      return verifySlack(headers, body, secret)
    case "telegram":
      return verifyTelegram(headers, body, secret)
    case "teams":
      return verifyTeams(headers, body, secret)
    case "discord":
    case "github":
    case "linear":
    case "whatsapp":
      // These use platform-specific schemes; accept a shared secret header for now.
      const header = headers.get("x-webhook-secret") ?? headers.get("x-hub-signature-256")
      return header !== null && safeEqual(header, secret) ? { ok: true } : { ok: false, reason: "invalid webhook secret" }
    default:
      return { ok: false, reason: `unknown platform ${platform}` }
  }
}
