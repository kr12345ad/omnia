// Sponsored ads, served from the control plane.
//
// The browser app never holds the Gravity publisher key. It asks this route for
// one below-response ad and gets back an already-normalized card; the key and
// the matching request live here, on the server.
//
// This is NOT a public route. It is deliberately absent from isPublicApiRoute,
// so an anonymous caller, a browser address bar and a crawler all meet the same
// bearer gate as every other /v1 route. Only a signed-in desktop client token,
// or the operator's own server token, can reach it.
//
// Ads are best-effort: a missing key, a timeout, a 204 and a rejected publisher
// all answer with an empty list rather than an error, because an ad must never
// be able to interrupt a conversation.
import type { IncomingMessage, ServerResponse } from "node:http"
import {
  bearerToken,
  json,
  presentsServerToken,
  readBodyBytes,
  type ApiContext,
  type ParsedRequest,
} from "./api.js"

const ENDPOINT = "https://server.trygravity.com/api/v1/ad"
const TIMEOUT_MS = 3_000
const MAX_SESSION_ID = 200
const MAX_CONTEXT = 2_000
const MAX_UA = 500
const MAX_OS = 40

export interface SponsoredAd {
  readonly adText: string
  readonly title: string
  readonly brandName: string
  readonly cta: string
  readonly url?: string
  readonly favicon?: string
  /** The tracked link. Opening `url` instead would not record the click. */
  readonly clickUrl: string
  /** Fired once, when at least half the card is visible. */
  readonly impUrl: string
  readonly placement: string
  readonly placementId: string
}

export async function handleAdsRoute(
  context: ApiContext,
  request: IncomingMessage,
  response: ServerResponse,
  parsed: ParsedRequest,
): Promise<boolean> {
  if (parsed.segments[1] !== "ads") return false
  if (request.method !== "POST" || parsed.segments.length !== 2) {
    json(response, 404, { ok: false, error: "Unknown ads route." })
    return true
  }

  // Entitlements and ads are both per profile. A client token carries the
  // profile it was minted for; the operator's server token does not, so the
  // signed-in server profile answers only for the operator credential.
  const presented = bearerToken(request)
  const tokenProfile = presented === undefined ? undefined : context.auth.clientTokenProfile(presented)
  const profile =
    tokenProfile ?? (presentsServerToken(context, request) ? context.auth.status().profile : undefined)
  if (profile === undefined) {
    json(response, 401, { ok: false, error: "Sign in to receive ads." })
    return true
  }

  const body = await readJson(request)
  const sessionId = text(body?.sessionId, MAX_SESSION_ID)
  const adContext = text(body?.context, MAX_CONTEXT)
  if (sessionId === undefined || adContext === undefined) {
    json(response, 400, { ok: false, error: "A session id and the last request are required." })
    return true
  }

  const forwarded = header(request, "x-forwarded-for")?.split(",")[0]?.trim()
  const ads = await requestGravity({
    sessionId,
    context: adContext,
    profileId: String(profile.id),
    ua: text(body?.ua, MAX_UA) ?? header(request, "user-agent"),
    ip: text(body?.ip, 64) ?? forwarded ?? request.socket.remoteAddress,
    os: text(body?.os, MAX_OS) ?? "desktop",
  })

  // Sponsored content is per-request, and a cached answer would show somebody
  // else's ad. Never store it anywhere along the path.
  response.setHeader("cache-control", "no-store")
  json(response, 200, { ok: true, ads })
  return true
}

async function requestGravity(input: {
  sessionId: string
  context: string
  profileId: string
  ua?: string
  ip?: string
  os: string
}): Promise<SponsoredAd[]> {
  const key = process.env.GRAVITY_API_KEY
  if (key === undefined || key.length === 0) return []

  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: input.context }],
      sessionId: input.sessionId,
      placements: [{ placement: "below_response", placement_id: "main" }],
      user: { id: input.profileId, tags: { plan: "free" } },
      // The control plane's own address would describe a datacentre, not the
      // person reading the reply, so the browser's user agent is forwarded and
      // the client platform is passed through when the app sends it.
      device: {
        ...(input.ua === undefined ? {} : { ua: input.ua }),
        ...(input.ip === undefined ? {} : { ip: input.ip }),
        os: input.os,
      },
      relevancy: 0.2,
      // Production requests answer 403 until the publisher is approved. Test
      // ads let the slot be built and reviewed without pretending revenue.
      testAd: process.env.GRAVITY_PRODUCTION !== "1",
      // Test mode only: a 204 leaves the slot empty, which makes a new
      // integration look broken. alwaysReturn gives a test card instead.
      ...(process.env.GRAVITY_PRODUCTION === "1" ? {} : { alwaysReturn: true }),
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => undefined)

  // 204 is the documented "no ad matched", and every failure is the same answer
  // for the slot.
  if (response === undefined || response.status !== 200) return []
  const body: unknown = await response.json().catch(() => undefined)
  if (!Array.isArray(body)) return []
  return body.flatMap(normalizeAd)
}

function normalizeAd(value: unknown): SponsoredAd[] {
  if (!record(value)) return []
  const clickUrl = https(value.clickUrl)
  const impUrl = https(value.impUrl)
  // Both tracked URLs are required: an untracked click is a broken promise to
  // the advertiser and an unfired impression is a slot nobody was paid for.
  if (clickUrl === undefined || impUrl === undefined) return []
  const title = text(value.title, 200)
  const adText = text(value.adText, 600)
  if (title === undefined && adText === undefined) return []
  const brandName = text(value.brandName, 200) ?? title ?? ""
  const url = https(value.url)
  const favicon = https(value.favicon)
  return [
    {
      adText: adText ?? "",
      title: title ?? brandName,
      brandName,
      cta: text(value.cta, 80) ?? "Learn more",
      ...(url === undefined ? {} : { url }),
      ...(favicon === undefined ? {} : { favicon }),
      clickUrl,
      impUrl,
      placement: text(value.placement, 40) ?? "below_response",
      placementId: text(value.placementId, 60) ?? text(value.placement_id, 60) ?? "main",
    },
  ]
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  return readBodyBytes(request)
    .then((bytes) => JSON.parse(bytes.toString("utf8")))
    .then((value) => (record(value) ? value : undefined))
    .catch(() => undefined)
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name]
  if (Array.isArray(value)) return value[0]
  return value
}

/** A trimmed non-empty string, or undefined when the value is not one. */
function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed.slice(0, max)
}

/**
 * An https URL, or undefined.
 *
 * The renderer opens clickUrl and loads impUrl, so a javascript: or data: value
 * from the ad response would turn an ad into script execution. Only https is
 * accepted; the plain-http landing page is still reachable through the tracked
 * redirect.
 */
function https(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const url = URL.parse(value)
  return url !== null && url.protocol === "https:" ? url.toString() : undefined
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
