import { createEffect, createSignal, onCleanup, Show } from "solid-js"
import { useEntitlement } from "@/context/entitlement"
import { usePlatform } from "@/context/platform"

// The one ad surface in the free tier.
//
// Gravity matches an ad to the conversation and pays per impression. The main
// process owns the API key and the request; this component owns what the docs
// require of a custom renderer: a visible "Sponsored" label, `clickUrl` for the
// outbound link, and `impUrl` fired exactly once when at least half the card is
// in the viewport.
//
// Nothing renders for a paid plan, a signed-out profile, an unconfigured or
// unreachable billing service, or a failed request. Ads are an addition to a
// free conversation, never a condition of it.

type SponsoredAd = {
  adText: string
  title: string
  brandName: string
  cta: string
  url?: string
  favicon?: string
  clickUrl: string
  impUrl: string
  placement: string
  placementId: string
}

type AdsBridge = {
  get(input: { sessionId: string; context: string; ua?: string }): Promise<unknown>
}

/** Every tier other than the free plan is ad-free. */
const FREE_PLAN = "free"

function bridge(): AdsBridge | undefined {
  if (typeof window === "undefined") return undefined
  const ads = (window as unknown as { api?: { ads?: Partial<AdsBridge> } }).api?.ads
  return typeof ads?.get === "function" ? (ads as AdsBridge) : undefined
}

function ad(value: unknown): SponsoredAd | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const clickUrl = record.clickUrl
  const impUrl = record.impUrl
  const title = record.title
  if (typeof clickUrl !== "string" || typeof impUrl !== "string") return undefined
  if (typeof title !== "string" || title.length === 0) return undefined
  return {
    adText: typeof record.adText === "string" ? record.adText : "",
    title,
    brandName: typeof record.brandName === "string" ? record.brandName : "",
    cta: typeof record.cta === "string" ? record.cta : "Learn more",
    ...(typeof record.url === "string" ? { url: record.url } : {}),
    ...(typeof record.favicon === "string" ? { favicon: record.favicon } : {}),
    clickUrl,
    impUrl,
    placement: typeof record.placement === "string" ? record.placement : "below_response",
    placementId: typeof record.placement_id === "string" ? record.placement_id : "main",
  }
}

export function SponsoredAd(props: { sessionID?: string; context?: string }) {
  const entitlement = useEntitlement()
  const platform = usePlatform()
  const [current, setCurrent] = createSignal<SponsoredAd | undefined>()
  let viewed = false

  // Only a confirmed free plan earns an ad. An unread entitlement renders
  // nothing, which is the same rule every paywall in the app follows: nobody is
  // shown an ad because a read failed.
  const free = () => entitlement.account()?.plan === FREE_PLAN

  createEffect(() => {
    const sessionID = props.sessionID
    const context = props.context?.trim()
    if (!free() || sessionID === undefined || context === undefined || context.length === 0) {
      setCurrent(undefined)
      return
    }
    viewed = false
    let live = true
    onCleanup(() => {
      live = false
    })
    const request = bridge()
    if (request === undefined) {
      setCurrent(undefined)
      return
    }
    void request
      .get({ sessionId: sessionID, context, ...(navigator.userAgent ? { ua: navigator.userAgent } : {}) })
      .then((value) => {
        if (!live) return
        const first = Array.isArray(value) ? value.map(ad).find((entry) => entry !== undefined) : undefined
        setCurrent(first)
      })
      .catch(() => {
        if (live) setCurrent(undefined)
      })
  })

  let card: HTMLDivElement | undefined
  createEffect(() => {
    const value = current()
    const element = card
    if (value === undefined || element === undefined) return
    if (typeof IntersectionObserver === "undefined") return
    const observer = new IntersectionObserver(
      (entries) => {
        if (viewed) return
        if (!entries.some((entry) => entry.isIntersecting && entry.intersectionRatio >= 0.5)) return
        viewed = true
        observer.disconnect()
        // A single pixel request is the documented impression: no response is
        // read, and a failure must not retry into a double count.
        new Image().src = value.impUrl
      },
      { threshold: [0.5] },
    )
    observer.observe(element)
    onCleanup(() => observer.disconnect())
  })

  return (
    <Show when={current()}>
      {(value) => (
        <div
          ref={card}
          data-component="sponsored-ad"
          data-placement={value().placementId}
          class="mb-2 overflow-hidden rounded-md border border-border-weak-base bg-background-base"
        >
          <div class="flex items-start gap-3 p-3">
            <Show when={value().favicon}>
              {(favicon) => (
                <img
                  src={favicon()}
                  alt=""
                  class="mt-0.5 size-4 shrink-0 rounded-sm"
                  referrerPolicy="no-referrer"
                />
              )}
            </Show>
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <span class="rounded-sm border border-border-weak-base px-1 py-0.5 text-[10px] font-[530] uppercase tracking-wide text-text-weak">
                  Sponsored
                </span>
                <Show when={value().brandName}>
                  <span class="truncate text-[11px] font-[440] text-text-weak">{value().brandName}</span>
                </Show>
              </div>
              <button
                type="button"
                class="mt-1 block max-w-full truncate text-left text-[13px] font-[530] text-text-base hover:underline"
                onClick={() => void platform.openExternal(value().clickUrl)}
              >
                {value().title}
              </button>
              <Show when={value().adText}>
                <p class="mt-0.5 line-clamp-2 text-[12px] font-[440] text-text-weak">{value().adText}</p>
              </Show>
              <button
                type="button"
                class="mt-1.5 text-[12px] font-[530] text-text-base hover:underline"
                onClick={() => void platform.openExternal(value().clickUrl)}
              >
                {value().cta}
              </button>
            </div>
          </div>
        </div>
      )}
    </Show>
  )
}
