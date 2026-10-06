import { For, Show, createMemo, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { COMPUTERS, usageLimits, type UsageLimit } from "./usage-limits"

// What the account is allowed, before a limit stops it.
//
// Informational and ungated: nothing here refuses anything, so a user who never
// opens it loses nothing and a user who does is told the ceiling instead of
// discovering it as a refusal. An entitlement that could not be read says so
// rather than showing zeroes, because a list of invented ceilings is worse than
// no list at all.

/** Named periods, so a daily budget is never described as a monthly one. */
const USED = {
  day: "settings.usage.usedPerDay",
  month: "settings.usage.usedPerMonth",
  // A plan this build cannot resolve has no period to name, so it says what it
  // does know instead of borrowing the monthly wording.
  unknown: "settings.usage.used",
} as const

export const SettingsUsage = () => {
  const language = useLanguage()
  const [store, setStore] = createStore({
    limits: undefined as UsageLimit[] | undefined,
    loading: true,
  })

  // The keys this surface needs are reported for `src/i18n/en.ts`; the cast is
  // what lets them land there without this file having to wait for them. `t` is
  // `string | undefined` because a key the dictionary does not hold resolves to
  // nothing at all rather than to the key, and a row that lost its name falls
  // back to the capability id instead of rendering blank.
  const t = (key: string, params?: Record<string, string>) =>
    language.t(key as Parameters<typeof language.t>[0], params) as string | undefined

  const number = createMemo(() => new Intl.NumberFormat(language.intl()))

  const capability = (id: string) => {
    // Every entry in the paywall's CAPABILITY_KEYS is the capability id in
    // camelCase inside one shared namespace, so the key is derived from the id
    // rather than listed here a second time: a paywall that calls an allowance
    // one thing and this list another is the bug, not the fix. Exporting
    // CAPABILITY_KEYS from @opencode-ai/ui/paywall replaces this function.
    const key = `ui.paywall.capability.${id.replaceAll(/_(\w)/g, (_, letter: string) => letter.toUpperCase())}`
    return t(key) ?? id
  }

  const value = (limit: UsageLimit) => {
    if (limit.limit === undefined) return t("settings.usage.unlimited")
    if (limit.used === undefined) return t("settings.usage.allowed", { limit: number().format(limit.limit) })
    return t(USED[limit.period ?? "unknown"], {
      used: number().format(limit.used),
      limit: number().format(limit.limit),
    })
  }

  const refresh = async () => {
    setStore("loading", true)
    try {
      setStore({ limits: usageLimits(await readEntitlement()), loading: false })
    } catch {
      setStore({ limits: undefined, loading: false })
    }
  }

  onMount(() => void refresh())

  return (
    <>
      <div class="settings-v2-tab-header">
        <div class="flex flex-col gap-1">
          <h2 class="settings-v2-tab-title">{t("settings.usage.title")}</h2>
          <p class="text-[13px] font-[440] text-v2-text-text-muted">{t("settings.usage.description")}</p>
        </div>
      </div>
      <div class="settings-v2-tab-body">
        <Show when={store.loading}>
          <div class="text-[13px] font-[440] text-v2-text-text-muted">{language.t("common.loading")}</div>
        </Show>

        {/* A definition list, so a screen reader reads each allowance as the
          capability's name and then its number. Nothing here is signalled by
          colour: the numbers are the text. */}
        <Show when={!store.loading && store.limits}>
          {(limits) => (
            <dl class="flex flex-col gap-2" data-component="usage-limits">
              <For each={limits()}>
                {(limit) => (
                  <div
                    class="flex items-start justify-between gap-3 rounded-md border border-v2-border-border-muted p-3"
                    data-slot="usage-limit"
                  >
                    <dt class="flex min-w-0 flex-col gap-1">
                      <span class="text-[13px] font-[530] text-v2-text-text-base">
                        {limit.id === COMPUTERS ? language.t("settings.computers.title") : capability(limit.id)}
                      </span>
                      <Show when={limit.sessionMinutes}>
                        {(minutes) => (
                          <span class="text-[11px] font-[440] text-v2-text-text-muted">
                            {t("settings.usage.sessionLength", { minutes: number().format(minutes()) })}
                          </span>
                        )}
                      </Show>
                    </dt>
                    <dd class="shrink-0 text-[13px] font-[530] text-v2-text-text-muted">{value(limit)}</dd>
                  </div>
                )}
              </For>
            </dl>
          )}
        </Show>

        <Show when={!store.loading && store.limits === undefined}>
          <div class="text-[13px] font-[440] text-v2-text-text-muted">{t("settings.usage.unavailable")}</div>
        </Show>
      </div>
    </>
  )
}

/**
 * The entitlement read, over the only billing bridge the renderer has.
 *
 * `@/context/entitlement` caches one read per window for the paywalls, whose
 * half of the response is a decision per capability. This surface asks the
 * bridge for the whole response itself, so it renders whether or not a paywall
 * has been mounted this window and without depending on which half of the
 * response that owner keeps. The cost is one extra request each time the
 * settings tab is opened, and nothing is metered by it.
 */
function readEntitlement(): Promise<unknown> {
  if (typeof window === "undefined") return Promise.resolve(undefined)
  const billing = (window as unknown as { api?: { billing?: { entitlement?: () => Promise<unknown> } } }).api?.billing
  return typeof billing?.entitlement === "function" ? billing.entitlement() : Promise.resolve(undefined)
}
