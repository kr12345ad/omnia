import { For, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Progress } from "@opencode-ai/ui/progress"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { checkoutPlan, openBillingPortal, useEntitlement } from "@/context/entitlement"
import { COMPUTERS, usageLimits, type UsageLimit } from "./usage-limits"
import { SettingsRuns } from "./settings-runs"

// The Account tab: plan, purchase actions, and every finite allowance as a bar.
//
// Informational and ungated like SettingsUsage: nothing here refuses anything.
// Only allowances with a real ceiling get a bar - unlimited rows would fill it
// to 100% and read as spent, and a 0 is a capability the plan does not include
// rather than an allowance that ran out, so neither renders one.
export const SettingsAccount = () => {
  const language = useLanguage()
  const platform = usePlatform()
  const entitlement = useEntitlement()

  // The keys this surface needs beyond what SettingsUsage pinned. `t` resolves
  // to undefined for a missing key rather than the key, so unfinished copy
  // falls back instead of rendering raw identifiers.
  const t = (key: string, params?: Record<string, string>) =>
    language.t(key as Parameters<typeof language.t>[0], params) as string | undefined

  const number = () => new Intl.NumberFormat(language.intl())
  const date = (at: number) =>
    new Intl.DateTimeFormat(language.intl(), { month: "short", day: "numeric" }).format(new Date(at))

  const capability = (id: string) => {
    const key = `ui.paywall.capability.${id.replaceAll(/_(\w)/g, (_, letter: string) => letter.toUpperCase())}`
    return t(key) ?? id
  }

  const account = () => entitlement.account()
  const plan = () => account()?.plan
  const configured = () => account()?.billingConfigured === true
  const rows = (): UsageLimit[] => {
    const current = account()
    if (!current) return []
    // The context snapshot already carries used, limit, period and resetsAt per
    // capability, so the rows come from it with no second bridge read.
    const asResponse = {
      plan: current.plan,
      computers: current.computers,
      computersUsed: current.computersUsed,
      capabilities: Object.fromEntries(
        Object.entries(current.capabilities).map(([id, state]) => [
          id,
          {
            allowed: state.allowed,
            code: state.code,
            used: state.used,
            // The snapshot drops the server's null to undefined, which usageLimits
            // reads as "unknown" and filters out. Restore it for capabilities the
            // plan actually allows: on a resolved plan the server always sends the
            // full matrix, so allowed + no number means unlimited, not unknown.
            // Unknown-plan rows stay undefined and stay hidden.
            limit: state.limit ?? (state.allowed && current.plan !== undefined ? null : undefined),
            resetsAt: state.resetsAt,
            sessionMinutes: state.sessionMinutes,
          },
        ]),
      ),
    }
    return usageLimits(asResponse) ?? []
  }

  const price = () => {
    const usd = account()?.monthlyUsd ?? 0
    if (usd <= 0) return undefined
    return new Intl.NumberFormat(language.intl(), { style: "currency", currency: "USD" }).format(usd)
  }

  const valueText = (limit: UsageLimit) => {
    // No ceiling means no bar and no count. usageLimits drops unknown-plan rows
    // before they arrive, so an undefined limit here is the server's null: the
    // JSON form of Infinity, i.e. genuinely unlimited rather than uncounted.
    if (limit.limit === undefined) return t("settings.usage.unlimited") ?? "Unlimited"
    if (limit.id === COMPUTERS) {
      if (limit.used === undefined) return t("settings.usage.allowed", { limit: number().format(limit.limit!) })
      return t("settings.usage.computersUsed", {
        used: number().format(limit.used),
        limit: number().format(limit.limit!),
      })
    }
    const base =
      limit.used === undefined
        ? t("settings.usage.allowed", { limit: number().format(limit.limit!) })
        : limit.period === "day"
          ? t("settings.usage.usedPerDay", { used: number().format(limit.used), limit: number().format(limit.limit!) })
          : limit.period === "month"
            ? t("settings.usage.usedPerMonth", {
                used: number().format(limit.used),
                limit: number().format(limit.limit!),
              })
            : t("settings.usage.used", { used: number().format(limit.used), limit: number().format(limit.limit!) })
    if (limit.resetsAt === undefined) return base
    const resets = t("settings.usage.resetsOn", { date: date(limit.resetsAt) })
    // The date alone is still informative when the sentence is untranslated.
    const suffix = resets ?? date(limit.resetsAt)
    return base === undefined ? suffix : `${base} · ${suffix}`
  }

  const percent = (limit: UsageLimit) =>
    limit.limit === undefined || limit.limit <= 0 || limit.used === undefined
      ? 0
      : Math.min(100, Math.round((limit.used / limit.limit) * 100))

  return (
    <>
      <div class="settings-v2-tab-header">
        <div class="flex items-start justify-between gap-4">
          <div class="flex flex-col gap-1">
            <h2 class="settings-v2-tab-title">{t("desktop.menu.account")}</h2>
            <p class="text-[13px] font-[440] text-v2-text-text-muted">{t("settings.usage.description")}</p>
          </div>
          <Show when={plan()}>
            {(current) => (
              <span class="shrink-0 rounded-md border border-v2-border-border-muted px-2 py-1 text-[12px] font-[530] text-v2-text-text-base">
                {current()}
                {price() ? ` · ${price()}` : ""}
              </span>
            )}
          </Show>
        </div>
        <Show when={account()?.profile?.login}>
          {(login) => <p class="text-[12px] font-[440] text-v2-text-text-muted">{login()}</p>}
        </Show>
      </div>
      <div class="settings-v2-tab-body">
        <Show when={account() === undefined}>
          <div class="text-[13px] font-[440] text-v2-text-text-muted">{t("settings.usage.unavailable")}</div>
        </Show>
        <Show when={account()}>
          <div class="settings-v2-section">
            <div class="flex flex-wrap gap-2">
              <Button
                variant="primary"
                size="small"
                disabled={!configured() || plan() !== "free"}
                onClick={() => void checkoutPlan(platform, language, "pro")}
              >
                {t("desktop.menu.upgradePro")}
              </Button>
              <Button
                variant="secondary"
                size="small"
                disabled={!configured() || (plan() !== "free" && plan() !== "pro")}
                onClick={() => void checkoutPlan(platform, language, "business")}
              >
                {t("desktop.menu.upgradeBusiness")}
              </Button>
              <Button
                variant="ghost"
                size="small"
                disabled={!configured() || plan() === undefined || plan() === "free"}
                onClick={() => void openBillingPortal(platform, language)}
              >
                {t("desktop.menu.manageBilling")}
              </Button>
            </div>
            <Show when={!configured()}>
              <p class="text-[13px] font-[440] text-v2-text-text-muted">{t("desktop.billing.notConfigured")}</p>
            </Show>
          </div>
          <SettingsRuns />
          <div class="settings-v2-section">
            <h3 class="settings-v2-section-title">{t("settings.usage.title")}</h3>
            <dl class="flex flex-col gap-2" data-component="account-limits">
              <For each={rows()}>
                {(limit) => (
                  <div
                    class="flex flex-col gap-2 rounded-md border border-v2-border-border-muted p-3"
                    data-slot="account-limit"
                    data-capability={limit.id}
                  >
                    <dt class="flex min-w-0 flex-col gap-1">
                      <span class="text-[13px] font-[530] text-v2-text-text-base">
                        {limit.id === COMPUTERS ? t("settings.computers.title") : capability(limit.id)}
                      </span>
                      <Show when={limit.sessionMinutes}>
                        {(minutes) => (
                          <span class="text-[11px] font-[440] text-v2-text-text-muted">
                            {t("settings.usage.sessionLength", { minutes: number().format(minutes()) })}
                          </span>
                        )}
                      </Show>
                    </dt>
                    <dd class="flex flex-col gap-1">
                      <span class="text-[13px] font-[530] text-v2-text-text-muted">{valueText(limit)}</span>
                      {/* A bar needs a ceiling to mean anything: an unlimited row
                          renders text only, because a full bar reads as spent and
                          an empty one as broken. */}
                      <Show
                        when={
                          limit.limit !== undefined && limit.limit > 0 && limit.used !== undefined ? limit : undefined
                        }
                      >
                        {(finite) => (
                          <Progress value={finite().used ?? 0} maxValue={finite().limit ?? 100} hideLabel>
                            {limit.id === COMPUTERS ? t("settings.computers.title") : capability(limit.id)}
                          </Progress>
                        )}
                      </Show>
                    </dd>
                  </div>
                )}
              </For>
            </dl>
          </div>
        </Show>
      </div>
    </>
  )
}
