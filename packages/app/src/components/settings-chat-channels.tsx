import { For, Show, createMemo, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { isPlanId, PLANS, type CapabilityRule } from "@opencode-ai/omnia/billing/plans"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Paywall } from "@opencode-ai/ui/paywall"
import { Switch } from "@opencode-ai/ui/switch"
import { TextField } from "@opencode-ai/ui/text-field"
import { emptyCredentials, type ChatChannelSummary, type ChatPlatformSpec } from "@/chat"
import { useEntitlement } from "@/context/entitlement"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"

/**
 * Chat channels: the messaging platforms Omnia answers on.
 *
 * A channel's credentials are write-only here. The server's summary names the
 * fields a channel has set and never their values, so this panel can create a
 * connection and reconnect over it, and cannot read a bot token back out.
 *
 * The Pro gate reads the entitlement answer first and the plan matrix second,
 * because a control plane built before this capability existed does not name it
 * at all - and silence is not a refusal. Only an answer that names the
 * capability and denies it is a refusal; when the answer is silent the app falls
 * back to the same plan matrix the server enforces from, so a paying account is
 * never blocked by a stale server. With no answer at all (signed out, or no
 * billing configured) there is no gate, because enforcement is the server's job.
 */
export function SettingsChatChannels() {
  const language = useLanguage()
  const platform = usePlatform()
  const entitlement = useEntitlement()
  const [store, setStore] = createStore({
    platforms: [] as readonly ChatPlatformSpec[],
    channels: [] as readonly ChatChannelSummary[],
    draft: undefined as ChatPlatformSpec | undefined,
    credentials: {} as Record<string, string>,
    loading: true,
    saving: false,
    busy: "",
    copied: "",
    // The server answered that it has no such route: nothing can be configured
    // until it is updated, and the raw IPC error would read as a broken panel.
    unsupported: false,
    error: "",
  })

  const api = () => platform.chat
  const refused = createMemo(() => {
    const account = entitlement.account()
    if (account === undefined) return false
    const state = account.capabilities.chat_channels
    if (state !== undefined) return state.allowed !== true
    return !planAllowsChatChannels(account.plan)
  })

  const refresh = async () => {
    if (!api()) return
    setStore({ loading: true, error: "", unsupported: false })
    try {
      const channels = await api()!.list()
      const platforms = await api()!.platforms()
      setStore({ platforms, channels, loading: false })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setStore({ loading: false, unsupported: /unknown route/i.test(message), error: message })
    }
  }

  onMount(() => void refresh())

  const channel = (id: string) => store.channels.find((item) => item.platform === id)

  const start = (spec: ChatPlatformSpec) => {
    setStore({ draft: spec, credentials: emptyCredentials(spec), error: "" })
  }

  const connect = async () => {
    const spec = store.draft
    if (!api() || spec === undefined) return
    const credentials = Object.fromEntries(Object.entries(store.credentials).filter(([, value]) => value.length > 0))
    const missing = spec.fields.filter(
      (field) => field.required === true && (credentials[field.key] ?? "").length === 0,
    )
    if (missing.length > 0) {
      setStore(
        "error",
        language.t("settings.chatChannels.missingFields", { fields: missing.map((field) => field.label).join(", ") }),
      )
      return
    }
    setStore({ saving: true, error: "" })
    try {
      const saved = await api()!.connect({ platform: spec.id, credentials })
      setStore({
        channels: [...store.channels.filter((item) => item.platform !== saved.platform), saved],
        draft: undefined,
        credentials: {},
        saving: false,
      })
    } catch (error) {
      setStore({ saving: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  const disconnect = async (platformId: string) => {
    if (!api()) return
    setStore({ busy: platformId, error: "" })
    try {
      const removed = await api()!.disconnect(platformId)
      setStore({
        channels: removed ? store.channels.filter((item) => item.platform !== platformId) : store.channels,
        busy: "",
        draft: store.draft?.id === platformId ? undefined : store.draft,
      })
    } catch (error) {
      setStore({ busy: "", error: error instanceof Error ? error.message : String(error) })
    }
  }

  const toggle = async (target: ChatChannelSummary, enabled: boolean) => {
    if (!api()) return
    setStore("error", "")
    try {
      const updated = await api()!.setEnabled(target.platform, enabled)
      if (updated === undefined) return
      setStore(
        "channels",
        store.channels.map((item) => (item.platform === updated.platform ? updated : item)),
      )
    } catch (error) {
      setStore("error", error instanceof Error ? error.message : String(error))
    }
  }

  const copyWebhook = async (spec: ChatPlatformSpec) => {
    await navigator.clipboard.writeText(spec.webhookPath).catch(() => undefined)
    setStore("copied", spec.id)
  }

  return (
    <>
      <div class="settings-v2-tab-header">
        <div class="flex items-start justify-between gap-4">
          <div class="flex flex-col gap-1">
            <h2 class="settings-v2-tab-title">{language.t("settings.chatChannels.title")}</h2>
            <p class="text-[13px] font-[440] text-v2-text-text-muted">
              {language.t("settings.chatChannels.description")}
            </p>
          </div>
        </div>
      </div>

      <div class="settings-v2-tab-body">
        <Show when={api() === undefined}>
          <p class="text-[13px] font-[440] text-v2-text-text-muted">
            {language.t("settings.chatChannels.unavailable")}
          </p>
        </Show>

        <Show when={api() !== undefined && refused()}>
          <Paywall capability="chat_channels" decision={{ code: "not_entitled" }} offer={entitlement.offer()} />
        </Show>

        <Show when={api() !== undefined && !refused()}>
          <div class="flex flex-col gap-3">
            <Show when={store.unsupported}>
              <p class="text-[13px] font-[440] text-v2-text-text-muted">
                {language.t("settings.chatChannels.unsupported")}
              </p>
            </Show>

            <Show when={store.loading}>
              <p class="text-[13px] font-[440] text-v2-text-text-muted">{language.t("common.loading")}</p>
            </Show>

            <Show when={!store.loading && !store.unsupported && store.channels.length === 0}>
              <p class="text-[13px] font-[440] text-v2-text-text-muted">
                {language.t("settings.chatChannels.empty")}
              </p>
            </Show>

            <For each={store.platforms}>
              {(spec) => (
                <div
                  data-platform={spec.id}
                  class="flex flex-col gap-2 rounded-md border border-v2-border-border-muted p-3"
                >
                  <div class="flex items-start justify-between gap-3">
                    <div class="flex min-w-0 gap-2">
                      <Icon name="comment" size="small" class="mt-0.5 shrink-0 text-v2-icon-icon-muted" />
                      <div class="flex min-w-0 flex-col gap-1">
                        <span class="text-[13px] font-[530] text-v2-text-text-base">{spec.name}</span>
                        <span class="text-[11px] font-[440] text-v2-text-text-muted">{spec.description}</span>
                        <Show when={spec.polling}>
                          <span class="text-[11px] font-[440] text-v2-text-text-faint">
                            {language.t("settings.chatChannels.polling")}
                          </span>
                        </Show>
                      </div>
                    </div>
                    <div class="flex shrink-0 items-center gap-2">
                      <Show
                        when={channel(spec.id)}
                        fallback={
                          <Button variant="secondary" size="small" icon="plus-small" onClick={() => start(spec)}>
                            {language.t("common.connect")}
                          </Button>
                        }
                      >
                        <span
                          class="text-[11px] font-[530] text-v2-state-fg-success"
                          classList={{ "text-v2-text-text-muted": channel(spec.id)?.enabled !== true }}
                        >
                          {language.t("settings.chatChannels.connected")}
                        </span>
                        <Switch
                          checked={channel(spec.id)?.enabled === true}
                          onChange={(value) => void toggle(channel(spec.id)!, value)}
                        />
                        <Button
                          variant="ghost"
                          size="small"
                          disabled={store.busy === spec.id}
                          onClick={() => void disconnect(spec.id)}
                        >
                          {language.t("common.disconnect")}
                        </Button>
                      </Show>
                    </div>
                  </div>

                  <Show when={channel(spec.id)}>
                    {(connected) => (
                      <div class="flex flex-col gap-1">
                        <div class="flex items-center gap-2">
                          <span class="text-[11px] font-[440] text-v2-text-text-muted">
                            {language.t("settings.chatChannels.webhook")}
                          </span>
                          <code class="truncate rounded bg-v2-background-bg-layer-01 px-1.5 py-0.5 text-[11px] text-v2-text-text-base">
                            {spec.webhookPath}
                          </code>
                          <Button variant="ghost" size="small" onClick={() => void copyWebhook(spec)}>
                            {store.copied === spec.id
                              ? language.t("settings.chatChannels.copied")
                              : language.t("settings.chatChannels.copy")}
                          </Button>
                        </div>
                        <span class="text-[11px] font-[440] text-v2-text-text-faint">
                          {language.t("settings.chatChannels.messages", {
                            count: String(connected().messageCount ?? 0),
                          })}
                        </span>
                        <Show when={connected().error}>
                          {(message) => (
                            <span class="text-[11px] font-[440] text-v2-state-fg-danger">{message()}</span>
                          )}
                        </Show>
                      </div>
                    )}
                  </Show>

                  <Show when={store.draft?.id === spec.id}>
                    <div data-draft={spec.id} class="flex flex-col gap-3 border-t border-v2-border-border-muted pt-3">
                      <For each={spec.fields}>
                        {(field) => (
                          <TextField
                            type={field.secret === true ? "password" : undefined}
                            label={
                              field.required === true
                                ? `${field.label} · ${language.t("settings.chatChannels.required")}`
                                : field.label
                            }
                            {...(field.hint === undefined ? {} : { placeholder: field.hint })}
                            value={store.credentials[field.key] ?? ""}
                            onChange={(value) => setStore("credentials", field.key, value)}
                          />
                        )}
                      </For>
                      <div class="flex items-center gap-2">
                        <Button variant="primary" size="small" disabled={store.saving} onClick={() => void connect()}>
                          {store.saving ? language.t("common.saving") : language.t("common.connect")}
                        </Button>
                        <Button
                          variant="ghost"
                          size="small"
                          onClick={() => setStore({ draft: undefined, credentials: {}, error: "" })}
                        >
                          {language.t("common.cancel")}
                        </Button>
                        <a
                          class="ml-auto text-[11px] font-[440] text-v2-text-text-muted underline"
                          href={spec.docs}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {language.t("settings.chatChannels.docs")}
                        </a>
                      </div>
                    </div>
                  </Show>
                </div>
              )}
            </For>

            <Show when={store.error && !store.unsupported}>
              <p role="alert" class="text-[12px] font-[440] text-v2-state-fg-danger">
                {store.error}
              </p>
            </Show>
          </div>
        </Show>
      </div>
    </>
  )
}

/**
 * The plan matrix this build enforces, used only when the entitlement answer
 * does not name the capability at all.
 *
 * It reads the one shared matrix rather than repeating a number here, and an
 * unrecognised plan is left ungated: a plan this build cannot resolve is not a
 * reason to take a feature away from the account using it.
 */
function planAllowsChatChannels(plan: string | undefined): boolean {
  if (!isPlanId(plan)) return true
  const rule = (PLANS[plan].capabilities as Record<string, CapabilityRule | undefined>).chat_channels
  return rule === undefined ? true : rule.limit > 0
}
