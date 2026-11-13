// The desktop side of sponsored ads.
//
// The Gravity publisher key lives on the control plane, so this process holds no
// ad credential at all. It sends the last thing the person asked to
// POST /v1/ads and receives an already-normalized card back; a signed-out
// desktop has no client token and therefore no ad request.
//
// Every failure, timeout and missing key resolves to no ad. A sponsored slot is
// an addition to a free conversation and must never be able to fail or slow one.
import { ipcMain } from "electron"
import { controlPlaneCall } from "./control-plane"

export const ADS_CHANNEL = "ads-get"

const MAX_CONTEXT = 2_000
const MAX_SESSION_ID = 200
const MAX_UA = 500

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

export function registerAdsIpcHandlers(): void {
  ipcMain.handle(ADS_CHANNEL, (_event, input: unknown) => requestSponsoredAd(input))
}

/**
 * Asks the control plane for one below-response ad.
 *
 * The profile is the one the signed-in client token was minted for, resolved on
 * the server, so per-user frequency capping follows the account rather than a
 * constant.
 */
export async function requestSponsoredAd(input: unknown): Promise<SponsoredAd[]> {
  const request = readRequest(input)
  if (request === undefined) return []

  const response = await controlPlaneCall("/v1/ads", "POST", {
    sessionId: request.sessionId,
    context: request.context,
    ...(request.ua === undefined ? {} : { ua: request.ua }),
  }).catch(() => undefined)
  if (response === undefined || !Array.isArray(response.ads)) return []
  return response.ads.flatMap(normalizeAd)
}

function readRequest(value: unknown): { sessionId: string; context: string; ua?: string } | undefined {
  if (!record(value)) return undefined
  const sessionId = text(value.sessionId, MAX_SESSION_ID)
  const context = text(value.context, MAX_CONTEXT)
  if (sessionId === undefined || context === undefined) return undefined
  const ua = text(value.ua, MAX_UA)
  return { sessionId, context, ...(ua === undefined ? {} : { ua }) }
}

function normalizeAd(value: unknown): SponsoredAd[] {
  if (!record(value)) return []
  const clickUrl = https(value.clickUrl)
  const impUrl = https(value.impUrl)
  // Without both tracked URLs the ad cannot be shown honestly: an untracked
  // click is a broken promise to the advertiser and an unfired impression is a
  // slot nobody was paid for.
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
 * from the ad response would turn an ad into script execution. The control plane
 * already enforces this; doing it again keeps a compromised or misconfigured
 * server from turning a card into code.
 */
function https(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const url = URL.parse(value)
  return url !== null && url.protocol === "https:" ? url.toString() : undefined
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
