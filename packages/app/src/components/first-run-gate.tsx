import { createResource, createSignal, onCleanup, onMount, Show, type ParentProps } from "solid-js"
import { Logo } from "@opencode-ai/ui/logo"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { LoaderV2 } from "@opencode-ai/ui/v2/loader-v2"
import { useLanguage } from "@/context/language"
import {
  usePlatform,
  type EnterpriseBranding,
  type EnterpriseProfile,
  type GitHubAuthStatus,
} from "@/context/platform"
import { useEnterprise } from "@/context/enterprise"
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
  // A tenant installer must never offer GitHub or Google. The flag is known
  // synchronously from the packaged build, so a slow or failed profile read
  // cannot fall back to the public sign-in screen.
  const managed = auth.enterprise?.managed === true
  // The profile is packaged with the installer, so it is available before the
  // first sign-in and does not depend on the network.
  const [profile] = createResource(async () => auth.enterprise?.profile().catch(() => undefined))

  const refresh = () => void refetch()
  onMount(() => window.addEventListener(GITHUB_AUTH_CHANGED_EVENT, refresh))
  onCleanup(() => window.removeEventListener(GITHUB_AUTH_CHANGED_EVENT, refresh))

  return (
    <Show
      when={status()?.authenticated === true}
      fallback={
        <GateScreen
          managed={managed}
          loading={status.loading || profile.loading}
          profile={profile()}
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
  managed: boolean
  loading: boolean
  profile?: EnterpriseProfile
  error?: unknown
  onRetry: () => void
  onSignedIn: (status: GitHubAuthStatus) => void
  onError: (error: unknown) => void
}) {
  const language = useLanguage()
  const details = createErrorDetailsCopy()

  if (props.managed || props.profile !== undefined) {
    return (
      <EnterpriseGate
        profile={props.profile}
        loading={props.loading}
        error={props.error}
        onSignedIn={props.onSignedIn}
        onError={props.onError}
      />
    )
  }

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

function failureMessage(value: unknown): string {
  if (value instanceof Error) return value.message
  return typeof value === "string" ? value : "Sign-in failed."
}

/** -1 when the client is older, 0 when equal, 1 when newer. Non-numeric parts compare as zero. */
function compareVersions(client: string, minimum: string): number {
  const parts = (value: string) => value.split(".").map((entry) => Number.parseInt(entry, 10) || 0)
  const mine = parts(client)
  const floor = parts(minimum)
  for (let index = 0; index < Math.max(mine.length, floor.length); index += 1) {
    const delta = (mine[index] ?? 0) - (floor[index] ?? 0)
    if (delta !== 0) return delta < 0 ? -1 : 1
  }
  return 0
}

/**
 * Work-account sign-in for a managed build. There is deliberately no GitHub or
 * Google button: the tenant server is the only identity provider this client
 * trusts, and its policy (domains, MFA, session length) is enforced there.
 * Copy, links and the minimum-version bar come from the admin's manifest; the
 * baked profile is only the fallback while it loads.
 */
function EnterpriseGate(props: {
  profile?: EnterpriseProfile
  loading: boolean
  error?: unknown
  onSignedIn: (status: GitHubAuthStatus) => void
  onError: (error: unknown) => void
}) {
  const platform = usePlatform()
  const policy = useEnterprise()
  const details = createErrorDetailsCopy()
  const [identifier, setIdentifier] = createSignal("")
  const [password, setPassword] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [failure, setFailure] = createSignal<unknown>()
  const enterprise = platform.auth?.enterprise
  const resolved = () => policy.policy()
  const domains = () => resolved()?.auth.allowedEmailDomains ?? props.profile?.auth.allowedEmailDomains ?? []
  const brand = (): EnterpriseBranding => resolved()?.branding ?? props.profile?.branding ?? {}
  const orgName = () => resolved()?.org ?? props.profile?.org?.name ?? ""
  const clientName = () => resolved()?.name ?? props.profile?.name ?? ""
  // The console's "Client preview" is the contract for this screen: the logo
  // (or its gradient initial), the product name, the sign-in headline and the
  // accent-colored action are the same fields, in the same order.
  const primary = () => brand().primaryColor || "#0a0a0a"
  const accent = () => brand().accentColor || "#2563eb"
  const logo = () => brand().logoUrl ?? brand().iconUrl
  const productName = () => brand().productName || clientName() || "Your client"
  const headline = () => brand().signInHeadline || "Sign in to continue"
  const initial = () => (brand().shortName || clientName() || "O").slice(0, 1).toUpperCase()
  const domainText = () => domains().join(", ") || "any work email"
  const footer = () => brand().footerText
  const supportUrl = () => brand().supportUrl
  const docsUrl = () => brand().docsUrl
  const requireMfa = () => resolved()?.auth.requireMfa === true
  // The admin can pin a floor: an older client is told to update instead of
  // signing in, exactly as the console promises.
  const outdated = () => {
    const minimum = resolved()?.update.minimumVersion
    const version = platform.version
    if (minimum === undefined || minimum.length === 0 || version === undefined || version.length === 0) return false
    try {
      return compareVersions(version, minimum) < 0
    } catch {
      return false
    }
  }

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    if (busy() || enterprise === undefined) return
    setBusy(true)
    setFailure(undefined)
    try {
      const status = await enterprise.signIn(identifier(), password())
      props.onSignedIn(status)
    } catch (cause) {
      setFailure(cause)
      props.onError(cause)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      data-component="first-run-gate"
      class="fixed inset-0 z-[9998] flex flex-col items-center justify-center bg-v2-background-bg-base p-6"
    >
      <div class="flex w-full max-w-sm flex-col items-center gap-4 rounded-xl border-[0.5px] border-v2-border-border-base bg-v2-background-bg-deep px-6 py-8 text-center">
        <Show
          when={logo()}
          fallback={
            <span
              class="grid size-10 place-items-center rounded-lg text-lg font-semibold text-white"
              style={{ background: `linear-gradient(135deg, ${primary()}, ${accent()})` }}
            >
              {initial()}
            </span>
          }
        >
          {(url) => <img src={url()} alt="" class="max-h-16 max-w-48 object-contain" />}
        </Show>
        <div class="flex flex-col items-center gap-1">
          <h1 class="text-[15px] font-[640] leading-5 text-v2-text-text-base">{productName()}</h1>
          <p class="text-[13px] font-[440] leading-5 text-v2-text-text-muted">{headline()}</p>
        </div>
        <Show when={outdated()}>
          <div class="flex w-full flex-col items-center gap-2 rounded-md border-[0.5px] border-v2-border-border-base bg-v2-background-bg-deep p-4 text-center">
            <p class="text-[13px] font-[530] text-v2-text-text-base">This client is out of date</p>
            <p class="text-[12px] font-[440] leading-4 text-v2-text-text-muted">
              Your organization requires version {resolved()?.update.minimumVersion} or newer. Ask your
              administrator for the current installer
              <Show when={supportUrl()}>
                {(url) => (
                  <>
                    {" "}or <a href={url()} target="_blank" rel="noopener noreferrer" class="underline underline-offset-2 hover:text-v2-text-text-base">contact support</a>
                  </>
                )}
              </Show>
              .
            </p>
          </div>
        </Show>
        <Show when={!props.loading && !outdated()} fallback={<LoaderV2 width={20} height={20} />}>
          <form class="flex w-full flex-col gap-2 text-left" onSubmit={(event) => void submit(event)}>
            <label class="flex flex-col gap-1 text-[11px] font-[440] text-v2-text-text-muted">
              Work email or employee ID
              <input
                class="h-9 rounded-md border-[0.5px] border-v2-border-border-base bg-v2-background-bg-deep px-3 text-[13px] text-v2-text-text-base outline-none focus:border-v2-border-border-strong"
                autocomplete="username"
                value={identifier()}
                disabled={busy()}
                onInput={(event) => setIdentifier(event.currentTarget.value)}
              />
            </label>
            <label class="flex flex-col gap-1 text-[11px] font-[440] text-v2-text-text-muted">
              Password
              <input
                type="password"
                class="h-9 rounded-md border-[0.5px] border-v2-border-border-base bg-v2-background-bg-deep px-3 text-[13px] text-v2-text-text-base outline-none focus:border-v2-border-border-strong"
                autocomplete="current-password"
                value={password()}
                disabled={busy()}
                onInput={(event) => setPassword(event.currentTarget.value)}
              />
            </label>
            <Show when={requireMfa()}>
              <p class="text-[11px] leading-4 text-v2-text-text-muted">
                Your organization requires multi-factor authentication. Complete the second-factor step your
                administrator configured after entering your password.
              </p>
            </Show>
            <ButtonV2
              type="submit"
              size="large"
              class="mt-1 justify-center"
              style={{ background: accent(), color: "#fff" }}
              disabled={busy()}
            >
              <Show when={!busy()} fallback={<LoaderV2 width={16} height={16} />}>
                Sign in
              </Show>
            </ButtonV2>
            <Show when={failure() !== undefined || props.error !== undefined}>
              <div class="mt-1 flex flex-col items-center gap-1 text-center">
                <p class="text-[12px] font-[440] leading-4 text-v2-state-fg-danger">
                  {failureMessage(failure() ?? props.error)}
                </p>
                <button
                  type="button"
                  class="text-[11px] font-[440] text-v2-text-text-muted underline underline-offset-2 hover:text-v2-text-text-base"
                  onClick={() => void details.copy(failure() ?? props.error)}
                >
                  {details.copied() ? "Details copied" : "Copy details"}
                </button>
              </div>
            </Show>
          </form>
        </Show>
        <span class="text-[11px] leading-4 text-v2-text-text-muted">SSO only · {domainText()}</span>
        <Show when={brand().showOmniaBranding === false}>
          <span class="text-[11px] leading-4 text-v2-text-text-muted">Powered by your team</span>
        </Show>
        <Show when={footer() ?? (orgName() && clientName() ? `${orgName()} · ${clientName()}` : undefined)}>
          {(line) => <p class="text-[11px] text-v2-text-text-muted">{line()}</p>}
        </Show>
        <Show when={supportUrl() !== undefined || docsUrl() !== undefined}>
          <p class="text-[11px] text-v2-text-text-muted">
            <Show when={supportUrl()}>
              {(url) => (
                <a href={url()} target="_blank" rel="noopener noreferrer" class="underline underline-offset-2 hover:text-v2-text-text-base">
                  Support
                </a>
              )}
            </Show>
            <Show when={supportUrl() !== undefined && docsUrl() !== undefined}>
              <span> · </span>
            </Show>
            <Show when={docsUrl()}>
              {(url) => (
                <a href={url()} target="_blank" rel="noopener noreferrer" class="underline underline-offset-2 hover:text-v2-text-text-base">
                  Documentation
                </a>
              )}
            </Show>
          </p>
        </Show>
      </div>
    </div>
  )
}
