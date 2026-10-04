import { For, Show, createMemo, createSignal, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Switch } from "@opencode-ai/ui/switch"
import { TextField } from "@opencode-ai/ui/text-field"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { useTabs } from "@/context/tabs"
import { SelectField } from "./select-field"
import { emptySuperskill, type Superskill, type SuperskillSummary } from "@/superskills"

export const SettingsSuperskills = () => {
  const language = useLanguage()
  const platform = usePlatform()
  const tabs = useTabs()
  const server = useServer()
  const layout = useLayout()
  const dialog = useDialog()
  const api = platform.superskills

  const [store, setStore] = createStore({
    skills: [] as SuperskillSummary[],
    draft: undefined as Superskill | undefined,
    methodsText: "[]",
    status: "",
    error: "",
    loading: true,
    saving: false,
    aiPrompt: "",
  })
  const [selected, setSelected] = createSignal<string | undefined>(undefined)

  const refresh = async () => {
    if (!api) return
    setStore("loading", true)
    try {
      setStore("skills", await api.list())
      setStore("error", "")
    } catch (error) {
      setStore("error", error instanceof Error ? error.message : String(error))
    } finally {
      setStore("loading", false)
    }
  }

  onMount(() => void refresh())

  const startNew = () => {
    const draft = emptySuperskill()
    setSelected(undefined)
    setStore("draft", draft)
    setStore("methodsText", JSON.stringify(draft.methods, null, 2))
    setStore("status", "")
    setStore("error", "")
  }

  const edit = async (id: string) => {
    if (!api) return
    try {
      const skill = await api.get(id)
      setSelected(id)
      setStore("draft", skill)
      setStore("methodsText", JSON.stringify(skill.methods, null, 2))
      setStore("status", "")
      setStore("error", "")
    } catch (error) {
      setStore("error", error instanceof Error ? error.message : String(error))
    }
  }

  const parseMethods = (): Superskill["methods"] | undefined => {
    try {
      const parsed = JSON.parse(store.methodsText)
      if (!Array.isArray(parsed)) throw new Error("not an array")
      return parsed as Superskill["methods"]
    } catch {
      setStore("error", language.t("settings.superskills.invalidMethods"))
      return undefined
    }
  }

  const save = async () => {
    if (!api || !store.draft) return
    const methods = parseMethods()
    if (!methods) return
    setStore("saving", true)
    try {
      const saved = await api.save({ ...store.draft, methods })
      setSelected(saved.id)
      setStore("draft", saved)
      setStore("status", language.t("settings.superskills.saved"))
      setStore("error", "")
      await refresh()
    } catch (error) {
      setStore("error", error instanceof Error ? error.message : String(error))
    } finally {
      setStore("saving", false)
    }
  }

  const remove = async () => {
    if (!api || !store.draft) return
    const id = store.draft.id
    if (id.length === 0) return
    try {
      await api.remove(id)
      setStore("draft", undefined)
      setSelected(undefined)
      setStore("status", language.t("settings.superskills.deleted"))
      await refresh()
    } catch (error) {
      setStore("error", error instanceof Error ? error.message : String(error))
    }
  }

  const toggle = async (summary: SuperskillSummary, enabled: boolean) => {
    if (!api) return
    try {
      const skill = await api.get(summary.id)
      await api.save({ ...skill, enabled })
      await refresh()
    } catch (error) {
      setStore("error", error instanceof Error ? error.message : String(error))
    }
  }

  const test = async () => {
    if (!api || !store.draft) return
    const method = store.draft.methods[0]?.name
    if (method === undefined) return
    try {
      const result = await api.call(store.draft.id, method, {})
      setStore("status", `${method}: ${JSON.stringify(result).slice(0, 400)}`)
      setStore("error", "")
    } catch (error) {
      setStore("error", error instanceof Error ? error.message : String(error))
    }
  }

  const draft = createMemo(() => store.draft)

  const createWithAI = () => {
    const request = store.aiPrompt.trim()
    if (request.length === 0) return
    const directory = layout.projects.list()[0]?.worktree
    if (directory === undefined) {
      setStore("error", language.t("settings.superskills.aiNoProject"))
      return
    }
    void tabs.newDraft(
      { server: server.key, directory, mode: "work" },
      language.t("settings.superskills.aiPrompt", { request }),
    )
    dialog.close()
  }

  return (
    <>
      <div class="settings-v2-tab-header">
      <div class="flex items-start justify-between gap-4">
        <div class="flex flex-col gap-1">
          <h2 class="settings-v2-tab-title">{language.t("settings.superskills.title")}</h2>
          <p class="text-[13px] font-[440] text-v2-text-text-muted">{language.t("settings.superskills.description")}</p>
        </div>
        <Button variant="secondary" size="small" icon="plus-small" onClick={startNew} disabled={!api}>
          {language.t("settings.superskills.new")}
        </Button>
      </div>
      </div>
      <div class="settings-v2-tab-body">

      <Show when={!api}>
        <div class="text-[13px] font-[440] text-v2-text-text-muted">{language.t("settings.superskills.unavailable")}</div>
      </Show>

      <Show when={api}>
        <div class="flex flex-col gap-2 rounded-md border border-v2-border-border-muted p-3">
          <span class="text-[13px] font-[530] text-v2-text-text-base">{language.t("settings.superskills.aiTitle")}</span>
          <span class="text-[11px] font-[440] text-v2-text-text-muted">{language.t("settings.superskills.aiDescription")}</span>
          <textarea
            class="min-h-20 w-full rounded-md border border-v2-border-border-muted bg-v2-background-bg-base p-2 text-[13px] font-[440] text-v2-text-text-base outline-none focus:border-v2-border-border-base"
            placeholder={language.t("settings.superskills.aiPlaceholder")}
            value={store.aiPrompt}
            onInput={(event) => setStore("aiPrompt", event.currentTarget.value)}
          />
          <div class="flex items-center gap-2">
            <Button
              variant="primary"
              size="small"
              icon="subagent"
              onClick={createWithAI}
              disabled={store.aiPrompt.trim().length === 0}
            >
              {language.t("settings.superskills.aiCreate")}
            </Button>
          </div>
        </div>

        <div class="flex gap-6">
          <div class="flex w-64 shrink-0 flex-col gap-1">
            <Show when={store.skills.length === 0 && !store.loading}>
              <div class="px-2 py-3 text-[13px] font-[440] text-v2-text-text-muted">{language.t("settings.superskills.empty")}</div>
            </Show>
            <For each={store.skills}>
              {(skill) => (
                <div
                  class="group flex items-center gap-2 rounded-md px-2 py-1.5 cursor-pointer hover:bg-v2-overlay-simple-overlay-hover"
                  classList={{ "bg-v2-background-bg-layer-01": selected() === skill.id }}
                  onClick={() => void edit(skill.id)}
                >
                  <Icon name="dot-grid" size="small" class="shrink-0 text-v2-icon-icon-muted" />
                  <div class="flex min-w-0 flex-1 flex-col">
                    <span class="truncate text-[13px] font-[530] text-v2-text-text-base">{skill.name}</span>
                    <span class="truncate text-[11px] font-[440] text-v2-text-text-muted">{skill.methods.length} methods</span>
                  </div>
                  <span onClick={(event) => event.stopPropagation()}><Switch checked={skill.enabled} onChange={(value) => void toggle(skill, value)} /></span>
                </div>
              )}
            </For>
          </div>

          <Show when={draft()}>
            {(skill) => (
              <div class="flex min-w-0 flex-1 flex-col gap-4">
                <div class="grid grid-cols-2 gap-3">
                  <TextField
                    label={language.t("settings.superskills.name")}
                    value={skill().name}
                    onChange={(value) => setStore("draft", "name", value)}
                  />
                  <TextField
                    label={language.t("settings.superskills.id")}
                    value={skill().id}
                    onChange={(value) => setStore("draft", "id", value)}
                  />
                </div>
                <TextField
                  label={language.t("settings.superskills.descriptionLabel")}
                  value={skill().description}
                  onChange={(value) => setStore("draft", "description", value)}
                />
                <label class="flex flex-col gap-1.5">
                  <span class="text-[13px] font-[530] text-v2-text-text-muted">{language.t("settings.superskills.instructions")}</span>
                  <textarea
                    class="min-h-40 w-full rounded-md border border-v2-border-border-muted bg-v2-background-bg-base p-2 text-[13px] font-[440] text-v2-text-text-base outline-none focus:border-v2-border-border-base"
                    value={skill().instructions}
                    onInput={(event) => setStore("draft", "instructions", event.currentTarget.value)}
                  />
                </label>
                <div class="grid grid-cols-2 gap-3">
                  <SelectField
                    label={language.t("settings.superskills.bridge")}
                    value={skill().bridge.type}
                    options={[
                      { value: "stdio", label: language.t("settings.superskills.bridge.stdio") },
                      { value: "http", label: language.t("settings.superskills.bridge.http") },
                    ]}
                    onChange={(value) =>
                      setStore("draft", "bridge", {
                        ...skill().bridge,
                        type: value === "http" ? "http" : "stdio",
                      })
                    }
                  />
                  <Show
                    when={skill().bridge.type === "http"}
                    fallback={
                      <TextField
                        label={language.t("settings.superskills.command")}
                        value={skill().bridge.command ?? ""}
                        onChange={(value) => setStore("draft", "bridge", { ...skill().bridge, command: value })}
                      />
                    }
                  >
                    <TextField
                      label={language.t("settings.superskills.url")}
                      value={skill().bridge.url ?? ""}
                      onChange={(value) => setStore("draft", "bridge", { ...skill().bridge, url: value })}
                    />
                  </Show>
                </div>
                <label class="flex flex-col gap-1.5">
                  <span class="text-[13px] font-[530] text-v2-text-text-muted">{language.t("settings.superskills.methods")}</span>
                  <textarea
                    class="min-h-32 w-full rounded-md border border-v2-border-border-muted bg-v2-background-bg-base p-2 font-mono text-[11px] font-[440] text-v2-text-text-base outline-none focus:border-v2-border-border-base"
                    value={store.methodsText}
                    onInput={(event) => setStore("methodsText", event.currentTarget.value)}
                  />
                </label>
                <div class="flex items-center gap-3">
                  <Switch
                    checked={skill().enabled}
                    onChange={(value) => setStore("draft", "enabled", value)}
                  />
                  <span class="text-[13px] font-[440] text-v2-text-text-base">{language.t("settings.superskills.enabled")}</span>
                </div>
                <div class="flex items-center gap-2">
                  <Button variant="primary" size="small" onClick={() => void save()} disabled={store.saving}>
                    {language.t("settings.superskills.save")}
                  </Button>
                  <Button variant="secondary" size="small" onClick={() => void test()}>
                    {language.t("settings.superskills.test")}
                  </Button>
                  <Show when={selected() !== undefined}>
                    <IconButton
                      icon="close-small"
                      variant="ghost"
                      aria-label={language.t("settings.superskills.delete")}
                      onClick={() => void remove()}
                    />
                  </Show>
                </div>
                <Show when={store.status}>
                  <div class="rounded-md bg-v2-background-bg-layer-01 p-2 text-[11px] font-[440] text-v2-text-text-muted">{store.status}</div>
                </Show>
                <Show when={store.error}>
                  <div class="rounded-md bg-v2-background-bg-layer-01 p-2 text-[11px] font-[440] text-v2-state-fg-danger">
                    {store.error}
                  </div>
                </Show>
              </div>
            )}
          </Show>
        </div>
      </Show>
      </div>
    </>
  )
}
