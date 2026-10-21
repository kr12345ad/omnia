import { createResource, createSignal, For, Show } from "solid-js"
import { useQueryClient } from "@tanstack/solid-query"
import { Button } from "@opencode-ai/ui/button"
import { useLanguage } from "@/context/language"

interface ImportSource {
  readonly kind: "opencode" | "codex"
  readonly path: string
  readonly bytes: number
  readonly sessions: number
  readonly messages: number
  readonly oldest: number | null
  readonly newest: number | null
}

interface ImportReport {
  readonly importedSessions: number
  readonly importedMessages: number
  readonly importedParts: number
  readonly skippedSessions: number
  readonly errors: string[]
}

function formatDate(value: number | null): string {
  if (value === null) return ""
  return new Date(value).toLocaleDateString(undefined, { dateStyle: "medium" })
}

const bridgeAvailable = () =>
  typeof window.api?.importSourcesDetect === "function" && typeof window.api?.importSessionsRun === "function"

/**
 * Re-runnable session import: detects OpenCode databases and Codex rollout
 * files on this computer and converts them into Omnia sessions. The desktop
 * bridge does the work; originals are never modified.
 */
export const SettingsSessions = () => {
  const language = useLanguage()
  const queryClient = useQueryClient()
  const [selected, setSelected] = createSignal<Set<string>>(new Set())
  const [running, setRunning] = createSignal(false)
  const [reports, setReports] = createSignal<ImportReport[]>([])
  const [failed, setFailed] = createSignal<string | undefined>(undefined)

  const [sources, { refetch }] = createResource(async (): Promise<ImportSource[]> => {
    if (!bridgeAvailable()) return []
    const detected = await window.api!.importSourcesDetect!()
    return Array.isArray(detected) ? detected : []
  })

  const toggle = (path: string) => {
    setSelected((previous) => {
      const next = new Set(previous)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const runImport = async () => {
    const chosen = (sources() ?? []).filter((source) => selected().has(source.path))
    if (chosen.length === 0 || running()) return
    setRunning(true)
    setFailed(undefined)
    try {
      const done: ImportReport[] = []
      for (const source of chosen) {
        done.push(await window.api!.importSessionsRun!({ kind: source.kind, path: source.path }))
      }
      setReports(done)
      // The import writes straight to the database the server reads, so cached
      // session and project lists have to be re-read before the user looks.
      if (done.some((report) => report.importedSessions > 0)) void queryClient.invalidateQueries()
      void refetch()
    } catch (error) {
      setFailed(error instanceof Error ? error.message : String(error))
    } finally {
      setRunning(false)
    }
  }

  const totals = () => ({
    sessions: reports().reduce((sum, report) => sum + report.importedSessions, 0),
    messages: reports().reduce((sum, report) => sum + report.importedMessages, 0),
    skipped: reports().reduce((sum, report) => sum + report.skippedSessions, 0),
    errors: reports().flatMap((report) => report.errors),
  })

  return (
    <>
      <div class="settings-v2-tab-header">
        <div class="flex items-start justify-between gap-4">
          <div class="flex flex-col gap-1">
            <h2 class="settings-v2-tab-title">{language.t("settings.sessions.title")}</h2>
            <p class="text-[13px] font-[440] text-v2-text-text-muted">{language.t("settings.sessions.description")}</p>
          </div>
          <Button variant="secondary" size="small" onClick={() => void refetch()} disabled={!bridgeAvailable()}>
            {language.t("settings.sessions.refresh")}
          </Button>
        </div>
      </div>
      <div class="settings-v2-tab-body">
        <Show when={!bridgeAvailable()}>
          <div class="text-[13px] font-[440] text-v2-text-text-muted">
            {language.t("settings.sessions.unavailable")}
          </div>
        </Show>

        <Show when={bridgeAvailable()}>
          <div class="flex flex-col gap-4">
            <Show when={sources.loading}>
              <div class="text-[13px] font-[440] text-v2-text-text-muted">{language.t("common.loading")}</div>
            </Show>

            <Show when={!sources.loading && (sources() ?? []).length === 0}>
              <div class="text-[13px] font-[440] text-v2-text-text-muted">
                {language.t("settings.sessions.empty")}
              </div>
            </Show>

            <div class="flex flex-col gap-2">
              <For each={sources() ?? []}>
                {(source) => (
                  <label class="flex cursor-pointer items-start gap-3 rounded-md border border-v2-border-border-muted p-3 text-left">
                    <input
                      type="checkbox"
                      class="mt-1"
                      checked={selected().has(source.path)}
                      onChange={() => toggle(source.path)}
                      aria-label={source.path}
                    />
                    <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span class="text-[13px] font-[600] text-v2-text-text-base">
                        {source.kind === "opencode"
                          ? language.t("settings.sessions.opencodeSource")
                          : language.t("settings.sessions.codexSource")}
                      </span>
                      <span class="truncate text-[11px] text-v2-text-text-muted" title={source.path}>
                        {source.path}
                      </span>
                      <span class="text-[12px] text-v2-text-text-muted">
                        {language.t("settings.sessions.countLine", {
                          sessions: String(source.sessions),
                          messages: String(source.messages),
                        })}
                        {source.oldest !== null && source.newest !== null
                          ? ` · ${formatDate(source.oldest)} – ${formatDate(source.newest)}`
                          : ""}
                      </span>
                    </span>
                  </label>
                )}
              </For>
            </div>

            <div class="flex items-center gap-2">
              <Button size="small" disabled={selected().size === 0 || running()} onClick={() => void runImport()}>
                {running() ? language.t("settings.sessions.importing") : language.t("settings.sessions.importSelected")}
              </Button>
            </div>

            <Show when={reports().length > 0}>
              <div class="flex flex-col gap-1 rounded-md bg-v2-background-bg-layer-01 p-3 text-[12px] text-v2-text-text-base">
                <strong>{language.t("settings.sessions.done")}</strong>
                <span>
                  {language.t("settings.sessions.importedLine", {
                    sessions: String(totals().sessions),
                    messages: String(totals().messages),
                  })}
                </span>
                <Show when={totals().skipped > 0}>
                  <span class="text-v2-text-text-muted">
                    {language.t("settings.sessions.skippedLine", { skipped: String(totals().skipped) })}
                  </span>
                </Show>
                <For each={totals().errors}>{(error) => <span class="text-v2-state-fg-danger">{error}</span>}</For>
              </div>
            </Show>

            <Show when={failed() !== undefined}>
              <div class="rounded-md bg-v2-background-bg-layer-01 p-2 text-[11px] font-[440] text-v2-state-fg-danger">
                {failed()}
              </div>
            </Show>
          </div>
        </Show>
      </div>
    </>
  )
}
