import { createResource, createSignal, For, Match, Show, Switch } from "solid-js"
import { Logo } from "@opencode-ai/ui/logo"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { LoaderV2 } from "@opencode-ai/ui/v2/loader-v2"
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

type Step = "welcome" | "import" | "project" | "done"

function formatDate(value: number | null): string {
  if (value === null) return ""
  return new Date(value).toLocaleDateString(undefined, { dateStyle: "medium" })
}

/**
 * First-launch setup: welcome, session import from OpenCode and Codex, then a
 * first project. Renders nothing once onboarding is complete or when the
 * desktop bridge is absent (web mode has no onboarding).
 */
export function OnboardingWizard() {
  const [pending, setPending] = createSignal<boolean | undefined>(undefined)

  void window.api?.isFirstLaunchOnboardingPending?.().then(
    (value) => setPending(value === true),
    () => setPending(false),
  )

  return <Show when={pending() === true}>{<WizardBody onDone={() => setPending(false)} />}</Show>
}

function WizardBody(props: { onDone: () => void }) {
  const language = useLanguage()
  const [step, setStep] = createSignal<Step>("welcome")

  return (
    <div
      data-component="onboarding-wizard"
      class="fixed inset-0 z-[9997] flex flex-col items-center justify-center gap-6 overflow-y-auto bg-v2-background-bg-base p-6"
    >
      <Logo class="w-28" />
      <div class="flex w-full max-w-md flex-col items-center gap-4">
        <Switch>
          <Match when={step() === "welcome"}>
            <div class="flex max-w-sm flex-col items-center gap-2 text-center">
              <h1 class="text-[15px] font-[640] leading-5 text-v2-text-text-base">
                {language.t("ui.onboarding.welcomeTitle")}
              </h1>
              <p class="text-[13px] font-[440] leading-5 text-v2-text-text-muted">
                {language.t("ui.onboarding.welcomeBody")}
              </p>
            </div>
            <div class="flex flex-col items-center gap-3">
              <ButtonV2 size="large" class="min-w-48 justify-center" onClick={() => setStep("import")}>
                {language.t("ui.onboarding.continue")}
              </ButtonV2>
              <button
                type="button"
                class="text-[12px] font-[440] text-v2-text-text-muted underline underline-offset-2 hover:text-v2-text-text-base"
                onClick={() => setStep("project")}
              >
                {language.t("ui.onboarding.skipAll")}
              </button>
            </div>
          </Match>
          <Match when={step() === "import"}>
            <ImportStep onBack={() => setStep("welcome")} onNext={() => setStep("project")} />
          </Match>
          <Match when={step() === "project"}>
            <ProjectStep onBack={() => setStep("import")} onDone={props.onDone} />
          </Match>
        </Switch>
      </div>
    </div>
  )
}

function ImportStep(props: { onBack: () => void; onNext: () => void }) {
  const language = useLanguage()
  const [selected, setSelected] = createSignal<Set<string>>(new Set())
  const [running, setRunning] = createSignal(false)
  const [reports, setReports] = createSignal<ImportReport[]>([])
  const [failed, setFailed] = createSignal<string | undefined>(undefined)

  const [sources] = createResource(async (): Promise<ImportSource[]> => {
    const detected = await window.api?.importSourcesDetect?.()
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
    <div class="flex w-full flex-col items-center gap-4">
      <div class="flex max-w-sm flex-col items-center gap-2 text-center">
        <h1 class="text-[15px] font-[640] leading-5 text-v2-text-text-base">{language.t("ui.onboarding.importTitle")}</h1>
        <p class="text-[13px] font-[440] leading-5 text-v2-text-text-muted">{language.t("ui.onboarding.importBody")}</p>
      </div>
      <Show when={sources.loading} fallback={
        <Show
          when={(sources() ?? []).length > 0}
          fallback={<p class="text-[13px] text-v2-text-text-muted">{language.t("ui.onboarding.importNone")}</p>}
        >
          <div class="flex w-full flex-col gap-2">
            <For each={sources() ?? []}>
              {(source) => (
                <label class="flex cursor-pointer items-start gap-3 rounded-xl border border-v2-alias-border-l3 p-3 text-left">
                  <input
                    type="checkbox"
                    class="mt-1"
                    checked={selected().has(source.path)}
                    onChange={() => toggle(source.path)}
                    aria-label={source.path}
                  />
                  <span class="flex min-w-0 flex-col gap-0.5">
                    <span class="text-[13px] font-[600] text-v2-text-text-base">
                      {source.kind === "opencode"
                        ? language.t("ui.onboarding.opencodeSource")
                        : language.t("ui.onboarding.codexSource")}
                    </span>
                    <span class="truncate text-[11px] text-v2-text-text-muted" title={source.path}>
                      {source.path}
                    </span>
                    <span class="text-[12px] text-v2-text-text-muted">
                      {language.plural("ui.onboarding.sessions", source.sessions)}
                      {" · "}
                      {language.plural("ui.onboarding.messages", source.messages)}
                      {source.oldest !== null && source.newest !== null
                        ? ` · ${formatDate(source.oldest)} – ${formatDate(source.newest)}`
                        : ""}
                    </span>
                  </span>
                </label>
              )}
            </For>
          </div>
          <Show when={reports().length > 0}>
            <div class="flex w-full flex-col gap-1 rounded-xl bg-v2-alias-bg-layer-2 p-3 text-[12px] text-v2-text-text-base">
              <strong>{language.t("ui.onboarding.importDone")}</strong>
              <span>
                {language.plural("ui.onboarding.importedSessions", totals().sessions)}
                {" · "}
                {language.plural("ui.onboarding.importedMessages", totals().messages)}
              </span>
              <Show when={totals().skipped > 0}>
                <span class="text-v2-text-text-muted">
                  {language.plural("ui.onboarding.skippedSessions", totals().skipped)}
                </span>
              </Show>
              <For each={totals().errors}>{(error) => <span class="text-v2-state-fg-danger">{error}</span>}</For>
            </div>
          </Show>
          <Show when={failed() !== undefined}>
            <p class="text-[13px] text-v2-state-fg-danger">{failed()}</p>
          </Show>
        </Show>
      }>
        <LoaderV2 width={20} height={20} />
      </Show>
      <div class="flex items-center gap-3">
        <button
          type="button"
          class="text-[12px] font-[440] text-v2-text-text-muted underline underline-offset-2 hover:text-v2-text-text-base"
          onClick={props.onBack}
        >
          {language.t("ui.onboarding.back")}
        </button>
        <Show
          when={reports().length === 0}
          fallback={
            <ButtonV2 size="large" class="min-w-48 justify-center" onClick={props.onNext}>
              {language.t("ui.onboarding.continue")}
            </ButtonV2>
          }
        >
          <ButtonV2
            size="large"
            class="min-w-48 justify-center"
            disabled={selected().size === 0 || running() || sources.loading}
            onClick={() => void runImport()}
          >
            {running() ? language.t("ui.onboarding.importing") : language.t("ui.onboarding.importSelected")}
          </ButtonV2>
        </Show>
        <button
          type="button"
          class="text-[12px] font-[440] text-v2-text-text-muted underline underline-offset-2 hover:text-v2-text-text-base"
          onClick={props.onNext}
        >
          {language.t("ui.onboarding.skip")}
        </button>
      </div>
    </div>
  )
}

function ProjectStep(props: { onBack: () => void; onDone: () => void }) {
  const language = useLanguage()
  const [working, setWorking] = createSignal(false)
  const [failed, setFailed] = createSignal<string | undefined>(undefined)

  const finish = async (createDefaultProject: boolean) => {
    if (working()) return
    setWorking(true)
    setFailed(undefined)
    try {
      await window.api?.finishFirstLaunchOnboarding?.(createDefaultProject)
      props.onDone()
    } catch (error) {
      setFailed(error instanceof Error ? error.message : String(error))
    } finally {
      setWorking(false)
    }
  }

  return (
    <div class="flex w-full flex-col items-center gap-4">
      <div class="flex max-w-sm flex-col items-center gap-2 text-center">
        <h1 class="text-[15px] font-[640] leading-5 text-v2-text-text-base">
          {language.t("ui.onboarding.projectTitle")}
        </h1>
        <p class="text-[13px] font-[440] leading-5 text-v2-text-text-muted">
          {language.t("ui.onboarding.projectBody")}
        </p>
      </div>
      <Show when={failed() !== undefined}>
        <p class="text-[13px] text-v2-state-fg-danger">{failed()}</p>
      </Show>
      <div class="flex items-center gap-3">
        <button
          type="button"
          class="text-[12px] font-[440] text-v2-text-text-muted underline underline-offset-2 hover:text-v2-text-text-base"
          onClick={props.onBack}
        >
          {language.t("ui.onboarding.back")}
        </button>
        <ButtonV2 size="large" class="min-w-48 justify-center" disabled={working()} onClick={() => void finish(true)}>
          {language.t("ui.onboarding.createProject")}
        </ButtonV2>
        <button
          type="button"
          class="text-[12px] font-[440] text-v2-text-text-muted underline underline-offset-2 hover:text-v2-text-text-base"
          onClick={() => void finish(false)}
        >
          {language.t("ui.onboarding.skip")}
        </button>
      </div>
    </div>
  )
}
