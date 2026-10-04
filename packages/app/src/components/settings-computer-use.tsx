import { For, Show, createEffect, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { Switch } from "@opencode-ai/ui/switch"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import type {
  ComputerUseModelState,
  ComputerUseModelStatus,
  ComputerUseRuntimeStatus,
  ComputerUseSettings,
  ComputerUseStatus,
} from "@/computer-use"

const ACTIVE_STATES: ReadonlySet<ComputerUseModelState> = new Set([
  "DOWNLOADING",
  "STARTING",
  "LOADING",
  "UNLOADING",
])

interface CuaEngineStatus {
  readonly available?: boolean
  readonly backend?: string
}

const STATE_LABEL = {
  NOT_INSTALLED: "settings.computerUse.state.notInstalled",
  DOWNLOADING: "settings.computerUse.state.downloading",
  INSTALLED: "settings.computerUse.state.installed",
  STARTING: "settings.computerUse.state.starting",
  READY: "settings.computerUse.state.ready",
  LOADING: "settings.computerUse.state.loading",
  UNLOADING: "settings.computerUse.state.unloading",
  FAILED: "settings.computerUse.state.failed",
  DISABLED: "settings.computerUse.state.disabled",
} as const

function formatSize(bytes: number | undefined): string | undefined {
  if (bytes === undefined || bytes <= 0) return undefined
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  return `${Math.round(bytes / 1024 ** 2)} MB`
}

export const SettingsComputerUse = () => {
  const language = useLanguage()
  const platform = usePlatform()
  const api = platform.computerUse
  const cuaEngine = (): CuaEngineStatus | undefined =>
    (store.status as (ComputerUseStatus & { cua?: CuaEngineStatus }) | undefined)?.cua
  const [store, setStore] = createStore({
    models: [] as ComputerUseModelStatus[],
    runtimes: [] as ComputerUseRuntimeStatus[],
    status: undefined as ComputerUseStatus | undefined,
    settings: undefined as ComputerUseSettings | undefined,
    error: "",
    loading: true,
    busy: "",
  })
  let poll: ReturnType<typeof setInterval> | undefined

  const refresh = async () => {
    if (!api) return
    try {
      const [models, runtimes, status, settings] = await Promise.all([
        api.models(),
        api.runtimes(),
        api.status(),
        api.settings(),
      ])
      setStore({ models, runtimes, status, settings, error: "", loading: false })
    } catch (error) {
      setStore("error", error instanceof Error ? error.message : String(error))
      setStore("loading", false)
    }
  }

  createEffect(() => {
    const active =
      store.models.some((entry) => ACTIVE_STATES.has(entry.state)) ||
      store.runtimes.some((entry) => ACTIVE_STATES.has(entry.state))
    if (active && poll === undefined) poll = setInterval(() => void refresh(), 1500)
    if (!active && poll !== undefined) {
      clearInterval(poll)
      poll = undefined
    }
  })

  onMount(() => void refresh())

  onCleanup(() => {
    if (poll !== undefined) clearInterval(poll)
  })

  const run = async (id: string, action: () => Promise<unknown>) => {
    setStore("busy", id)
    try {
      await action()
      await refresh()
    } catch (error) {
      setStore("error", error instanceof Error ? error.message : String(error))
    } finally {
      setStore("busy", "")
    }
  }

  const download = (entry: ComputerUseModelStatus) =>
    run(entry.model.id, async () => {
      if (!api) return
      if (store.settings?.allowDownloads !== true) {
        const settings = await api.updateSettings({ allowDownloads: true })
        setStore("settings", settings)
      }
      await api.download(entry.model.id)
    })

  const toggleDownloads = async (value: boolean) => {
    if (!api) return
    try {
      setStore("settings", await api.updateSettings({ allowDownloads: value }))
    } catch (error) {
      setStore("error", error instanceof Error ? error.message : String(error))
    }
  }

  const downloadRuntime = (entry: ComputerUseRuntimeStatus) =>
    run(entry.runtime.id, async () => {
      if (!api) return
      if (store.settings?.allowDownloads !== true) {
        const settings = await api.updateSettings({ allowDownloads: true })
        setStore("settings", settings)
      }
      await api.downloadRuntime(entry.runtime.id)
    })

  return (
    <>
      <div class="settings-v2-tab-header">
      <div class="flex flex-col gap-1">
        <h2 class="settings-v2-tab-title">{language.t("settings.computerUse.title")}</h2>
        <p class="text-[13px] font-[440] text-v2-text-text-muted">{language.t("settings.computerUse.description")}</p>
      </div>
      </div>
      <div class="settings-v2-tab-body">

      <Show when={!api}>
        <div class="text-[13px] font-[440] text-v2-text-text-muted">{language.t("settings.computers.unavailable")}</div>
      </Show>

      <Show when={api}>
        <div class="rounded-md border border-v2-border-border-muted p-3 text-[11px] font-[440] text-v2-text-text-muted">
          <Show
            when={store.status?.localRuntime.available}
            fallback={language.t("settings.computerUse.runtime.unavailable")}
          >
            {language.t("settings.computerUse.runtime.ready", {
              backend: store.status?.localRuntime.backend ?? "cpu",
            })}
          </Show>
        </div>

        <div class="flex items-center justify-between gap-3 rounded-md border border-v2-border-border-muted p-3">
          <span class="text-[13px] font-[530] text-v2-text-text-base">
            {language.t("settings.computerUse.engine.title")}
          </span>
          <span class="text-[11px] font-[440] text-v2-text-text-muted">
            <Show
              when={cuaEngine()?.available === true}
              fallback={language.t("settings.computerUse.engine.legacy")}
            >
              {cuaEngine()?.backend
                ? language.t("settings.computerUse.engine.cuaBackend", { backend: cuaEngine()!.backend! })
                : language.t("settings.computerUse.engine.cua")}
            </Show>
          </span>
        </div>

        <div class="flex items-start justify-between gap-4 rounded-md border border-v2-border-border-muted p-3">
          <div class="flex flex-col gap-1">
            <span class="text-[13px] font-[530] text-v2-text-text-base">{language.t("settings.computerUse.downloads")}</span>
            <span class="text-[11px] font-[440] text-v2-text-text-muted">
              {language.t("settings.computerUse.downloads.description")}
            </span>
          </div>
          <Switch
            checked={store.settings?.allowDownloads === true}
            onChange={(value) => void toggleDownloads(value)}
          />
        </div>

        <div class="flex flex-col gap-2">
          <span class="text-[13px] font-[530] text-v2-text-text-muted">{language.t("settings.computerUse.runtime.title")}</span>
          <span class="text-[11px] font-[440] text-v2-text-text-muted">
            {language.t("settings.computerUse.runtime.description")}
          </span>
          <For each={store.runtimes}>
            {(entry) => {
              const active = () => ACTIVE_STATES.has(entry.state)
              const busy = () => store.busy === entry.runtime.id
              return (
                <div class="flex items-center justify-between gap-3 rounded-md border border-v2-border-border-muted p-3">
                  <div class="flex min-w-0 flex-col gap-1">
                    <div class="flex items-center gap-2">
                      <span class="text-[13px] font-[530] text-v2-text-text-base">{entry.runtime.displayName}</span>
                      <Show when={entry.bundled}>
                        <span class="rounded-sm bg-v2-background-bg-layer-01 px-1.5 py-0.5 text-[11px] font-[530] text-v2-text-text-muted">
                          {language.t("settings.computerUse.runtime.included")}
                        </span>
                      </Show>
                      <Show when={entry.installed && !entry.bundled}>
                        <span class="rounded-sm bg-v2-background-bg-layer-01 px-1.5 py-0.5 text-[11px] font-[530] text-v2-text-text-muted">
                          {language.t("settings.computerUse.runtime.installed")}
                        </span>
                      </Show>
                      <Show when={!entry.installed}>
                        <span class="text-[11px] font-[530] text-v2-text-text-muted">
                          {formatSize(entry.bytes) ?? ""}
                        </span>
                      </Show>
                    </div>
                    <span class="text-[11px] font-[440] text-v2-text-text-muted">{entry.runtime.description}</span>
                    <Show when={entry.state === "DOWNLOADING"}>
                      <div class="h-1 w-full overflow-hidden rounded-full bg-v2-background-bg-layer-01">
                        <div
                          class="h-full rounded-full transition-[width]"
                          style={{
                            width: `${Math.round((entry.progress ?? 0) * 100)}%`,
                            background: "var(--icon-interactive-base)",
                          }}
                        />
                      </div>
                    </Show>
                    <Show when={entry.reason}>
                      <span class="text-[11px] font-[440] text-v2-state-fg-danger">{entry.reason}</span>
                    </Show>
                  </div>
                  <div class="flex shrink-0 items-center gap-2">
                    <Show when={!entry.installed}>
                      <Button
                        variant="secondary"
                        size="small"
                        icon="download"
                        disabled={busy() || active()}
                        onClick={() => void downloadRuntime(entry)}
                      >
                        {language.t("settings.computerUse.download")}
                      </Button>
                    </Show>
                    <Show when={entry.installed && !entry.bundled}>
                      <Button
                        variant="ghost"
                        size="small"
                        disabled={busy() || active()}
                        onClick={() => api && void run(entry.runtime.id, () => api.removeRuntime(entry.runtime.id))}
                      >
                        {language.t("settings.computerUse.delete")}
                      </Button>
                    </Show>
                  </div>
                </div>
              )
            }}
          </For>
        </div>

        <Show when={store.models.length === 0 && !store.loading}>
          <div class="text-[13px] font-[440] text-v2-text-text-muted">{language.t("settings.computerUse.empty")}</div>
        </Show>

        <div class="flex flex-col gap-2">
          <For each={store.models}>
            {(entry) => {
              const active = () => ACTIVE_STATES.has(entry.state)
              const busy = () => store.busy === entry.model.id
              return (
                <div class="flex flex-col gap-2 rounded-md border border-v2-border-border-muted p-3">
                  <div class="flex items-start justify-between gap-3">
                    <div class="flex min-w-0 flex-col">
                      <div class="flex items-center gap-2">
                        <span class="truncate text-[13px] font-[530] text-v2-text-text-base">{entry.model.displayName}</span>
                        <Show when={entry.model.recommended}>
                          <span class="rounded-sm bg-v2-background-bg-layer-01 px-1.5 py-0.5 text-[11px] font-[530] text-v2-text-text-muted">
                            {language.t("settings.computerUse.recommended")}
                          </span>
                        </Show>
                      </div>
                      <span class="truncate text-[11px] font-[440] text-v2-text-text-muted">
                        {[
                          entry.model.provider,
                          entry.model.quantization,
                          formatSize(entry.model.modelSizeBytes),
                          entry.runtimeBackend,
                        ]
                          .filter((value): value is string => typeof value === "string" && value.length > 0)
                          .join(" · ")}
                      </span>
                    </div>
                    <span class="shrink-0 text-[11px] font-[530] text-v2-text-text-muted">
                      {language.t(STATE_LABEL[entry.state])}
                    </span>
                  </div>

                  <Show when={entry.state === "DOWNLOADING"}>
                    <div class="h-1 w-full overflow-hidden rounded-full bg-v2-background-bg-layer-01">
                      <div
                        class="h-full rounded-full transition-[width]"
                        style={{
                          width: `${Math.round((entry.progress ?? 0) * 100)}%`,
                          background: "var(--icon-interactive-base)",
                        }}
                      />
                    </div>
                  </Show>

                  <Show when={entry.reason}>
                    <div class="text-[11px] font-[440] text-v2-state-fg-danger">{entry.reason}</div>
                  </Show>

                  <div class="flex items-center gap-2">
                    <Show when={!entry.installed}>
                      <Button
                        variant="secondary"
                        size="small"
                        icon="download"
                        disabled={busy() || active()}
                        onClick={() => void download(entry)}
                      >
                        {language.t("settings.computerUse.download")}
                      </Button>
                    </Show>
                    <Show when={entry.installed && !entry.loaded}>
                      <Button
                        variant="secondary"
                        size="small"
                        disabled={busy() || active()}
                        onClick={() => api && void run(entry.model.id, () => api.load(entry.model.id))}
                      >
                        {language.t("settings.computerUse.load")}
                      </Button>
                    </Show>
                    <Show when={entry.loaded}>
                      <Button
                        variant="secondary"
                        size="small"
                        disabled={busy() || active()}
                        onClick={() => api && void run(entry.model.id, () => api.unload(entry.model.id))}
                      >
                        {language.t("settings.computerUse.unload")}
                      </Button>
                    </Show>
                    <Show when={entry.installed}>
                      <Button
                        variant="ghost"
                        size="small"
                        disabled={busy() || active()}
                        onClick={() => api && void run(entry.model.id, () => api.remove(entry.model.id))}
                      >
                        {language.t("settings.computerUse.delete")}
                      </Button>
                    </Show>
                  </div>
                </div>
              )
            }}
          </For>
        </div>

        <div class="text-[11px] font-[440] text-v2-text-text-muted">{language.t("settings.computerUse.note")}</div>

        <Show when={store.error}>
          <div class="rounded-md bg-v2-background-bg-layer-01 p-2 text-[11px] font-[440] text-v2-state-fg-danger">{store.error}</div>
        </Show>
      </Show>
      </div>
    </>
  )
}
