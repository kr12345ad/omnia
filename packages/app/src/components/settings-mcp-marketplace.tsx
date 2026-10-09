import { For, Show, createEffect, createMemo, createUniqueId, onMount, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { SettingsListV2 } from "./settings-v2/parts/list"
import { useLanguage } from "@/context/language"
import { useServerSync } from "@/context/server-sync"
import { usePlatform } from "@/context/platform"
import type { Config, McpHealth } from "@opencode-ai/sdk/v2/client"
import { loadCatalog } from "@/mcp/catalog"
import {
  CATEGORY_ALL,
  catalogIndex,
  categories,
  categoryLabel,
  commandKey,
  commandLabel,
  filterServers,
  formatPopularity,
  installedEntries,
  needsSettings,
  patchMcp,
  serverConfig,
  serverKey,
  uniqueServerKey,
  serverRuntime,
  type MarketplaceRuntime,
  type MarketplaceSort,
  type MarketplaceServer,
  type McpEntry,
} from "@/mcp/marketplace"
import "./settings-v2/settings-v2.css"

const PAGE = 24

export const SettingsMcpMarketplace: Component<{ directory?: string }> = (props) => {
  const language = useLanguage()
  const dialog = useDialog()
  const sync = useServerSync()
  const platform = usePlatform()

  const [store, setStore] = createStore({
    catalog: [] as MarketplaceServer[],
    loading: true,
    query: "",
    category: CATEGORY_ALL,
    runtime: "all" as MarketplaceRuntime,
    sort: "popular" as MarketplaceSort,
    page: 1,
    view: "browse" as "browse" | "installed",
    selected: undefined as MarketplaceServer | undefined,
    busy: undefined as string | undefined,
    checking: undefined as string | undefined,
    health: {} as Record<string, McpHealth | undefined>,
    error: "",
    mcp: undefined as Config["mcp"] | undefined,
  })
  const catalog = () => store.catalog
  const loading = () => store.loading
  const query = () => store.query
  const category = () => store.category
  const busy = () => store.busy
  const checking = () => store.checking
  const error = () => store.error
  const setQuery = (value: string) => setStore({ query: value, page: 1 })
  const setCategory = (value: string) => setStore({ category: value, page: 1 })

  const load = () => {
    setStore({ loading: true, error: "" })
    return loadCatalog()
      .then((catalog) => setStore("catalog", catalog))
      .catch((reason) => setStore("error", reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setStore("loading", false))
  }
  onMount(() => void load())

  createEffect(() => {
    sync().data.config.mcp
    setStore("mcp", undefined)
  })
  const config = () => ({ ...sync().data.config, ...(store.mcp === undefined ? {} : { mcp: store.mcp }) })
  const index = createMemo(() => catalogIndex(catalog()))
  const installed = createMemo(() => installedEntries(config(), index()))
  const installedCommands = createMemo(
    () =>
      new Set(
        installed()
          .map((item) => commandLabel(item.entry))
          .filter((item) => item !== undefined),
      ),
  )
  const results = createMemo(() =>
    filterServers(catalog(), query(), category(), PAGE, {
      offset: (store.page - 1) * PAGE,
      runtime: store.runtime,
      sort: store.sort,
    }),
  )
  const categoryCounts = createMemo(() => {
    const counts = new Map<string, number>([[CATEGORY_ALL, catalog().length]])
    for (const server of catalog()) counts.set(server.category, (counts.get(server.category) ?? 0) + 1)
    return counts
  })
  const pageCount = () => Math.max(1, Math.ceil(results().total / PAGE))
  const hasFilters = () =>
    query().trim().length > 0 || category() !== CATEGORY_ALL || store.runtime !== "all" || store.sort !== "popular"
  const resetFilters = () =>
    setStore({ query: "", category: CATEGORY_ALL, runtime: "all", sort: "popular", page: 1 })
  createEffect(() => {
    if (store.page > pageCount()) setStore("page", pageCount())
  })
  const installedResults = createMemo(() =>
    installed().filter((item) =>
      `${item.name} ${item.catalog?.name ?? ""} ${commandLabel(item.entry) ?? ""}`
        .toLowerCase()
        .includes(query().trim().toLowerCase()),
    ),
  )
  const categoryName = (value: string) => {
    const key = `settings.mcpMarketplace.category.${value}` as Parameters<typeof language.t>[0]
    return language.t(key) ?? categoryLabel(value)
  }
  const runtimeName = (server: MarketplaceServer) =>
    language.t(`settings.mcpMarketplace.runtime.${serverRuntime(server)}`)
  const healthName = (health: McpHealth) => {
    const key = `mcp.status.${health.status.status}` as Parameters<typeof language.t>[0]
    return language.t(key) ?? health.status.status
  }

  const update = async (name: string, entry: McpEntry | undefined) => {
    if (busy() !== undefined) return
    setStore("busy", name)
    try {
      const next = patchMcp(config(), name, entry)
      await sync().updateConfig(next)
      setStore("mcp", next.mcp ?? {})
      setStore("error", "")
    } catch (reason) {
      setStore("error", reason instanceof Error ? reason.message : String(reason))
      throw reason
    } finally {
      setStore("busy", undefined)
    }
  }

  const checkHealth = async (name: string) => {
    if (!props.directory || busy() !== undefined || checking() !== undefined) return
    setStore("checking", name)
    try {
      const result = await sync().mcp.health(props.directory, name)
      setStore("health", name, result)
      setStore("error", "")
    } catch (reason) {
      const error = reason instanceof Error ? reason.message : String(reason)
      setStore("health", name, { status: { status: "failed", error } })
      setStore("error", error)
    } finally {
      setStore("checking", undefined)
    }
  }

  const install = (server: MarketplaceServer, environment: Record<string, string>) => {
    const name = uniqueServerKey(Object.keys(config().mcp ?? {}), serverKey(server))
    return update(name, serverConfig(server, environment, true)).then(() => checkHealth(name))
  }

  const start = (server: MarketplaceServer) => {
    if (!needsSettings(server)) return install(server, {}).catch(() => undefined)
    dialog.push(() => <DialogMcpSetup server={server} onSave={(environment) => install(server, environment)} />)
  }

  const configure = (name: string, server: MarketplaceServer, entry: McpEntry) => {
    // Only a local entry carries the command the catalog matched on, and only a
    // local entry can hold the environment the dialog edits.
    if (!("command" in entry)) return
    dialog.push(() => (
      <DialogMcpSetup
        server={server}
        values={entry.environment}
        onSave={(environment) => update(name, { ...entry, environment })}
      />
    ))
  }

  return (
    <>
      <div
        class="settings-v2-tab-header settings-v2-tab-header--stacked"
        classList={{ "settings-v2-marketplace-header": true }}
      >
        <div class="settings-v2-tab-header-row">
          <h2 class="settings-v2-tab-title">{language.t("settings.mcpMarketplace.title")}</h2>
          <Show when={!loading()}>
            <span class="settings-v2-marketplace-count">
              {language.t("settings.mcpMarketplace.count", { count: catalog().length })}
            </span>
          </Show>
        </div>
        <p class="settings-v2-marketplace-lede">{language.t("settings.mcpMarketplace.description")}</p>
        <Show when={!store.selected}>
          <nav class="settings-v2-marketplace-navigation" aria-label={language.t("settings.mcpMarketplace.pages")}>
            <ButtonV2
              variant={store.view === "browse" ? "contrast" : "ghost"}
              size="small"
              aria-current={store.view === "browse" ? "page" : undefined}
              onClick={() => setStore({ view: "browse", page: 1 })}
            >
              {language.t("settings.mcpMarketplace.browse")}
            </ButtonV2>
            <ButtonV2
              variant={store.view === "installed" ? "contrast" : "ghost"}
              size="small"
              aria-current={store.view === "installed" ? "page" : undefined}
              onClick={() => setStore({ view: "installed", page: 1 })}
            >
              {language.t("settings.mcpMarketplace.installed")} ({installed().length})
            </ButtonV2>
          </nav>
          <div class="settings-v2-tab-search">
            <TextInputV2
              type="search"
              appearance="base"
              leadingIcon={<Icon name="magnifying-glass" size="small" />}
              value={query()}
              onInput={(event) => setQuery(event.currentTarget.value)}
              placeholder={language.t("settings.mcpMarketplace.search")}
              spellcheck={false}
              autocorrect="off"
              autocomplete="off"
              autocapitalize="off"
              aria-label={language.t("settings.mcpMarketplace.search")}
            />
          </div>
          <Show when={store.view === "browse"}>
            <div class="settings-v2-marketplace-filters">
              <label>
                <span>{language.t("settings.mcpMarketplace.runtime")}</span>
                <select
                  value={store.runtime}
                  onChange={(event) => setStore({ runtime: event.currentTarget.value as MarketplaceRuntime, page: 1 })}
                >
                  <For each={["all", "node", "python", "docker"] as const}>
                    {(value) => <option value={value}>{language.t(`settings.mcpMarketplace.runtime.${value}`)}</option>}
                  </For>
                </select>
              </label>
              <label>
                <span>{language.t("settings.mcpMarketplace.sort")}</span>
                <select
                  value={store.sort}
                  onChange={(event) => setStore({ sort: event.currentTarget.value as MarketplaceSort, page: 1 })}
                >
                  <option value="popular">{language.t("settings.mcpMarketplace.sort.popular")}</option>
                  <option value="name">{language.t("settings.mcpMarketplace.sort.name")}</option>
                </select>
              </label>
              <Show when={hasFilters()}>
                <ButtonV2 variant="ghost" size="small" icon="reset" onClick={resetFilters}>
                  {language.t("common.reset")}
                </ButtonV2>
              </Show>
            </div>
            <div class="settings-v2-marketplace-categories">
              <For each={categories(catalog())}>
                {(item) => (
                  <button
                    type="button"
                    class="settings-v2-marketplace-chip"
                    data-active={category() === item ? "" : undefined}
                    aria-pressed={category() === item}
                    onClick={() => setCategory(item)}
                  >
                    {categoryName(item)}
                    <span class="settings-v2-marketplace-chip-count" aria-hidden="true">
                      {categoryCounts().get(item) ?? 0}
                    </span>
                  </button>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </div>

      <div class="settings-v2-tab-body settings-v2-marketplace">
        <Show when={error()}>
          <div class="settings-v2-marketplace-error" role="alert">
            {error()}
            <Show when={catalog().length === 0 && !loading()}>
              <ButtonV2 variant="ghost" size="small" onClick={() => void load()}>
                {language.t("settings.mcpMarketplace.retry")}
              </ButtonV2>
            </Show>
          </div>
        </Show>

        <Show when={store.selected}>
          {(server) => (
            <section class="settings-v2-marketplace-details" aria-label={server().name}>
              <ButtonV2 variant="ghost" size="small" onClick={() => setStore("selected", undefined)}>
                {language.t("settings.mcpMarketplace.back")}
              </ButtonV2>
              <div class="settings-v2-marketplace-detail-heading">
                <h3>{server().name}</h3>
                <Tag>{categoryName(server().category)}</Tag>
                <Tag>{runtimeName(server())}</Tag>
              </div>
              <p class="settings-v2-marketplace-lede">{server().description}</p>
              <div class="settings-v2-marketplace-detail-actions">
                <Show
                  when={!installedCommands().has(commandKey(server().command))}
                  fallback={<Tag variant="accent">{language.t("settings.mcpMarketplace.installedTag")}</Tag>}
                >
                  <ButtonV2
                    variant="contrast"
                    size="small"
                    disabled={busy() !== undefined}
                    onClick={() => start(server())}
                  >
                    {language.t("settings.mcpMarketplace.install")}
                  </ButtonV2>
                </Show>
                <Show when={server().homepage && /^https?:\/\//i.test(server().homepage!)}>
                  <ButtonV2 variant="neutral" size="small" onClick={() => platform.openExternal(server().homepage!)}>
                    {language.t("settings.mcpMarketplace.documentation")}
                  </ButtonV2>
                </Show>
              </div>
              <h4>{language.t("settings.mcpMarketplace.installCommand")}</h4>
              <pre class="settings-v2-marketplace-detail-command">
                <code>{commandKey(server().command)}</code>
              </pre>
              <p class="settings-v2-marketplace-lede">
                {language.t(`settings.mcpMarketplace.requirements.${serverRuntime(server())}`)}
              </p>
              <Show when={needsSettings(server())}>
                <h4>{language.t("settings.mcpMarketplace.configuration")}</h4>
                <For each={server().env ?? []}>
                  {(variable) => (
                    <div class="settings-v2-marketplace-detail-field">
                      <span class="font-mono">{variable.name}</span>
                      <Show when={variable.secret}>
                        <Tag>{language.t("settings.mcpMarketplace.setup.secret")}</Tag>
                      </Show>
                      <p>{variable.description ?? variable.name}</p>
                    </div>
                  )}
                </For>
              </Show>
            </section>
          )}
        </Show>

        <Show when={!store.selected && store.view === "installed"}>
          <section class="settings-v2-section">
            <h3 class="settings-v2-section-title">{language.t("settings.mcpMarketplace.installed")}</h3>
            <Show when={installedResults().length === 0}>
              <p class="settings-v2-marketplace-status">{language.t("settings.mcpMarketplace.installedEmpty")}</p>
            </Show>
            <SettingsListV2>
              <For each={installedResults()}>
                {(item) => (
                  <div class="settings-v2-marketplace-row">
                    <div class="settings-v2-marketplace-copy">
                      <span class="settings-v2-marketplace-name">
                        {item.name}
                        <Show when={!item.catalog}>
                          <Tag>{language.t("settings.mcpMarketplace.custom")}</Tag>
                        </Show>
                        <Show when={item.entry.enabled === false}>
                          <Tag>{language.t("settings.mcpMarketplace.paused")}</Tag>
                        </Show>
                      </span>
                      <span class="settings-v2-marketplace-command font-mono">
                        {commandLabel(item.entry) ?? language.t("settings.mcpMarketplace.unnamed")}
                      </span>
                    </div>
                    <div class="settings-v2-marketplace-actions">
                      <Show when={item.catalog && needsSettings(item.catalog)}>
                        <ButtonV2
                          variant="ghost"
                          size="small"
                          disabled={busy() !== undefined}
                          onClick={() => configure(item.name, item.catalog!, item.entry)}
                        >
                          {language.t("settings.mcpMarketplace.configure")}
                        </ButtonV2>
                      </Show>
                      <Show when={item.catalog}>
                        <ButtonV2 variant="ghost" size="small" onClick={() => setStore("selected", item.catalog)}>
                          {language.t("settings.mcpMarketplace.details")}
                        </ButtonV2>
                      </Show>
                      <Show when={props.directory}>
                        <ButtonV2
                          variant={checking() === item.name ? "loading" : "ghost"}
                          size="small"
                          icon="reset"
                          disabled={busy() !== undefined || checking() !== undefined}
                          onClick={() => void checkHealth(item.name)}
                        >
                          {language.t("settings.updates.action.checkNow")}
                        </ButtonV2>
                      </Show>
                      <Show when={store.health[item.name]}>
                        {(health) => (
                          <Tag variant={health().status.status === "connected" ? "accent" : undefined}>
                            {healthName(health())}
                          </Tag>
                        )}
                      </Show>
                      <Switch
                        checked={item.entry.enabled !== false}
                        disabled={busy() !== undefined}
                        onChange={(checked) =>
                          void update(item.name, { ...item.entry, enabled: checked }).catch(() => undefined)
                        }
                      >
                        {language.t("settings.mcpMarketplace.startup")}
                      </Switch>
                      <ButtonV2
                        variant="ghost"
                        size="small"
                        disabled={busy() !== undefined}
                        onClick={() => void update(item.name, undefined).catch(() => undefined)}
                      >
                        {language.t("settings.mcpMarketplace.remove")}
                      </ButtonV2>
                    </div>
                  </div>
                )}
              </For>
            </SettingsListV2>
          </section>
        </Show>

        <Show when={!store.selected && store.view === "browse"}>
          <section class="settings-v2-section">
            <h3 class="settings-v2-section-title">
              {language.t("settings.mcpMarketplace.catalog")}
              <Show when={!loading()}>
                <span class="settings-v2-marketplace-section-count">{results().total}</span>
              </Show>
            </h3>
            <Show
              when={results().servers.length > 0}
              fallback={
                <div class="settings-v2-marketplace-status">
                  {language.t(loading() ? "settings.mcpMarketplace.loading" : "settings.mcpMarketplace.empty")}
                </div>
              }
            >
              <SettingsListV2>
                <For each={results().servers}>
                  {(server) => (
                    <div class="settings-v2-marketplace-row">
                      <div class="settings-v2-marketplace-copy">
                        <span class="settings-v2-marketplace-name">
                          {server.name}
                          <Tag>{categoryName(server.category)}</Tag>
                          <Tag>{runtimeName(server)}</Tag>
                          <Show when={formatPopularity(server.popularity)}>
                            {(value) => <span class="settings-v2-marketplace-popularity">{value()}</span>}
                          </Show>
                        </span>
                        <p class="settings-v2-marketplace-description">{server.description}</p>
                        <span class="settings-v2-marketplace-command font-mono">{commandKey(server.command)}</span>
                      </div>
                      <div class="settings-v2-marketplace-actions">
                        <ButtonV2
                          variant="ghost"
                          size="small"
                          onClick={() => setStore("selected", server)}
                          aria-label={language.t("settings.mcpMarketplace.detailsFor", { server: server.name })}
                        >
                          {language.t("settings.mcpMarketplace.details")}
                        </ButtonV2>
                        <Show when={needsSettings(server)}>
                          <Tag>{language.t("settings.mcpMarketplace.needsSettings")}</Tag>
                        </Show>
                        <Show
                          when={installedCommands().has(commandKey(server.command))}
                          fallback={
                            <ButtonV2
                              variant="contrast"
                              size="small"
                              icon="plus"
                              disabled={busy() !== undefined}
                              onClick={() => start(server)}
                            >
                              {language.t("settings.mcpMarketplace.install")}
                            </ButtonV2>
                          }
                        >
                          <Tag variant="accent">{language.t("settings.mcpMarketplace.installedTag")}</Tag>
                        </Show>
                      </div>
                    </div>
                  )}
                </For>
              </SettingsListV2>
            </Show>
            <Show when={results().total > 0}>
              <nav
                class="settings-v2-marketplace-pagination"
                aria-label={language.t("settings.mcpMarketplace.pagination")}
              >
                <ButtonV2
                  variant="neutral"
                  size="small"
                  disabled={store.page === 1}
                  onClick={() => setStore("page", 1)}
                >
                  {language.t("settings.mcpMarketplace.first")}
                </ButtonV2>
                <ButtonV2
                  variant="neutral"
                  size="small"
                  disabled={store.page === 1}
                  onClick={() => setStore("page", store.page - 1)}
                >
                  {language.t("settings.mcpMarketplace.previous")}
                </ButtonV2>
                <span role="status">
                  {language.t("settings.mcpMarketplace.page", {
                    page: store.page,
                    pages: pageCount(),
                    total: results().total,
                  })}
                </span>
                <ButtonV2
                  variant="neutral"
                  size="small"
                  disabled={store.page === pageCount()}
                  onClick={() => setStore("page", store.page + 1)}
                >
                  {language.t("settings.mcpMarketplace.next")}
                </ButtonV2>
                <ButtonV2
                  variant="neutral"
                  size="small"
                  disabled={store.page === pageCount()}
                  onClick={() => setStore("page", pageCount())}
                >
                  {language.t("settings.mcpMarketplace.last")}
                </ButtonV2>
              </nav>
            </Show>
          </section>
        </Show>
      </div>
    </>
  )
}

const DialogMcpSetup: Component<{
  server: MarketplaceServer
  values?: Record<string, string>
  onSave: (environment: Record<string, string>) => void | Promise<void>
}> = (props) => {
  const language = useLanguage()
  const dialog = useDialog()
  const [values, setValues] = createStore<Record<string, string>>({ ...(props.values ?? {}) })
  const [state, setState] = createStore({ saving: false, error: "" })
  const fieldId = createUniqueId()
  const saving = () => state.saving

  const save = async () => {
    if (saving()) return
    const missing = props.server.env?.find((variable) => variable.required && !(values[variable.name] ?? "").trim())
    if (missing) {
      setState("error", language.t("settings.mcpMarketplace.setup.required", { field: missing.name }))
      return
    }
    setState({ saving: true, error: "" })
    try {
      await props.onSave({ ...values })
      dialog.close()
    } catch (reason) {
      setState("error", reason instanceof Error ? reason.message : String(reason))
    } finally {
      setState("saving", false)
    }
  }

  const submit = (event: KeyboardEvent) => {
    if (event.key !== "Enter" || event.isComposing) return
    event.preventDefault()
    if (!saving()) void save()
  }

  return (
    <Dialog fit class="settings-v2-marketplace-dialog">
      <DialogHeader>
        <DialogTitle>{language.t("settings.mcpMarketplace.setup.title", { server: props.server.name })}</DialogTitle>
      </DialogHeader>
      <DialogBody class="flex w-full min-w-0 flex-1 flex-col px-4 pt-4 pb-2">
        <div class="flex w-full min-w-0 flex-col gap-5">
          <p class="settings-v2-marketplace-lede">{language.t("settings.mcpMarketplace.setup.description")}</p>
          <For each={props.server.env ?? []}>
            {(variable) => (
              <div class="flex w-full min-w-0 flex-col gap-2">
                <label class="settings-v2-marketplace-field-label" for={`${fieldId}-${variable.name}`}>
                  <span class="font-mono">{variable.name}</span>
                  <Show when={variable.secret}>
                    <Tag>{language.t("settings.mcpMarketplace.setup.secret")}</Tag>
                  </Show>
                </label>
                <TextInputV2
                  id={`${fieldId}-${variable.name}`}
                  required={variable.required === true}
                  type={variable.secret ? "password" : "text"}
                  appearance="large"
                  class="!w-full self-stretch"
                  value={values[variable.name] ?? ""}
                  placeholder={variable.description ?? variable.name}
                  disabled={saving()}
                  onInput={(event) => setValues(variable.name, event.currentTarget.value)}
                  onKeyDown={submit}
                />
              </div>
            )}
          </For>
          <Show when={state.error}>
            <p role="alert" class="settings-v2-marketplace-error">
              {state.error}
            </p>
          </Show>
        </div>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 variant="neutral" disabled={saving()} onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </ButtonV2>
        <ButtonV2 variant="contrast" disabled={saving()} onClick={() => void save()}>
          {language.t("settings.mcpMarketplace.install")}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}
