import { plugin } from "bun"
import { beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { fakeElectron as sharedElectron } from "../../../test-support/electron"

// browser-view.ts talks to the Electron main-process APIs, which only exist
// inside a running app. The fake window and webContents below reproduce the
// narrow surface the manager uses so the cold-start open handshake can be
// driven deterministically.
interface FakeDebugger {
  attached: boolean
  enabled: number
  detaches: number
  /** Rejects one sendCommand per entry, in order, before the next succeeds. */
  readonly failures: Array<{ method: string; error: Error }>
  readonly commands: Array<{ method: string; params?: Record<string, unknown> }>
  readonly listeners: Map<string, Set<(...args: unknown[]) => void>>
  attach(version: string): void
  detach(): void
  isAttached(): boolean
  sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>
  on(event: string, listener: (...args: unknown[]) => void): void
  removeListener(event: string, listener: (...args: unknown[]) => void): void
  emit(event: string, ...args: unknown[]): void
}

interface FakeNavigationHistory {
  backAvailable: boolean
  forwardAvailable: boolean
  readonly moves: string[]
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
}

interface FakeContents {
  id: number
  type: string
  url: string
  hostWebContents: null
  destroyed: boolean
  loading: boolean
  failSend: boolean
  readonly sent: Array<{ channel: string; message: unknown }>
  readonly debugger: FakeDebugger
  readonly navigationHistory: FakeNavigationHistory
  readonly reloads: string[]
  readonly loads: string[]
  send(channel: string, message: unknown): void
  isDestroyed(): boolean
  isLoading(): boolean
  getType(): string
  getURL(): string
  getTitle(): string
  loadURL(url: string): Promise<void>
  reload(): void
  reloadIgnoringCache(): void
  insertCSS(css: string): Promise<string>
  setWindowOpenHandler(handler: (details: { url: string }) => { action: string }): void
  removeAllListeners(event: string): void
  on(event: string, listener: (...args: unknown[]) => void): void
  once(event: string, listener: (...args: unknown[]) => void): void
  removeListener(event: string, listener: (...args: unknown[]) => void): void
  emit(event: string, ...args: unknown[]): void
}

interface FakeWindow {
  readonly webContents: FakeContents
  destroyed: boolean
  isDestroyed(): boolean
  once(event: string, listener: () => void): void
  removeListener(event: string, listener: () => void): void
  emit(event: string): void
  close(): void
}

type FakeListener = (...args: unknown[]) => void

function addListener(target: Map<string, Set<FakeListener>>, event: string, listener: FakeListener): void {
  const listeners = target.get(event) ?? new Set<FakeListener>()
  listeners.add(listener)
  target.set(event, listeners)
}

function removeListener(target: Map<string, Set<FakeListener>>, event: string, listener: FakeListener): void {
  target.get(event)?.delete(listener)
}

function emit(target: Map<string, Set<FakeListener>>, event: string, ...args: unknown[]): void {
  for (const listener of [...(target.get(event) ?? [])]) listener(...args)
}

function createDebugger(): FakeDebugger {
  const listeners = new Map<string, Set<FakeListener>>()
  const debugger_: FakeDebugger = {
    attached: false,
    enabled: 0,
    detaches: 0,
    failures: [],
    commands: [],
    listeners,
    attach() {
      if (debugger_.attached) throw new Error("Debugger is already attached.")
      debugger_.attached = true
    },
    detach() {
      if (!debugger_.attached) throw new Error("Debugger is not attached.")
      debugger_.attached = false
      debugger_.detaches += 1
      debugger_.emit("detach", undefined, "target_closed")
    },
    isAttached: () => debugger_.attached,
    sendCommand: (method, params) => {
      debugger_.commands.push({ method, ...(params === undefined ? {} : { params }) })
      const failure = debugger_.failures[0]
      if (failure?.method === method) {
        debugger_.failures.shift()
        return Promise.reject(failure.error)
      }
      if (method === "Page.enable") debugger_.enabled += 1
      return Promise.resolve({})
    },
    on: (event, listener) => addListener(listeners, event, listener),
    removeListener: (event, listener) => removeListener(listeners, event, listener),
    emit: (event, ...args) => emit(listeners, event, ...args),
  }
  return debugger_
}

const state = {
  windows: [] as FakeWindow[],
  focused: undefined as FakeWindow | undefined,
  contents: new Map<number, FakeContents>(),
  nextId: 1,
}

function createContents(options: { type?: string; url?: string } = {}): FakeContents {
  const listeners = new Map<string, Set<FakeListener>>()
  const history: FakeNavigationHistory = {
    backAvailable: false,
    forwardAvailable: false,
    moves: [],
    canGoBack: () => history.backAvailable,
    canGoForward: () => history.forwardAvailable,
    goBack: () => history.moves.push("back"),
    goForward: () => history.moves.push("forward"),
  }
  const contents: FakeContents = {
    id: state.nextId++,
    type: options.type ?? "window",
    url: options.url ?? "https://example.test/",
    hostWebContents: null,
    destroyed: false,
    loading: false,
    failSend: false,
    sent: [],
    debugger: createDebugger(),
    navigationHistory: history,
    reloads: [],
    loads: [],
    send(channel, message) {
      if (contents.failSend) throw new Error("The renderer is gone.")
      contents.sent.push({ channel, message })
    },
    isDestroyed: () => contents.destroyed,
    isLoading: () => contents.loading,
    getType: () => contents.type,
    getURL: () => contents.url,
    getTitle: () => "Example",
    loadURL: (url) => {
      contents.loads.push(url)
      contents.url = url
      return Promise.resolve()
    },
    reload: () => contents.reloads.push("reload"),
    reloadIgnoringCache: () => contents.reloads.push("reloadIgnoringCache"),
    insertCSS: () => Promise.resolve(""),
    setWindowOpenHandler: () => undefined,
    removeAllListeners: (event) => void listeners.delete(event),
    on: (event, listener) => addListener(listeners, event, listener),
    once: (event, listener) => {
      const onceListener: FakeListener = (...args) => {
        removeListener(listeners, event, onceListener)
        listener(...args)
      }
      addListener(listeners, event, onceListener)
    },
    removeListener: (event, listener) => removeListener(listeners, event, listener),
    emit: (event, ...args) => emit(listeners, event, ...args),
  }
  state.contents.set(contents.id, contents)
  return contents
}

function createWindow(): FakeWindow {
  const contents = createContents()
  const listeners = new Map<string, Set<FakeListener>>()
  const window: FakeWindow = {
    webContents: contents,
    destroyed: false,
    isDestroyed: () => window.destroyed,
    once: (event, listener) => addListener(listeners, event, listener),
    removeListener: (event, listener) => removeListener(listeners, event, listener),
    emit: (event) => emit(listeners, event),
    close: () => {
      window.destroyed = true
      contents.destroyed = true
      emit(listeners, "closed")
    },
  }
  state.windows.push(window)
  state.focused = window
  return window
}

// The Electron module is a path shim under Bun, so it has no named exports to
// satisfy browser-view.ts. A plugin substitution works even when another test
// file already loaded the real module, unlike mock.module which must run first.
const fakeAppListeners = new Map<string, Set<FakeListener>>()
const fakeSessionListeners = new Map<string, Set<FakeListener>>()
// The partition request filter is registered once per watch(); the fake keeps
// the last listener per phase so a test can drive it like Chromium would.
const fakeRequestFilters = new Map<string, FakeListener>()
const fakeSession = {
  setPermissionRequestHandler: () => undefined,
  setPermissionCheckHandler: () => undefined,
  on: (event: string, listener: FakeListener) => addListener(fakeSessionListeners, event, listener),
  once: (event: string, listener: FakeListener) => addListener(fakeSessionListeners, event, listener),
  removeListener: (event: string, listener: FakeListener) => removeListener(fakeSessionListeners, event, listener),
  webRequest: {
    onBeforeRequest: (_filter: unknown, listener: FakeListener) => {
      fakeRequestFilters.set("beforeRequest", listener)
    },
    onHeadersReceived: (_filter: unknown, listener: FakeListener) => {
      fakeRequestFilters.set("headersReceived", listener)
    },
  },
}

function filterRequest(details: Record<string, unknown>): { cancelled: boolean } {
  const results: Array<Record<string, unknown>> = []
  fakeRequestFilters.get("beforeRequest")?.(details, (result: Record<string, unknown>) => results.push(result))
  expect(results).toHaveLength(1)
  return { cancelled: results[0]?.cancel === true }
}

function filterResponseResult(details: Record<string, unknown>): Record<string, unknown> | undefined {
  const results: Array<Record<string, unknown>> = []
  fakeRequestFilters.get("headersReceived")?.(details, (result: Record<string, unknown>) => results.push(result))
  expect(results).toHaveLength(1)
  return results[0]
}

function filterResponse(details: Record<string, unknown>): { cancelled: boolean } {
  return { cancelled: filterResponseResult(details)?.cancel === true }
}

// The shared substitution supplies every other Electron member, so a module
// that binds this registration still finds app paths, safe storage, and the
// handler record. The browser surface below is what the manager drives.
const fakeElectron = {
  ...sharedElectron,
  app: {
    ...sharedElectron.app,
    on: (event: string, listener: FakeListener) => addListener(fakeAppListeners, event, listener),
    removeListener: (event: string, listener: FakeListener) => removeListener(fakeAppListeners, event, listener),
  },
  BrowserWindow: {
    getAllWindows: () => state.windows,
    getFocusedWindow: () => state.focused ?? null,
    fromWebContents: (contents: unknown) => state.windows.find((window) => window.webContents === contents) ?? null,
  },
  session: {
    fromPartition: () => fakeSession,
  },
  webContents: { fromId: (id: number) => state.contents.get(id) },
}

plugin({
  name: "embedded-browser-electron",
  setup(build) {
    build.module("electron", () => ({ exports: { ...fakeElectron, default: fakeElectron }, loader: "object" }))
  },
})

const { EmbeddedBrowserManager, BROWSER_PANEL_COMMAND } = await import("./browser-view")

type OpenCommand = { kind: "open"; requestId: string; url: string }

function openCommands(window: FakeWindow): OpenCommand[] {
  return window.webContents.sent
    .filter((entry) => entry.channel === BROWSER_PANEL_COMMAND)
    .map((entry) => entry.message as OpenCommand)
    .filter((command) => command.kind === "open")
}

function registerGuest(manager: InstanceType<typeof EmbeddedBrowserManager>, owner: FakeContents, requestId: string) {
  const guest = createContents({ type: "webview" })
  const registered = manager.register(owner as never, {
    webContentsId: guest.id,
    requestId,
    url: guest.url,
  })
  return { guest, registered }
}

function manager(options: { hostLoadWaitMs?: number; pausedRequestTimeoutMs?: number } = {}) {
  return new EmbeddedBrowserManager({
    openTimeoutMs: 300,
    openRetryMs: 20,
    hostWindowWaitMs: 80,
    hostLoadWaitMs: options.hostLoadWaitMs ?? 80,
    pausedRequestTimeoutMs: options.pausedRequestTimeoutMs ?? 15000,
  })
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("The test condition was not met in time.")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

beforeEach(() => {
  state.windows.length = 0
  state.focused = undefined
  state.contents.clear()
  state.nextId = 1
  fakeAppListeners.clear()
  fakeRequestFilters.clear()
})

describe("embedded browser manager open handshake", () => {
  test("retries an open command sent before the renderer was ready", async () => {
    const browser = manager()
    const host = createWindow()
    const opening = browser.open("https://example.test/retry")

    await waitUntil(() => openCommands(host).length >= 2)
    const commands = openCommands(host)
    expect(new Set(commands.map((command) => command.requestId)).size).toBe(1)
    expect(commands.every((command) => command.url === "https://example.test/retry")).toBe(true)

    const { guest } = registerGuest(browser, host.webContents, commands[0]!.requestId)
    await expect(opening).resolves.toMatchObject({ id: guest.id, url: guest.url })
    expect(browser.list()).toHaveLength(1)

    const resolved = openCommands(host).length
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(openCommands(host)).toHaveLength(resolved)
  })

  test("an open after a failed open recovers without leaked retries", async () => {
    const browser = manager()
    const host = createWindow()

    await expect(browser.open("https://first.test/")).rejects.toMatchObject({ code: "open_timeout" })
    const settled = openCommands(host).length
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(openCommands(host)).toHaveLength(settled)
    expect(browser.list()).toHaveLength(0)

    const opening = browser.open("https://second.test/")
    await waitUntil(() => openCommands(host).length > settled)
    const request = openCommands(host).at(-1)!
    const { guest } = registerGuest(browser, host.webContents, request.requestId)
    await expect(opening).resolves.toMatchObject({ id: guest.id })
    expect(browser.list()).toHaveLength(1)
  })

  test("waits briefly for a host window during early startup", async () => {
    const browser = manager()
    const opening = browser.open("https://example.test/early")
    const host = createWindow()

    await waitUntil(() => openCommands(host).length >= 1)
    const { guest } = registerGuest(browser, host.webContents, openCommands(host)[0]!.requestId)
    await expect(opening).resolves.toMatchObject({ id: guest.id })
  })

  test("waits for the host renderer to finish loading before sending", async () => {
    const browser = manager({ hostLoadWaitMs: 5000 })
    const host = createWindow()
    host.webContents.loading = true
    const opening = browser.open("https://example.test/load")

    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(openCommands(host)).toHaveLength(0)
    host.webContents.loading = false
    host.webContents.emit("did-finish-load")

    await waitUntil(() => openCommands(host).length >= 1)
    const { guest } = registerGuest(browser, host.webContents, openCommands(host)[0]!.requestId)
    await expect(opening).resolves.toMatchObject({ id: guest.id })
  })

  test("a synchronous send failure rejects and the next open recovers", async () => {
    const browser = manager()
    const host = createWindow()
    host.webContents.failSend = true

    await expect(browser.open("https://example.test/broken")).rejects.toMatchObject({ code: "not_available" })
    host.webContents.failSend = false

    const opening = browser.open("https://example.test/next")
    await waitUntil(() => openCommands(host).length >= 1)
    const { guest } = registerGuest(browser, host.webContents, openCommands(host)[0]!.requestId)
    await expect(opening).resolves.toMatchObject({ id: guest.id })
  })

  test("a host window that closes rejects the pending open", async () => {
    const browser = manager()
    const host = createWindow()
    const opening = browser.open("https://example.test/closed")

    host.close()
    await expect(opening).rejects.toMatchObject({ code: "not_available" })
    expect(browser.list()).toHaveLength(0)
  })

  test("a duplicate tab from a retried open is closed", async () => {
    const browser = manager()
    const host = createWindow()
    const opening = browser.open("https://example.test/duplicate")

    await waitUntil(() => openCommands(host).length >= 1)
    const requestId = openCommands(host)[0]!.requestId
    const first = registerGuest(browser, host.webContents, requestId)
    await opening

    const second = registerGuest(browser, host.webContents, requestId)
    expect(second.registered).toBeDefined()
    expect(browser.list().map((page) => page.id)).toEqual([first.guest.id])
    const last = host.webContents.sent.at(-1)!
    expect(last.message).toMatchObject({ kind: "close", tabId: second.guest.id })
  })
})

type Dispatchable = {
  dispatch(method: string, params: Record<string, unknown>, tabId?: number): Promise<unknown>
}

function dispatch(
  browser: InstanceType<typeof EmbeddedBrowserManager>,
  method: string,
  params: Record<string, unknown> = {},
  tabId?: number,
): Promise<unknown> {
  return (browser as unknown as Dispatchable).dispatch(method, params, tabId)
}

function captureBroadcasts(browser: InstanceType<typeof EmbeddedBrowserManager>): unknown[] {
  const messages: unknown[] = []
  ;(browser as unknown as { bridge: unknown }).bridge = {
    broadcast: (message: unknown) => messages.push(message),
    close: () => Promise.resolve(),
  }
  return messages
}

describe("embedded browser page debugger and dialogs", () => {
  test("attaches once per page and enables the Page domain exactly once", async () => {
    const browser = manager()
    const host = createWindow()
    const { guest } = registerGuest(browser, host.webContents, "req-enable")

    expect(guest.debugger.attached).toBe(true)
    expect(guest.debugger.enabled).toBe(1)

    await dispatch(browser, "Runtime.evaluate", { expression: "1" }, guest.id)
    await dispatch(browser, "Runtime.evaluate", { expression: "2" }, guest.id)
    expect(guest.debugger.enabled).toBe(1)
    expect(guest.debugger.commands.map((command) => command.method)).toEqual([
      "Page.enable",
      "Page.setInterceptFileChooserDialog",
      "Runtime.evaluate",
      "Runtime.evaluate",
    ])
  })

  test("dialog events are tracked and broadcast with a string tab id", async () => {
    const browser = manager()
    const host = createWindow()
    const broadcasts = captureBroadcasts(browser)
    const { guest } = registerGuest(browser, host.webContents, "req-dialog")

    guest.debugger.emit("message", undefined, "Page.javascriptDialogOpening", {
      type: "confirm",
      message: "Leave?",
      hasBrowserHandler: false,
    })
    expect(await dispatch(browser, "Omnia.currentDialog", {}, guest.id)).toEqual({
      dialog: { type: "confirm", message: "Leave?", hasBrowserHandler: false },
    })
    expect(broadcasts).toContainEqual({
      method: "Page.javascriptDialogOpening",
      params: { type: "confirm", message: "Leave?", hasBrowserHandler: false },
      tabId: String(guest.id),
    })

    guest.debugger.emit("message", undefined, "Page.javascriptDialogClosed", { result: false })
    expect(await dispatch(browser, "Omnia.currentDialog", {}, guest.id)).toEqual({ dialog: null })
  })

  test("handleDialog answers the pending dialog and rejects stale or mismatched answers", async () => {
    const browser = manager()
    const host = createWindow()
    const { guest } = registerGuest(browser, host.webContents, "req-answer")

    await expect(dispatch(browser, "Omnia.handleDialog", { accept: true }, guest.id)).rejects.toMatchObject({
      code: "dialog_not_open",
    })

    guest.debugger.emit("message", undefined, "Page.javascriptDialogOpening", {
      type: "prompt",
      message: "Name?",
      defaultPrompt: "Ada",
    })
    await expect(
      dispatch(browser, "Omnia.handleDialog", { accept: true, expectedType: "confirm" }, guest.id),
    ).rejects.toMatchObject({ code: "dialog_mismatch" })
    await expect(
      dispatch(browser, "Omnia.handleDialog", { accept: true, expectedMessage: "Other" }, guest.id),
    ).rejects.toMatchObject({ code: "dialog_mismatch" })

    await expect(
      dispatch(
        browser,
        "Omnia.handleDialog",
        { accept: true, promptText: "Ada", expectedType: "prompt", expectedMessage: "Name?" },
        guest.id,
      ),
    ).resolves.toEqual({ handled: true })
    expect(guest.debugger.commands.at(-1)).toEqual({
      method: "Page.handleJavaScriptDialog",
      params: { accept: true, promptText: "Ada" },
    })
    expect(await dispatch(browser, "Omnia.currentDialog", {}, guest.id)).toEqual({ dialog: null })
  })

  test("will-prevent-unload is forced through and recorded as a beforeunload dialog", async () => {
    const browser = manager()
    const host = createWindow()
    const broadcasts = captureBroadcasts(browser)
    const { guest } = registerGuest(browser, host.webContents, "req-unload")

    let prevented = false
    guest.emit("will-prevent-unload", {
      preventDefault: () => {
        prevented = true
      },
    })
    expect(prevented).toBe(true)
    expect(await dispatch(browser, "Omnia.currentDialog", {}, guest.id)).toMatchObject({
      dialog: { type: "beforeunload" },
    })
    expect(broadcasts).toContainEqual(
      expect.objectContaining({ method: "Page.javascriptDialogOpening", tabId: String(guest.id) }),
    )

    guest.emit("did-navigate", undefined, "https://example.test/next", 200, "OK")
    expect(await dispatch(browser, "Omnia.currentDialog", {}, guest.id)).toEqual({ dialog: null })
  })

  test("reload, back, and forward use WebContents APIs and never reload the host window", async () => {
    const browser = manager()
    const host = createWindow()
    const { guest } = registerGuest(browser, host.webContents, "req-nav")

    await expect(dispatch(browser, "Omnia.back", {}, guest.id)).rejects.toMatchObject({ code: "no_history" })
    await expect(dispatch(browser, "Omnia.forward", {}, guest.id)).rejects.toMatchObject({ code: "no_history" })

    guest.navigationHistory.backAvailable = true
    guest.navigationHistory.forwardAvailable = true
    await expect(dispatch(browser, "Omnia.back", {}, guest.id)).resolves.toEqual({
      url: guest.url,
      navigated: true,
    })
    await expect(dispatch(browser, "Omnia.forward", {}, guest.id)).resolves.toEqual({
      url: guest.url,
      navigated: true,
    })
    expect(guest.navigationHistory.moves).toEqual(["back", "forward"])

    await expect(dispatch(browser, "Omnia.reload", {}, guest.id)).resolves.toEqual({
      url: guest.url,
      reloaded: true,
    })
    await dispatch(browser, "Omnia.reload", { ignoreCache: true }, guest.id)
    expect(guest.reloads).toEqual(["reload", "reloadIgnoringCache"])
    expect(host.webContents.reloads).toEqual([])
  })

  test("destroy removes the web-contents-created listener and watch re-adds it", async () => {
    const browser = manager()
    browser.watch()
    expect(fakeAppListeners.get("web-contents-created")?.size).toBe(1)

    await browser.destroy()
    expect(fakeAppListeners.get("web-contents-created")?.size ?? 0).toBe(0)

    browser.watch()
    expect(fakeAppListeners.get("web-contents-created")?.size).toBe(1)
    await browser.destroy()
  })

  test("guest navigation events are forwarded with a string tab id", async () => {
    const browser = manager()
    const host = createWindow()
    const broadcasts = captureBroadcasts(browser)
    const { guest } = registerGuest(browser, host.webContents, "req-events")

    guest.emit("did-navigate", undefined, "https://example.test/next", 200, "OK")
    guest.emit("render-process-gone", undefined, { reason: "crashed", exitCode: 1 })
    guest.emit("unresponsive")

    expect(broadcasts).toContainEqual({
      method: "Omnia.did-navigate",
      params: { url: "https://example.test/next", httpResponseCode: 200, httpStatusText: "OK" },
      tabId: String(guest.id),
    })
    expect(broadcasts).toContainEqual({
      method: "Omnia.render-process-gone",
      params: { reason: "crashed", exitCode: 1 },
      tabId: String(guest.id),
    })
    expect(broadcasts).toContainEqual({ method: "Omnia.unresponsive", params: {}, tabId: String(guest.id) })
  })

  test("tracks browser downloads and reports completed files", async () => {
    const browser = manager()
    browser.watch()
    const downloadsDir = mkdtempSync(join(tmpdir(), "omnia-browser-downloads-"))
    const previous = process.env.OMNIA_BROWSER_DOWNLOAD_DIR
    process.env.OMNIA_BROWSER_DOWNLOAD_DIR = downloadsDir
    try {
      const itemListeners = new Map<string, Set<FakeListener>>()
      const item = {
        path: "",
        getFilename: () => "some-file.txt",
        setSavePath: (value: string) => {
          item.path = value
        },
        getURL: () => "https://example.test/some-file.txt",
        getReceivedBytes: () => 123,
        getTotalBytes: () => 123,
        getMimeType: () => "text/plain",
        on: (event: string, listener: FakeListener) => addListener(itemListeners, event, listener),
        once: (event: string, listener: FakeListener) => addListener(itemListeners, event, listener),
      }
      for (const listener of fakeSessionListeners.get("will-download") ?? []) listener({}, item)
      emit(itemListeners, "done", {}, "completed")

      const result = (await dispatch(browser, "Omnia.downloads", {})) as {
        downloads: Array<{ filename: string; state: string; path: string; receivedBytes: number }>
      }
      expect(result.downloads).toHaveLength(1)
      expect(result.downloads[0]?.filename).toBe("some-file.txt")
      expect(result.downloads[0]?.state).toBe("completed")
      expect(result.downloads[0]?.receivedBytes).toBe(123)
      expect(result.downloads[0]?.path).toContain("some-file.txt")
      expect(result.downloads[0]?.path.startsWith(downloadsDir)).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.OMNIA_BROWSER_DOWNLOAD_DIR
      else process.env.OMNIA_BROWSER_DOWNLOAD_DIR = previous
      rmSync(downloadsDir, { recursive: true, force: true })
    }
    await browser.destroy()
  })

  test("holds an HTTP auth challenge until Omnia.auth answers it", async () => {
    const browser = manager()
    const host = createWindow()
    const broadcasts = captureBroadcasts(browser)
    const { guest } = registerGuest(browser, host.webContents, "req-auth")

    let answered: [string, string] | undefined
    let prevented = false
    guest.emit("login", {
      preventDefault: () => {
        prevented = true
      },
      url: "https://example.test/private",
    }, { url: "https://example.test/private" }, { host: "example.test", realm: "Restricted", isProxy: false }, (username: string, password: string) => {
      answered = [username, password]
    })

    expect(prevented).toBe(true)
    expect(answered).toBeUndefined()
    expect(broadcasts).toContainEqual(
      expect.objectContaining({
        method: "Omnia.authRequired",
        params: expect.objectContaining({ host: "example.test", realm: "Restricted" }),
        tabId: String(guest.id),
      }),
    )
    await expect(dispatch(browser, "Omnia.auth", { username: "tomsmith", password: "secret" }, guest.id)).resolves.toEqual(
      { answered: true },
    )
    expect(answered).toEqual(["tomsmith", "secret"])
    await expect(dispatch(browser, "Omnia.auth", { username: "a", password: "b" }, guest.id)).rejects.toMatchObject({
      code: "no_auth_challenge",
    })
    await browser.destroy()
  })

  test("installs no app-level login listener and answers a duplicate guest challenge", async () => {
    const browser = manager()
    const host = createWindow()
    const { guest } = registerGuest(browser, host.webContents, "req-app-auth")
    browser.watch()
    // Only the per-guest listener answers challenges; an app-level listener with
    // preventDefault would drain every app and proxy prompt into this manager.
    expect(fakeAppListeners.get("login")?.size ?? 0).toBe(0)

    const answered: Array<[string | undefined, string | undefined]> = []
    const details = { url: guest.url }
    const authInfo = { host: "example.test", realm: "Restricted", isProxy: false }
    guest.emit("login", { preventDefault: () => {} }, details, authInfo, (username?: string, password?: string) => {
      answered.push([username, password])
    })
    // The duplicate the page raises after a rejected credential is answered with
    // empty credentials instead of being dropped: a callback that is never
    // invoked leaves the load pending forever.
    guest.emit("login", { preventDefault: () => {} }, details, authInfo, (username?: string, password?: string) => {
      answered.push([username, password])
    })

    await expect(dispatch(browser, "Omnia.auth", { username: "u", password: "p" }, guest.id)).resolves.toEqual({
      answered: true,
    })
    expect(answered).toEqual([
      [undefined, undefined],
      ["u", "p"],
    ])
    await expect(dispatch(browser, "Omnia.auth", { username: "u", password: "p" }, guest.id)).rejects.toMatchObject({
      code: "no_auth_challenge",
    })
    await browser.destroy()
  })

  test("gates main-frame, subframe, and redirect navigations on the url policy", async () => {
    const browser = manager()
    browser.watch()
    const host = createWindow()
    const guest = createContents({ type: "webview" })
    for (const listener of fakeAppListeners.get("web-contents-created") ?? []) listener({}, guest)

    const prevented: string[] = []
    const attempt = (event: string, url: string) => {
      guest.emit(event, { preventDefault: () => void prevented.push(`${event}:${url}`), url, isMainFrame: false })
    }
    attempt("will-navigate", "http://127.0.0.1:8080/admin")
    attempt("will-navigate", "https://allowed.test/page")
    // The pdf.js reader is a local renderer page, not web content; routing a
    // PDF to it must not be blocked by the page allowlist.
    attempt("will-navigate", "oc://renderer/pdf.html?url=https%3A%2F%2Fallowed.test%2Finvoice.pdf")
    attempt("will-frame-navigate", "http://169.254.169.254/latest/meta-data")
    attempt("will-frame-navigate", "https://allowed.test/frame")
    attempt("will-redirect", "http://[::1]:9000/")
    attempt("will-redirect", "https://allowed.test/next")

    expect(prevented).toEqual([
      "will-navigate:http://127.0.0.1:8080/admin",
      "will-frame-navigate:http://169.254.169.254/latest/meta-data",
      "will-redirect:http://[::1]:9000/",
    ])
    await browser.destroy()
  })

  test("forces the guest partition and filters private requests out of the partition", async () => {
    const browser = manager()
    const host = createWindow()
    for (const listener of fakeAppListeners.get("web-contents-created") ?? []) listener({}, host.webContents)
    browser.watch()

    const preferences: Record<string, unknown> = { sandbox: false }
    host.webContents.emit("will-attach-webview", { preventDefault: () => undefined }, preferences, {
      src: "https://allowed.test/start",
    })
    expect(preferences.partition).toBe("persist:omnia-browser")
    expect(preferences.allowRunningInsecureContent).toBe(false)
    // Every guest carries the PDF preload, which exposes nothing unless its own
    // document is the reader page.
    expect(String(preferences.preload).replace(/\\/g, "/").endsWith("/preload/pdf.js")).toBe(true)
    // The guest plugin flag is what lets Chromium's PDF viewer render a PDF
    // instead of leaving the webview blank.
    expect(preferences.plugins).toBe(true)

    expect(filterRequest({ url: "https://allowed.test/page.png", resourceType: "image" })).toEqual({
      cancelled: false,
    })
    // The PDF viewer is a chrome-extension page; its local resources are not
    // network egress and must survive the partition filter.
    expect(
      filterRequest({
        url: "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html?streaming",
        resourceType: "other",
      }),
    ).toEqual({ cancelled: false })
    expect(filterRequest({ url: "http://127.0.0.1:8080/admin", resourceType: "xmlhttprequest" })).toEqual({
      cancelled: true,
    })
    expect(filterRequest({ url: "http://169.254.169.254/latest/meta-data", resourceType: "xhr" })).toEqual({
      cancelled: true,
    })
    // A public 3xx that points at loopback is cancelled on the redirect hop.
    expect(
      filterResponse({
        url: "https://allowed.test/go",
        statusLine: "302 Found",
        responseHeaders: { Location: "http://127.0.0.1:8080/admin" },
      }),
    ).toEqual({ cancelled: true })
    expect(
      filterResponse({
        url: "https://allowed.test/go",
        statusLine: "302 Found",
        responseHeaders: { location: "/next" },
      }),
    ).toEqual({ cancelled: false })
    await browser.destroy()
  })

  test("normalizes attachment PDFs into inline documents for the embedded viewer", async () => {
    const browser = manager()
    browser.watch()

    const php = filterResponseResult({
      url: "https://allowed.test/invoice.php?id=7",
      resourceType: "mainFrame",
      responseHeaders: {
        "Content-Type": ["application/pdf"],
        "Content-Disposition": ['attachment; filename="invoice.pdf"'],
        "Cache-Control": ["no-store"],
      },
    })
    expect(php?.cancel).toBeUndefined()
    expect(php?.responseHeaders).toEqual({
      "Cache-Control": ["no-store"],
      "Content-Type": "application/pdf",
      "Content-Disposition": 'inline; filename="invoice.pdf"',
    })

    // PHP endpoints often label the generated file as octet-stream and only
    // reveal its type in the download filename.
    const octet = filterResponseResult({
      url: "https://allowed.test/download.php?id=9",
      resourceType: "mainFrame",
      responseHeaders: {
        "content-type": ["application/octet-stream"],
        "content-disposition": ["attachment; filename=report.pdf"],
      },
    })
    expect(octet?.responseHeaders).toMatchObject({
      "Content-Type": "application/pdf",
      "Content-Disposition": "inline; filename=report.pdf",
    })

    // A normal HTML endpoint and a PDF subresource must keep their headers.
    expect(
      filterResponseResult({
        url: "https://allowed.test/invoice.php",
        resourceType: "mainFrame",
        responseHeaders: { "content-type": ["text/html"] },
      })?.responseHeaders,
    ).toBeUndefined()
    expect(
      filterResponseResult({
        url: "https://allowed.test/manual.pdf",
        resourceType: "subFrame",
        responseHeaders: { "content-type": ["application/pdf"] },
      })?.responseHeaders,
    ).toBeUndefined()

    await browser.destroy()
  })

  test("routes a top-level PDF response to the local pdf.js reader", async () => {
    const browser = manager()
    const host = createWindow()
    browser.watch()
    const { guest } = registerGuest(browser, host.webContents, "req-pdf-reader")

    const source = "https://allowed.test/invoice.php?id=7"
    filterResponseResult({
      url: source,
      resourceType: "mainFrame",
      webContentsId: guest.id,
      responseHeaders: {
        "Content-Type": ["application/pdf"],
        "Content-Disposition": ['attachment; filename="invoice.pdf"'],
      },
    })

    await waitUntil(() => guest.loads.length > 0)
    const reader = guest.loads[0]!
    expect(reader.startsWith("oc://renderer/pdf.html?url=")).toBe(true)
    expect(new URL(reader).searchParams.get("url")).toBe(source)
    await browser.destroy()
  })

  test("refuses uploads outside the downloads and temporary roots", async () => {
    const browser = manager()
    browser.watch()
    const host = createWindow()
    const { guest } = registerGuest(browser, host.webContents, "req-upload")
    guest.debugger.emit("message", undefined, "Page.fileChooserOpened", { backendNodeId: 7 })

    const home = join(homedir(), ".ssh", "id_rsa")
    await expect(dispatch(browser, "Omnia.upload", { files: [home] }, guest.id)).rejects.toMatchObject({
      code: "path_blocked",
    })
    await expect(dispatch(browser, "Omnia.upload", { files: ["/etc/passwd"] }, guest.id)).rejects.toMatchObject({
      code: "path_blocked",
    })
    // A directory that stats is still not a file the guest may read.
    await expect(dispatch(browser, "Omnia.upload", { files: [tmpdir()] }, guest.id)).rejects.toMatchObject({
      code: "invalid_params",
    })
    expect(guest.debugger.callsOf?.("DOM.setFileInputFiles")).toBeUndefined()
    await browser.destroy()
  })

  test("saveImage writes only base64 image data URLs inside the sandbox roots", async () => {
    const browser = manager()
    browser.watch()
    const host = createWindow()
    const { guest } = registerGuest(browser, host.webContents, "req-image")
    const outside = join(tmpdir(), `omnia-escape-${Date.now()}.png`)
    await expect(
      dispatch(
        browser,
        "Omnia.saveImage",
        { url: "data:image/png;base64,AAAA", path: "/etc/omnia-escape.png" },
        guest.id,
      ),
    ).rejects.toMatchObject({ code: "path_blocked" })
    await expect(
      dispatch(
        browser,
        "Omnia.saveImage",
        { url: "data:text/html;base64,PHNjcmlwdD4=", path: join(tmpdir(), "page.png") },
        guest.id,
      ),
    ).rejects.toMatchObject({ code: "invalid_url" })

    const target = join(tmpdir(), `omnia-image-${Date.now()}.png`)
    const payload = Buffer.from("image-bytes")
    const result = (await dispatch(
      browser,
      "Omnia.saveImage",
      { url: `data:image/png;base64,${payload.toString("base64")}`, path: target },
      guest.id,
    )) as { saved: boolean; path: string; bytes: number }
    expect(result.saved).toBe(true)
    expect(result.bytes).toBe(payload.length)
    expect(readFileSync(result.path).equals(payload)).toBe(true)
    // A second save never overwrites the first file.
    const again = (await dispatch(
      browser,
      "Omnia.saveImage",
      { url: `data:image/png;base64,${payload.toString("base64")}`, path: target },
      guest.id,
    )) as { path: string }
    expect(again.path).not.toBe(result.path)
    rmSync(outside, { force: true })
    rmSync(result.path, { force: true })
    rmSync(again.path, { force: true })
    await browser.destroy()
  })

  test("a closed tab never leaves a pending dialog behind", async () => {
    const browser = manager()
    const host = createWindow()
    const { guest } = registerGuest(browser, host.webContents, "req-close-dialog")

    guest.debugger.emit("message", undefined, "Page.javascriptDialogOpening", { type: "alert", message: "Stay?" })
    expect(await dispatch(browser, "Omnia.currentDialog", {}, guest.id)).toMatchObject({ dialog: { type: "alert" } })

    browser.close(guest.id)
    // The dialog went with the tab, so a fresh tab answers normally instead of
    // every later action failing as dialog_open.
    expect(browser.list()).toHaveLength(0)
    const replacement = registerGuest(browser, host.webContents, "req-close-dialog-2")
    await expect(
      dispatch(browser, "Omnia.handleDialog", { accept: true }, replacement.guest.id),
    ).rejects.toMatchObject({ code: "dialog_not_open" })
    await browser.destroy()
  })
})

describe("embedded browser fetch interception cleanup", () => {
  test("disarms interception and settles paused requests under the url policy", async () => {
    const browser = manager()
    const host = createWindow()
    const { guest } = registerGuest(browser, host.webContents, "req-fetch")

    await dispatch(browser, "Fetch.enable", {}, guest.id)
    guest.debugger.emit("message", undefined, "Fetch.requestPaused", {
      requestId: "r-1",
      request: { url: "https://example.test/next.png" },
    })
    guest.debugger.emit("message", undefined, "Fetch.requestPaused", {
      requestId: "r-2",
      request: { url: "http://127.0.0.1:8080/admin" },
    })

    // Once the controller socket is gone nothing answers the pauses, so the
    // shutdown path continues the public request, fails the private one, and
    // turns interception off instead of hanging the page.
    ;(browser as unknown as { releaseInterceptions(): void }).releaseInterceptions()
    expect(guest.debugger.commands.map((command) => command.method)).toEqual(
      expect.arrayContaining(["Fetch.continueRequest", "Fetch.failRequest", "Fetch.disable"]),
    )
    const continued = guest.debugger.commands.find((command) => command.method === "Fetch.continueRequest")
    const failed = guest.debugger.commands.find((command) => command.method === "Fetch.failRequest")
    expect(continued?.params).toEqual({ requestId: "r-1" })
    expect(failed?.params).toEqual({ requestId: "r-2", errorReason: "BlockedByClient" })

    await browser.destroy()
  })
})

describe("embedded browser target recovery", () => {
  test("a read that dies with the target is replayed once on a fresh session", async () => {
    const browser = manager()
    const host = createWindow()
    const { guest } = registerGuest(browser, host.webContents, "req-replay")
    expect(guest.debugger.enabled).toBe(1)

    guest.debugger.failures.push({ method: "Page.getFrameTree", error: new Error("target closed while handling command") })

    await expect(dispatch(browser, "Page.getFrameTree", {}, guest.id)).resolves.toEqual({})
    // The dead session was dropped and the command replayed against a new one,
    // so the tab keeps working instead of failing every later command.
    expect(guest.debugger.detaches).toBe(1)
    expect(guest.debugger.attached).toBe(true)
    expect(guest.debugger.enabled).toBe(2)
    expect(guest.debugger.commands.map((command) => command.method)).toEqual([
      "Page.enable",
      "Page.setInterceptFileChooserDialog",
      "Page.getFrameTree",
      "Page.enable",
      "Page.setInterceptFileChooserDialog",
      "Page.getFrameTree",
    ])

    // The recovered session serves the next command without another reset.
    await expect(dispatch(browser, "Runtime.evaluate", { expression: "2" }, guest.id)).resolves.toEqual({})
    expect(guest.debugger.detaches).toBe(1)
  })

  test("a command a page can feel is never replayed and reports a retryable failure", async () => {
    const browser = manager()
    const host = createWindow()
    const { guest } = registerGuest(browser, host.webContents, "req-no-replay")

    guest.debugger.failures.push({ method: "Input.dispatchMouseEvent", error: new Error("target closed while handling command") })
    await expect(
      dispatch(browser, "Input.dispatchMouseEvent", { type: "mousePressed", x: 1, y: 2 }, guest.id),
    ).rejects.toMatchObject({ code: "target_closed" })
    expect(guest.debugger.detaches).toBe(1)
    expect(guest.debugger.commands.map((command) => command.method)).toEqual([
      "Page.enable",
      "Page.setInterceptFileChooserDialog",
      "Input.dispatchMouseEvent",
    ])

    // The reset still happened, so retrying the action reaches a live page.
    await expect(dispatch(browser, "Runtime.evaluate", { expression: "1" }, guest.id)).resolves.toEqual({})
    expect(guest.debugger.attached).toBe(true)
    expect(guest.debugger.enabled).toBe(2)
  })

  test("a replay that also dies with the target reports the retryable failure", async () => {
    const browser = manager()
    const host = createWindow()
    const { guest } = registerGuest(browser, host.webContents, "req-replay-twice")

    guest.debugger.failures.push(
      { method: "Page.getFrameTree", error: new Error("target closed while handling command") },
      { method: "Page.getFrameTree", error: new Error("target closed while handling command") },
    )

    await expect(dispatch(browser, "Page.getFrameTree", {}, guest.id)).rejects.toMatchObject({
      code: "target_closed",
    })
    // Both attempts saw a dead target, and each one dropped its session.
    expect(guest.debugger.detaches).toBe(2)
  })

  test("JavaScript is never replayed because it may have submitted a form", async () => {
    const browser = manager()
    const host = createWindow()
    const broadcasts = captureBroadcasts(browser)
    const { guest } = registerGuest(browser, host.webContents, "req-script")
    guest.debugger.failures.push({ method: "Runtime.evaluate", error: new Error("target closed while handling command") })

    await expect(dispatch(browser, "Runtime.evaluate", { expression: "submitForm()" }, guest.id)).rejects.toMatchObject({
      code: "target_closed",
    })
    expect(guest.debugger.commands.filter((command) => command.method === "Runtime.evaluate")).toHaveLength(1)
    expect(broadcasts).toContainEqual({ method: "Inspector.detached", params: { reason: "target_closed" }, tabId: String(guest.id) })
    await browser.destroy()
  })

  test("an unrelated page failure keeps its own error", async () => {
    const browser = manager()
    const host = createWindow()
    const { guest } = registerGuest(browser, host.webContents, "req-other-error")

    guest.debugger.failures.push({ method: "Runtime.evaluate", error: new Error("Some other protocol failure") })
    await expect(dispatch(browser, "Runtime.evaluate", { expression: "1" }, guest.id)).rejects.toThrow(
      "Some other protocol failure",
    )
    expect(guest.debugger.detaches).toBe(0)
  })
})

describe("embedded browser request interception release", () => {
  test("a disconnected controller releases the requests it left paused", async () => {
    const browser = manager()
    const host = createWindow()
    const { guest } = registerGuest(browser, host.webContents, "req-paused-leave")
    const bridge = await browser.start()
    const socket = new WebSocket(`${bridge.endpoint}?token=${bridge.token}`)
    await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }))

    guest.debugger.emit("message", undefined, "Fetch.requestPaused", {
      requestId: "paused-1",
      request: { url: "https://example.test/next" },
    })
    const paused = guest.debugger.commands.filter((command) => command.method === "Fetch.continueRequest")
    expect(paused).toHaveLength(0)

    socket.close()
    await waitUntil(() => guest.debugger.commands.some((command) => command.method === "Fetch.disable"))
    // Nothing can answer a paused request without a controller, so the far end
    // is released instead of leaving the tab loading forever.
    expect(guest.debugger.commands).toContainEqual({ method: "Fetch.continueRequest", params: { requestId: "paused-1" } })
    await browser.destroy()
  })

  test("a paused request the controller never answers is released by the watchdog", async () => {
    const browser = manager({ pausedRequestTimeoutMs: 20 })
    const host = createWindow()
    const { guest } = registerGuest(browser, host.webContents, "req-paused-watchdog")

    guest.debugger.emit("message", undefined, "Fetch.requestPaused", {
      requestId: "paused-2",
      request: { url: "https://example.test/slow" },
    })
    await waitUntil(() => guest.debugger.commands.some((command) => command.method === "Fetch.continueRequest"))
    expect(guest.debugger.commands).toContainEqual({ method: "Fetch.continueRequest", params: { requestId: "paused-2" } })
    await browser.destroy()
  })

  test("a request the controller answered is never released again", async () => {
    const browser = manager({ pausedRequestTimeoutMs: 20 })
    const host = createWindow()
    const { guest } = registerGuest(browser, host.webContents, "req-paused-answered")

    guest.debugger.emit("message", undefined, "Fetch.requestPaused", {
      requestId: "paused-3",
      request: { url: "https://example.test/answer" },
    })
    await dispatch(browser, "Fetch.continueRequest", { requestId: "paused-3" }, guest.id)
    await new Promise((resolve) => setTimeout(resolve, 60))

    const continues = guest.debugger.commands.filter((command) => command.method === "Fetch.continueRequest")
    // Exactly the controller's own reply: the watchdog must not answer a
    // second time for a request that is already on its way.
    expect(continues).toHaveLength(1)
    await browser.destroy()
  })
})
