import { createEffect, Suspense, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { BrowserPanel } from "@/components/browser-panel"
import { DebugBar } from "@/components/debug-bar"
import { TabsInfoPopup } from "@/components/help-button"
import { ShellSidebar } from "@/components/shell-sidebar"
import { Titlebar, type TitlebarUpdate } from "@/components/titlebar"
import { usePlatform } from "@/context/platform"
import { setV2Toast, ToastRegion } from "@/utils/toast"

// The dev-only performance bar. It starts hidden (the shell is what a developer
// is looking at, not the numbers) and `VITE_DISABLE_DEBUG_BAR=1` removes the
// affordance entirely, the same switch the legacy layout honours.
export default function NewLayout(props: ParentProps) {
  const platform = usePlatform()
  const [state, setState] = createStore({ debugTools: false })
  const debugBar = import.meta.env.DEV && import.meta.env.VITE_DISABLE_DEBUG_BAR !== "1"

  createEffect(() => setV2Toast(true))

  const update: TitlebarUpdate = {
    version: () => {
      const state = platform.updater?.state()
      if (state?.status !== "ready") return
      return state.version
    },
    installing: () => platform.updater?.state().status === "installing",
    install: () => void platform.updater?.install(),
  }

  return (
    <div
      class="relative bg-v2-background-bg-deep flex-1 min-h-0 min-w-0 flex flex-col select-none [&_input]:select-text [&_textarea]:select-text [&_[contenteditable]]:select-text"
      style={{
        "padding-top": "env(safe-area-inset-top, 0px)",
        "padding-bottom": "env(safe-area-inset-bottom, 0px)",
      }}
    >
      <Titlebar
        update={update}
        debugTools={
          debugBar ? { visible: state.debugTools, toggle: () => setState("debugTools", (value) => !value) } : undefined
        }
      />
      <div class="flex-1 min-h-0 min-w-0 flex flex-row">
        <ShellSidebar />
        <main class="flex-1 min-h-0 min-w-0 overflow-x-hidden overflow-y-auto flex flex-col items-stretch contain-strict">
          <Suspense>{props.children}</Suspense>
        </main>
        <BrowserPanel />
      </div>
      {debugBar && state.debugTools && <DebugBar inline />}
      <TabsInfoPopup />
      <ToastRegion v2 />
    </div>
  )
}
