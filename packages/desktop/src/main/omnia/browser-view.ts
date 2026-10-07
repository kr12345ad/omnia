// Embedded browser pages for the Omnia desktop app. The renderer hosts a
// <webview> per browser tab; this module tracks those guest pages, exposes a
// token-authenticated localhost WebSocket CDP bridge in front of the active
// page debugger, and lets the Omnia Server drive them like the external
// Firefox runtime.

import { randomBytes, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path"
import { app, BrowserWindow, ipcMain, session, webContents } from "electron"
import type { IpcMainInvokeEvent, WebContents } from "electron"
import { imageDownloadsDir, writeImageFile } from "@opencode-ai/omnia/browser/image-file"
import { isNavigableBrowserUrl } from "@opencode-ai/omnia/browser/url-policy"
import { startWebSocketBridge } from "./ws-bridge"
import type { WebSocketBridge, WebSocketBridgeClient } from "./ws-bridge"

export const BROWSER_PANEL_COMMAND = "browser-panel-command"

// Guest pages are untrusted web content, so they live in their own persistent
// partition instead of the app session: the partition owns the permission
// handlers, the request filter, and the download tracking, and the app's own
// cookies and credentials are never reachable from a page.
const BROWSER_PARTITION = "persist:omnia-browser"
// An image body written to disk is bounded on both sides: the page-script path
// caps the in-page fetch and the bridge caps a data: URL it is handed.
const MAX_IMAGE_BYTES = 32 * 1024 * 1024

// The host renderer mounts its browser panel asynchronously after a cold start
// and the panel only listens for commands once its scripts run. An open command
// must therefore survive a renderer that is not listening yet: wait for the
// host window to load, then keep re-sending the same open command until the
// matching <webview> registers.
const OPEN_TIMEOUT_MS = 15000
const OPEN_RETRY_MS = 2000
const HOST_WINDOW_WAIT_MS = 5000
const HOST_LOAD_WAIT_MS = 5000
const MAX_TRACKED_DOWNLOADS = 100

export interface BrowserPanelTabInfo {
  readonly id: number
  readonly url: string
  readonly title?: string
  readonly active?: boolean
  readonly loading?: boolean
}

export interface BrowserPanelDialog {
  readonly type: string
  readonly message: string
  readonly defaultPrompt?: string
  readonly frameUrl?: string
  readonly hasBrowserHandler?: boolean
}

export interface BrowserDownload {
  readonly id: string
  readonly url: string
  readonly filename: string
  readonly path: string
  readonly state: "progressing" | "completed" | "cancelled" | "interrupted"
  readonly receivedBytes: number
  readonly totalBytes: number
  readonly startedAt: number
  readonly finishedAt?: number
  readonly mimeType?: string
  readonly error?: string
}

interface TrackedDownload {
  readonly id: string
  readonly url: string
  readonly filename: string
  readonly path: string
  state: BrowserDownload["state"]
  receivedBytes: number
  totalBytes: number
  readonly startedAt: number
  finishedAt: number | undefined
  readonly mimeType: string | undefined
  error: string | undefined
}

interface PendingAuthChallenge {
  readonly url: string
  readonly host: string
  readonly realm: string
  readonly isProxy: boolean
  readonly callback: (username?: string, password?: string) => void
}

export type BrowserPanelCommand =
  | { readonly kind: "open"; readonly requestId: string; readonly url: string }
  | { readonly kind: "activate"; readonly tabId: number }
  | { readonly kind: "close"; readonly tabId: number }
  | {
      readonly kind: "dialog"
      readonly tabId: number
      readonly type: string
      readonly message: string
      readonly defaultPrompt?: string
      readonly frameUrl?: string
    }

export interface BrowserPanelRegisterInput {
  readonly webContentsId: number
  readonly requestId?: string
  readonly url?: string
}

export interface BrowserViewBridge {
  readonly endpoint: string
  readonly token: string
}

interface ManagedPage {
  readonly id: number
  readonly webContents: WebContents
  readonly hostWebContentsId: number
  url: string
  title: string
  loading: boolean
  active: boolean
  debuggerAttached: boolean
  // debugger.on listeners belong to the webContents debugger for the page's
  // whole lifetime; re-attaching must not add a second copy of them.
  debuggerBound: boolean
  pageEnabled: boolean
  dialog: BrowserPanelDialog | undefined
  fileChooser: { readonly backendNodeId: number; readonly mode?: string } | undefined
  // The controller's Fetch interception pauses every request the page makes
  // until a continue/fail command arrives. Both pieces of state are tracked so
  // a controller whose socket drops cannot strand the page mid-navigation.
  fetchArmed: boolean
  readonly fetchPaused: Map<string, string>
}

interface PendingOpen {
  readonly requestId: string
  readonly url: string
  readonly window: BrowserWindow
  readonly resolve: (page: ManagedPage) => void
  readonly reject: (error: CdpBridgeError) => void
  readonly timeout: ReturnType<typeof setTimeout>
  readonly onWindowClosed: () => void
  retry: ReturnType<typeof setInterval> | undefined
  sending: boolean
}

export interface EmbeddedBrowserManagerOptions {
  readonly openTimeoutMs?: number
  readonly openRetryMs?: number
  readonly hostWindowWaitMs?: number
  readonly hostLoadWaitMs?: number
}

class CdpBridgeError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = "CdpBridgeError"
    this.code = code
  }
}

export class EmbeddedBrowserManager {
  private readonly pages = new Map<number, ManagedPage>()
  private readonly pending = new Map<string, PendingOpen>()
  // A retried open command can mount a second <webview> before the first one
  // registers; remembering which page answered a request lets late duplicates
  // be closed instead of left visible.
  private readonly openedRequests = new Map<string, number>()
  private readonly openTimeoutMs: number
  private readonly openRetryMs: number
  private readonly hostWindowWaitMs: number
  private readonly hostLoadWaitMs: number
  private bridge: WebSocketBridge | undefined
  private started: Promise<BrowserViewBridge> | undefined
  private watching = false
  // Kept as a field so destroy() can remove exactly the listener watch() added.
  private readonly onWebContentsCreated = (_event: Electron.Event, contents: WebContents): void => this.prepare(contents)
  private readonly onWillDownload = (_event: Electron.Event, item: Electron.DownloadItem): void =>
    this.trackDownload(item)
  // Newest first, capped so a long-lived app cannot grow without bound.
  private readonly downloads: TrackedDownload[] = []
  // Per-webContents FIFO: a rejected credential produces another login event,
  // so each callback must be kept until it is answered.
  private readonly authChallenges = new Map<number, PendingAuthChallenge[]>()
  // Challenges for guests whose tab has not registered yet (the initial
  // navigation is held open until auth is answered, so no dom-ready fires).
  private readonly pendingAuthByContents = new Map<number, PendingAuthChallenge[]>()
  private browserSession: Electron.Session | undefined
  private downloadsWatched = false
  // Agent actions often arrive while the app is unfocused. Remembering the
  // last window that hosted a browser panel keeps open commands away from
  // arbitrary windows (or the transient overlay) after a reload.
  private lastHostId: number | undefined

  constructor(options: EmbeddedBrowserManagerOptions = {}) {
    this.openTimeoutMs = options.openTimeoutMs ?? OPEN_TIMEOUT_MS
    this.openRetryMs = options.openRetryMs ?? OPEN_RETRY_MS
    this.hostWindowWaitMs = options.hostWindowWaitMs ?? HOST_WINDOW_WAIT_MS
    this.hostLoadWaitMs = options.hostLoadWaitMs ?? HOST_LOAD_WAIT_MS
  }

  watch(): void {
    if (this.watching) return
    this.watching = true
    // The embedded browser is untrusted web content. It gets no web
    // permissions at all: no geolocation, camera, microphone, or notifications.
    const browserSession = session.fromPartition(BROWSER_PARTITION)
    browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    browserSession.setPermissionCheckHandler(() => false)
    this.browserSession = browserSession
    if (!this.downloadsWatched) {
      this.downloadsWatched = true
      browserSession.on("will-download", this.onWillDownload)
    }
    // Last-resort egress filter for the partition. will-navigate /
    // will-frame-navigate / will-redirect cover document navigations, but a
    // redirect target or a private subresource is only visible at the network
    // layer, so every request that resolves to a private or metadata address is
    // cancelled before it leaves the process. This runs with or without a
    // connected controller, unlike the controller's Fetch interception.
    browserSession.webRequest.onBeforeRequest({ urls: ["*://*/*"] }, (details, callback) => {
      if (isAllowedBrowserUrl(details.url)) callback({})
      else {
        this.bridge?.broadcast({
          method: "Omnia.requestBlocked",
          params: { url: details.url, resourceType: details.resourceType },
        })
        callback({ cancel: true })
      }
    })
    browserSession.webRequest.onHeadersReceived({ urls: ["*://*/*"] }, (details, callback) => {
      // A 3xx target is resolved here so a redirect into loopback or metadata is
      // cancelled even when the hop looked public.
      const location = headerValue(details.responseHeaders, "location")
      const target = location === undefined ? undefined : redirectTarget(details.url, location)
      if (target === undefined || isAllowedBrowserUrl(target)) callback({})
      else callback({ cancel: true })
    })
    app.on("web-contents-created", this.onWebContentsCreated)
    for (const window of BrowserWindow.getAllWindows()) this.prepare(window.webContents)
  }

  async start(): Promise<BrowserViewBridge> {
    this.watch()
    this.started ??= this.startBridge()
    return this.started
  }

  private async startBridge(): Promise<BrowserViewBridge> {
    const token = randomBytes(32).toString("hex")
    const bridge = await startWebSocketBridge({
      token,
      onMessage: (client, message) => void this.handleBridgeMessage(client, message),
      // A paused Fetch request waits on a continue/fail command that only a
      // connected controller can send. With no client left those pauses never
      // resolve, so the last disconnect disarms interception and settles the
      // pending requests here instead of hanging the tab forever.
      onClose: () => {
        if (bridge.clients === 0) this.releaseInterceptions()
      },
    })
    this.bridge = bridge
    return { endpoint: bridge.endpoint, token }
  }

  private prepare(contents: WebContents): void {
    // Electron's built-in -run-dialog listener shows a native message box
    // parented to the whole app window and silently cancels prompts. Guest
    // dialogs surface through the owner window's listener too, so the default
    // is removed for every WebContents: the CDP Page domain owns dialogs, the
    // dialog stays pending until Page.handleJavaScriptDialog answers it, and
    // the in-panel dialog bar is the only visible surface.
    const emitter = contents as unknown as {
      removeAllListeners: (event: string) => void
      on: (event: string, listener: () => void) => void
    }
    emitter.removeAllListeners("-run-dialog")
    emitter.on("-run-dialog", () => {})
    if (contents.getType() === "window") {
      contents.on("will-attach-webview", (event, webPreferences, params) => {
        delete webPreferences.preload
        webPreferences.nodeIntegration = false
        webPreferences.nodeIntegrationInSubFrames = false
        webPreferences.contextIsolation = true
        webPreferences.sandbox = true
        webPreferences.webSecurity = true
        // The guest is forced into the isolated partition (and never allowed to
        // run mixed or insecure content) so its cookies, permissions, and
        // request filter are the guest's own.
        webPreferences.partition = BROWSER_PARTITION
        webPreferences.allowRunningInsecureContent = false
        if (!isAllowedBrowserUrl(params.src)) event.preventDefault()
      })
      return
    }
    if (contents.getType() !== "webview") return
    const hideScrollbars = () => {
      void contents.insertCSS(
        "*::-webkit-scrollbar{width:0!important;height:0!important;display:none!important}" +
          "*{scrollbar-width:none!important;-ms-overflow-style:none!important}",
      )
    }
    contents.on("dom-ready", hideScrollbars)
    contents.on("did-navigate", hideScrollbars)
    // A page-initiated navigation must obey the same allowlist as opens, so a
    // compromised page cannot steer the guest at loopback or metadata. Only the
    // main frame is covered by will-navigate: a subframe or a redirect target is
    // invisible there, so both are gated explicitly. Every event here carries the
    // target on its details object; the positional url argument is deprecated.
    contents.on("will-navigate", (details) => {
      if (isAllowedBrowserUrl(details.url)) return
      details.preventDefault()
    })
    contents.on("will-frame-navigate", (details) => {
      if (isAllowedBrowserUrl(details.url)) return
      details.preventDefault()
    })
    contents.on("will-redirect", (details) => {
      if (isAllowedBrowserUrl(details.url)) return
      details.preventDefault()
    })
    contents.setWindowOpenHandler(({ url }) => {
      // A page that targets a new window becomes its own tab; previously the
      // URL was loaded into the same tab, which the /windows test forbids.
      if (isAllowedBrowserUrl(url)) void this.open(url)
      return { action: "deny" }
    })
  }

  private async handleBridgeMessage(client: WebSocketBridgeClient, message: unknown): Promise<void> {
    if (typeof message !== "object" || message === null) return
    const record = message as Record<string, unknown>
    if (typeof record.id !== "number" || typeof record.method !== "string") return
    const params =
      typeof record.params === "object" && record.params !== null ? (record.params as Record<string, unknown>) : {}
    try {
      const tabId = optionalTabId(record.tabId)
      client.send({ id: record.id, result: await this.dispatch(record.method, params, tabId) })
    } catch (error) {
      client.send({
        id: record.id,
        error: {
          code: error instanceof CdpBridgeError ? -32000 : -32603,
          message: error instanceof Error ? error.message : "The embedded browser command failed.",
          ...(error instanceof CdpBridgeError ? { data: { code: error.code } } : {}),
        },
      })
    }
  }

  private async dispatch(method: string, params: Record<string, unknown>, tabId?: number): Promise<unknown> {
    if (method.startsWith("Omnia.")) return this.dispatchOmnia(method, params, tabId)
    const page = tabId === undefined ? this.activePage() : this.pages.get(tabId)
    if (page === undefined) throw new CdpBridgeError("not_available", "The embedded browser has no matching page.")
    return this.sendToPage(page, method, params)
  }

  private async dispatchOmnia(method: string, params: Record<string, unknown>, tabId?: number): Promise<unknown> {
    if (method === "Omnia.tabs") return { tabs: this.list() }
    if (method === "Omnia.open")
      return { tab: await this.open(typeof params.url === "string" ? params.url : "about:blank") }
    if (method === "Omnia.activate") {
      this.activate(requireTabId(params.tabId))
      return {}
    }
    if (method === "Omnia.close") {
      this.close(requireTabId(params.tabId))
      return {}
    }
    if (method === "Omnia.currentTab") return { tabId: this.activeId ?? null }
    if (method === "Omnia.currentDialog") {
      const page = this.requirePage(tabId)
      this.attachDebuggerQuietly(page)
      return { dialog: page.dialog ?? null }
    }
    if (method === "Omnia.handleDialog") {
      const page = this.requirePage(tabId)
      return this.answerPageDialog(page, {
        accept: requireBoolean(params.accept, "accept"),
        ...(typeof params.promptText === "string" ? { promptText: params.promptText } : {}),
        ...(typeof params.expectedType === "string" ? { expectedType: params.expectedType } : {}),
        ...(typeof params.expectedMessage === "string" ? { expectedMessage: params.expectedMessage } : {}),
      })
    }
    if (method === "Omnia.downloads") return { downloads: this.downloads.map(downloadJson) }
    if (method === "Omnia.auth") {
      const username = typeof params.username === "string" ? params.username : undefined
      const password = typeof params.password === "string" ? params.password : undefined
      if (username === undefined || password === undefined) {
        throw new CdpBridgeError("invalid_params", "Omnia.auth needs username and password.")
      }
      const requested = optionalTabId(params.tabId) ?? tabId
      return this.answerAuth({ username, password, ...(requested === undefined ? {} : { tabId: requested }) })
    }
    if (method === "Omnia.upload") {
      const page = this.requirePage(optionalTabId(params.tabId) ?? tabId)
      const files = params.files
      if (
        !Array.isArray(files) ||
        files.length === 0 ||
        files.length > 10 ||
        files.some((file) => typeof file !== "string" || file.length === 0 || file.length > 400)
      ) {
        throw new CdpBridgeError("invalid_params", "Omnia.upload needs files: 1-10 paths of at most 400 characters.")
      }
      for (const file of files) {
        if (typeof file !== "string") continue
        if (!isAbsolute(file)) {
          throw new CdpBridgeError("invalid_params", `The upload file ${JSON.stringify(file)} must be an absolute path.`)
        }
        // An upload hands a guest page a path to read on this machine, so it is
        // confined to the roots the sandbox already exposes (the Omnia downloads
        // directory and the OS temp root) instead of any file that happens to
        // exist. A symlink cannot smuggle a read outside them either.
        if (!isReadableUploadPath(file)) {
          throw new CdpBridgeError(
            "path_blocked",
            `Refusing to upload ${JSON.stringify(file)}. Uploads are confined to the Omnia ` +
              "downloads directory and the temporary folder.",
          )
        }
        let stats: ReturnType<typeof statSync>
        try {
          stats = statSync(file)
        } catch {
          throw new CdpBridgeError("invalid_params", `The upload file ${JSON.stringify(file)} does not exist on disk.`)
        }
        if (!stats.isFile()) {
          throw new CdpBridgeError("invalid_params", `The upload file ${JSON.stringify(file)} is not a regular file.`)
        }
      }
      const chooser = page.fileChooser
      if (chooser === undefined) throw new CdpBridgeError("no_file_chooser", "No file chooser is open on this page.")
      try {
        const debugger_ = this.ensurePageDebugger(page)
        await debugger_.sendCommand("DOM.setFileInputFiles", {
          files: files as string[],
          backendNodeId: chooser.backendNodeId,
        })
      } catch (error) {
        throw new CdpBridgeError(
          "upload_failed",
          error instanceof Error ? error.message : "The file upload could not be applied to the page.",
        )
      }
      page.fileChooser = undefined
      return { files }
    }
    if (method === "Omnia.reload") {
      const page = this.requirePage(tabId)
      if (params.ignoreCache === true) page.webContents.reloadIgnoringCache()
      else page.webContents.reload()
      return { url: page.webContents.getURL() || page.url, reloaded: true }
    }
    if (method === "Omnia.back" || method === "Omnia.forward") {
      const page = this.requirePage(tabId)
      const history = page.webContents.navigationHistory
      const canMove = method === "Omnia.back" ? history.canGoBack() : history.canGoForward()
      if (!canMove) {
        throw new CdpBridgeError(
          "no_history",
          method === "Omnia.back" ? "There is no previous page in this tab." : "There is no next page in this tab.",
        )
      }
      if (method === "Omnia.back") history.goBack()
      else history.goForward()
      return { url: page.webContents.getURL() || page.url, navigated: true }
    }
    if (method === "Omnia.saveImage") {
      const url = typeof params.url === "string" ? params.url : undefined
      const path = typeof params.path === "string" ? params.path : undefined
      if (url === undefined || path === undefined) {
        throw new CdpBridgeError("invalid_params", "Omnia.saveImage needs url and path.")
      }
      return this.saveImage(url, path, params.allowOutside === true, tabId)
    }
    throw new CdpBridgeError("unsupported", `Unknown embedded browser command ${method}.`)
  }

  // Downloads a page image through the guest session so cross-origin images
  // save without CORS restrictions, which an in-page fetch cannot do. The
  // destination is validated before anything is created on disk, and both write
  // paths go through the collision-safe / O_EXCL helpers so a name can neither
  // escape the sandbox roots nor overwrite an existing file. allowOutside is the
  // controller's explicit write approval for a path the sandbox does not own.
  private async saveImage(
    url: string,
    path: string,
    allowOutside: boolean,
    tabId?: number,
  ): Promise<{ saved: boolean; path: string; bytes: number }> {
    const target = writableImagePath(path, allowOutside)
    if (url.startsWith("data:")) {
      if (url.length > MAX_IMAGE_BYTES * 2) {
        throw new CdpBridgeError("image_too_large", "The image data is too large to save.")
      }
      // A data: URL has no host to check against the allowlist, so the source
      // check is on its declared type instead: only a base64 image payload is
      // ever written, never markup that would run if the file were opened.
      const match = url.match(/^data:(image\/[A-Za-z0-9.+-]+)((?:;[^,;]*)*);base64,(.*)$/su)
      if (match === null) throw new CdpBridgeError("invalid_url", "Only base64 image data URLs can be saved.")
      const bytes = Buffer.from(match[3] ?? "", "base64")
      if (bytes.length > MAX_IMAGE_BYTES) {
        throw new CdpBridgeError("image_too_large", "The image data is too large to save.")
      }
      const written = writeImageFile(target, bytes)
      return { saved: true, path: written, bytes: statSync(written).size }
    }
    if (!isAllowedBrowserUrl(url)) throw new CdpBridgeError("invalid_url", `Refusing to download ${url}.`)
    const page = tabId === undefined ? this.activePage() : this.pages.get(tabId)
    if (page === undefined) throw new CdpBridgeError("not_available", "The embedded browser has no matching page.")
    // Electron needs the parent directory to exist before it starts a download;
    // it is created only after the destination has been validated above.
    mkdirSync(dirname(target), { recursive: true })
    const session = page.webContents.session
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        session.removeListener("will-download", onWillDownload)
        reject(new CdpBridgeError("download_timeout", "The image download timed out."))
      }, 30000)
      const onWillDownload = (_event: unknown, item: Electron.DownloadItem) => {
        clearTimeout(timeout)
        item.setSavePath(collisionSafeDownloadPath(dirname(target), basename(target)))
        item.once("done", (_doneEvent: unknown, state: string) => {
          if (state === "completed") resolve({ saved: true, path: item.getSavePath(), bytes: item.getReceivedBytes() })
          else reject(new CdpBridgeError("download_failed", `The image download ${state}.`))
        })
      }
      session.once("will-download", onWillDownload)
      page.webContents.downloadURL(url)
    })
  }

  // Browser-initiated downloads land in the same downloads root the image
  // saver uses; the record is live-updated so Omnia.downloads always reports
  // the current state instead of a snapshot taken at start.
  private trackDownload(item: Electron.DownloadItem): void {
    const directory = imageDownloadsDir()
    mkdirSync(directory, { recursive: true })
    const path = collisionSafeDownloadPath(directory, item.getFilename())
    item.setSavePath(path)
    const record: TrackedDownload = {
      id: randomUUID(),
      url: item.getURL(),
      filename: item.getFilename(),
      path,
      state: "progressing",
      receivedBytes: item.getReceivedBytes(),
      totalBytes: item.getTotalBytes(),
      startedAt: Date.now(),
      finishedAt: undefined,
      mimeType: safeMimeType(item),
      error: undefined,
    }
    this.downloads.unshift(record)
    if (this.downloads.length > MAX_TRACKED_DOWNLOADS) this.downloads.pop()
    this.broadcastDownload(record)
    item.on("updated", (_event, state) => {
      record.state = downloadState(state)
      record.receivedBytes = item.getReceivedBytes()
      record.totalBytes = item.getTotalBytes()
      this.broadcastDownload(record)
    })
    item.once("done", (_event, state) => {
      record.state = downloadState(state)
      record.receivedBytes = item.getReceivedBytes()
      record.totalBytes = item.getTotalBytes()
      record.finishedAt = Date.now()
      if (state !== "completed") record.error = safeDownloadError(state)
      this.broadcastDownload(record)
    })
  }

  private broadcastDownload(record: TrackedDownload): void {
    this.bridge?.broadcast({ method: "Omnia.download", params: { download: downloadJson(record) } })
  }

  // Electron emits webview guest challenges on the guest WebContents itself, so
  // every challenge is held open until Omnia.auth answers it. A challenge that
  // repeats for a host+realm already pending (Electron re-emits one after a
  // rejected credential) is answered with empty credentials instead of being
  // dropped: a callback that is never invoked leaves the load pending forever.
  private holdAuth(
    contents: WebContents,
    details: { url?: string },
    authInfo: { host: string; realm?: string; isProxy?: boolean },
    callback: (username?: string, password?: string) => void,
  ): void {
    const page = [...this.pages.values()].find((candidate) => candidate.webContents === contents)
    if (page === undefined) {
      const queue = this.pendingAuthByContents.get(contents.id) ?? []
      if (queue.some((entry) => entry.host === authInfo.host && entry.realm === (authInfo.realm ?? ""))) {
        callback()
        return
      }
      queue.push({
        url: typeof details.url === "string" ? details.url : contents.getURL(),
        host: authInfo.host,
        realm: authInfo.realm ?? "",
        isProxy: authInfo.isProxy === true,
        callback,
      })
      this.pendingAuthByContents.set(contents.id, queue)
      this.bridge?.broadcast({
        method: "Omnia.authRequired",
        params: { url: details.url ?? contents.getURL(), host: authInfo.host, realm: authInfo.realm ?? "", isProxy: authInfo.isProxy === true },
      })
      return
    }
    const queue = this.authChallenges.get(page.id) ?? []
    if (queue.some((entry) => entry.host === authInfo.host && entry.realm === (authInfo.realm ?? ""))) {
      callback()
      return
    }
    const challenge: PendingAuthChallenge = {
      url: typeof details.url === "string" ? details.url : contents.getURL(),
      host: authInfo.host,
      realm: authInfo.realm ?? "",
      isProxy: authInfo.isProxy === true,
      callback,
    }
    if (queue.length === 0) this.authChallenges.set(page.id, [challenge])
    else queue.push(challenge)
    this.broadcastEvent(page, "Omnia.authRequired", {
      url: challenge.url,
      host: challenge.host,
      realm: challenge.realm,
      isProxy: challenge.isProxy,
    })
  }

  // Answers the oldest pending challenge, optionally pinned to one tab. The
  // callback is removed before it is invoked so one challenge can never be
  // answered twice, and a second Omnia.auth fails with no_auth_challenge.
  private answerAuth(input: {
    readonly username: string
    readonly password: string
    readonly tabId?: number
  }): { answered: true } {
    const preferred = input.tabId ?? [...this.authChallenges.keys()].at(-1)
    if (preferred !== undefined) {
      const queue = this.authChallenges.get(preferred)
      const challenge = queue?.shift()
      if (queue !== undefined && queue.length === 0) this.authChallenges.delete(preferred)
      if (challenge !== undefined) {
        challenge.callback(input.username, input.password)
        return { answered: true }
      }
    }
    // A challenge can arrive before the tab finishes registering (the initial
    // navigation is held open until auth is answered), so unregistered
    // challenges are answerable too.
    const contentsId = input.tabId === undefined ? [...this.pendingAuthByContents.keys()].at(-1) : undefined
    if (contentsId !== undefined) {
      const queue = this.pendingAuthByContents.get(contentsId)
      const challenge = queue?.shift()
      if (queue !== undefined && queue.length === 0) this.pendingAuthByContents.delete(contentsId)
      if (challenge !== undefined) {
        challenge.callback(input.username, input.password)
        return { answered: true }
      }
    }
    throw new CdpBridgeError("no_auth_challenge", "No authentication challenge is pending.")
  }

  private async sendToPage(page: ManagedPage, method: string, params: Record<string, unknown>): Promise<unknown> {
    if (page.webContents.isDestroyed()) {
      this.removePage(page.id)
      throw new CdpBridgeError("not_available", "The embedded browser page is closed.")
    }
    const result = this.ensurePageDebugger(page).sendCommand(method, params)
    void Promise.resolve(result).then(() => this.trackFetchCommand(page, method, params), () => undefined)
    return result
  }

  private trackFetchCommand(page: ManagedPage, method: string, params: Record<string, unknown>): void {
    if (method === "Fetch.enable") {
      page.fetchArmed = true
      return
    }
    if (method === "Fetch.disable") {
      page.fetchArmed = false
      page.fetchPaused.clear()
      return
    }
    if (
      (method === "Fetch.continueRequest" || method === "Fetch.failRequest" || method === "Fetch.fulfillRequest") &&
      typeof params.requestId === "string"
    ) {
      page.fetchPaused.delete(params.requestId)
    }
  }

  private releaseInterceptions(): void {
    for (const page of this.pages.values()) {
      if ((!page.fetchArmed && page.fetchPaused.size === 0) || page.webContents.isDestroyed()) continue
      for (const [requestId, url] of page.fetchPaused) {
        void page.webContents.debugger
          .sendCommand(
            isAllowedBrowserUrl(url) ? "Fetch.continueRequest" : "Fetch.failRequest",
            isAllowedBrowserUrl(url) ? { requestId } : { requestId, errorReason: "BlockedByClient" },
          )
          .catch(() => undefined)
      }
      page.fetchPaused.clear()
      if (!page.fetchArmed) continue
      page.fetchArmed = false
      void page.webContents.debugger.sendCommand("Fetch.disable").catch(() => undefined)
    }
  }

  // Electron's <webview> runs JavaScript dialogs through the embedder unless a
  // debugger owns the Page domain. Attaching and enabling Page once routes
  // Page.javascriptDialogOpening to this process, so a dialog is a first-class
  // AI-visible event (answered with Page.handleJavaScriptDialog) instead of a
  // native box parented to the whole application window. If a platform dialog
  // still appears on a given Electron build, the same Page.handleJavaScriptDialog
  // answer closes it while the debugger is attached.
  private ensurePageDebugger(page: ManagedPage): Electron.Debugger {
    const debugger_ = page.webContents.debugger
    if (page.debuggerAttached && debugger_.isAttached()) return debugger_
    if (!debugger_.isAttached()) {
      try {
        debugger_.attach("1.3")
      } catch (error) {
        page.debuggerAttached = false
        throw new CdpBridgeError(
          "not_available",
          error instanceof Error ? error.message : "Could not attach to the embedded browser page.",
        )
      }
    }
    page.debuggerAttached = true
    if (!page.debuggerBound) {
      page.debuggerBound = true
      debugger_.on("message", (_event, eventMethod, eventParams) =>
        this.handleDebuggerEvent(page, eventMethod, eventParams),
      )
      debugger_.on("detach", () => {
        page.debuggerAttached = false
        page.pageEnabled = false
        page.dialog = undefined
        page.fileChooser = undefined
        // The controller's Fetch interception and its isolated world live in
        // this debugger, so a detach has to be reported: keeping either would
        // leave a paused request or a ref map the page can no longer reach.
        page.fetchArmed = false
        page.fetchPaused.clear()
        this.broadcastEvent(page, "Inspector.detached", { reason: "target_closed" })
      })
    }
    if (!page.pageEnabled) {
      page.pageEnabled = true
      const enabling = debugger_.sendCommand("Page.enable")
      void Promise.resolve(enabling).catch(() => {
        page.pageEnabled = false
      })
      // File choosers are owned by the CDP Page domain too: intercept them so
      // they are answered with Omnia.upload instead of a native dialog.
      const intercepting = debugger_.sendCommand("Page.setInterceptFileChooserDialog", { enabled: true })
      void Promise.resolve(intercepting).catch(() => {
        page.pageEnabled = false
      })
    }
    return debugger_
  }

  private attachDebuggerQuietly(page: ManagedPage): void {
    if (page.webContents.isDestroyed()) return
    try {
      this.ensurePageDebugger(page)
    } catch {
      // A later page command reports the attach failure; state queries stay non-fatal.
    }
  }

  private handleDebuggerEvent(page: ManagedPage, method: string, params: unknown): void {
    if (method === "Fetch.requestPaused") {
      const record = typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {}
      const request =
        typeof record.request === "object" && record.request !== null
          ? (record.request as Record<string, unknown>)
          : {}
      if (typeof record.requestId === "string") {
        page.fetchPaused.set(record.requestId, typeof request.url === "string" ? request.url : "")
      }
    }
    if (method === "Page.javascriptDialogOpening") {
      page.dialog = dialogFromEvent(params)
      this.broadcastEvent(page, method, params)
      this.sendToHost(page, { kind: "dialog", tabId: page.id, ...page.dialog })
      return
    }
    if (method === "Page.javascriptDialogClosed") {
      page.dialog = undefined
      this.broadcastEvent(page, method, params)
      return
    }
    if (method === "Page.fileChooserOpened") {
      const record = typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {}
      if (typeof record.backendNodeId !== "number") return
      page.fileChooser = {
        backendNodeId: record.backendNodeId,
        ...(typeof record.mode === "string" ? { mode: record.mode } : {}),
      }
      this.broadcastEvent(page, method, params)
      return
    }
    // Every other debugger event (Page.frameNavigated, Inspector.targetCrashed,
    // network/runtime chatter) is forwarded; the client filters by domain.
    this.broadcastEvent(page, method, params)
  }

  private broadcastEvent(page: ManagedPage, method: string, params: unknown): void {
    this.bridge?.broadcast({
      method,
      ...(params === undefined ? {} : { params }),
      tabId: String(page.id),
    })
  }

  private requirePage(tabId?: number): ManagedPage {
    const page = tabId === undefined ? this.activePage() : this.pages.get(tabId)
    if (page === undefined) throw new CdpBridgeError("not_available", "The embedded browser has no matching page.")
    return page
  }

  private async answerPageDialog(
    page: ManagedPage,
    input: {
      readonly accept: boolean
      readonly promptText?: string
      readonly expectedType?: string
      readonly expectedMessage?: string
    },
  ): Promise<{ handled: true }> {
    const dialog = page.dialog
    if (dialog === undefined) {
      throw new CdpBridgeError("dialog_not_open", "There is no pending JavaScript dialog.")
    }
    if (input.expectedType !== undefined && input.expectedType !== dialog.type) {
      throw new CdpBridgeError(
        "dialog_mismatch",
        `The pending dialog is a ${dialog.type} dialog, not ${input.expectedType}.`,
      )
    }
    if (input.expectedMessage !== undefined && input.expectedMessage !== dialog.message) {
      throw new CdpBridgeError("dialog_mismatch", "The pending dialog message does not match the expected message.")
    }
    // will-prevent-unload is already forced through so the navigation continues;
    // there is no native dialog left to answer.
    if (dialog.type !== "beforeunload") {
      const debugger_ = this.ensurePageDebugger(page)
      await debugger_.sendCommand("Page.handleJavaScriptDialog", {
        accept: input.accept,
        ...(input.promptText === undefined ? {} : { promptText: input.promptText }),
      })
    }
    page.dialog = undefined
    return { handled: true }
  }

  async answerDialog(
    ownerId: number,
    tabId: number,
    input: { readonly accept: boolean; readonly promptText?: string },
  ): Promise<{ handled: true }> {
    const page = this.pages.get(tabId)
    if (page === undefined || page.hostWebContentsId !== ownerId) {
      throw new CdpBridgeError("not_available", "The embedded browser tab is not open.")
    }
    return this.answerPageDialog(page, input)
  }

  async open(url = "about:blank"): Promise<BrowserPanelTabInfo> {
    const target = navigableOrThrow(url)
    const window = await this.waitForHostWindow()
    if (window === undefined) {
      throw new CdpBridgeError("not_available", "No application window can host the embedded browser.")
    }
    const requestId = randomUUID()
    const page = await new Promise<ManagedPage>((resolve, reject) => {
      const pending: PendingOpen = {
        requestId,
        url: target,
        window,
        resolve,
        reject,
        timeout: setTimeout(() => {
          this.failOpen(requestId, new CdpBridgeError("open_timeout", "The embedded browser did not open a tab in time."))
        }, this.openTimeoutMs),
        onWindowClosed: () => {
          this.failOpen(
            requestId,
            new CdpBridgeError("not_available", "The application window closed before the embedded browser opened."),
          )
        },
        retry: undefined,
        sending: false,
      }
      this.pending.set(requestId, pending)
      window.once("closed", pending.onWindowClosed)
      void this.sendOpen(requestId)
    })
    this.activatePage(page.id)
    return summary(page)
  }

  // Early startup can race window creation, so an open waits briefly for a
  // host window instead of failing before the app has a window at all.
  private async waitForHostWindow(): Promise<BrowserWindow | undefined> {
    const deadline = Date.now() + this.hostWindowWaitMs
    for (;;) {
      const window = this.openHostWindow()
      if (window !== undefined) return window
      if (Date.now() >= deadline) return undefined
      await sleep(100)
    }
  }

  private async sendOpen(requestId: string): Promise<void> {
    const pending = this.pending.get(requestId)
    if (pending === undefined || pending.sending) return
    pending.sending = true
    try {
      if (pending.window.isDestroyed() || pending.window.webContents.isDestroyed()) {
        this.failOpen(
          requestId,
          new CdpBridgeError("not_available", "The application window closed before the embedded browser opened."),
        )
        return
      }
      await waitForHostLoad(pending.window.webContents, this.hostLoadWaitMs)
      if (this.pending.get(requestId) !== pending) return
      try {
        pending.window.webContents.send(BROWSER_PANEL_COMMAND, {
          kind: "open",
          requestId,
          url: pending.url,
        } satisfies BrowserPanelCommand)
      } catch (error) {
        this.failOpen(
          requestId,
          new CdpBridgeError(
            "not_available",
            error instanceof Error ? error.message : "The embedded browser could not receive the open command.",
          ),
        )
        return
      }
      pending.retry ??= setInterval(() => void this.sendOpen(requestId), this.openRetryMs)
    } finally {
      pending.sending = false
    }
  }

  private failOpen(requestId: string, error: CdpBridgeError): void {
    const pending = this.pending.get(requestId)
    if (pending === undefined) return
    this.pending.delete(requestId)
    this.clearPendingTimers(pending)
    pending.window.removeListener("closed", pending.onWindowClosed)
    pending.reject(error)
  }

  private clearPendingTimers(pending: PendingOpen): void {
    clearTimeout(pending.timeout)
    if (pending.retry !== undefined) clearInterval(pending.retry)
  }

  private openHostWindow(): BrowserWindow | undefined {
    const focused = BrowserWindow.getFocusedWindow()
    if (focused !== null && !focused.isDestroyed()) return focused
    const windows = BrowserWindow.getAllWindows().filter((candidate) => !candidate.isDestroyed())
    const remembered = this.lastHostId
    return (
      (remembered === undefined ? undefined : windows.find((candidate) => candidate.webContents.id === remembered)) ??
      windows[0]
    )
  }

  list(): BrowserPanelTabInfo[] {
    return [...this.pages.values()].map((page) => summary(page))
  }

  activate(tabId: number): void {
    const page = this.pages.get(tabId)
    if (page === undefined) throw new CdpBridgeError("not_available", "The embedded browser tab is not open.")
    this.activatePage(tabId)
  }

  activateOwned(ownerId: number, tabId: number): void {
    const page = this.pages.get(tabId)
    if (page === undefined || page.hostWebContentsId !== ownerId) return
    this.activatePage(tabId)
  }

  close(tabId: number): void {
    const page = this.pages.get(tabId)
    if (page === undefined) return
    this.sendToHost(page, { kind: "close", tabId })
    this.detachDebugger(page)
    this.removePage(tabId)
  }

  focus(tabId: number): void {
    const page = this.pages.get(tabId)
    if (page === undefined) throw new CdpBridgeError("not_available", "The embedded browser tab is not open.")
    this.activatePage(tabId)
    page.webContents.focus()
  }

  register(owner: WebContents, input: BrowserPanelRegisterInput): BrowserPanelTabInfo | undefined {
    const contents = webContents.fromId(input.webContentsId)
    if (contents === undefined || contents.isDestroyed() || contents.getType() !== "webview") return undefined
    // hostWebContents is documented as "might own"; when Electron has not
    // reported it yet, the trusted IPC sender owns the registration.
    const hostWebContentsId = contents.hostWebContents?.id ?? owner.id
    if (hostWebContentsId !== owner.id) return undefined
    this.lastHostId = owner.id
    const page = this.observe(contents, input.url ?? contents.getURL(), hostWebContentsId)
    this.consumePending(input.requestId, page)
    const queuedAuth = this.pendingAuthByContents.get(contents.id)
    if (queuedAuth !== undefined) {
      this.pendingAuthByContents.delete(contents.id)
      const existing = this.authChallenges.get(page.id) ?? []
      this.authChallenges.set(page.id, [...existing, ...queuedAuth])
      for (const challenge of queuedAuth) {
        this.broadcastEvent(page, "Omnia.authRequired", {
          url: challenge.url,
          host: challenge.host,
          realm: challenge.realm,
          isProxy: challenge.isProxy,
        })
      }
    }
    // A panel that mounts while a dialog is already open must render it, so the
    // pending dialog is re-sent on every registration.
    if (page.dialog !== undefined) this.sendToHost(page, { kind: "dialog", tabId: page.id, ...page.dialog })
    return summary(page)
  }

  unregisterOwned(ownerId: number, tabId: number): void {
    const page = this.pages.get(tabId)
    if (page === undefined || page.hostWebContentsId !== ownerId) return
    this.detachDebugger(page)
    this.removePage(tabId)
  }

  async destroy(): Promise<void> {
    for (const page of [...this.pages.values()]) {
      // Every page state is dropped explicitly: the bridge is about to close, so
      // a dialog or chooser left on a page object would outlive the app.
      page.dialog = undefined
      page.fileChooser = undefined
      this.detachDebugger(page)
    }
    this.pages.clear()
    this.activeId = undefined
    for (const pending of this.pending.values()) {
      this.clearPendingTimers(pending)
      pending.window.removeListener("closed", pending.onWindowClosed)
      pending.reject(new CdpBridgeError("not_available", "The embedded browser bridge stopped."))
    }
    this.pending.clear()
    this.openedRequests.clear()
    this.authChallenges.clear()
    this.pendingAuthByContents.clear()
    this.browserSession?.removeListener("will-download", this.onWillDownload)
    this.browserSession = undefined
    this.downloadsWatched = false
    app.removeListener("web-contents-created", this.onWebContentsCreated)
    this.watching = false
    await this.bridge?.close()
    this.bridge = undefined
    this.started = undefined
  }

  private activeId: number | undefined

  private activePage(): ManagedPage | undefined {
    if (this.activeId === undefined) return undefined
    const page = this.pages.get(this.activeId)
    if (page !== undefined) return page
    this.activeId = undefined
    return undefined
  }

  private activatePage(tabId: number): void {
    const page = this.pages.get(tabId)
    if (page === undefined) return
    this.activeId = tabId
    for (const candidate of this.pages.values()) candidate.active = candidate.id === tabId
    this.sendToHost(page, { kind: "activate", tabId })
  }

  private observe(contents: WebContents, url: string, hostWebContentsId: number): ManagedPage {
    const existing = this.pages.get(contents.id)
    if (existing !== undefined && existing.webContents === contents) {
      existing.url = contents.getURL() || existing.url
      existing.title = contents.getTitle() || existing.title
      this.attachDebuggerQuietly(existing)
      return existing
    }
    if (existing !== undefined) {
      // A recycled webContents id must not keep serving the destroyed page.
      this.detachDebugger(existing)
      this.pages.delete(existing.id)
    }
    const page: ManagedPage = {
      id: contents.id,
      webContents: contents,
      hostWebContentsId,
      url: contents.getURL() || url,
      title: contents.getTitle(),
      loading: contents.isLoading(),
      active: false,
      debuggerAttached: false,
      debuggerBound: false,
      pageEnabled: false,
      dialog: undefined,
      fileChooser: undefined,
      fetchArmed: false,
      fetchPaused: new Map(),
    }
    this.pages.set(page.id, page)
    const sync = () => {
      page.url = contents.getURL() || page.url
      page.title = contents.getTitle() || page.title
    }
    contents.on("did-navigate", (_event, navigatedUrl, httpResponseCode, httpStatusText) => {
      page.url = navigatedUrl || page.url
      page.title = contents.getTitle() || page.title
      page.dialog = undefined
      page.fileChooser = undefined
      this.broadcastEvent(page, "Omnia.did-navigate", { url: navigatedUrl, httpResponseCode, httpStatusText })
    })
    contents.on("did-navigate-in-page", (_event, navigatedUrl, isMainFrame) => {
      sync()
      page.dialog = undefined
      page.fileChooser = undefined
      this.broadcastEvent(page, "Omnia.did-navigate-in-page", { url: navigatedUrl, isMainFrame })
    })
    contents.on("page-title-updated", sync)
    contents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      this.broadcastEvent(page, "Omnia.did-fail-load", { errorCode, errorDescription, validatedURL, isMainFrame })
    })
    contents.on("render-process-gone", (_event, details) => {
      page.dialog = undefined
      page.fileChooser = undefined
      this.broadcastEvent(page, "Omnia.render-process-gone", { reason: details.reason, exitCode: details.exitCode })
    })
    contents.on("unresponsive", () => {
      this.broadcastEvent(page, "Omnia.unresponsive", {})
    })
    // A beforeunload handler must never raise a native dialog over the whole
    // app window. Forcing the unload through keeps navigation reliable; the
    // condition is still recorded and reported so the AI can see it.
    contents.on("will-prevent-unload", (event) => {
      event.preventDefault()
      page.dialog = {
        type: "beforeunload",
        message: "The page tried to prevent leaving; the navigation was forced.",
        hasBrowserHandler: true,
      }
      this.broadcastEvent(page, "Page.javascriptDialogOpening", { ...page.dialog })
      this.sendToHost(page, { kind: "dialog", tabId: page.id, ...page.dialog })
    })
    // HTTP auth (basic/digest) and proxy challenges are held open until the
    // agent answers with Omnia.auth. Electron cancels a challenge by default
    // when no listener handles it, so the default is always prevented and the
    // pending challenge is surfaced as an event.
    contents.on("login", (event, details, authInfo, callback) => {
      event.preventDefault()
      this.holdAuth(contents, details, authInfo, callback)
    })
    contents.on("did-start-loading", () => {
      page.loading = true
    })
    contents.on("did-stop-loading", () => {
      page.loading = false
      sync()
    })
    contents.on("destroyed", () => {
      // A late destroy event for a replaced page must not evict its successor.
      if (this.pages.get(page.id) !== page) return
      this.authChallenges.delete(page.id)
      page.fileChooser = undefined
      this.detachDebugger(page)
      this.removePage(page.id)
    })
    if (this.activeId === undefined) this.activatePage(page.id)
    // Attaching at registration (not on the first page command) is what makes a
    // dialog from an already-open page AI-visible even before the next command.
    this.attachDebuggerQuietly(page)
    return page
  }

  private consumePending(requestId: string | undefined, page: ManagedPage): void {
    if (requestId === undefined) return
    const canonical = this.openedRequests.get(requestId)
    if (canonical !== undefined && canonical !== page.id) {
      // A retry mounted a second <webview> for an already-resolved open; close
      // the redundant tab so retries cannot leave visible duplicates.
      this.sendToHost(page, { kind: "close", tabId: page.id })
      this.detachDebugger(page)
      this.removePage(page.id)
      return
    }
    const pending = this.pending.get(requestId)
    if (pending === undefined) return
    this.pending.delete(requestId)
    this.clearPendingTimers(pending)
    pending.window.removeListener("closed", pending.onWindowClosed)
    this.rememberRequest(requestId, page.id)
    pending.resolve(page)
  }

  private rememberRequest(requestId: string, pageId: number): void {
    this.openedRequests.delete(requestId)
    this.openedRequests.set(requestId, pageId)
    if (this.openedRequests.size <= 64) return
    const oldest = this.openedRequests.keys().next().value
    if (oldest !== undefined) this.openedRequests.delete(oldest)
  }

  private removePage(tabId: number): void {
    const existing = this.pages.get(tabId)
    if (existing === undefined) return
    // A tab that goes away can never answer its pending dialog, chooser, or auth
    // challenge: clearing them here is what keeps a closed or crashed tab from
    // blocking every later action as dialog_open forever.
    existing.dialog = undefined
    existing.fileChooser = undefined
    this.authChallenges.delete(tabId)
    this.pendingAuthByContents.delete(existing.webContents.id)
    this.pages.delete(tabId)
    if (this.activeId !== tabId) return
    // Closing the active tab must not leave the bridge with pages but no
    // active one; elect a successor so Omnia.currentTab stays truthful.
    this.activeId = undefined
    const next = this.preferredPage()
    if (next !== undefined) this.activatePage(next.id)
  }

  private preferredPage(): ManagedPage | undefined {
    const candidates = [...this.pages.values()]
    return candidates.find((page) => isNavigableBrowserUrl(page.url)) ?? candidates[0]
  }

  private detachDebugger(page: ManagedPage): void {
    page.debuggerAttached = false
    page.pageEnabled = false
    if (page.webContents.isDestroyed()) return
    // isAttached() is the source of truth: a missed detach event must not leave
    // our debugger attached to a page we no longer manage.
    try {
      if (page.webContents.debugger.isAttached()) page.webContents.debugger.detach()
    } catch {
      // the page is already gone
    }
  }

  private sendToHost(page: ManagedPage, command: BrowserPanelCommand): void {
    const host = page.webContents.hostWebContents
    const window =
      (host === null ? null : BrowserWindow.fromWebContents(host)) ??
      BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.id === page.hostWebContentsId)
    if (window === undefined || window === null || window.isDestroyed() || window.webContents.isDestroyed()) return
    window.webContents.send(BROWSER_PANEL_COMMAND, command)
  }
}

function summary(page: ManagedPage): BrowserPanelTabInfo {
  return {
    id: page.id,
    url: page.url,
    ...(page.title.length === 0 ? {} : { title: page.title }),
    active: page.active,
    loading: page.loading,
  }
}

function optionalTabId(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  return requireTabId(value)
}

function requireTabId(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value)
  throw new CdpBridgeError("invalid_params", "The embedded browser tab id must be a number.")
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value === "boolean") return value
  throw new CdpBridgeError("invalid_params", `The embedded browser ${label} value must be a boolean.`)
}

// CDP payloads are untrusted input from the page, so only the documented
// dialog fields survive and every field keeps its declared type.
function dialogFromEvent(params: unknown): BrowserPanelDialog {
  const record = typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {}
  return {
    type: typeof record.type === "string" ? record.type : "alert",
    message: typeof record.message === "string" ? record.message : "",
    ...(typeof record.defaultPrompt === "string" ? { defaultPrompt: record.defaultPrompt } : {}),
    ...(typeof record.frameUrl === "string" ? { frameUrl: record.frameUrl } : {}),
    ...(typeof record.hasBrowserHandler === "boolean" ? { hasBrowserHandler: record.hasBrowserHandler } : {}),
  }
}

function downloadJson(record: TrackedDownload): BrowserDownload {
  return {
    id: record.id,
    url: record.url,
    filename: record.filename,
    path: record.path,
    state: record.state,
    receivedBytes: record.receivedBytes,
    totalBytes: record.totalBytes,
    startedAt: record.startedAt,
    ...(record.finishedAt === undefined ? {} : { finishedAt: record.finishedAt }),
    ...(record.mimeType === undefined ? {} : { mimeType: record.mimeType }),
    ...(record.error === undefined ? {} : { error: record.error }),
  }
}

function downloadState(value: string): BrowserDownload["state"] {
  if (value === "completed" || value === "cancelled" || value === "interrupted") return value
  return "progressing"
}

function safeMimeType(item: Electron.DownloadItem): string | undefined {
  const value = item.getMimeType()
  return value.length === 0 ? undefined : value
}

function safeDownloadError(state: string): string {
  return state === "interrupted" ? "The download was interrupted." : "The download was cancelled."
}

// A suggested filename is untrusted: strip path separators and control
// characters, then find a free name instead of overwriting an existing file.
function collisionSafeDownloadPath(directory: string, filename: string): string {
  const cleaned = basename(filename)
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/gu, "_")
    .trim()
  const base = cleaned.length === 0 || cleaned === "." || cleaned === ".." ? "download" : cleaned
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = attempt === 0 ? join(directory, base) : withDownloadSuffix(join(directory, base), attempt)
    if (!existsSync(candidate)) return candidate
  }
  return join(directory, `${randomUUID()}-${base}`)
}

function withDownloadSuffix(path: string, index: number): string {
  const extension = extname(path)
  return extension.length === 0 ? `${path}-${index}` : `${path.slice(0, -extension.length)}-${index}${extension}`
}

function isAllowedBrowserUrl(value: string): boolean {
  return isNavigableBrowserUrl(value)
}

// The roots the Omnia sandbox already exposes for browser reads and writes: the
// downloads directory plus the OS temp root. Both an image save target and an
// upload source are confined to them here, on the machine that performs the
// access, so a model-supplied path can never reach ~/.ssh or a mounted share.
function sandboxRoots(): string[] {
  return [resolve(imageDownloadsDir()), resolve(tmpdir())]
}

function isInsideRoots(target: string): boolean {
  return sandboxRoots().some((root) => {
    if (target === root) return true
    const rest = relative(root, target)
    return rest.length > 0 && !rest.startsWith("..") && !isAbsolute(rest)
  })
}

function writableImagePath(path: string, allowOutside: boolean): string {
  const target = resolve(path)
  if (allowOutside || isInsideRoots(target)) return target
  throw new CdpBridgeError(
    "path_blocked",
    "Refusing to write an image outside the Omnia downloads directory and the temporary folder.",
  )
}

// A symlink is resolved before the containment check, so an in-root link cannot
// be used to hand the guest a read anywhere else on the machine.
function isReadableUploadPath(path: string): boolean {
  try {
    return isInsideRoots(resolve(realpathSync(path)))
  } catch {
    return false
  }
}

// Response headers are attacker-influenced, so the redirect target is only read
// as text and re-asserted by the shared policy instead of being trusted.
function headerValue(headers: Record<string, string | string[]> | undefined, name: string): string | undefined {
  if (headers === undefined) return undefined
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name)
  const value = match?.[1]
  if (Array.isArray(value)) return value[0]
  return value
}

function redirectTarget(from: string, location: string): string | undefined {
  try {
    return new URL(location, from).href
  } catch {
    return undefined
  }
}

function navigableOrThrow(value: string): string {
  if (isAllowedBrowserUrl(value)) return value
  throw new CdpBridgeError(
    "url_blocked",
    `Refusing to open ${value}. Only public http(s) addresses and about:blank are allowed.`,
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// The host renderer must run its scripts before the panel can receive an open
// command, so the first send waits for the load with a bounded fallback; the
// retry loop covers a panel that subscribes after the load event.
function waitForHostLoad(contents: WebContents, timeoutMs: number): Promise<void> {
  if (!contents.isLoading()) return Promise.resolve()
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      contents.removeListener("did-finish-load", finish)
      contents.removeListener("destroyed", finish)
      resolve()
    }
    const timer = setTimeout(finish, timeoutMs)
    contents.once("did-finish-load", finish)
    contents.once("destroyed", finish)
  })
}

const manager = new EmbeddedBrowserManager()

export async function startBrowserViewBridge(): Promise<BrowserViewBridge> {
  const bridge = await manager.start()
  process.env.OMNIA_BROWSER_WS = bridge.endpoint
  process.env.OMNIA_BROWSER_TOKEN = bridge.token
  return bridge
}

export function registerBrowserViewIpc(): void {
  manager.watch()
  ipcMain.handle("browser-panel-register", (event, value: unknown) => {
    if (!isTrustedSender(event)) return undefined
    const input = parseRegisterInput(value)
    if (input === undefined) return undefined
    return manager.register(event.sender, input)
  })
  ipcMain.handle("browser-panel-unregister", (event, value: unknown) => {
    if (!isTrustedSender(event) || typeof value !== "number") return
    manager.unregisterOwned(event.sender.id, value)
  })
  ipcMain.handle("browser-panel-activate", (event, value: unknown) => {
    if (!isTrustedSender(event) || typeof value !== "number") return
    manager.activateOwned(event.sender.id, value)
  })
  ipcMain.handle("browser-panel-list", (event) => (isTrustedSender(event) ? manager.list() : []))
  ipcMain.handle("browser-panel-answer-dialog", (event, value: unknown) => {
    if (!isTrustedSender(event)) return undefined
    const input = parseAnswerDialogInput(value)
    if (input === undefined) throw new Error("The dialog answer is invalid.")
    return manager.answerDialog(event.sender.id, input.webContentsId, {
      accept: input.accept,
      ...(input.promptText === undefined ? {} : { promptText: input.promptText }),
    })
  })
}

export function destroyBrowserViewBridge(): Promise<void> {
  return manager.destroy()
}

function parseRegisterInput(value: unknown): BrowserPanelRegisterInput | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.webContentsId !== "number" || !Number.isFinite(record.webContentsId)) return undefined
  return {
    webContentsId: record.webContentsId,
    ...(typeof record.requestId === "string" ? { requestId: record.requestId } : {}),
    ...(typeof record.url === "string" ? { url: record.url } : {}),
  }
}

function parseAnswerDialogInput(
  value: unknown,
): { webContentsId: number; accept: boolean; promptText?: string } | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.webContentsId !== "number" || !Number.isFinite(record.webContentsId)) return undefined
  if (typeof record.accept !== "boolean") return undefined
  return {
    webContentsId: record.webContentsId,
    accept: record.accept,
    ...(typeof record.promptText === "string" ? { promptText: record.promptText } : {}),
  }
}

function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame
  if (frame === null || frame !== event.sender.mainFrame || event.sender.isDestroyed()) return false
  const window = BrowserWindow.fromWebContents(event.sender)
  return window !== null && !window.isDestroyed() && window.webContents === event.sender
}
