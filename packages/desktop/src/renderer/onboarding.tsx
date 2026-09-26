import { ServerConnection, useServer, useSettings, useTabs } from "@opencode-ai/app"
import { createSignal, For, onMount, Show } from "solid-js"
import { Mark } from "@opencode-ai/ui/logo"
import { Button } from "@opencode-ai/ui/button"

type Readiness = {
  label: string
  status: string
  detail?: string
}

const STATUS_LABEL: Record<string, string> = {
  available: "Ready",
  degraded: "Limited",
  unavailable: "Unavailable",
  unknown: "Not checked yet",
  granted: "Ready",
}

const STATUS_CLASS: Record<string, string> = {
  available: "bg-icon-success-base",
  degraded: "bg-icon-warning-base",
  unavailable: "bg-icon-critical-base",
  unknown: "bg-icon-weak-base",
  granted: "bg-icon-success-base",
}

const SETUP_PENDING_KEY = "omnia.setup.pending"

function statusClass(status: string) {
  return STATUS_CLASS[status] ?? "bg-icon-weak-base"
}

export function DesktopFirstLaunchOnboarding(props: { initialUrl: string; onLoaded: () => void }) {
  const server = useServer()
  const settings = useSettings()
  const tabs = useTabs()
  const [setup, setSetup] = createSignal(false)
  const [readiness, setReadiness] = createSignal<Readiness[]>([])
  const [checking, setChecking] = createSignal(true)

  onMount(() => {
    if (window.localStorage?.getItem(SETUP_PENDING_KEY) === "1") {
      setSetup(true)
      void loadReadiness()
    }
    void runFirstLaunchOnboarding().finally(props.onLoaded)
  })

  function dismiss() {
    window.localStorage?.removeItem(SETUP_PENDING_KEY)
    setSetup(false)
  }

  async function runFirstLaunchOnboarding() {
    try {
      await Promise.all(
        [server.ready.promise, tabs.ready.promise, tabs.recentReady.promise].map((p) => p ?? Promise.resolve()),
      )
      const existingInstall = await window.api.isOldLayoutEligible()
      settings.general.setOldLayoutEligible(existingInstall)
      settings.general.initializeAgentVisibility(existingInstall)
      if (!server.isLocal()) return

      const pending = await window.api.isFirstLaunchOnboardingPending()
      if (!pending) return

      const shouldTrigger =
        !existingInstall &&
        props.initialUrl === "/" &&
        tabs.store.length === 0 &&
        server.list.every(ServerConnection.builtin)
      if (!shouldTrigger) {
        await window.api.finishFirstLaunchOnboarding(false)
        return
      }

      // Show the setup screen as soon as first launch is confirmed so the
      // overlay cannot be lost if this view is re-created while the first
      // task is being opened.
      window.localStorage?.setItem(SETUP_PENDING_KEY, "1")
      setSetup(true)
      void loadReadiness()

      const directory = await window.api.finishFirstLaunchOnboarding(true)
      if (!directory) return
      server.projects.open(directory)
      server.projects.touch(directory)
      try {
        tabs.select(await tabs.newDraft({ server: server.key, directory }))
      } catch (error) {
        console.error("[desktop-onboarding] opening the first task failed", error)
      }
    } catch (error) {
      console.error("[desktop-onboarding] first launch onboarding failed", error)
    }
  }

  async function loadReadiness() {
    setChecking(true)
    try {
      const result = await window.api.omnia?.getCapabilities().catch(() => undefined)
      if (!result || result.ok !== true) {
        setReadiness([
          {
            label: "Omnia Server",
            status: "unavailable",
            detail: "The computer runtime is not responding. Restart Omnia Desktop to retry.",
          },
        ])
        return
      }
      const capabilities = result.value.capabilities ?? []
      const capability = (name: string) => capabilities.find((entry) => entry.capability === name)
      setReadiness([
        {
          label: "Omnia Server",
          status: result.value.available ? "available" : "unavailable",
          detail: `${result.value.platform} · ${result.value.backend}`,
        },
        {
          label: "Accessibility",
          status: capability("accessibility")?.status ?? "unknown",
          detail: capability("accessibility")?.reason,
        },
        {
          label: "Keyboard control",
          status: capability("keyboard")?.status ?? "unknown",
          detail: capability("keyboard")?.reason,
        },
        {
          label: "Pointer control",
          status: capability("pointer")?.status ?? "unknown",
          detail: capability("pointer")?.reason,
        },
        {
          label: "Screen capture",
          status: capability("screen_read")?.status ?? "unknown",
          detail: capability("screen_read")?.reason,
        },
        {
          label: "Application launching",
          status: capability("launch")?.status ?? "unknown",
          detail: capability("launch")?.reason,
        },
      ])
    } finally {
      setChecking(false)
    }
  }

  return (
    <Show when={setup()}>
      <div class="fixed inset-0 z-50 flex items-center justify-center bg-background-base/95 backdrop-blur-sm">
        <div class="w-full max-w-135 mx-6 rounded-xl border border-border-weak-base bg-background-stronger p-8 shadow-lg">
          <div class="flex items-center gap-3 mb-6">
            <Mark class="w-5 h-6" />
            <div class="text-16-medium text-text-strong">Omnia</div>
          </div>

          <div class="mb-6">
            <div class="text-11-medium text-text-weak uppercase tracking-wide mb-2">Computer readiness</div>
            <div class="flex flex-col gap-1">
              <For each={readiness()}>
                {(entry) => (
                  <div class="flex items-center gap-2 text-12-regular">
                    <span class={`w-1.5 h-1.5 rounded-full ${statusClass(entry.status)}`} />
                    <span class="text-text-strong">{entry.label}</span>
                    <span class="text-text-weak" title={entry.detail}>
                      {STATUS_LABEL[entry.status] ?? entry.status}
                    </span>
                  </div>
                )}
              </For>
              <Show when={checking() && readiness().length === 0}>
                <span class="text-12-regular text-text-weak">Checking this computer…</span>
              </Show>
            </div>
          </div>

          <div class="flex items-center justify-between">
            <Button variant="ghost" size="small" onClick={() => void loadReadiness()}>
              Check again
            </Button>
            <Button variant="primary" size="normal" onClick={dismiss}>
              Get started
            </Button>
          </div>
        </div>
      </div>
    </Show>
  )
}
