import { createMemo, createResource, createSignal, For, onMount, Show, type ParentProps } from "solid-js"
import { Logo } from "@opencode-ai/ui/logo"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { LoaderV2 } from "@opencode-ai/ui/v2/loader-v2"
import { usePlatform, type LegalStatus } from "@/context/platform"
import {
  TERMS_CONTACT,
  TERMS_EFFECTIVE_DATE,
  TERMS_PREAMBLE,
  TERMS_SECTIONS,
  TERMS_VERSION,
} from "@/legal/terms"

/**
 * Sits outside every server-bound provider: a banned installation must render
 * even though no local server starts, and an unaccepted installation must not
 * reach the agent, sessions, or the network before it agrees. Existing installs
 * see this gate too, because acceptance is recorded per terms version and
 * nothing older than the current version counts.
 */
export function LegalGate(props: ParentProps) {
  const platform = usePlatform()
  const legal = platform.legal
  if (legal === undefined) return <>{props.children}</>

  const [status, { mutate }] = createResource(() => legal.status())
  const [failure, setFailure] = createSignal<string | undefined>(undefined)

  return (
    <Show
      when={status()}
      fallback={
        <div data-component="legal-gate-loading" class="fixed inset-0 z-[9999] grid place-items-center bg-v2-background-bg-base">
          <Logo class="w-24 opacity-60" />
        </div>
      }
    >
      {(current) => (
        <Show
          when={current().banned}
          fallback={
            <Show
              when={current().accepted}
              fallback={
                <TermsScreen
                  status={current()}
                  failure={failure()}
                  onAgree={async () => {
                    setFailure(undefined)
                    try {
                      mutate(await legal.accept(TERMS_VERSION))
                    } catch (error) {
                      setFailure(error instanceof Error ? error.message : String(error))
                    }
                  }}
                  onDecline={() => void legal.decline()}
                />
              }
            >
              {props.children}
            </Show>
          }
        >
          <BanScreen
            status={current()}
            failure={failure()}
            onRefresh={async () => {
              setFailure(undefined)
              try {
                // A successful re-check restores the sealed database and
                // relaunches the app from the main process, so the server can
                // start against a database that exists again.
                mutate(await legal.refresh())
              } catch (error) {
                setFailure(error instanceof Error ? error.message : String(error))
              }
            }}
          />
        </Show>
      )}
    </Show>
  )
}

function TermsScreen(props: {
  status: LegalStatus
  failure?: string
  onAgree: () => Promise<void> | void
  onDecline: () => void
}) {
  const [reachedEnd, setReachedEnd] = createSignal(false)
  const [agreeing, setAgreeing] = createSignal(false)
  let body: HTMLDivElement | undefined

  const atEnd = (element: HTMLDivElement) =>
    element.scrollHeight - element.scrollTop - element.clientHeight < 24

  onMount(() => {
    if (body !== undefined && atEnd(body)) setReachedEnd(true)
  })

  const accept = async () => {
    if (!reachedEnd() || agreeing()) return
    setAgreeing(true)
    try {
      await props.onAgree()
    } finally {
      setAgreeing(false)
    }
  }

  return (
    <div
      data-component="terms-gate"
      class="fixed inset-0 z-[9999] flex flex-col items-center justify-center overflow-y-auto bg-v2-background-bg-base p-4 sm:p-6"
    >
      <div class="flex w-full max-w-2xl flex-col gap-4 rounded-xl border-[0.5px] border-v2-border-border-base bg-v2-background-bg-deep px-5 py-6 sm:px-7">
        <div class="flex flex-col items-center gap-2 text-center">
          <Logo class="w-24" />
          <h1 class="text-[17px] font-[640] leading-6 text-v2-text-text-base">Terms of Service</h1>
          <p class="text-[12px] font-[440] leading-4 text-v2-text-text-muted">
            Version {TERMS_VERSION} · effective {TERMS_EFFECTIVE_DATE}
          </p>
        </div>

        <div
          ref={body}
          data-slot="terms-body"
          class="flex max-h-[52vh] min-h-48 flex-col gap-4 overflow-y-auto pr-2 text-left"
          onScroll={(event) => {
            if (atEnd(event.currentTarget)) setReachedEnd(true)
          }}
        >
          <div class="flex flex-col gap-2">
            <For each={TERMS_PREAMBLE}>
              {(paragraph) => (
                <p class="text-[12px] font-[440] leading-5 text-v2-text-text-muted">{paragraph}</p>
              )}
            </For>
          </div>
          <For each={TERMS_SECTIONS}>
            {(section) => (
              <section class="flex flex-col gap-2">
                <h2 class="text-[13px] font-[600] leading-5 text-v2-text-text-base">{section.title}</h2>
                <For each={section.paragraphs ?? []}>
                  {(paragraph) => (
                    <p class="text-[12px] font-[440] leading-5 text-v2-text-text-muted">{paragraph}</p>
                  )}
                </For>
                <Show when={(section.bullets ?? []).length > 0}>
                  <ul class="flex list-disc flex-col gap-1.5 pl-5">
                    <For each={section.bullets ?? []}>
                      {(item) => (
                        <li class="text-[12px] font-[440] leading-5 text-v2-text-text-muted">{item}</li>
                      )}
                    </For>
                  </ul>
                </Show>
              </section>
            )}
          </For>
          <p class="text-[12px] font-[440] leading-5 text-v2-text-text-muted">
            Contact:{" "}
            <a
              href={`mailto:${TERMS_CONTACT}`}
              class="underline underline-offset-2 hover:text-v2-text-text-base"
            >
              {TERMS_CONTACT}
            </a>
          </p>
        </div>

        <div class="flex flex-col items-center gap-2 border-t-[0.5px] border-v2-border-border-base pt-4">
          <p class="text-[11px] font-[440] leading-4 text-v2-text-text-muted">
            {reachedEnd()
              ? "By selecting I agree, you accept these Terms."
              : "Scroll to the end of the Terms to continue."}
          </p>
          <Show when={props.failure}>
            <p class="text-[12px] font-[440] text-v2-state-fg-danger">{props.failure}</p>
          </Show>
          <div class="flex flex-wrap items-center justify-center gap-3">
            <ButtonV2
              size="large"
              class="min-w-48 justify-center"
              disabled={!reachedEnd() || agreeing()}
              onClick={() => void accept()}
            >
              <Show when={!agreeing()} fallback={<LoaderV2 width={16} height={16} />}>
                I agree
              </Show>
            </ButtonV2>
            <button
              type="button"
              class="text-[12px] font-[440] text-v2-text-text-muted underline underline-offset-2 hover:text-v2-text-text-base"
              onClick={props.onDecline}
            >
              Decline and quit
            </button>
          </div>
          <p class="text-[11px] font-[440] leading-4 text-v2-text-text-muted">
            Omnia cannot be used until the current Terms are accepted.
          </p>
        </div>
      </div>
    </div>
  )
}

function BanScreen(props: {
  status: LegalStatus
  failure?: string
  onRefresh: () => Promise<void> | void
}) {
  const platform = usePlatform()
  const [checking, setChecking] = createSignal(false)
  const date = createMemo(() => {
    const value = props.status.bannedAt
    return value === null ? null : new Date(value).toLocaleDateString(undefined, { dateStyle: "medium" })
  })
  const appeal = createMemo(() => {
    const subject = `Ban appeal — ${props.status.fingerprint}`
    const lines = [
      "Hello,",
      "",
      "I would like to appeal the ban on my Omnia installation.",
      "",
      `Fingerprint: ${props.status.fingerprint}`,
      `Reason shown: ${props.status.reason ?? "not stated"}`,
      `Banned: ${date() ?? "unknown"}`,
      "",
      "What happened:",
      "",
    ]
    return `mailto:${TERMS_CONTACT}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(lines.join("\n"))}`
  })

  const refresh = async () => {
    if (checking()) return
    setChecking(true)
    try {
      await props.onRefresh()
    } finally {
      setChecking(false)
    }
  }

  return (
    <div
      data-component="ban-gate"
      class="fixed inset-0 z-[9999] flex flex-col items-center justify-center overflow-y-auto bg-v2-background-bg-base p-6"
    >
      <div class="flex w-full max-w-lg flex-col gap-5 rounded-xl border-[0.5px] border-v2-border-border-base bg-v2-background-bg-deep px-6 py-7">
        <div class="flex flex-col items-center gap-2 text-center">
          <Logo class="w-24 opacity-80" />
          <h1 class="text-[17px] font-[640] leading-6 text-v2-text-text-base">
            This installation is banned
          </h1>
          <p class="text-[13px] font-[440] leading-5 text-v2-text-text-muted">
            Omnia can no longer run on this computer. The decision was made because activity here was
            found to breach the Terms of Service.
          </p>
        </div>

        <dl class="flex flex-col gap-2 rounded-lg bg-v2-background-bg-layer-01 p-4 text-[12px] leading-5">
          <div class="flex gap-3">
            <dt class="w-24 shrink-0 font-[530] text-v2-text-text-base">Reason</dt>
            <dd class="min-w-0 text-v2-text-text-muted">{props.status.reason ?? "Not stated"}</dd>
          </div>
          <Show when={date()}>
            {(value) => (
              <div class="flex gap-3">
                <dt class="w-24 shrink-0 font-[530] text-v2-text-text-base">Applied</dt>
                <dd class="text-v2-text-text-muted">{value()}</dd>
              </div>
            )}
          </Show>
          <div class="flex gap-3">
            <dt class="w-24 shrink-0 font-[530] text-v2-text-text-base">Installation</dt>
            <dd class="min-w-0 break-all font-mono text-[11px] text-v2-text-text-muted">
              {props.status.fingerprint}
            </dd>
          </div>
        </dl>

        <p class="text-[12px] font-[440] leading-5 text-v2-text-text-muted">
          Your sessions and settings have not been deleted. They are encrypted on this computer and will be
          restored if the ban is lifted. Uninstalling Omnia, deleting its data folder, or reinstalling does
          not lift the ban.
        </p>

        <Show when={props.failure}>
          <p class="text-[12px] font-[440] leading-5 text-v2-state-fg-danger">{props.failure}</p>
        </Show>

        <div class="flex flex-col gap-2">
          <ButtonV2 size="large" class="w-full justify-center" onClick={() => platform.openExternal(appeal())}>
            Appeal by email
          </ButtonV2>
          <p class="text-center text-[11px] font-[440] leading-4 text-v2-text-text-muted">
            Write to{" "}
            <a
              href={`mailto:${TERMS_CONTACT}`}
              class="underline underline-offset-2 hover:text-v2-text-text-base"
            >
              {TERMS_CONTACT}
            </a>{" "}
            with the fingerprint above. Appeals are reviewed manually.
          </p>
        </div>

        <div class="flex items-center justify-between gap-3 border-t-[0.5px] border-v2-border-border-base pt-4">
          <span class="text-[11px] font-[440] leading-4 text-v2-text-text-muted">
            {props.status.sealed ? "Sessions encrypted" : "No session data found"}
          </span>
          <ButtonV2 variant="outline" size="small" disabled={checking()} onClick={() => void refresh()}>
            <Show when={!checking()} fallback={<LoaderV2 width={14} height={14} />}>
              Check again
            </Show>
          </ButtonV2>
        </div>
      </div>
    </div>
  )
}
