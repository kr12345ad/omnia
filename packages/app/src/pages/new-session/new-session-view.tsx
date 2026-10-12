import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { WordmarkV2 } from "@opencode-ai/ui/v2/wordmark-v2"
import { For, Show, createMemo, createResource, createSignal, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { Portal } from "solid-js/web"
import createPresence from "solid-presence"
import { DialogNewDiscussion } from "@/components/dialog-new-discussion"
import { PromptInputV2Composer } from "@/components/prompt-input-v2"
import { PromptGitStatus, PromptWorkspaceSelector } from "@/components/prompt-workspace-selector"
import {
  PromptProjectAddButton,
  PromptProjectSelector,
  type PromptProjectController,
} from "@/components/prompt-project-selector"
import { useSettingsDialog } from "@/components/settings-dialog"
import { StatusPopoverV2 } from "@/components/status-popover"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { usePrompt } from "@/context/prompt"
import { useSDK } from "@/context/sdk"
import { useServerSync } from "@/context/server-sync"
import { useProviders } from "@/hooks/use-providers"
import { NEW_SESSION_CONTENT_WIDTH } from "@/pages/session/new-session-layout"
import { Persist, persisted } from "@/utils/persist"
import type { NewSessionDraftController } from "./new-session-draft-controller"
import type { NewSessionWorkspaceController } from "./new-session-workspace-controller"

const providerTipDismissalDuration = 30 * 24 * 60 * 60 * 1000

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

// Flat, like the prompt box above them: the same surface as the v2 input, with no
// gradient or card outline, so the actions read as part of the page they sit on.
const TILE_SURFACE = "bg-v2-background-bg-base transition-colors hover:bg-v2-overlay-simple-overlay-hover"

export function NewSessionView(props: {
  input: NewSessionDraftController["input"]
  project: PromptProjectController
  workspace: NewSessionWorkspaceController
}) {
  const language = useLanguage()
  const platform = usePlatform()
  const prompt = usePrompt()
  const dialog = useDialog()
  const openSettings = useSettingsDialog("superskills")

  const [superskills] = createResource(async () => {
    if (!platform.superskills) return undefined
    return platform.superskills.list().catch(() => undefined)
  })

  // A quick action fills the box the user is already looking at rather than
  // opening a second draft: the click is a starting point they can edit and send.
  const start = (action: (typeof QUICK_ACTIONS)[number]) => {
    if (action.id === "discussion") {
      void dialog.show(() => <DialogNewDiscussion />)
      return
    }
    if (!("promptKey" in action)) return
    const text = language.t(action.promptKey, "values" in action ? action.values : undefined)
    prompt.set([{ type: "text", content: text, start: 0, end: text.length }], text.length)
    props.input.restoreFocus()
  }

  return (
    <div class="@container relative flex flex-col min-h-0 h-full flex-1">
      <div
        data-component="session-new-design"
        class="relative flex-1 min-h-0 overflow-hidden rounded-[10px] bg-v2-background-bg-deep"
      >
        <div class="absolute inset-x-0 bottom-0 top-[25.375%] flex justify-center overflow-y-auto px-6 pb-8 no-scrollbar">
          <div class={NEW_SESSION_CONTENT_WIDTH}>
            <WordmarkV2 class="h-auto w-full text-v2-background-bg-inverse" />
            <div class="mt-8 flex flex-col gap-6">
              <PromptInputV2Composer controller={props.input} />
              <div class="grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-4">
                <For each={QUICK_ACTIONS}>
                  {(action, index) => (
                    <button
                      type="button"
                      data-component="new-session-quick-action"
                      data-action={action.id}
                      class={`anim-rise home-qa-card group flex h-9 items-center gap-2.5 rounded-lg px-3 text-left ${TILE_SURFACE}`}
                      style={{ "animation-delay": `${Math.min(index(), 7) * 45}ms` }}
                      onClick={() => start(action)}
                    >
                      <Icon name={action.icon} size="small" class="shrink-0 text-v2-icon-icon-muted" />
                      <span class="min-w-0 truncate text-[13px] font-[530] text-v2-text-text-base">
                        {language.t(action.labelKey)}
                      </span>
                    </button>
                  )}
                </For>
              </div>
              <div
                data-component="new-session-superskills"
                class={`flex h-9 items-center gap-3 rounded-lg px-3 ${TILE_SURFACE}`}
              >
                <Icon name="dot-grid" size="small" class="shrink-0 text-v2-icon-icon-muted" />
                <span class="min-w-0 flex-1 truncate text-[13px] text-v2-text-text-muted">
                  {language.t("work.home.superskills")}
                </span>
                <span class="text-[13px] font-[530] text-v2-text-text-base">
                  {superskills() === undefined ? "—" : superskills()!.length}
                </span>
                <ButtonV2 variant="neutral" size="small" onClick={openSettings}>
                  {language.t("work.home.superskills.manage")}
                </ButtonV2>
              </div>
              <Show when={props.project.empty()}>
                <PromptProjectAddButton controller={props.project} />
              </Show>
              <Show when={props.project.selected()}>
                <div class="flex min-h-7 min-w-0 flex-col items-center justify-center gap-0 text-v2-text-text-faint sm:flex-row">
                  <PromptProjectSelector controller={props.project} placement="bottom" />
                  <Show
                    when={props.workspace.bar.visible()}
                    fallback={
                      <PromptGitStatus branch={props.workspace.bar.branch()} noGit={!props.workspace.project.git()} />
                    }
                  >
                    <PromptWorkspaceSelector
                      value={props.workspace.selection.value()}
                      projectRoot={props.workspace.project.root()}
                      workspaces={props.workspace.project.workspaces()}
                      branch={props.workspace.bar.branch()}
                      onChange={props.workspace.selection.set}
                      onDone={props.input.restoreFocus}
                    />
                  </Show>
                </div>
              </Show>
            </div>
          </div>
        </div>
        <ProviderTip />
      </div>
    </div>
  )
}

export function NewSessionStatus(props: { mount: Accessor<HTMLElement | null>; visible: Accessor<boolean> }) {
  const language = useLanguage()

  return (
    <Show when={props.mount()} keyed>
      {(mount) => (
        <Portal mount={mount}>
          <Show when={props.visible()}>
            <Tooltip placement="bottom" value={language.t("status.popover.trigger")}>
              <StatusPopoverV2 />
            </Tooltip>
          </Show>
        </Portal>
      )}
    </Show>
  )
}

function ProviderTip() {
  const language = useLanguage()
  const dialog = useDialog()
  const sdk = useSDK()
  const serverSync = useServerSync()
  const providers = useProviders(() => sdk().directory)
  const [persistedState, setPersistedState, , persistedReady] = persisted(
    Persist.global("new-session.provider-tip"),
    createStore({ dismissedAt: 0 }),
  )
  const visible = createMemo(
    () =>
      serverSync().child(sdk().directory)[0].provider_ready &&
      persistedReady() &&
      providers.paid().length === 0 &&
      Date.now() - persistedState.dismissedAt >= providerTipDismissalDuration,
  )
  const [ref, setRef] = createSignal<HTMLDivElement>()
  const presence = createPresence({
    show: visible,
    element: () => ref() ?? null,
  })
  const openProviders = () => {
    void import("@/components/dialog-connect-provider").then(({ DialogConnectProvider }) => {
      void dialog.show(() => <DialogConnectProvider directory={() => sdk().directory} />)
    })
  }

  return (
    <Show when={presence.present()}>
      <div class="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center px-10">
        <div
          ref={setRef}
          data-component="provider-tip"
          data-visible={visible()}
          class="group/provider-tip pointer-events-auto relative flex h-6 max-w-full items-center transition-[opacity,transform] duration-[250ms] ease-[cubic-bezier(0.215,0.61,0.355,1)] motion-reduce:transition-none"
          classList={{ "data-[visible=false]:animate-out fade-out slide-out-to-bottom-4": true }}
        >
          <button
            type="button"
            class="flex h-6 min-w-0 items-center rounded-[4px] pl-1.5 text-[13px] leading-none tracking-[-0.04px] text-v2-text-text-faint transition-[background-color,color] duration-150 ease-in-out hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-muted focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:text-v2-text-text-muted focus-visible:outline-none"
            onClick={openProviders}
          >
            <span class="truncate">{language.t("home.providerTip")}</span>
            <span class="flex size-6 shrink-0 items-center justify-center" aria-hidden="true">
              <IconV2 name="chevron-down" size="small" class="-rotate-90" />
            </span>
          </button>
          <TooltipV2
            class="hover-reveal absolute left-full top-0 flex h-6 w-7 items-center justify-end delay-0 duration-0 group-hover/provider-tip:delay-[250ms] group-hover/provider-tip:duration-150 group-hover/provider-tip:opacity-100 focus-within:delay-0 focus-within:duration-0 focus-within:opacity-100"
            placement="top"
            openDelay={1000}
            value={language.t("common.dismiss")}
          >
            <button
              type="button"
              class="flex size-6 items-center justify-center rounded-[4px] text-v2-icon-icon-muted transition-[background-color,color] duration-150 ease-in-out hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-icon-icon-base focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:text-v2-icon-icon-base focus-visible:outline-none"
              aria-label={language.t("common.dismiss")}
              onClick={() => setPersistedState("dismissedAt", Date.now())}
            >
              <IconV2 name="xmark-small" />
            </button>
          </TooltipV2>
        </div>
      </div>
    </Show>
  )
}
