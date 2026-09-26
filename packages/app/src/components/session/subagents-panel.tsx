import { For, Show, createMemo, createSignal, onCleanup } from "solid-js"
import { useData } from "@opencode-ai/session-ui/context/data"
import { Icon } from "@opencode-ai/ui/icon"
import { useLanguage } from "@/context/language"

function timeValue(value: unknown): number {
  if (typeof value === "number") return value
  if (value instanceof Date) return value.getTime()
  return Date.now()
}

function elapsed(from: number, to: number): string {
  const seconds = Math.max(0, Math.round((to - from) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export function useSubagentSessions() {
  const data = useData()
  const sessions = createMemo(() =>
    data.store.session
      .filter((session) => session.parentID === data.sessionID)
      .sort((a, b) => timeValue(b.time.updated) - timeValue(a.time.updated)),
  )
  const statusOf = (id: string) => data.store.session_status[id]?.type ?? "idle"
  const running = createMemo(() => sessions().filter((session) => statusOf(session.id) !== "idle").length)
  return { sessions, running, statusOf }
}

export function SubagentsPanel(props: { onSelect?: (id: string) => void }) {
  const data = useData()
  const language = useLanguage()
  const { sessions, statusOf } = useSubagentSessions()
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(timer))

  return (
    <div class="flex flex-col h-full min-h-0">
      <Show
        when={sessions().length > 0}
        fallback={
          <div class="flex-1 flex flex-col items-center justify-center gap-3 text-center px-6">
            <Icon name="subagent" size="large" class="text-icon-weak-base opacity-40" />
            <div class="text-12-regular text-text-weak">{language.t("session.subagents.empty")}</div>
          </div>
        }
      >
        <div class="flex-1 min-h-0 overflow-y-auto">
          <div class="flex flex-col gap-0.5 px-2 py-2">
            <For each={sessions()}>
              {(session) => {
                const status = createMemo(() => statusOf(session.id))
                const active = createMemo(() => status() !== "idle")
                const title = createMemo(() => session.title || session.id)
                const agent = createMemo(() => session.agent ?? "")
                const model = createMemo(() => {
                  const ref = session.model
                  if (!ref) return ""
                  return typeof ref === "object" && "modelID" in ref ? String(ref.modelID) : ""
                })
                const age = createMemo(() => elapsed(timeValue(session.time.created), now()))
                return (
                  <button
                    type="button"
                    class="group flex items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-surface-raised-base-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-strong-base"
                    onClick={() => props.onSelect?.(session.id)}
                    title={title()}
                  >
                    <span class="relative mt-1 flex h-2 w-2 shrink-0">
                      <Show when={active()}>
                        <span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-icon-warning-base opacity-60" />
                      </Show>
                      <span
                        class="relative inline-flex h-2 w-2 rounded-full"
                        classList={{
                          "bg-icon-warning-base": active(),
                          "bg-icon-success-base": !active(),
                        }}
                      />
                    </span>
                    <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span class="truncate text-12-medium text-text-strong">{title()}</span>
                      <span class="flex items-center gap-1.5 text-11-regular text-text-weak">
                        <Show when={agent()}>
                          <span class="truncate">{agent()}</span>
                        </Show>
                        <Show when={agent() && model()}>
                          <span class="opacity-40">·</span>
                        </Show>
                        <Show when={model()}>
                          <span class="truncate">{model()}</span>
                        </Show>
                      </span>
                    </span>
                    <span class="shrink-0 pt-0.5 text-11-regular tabular-nums text-text-weaker">{age()}</span>
                  </button>
                )
              }}
            </For>
          </div>
        </div>
      </Show>
    </div>
  )
}
