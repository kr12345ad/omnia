import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { isNavigableBrowserUrl } from "@opencode-ai/omnia/browser/url-policy"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useSettings } from "@/context/settings"

const PANEL_MIN_WIDTH = 320
const PANEL_MAX_WIDTH = 1400
const BROWSER_PARTITION = "persist:omnia-browser"

type WebviewEvent = {
  readonly url?: string
  readonly title?: string
  readonly isMainFrame?: boolean
}

type WebviewElement = HTMLElement & {
  getWebContentsId?: () => number
  getURL?: () => string
  canGoBack?: () => boolean
  canGoForward?: () => boolean
  loadURL?: (url: string) => Promise<void>
  goBack?: () => void
  goForward?: () => void
  reload?: () => void
}

type BrowserTabState = {
  readonly key: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  webContentsId?: number
  requestId?: string
}

type BrowserDialogState = {
  readonly type: string
  readonly message: string
  readonly defaultPrompt?: string
  readonly frameUrl?: string
}

function eventField(event: Event, key: keyof WebviewEvent): string | undefined {
  const value = (event as unknown as Record<string, unknown>)[key]
  return typeof value === "string" ? value : undefined
}

function normalizeAddress(value: string): string | undefined {
  const trimmed = value.trim()
  if (trimmed.length === 0) return "about:blank"
  // A scheme is only a scheme when the colon is not a host:port separator;
  // otherwise "example.com:8080" would be mistaken for a custom scheme.
  const hasScheme = /^[a-z][a-z0-9+.-]*:(?!\d)/iu.test(trimmed)
  const candidate = hasScheme ? trimmed : `https://${trimmed}`
  return isNavigableBrowserUrl(candidate) ? candidate : undefined
}

// The guest URL is the local reader page while a PDF is open. The address bar
// still belongs to the document the user opened, so show its source URL rather
// than the internal oc://renderer reader address.
function displayAddress(value: string): string {
  if (!URL.canParse(value)) return value
  const url = new URL(value)
  if (!url.pathname.endsWith("/pdf.html")) return value
  const source = url.searchParams.get("url")
  return source !== null && URL.canParse(source) ? source : value
}

export function BrowserPanel() {
  const platform = usePlatform()
  const settings = useSettings()
  const language = useLanguage()
  const api = platform.browserPanel
  const [tabs, setTabs] = createStore({ items: [] as BrowserTabState[], active: undefined as string | undefined })
  const [dialogs, setDialogs] = createStore<{ byTab: Record<number, BrowserDialogState | undefined> }>({ byTab: {} })
  const [address, setAddress] = createSignal("")
  const [blocked, setBlocked] = createSignal(false)
  const [promptText, setPromptText] = createSignal("")
  const elements = new Map<string, WebviewElement>()

  const available = createMemo(() => platform.platform === "desktop" && api !== undefined)
  // A persisted open panel from a desktop session must not wedge the web
  // workspace in a state it cannot render or toggle back.
  createEffect(() => {
    if (available()) return
    if (!settings.general.browserPanelOpen()) return
    settings.general.setBrowserPanelOpen(false)
  })
  const open = createMemo(() => settings.general.browserPanelOpen())
  const activeTab = createMemo(() => tabs.items.find((tab) => tab.key === tabs.active))
  const activeUrl = createMemo(() => activeTab()?.url ?? "about:blank")
  const activeDialog = createMemo(() => {
    const id = activeTab()?.webContentsId
    return id === undefined ? undefined : dialogs.byTab[id]
  })

  const answerDialog = (accept: boolean) => {
    const id = activeTab()?.webContentsId
    if (id === undefined || api === undefined) return
    const dialog = activeDialog()
    void api
      .answerDialog({
        webContentsId: id,
        accept,
        ...(dialog?.type === "prompt" && accept ? { promptText: promptText() } : {}),
      })
      .then(() => setDialogs("byTab", id, undefined))
      .catch(() => undefined)
  }

  const updateTab = (key: string, patch: Partial<BrowserTabState>) => {
    const index = tabs.items.findIndex((tab) => tab.key === key)
    if (index === -1) return
    setTabs("items", index, patch)
  }

  const createTab = (url = "about:blank", requestId?: string) => {
    // The main process re-sends an open until the guest registers. Slow pages
    // must not mount a fresh webview on every retry and close targets in flight.
    const existing = requestId === undefined ? undefined : tabs.items.find((tab) => tab.requestId === requestId)
    if (existing !== undefined) {
      setTabs("active", existing.key)
      return existing.key
    }
    const key = crypto.randomUUID()
    const tab: BrowserTabState = {
      key,
      url,
      title: "",
      loading: true,
      canGoBack: false,
      canGoForward: false,
      ...(requestId === undefined ? {} : { requestId }),
    }
    setTabs("items", (items) => [...items, tab])
    setTabs("active", key)
    return key
  }

  const closeTab = (key: string) => {
    const index = tabs.items.findIndex((tab) => tab.key === key)
    if (index === -1) return
    const tab = tabs.items[index]!
    if (tab.webContentsId !== undefined) {
      void api?.unregister(tab.webContentsId)
      setDialogs("byTab", tab.webContentsId, undefined)
    }
    elements.delete(key)
    const next = tabs.items[index + 1] ?? tabs.items[index - 1]
    setTabs("items", (items) => items.filter((item) => item.key !== key))
    if (tabs.active === key) setTabs("active", next?.key)
  }

  const setupTab = (key: string, element: WebviewElement) => {
    elements.set(key, element)
    element.setAttribute("src", tabs.items.find((tab) => tab.key === key)?.url ?? "about:blank")
    element.addEventListener("dom-ready", () => {
      const webContentsId = element.getWebContentsId?.()
      if (typeof webContentsId !== "number") return
      const tab = tabs.items.find((item) => item.key === key)
      updateTab(key, { webContentsId })
      void api?.register({
        webContentsId,
        ...(tab?.requestId === undefined ? {} : { requestId: tab.requestId }),
        url: element.getURL?.() ?? tab?.url ?? "about:blank",
      })
    })
    element.addEventListener("did-start-loading", () => updateTab(key, { loading: true }))
    element.addEventListener("did-stop-loading", () => {
      updateTab(key, {
        loading: false,
        ...(element.getURL === undefined ? {} : { url: element.getURL() ?? "" }),
        canGoBack: element.canGoBack?.() ?? false,
        canGoForward: element.canGoForward?.() ?? false,
      })
    })
    element.addEventListener("did-navigate", (event) => {
      const url = eventField(event, "url")
      if (url !== undefined) updateTab(key, { url })
      const id = tabs.items.find((tab) => tab.key === key)?.webContentsId
      if (id !== undefined) setDialogs("byTab", id, undefined)
    })
    element.addEventListener("did-navigate-in-page", (event) => {
      const url = eventField(event, "url")
      if (url !== undefined) updateTab(key, { url })
      const id = tabs.items.find((tab) => tab.key === key)?.webContentsId
      if (id !== undefined) setDialogs("byTab", id, undefined)
    })
    element.addEventListener("page-title-updated", (event) => {
      const title = eventField(event, "title")
      if (title !== undefined) updateTab(key, { title })
    })
    element.addEventListener("did-fail-load", () => updateTab(key, { loading: false }))
  }

  const navigateActive = (value: string) => {
    const url = normalizeAddress(value)
    // A refused address must say so: silently doing nothing reads as a broken
    // address bar, and the reason (a private host, or text that is not a URL)
    // is not something the user can infer from an unchanged page.
    if (url === undefined) {
      setBlocked(true)
      return
    }
    setBlocked(false)
    const tab = activeTab()
    if (tab === undefined) {
      createTab(url)
      return
    }
    updateTab(tab.key, { url, loading: true })
    const element = elements.get(tab.key)
    if (element?.loadURL !== undefined) void element.loadURL(url)
  }

  const activeElement = () => {
    const tab = activeTab()
    return tab === undefined ? undefined : elements.get(tab.key)
  }

  const startResize = (event: PointerEvent) => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = settings.general.browserPanelWidth()
    const move = (moveEvent: PointerEvent) => {
      settings.general.setBrowserPanelWidth(startWidth + (startX - moveEvent.clientX))
    }
    const stop = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", stop)
      window.removeEventListener("pointercancel", stop)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", stop)
    window.addEventListener("pointercancel", stop)
  }

  createEffect(() => {
    const url = displayAddress(activeUrl())
    setAddress(url === "about:blank" ? "" : url)
    setBlocked(false)
  })

  createEffect(() => {
    const dialog = activeDialog()
    setPromptText(dialog?.defaultPrompt ?? "")
  })

  createEffect(() => {
    const tab = activeTab()
    if (tab?.webContentsId !== undefined) void api?.activate(tab.webContentsId)
  })

  onMount(() => {
    if (api === undefined) return
    const dispose = api.onCommand((command) => {
      if (command.kind === "open") {
        settings.general.setBrowserPanelOpen(true)
        createTab(command.url, command.requestId)
        return
      }
      if (command.kind === "activate") {
        const tab = tabs.items.find((item) => item.webContentsId === command.tabId)
        if (tab !== undefined) setTabs("active", tab.key)
        return
      }
      if (command.kind === "dialog") {
        setDialogs("byTab", command.tabId, {
          type: command.type,
          message: command.message,
          ...(command.defaultPrompt === undefined ? {} : { defaultPrompt: command.defaultPrompt }),
          ...(command.frameUrl === undefined ? {} : { frameUrl: command.frameUrl }),
        })
        return
      }
      const tab = tabs.items.find((item) => item.webContentsId === command.tabId)
      if (tab !== undefined) closeTab(tab.key)
    })
    onCleanup(() => {
      dispose()
      tabs.items.forEach((tab) => {
        if (tab.webContentsId !== undefined) void api.unregister(tab.webContentsId)
      })
      elements.clear()
    })
  })

  return (
    <Show when={available()}>
      <aside
        aria-label={language.t("browser.panel.title")}
        aria-hidden={!open()}
        classList={{
          "relative shrink-0 min-h-0 flex flex-col overflow-hidden bg-v2-background-bg-base rounded-[10px] shadow-[var(--v2-elevation-raised)] my-2 mr-2":
            true,
          hidden: !open(),
        }}
        style={{
          width: `${Math.min(Math.max(settings.general.browserPanelWidth(), PANEL_MIN_WIDTH), PANEL_MAX_WIDTH)}px`,
          "max-width": "70vw",
        }}
      >
        <div
          role="separator"
          aria-orientation="vertical"
          class="absolute inset-y-0 left-0 z-20 w-1.5 -translate-x-1/2 cursor-col-resize touch-none"
          onPointerDown={startResize}
        />
        <div class="h-9 shrink-0 flex items-center gap-1 px-2 border-b border-v2-border-border-base">
          <IconButton
            icon="arrow-left"
            variant="ghost"
            class="h-6 w-6 shrink-0"
            disabled={activeTab()?.canGoBack !== true}
            onClick={() => activeElement()?.goBack?.()}
            aria-label={language.t("browser.panel.back")}
          />
          <IconButton
            icon="arrow-right"
            variant="ghost"
            class="h-6 w-6 shrink-0"
            disabled={activeTab()?.canGoForward !== true}
            onClick={() => activeElement()?.goForward?.()}
            aria-label={language.t("browser.panel.forward")}
          />
          <IconButton
            icon="reset"
            variant="ghost"
            class="h-6 w-6 shrink-0"
            onClick={() => activeElement()?.reload?.()}
            aria-label={language.t("browser.panel.reload")}
          />
          <input
            type="text"
            value={address()}
            spellcheck={false}
            autocomplete="off"
            placeholder={language.t("browser.panel.address.placeholder")}
            aria-label={language.t("browser.panel.address.placeholder")}
            aria-invalid={blocked()}
            classList={{
              "flex-1 min-w-0 h-6 rounded-md border bg-v2-background-bg-deep px-2 text-12-regular text-text-strong outline-none focus:border-v2-border-border-focus":
                true,
              "border-v2-border-border-base": !blocked(),
              "border-icon-critical-base": blocked(),
            }}
            onInput={(event) => {
              setBlocked(false)
              setAddress(event.currentTarget.value)
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return
              navigateActive(event.currentTarget.value)
            }}
          />
          <Show when={activeTab()?.loading === true}>
            <span
              class="size-1.5 shrink-0 rounded-full bg-icon-interactive-base animate-pulse"
              aria-label={language.t("browser.panel.loading")}
            />
          </Show>
          <IconButton
            icon="close-small"
            variant="ghost"
            class="h-6 w-6 shrink-0"
            onClick={() => settings.general.setBrowserPanelOpen(false)}
            aria-label={language.t("browser.panel.close")}
          />
        </div>
        <Show when={blocked()}>
          <div
            role="alert"
            class="shrink-0 border-b border-v2-border-border-base bg-v2-background-bg-deep px-2 py-1.5 text-11-regular text-text-strong"
          >
            {language.t("browser.panel.address.blocked")}
          </div>
        </Show>
        <div class="h-8 shrink-0 flex items-center gap-1 px-2 border-b border-v2-border-border-base overflow-x-auto no-scrollbar">
          <For each={tabs.items}>
            {(tab) => (
              <div
                classList={{
                  "group flex items-center gap-1 h-6 max-w-44 shrink-0 rounded-md px-2 text-11-regular cursor-pointer":
                    true,
                  "bg-v2-background-bg-deep text-text-strong": tabs.active === tab.key,
                  "text-text-weak hover:text-text-strong": tabs.active !== tab.key,
                }}
                onClick={() => setTabs("active", tab.key)}
              >
                <span class="truncate">
                  {tab.title.length > 0
                    ? tab.title
                    : tab.url === "about:blank"
                      ? language.t("browser.panel.newTab")
                      : displayAddress(tab.url)}
                </span>
                <Tooltip placement="bottom" value={language.t("browser.panel.closeTab")}>
                  <button
                    type="button"
                    class="shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                    aria-label={language.t("browser.panel.closeTab")}
                    onClick={(event) => {
                      event.stopPropagation()
                      closeTab(tab.key)
                    }}
                  >
                    <Icon name="close-small" size="small" />
                  </button>
                </Tooltip>
              </div>
            )}
          </For>
          <Tooltip placement="bottom" value={language.t("browser.panel.newTab")}>
            <IconButton
              icon="plus-small"
              variant="ghost"
              class="h-6 w-6 shrink-0"
              onClick={() => createTab()}
              aria-label={language.t("browser.panel.newTab")}
            />
          </Tooltip>
        </div>
        <Show when={activeDialog()}>
          {(dialog) => (
            <div
              class="shrink-0 flex flex-col gap-1.5 border-b border-v2-border-border-base bg-v2-background-bg-deep px-2 py-1.5"
              aria-label={language.t("browser.panel.dialog.title")}
            >
              <div class="flex items-start gap-2">
                <span class="flex-1 min-w-0 max-h-20 overflow-y-auto whitespace-pre-wrap break-words text-11-regular text-text-strong">
                  {dialog().message}
                </span>
                <button
                  type="button"
                  class="h-6 shrink-0 rounded-md border border-v2-border-border-base px-2 text-11-regular text-text-strong hover:bg-v2-background-bg-base"
                  onClick={() => answerDialog(false)}
                >
                  {language.t("browser.panel.dialog.dismiss")}
                </button>
                <button
                  type="button"
                  class="h-6 shrink-0 rounded-md border border-v2-border-border-base bg-v2-background-bg-base px-2 text-11-regular text-text-strong hover:bg-v2-background-bg-deep"
                  onClick={() => answerDialog(true)}
                >
                  {language.t("browser.panel.dialog.accept")}
                </button>
              </div>
              <Show when={dialog().type === "prompt"}>
                <input
                  type="text"
                  value={promptText()}
                  spellcheck={false}
                  autocomplete="off"
                  placeholder={language.t("browser.panel.dialog.prompt.placeholder")}
                  aria-label={language.t("browser.panel.dialog.prompt.placeholder")}
                  class="h-6 rounded-md border border-v2-border-border-base bg-v2-background-bg-base px-2 text-12-regular text-text-strong outline-none focus:border-v2-border-border-focus"
                  onInput={(event) => setPromptText(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return
                    answerDialog(true)
                  }}
                />
              </Show>
            </div>
          )}
        </Show>
        <div class="relative flex-1 min-h-0">
          <For each={tabs.items}>
            {(tab) => (
              <div
                class="absolute inset-0 flex"
                classList={{ hidden: tabs.active !== tab.key }}
                aria-hidden={tabs.active !== tab.key}
              >
                <webview
                  partition={BROWSER_PARTITION}
                  plugins
                  class="w-full h-full"
                  ref={(element) => setupTab(tab.key, element as WebviewElement)}
                />
              </div>
            )}
          </For>
          <Show when={tabs.items.length === 0}>
            <div class="size-full flex items-center justify-center px-6 text-center text-12-regular text-text-weak">
              {language.t("browser.panel.empty")}
            </div>
          </Show>
        </div>
      </aside>
    </Show>
  )
}
