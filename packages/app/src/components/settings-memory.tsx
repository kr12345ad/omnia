import { For, Show, createMemo, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { TextField } from "@opencode-ai/ui/text-field"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import type { MemoryRecord, MemoryScope } from "@/memory"

const scopes = ["session", "task", "workspace", "user", "skill", "application"] as const

type ScopeFilter = "all" | MemoryScope

const filters: ScopeFilter[] = ["all", ...scopes]

const isScope = (value: string): value is MemoryScope => scopes.includes(value as MemoryScope)

const scopeKey = (scope: MemoryScope) => `settings.memory.scope.${scope}` as const

export const SettingsMemory = () => {
  const language = useLanguage()
  const platform = usePlatform()
  const api = platform.memory

  const [store, setStore] = createStore({
    memories: [] as MemoryRecord[],
    stats: {} as Record<string, number>,
    query: "",
    scope: "all" as ScopeFilter,
    loading: true,
    error: "",
  })

  const scopeLabel = (scope: string) => (isScope(scope) ? language.t(scopeKey(scope)) : scope)

  const age = (memory: MemoryRecord) => {
    const minutes = Math.floor(Math.max(0, Date.now() - memory.createdAt) / 60000)
    if (minutes < 1) return language.t("common.time.justNow")
    if (minutes < 60) return language.t("common.time.minutesAgo.short", { count: minutes })
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return language.t("common.time.hoursAgo.short", { count: hours })
    return language.t("common.time.daysAgo.short", { count: Math.floor(hours / 24) })
  }

  const refresh = async () => {
    if (!api) return
    setStore("loading", true)
    try {
      const [memories, stats] = await Promise.all([
        api.list({
          query: store.query.trim() || undefined,
          scope: store.scope === "all" ? undefined : store.scope,
        }),
        api.stats(),
      ])
      setStore("memories", memories)
      setStore("stats", stats)
      setStore("error", "")
    } catch (error) {
      setStore("error", error instanceof Error ? error.message : String(error))
    } finally {
      setStore("loading", false)
    }
  }

  onMount(() => void refresh())

  const selectScope = (scope: ScopeFilter) => {
    setStore("scope", scope)
    void refresh()
  }

  const search = (value: string) => {
    setStore("query", value)
    void refresh()
  }

  const remove = async (memory: MemoryRecord) => {
    if (!api) return
    try {
      await api.remove(memory.id)
      await refresh()
    } catch (error) {
      setStore("error", error instanceof Error ? error.message : String(error))
    }
  }

  const forget = async () => {
    if (!api || store.scope === "all") return
    try {
      await api.forget({ scope: store.scope })
      await refresh()
    } catch (error) {
      setStore("error", error instanceof Error ? error.message : String(error))
    }
  }

  const statEntries = createMemo(() => Object.entries(store.stats))

  return (
    <div class="flex flex-col gap-6 p-6">
      <div class="flex items-start justify-between gap-4">
        <div class="flex flex-col gap-1">
          <h2 class="text-16-medium text-text-strong">{language.t("settings.memory.title")}</h2>
          <p class="text-12-regular text-text-weak">{language.t("settings.memory.description")}</p>
        </div>
        <Button
          variant="secondary"
          size="small"
          icon="trash"
          onClick={() => void forget()}
          disabled={!api || store.scope === "all"}
        >
          {language.t("settings.memory.forget")}
        </Button>
      </div>

      <Show when={!api}>
        <div class="text-12-regular text-text-weak">{language.t("settings.memory.unavailable")}</div>
      </Show>

      <Show when={api}>
        <div class="flex flex-col gap-4">
          <div class="flex items-center gap-2 px-3 h-9 rounded-lg bg-surface-base">
            <Icon name="magnifying-glass" class="text-icon-weak-base shrink-0" />
            <TextField
              variant="ghost"
              type="text"
              value={store.query}
              onChange={search}
              placeholder={language.t("settings.memory.search.placeholder")}
              spellcheck={false}
              autocorrect="off"
              autocomplete="off"
              autocapitalize="off"
              class="flex-1"
            />
            <Show when={store.query}>
              <IconButton
                icon="circle-x"
                variant="ghost"
                aria-label={language.t("common.clear")}
                onClick={() => search("")}
              />
            </Show>
          </div>

          <div class="flex flex-wrap items-center gap-1">
            <For each={filters}>
              {(scope) => (
                <Button
                  variant={store.scope === scope ? "primary" : "secondary"}
                  size="small"
                  onClick={() => selectScope(scope)}
                >
                  {scope === "all" ? language.t("settings.memory.scope.all") : language.t(scopeKey(scope))}
                </Button>
              )}
            </For>
          </div>

          <Show when={store.loading}>
            <div class="text-12-regular text-text-weak">{language.t("common.loading")}</div>
          </Show>

          <Show when={!store.loading && store.memories.length === 0}>
            <div class="text-12-regular text-text-weak">{language.t("settings.memory.empty")}</div>
          </Show>

          <div class="flex flex-col gap-2">
            <For each={store.memories}>
              {(memory) => (
                <div class="flex items-start gap-3 rounded-md border border-border-weak-base p-3">
                  <span class="shrink-0 rounded bg-surface-raised-base px-1.5 py-0.5 text-11-medium text-text-strong">
                    {scopeLabel(memory.scope)}
                  </span>
                  <div class="flex min-w-0 flex-1 flex-col gap-1">
                    <span class="line-clamp-3 whitespace-pre-wrap break-words text-12-regular text-text-strong">
                      {memory.text}
                    </span>
                    <div class="flex flex-wrap items-center gap-2 text-11-regular text-text-weak">
                      <Show when={memory.application}>{(application) => <span>{application()}</span>}</Show>
                      <For each={memory.tags ?? []}>{(tag) => <span>#{tag}</span>}</For>
                      <span>{age(memory)}</span>
                      <span title={language.t("settings.memory.confidence")}>
                        {Math.round(memory.confidence * 100)}%
                      </span>
                    </div>
                  </div>
                  <IconButton
                    icon="trash"
                    variant="ghost"
                    aria-label={language.t("settings.memory.delete")}
                    onClick={() => void remove(memory)}
                  />
                </div>
              )}
            </For>
          </div>

          <Show when={store.error}>
            <div class="rounded-md bg-surface-raised-base p-2 text-11-regular text-icon-critical-base">{store.error}</div>
          </Show>

          <Show when={statEntries().length > 0}>
            <div class="flex flex-wrap items-center gap-2 text-11-regular text-text-weak">
              <span>{language.t("settings.memory.stats")}</span>
              <For each={statEntries()}>
                {([scope, count]) => (
                  <span class="rounded bg-surface-raised-base px-1.5 py-0.5">
                    {scopeLabel(scope)}: {count}
                  </span>
                )}
              </For>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  )
}
