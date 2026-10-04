import { For, Show, createMemo, createResource } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { Button } from "@opencode-ai/ui/button"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { useSettings } from "@/context/settings"
import { useTabs } from "@/context/tabs"
import { useSettingsDialog } from "@/components/settings-dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { DialogNewDiscussion } from "@/components/dialog-new-discussion"
import { resolveSessionMode } from "@/utils/session-mode"
import { createHomeController } from "./home-controller"
import { createHomeSessionsController } from "./home-sessions-controller"

const QUICK_ACTIONS = [
  { id: "discussion", icon: "speech-bubble", labelKey: "work.home.discussion" },
  { id: "research", icon: "magnifying-glass-menu", labelKey: "work.home.action.research", promptKey: "work.home.action.research.prompt", values: { topic: "[topic]" } },
  { id: "files", icon: "file-tree", labelKey: "work.home.action.files", promptKey: "work.home.action.files.prompt", values: { path: "[folder]" } },
  { id: "spreadsheet", icon: "bullet-list", labelKey: "work.home.action.spreadsheet", promptKey: "work.home.action.spreadsheet.prompt", values: { path: "[spreadsheet]" } },
  { id: "application", icon: "window-cursor", labelKey: "work.home.action.application", promptKey: "work.home.action.application.prompt", values: { app: "[application]" } },
  { id: "browser", icon: "square-arrow-top-right", labelKey: "work.home.action.browser", promptKey: "work.home.action.browser.prompt", values: { url: "[url]" } },
  { id: "agent", icon: "subagent", labelKey: "work.home.action.agent", promptKey: "work.home.action.agent.prompt", values: { purpose: "[purpose]" } },
  { id: "superskill", icon: "dot-grid", labelKey: "work.home.action.superskill", promptKey: "work.home.action.superskill.prompt", values: { app: "[application]" } },
] as const

export function WorkHome() {
  const language = useLanguage()
  const platform = usePlatform()
  const tabs = useTabs()
  const server = useServer()
  const layout = useLayout()
  const settings = useSettings()
  const home = createHomeController()
  const sessions = createHomeSessionsController(home)
  const openSettings = useSettingsDialog("superskills")
  const dialog = useDialog()

  const directory = createMemo(() => layout.projects.list()[0]?.worktree)

  const recent = createMemo(() =>
    sessions.data
      .records()
      .filter(
        (record) =>
          resolveSessionMode({
            stored: settings.general.sessionModes.get(record.session.id),
            metadata: record.session.metadata,
          }) !== "code",
      )
      .slice(0, 6),
  )

  const [superskills] = createResource(async () => {
    if (!platform.superskills) return undefined
    return platform.superskills.list().catch(() => undefined)
  })

  const start = (action: (typeof QUICK_ACTIONS)[number]) => {
    if (action.id === "discussion") {
      dialog.show(() => <DialogNewDiscussion />)
      return
    }
    if (!("promptKey" in action)) return
    const dir = directory()
    if (dir === undefined) return
    const prompt = language.t(action.promptKey, "values" in action ? action.values : undefined)
    void tabs.newDraft({ server: server.key, directory: dir, mode: "work" }, prompt)
  }

  const openTask = (session: Parameters<typeof sessions.session.open>[0]) => {
    sessions.session.open(session)
  }

  return (
    <div class="m-2 min-h-0 flex-1 self-stretch overflow-hidden rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]">
      <ScrollView class="h-full">
        <div class="mx-auto flex w-full max-w-[1080px] flex-col gap-8 px-6 py-10">
          <div class="flex flex-col gap-2">
            <h1 class="text-[20px] font-[640] leading-7 text-v2-text-text-base">{language.t("work.home.title")}</h1>
            <p class="text-[13px] font-[440] text-v2-text-text-muted">{language.t("work.home.subtitle")}</p>
          </div>

          <div class="flex flex-col gap-3">
            <span class="text-[11px] font-[530] uppercase tracking-wide text-v2-text-text-muted">{language.t("work.home.quickActions")}</span>
            <div class="grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-4">
              <For each={QUICK_ACTIONS}>
                {(action, index) => (
                  <button
                    type="button"
                    class="anim-rise home-qa-card group flex items-center gap-3 rounded-lg border border-v2-border-border-muted bg-v2-background-bg-base px-3 py-3 text-left transition-colors hover:bg-v2-overlay-simple-overlay-hover"
                    style={{ "animation-delay": `${Math.min(index(), 7) * 45}ms` }}
                    onClick={() => start(action)}
                  >
                    <Icon name={action.icon} size="small" class="shrink-0 text-v2-icon-icon-muted" />
                    <span class="text-[13px] font-[530] text-v2-text-text-base">{language.t(action.labelKey)}</span>
                  </button>
                )}
              </For>
            </div>
          </div>

          <div class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
            <div class="flex flex-col gap-3">
              <span class="text-[11px] font-[530] uppercase tracking-wide text-v2-text-text-muted">{language.t("work.home.recent")}</span>
              <Show
                when={recent().length > 0}
                fallback={<div class="rounded-lg border border-v2-border-border-muted px-3 py-6 text-center text-[13px] font-[440] text-v2-text-text-muted">{language.t("home.sessions.empty")}</div>}
              >
                <div class="flex flex-col gap-1">
                  <For each={recent()}>
                    {(record) => (
                      <button
                        type="button"
                        class="flex items-center gap-3 rounded-md px-3 py-2 text-left transition-colors hover:bg-v2-overlay-simple-overlay-hover"
                        onClick={() => openTask(record.session)}
                      >
                        <Icon name="speech-bubble" size="small" class="shrink-0 text-v2-icon-icon-muted" />
                        <span class="min-w-0 flex-1 truncate text-[13px] font-[440] text-v2-text-text-base">
                          {record.session.title || record.session.id}
                        </span>
                        <span class="shrink-0 text-[11px] font-[440] text-v2-text-text-faint">{record.session.agent ?? ""}</span>
                      </button>
                    )}
                  </For>
                </div>
              </Show>
            </div>

            <div class="flex flex-col gap-3">
              <span class="text-[11px] font-[530] uppercase tracking-wide text-v2-text-text-muted">{language.t("work.home.superskills")}</span>
              <div class="flex flex-col gap-3 rounded-lg border border-v2-border-border-muted bg-v2-background-bg-base p-4">
                <div class="flex items-center gap-2">
                  <Icon name="dot-grid" size="small" class="text-v2-icon-icon-muted" />
                  <span class="text-[13px] font-[530] text-v2-text-text-base">
                    {superskills() === undefined ? "—" : superskills()!.length}
                  </span>
                </div>
                <Button variant="secondary" size="small" onClick={openSettings}>
                  {language.t("work.home.superskills.manage")}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </ScrollView>
    </div>
  )
}
