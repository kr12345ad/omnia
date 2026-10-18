import { createResource, createSignal, Show } from "solid-js"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { LoaderV2 } from "@opencode-ai/ui/v2/loader-v2"
import { useLanguage } from "@/context/language"
import { usePlatform, type AuthProvider, type GitHubAuthStatus } from "@/context/platform"
import { createErrorDetailsCopy, friendlyErrorMessage } from "@/utils/error-message"

// The first-run gate and the account control both observe the same session;
// this window event lets one side tell the other that it changed.
export const GITHUB_AUTH_CHANGED_EVENT = "omnia-auth-changed"

export function notifyGitHubAuthChanged(): void {
  window.dispatchEvent(new Event(GITHUB_AUTH_CHANGED_EVENT))
}

const PROVIDERS: readonly AuthProvider[] = ["github", "google"]

// Copy and icon per provider. Google's labels are separate keys rather than a
// template so translators can inflect the whole sentence.
const COPY = {
  github: {
    continue: "ui.github.continue",
    waiting: "ui.github.waiting",
    error: "ui.github.error",
    signedInWith: "ui.github.signedInWith",
  },
  google: {
    continue: "ui.google.continue",
    waiting: "ui.google.waiting",
    error: "ui.google.error",
    signedInWith: "ui.google.signedInWith",
  },
} as const

function providerOf(status: GitHubAuthStatus | undefined): AuthProvider {
  return status?.profile?.provider === "google" ? "google" : "github"
}

export function SignInButton(props: {
  provider: AuthProvider
  variant?: "contrast" | "outline"
  disabled?: boolean
  onSignedIn?: (status: GitHubAuthStatus) => void
  onError?: (error: unknown) => void
}) {
  const platform = usePlatform()
  const language = useLanguage()
  const auth = platform.auth
  if (auth === undefined) return null

  const [busy, setBusy] = createSignal(false)
  const copy = COPY[props.provider]

  const signIn = async () => {
    if (busy()) return
    setBusy(true)
    try {
      const status = await auth.signIn(props.provider)
      notifyGitHubAuthChanged()
      props.onSignedIn?.(status)
    } catch (error) {
      props.onError?.(error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <ButtonV2
      variant={props.variant ?? "contrast"}
      size="large"
      class="min-w-48 justify-center"
      disabled={busy() || props.disabled === true}
      onClick={() => void signIn()}
    >
      <Show when={!busy()} fallback={<LoaderV2 width={16} height={16} />}>
        <Icon name={props.provider} size="small" />
      </Show>
      <span>{busy() ? language.t(copy.waiting) : language.t(copy.continue)}</span>
    </ButtonV2>
  )
}

export function GitHubSignInButton(props: {
  disabled?: boolean
  onSignedIn?: (status: GitHubAuthStatus) => void
  onError?: (error: unknown) => void
}) {
  return <SignInButton provider="github" variant="contrast" {...props} />
}

export function GoogleSignInButton(props: {
  disabled?: boolean
  onSignedIn?: (status: GitHubAuthStatus) => void
  onError?: (error: unknown) => void
}) {
  return <SignInButton provider="google" variant="outline" {...props} />
}

export function SignInOptions(props: {
  disabled?: boolean
  onSignedIn?: (status: GitHubAuthStatus) => void
  onError?: (error: unknown) => void
}) {
  return (
    <div class="flex flex-col items-stretch gap-2">
      {PROVIDERS.map((provider) => (
        <SignInButton
          provider={provider}
          variant={provider === "github" ? "contrast" : "outline"}
          disabled={props.disabled}
          onSignedIn={props.onSignedIn}
          onError={props.onError}
        />
      ))}
    </div>
  )
}

export function GitHubAuthButton() {
  const platform = usePlatform()
  const language = useLanguage()
  const auth = platform.auth
  if (auth === undefined) return null

  const [status, { mutate }] = createResource(() => auth.status())
  const [busy, setBusy] = createSignal(false)
  const [open, setOpen] = createSignal(false)
  const [error, setError] = createSignal<unknown>()
  const details = createErrorDetailsCopy()

  const signOut = async () => {
    setBusy(true)
    try {
      mutate(await auth.signOut())
      notifyGitHubAuthChanged()
      setOpen(false)
    } catch (cause) {
      setError(cause)
    } finally {
      setBusy(false)
    }
  }

  const profile = () => status()?.profile
  const provider = () => providerOf(status())

  return (
    <DropdownMenu open={open()} onOpenChange={setOpen} placement="bottom-end">
      <Show
        when={status()?.authenticated === true}
        fallback={
          <DropdownMenu.Trigger
            as="button"
            type="button"
            class="flex h-7 items-center gap-1.5 rounded-md px-2 text-[13px] font-[440] text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base"
            aria-label={language.t("ui.github.signIn")}
          >
            <Icon name="github" size="small" />
            <span>{language.t("ui.github.signIn")}</span>
          </DropdownMenu.Trigger>
        }
      >
        <DropdownMenu.Trigger
          as="button"
          type="button"
          class="flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-full border-[0.5px] border-v2-border-border-base bg-v2-background-bg-deep"
          aria-label={language.t("ui.github.account")}
        >
          <Show when={profile()?.avatarUrl} fallback={<Icon name={provider()} size="small" />}>
            <img
              src={profile()!.avatarUrl}
              alt={profile()!.login}
              class="size-full rounded-full object-cover"
              draggable={false}
            />
          </Show>
        </DropdownMenu.Trigger>
      </Show>
      <DropdownMenu.Portal>
        <DropdownMenu.Content class="mt-1 w-76 p-3">
          <Show
            when={status()?.authenticated === true}
            fallback={
              <div class="flex flex-col gap-3">
                <div class="flex flex-col gap-1">
                  <span class="text-[13px] font-[530] text-v2-text-text-base">
                    {language.t("ui.github.signInTitle")}
                  </span>
                  <span class="text-[13px] font-[440] leading-5 text-v2-text-text-muted">
                    {language.t("ui.github.signInDescription")}
                  </span>
                </div>
                <SignInOptions
                  onSignedIn={(next) => {
                    setError(undefined)
                    mutate(next)
                    setOpen(false)
                  }}
                  onError={setError}
                />
              </div>
            }
          >
            <div class="flex flex-col gap-3">
              <div class="flex items-center gap-3">
                <Show when={profile()?.avatarUrl}>
                  <img
                    src={profile()!.avatarUrl}
                    alt={profile()!.login}
                    class="size-8 rounded-full"
                    draggable={false}
                  />
                </Show>
                <div class="flex min-w-0 flex-col">
                  <span class="truncate text-[13px] font-[530] text-v2-text-text-base">
                    {profile()?.name ?? profile()?.login ?? language.t("ui.github.account")}
                  </span>
                  <Show when={profile()?.login}>
                    <span class="truncate text-[13px] font-[440] text-v2-text-text-muted">@{profile()!.login}</span>
                  </Show>
                </div>
              </div>
              <span class="text-[13px] font-[440] text-v2-text-text-muted">
                {language.t(COPY[provider()].signedInWith)}
              </span>
              <div class="flex flex-col gap-1 border-t-[0.5px] border-v2-border-border-base pt-2">
                <Show when={profile()?.htmlUrl}>
                  <a
                    href={profile()!.htmlUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    class="text-[13px] font-[440] text-v2-text-text-muted hover:text-v2-text-text-base"
                  >
                    {language.t("ui.github.viewProfile")}
                  </a>
                </Show>
                <button
                  type="button"
                  class="text-left text-[13px] font-[440] text-v2-text-text-muted hover:text-v2-text-text-base disabled:opacity-60"
                  disabled={busy()}
                  onClick={() => void signOut()}
                >
                  {language.t("ui.github.signOut")}
                </button>
              </div>
            </div>
          </Show>
          <Show when={error()}>
            <div class="mt-2 flex flex-col gap-1">
              <span class="text-[13px] font-[440] text-v2-state-fg-danger">
                {friendlyErrorMessage(error(), language.t, COPY[provider()].error)}
              </span>
              <button
                type="button"
                class="text-left text-[11px] font-[440] text-v2-text-text-muted underline underline-offset-2 hover:text-v2-text-text-base"
                onClick={() => void details.copy(error())}
              >
                {details.copied() ? language.t("error.common.detailsCopied") : language.t("error.common.copyDetails")}
              </button>
            </div>
          </Show>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  )
}
