import { For, Show, createMemo, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { Paywall } from "@opencode-ai/ui/paywall"
import { TextField } from "@opencode-ai/ui/text-field"
import { useEntitlement } from "@/context/entitlement"
import { useLanguage } from "@/context/language"
import { usePlatform, type ScheduledRun } from "@/context/platform"

export function SettingsRuns() {
  const language = useLanguage()
  const platform = usePlatform()
  const entitlement = useEntitlement()
  const [store, setStore] = createStore({
    runs: [] as readonly ScheduledRun[],
    name: "",
    prompt: "",
    intervalMinutes: 60,
    loading: true,
    saving: false,
    error: "",
  })
  const api = () => platform.runs
  const allowed = createMemo(() => entitlement.account()?.capabilities.scheduled_runs?.allowed === true)

  const refresh = async () => {
    if (!api()) return
    setStore({ loading: true, error: "" })
    try {
      setStore({ runs: await api()!.list(), loading: false })
    } catch (error) {
      setStore({ loading: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  onMount(() => void refresh())

  const create = async () => {
    const name = store.name.trim()
    const prompt = store.prompt.trim()
    if (!api() || name.length === 0 || prompt.length === 0) return
    setStore({ saving: true, error: "" })
    try {
      const created = await api()!.create({ name, prompt, intervalMinutes: store.intervalMinutes })
      setStore({ runs: [...store.runs, created], name: "", prompt: "", saving: false })
    } catch (error) {
      setStore({ saving: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  const toggle = async (run: ScheduledRun) => {
    if (!api()) return
    setStore("error", "")
    try {
      const updated = await api()!.update(run.id, { enabled: !run.enabled })
      setStore("runs", (runs) => runs.map((item) => (item.id === run.id ? updated : item)))
    } catch (error) {
      setStore("error", error instanceof Error ? error.message : String(error))
    }
  }

  const remove = async (run: ScheduledRun) => {
    if (!api()) return
    setStore("error", "")
    try {
      if (await api()!.remove(run.id)) setStore("runs", (runs) => runs.filter((item) => item.id !== run.id))
    } catch (error) {
      setStore("error", error instanceof Error ? error.message : String(error))
    }
  }

  const intervalLabel = (minutes: number) =>
    minutes % 1440 === 0
      ? language.t("settings.runs.everyDays", { count: String(minutes / 1440) })
      : minutes % 60 === 0
        ? language.t("settings.runs.everyHours", { count: String(minutes / 60) })
        : language.t("settings.runs.everyMinutes", { count: String(minutes) })

  if (api() === undefined) return null

  return (
    <section class="settings-v2-section" aria-labelledby="settings-runs-title">
      <div class="flex flex-col gap-1">
        <h3 id="settings-runs-title" class="settings-v2-section-title">{language.t("settings.runs.title")}</h3>
        <p class="text-[13px] font-[440] text-v2-text-text-muted">{language.t("settings.runs.description")}</p>
      </div>
      <Show when={entitlement.account() !== undefined && !allowed()}>
        <Paywall capability="scheduled_runs" decision={{ code: "not_entitled" }} offer={entitlement.offer()} />
      </Show>
      <Show when={allowed()}>
        <div class="mt-3 flex flex-col gap-3">
          <TextField label={language.t("settings.runs.name")} placeholder={language.t("settings.runs.namePlaceholder")} value={store.name} onChange={(value) => setStore("name", value)} />
          <TextField label={language.t("settings.runs.prompt")} placeholder={language.t("settings.runs.promptPlaceholder")} value={store.prompt} onChange={(value) => setStore("prompt", value)} />
          <TextField label={language.t("settings.runs.interval")} type="number" value={String(store.intervalMinutes)} onChange={(value) => setStore("intervalMinutes", Math.max(15, Math.min(10080, Number(value) || 60)))} />
          <Button variant="primary" size="small" disabled={store.saving || store.name.trim().length === 0 || store.prompt.trim().length === 0} onClick={() => void create()}>
            {language.t("settings.runs.create")}
          </Button>
        </div>
      </Show>
      <Show when={store.loading}>
        <p class="mt-3 text-[13px] font-[440] text-v2-text-text-muted">{language.t("settings.runs.loading")}</p>
      </Show>
      <Show when={!store.loading && store.runs.length === 0 && allowed()}>
        <p class="mt-3 text-[13px] font-[440] text-v2-text-text-muted">{language.t("settings.runs.empty")}</p>
      </Show>
      <For each={store.runs}>
        {(run) => (
          <div class="mt-3 flex flex-col gap-2 rounded-md border border-v2-border-border-muted p-3">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <p class="text-[13px] font-[530] text-v2-text-text-base">{run.name}</p>
                <p class="mt-1 line-clamp-2 text-[12px] font-[440] text-v2-text-text-muted">{run.prompt}</p>
                <p class="mt-1 text-[11px] font-[440] text-v2-text-text-faint">{intervalLabel(run.intervalMinutes)}</p>
              </div>
              <div class="flex shrink-0 gap-2">
                <Button variant="secondary" size="small" onClick={() => void toggle(run)}>{run.enabled ? language.t("settings.runs.disable") : language.t("settings.runs.enable")}</Button>
                <Button variant="ghost" size="small" onClick={() => void remove(run)}>{language.t("settings.runs.delete")}</Button>
              </div>
            </div>
            <Show when={run.lastResult}>
              {(result) => <p class="text-[11px] font-[440] text-v2-text-text-muted">{result().ok ? language.t("settings.runs.lastSuccess") : `${language.t("settings.runs.lastFailed")}: ${result().error ?? ""}`}</p>}
            </Show>
          </div>
        )}
      </For>
      <Show when={store.error}>
        <p role="alert" class="mt-3 text-[12px] font-[440] text-v2-state-fg-danger">{store.error}</p>
      </Show>
    </section>
  )
}
