import { createResource, createSignal, onCleanup, onMount, Show, type ParentProps } from "solid-js"
import { Logo } from "@opencode-ai/ui/logo"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { LoaderV2 } from "@opencode-ai/ui/v2/loader-v2"
import { useLanguage } from "@/context/language"
import { usePlatform, type GitHubAuthStatus } from "@/context/platform"
import { createErrorDetailsCopy, friendlyErrorMessage } from "@/utils/error-message"
import { GITHUB_AUTH_CHANGED_EVENT, SignInOptions } from "./github-auth"

/**
 * Blocks the app until a GitHub session exists. The gate mounts at the app root
 * and never renders its children while the platform reports signed out, so the
 * rest of the UI cannot be reached, skipped, or dismissed before sign-in.
 */
export function FirstRunGate(props: ParentProps) {
  const platform = usePlatform()
  const auth = platform.auth
  if (auth === undefined) return <>{props.children}</>

  const [error, setError] = createSignal<unknown>()
  const [status, { refetch, mutate }] = createResource(async () => {
    try {
      const next = await auth.status()
      setError(undefined)
      return next
    } catch (cause) {
      // A stored resource error is re-thrown from read(), which would replace
      // the gate with the fatal restart page; keep it here and offer a retry.
      setError(cause)
      return undefined
    }
  })

  const refresh = () => void refetch()
  onMount(() => window.addEventListener(GITHUB_AUTH_CHANGED_EVENT, refresh))
  onCleanup(() => window.removeEventListener(GITHUB_AUTH_CHANGED_EVENT, refresh))

  return (
    <Show
      when={status()?.authenticated === true}
      fallback={
        <GateScreen
          loading={status.loading}
          error={error()}
          onRetry={refresh}
          onSignedIn={(next) => {
            setError(undefined)
            mutate(next)
          }}
          onError={setError}
        />
      }
    >
      {props.children}
    </Show>
  )
}

function GateScreen(props: {
  loading: boolean
  error?: unknown
  onRetry: () => void
  onSignedIn: (status: GitHubAuthStatus) => void
  onError: (error: unknown) => void
}) {
  const language = useLanguage()
  const details = createErrorDetailsCopy()

  return (
    <div
      data-component="first-run-gate"
      class="fixed inset-0 z-[9998] flex flex-col items-center justify-center gap-6 bg-v2-background-bg-base p-6"
    >
      <Logo class="w-36" />
      <div class="flex max-w-sm flex-col items-center gap-2 text-center">
        <h1 class="text-[15px] font-[640] leading-5 text-v2-text-text-base">{language.t("ui.github.signInTitle")}</h1>
        <p class="text-[13px] font-[440] leading-5 text-v2-text-text-muted">
          {language.t("ui.github.signInDescription")}
        </p>
      </div>
      <Show when={!props.loading} fallback={<LoaderV2 width={20} height={20} />}>
        <div class="flex flex-col items-center gap-3">
          <SignInOptions onSignedIn={props.onSignedIn} onError={props.onError} />
          <Show when={props.error}>
            <ButtonV2 variant="outline" size="large" class="min-w-48 justify-center" onClick={props.onRetry}>
              {language.t("ui.github.retry")}
            </ButtonV2>
          </Show>
        </div>
      </Show>
      <Show when={props.error}>
        <div class="flex max-w-sm flex-col items-center gap-1 text-center">
          <p class="text-[13px] font-[440] leading-5 text-v2-state-fg-danger">
            {friendlyErrorMessage(props.error, language.t, "ui.github.error")}
          </p>
          <button
            type="button"
            class="text-[11px] font-[440] text-v2-text-text-muted underline underline-offset-2 hover:text-v2-text-text-base"
            onClick={() => void details.copy(props.error)}
          >
            {details.copied() ? language.t("error.common.detailsCopied") : language.t("error.common.copyDetails")}
          </button>
        </div>
      </Show>
    </div>
  )
}
