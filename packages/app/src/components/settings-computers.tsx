import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Switch } from "@opencode-ai/ui/switch"
import { TextField } from "@opencode-ai/ui/text-field"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { createErrorDetailsCopy, friendlyErrorMessage } from "@/utils/error-message"
import { DialogAddComputer } from "./dialog-add-computer"
import { DialogJoinComputer } from "./dialog-join-computer"
import { SelectField } from "./select-field"
import {
  emptyCredential,
  type ComputerCredentialInput,
  type ComputerCredentialRuleKind,
  type ComputerCredentialSummary,
  type ComputerPairStatus,
  type ComputerSummary,
} from "@/computers"

const RULE_KINDS: ComputerCredentialRuleKind[] = ["command", "application", "url"]

// Registration finishes a few seconds after the dialog closes, so the panel
// polls: without it the list stays empty for the rest of the session.
const REFRESH_INTERVAL_MS = 3000

const RULE_LABEL = {
  command: "settings.computers.credentials.rule.command",
  application: "settings.computers.credentials.rule.application",
  url: "settings.computers.credentials.rule.url",
} as const

export const SettingsComputers = () => {
  const language = useLanguage()
  const platform = usePlatform()
  const dialog = useDialog()
  const api = platform.computers

  const [store, setStore] = createStore({
    computers: [] as ComputerSummary[],
    selectedId: undefined as string | undefined,
    credentials: [] as ComputerCredentialSummary[],
    draft: undefined as ComputerCredentialInput | undefined,
    pairStatus: undefined as ComputerPairStatus | undefined,
    status: "",
    error: undefined as unknown,
    loading: true,
    saving: false,
  })
  const [selectedCredential, setSelectedCredential] = createSignal<string | undefined>(undefined)
  const details = createErrorDetailsCopy()

  const errorText = createMemo(() =>
    store.error === undefined ? undefined : friendlyErrorMessage(store.error, language.t, "error.common.unknown"),
  )

  const refreshComputers = async (silent = false) => {
    if (!api) return
    if (!silent) setStore("loading", true)
    try {
      const computers = await api.list()
      setStore("computers", computers)
      if (!silent) setStore("error", undefined)
      if (store.selectedId === undefined && computers.length > 0) {
        await selectComputer(computers[0]!.id)
      }
    } catch (error) {
      if (!silent) setStore("error", error)
    } finally {
      if (!silent) setStore("loading", false)
    }
  }

  const refreshPairStatus = async () => {
    if (!api) return
    await api.pair
      .status()
      .then((status) => setStore("pairStatus", status))
      // Keep the last known state: a single failed poll must not make a paired
      // computer look unpaired while the loop is restarting.
      .catch(() => undefined)
  }

  const leavePairing = async () => {
    if (!api) return
    try {
      await api.pair.leave()
      setStore("pairStatus", { paired: false })
      setStore("status", language.t("settings.computers.pair.unpaired"))
      setStore("error", undefined)
    } catch (error) {
      setStore("error", error)
    }
  }

  const refreshCredentials = async (computerId: string) => {
    if (!api) return
    try {
      setStore("credentials", await api.credentials.list(computerId))
      setStore("error", undefined)
    } catch (error) {
      setStore("error", error)
    }
  }

  const selectComputer = async (computerId: string) => {
    setStore("selectedId", computerId)
    setStore("draft", undefined)
    setSelectedCredential(undefined)
    setStore("status", "")
    await refreshCredentials(computerId)
  }

  onMount(() => {
    void refreshComputers()
    void refreshPairStatus()
    const poll = setInterval(() => {
      void refreshComputers(true)
      void refreshPairStatus()
    }, REFRESH_INTERVAL_MS)
    onCleanup(() => clearInterval(poll))
  })

  const selectedComputer = createMemo(() => store.computers.find((computer) => computer.id === store.selectedId))

  const startNewCredential = () => {
    const computerId = store.selectedId
    if (computerId === undefined) return
    setSelectedCredential(undefined)
    setStore("draft", emptyCredential(computerId))
    setStore("status", "")
    setStore("error", undefined)
  }

  const editCredential = (credential: ComputerCredentialSummary) => {
    setSelectedCredential(credential.id)
    setStore("draft", {
      id: credential.id,
      computerId: credential.computerId,
      name: credential.name,
      kind: credential.kind,
      ...(credential.username === undefined ? {} : { username: credential.username }),
      rules: credential.rules.map((rule) => ({ ...rule })),
      ...(credential.description === undefined ? {} : { description: credential.description }),
      enabled: credential.enabled,
    })
    setStore("status", "")
    setStore("error", undefined)
  }

  const saveCredential = async () => {
    if (!api || !store.draft) return
    if (store.draft.name.trim().length === 0) {
      setStore("error", language.t("settings.computers.credentials.nameRequired"))
      return
    }
    const draft = store.draft
    // Build a plain object: store.draft is a reactive proxy, and Electron IPC
    // (structured clone) rejects proxies with "An object could not be cloned".
    const input: ComputerCredentialInput = {
      ...(draft.id === undefined ? {} : { id: draft.id }),
      computerId: draft.computerId,
      name: draft.name,
      ...(draft.kind === undefined ? {} : { kind: draft.kind }),
      ...(draft.username === undefined ? {} : { username: draft.username }),
      // An empty box means "keep the stored secret"; sending "" would erase it.
      ...(draft.secret === undefined || draft.secret.trim().length === 0 ? {} : { secret: draft.secret }),
      rules: (draft.rules ?? []).map((rule) => ({ kind: rule.kind, match: rule.match })),
      ...(draft.description === undefined ? {} : { description: draft.description }),
      ...(draft.enabled === undefined ? {} : { enabled: draft.enabled }),
    }
    const computerId = draft.computerId
    setStore("saving", true)
    try {
      const saved = await api.credentials.save(input)
      setSelectedCredential(saved.id)
      setStore("draft", undefined)
      setStore("status", language.t("settings.computers.credentials.saved"))
      setStore("error", undefined)
      await refreshCredentials(computerId)
    } catch (error) {
      setStore("error", error)
    } finally {
      setStore("saving", false)
    }
  }

  const removeCredential = async () => {
    if (!api || !store.draft) return
    const id = store.draft.id
    const computerId = store.draft.computerId
    if (id === undefined) return
    try {
      await api.credentials.remove(computerId, id)
      setStore("draft", undefined)
      setSelectedCredential(undefined)
      setStore("status", language.t("settings.computers.credentials.deleted"))
      setStore("error", undefined)
      await refreshCredentials(computerId)
    } catch (error) {
      setStore("error", error)
    }
  }

  const toggleCredential = async (credential: ComputerCredentialSummary, enabled: boolean) => {
    if (!api) return
    try {
      await api.credentials.save({
        id: credential.id,
        computerId: credential.computerId,
        name: credential.name,
        kind: credential.kind,
        ...(credential.username === undefined ? {} : { username: credential.username }),
        rules: credential.rules.map((rule) => ({ ...rule })),
        ...(credential.description === undefined ? {} : { description: credential.description }),
        enabled,
      })
      await refreshCredentials(store.selectedId ?? credential.computerId)
    } catch (error) {
      setStore("error", error)
    }
  }

  const stopComputer = async () => {
    const computer = selectedComputer()
    if (!api || computer === undefined) return
    try {
      await api.stop(computer.id, "user pressed stop in settings")
      setStore("status", language.t("settings.computers.stoppedWithName", { name: computer.name }))
      setStore("error", undefined)
      await refreshComputers()
    } catch (error) {
      setStore("error", error)
    }
  }

  const connectComputer = async () => {
    const computer = selectedComputer()
    if (!api || computer === undefined) return
    try {
      await api.connect(computer.id)
      // The result message carries a raw computer id, so the status line is
      // built from the selected computer's name instead.
      setStore("status", language.t("settings.computers.connectedWithName", { name: computer.name }))
      setStore("error", undefined)
      await refreshComputers()
    } catch (error) {
      setStore("error", error)
    }
  }

  const updateRule = (index: number, kind: ComputerCredentialRuleKind, match: string) => {
    // Update the rule fields in place: <For> reconciles rows by object
    // identity, so replacing the row object on every keystroke would remount
    // its inputs and steal focus after a single character.
    setStore("draft", "rules", index, "kind", kind)
    setStore("draft", "rules", index, "match", match)
  }

  const addRule = () => {
    setStore("draft", "rules", (rules) => [...(rules ?? []), { kind: "command" as const, match: "" }])
  }

  const removeRule = (index: number) => {
    setStore("draft", "rules", (rules) => (rules ?? []).filter((_rule, position) => position !== index))
  }

  return (
    <>
      <div class="settings-v2-tab-header">
        <div class="flex items-start justify-between gap-4">
          <div class="flex flex-col gap-1">
            <h2 class="settings-v2-tab-title">{language.t("settings.computers.title")}</h2>
            <p class="text-[13px] font-[440] text-v2-text-text-muted">{language.t("settings.computers.description")}</p>
          </div>
          <Show when={api}>
            <div class="flex items-center gap-2">
              <Button
                variant="secondary"
                size="small"
                icon="enter"
                onClick={() =>
                  dialog.show(() => (
                    <DialogJoinComputer
                      onPaired={() => {
                        void refreshPairStatus()
                      }}
                    />
                  ))
                }
              >
                {language.t("settings.computers.pair.join")}
              </Button>
              <Button
                variant="secondary"
                size="small"
                icon="plus-small"
                onClick={() =>
                  dialog.show(() => (
                    <DialogAddComputer
                      existing={store.computers.map((computer) => computer.id)}
                      onPaired={(id) => {
                        void refreshComputers()
                        void selectComputer(id)
                      }}
                    />
                  ))
                }
              >
                {language.t("settings.computers.add")}
              </Button>
            </div>
          </Show>
        </div>
      </div>
      <div class="settings-v2-tab-body">
        <Show when={store.pairStatus?.paired}>
          <div class="flex items-center justify-between gap-3 rounded-md border border-v2-border-border-muted p-3">
            <div class="flex min-w-0 flex-col">
              <span class="text-[13px] font-[530] text-v2-text-text-base">
                {language.t("settings.computers.pair.remoteTitle")}
              </span>
              <span
                class="truncate text-[11px] font-[440]"
                classList={{
                  "text-v2-text-text-muted": store.pairStatus?.connected === true,
                  "text-v2-state-fg-danger": store.pairStatus?.connected !== true,
                }}
              >
                {store.pairStatus?.connected === true
                  ? language.t("settings.computers.pair.remoteDescription")
                  : language.t("settings.computers.pair.remoteDisconnected")}
              </span>
            </div>
            <Button variant="secondary" size="small" onClick={() => void leavePairing()}>
              {language.t("settings.computers.pair.unpair")}
            </Button>
          </div>
        </Show>

        <Show when={!api}>
          <div class="text-[13px] font-[440] text-v2-text-text-muted">
            {language.t("settings.computers.unavailable")}
          </div>
        </Show>

        <Show when={api}>
          <Show when={store.computers.length === 0 && !store.loading}>
            <div class="text-[13px] font-[440] text-v2-text-text-muted">{language.t("settings.computers.empty")}</div>
          </Show>

          <div class="flex gap-6">
            <div class="flex w-64 shrink-0 flex-col gap-1">
              <For each={store.computers}>
                {(computer) => (
                  <div
                    class="group flex items-center gap-2 rounded-md px-2 py-1.5 cursor-pointer hover:bg-v2-overlay-simple-overlay-hover"
                    classList={{ "bg-v2-background-bg-layer-01": store.selectedId === computer.id }}
                    onClick={() => void selectComputer(computer.id)}
                  >
                    <Icon name="window-cursor" size="small" class="shrink-0 text-v2-icon-icon-muted" />
                    <div class="flex min-w-0 flex-1 flex-col">
                      <span class="truncate text-[13px] font-[530] text-v2-text-text-base">{computer.name}</span>
                    </div>
                    <span
                      class="text-[11px] font-[530]"
                      classList={{
                        "text-v2-state-fg-success": computer.connected,
                        "text-v2-text-text-muted": !computer.connected,
                      }}
                    >
                      {computer.connected
                        ? language.t("settings.computers.connected")
                        : language.t("settings.computers.disconnected")}
                    </span>
                  </div>
                )}
              </For>
            </div>

            <Show when={selectedComputer()}>
              {(computer) => (
                <div class="flex min-w-0 flex-1 flex-col gap-4">
                  <div class="flex items-center justify-between gap-3 rounded-md border border-v2-border-border-muted p-3">
                    <div class="flex min-w-0 flex-col">
                      <span class="truncate text-[13px] font-[530] text-v2-text-text-base">{computer().name}</span>
                    </div>
                    <div class="flex items-center gap-2">
                      <Show
                        when={computer().connected}
                        fallback={
                          <Button variant="secondary" size="small" icon="enter" onClick={() => void connectComputer()}>
                            {language.t("settings.computers.connect")}
                          </Button>
                        }
                      >
                        <Button variant="secondary" size="small" icon="stop" onClick={() => void stopComputer()}>
                          {language.t("settings.computers.stop")}
                        </Button>
                      </Show>
                    </div>
                  </div>

                  <div class="flex items-start justify-between gap-4">
                    <div class="flex flex-col gap-1">
                      <span class="text-[13px] font-[530] text-v2-text-text-base">
                        {language.t("settings.computers.credentials.title")}
                      </span>
                      <span class="text-[11px] font-[440] text-v2-text-text-muted">
                        {language.t("settings.computers.credentials.description")}
                      </span>
                    </div>
                    <Button variant="secondary" size="small" icon="plus-small" onClick={startNewCredential}>
                      {language.t("settings.computers.credentials.new")}
                    </Button>
                  </div>

                  <Show when={store.credentials.length === 0}>
                    <div class="text-[13px] font-[440] text-v2-text-text-muted">
                      {language.t("settings.computers.credentials.empty")}
                    </div>
                  </Show>

                  <div class="flex flex-col gap-1">
                    <For each={store.credentials}>
                      {(credential) => (
                        <div
                          class="flex items-center gap-2 rounded-md px-2 py-1.5 cursor-pointer hover:bg-v2-overlay-simple-overlay-hover"
                          classList={{ "bg-v2-background-bg-layer-01": selectedCredential() === credential.id }}
                          onClick={() => editCredential(credential)}
                        >
                          <Icon name="shield" size="small" class="shrink-0 text-v2-icon-icon-muted" />
                          <div class="flex min-w-0 flex-1 flex-col">
                            <span class="truncate text-[13px] font-[530] text-v2-text-text-base">
                              {credential.name}
                            </span>
                            <span class="truncate text-[11px] font-[440] text-v2-text-text-muted">
                              {credential.rules
                                .map((rule) =>
                                  language.t("settings.computers.credentials.ruleSummary", {
                                    kind: language.t(RULE_LABEL[rule.kind]),
                                    match: rule.match,
                                  }),
                                )
                                .join(" · ")}
                            </span>
                          </div>
                          <span onClick={(event) => event.stopPropagation()}>
                            <Switch
                              checked={credential.enabled}
                              onChange={(value) => void toggleCredential(credential, value)}
                            />
                          </span>
                        </div>
                      )}
                    </For>
                  </div>

                  <Show when={store.draft}>
                    {(draft) => (
                      <div class="flex flex-col gap-3 rounded-md border border-v2-border-border-muted p-3">
                        <div class="grid grid-cols-2 gap-3">
                          <TextField
                            label={language.t("settings.computers.credentials.name")}
                            value={draft().name}
                            onChange={(value) => setStore("draft", "name", value)}
                          />
                          <SelectField
                            label={language.t("settings.computers.credentials.kind")}
                            value={draft().kind ?? "password"}
                            options={[
                              { value: "password", label: language.t("settings.computers.credentials.kind.password") },
                              {
                                value: "username_password",
                                label: language.t("settings.computers.credentials.kind.usernamePassword"),
                              },
                              { value: "token", label: language.t("settings.computers.credentials.kind.token") },
                            ]}
                            onChange={(value) =>
                              setStore(
                                "draft",
                                "kind",
                                value === "username_password"
                                  ? "username_password"
                                  : value === "token"
                                    ? "token"
                                    : "password",
                              )
                            }
                          />
                        </div>
                        <Show when={(draft().kind ?? "password") === "username_password"}>
                          <TextField
                            label={language.t("settings.computers.credentials.username")}
                            value={draft().username ?? ""}
                            onChange={(value) => setStore("draft", "username", value)}
                          />
                        </Show>
                        <TextField
                          type="password"
                          label={language.t("settings.computers.credentials.secret")}
                          placeholder={
                            selectedCredential() === undefined
                              ? undefined
                              : language.t("settings.computers.credentials.secretKeep")
                          }
                          value={draft().secret ?? ""}
                          onChange={(value) => setStore("draft", "secret", value)}
                        />
                        <TextField
                          label={language.t("settings.computers.credentials.descriptionLabel")}
                          value={draft().description ?? ""}
                          onChange={(value) => setStore("draft", "description", value)}
                        />
                        <div class="flex flex-col gap-2">
                          <span class="text-[13px] font-[530] text-v2-text-text-muted">
                            {language.t("settings.computers.credentials.rules")}
                          </span>
                          <For each={draft().rules ?? []}>
                            {(rule, index) => (
                              <div class="flex min-w-0 items-end gap-2">
                                <SelectField
                                  class="w-44 shrink-0"
                                  value={rule.kind}
                                  options={RULE_KINDS.map((kind) => ({
                                    value: kind,
                                    label: language.t(RULE_LABEL[kind]),
                                  }))}
                                  onChange={(value) =>
                                    updateRule(
                                      index(),
                                      value === "application" ? "application" : value === "url" ? "url" : "command",
                                      rule.match,
                                    )
                                  }
                                />
                                <div class="min-w-0 flex-1">
                                  <TextField
                                    label={language.t("settings.computers.credentials.rule.match")}
                                    value={rule.match}
                                    onChange={(value) => updateRule(index(), rule.kind, value)}
                                  />
                                </div>
                                <IconButton
                                  icon="close-small"
                                  variant="ghost"
                                  aria-label={language.t("settings.computers.credentials.removeRule")}
                                  onClick={() => removeRule(index())}
                                />
                              </div>
                            )}
                          </For>
                          <div>
                            <Button variant="secondary" size="small" icon="plus-small" onClick={addRule}>
                              {language.t("settings.computers.credentials.addRule")}
                            </Button>
                          </div>
                        </div>
                        <div class="flex items-center gap-3">
                          <Switch
                            checked={draft().enabled !== false}
                            onChange={(value) => setStore("draft", "enabled", value)}
                          />
                          <span class="text-[13px] font-[440] text-v2-text-text-base">
                            {language.t("settings.computers.credentials.enabled")}
                          </span>
                        </div>
                        <div class="flex items-center gap-2">
                          <Button
                            variant="primary"
                            size="small"
                            onClick={() => void saveCredential()}
                            disabled={store.saving}
                          >
                            {language.t("settings.computers.credentials.save")}
                          </Button>
                          <Show when={selectedCredential() !== undefined}>
                            <IconButton
                              icon="trash"
                              variant="ghost"
                              aria-label={language.t("settings.computers.credentials.delete")}
                              onClick={() => void removeCredential()}
                            />
                          </Show>
                        </div>
                        <div class="text-[11px] font-[440] text-v2-text-text-muted">
                          {language.t("settings.computers.credentials.hint")}
                        </div>
                      </div>
                    )}
                  </Show>

                  <Show when={store.status}>
                    <div class="rounded-md bg-v2-background-bg-layer-01 p-2 text-[11px] font-[440] text-v2-text-text-muted">
                      {store.status}
                    </div>
                  </Show>
                  <Show when={errorText()}>
                    <div class="flex flex-col gap-1 rounded-md bg-v2-background-bg-layer-01 p-2">
                      <span class="text-[11px] font-[440] text-v2-state-fg-danger">{errorText()}</span>
                      <button
                        type="button"
                        class="text-left text-[11px] font-[440] text-v2-text-text-muted underline underline-offset-2 hover:text-v2-text-text-base"
                        onClick={() => void details.copy(store.error)}
                      >
                        {details.copied()
                          ? language.t("error.common.detailsCopied")
                          : language.t("error.common.copyDetails")}
                      </button>
                    </div>
                  </Show>
                </div>
              )}
            </Show>
          </div>
        </Show>
      </div>
    </>
  )
}
