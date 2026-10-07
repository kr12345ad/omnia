// Chromium DevTools Protocol client for the embedded browser. The desktop app
// runs a token-authenticated localhost bridge in front of the active <webview>
// debugger, so standard CDP commands go straight to that page while host-level
// tab commands travel as `Omnia.*` messages handled by the desktop main process.
// Every page command carries the resolved tab id so a UI tab switch can never
// reroute the request.
//
// Security constraints: the bridge is loopback-only (ws://127.0.0.1) and every
// upgrade must present the shared token. The token is required and must never be
// logged, echoed in diagnostics, or returned by status().
//
// Billing: every page-driving and page-reading operation below asks the billing
// gate first and is refused before any work happens if the plan does not cover
// it. The charge is per operation, so an operation that returns hundreds of DOM
// nodes still costs one request. See ./entitlement.

import { mimeFromSource, resolveImagePath, verifyImageFile, writeImageFile } from "./image-file"
import { BrowserEntitlementGate } from "./entitlement"
import { captureUntrustedPayload, escapeUntrustedText, serializeUntrustedForPrompt } from "./envelope"
import { cdpModifierMask, parseKeyChord } from "./keys"
import type { KeyModifier } from "./keys"
import {
  BROWSER_RAW_TEXT_LIMIT,
  BROWSER_TEXT_LIMIT,
  MAX_FETCHED_IMAGE_BYTES,
  buildDocumentIdExpression,
  buildFindExpression,
  buildImageFetchExpression,
  buildImageResolveExpression,
  buildImagesExpression,
  buildReadExpression,
  buildRectExpression,
  buildSelectExpression,
  buildTypeExpression,
  buildTypeFocusExpression,
  buildValueExpression,
  buildViewportExpression,
  compactBrowserText,
  hashBrowserText,
  parseBrowserCandidates,
  parseBrowserImages,
  parseFindCoverage,
} from "./page-script"
import type {
  BrowserCandidate,
  BrowserImage,
  BrowserImageTarget,
  BrowserPageText,
  BrowserStatus,
  BrowserTabInfo,
} from "./page-script"
import { assertNavigableBrowserUrl, isNavigableBrowserUrl } from "./url-policy"

export { BROWSER_TEXT_LIMIT }
export type { BrowserCandidate, BrowserPageText, BrowserStatus, BrowserTabInfo }

export class CdpError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = "CdpError"
    this.code = code
  }
}

export interface CdpSocketLike {
  send(data: string): void
  close(): void
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void
  removeEventListener?(type: string, listener: (event: { data?: unknown }) => void): void
}

export interface CdpClientOptions {
  readonly url: string
  readonly timeoutMs?: number
  readonly connectTimeoutMs?: number
  readonly maxPendingCommands?: number
  readonly maxPendingEvents?: number
  readonly eventDomains?: readonly string[]
  readonly onClose?: () => void
  readonly onEvent?: (method: string, params: unknown, tabId?: string) => void
}

interface CdpMessage {
  readonly id?: number
  readonly method?: string
  readonly params?: unknown
  readonly tabId?: unknown
  readonly result?: unknown
  readonly error?: { readonly code?: number | string; readonly message?: string; readonly data?: unknown }
}

const MAX_SCREENSHOT_CHARACTERS = 48 * 1024 * 1024
const DEFAULT_MAX_PENDING_COMMANDS = 64
const DEFAULT_MAX_PENDING_EVENTS = 256
// Reload/close/create churn makes the bridge's tab list briefly empty or
// stale, so tab resolution re-lists a bounded number of times before failing.
const TAB_RESOLUTION_ATTEMPTS = 3
const TAB_RESOLUTION_DELAY_MS = 120
// Navigation can destroy the execution context between the command reply and
// the location read, so the final location is polled before giving up.
const NAVIGATION_READ_ATTEMPTS = 3
const NAVIGATION_READ_DELAY_MS = 120

// Bridge failures that mean the embedded view cannot serve this request; image
// saves fall back to an in-page fetch for these codes only.
const UNAVAILABLE_BRIDGE_CODES = new Set([
  "not_available",
  "unsupported",
  "invalid_url",
  "download_failed",
  "download_timeout",
  "not_connected",
  "connection_closed",
])

export class CdpClient {
  private socket: CdpSocketLike | undefined
  private sequence = 0
  private closed = false
  private closeHandled = false
  private pumpScheduled = false
  private droppedEvents = 0
  private messageListener: ((event: { data?: unknown }) => void) | undefined
  private closeListener: (() => void) | undefined
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  private readonly pendingEvents: Array<{ method: string; params: unknown; tabId?: string }> = []

  constructor(private readonly options: CdpClientOptions) {}

  async connect(): Promise<void> {
    if (this.socket !== undefined && !this.closed) {
      throw new CdpError("already_connected", "The embedded browser is already connected.")
    }
    const socket = new WebSocket(this.options.url) as unknown as CdpSocketLike
    await this.attach(socket)
  }

  // Attaching is separated from connecting so tests can drive the real message
  // routing with an in-memory socket.
  async attach(socket: CdpSocketLike): Promise<void> {
    if (this.socket !== undefined && !this.closed) {
      throw new CdpError("already_connected", "The embedded browser is already connected.")
    }
    this.closed = false
    this.closeHandled = false
    const timeoutMs = this.options.connectTimeoutMs ?? 15_000
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer)
        socket.removeEventListener?.("open", onOpen)
        socket.removeEventListener?.("error", onError)
      }
      const onOpen = () => {
        cleanup()
        resolve()
      }
      const onError = () => {
        cleanup()
        reject(new CdpError("connection_failed", "Could not connect to the embedded browser."))
      }
      const timer = setTimeout(() => {
        cleanup()
        try {
          socket.close()
        } catch {
          // the socket never opened
        }
        reject(new CdpError("connection_failed", "The embedded browser did not accept the debug connection in time."))
      }, timeoutMs)
      socket.addEventListener("open", onOpen)
      socket.addEventListener("error", onError)
    })
    this.messageListener = (event) => this.handleMessage(String(event.data))
    this.closeListener = () => {
      if (this.socket !== socket) return
      this.detachListeners()
      this.handleClose()
    }
    socket.addEventListener("message", this.messageListener)
    socket.addEventListener("close", this.closeListener)
    this.socket = socket
  }

  private detachListeners(): void {
    const socket = this.socket
    if (socket === undefined) return
    if (this.messageListener !== undefined) socket.removeEventListener?.("message", this.messageListener)
    if (this.closeListener !== undefined) socket.removeEventListener?.("close", this.closeListener)
    this.messageListener = undefined
    this.closeListener = undefined
  }

  private handleMessage(raw: string): void {
    let parsed: CdpMessage
    try {
      parsed = JSON.parse(raw) as CdpMessage
    } catch {
      return
    }
    if (parsed.id === undefined) {
      if (typeof parsed.method === "string" && this.acceptsEvent(parsed.method)) {
        this.enqueueEvent(
          parsed.method,
          parsed.params,
          typeof parsed.tabId === "string"
            ? parsed.tabId
            : typeof parsed.tabId === "number"
              ? String(parsed.tabId)
              : undefined,
        )
      }
      return
    }
    const entry = this.pending.get(parsed.id)
    if (entry === undefined) return
    this.pending.delete(parsed.id)
    if (parsed.error === undefined) {
      entry.resolve(parsed.result)
      return
    }
    entry.reject(
      new CdpError(
        bridgeErrorCode(parsed.error.data) ?? numericBridgeErrorCode(parsed.error.code) ?? "cdp_error",
        parsed.error.message ?? "The embedded browser command failed.",
      ),
    )
  }

  // Events are dropped unless a subscriber opts in to the event's domain, so a
  // chatty page cannot flood an uninterested consumer.
  private acceptsEvent(method: string): boolean {
    if (this.options.onEvent === undefined) return false
    const domains = this.options.eventDomains
    if (domains === undefined || domains.length === 0) return false
    return domains.some((domain) => method.startsWith(`${domain}.`))
  }

  private enqueueEvent(method: string, params: unknown, tabId: string | undefined): void {
    const max = this.options.maxPendingEvents ?? DEFAULT_MAX_PENDING_EVENTS
    if (this.pendingEvents.length >= max) {
      this.droppedEvents += 1
      return
    }
    this.pendingEvents.push({ method, params, ...(tabId === undefined ? {} : { tabId }) })
    if (this.pumpScheduled) return
    this.pumpScheduled = true
    queueMicrotask(() => this.pumpEvents())
  }

  private pumpEvents(): void {
    this.pumpScheduled = false
    while (this.pendingEvents.length > 0) {
      const event = this.pendingEvents.shift()
      if (event === undefined) return
      this.options.onEvent?.(event.method, event.params, event.tabId)
    }
  }

  private handleClose(): void {
    this.closed = true
    this.pendingEvents.length = 0
    if (this.closeHandled) return
    this.closeHandled = true
    for (const entry of this.pending.values()) {
      entry.reject(new CdpError("connection_closed", "The embedded browser connection closed."))
    }
    this.pending.clear()
    this.options.onClose?.()
  }

  get droppedEventCount(): number {
    return this.droppedEvents
  }

  async send<T = unknown>(method: string, params: Record<string, unknown> = {}, tabId?: string): Promise<T> {
    if (this.socket === undefined || this.closed) {
      throw new CdpError("not_connected", "The embedded browser is not connected.")
    }
    if (this.pending.size >= (this.options.maxPendingCommands ?? DEFAULT_MAX_PENDING_COMMANDS)) {
      throw new CdpError("busy", "The embedded browser has too many commands in flight.")
    }
    const id = ++this.sequence
    const timeoutMs = this.options.timeoutMs ?? 30000
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new CdpError("timeout", `The embedded browser did not answer ${method} in time.`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value as T)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      const message = tabId === undefined ? { id, method, params } : { id, method, params, tabId }
      try {
        this.socket!.send(JSON.stringify(message))
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(
          new CdpError(
            "send_failed",
            error instanceof Error ? error.message : "The embedded browser command could not be sent.",
          ),
        )
      }
    })
  }

  get connected(): boolean {
    return this.socket !== undefined && !this.closed
  }

  close(): void {
    this.detachListeners()
    const socket = this.socket
    this.socket = undefined
    this.handleClose()
    try {
      socket?.close()
    } catch {
      // already closed
    }
  }

  rejectPending(error: Error): void {
    const entries = [...this.pending.values()]
    this.pending.clear()
    for (const entry of entries) entry.reject(error)
  }
}

export interface CdpTransport {
  send<T = unknown>(method: string, params?: Record<string, unknown>, tabId?: string): Promise<T>
  close(): void
  // Rejects every in-flight command so a blocking dialog does not stall them
  // until the transport timeout.
  rejectPending?(error: Error): void
  readonly connected: boolean
}

// The independently read state after a reload or history move. The bridge
// command is only the trigger; url and documentId come from the page itself.
export interface CdpNavigationResult {
  readonly url: string
  readonly documentId?: string
}

export interface CdpDialog {
  readonly type: string
  readonly message: string
  readonly defaultPrompt?: string
  readonly frameUrl?: string
  readonly hasBrowserHandler?: boolean
}

export interface CdpDialogAnswer {
  readonly tabId?: string
  readonly sessionId?: string
  readonly accept: boolean
  readonly promptText?: string
  readonly expectedType?: string
  readonly expectedMessage?: string
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

export interface CdpAuthChallenge {
  readonly url: string
  readonly host: string
  readonly realm: string
  readonly isProxy: boolean
}

export interface CdpRuntimeOptions {
  readonly endpoint: string
  readonly token: string
  readonly transport?: CdpTransport
  readonly timeoutMs?: number
  readonly log?: (message: string, meta?: Record<string, unknown>) => void
  /**
   * Billing gate for browser_automation. Defaults to whatever the environment
   * configures, and is inert when no control plane is configured - see
   * BrowserEntitlementGate.fromEnv.
   */
  readonly entitlement?: BrowserEntitlementGate
}

interface CdpEvaluateResult {
  readonly result?: { readonly value?: unknown; readonly type?: string }
  readonly exceptionDetails?: { readonly text?: string }
}

interface RawTab {
  readonly id: string
  readonly url: string
  readonly title?: string
  readonly active?: boolean
}

const MODIFIER_KEYS: Readonly<Record<KeyModifier, { code: string; keyCode: number }>> = {
  Alt: { code: "AltLeft", keyCode: 18 },
  Control: { code: "ControlLeft", keyCode: 17 },
  Meta: { code: "MetaLeft", keyCode: 91 },
  Shift: { code: "ShiftLeft", keyCode: 16 },
}

const MOUSE_BUTTON_MASKS = { left: 1, right: 2, middle: 4 } as const

// The world the page scripts are evaluated in. An isolated world shares the DOM
// with the page but not its window properties, so the ref/document state the
// scripts keep there can neither be read nor replaced by page script.
const ISOLATED_WORLD_NAME = "omnia-browser-refs"

// Element and image refs are page-script ids: "<kind>-<seq>@<documentId>".
// Validating the whole shape here means no caller-supplied string ever reaches
// a page-side map key or selector, so a lookalike ref fails closed instead of
// re-pointing an action at a page-chosen element.
const ELEMENT_REF = /^omnia-\d+@[A-Za-z0-9_-]{1,64}$/
const IMAGE_REF = /^img-\d+@[A-Za-z0-9_-]{1,64}$/
// A base64 image body is ~4/3 of its decoded size; the generous multiplier
// only has to stop an unbounded page-controlled string from being decoded.
const MAX_IMAGE_SOURCE_CHARACTERS = MAX_FETCHED_IMAGE_BYTES * 2
// A data: URL carries no host for the navigation allowlist to check, so the
// source check is on its declared media type instead: only a base64 image
// payload is ever written, never markup or a script that would run if the file
// were opened. The media type is page- and server-supplied, so it is matched
// against this shape rather than trusted, and the decoded size is capped here as
// well as in the page (a base64 string under the character cap still decodes to
// more than MAX_FETCHED_IMAGE_BYTES).
const BASE64_IMAGE_DATA_URL = /^data:(image\/[A-Za-z0-9.+-]+)((?:;[^,;]*)*);base64,([\s\S]*)$/u

export class CdpRuntime {
  private transport: CdpTransport | undefined
  private injected = false
  private readonly lastTabIds = new Map<string, string>()
  private readonly dialogs = new Map<string, CdpDialog>()
  // Pending HTTP auth challenges reported by Omnia.authRequired events,
  // keyed by tab id (or "default" when the bridge omitted one).
  private readonly authChallenges = new Map<string, CdpAuthChallenge>()
  // Pending file choosers reported by Page.fileChooserOpened events,
  // keyed by tab id (or "default" when the bridge omitted one).
  private readonly fileChoosers = new Map<string, { backendNodeId: number; mode?: string }>()
  // Execution context ids of the per-tab isolated world, and the tabs whose
  // Fetch interception is armed. Both are per-session state: the debugger
  // detach (or a navigation, for the world) drops them again.
  private readonly isolatedWorlds = new Map<string, number>()
  private readonly intercepted = new Set<string>()
  private readonly options: CdpRuntimeOptions
  private readonly entitlements: BrowserEntitlementGate

  constructor(options: CdpRuntimeOptions) {
    if (options.endpoint.length === 0 || options.token.length === 0) {
      throw new CdpError("not_available", "The embedded browser is not available.")
    }
    this.options = options
    this.transport = options.transport
    this.entitlements = options.entitlement ?? BrowserEntitlementGate.fromEnv()
  }

  /**
   * The billing gate for page work.
   *
   * Checked at the top of every operation below, before the bridge is touched,
   * so an exhausted allowance refuses the action instead of performing it and
   * reporting the problem afterwards.
   */
  async authorizeBrowserOperation(): Promise<void> {
    await this.entitlements.authorize("browser_automation")
  }

  /** The gate itself, so a composite action can charge one request for a span. */
  get entitlementGate(): BrowserEntitlementGate {
    return this.entitlements
  }

  get connected(): boolean {
    return this.transport?.connected === true
  }

  async ensure(): Promise<void> {
    await this.ensureTransport()
  }

  private url(): string {
    const separator = this.options.endpoint.includes("?") ? "&" : "?"
    return `${this.options.endpoint}${separator}token=${encodeURIComponent(this.options.token)}`
  }

  private async ensureTransport(): Promise<CdpTransport> {
    if (this.transport?.connected === true) return this.transport
    if (this.options.transport !== undefined) {
      if (this.options.transport.connected) {
        this.transport = this.options.transport
        return this.options.transport
      }
      if (!this.injected) {
        this.injected = true
        this.transport = this.options.transport
        return this.options.transport
      }
      this.transport = undefined
      throw new CdpError("not_connected", "The embedded browser is not connected.")
    }
    const client = new CdpClient({
      url: this.url(),
      ...(this.options.timeoutMs === undefined ? {} : { timeoutMs: this.options.timeoutMs }),
      // Dialog and auth state come from Page/Omnia events; without an explicit
      // subscription the client drops every event and both are invisible.
      eventDomains: ["Fetch", "Page", "Omnia"],
      onEvent: (method, params, tabId) => this.handleBrowserEvent(method, params, tabId),
      onClose: () => {
        this.transport = undefined
        this.lastTabIds.clear()
        this.authChallenges.clear()
        this.fileChoosers.clear()
        // A dropped socket can leave a dialog, chooser, or auth challenge
        // behind with no page to answer it, so nothing survives the close.
        this.dialogs.clear()
        this.isolatedWorlds.clear()
        this.intercepted.clear()
      },
    })
    try {
      await client.connect()
    } catch (error) {
      this.options.log?.("embedded browser connection failed", {
        error: redactToken(error instanceof Error ? error.message : String(error), this.options.token),
      })
      throw error
    }
    this.transport = client
    return client
  }

  private async send<T>(method: string, params: Record<string, unknown> = {}, tabId?: string): Promise<T> {
    const transport = await this.ensureTransport()
    try {
      return await transport.send<T>(method, params, tabId)
    } catch (error) {
      // A timed-out or failed send means the transport may be half-open, so
      // the next call reconnects instead of waiting on the same socket.
      if (
        error instanceof CdpError &&
        (error.code === "connection_closed" ||
          error.code === "not_connected" ||
          error.code === "timeout" ||
          error.code === "send_failed")
      ) {
        transport.close()
        this.transport = undefined
      }
      throw error
    }
  }

  // Page scripts keep their ref maps on the window of the world they are
  // evaluated in, so every evaluation runs in a dedicated isolated world: the
  // page shares the DOM with it but never its globals. A bridge too old to
  // create the world still works, with only the id-shape validation and the
  // landed-url policy standing between a page and a stale-ref retarget.
  private async isolatedContext(tabId: string): Promise<number | undefined> {
    const cached = this.isolatedWorlds.get(tabId)
    if (cached !== undefined) return cached
    const tree = await this.send<{ frameTree?: { frame?: { id?: unknown } } }>("Page.getFrameTree", {}, tabId).catch(
      () => undefined,
    )
    const frameId = tree?.frameTree?.frame?.id
    if (typeof frameId !== "string" || frameId.length === 0) return undefined
    const world = await this.send<{ executionContextId?: unknown }>(
      "Page.createIsolatedWorld",
      { frameId, worldName: ISOLATED_WORLD_NAME, grantUniveralAccess: false },
      tabId,
    ).catch(() => undefined)
    const contextId = world?.executionContextId
    if (typeof contextId !== "number") return undefined
    this.isolatedWorlds.set(tabId, contextId)
    return contextId
  }

  private async evaluateValueOn(tabId: string, expression: string): Promise<unknown> {
    const contextId = await this.isolatedContext(tabId)
    try {
      return await this.evaluateOn(tabId, expression, contextId)
    } catch (error) {
      // A cross-document navigation destroys the world the context id belongs
      // to, which races the command reply; the retry re-creates the world once
      // instead of failing a command that ran against a valid document.
      if (contextId === undefined || !isStaleContextError(error)) throw error
      this.isolatedWorlds.delete(tabId)
      return this.evaluateOn(tabId, expression, await this.isolatedContext(tabId))
    }
  }

  private async evaluateOn(tabId: string, expression: string, contextId: number | undefined): Promise<unknown> {
    const result = await this.send<CdpEvaluateResult>(
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
        awaitPromise: true,
        ...(contextId === undefined ? {} : { contextId }),
      },
      tabId,
    )
    if (result.exceptionDetails !== undefined) {
      throw new CdpError("evaluate_failed", result.exceptionDetails.text ?? "The page could not evaluate the script.")
    }
    return result.result?.value
  }

  private async evaluateJsonOn(tabId: string, expression: string): Promise<unknown> {
    const value = await this.evaluateValueOn(tabId, expression)
    if (typeof value !== "string") throw new CdpError("evaluate_failed", "The page returned an unexpected value.")
    try {
      return JSON.parse(value) as unknown
    } catch {
      throw new CdpError("evaluate_failed", "The page returned invalid JSON.")
    }
  }

  private async rawTabs(): Promise<RawTab[]> {
    const result = await this.send<{ tabs?: unknown }>("Omnia.tabs", {})
    if (result === null || typeof result !== "object" || !Array.isArray(result.tabs)) {
      throw new CdpError("cdp_error", "The embedded browser returned an unexpected tab list.")
    }
    return result.tabs.flatMap((item): RawTab[] => {
      if (typeof item !== "object" || item === null) return []
      const record = item as Record<string, unknown>
      if (typeof record.id !== "string" && typeof record.id !== "number") return []
      return [
        {
          id: String(record.id),
          url: typeof record.url === "string" ? record.url : "",
          ...(typeof record.title === "string" ? { title: record.title } : {}),
          ...(record.active === true ? { active: true } : {}),
        },
      ]
    })
  }

  private async activateTab(tabId: string): Promise<void> {
    await this.send("Omnia.activate", { tabId })
    if ((await this.confirmActive(tabId)) !== false) return
    await this.send("Omnia.activate", { tabId })
    if ((await this.confirmActive(tabId)) !== false) return
    this.options.log?.("embedded browser did not activate the requested tab", { tabId })
    throw new CdpError("activate_failed", "The embedded browser did not activate the requested tab.")
  }

  // Returns false when the bridge explicitly reports a different active tab,
  // true when the activation is confirmed, and undefined when the bridge does
  // not answer Omnia.currentTab (older builds) so activation is not treated as
  // failed without evidence.
  private async confirmActive(tabId: string): Promise<boolean | undefined> {
    const result = await this.send<{ tabId?: unknown }>("Omnia.currentTab").catch(() => undefined)
    if (result === null || typeof result !== "object") return undefined
    const active = (result as Record<string, unknown>).tabId
    if (active === undefined) return undefined
    return active !== null && String(active) === tabId
  }

  // The bridge owns tab identity. An explicit id is a contract: it is never
  // retargeted to another page, so a missing explicit tab fails closed as
  // tab_not_found after a short re-list window that tolerates churn. Without
  // an explicit id, a remembered or active tab is selected and a tab that
  // vanishes between listing and activation is re-resolved instead of failing.
  private async resolveTab(tabId?: string, sessionId?: string): Promise<string> {
    const scope = sessionId ?? "default"
    const explicit = tabId !== undefined && tabId.length > 0 ? tabId : undefined
    let lastError: CdpError | undefined
    for (let attempt = 0; attempt < TAB_RESOLUTION_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await sleep(TAB_RESOLUTION_DELAY_MS)
      const tabs = await this.rawTabs()
      const preferred = this.preferredTab(tabs, explicit, scope)
      if (preferred === undefined) {
        if (explicit !== undefined) {
          this.options.log?.("embedded browser tab id is not in the bridge tab list", { tabId: explicit })
          this.lastTabIds.delete(scope)
          lastError = new CdpError("tab_not_found", `The embedded browser tab ${explicit} is not open.`)
          continue
        }
        lastError = new CdpError("no_tabs", "The embedded browser has no navigable tab.")
        continue
      }
      try {
        await this.armNavigationPolicy(preferred)
        await this.activateTab(preferred)
        this.lastTabIds.set(scope, preferred)
        return preferred
      } catch (error) {
        if (error instanceof CdpError && error.code === "activate_failed") {
          // The tab exists; a UI focus race must not fail a page command,
          // because every page command carries the resolved tab id.
          this.options.log?.("embedded browser could not confirm tab activation", { tabId: preferred })
          this.lastTabIds.set(scope, preferred)
          return preferred
        }
        if (!isMissingTabError(error)) throw error
        // The tab disappeared between listing and activation: re-list.
        if (preferred === explicit || preferred === this.lastTabIds.get(scope)) this.lastTabIds.delete(scope)
        lastError =
          preferred === explicit
            ? new CdpError("tab_not_found", `The embedded browser tab ${explicit} is not open.`)
            : error
      }
    }
    throw lastError ?? new CdpError("no_tabs", "The embedded browser has no navigable tab.")
  }

  private preferredTab(tabs: RawTab[], explicit: string | undefined, scope: string): string | undefined {
    if (explicit !== undefined) return tabs.some((tab) => tab.id === explicit) ? explicit : undefined
    const remembered = this.lastTabIds.get(scope)
    if (remembered !== undefined) {
      const match = tabs.find((tab) => tab.id === remembered)
      if (match !== undefined && isNavigableTab(match)) return remembered
    }
    const active = tabs.find((tab) => tab.active === true && isNavigableTab(tab))
    return active?.id ?? tabs.find(isNavigableTab)?.id
  }

  // Asserting the caller's URL once is not enough: a redirect, a meta refresh,
  // or a link click can move the page onto loopback or cloud metadata long
  // after navigate() returned. Every request the page starts is therefore
  // paused at the request stage and re-asserted here, so the policy follows the
  // document instead of the request that opened it. The desktop shell enforces
  // the same allowlist on will-frame-navigate / will-redirect and on its
  // partition webRequest filter when no controller is attached.
  private async armNavigationPolicy(tabId: string): Promise<void> {
    if (this.intercepted.has(tabId)) return
    await this.send("Fetch.enable", { patterns: [{ requestStage: "Request" }] }, tabId).catch((error) => {
      this.options.log?.("embedded browser request interception could not be armed", {
        tabId,
        error: redactToken(error instanceof Error ? error.message : String(error), this.options.token),
      })
    })
    this.intercepted.add(tabId)
  }

  private handlePausedRequest(key: string, params: unknown): void {
    const record = typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {}
    const requestId = typeof record.requestId === "string" ? record.requestId : undefined
    if (requestId === undefined) return
    const target = key === "default" ? undefined : key
    const request =
      typeof record.request === "object" && record.request !== null
        ? (record.request as Record<string, unknown>)
        : undefined
    // Chromium reports the paused URL at params.request.url; a flat requestUrl
    // is only a fallback for bridges that pre-shape the event. Reading the
    // wrong key yields "", which fails the allowlist and aborts every request.
    const url =
      typeof request?.url === "string"
        ? request.url
        : typeof record.requestUrl === "string"
          ? record.requestUrl
          : ""
    if (isNavigableBrowserUrl(url)) {
      void this.send("Fetch.continueRequest", { requestId }, target).catch(() => undefined)
      return
    }
    this.options.log?.("embedded browser blocked a request to a non-public address", { tabId: key, url })
    // A blocked document request is the redirect/meta-refresh case: the tab is
    // dropped so nothing can read the private body it was steered to.
    if (record.resourceType === "Document") this.forgetTab(key, url)
    void this.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, target).catch(() => undefined)
  }

  // Every piece of per-tab state is dropped together with the tab itself: a
  // phantom dialog or chooser left behind by a dropped tab would otherwise make
  // every later action fail as dialog_open forever.
  private forgetTab(tabId: string, url: string): void {
    this.options.log?.("embedded browser tab left the navigable set", { tabId, url })
    this.dialogs.delete(tabId)
    this.authChallenges.delete(tabId)
    this.fileChoosers.delete(tabId)
    this.isolatedWorlds.delete(tabId)
    for (const [scope, id] of this.lastTabIds) {
      if (id === tabId) this.lastTabIds.delete(scope)
    }
    void this.closeTab(tabId).catch(() => undefined)
  }

  // The landed location is the source of truth, so it is re-asserted wherever
  // page content reaches the model instead of trusting the URL that opened the
  // tab. A tab that landed on a blocked address is closed, not just reported.
  private assertLanded(tabId: string, url: string): string {
    if (isNavigableBrowserUrl(url)) return url
    this.forgetTab(tabId, url)
    throw new CdpError("url_blocked", "The page moved to a blocked address, so the tab was closed.")
  }

  private async ensureReadyOn(tabId: string): Promise<void> {
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const state = await this.evaluateJsonOn(tabId, "JSON.stringify(document.readyState)").catch(() => undefined)
      if (state === "complete" || state === "interactive") return
      await new Promise((resolve) => setTimeout(resolve, 120))
    }
    throw new CdpError("load_timeout", "The page did not finish loading in time.")
  }

  async status(): Promise<BrowserStatus> {
    const tabs = await this.rawTabs()
    return {
      // Running means the bridge can reach a page, not merely that the bridge
      // answered: an empty tab list is the degraded churn state and must not
      // be reported as a healthy runtime.
      running: tabs.length > 0,
      endpoint: redactedEndpoint(this.options.endpoint),
      browser: "embedded",
      tabs: tabs.length,
    }
  }

  async tabs(): Promise<BrowserTabInfo[]> {
    const tabs = await this.rawTabs()
    // A tab that landed on a blocked address is never listed: the model must not
    // be able to select it, and it is closed instead of silently kept around. A
    // tab with no URL yet (still on its first navigation) is left alone: it has
    // not been anywhere.
    return tabs.flatMap((tab) => {
      if (tab.url.length === 0 || isNavigableBrowserUrl(tab.url)) {
        return [
          {
            ...tab,
            ...(tab.title === undefined ? {} : { title: escapeUntrustedText(tab.title) }),
            url: escapeUntrustedText(tab.url),
          },
        ]
      }
      this.forgetTab(tab.id, tab.url)
      return []
    })
  }

  async open(url = "about:blank"): Promise<BrowserTabInfo> {
    const target = url.length === 0 ? "about:blank" : assertNavigableBrowserUrl(url)
    // After the URL policy, before the bridge: a target the allowlist rejects
    // never becomes a metered request because nothing was ever attempted.
    await this.authorizeBrowserOperation()
    const before = await this.rawTabs().catch(() => [] as RawTab[])
    let result: { tab?: unknown }
    try {
      result = await this.send<{ tab?: unknown }>("Omnia.open", { url: target })
    } catch (error) {
      // The desktop bridge can time out or report no host window before the
      // renderer registers a new <webview>. When the tab did open anyway,
      // re-listing the bridge is the source of truth and the open is reported
      // as success. A genuine failure caches nothing, so the next open retries
      // the whole bridge handshake from the live tab list.
      if (!(error instanceof CdpError) || !isRecoverableOpenError(error)) throw error
      const appeared = await this.recoverOpenedTab(before, target).catch(() => undefined)
      if (appeared === undefined) {
        this.lastTabIds.delete("default")
        throw error
      }
      this.lastTabIds.set("default", appeared.id)
      await this.activateTab(appeared.id).catch((activationError) => {
        this.options.log?.("embedded browser recovered a tab but could not confirm activation", {
          tabId: appeared.id,
          error: redactToken(
            activationError instanceof Error ? activationError.message : String(activationError),
            this.options.token,
          ),
        })
      })
      return {
        id: appeared.id,
        url: escapeUntrustedText(appeared.url),
        ...(appeared.title === undefined ? {} : { title: escapeUntrustedText(appeared.title) }),
      }
    }
    if (result === null || typeof result !== "object" || typeof result.tab !== "object" || result.tab === null) {
      throw new CdpError("open_failed", "The embedded browser did not return a tab.")
    }
    const record = result.tab as Record<string, unknown>
    if (typeof record.id !== "string" && typeof record.id !== "number") {
      throw new CdpError("open_failed", "The embedded browser did not return a tab id.")
    }
    const id = String(record.id)
    this.lastTabIds.set("default", id)
    // The tab is open and page commands carry its id, so an activation the
    // bridge cannot confirm is not an open failure.
    await this.activateTab(id).catch((error) => {
      this.options.log?.("embedded browser opened a tab but could not confirm activation", {
        tabId: id,
        error: redactToken(error instanceof Error ? error.message : String(error), this.options.token),
      })
    })
    return {
      id,
      url: escapeUntrustedText(typeof record.url === "string" ? record.url : target),
      ...(typeof record.title === "string" ? { title: escapeUntrustedText(record.title) } : {}),
    }
  }

  private async recoverOpenedTab(before: RawTab[], target: string): Promise<RawTab | undefined> {
    const known = new Set(before.map((tab) => tab.id))
    const appeared = (await this.rawTabs()).filter((tab) => !known.has(tab.id))
    return appeared.find((tab) => tab.url === target) ?? appeared.find(isNavigableTab) ?? appeared[0]
  }

  async activate(tabId: string): Promise<void> {
    try {
      await this.activateTab(tabId)
      this.lastTabIds.set("default", tabId)
      return
    } catch (error) {
      if (!isMissingTabError(error)) throw error
      // A missing explicit target fails closed; silently activating a
      // different tab would make the caller believe its tab is focused.
      this.options.log?.("embedded browser activate target is gone", { tabId })
      this.lastTabIds.delete("default")
      throw new CdpError("tab_not_found", `The embedded browser tab ${tabId} is not open.`)
    }
  }

  async closeTab(tabId: string): Promise<void> {
    try {
      await this.send("Omnia.close", { tabId })
    } catch (error) {
      // Closing a tab that is already gone has the intended effect; forget it
      // so no later action keeps targeting the missing id.
      if (!isMissingTabError(error)) throw error
    }
    for (const [scope, id] of this.lastTabIds) {
      if (id === tabId) this.lastTabIds.delete(scope)
    }
  }

  async navigate(url: string, tabId?: string, sessionId?: string): Promise<BrowserTabInfo> {
    const target = assertNavigableBrowserUrl(url)
    await this.authorizeBrowserOperation()
    const context = await this.resolveTab(tabId, sessionId)
    const before = await this.evaluateValueOn(context, "location.href").catch(() => undefined)
    let failure: CdpError | undefined
    try {
      await this.send("Page.navigate", { url: target }, context)
    } catch (error) {
      if (!(error instanceof CdpError)) throw error
      failure = error
    }
    // The final location is the source of truth: navigations can outlive a
    // dead execution context or an aborted command reply, and must not be
    // reported as failures when the page actually moved.
    const current = await this.readLocation(context)
    if (current !== undefined) {
      if (failure === undefined || typeof before !== "string" || current !== before) {
        this.lastTabIds.set(sessionId ?? "default", context)
        return { id: context, url: escapeUntrustedText(this.assertLanded(context, current)) }
      }
      throw failure
    }
    if (failure !== undefined) throw failure
    throw new CdpError("load_timeout", "The page did not finish loading in time.")
  }

  private async readLocation(tabId: string): Promise<string | undefined> {
    for (let attempt = 0; attempt < NAVIGATION_READ_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await sleep(NAVIGATION_READ_DELAY_MS)
      await this.ensureReadyOn(tabId).catch(() => undefined)
      const current = await this.evaluateValueOn(tabId, "location.href").catch(() => undefined)
      if (typeof current === "string" && current.length > 0) return current
    }
    return undefined
  }

  async back(tabId?: string, sessionId?: string): Promise<CdpNavigationResult> {
    await this.authorizeBrowserOperation()
    const context = await this.resolveTab(tabId, sessionId)
    await this.sendHistory("Omnia.back", context, "There is no previous page in this tab.")
    return this.readNavigation(context, sessionId)
  }

  async forward(tabId?: string, sessionId?: string): Promise<CdpNavigationResult> {
    await this.authorizeBrowserOperation()
    const context = await this.resolveTab(tabId, sessionId)
    await this.sendHistory("Omnia.forward", context, "There is no next page in this tab.")
    return this.readNavigation(context, sessionId)
  }

  async reload(tabId?: string, sessionId?: string): Promise<CdpNavigationResult> {
    await this.authorizeBrowserOperation()
    const context = await this.resolveTab(tabId, sessionId)
    // Never raw Page.reload: on Electron it reloads the embedder window. The
    // desktop bridge owns the equivalent WebContents reload.
    const result = await this.send<{ reloaded?: unknown }>(
      "Omnia.reload",
      { tabId: context, ignoreCache: false },
      context,
    )
    if (result?.reloaded !== true) {
      throw new CdpError("cdp_error", "The embedded browser did not confirm the reload.")
    }
    return this.readNavigation(context, sessionId)
  }

  // The bridge reports a history move, but the page itself is the evidence:
  // the returned state always comes from an independent location read.
  private async sendHistory(
    method: "Omnia.back" | "Omnia.forward",
    tabId: string,
    noHistoryMessage: string,
  ): Promise<void> {
    let result: { navigated?: unknown }
    try {
      result = await this.send<{ navigated?: unknown }>(method, { tabId }, tabId)
    } catch (error) {
      if (error instanceof CdpError && error.code === "no_history") throw new CdpError("no_history", noHistoryMessage)
      throw error
    }
    if (result?.navigated !== true) throw new CdpError("no_history", noHistoryMessage)
  }

  private async readNavigation(tabId: string, sessionId?: string): Promise<CdpNavigationResult> {
    const url = await this.readLocation(tabId)
    if (url === undefined) throw new CdpError("load_timeout", "The page did not finish loading in time.")
    this.lastTabIds.set(sessionId ?? "default", tabId)
    this.assertLanded(tabId, url)
    const documentId = await this.evaluateValueOn(tabId, buildDocumentIdExpression()).catch(() => undefined)
    return {
      url: escapeUntrustedText(url),
      ...(typeof documentId === "string" && documentId.length > 0 ? { documentId } : {}),
    }
  }

  private handleBrowserEvent(method: string, params: unknown, tabId?: string): void {
    const key = tabId ?? "default"
    if (method === "Page.javascriptDialogOpening") {
      const record = typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {}
      this.dialogs.set(key, {
        type: typeof record.type === "string" && record.type.length > 0 ? record.type : "alert",
        message: typeof record.message === "string" ? record.message : "",
        ...(typeof record.defaultPrompt === "string" ? { defaultPrompt: record.defaultPrompt } : {}),
        ...(typeof record.url === "string" ? { frameUrl: record.url } : {}),
        ...(record.hasBrowserHandler === true ? { hasBrowserHandler: true } : {}),
      })
      // A dialog blocks the renderer, so every in-flight page command would
      // otherwise stall until its transport timeout. Fail them now with a
      // typed code the server can surface to the agent.
      this.transport?.rejectPending?.(
        new CdpError("dialog_open", "A JavaScript dialog is open on the page; answer it with browser_dialog."),
      )
      return
    }
    if (method === "Page.javascriptDialogClosed") this.dialogs.delete(key)
    if (method === "Fetch.requestPaused") {
      this.handlePausedRequest(key, params)
      return
    }
    if (method === "Page.fileChooserOpened") {
      const record = typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {}
      const backendNodeId = typeof record.backendNodeId === "number" ? record.backendNodeId : undefined
      if (backendNodeId === undefined) return
      this.fileChoosers.set(key, {
        backendNodeId,
        ...(typeof record.mode === "string" ? { mode: record.mode } : {}),
      })
      // The chooser blocks the page, so every in-flight page command would
      // otherwise stall until its transport timeout. Fail them now with a
      // typed code the server can surface to the agent.
      this.transport?.rejectPending?.(
        new CdpError("file_chooser_open", "The page is waiting for files; answer it with browser_upload."),
      )
      return
    }
    if (method === "Omnia.did-navigate" || method === "Omnia.did-navigate-in-page") {
      this.fileChoosers.delete(key)
      this.fileChoosers.delete("default")
      // A moved page has no open dialog, and the world the scripts kept their
      // ref state in died with the old document.
      this.dialogs.delete(key)
      this.isolatedWorlds.delete(key)
      return
    }
    // A crashed tab never answers a dialog, chooser, or auth challenge again, so
    // the pending state is dropped with it instead of blocking every later
    // action until the process restarts.
    if (method === "Omnia.render-process-gone" || method === "Inspector.targetCrashed") {
      this.dialogs.delete(key)
      this.authChallenges.delete(key)
      this.fileChoosers.delete(key)
      this.isolatedWorlds.delete(key)
      return
    }
    // The debugger owns the Fetch interception and the isolated world; when it
    // detaches both are gone with it.
    if (method === "Inspector.detached") {
      this.intercepted.delete(key)
      this.isolatedWorlds.delete(key)
      this.dialogs.delete(key)
      return
    }
    if (method === "Omnia.authRequired") {
      const record = typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {}
      this.authChallenges.set(key, {
        url: typeof record.url === "string" ? record.url : "",
        host: typeof record.host === "string" ? record.host : "",
        realm: typeof record.realm === "string" ? record.realm : "",
        isProxy: record.isProxy === true,
      })
      // The challenge blocks the guest until it is answered, so the in-flight
      // navigation must fail now instead of stalling the whole remote agent.
      this.transport?.rejectPending?.(
        new CdpError("auth_required", "The page is waiting for HTTP authentication; answer it with browser_auth."),
      )
      return
    }
    if (method === "Omnia.auth") this.authChallenges.delete(key)
  }

  private dialogFor(tabId: string): CdpDialog | undefined {
    return this.dialogs.get(tabId) ?? this.dialogs.get("default")
  }

  async currentDialog(tabId?: string, sessionId?: string): Promise<CdpDialog | null> {
    if (tabId === undefined) {
      const first = this.dialogs.values().next().value
      return first ?? null
    }
    const context = await this.resolveTab(tabId, sessionId).catch(() => undefined)
    if (context === undefined) return this.dialogs.get("default") ?? null
    return this.dialogFor(context) ?? null
  }

  async handleDialog(input: CdpDialogAnswer): Promise<{ handled: boolean }> {
    await this.authorizeBrowserOperation()
    const context =
      input.tabId === undefined ? undefined : await this.resolveTab(input.tabId, input.sessionId).catch(() => undefined)
    const entry = (() => {
      if (context !== undefined) {
        const dialog = this.dialogFor(context)
        if (dialog !== undefined) return { key: context, dialog }
      }
      const first = this.dialogs.entries().next().value
      if (first === undefined) return undefined
      return { key: first[0], dialog: first[1] }
    })()
    if (entry === undefined) throw new CdpError("dialog_not_open", "No JavaScript dialog is open.")
    if (input.expectedType !== undefined && input.expectedType !== entry.dialog.type) {
      throw new CdpError("dialog_mismatch", `The open dialog is ${entry.dialog.type}, not ${input.expectedType}.`)
    }
    if (input.expectedMessage !== undefined && input.expectedMessage !== entry.dialog.message) {
      throw new CdpError("dialog_mismatch", "The open dialog message does not match the expected message.")
    }
    const envelopeTab = entry.key === "default" ? context : entry.key
    const result = await this.send<{ handled?: unknown }>(
      "Omnia.handleDialog",
      {
        ...(envelopeTab === undefined ? {} : { tabId: envelopeTab }),
        accept: input.accept,
        ...(input.promptText === undefined ? {} : { promptText: input.promptText }),
      },
      envelopeTab,
    )
    if (result?.handled !== true) throw new CdpError("cdp_error", "The embedded browser did not answer the dialog.")
    this.dialogs.delete(entry.key)
    return { handled: true }
  }

  async read(
    tabId?: string,
    options?: { offset?: number; limit?: number; sessionId?: string },
  ): Promise<BrowserPageText> {
    await this.authorizeBrowserOperation()
    const context = await this.resolveTab(tabId, options?.sessionId)
    await this.ensureReadyOn(context)
    const raw = (await this.evaluateJsonOn(context, buildReadExpression())) as {
      url?: string
      title?: string
      text?: string
      viewport?: { width?: number; height?: number }
      documentId?: string
      framesVisited?: number
      framesSkipped?: number
      shadowRoots?: number
      sourceTruncated?: boolean
      complete?: boolean
      warning?: string
    }
    const full = compactBrowserText(raw.text ?? "")
    const offset = Math.max(0, options?.offset ?? 0)
    const limit = Math.max(0, options?.limit ?? BROWSER_TEXT_LIMIT)
    const text = full.slice(offset, offset + limit)
    // A redirect or meta refresh can move the page off the allowlist after
    // navigate() returned, so the URL this payload came from is re-asserted
    // before any of its text reaches the model.
    const rawUrl = typeof raw.url === "string" && raw.url.length > 0 ? this.assertLanded(context, raw.url) : ""
    const rawTitle = raw.title ?? ""
    const url = escapeUntrustedText(rawUrl)
    const title = escapeUntrustedText(rawTitle)
    const truncated = offset + text.length < full.length
    const sourceTruncated =
      raw.sourceTruncated === true || (raw.text !== undefined && raw.text.length >= BROWSER_RAW_TEXT_LIMIT)
    const framesSkipped = typeof raw.framesSkipped === "number" ? raw.framesSkipped : 0
    const framesVisited = typeof raw.framesVisited === "number" ? raw.framesVisited : 1
    const shadowRoots = typeof raw.shadowRoots === "number" ? raw.shadowRoots : 0
    // The hash only claims the full page when every reachable frame was read
    // and the source was not truncated; otherwise it is the hash of the
    // collected portion and complete === false says so explicitly. Legacy
    // page payloads without an explicit complete flag are treated as complete
    // when no frames were skipped and nothing was truncated.
    const complete = (raw.complete ?? (framesSkipped === 0 && !sourceTruncated)) === true && framesSkipped === 0 && !sourceTruncated
    const warning =
      typeof raw.warning === "string" && raw.warning.length > 0
        ? raw.warning
        : complete
          ? undefined
          : framesSkipped > 0
            ? `Partial page text: ${framesSkipped} frame(s) not accessible. Content may be incomplete.`
            : sourceTruncated
              ? "Partial page text: source truncated. Content may be incomplete."
              : undefined
    const documentId = typeof raw.documentId === "string" && raw.documentId.length > 0 ? raw.documentId : undefined
    const viewport =
      typeof raw.viewport?.width === "number" && typeof raw.viewport?.height === "number"
        ? { width: raw.viewport.width, height: raw.viewport.height }
        : undefined
    const envelope = captureUntrustedPayload(
      {
        kind: "browser-text",
        url: rawUrl,
        title: rawTitle,
        text,
        offset,
        returned: text.length,
        totalLength: full.length,
        truncated,
        sourceTruncated,
        complete,
        framesVisited,
        framesSkipped,
        shadowRoots,
        ...(documentId === undefined ? {} : { documentId }),
        ...(warning === undefined ? {} : { warning }),
      },
      {
        browserId: "embedded",
        contextId: context,
        tabId: context,
        pageId: context,
        ...(documentId === undefined ? {} : { documentId }),
        url,
      },
      new Date().toISOString(),
    )
    return {
      url,
      title,
      text: serializeUntrustedForPrompt(envelope, { maxStringCharacters: Math.max(text.length, 1_000) }),
      length: full.length,
      hash: hashBrowserText(full),
      offset,
      totalLength: full.length,
      truncated,
      ...(sourceTruncated ? { sourceTruncated: true } : {}),
      ...(viewport === undefined ? {} : { viewport }),
      ...(documentId === undefined ? {} : { documentId }),
      complete,
      framesVisited,
      framesSkipped,
      shadowRoots,
      ...(warning === undefined ? {} : { warning }),
    }
  }

  async find(
    query: string,
    options: { tabId?: string; role?: string; limit?: number; sessionId?: string } = {},
  ): Promise<BrowserCandidate[]> {
    await this.authorizeBrowserOperation()
    const context = await this.resolveTab(options.tabId, options.sessionId)
    await this.ensureReadyOn(context)
    const raw = await this.evaluateJsonOn(context, buildFindExpression(query, options.role, options.limit ?? 8))
    const coverage = parseFindCoverage(raw)
    if (coverage !== undefined && !coverage.complete) {
      this.options.log?.("browser find results are partial", {
        tabId: context,
        framesSkipped: coverage.framesSkipped,
        shadowRoots: coverage.shadowRoots,
        warning: coverage.warning ?? "Partial element results; content may be incomplete.",
      })
    }
    return parseBrowserCandidates(raw)
  }

  private async pointerClick(x: number, y: number, tabId: string, button: "left" | "right" | "middle" = "left"): Promise<void> {
    const mask = MOUSE_BUTTON_MASKS[button]
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 }, tabId)
    await this.send(
      "Input.dispatchMouseEvent",
      { type: "mousePressed", x, y, button, buttons: mask, clickCount: 1 },
      tabId,
    )
    await this.send(
      "Input.dispatchMouseEvent",
      { type: "mouseReleased", x, y, button, buttons: 0, clickCount: 1 },
      tabId,
    )
  }

  async click(target: {
    tabId?: string
    sessionId?: string
    id?: string
    x?: number
    y?: number
    button?: "left" | "right" | "middle"
  }): Promise<{
    clicked: boolean
    name?: string
    role?: string
    x?: number
    y?: number
    rect?: { x: number; y: number; width: number; height: number }
    popup?: { url: string; tabId: string }
  }> {
    await this.authorizeBrowserOperation()
    const context = await this.resolveTab(target.tabId, target.sessionId)
    if (target.id === undefined) {
      if (target.x === undefined || target.y === undefined) {
        throw new CdpError("invalid_target", "Clicking needs an element id or coordinates.")
      }
      await this.pointerClick(target.x, target.y, context, target.button)
      return { clicked: true, x: target.x, y: target.y }
    }
    await this.ensureReadyOn(context)
    const rect = (await this.evaluateJsonOn(context, buildRectExpression(requireElementRef(target.id)))) as {
      ok?: boolean
      reason?: string
      x?: number
      y?: number
      width?: number
      height?: number
      name?: string
      role?: string
      href?: string
      target?: string
    }
    if (rect.reason === "stale_element_reference") {
      throw new CdpError(
        "stale_element_reference",
        "The element reference is from a previous document. Find it again.",
      )
    }
    if (rect.ok !== true || typeof rect.x !== "number" || typeof rect.y !== "number") {
      throw new CdpError("element_not_found", "The element is no longer on the page. Find it again.")
    }
    // Synthetic input cannot open target=_blank links (the popup blocker
    // cancels the navigation without ever reaching the bridge), so open the
    // link's href as a real tab instead of sending a click that goes nowhere.
    if (rect.target === "_blank" && typeof rect.href === "string" && isNavigableBrowserUrl(rect.href)) {
      const opened = await this.open(rect.href)
      return {
        clicked: true,
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        ...(rect.name === undefined ? {} : { name: escapeUntrustedText(rect.name) }),
        ...(rect.role === undefined ? {} : { role: escapeUntrustedText(rect.role) }),
        popup: { url: opened.url, tabId: opened.id },
      }
    }
    await this.pointerClick(rect.x, rect.y, context, target.button)
    return {
      clicked: true,
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      ...(rect.name === undefined ? {} : { name: escapeUntrustedText(rect.name) }),
      ...(rect.role === undefined ? {} : { role: escapeUntrustedText(rect.role) }),
    }
  }

  async hover(
    target: { tabId?: string; sessionId?: string; id?: string; x?: number; y?: number },
    tabId?: string,
    sessionId?: string,
  ): Promise<{ hovered: boolean; name?: string; role?: string; x?: number; y?: number }> {
    await this.authorizeBrowserOperation()
    const context = await this.resolveTab(tabId ?? target.tabId, sessionId ?? target.sessionId)
    if (target.id === undefined) {
      if (target.x === undefined || target.y === undefined) {
        throw new CdpError("invalid_target", "Hovering needs an element id or coordinates.")
      }
      await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: target.x, y: target.y }, context)
      return { hovered: true, x: target.x, y: target.y }
    }
    await this.ensureReadyOn(context)
    const rect = (await this.evaluateJsonOn(context, buildRectExpression(requireElementRef(target.id)))) as {
      ok?: boolean
      reason?: string
      x?: number
      y?: number
      name?: string
      role?: string
    }
    if (rect.reason === "stale_element_reference") {
      throw new CdpError(
        "stale_element_reference",
        "The element reference is from a previous document. Find it again.",
      )
    }
    if (rect.ok !== true || typeof rect.x !== "number" || typeof rect.y !== "number") {
      throw new CdpError("element_not_found", "The element is no longer on the page. Find it again.")
    }
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x, y: rect.y }, context)
    return {
      hovered: true,
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      ...(rect.name === undefined ? {} : { name: escapeUntrustedText(rect.name) }),
      ...(rect.role === undefined ? {} : { role: escapeUntrustedText(rect.role) }),
    }
  }

  async select(
    target: { tabId?: string; sessionId?: string; id: string },
    value?: string,
    text?: string,
    tabId?: string,
    sessionId?: string,
  ): Promise<{ selected: boolean; value?: string }> {
    await this.authorizeBrowserOperation()
    const context = await this.resolveTab(tabId ?? target.tabId, sessionId ?? target.sessionId)
    await this.ensureReadyOn(context)
    const result = (await this.evaluateJsonOn(
      context,
      buildSelectExpression(requireElementRef(target.id), {
        ...(value === undefined ? {} : { value }),
        ...(text === undefined ? {} : { text }),
      }),
    )) as { ok?: boolean; reason?: string; value?: string }
    if (result.reason === "stale_element_reference") {
      throw new CdpError(
        "stale_element_reference",
        "The element reference is from a previous document. Find it again.",
      )
    }
    if (result.reason === "not_a_select") {
      throw new CdpError("not_a_select", "The element is not a <select>; find the select control itself.")
    }
    if (result.reason === "option_not_found") {
      throw new CdpError("option_not_found", "No option matches that value or text.")
    }
    if (result.reason === "missing_option") {
      throw new CdpError("invalid_target", "Selecting needs a value or text.")
    }
    if (result.ok !== true) {
      throw new CdpError("element_not_found", "The element is no longer on the page. Find it again.")
    }
    return { selected: true, ...(typeof result.value === "string" ? { value: escapeUntrustedText(result.value) } : {}) }
  }

  async drag(
    from: { tabId?: string; sessionId?: string; id?: string; x?: number; y?: number },
    to: { tabId?: string; sessionId?: string; id?: string; x?: number; y?: number },
    tabId?: string,
    sessionId?: string,
  ): Promise<{ dragged: boolean; method?: "drag_events" | "mouse" }> {
    await this.authorizeBrowserOperation()
    const context = await this.resolveTab(tabId ?? from.tabId, sessionId ?? from.sessionId)
    await this.ensureReadyOn(context)
    const source = await this.dragPoint(from, context)
    const destination = await this.dragPoint(to, context)
    const before = await this.pageTextFingerprint(context)
    const dragData = { files: [], items: [{ mimeType: "text/plain", data: "" }], dragOperationsMask: 16 }
    try {
      await this.send("Input.dispatchDragEvent", { type: "dragEnter", x: destination.x, y: destination.y, data: dragData }, context)
      await this.send("Input.dispatchDragEvent", { type: "dragOver", x: destination.x, y: destination.y, data: dragData }, context)
      await this.send("Input.dispatchDragEvent", { type: "drop", x: destination.x, y: destination.y, data: dragData }, context)
      if ((await this.pageTextFingerprint(context)) !== before) return { dragged: true, method: "drag_events" }
    } catch {
      // The bridge may not support dispatchDragEvent; the pointer fallback
      // below is the trusted path for jQuery UI droppables.
    }
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: source.x, y: source.y, button: "none", buttons: 0 }, context)
    await this.send(
      "Input.dispatchMouseEvent",
      { type: "mousePressed", x: source.x, y: source.y, button: "left", buttons: 1, clickCount: 1 },
      context,
    )
    for (let step = 1; step <= 5; step += 1) {
      const x = source.x + ((destination.x - source.x) * step) / 5
      const y = source.y + ((destination.y - source.y) * step) / 5
      await this.send(
        "Input.dispatchMouseEvent",
        { type: "mouseMoved", x, y, button: "left", buttons: 1 },
        context,
      )
    }
    await this.send(
      "Input.dispatchMouseEvent",
      { type: "mouseReleased", x: destination.x, y: destination.y, button: "left", buttons: 0, clickCount: 1 },
      context,
    )
    if ((await this.pageTextFingerprint(context)) !== before) return { dragged: true, method: "mouse" }
    return { dragged: false }
  }

  private async dragPoint(
    endpoint: { id?: string; x?: number; y?: number },
    context: string,
  ): Promise<{ x: number; y: number }> {
    if (endpoint.id === undefined) {
      if (endpoint.x === undefined || endpoint.y === undefined) {
        throw new CdpError("invalid_target", "A drag endpoint needs an element id or coordinates.")
      }
      return { x: endpoint.x, y: endpoint.y }
    }
    const rect = (await this.evaluateJsonOn(context, buildRectExpression(requireElementRef(endpoint.id)))) as {
      ok?: boolean
      reason?: string
      x?: number
      y?: number
    }
    if (rect.reason === "stale_element_reference") {
      throw new CdpError(
        "stale_element_reference",
        "The element reference is from a previous document. Find it again.",
      )
    }
    if (rect.ok !== true || typeof rect.x !== "number" || typeof rect.y !== "number") {
      throw new CdpError("element_not_found", "The element is no longer on the page. Find it again.")
    }
    return { x: rect.x, y: rect.y }
  }

  private async pageTextFingerprint(context: string): Promise<string> {
    const raw = (await this.evaluateJsonOn(context, buildReadExpression())) as { text?: string }
    return hashBrowserText(compactBrowserText(raw.text ?? ""))
  }

  async type(target: {
    tabId?: string
    sessionId?: string
    id: string
    text: string
  }): Promise<{ typed: boolean; value?: string }> {
    await this.authorizeBrowserOperation()
    const context = await this.resolveTab(target.tabId, target.sessionId)
    await this.ensureReadyOn(context)
    const focus = (await this.evaluateJsonOn(context, buildTypeFocusExpression(requireElementRef(target.id)))) as {
      ok?: boolean
      reason?: string
      editable?: boolean
      sensitive?: boolean
    }
    if (focus.reason === "stale_element_reference") {
      throw new CdpError(
        "stale_element_reference",
        "The element reference is from a previous document. Find it again.",
      )
    }
    if (focus.ok !== true) throw new CdpError("element_not_found", "The field is no longer on the page. Find it again.")
    // Trusted text insertion drives the same input pipeline as a user paste,
    // which framework value trackers and IME composition handlers observe. The
    // scripted setter remains the fallback when the trusted path is not
    // confirmed (non-editable nodes or a field that rejected the insertion).
    if (focus.editable === true) {
      await this.send("Input.insertText", { text: target.text }, context)
      const read = (await this.evaluateJsonOn(context, buildValueExpression(requireElementRef(target.id)))) as {
        ok?: boolean
        value?: string
        sensitive?: boolean
      }
      if (focus.sensitive === true || read.sensitive === true) return { typed: true }
      if (read.ok === true && read.value === target.text) {
        return { typed: true, value: escapeUntrustedText(target.text) }
      }
    }
    const result = (await this.evaluateJsonOn(context, buildTypeExpression(requireElementRef(target.id), target.text))) as {
      ok?: boolean
      reason?: string
      value?: string
      sensitive?: boolean
    }
    if (result.reason === "stale_element_reference") {
      throw new CdpError(
        "stale_element_reference",
        "The element reference is from a previous document. Find it again.",
      )
    }
    if (result.ok !== true)
      throw new CdpError("element_not_found", "The field is no longer on the page. Find it again.")
    return {
      typed: true,
      ...(result.sensitive === true || typeof result.value !== "string"
        ? {}
        : { value: escapeUntrustedText(result.value) }),
    }
  }

  async value(target: { tabId?: string; sessionId?: string; id: string }): Promise<{ value?: string; sensitive?: boolean }> {
    await this.authorizeBrowserOperation()
    const context = await this.resolveTab(target.tabId, target.sessionId)
    await this.ensureReadyOn(context)
    const result = (await this.evaluateJsonOn(context, buildValueExpression(requireElementRef(target.id)))) as {
      ok?: boolean
      reason?: string
      value?: string
      sensitive?: boolean
    }
    if (result.reason === "stale_element_reference") {
      throw new CdpError(
        "stale_element_reference",
        "The element reference is from a previous document. Find it again.",
      )
    }
    if (result.ok !== true)
      throw new CdpError("element_not_found", "The field is no longer on the page. Find it again.")
    if (result.sensitive === true) return { sensitive: true }
    return { ...(typeof result.value === "string" ? { value: escapeUntrustedText(result.value) } : {}) }
  }

  async key(key: string, tabId?: string, sessionId?: string): Promise<void> {
    await this.authorizeBrowserOperation()
    const context = await this.resolveTab(tabId, sessionId)
    const chord = parseChord(key)
    const mask = cdpModifierMask(chord.modifiers)
    for (const modifier of chord.modifiers) {
      const definition = MODIFIER_KEYS[modifier]
      await this.send(
        "Input.dispatchKeyEvent",
        {
          type: "keyDown",
          key: modifier,
          code: definition.code,
          windowsVirtualKeyCode: definition.keyCode,
          nativeVirtualKeyCode: definition.keyCode,
          modifiers: mask,
        },
        context,
      )
    }
    const text = chord.definition.text
    const insertsText =
      text !== undefined &&
      !chord.modifiers.includes("Control") &&
      !chord.modifiers.includes("Meta") &&
      !chord.modifiers.includes("Alt")
    await this.send(
      "Input.dispatchKeyEvent",
      {
        type: text === undefined ? "keyDown" : "rawKeyDown",
        key: chord.definition.key,
        code: chord.definition.code,
        windowsVirtualKeyCode: chord.definition.keyCode,
        nativeVirtualKeyCode: chord.definition.keyCode,
        modifiers: mask,
      },
      context,
    )
    // The char event carries the produced text (and the layout-independent
    // unmodifiedText) so pages observe a real text input alongside the keydown.
    if (insertsText) {
      await this.send(
        "Input.dispatchKeyEvent",
        {
          type: "char",
          key: chord.definition.key,
          code: chord.definition.code,
          windowsVirtualKeyCode: chord.definition.keyCode,
          nativeVirtualKeyCode: chord.definition.keyCode,
          modifiers: mask,
          text,
          unmodifiedText: chord.definition.unmodifiedText ?? text,
        },
        context,
      )
    }
    await this.send(
      "Input.dispatchKeyEvent",
      {
        type: "keyUp",
        key: chord.definition.key,
        code: chord.definition.code,
        windowsVirtualKeyCode: chord.definition.keyCode,
        nativeVirtualKeyCode: chord.definition.keyCode,
        modifiers: mask,
      },
      context,
    )
    for (const modifier of [...chord.modifiers].reverse()) {
      const definition = MODIFIER_KEYS[modifier]
      await this.send(
        "Input.dispatchKeyEvent",
        {
          type: "keyUp",
          key: modifier,
          code: definition.code,
          windowsVirtualKeyCode: definition.keyCode,
          nativeVirtualKeyCode: definition.keyCode,
          modifiers: mask,
        },
        context,
      )
    }
  }

  async scroll(
    options: { tabId?: string; sessionId?: string; deltaX?: number; deltaY?: number; x?: number; y?: number } = {},
  ): Promise<void> {
    await this.authorizeBrowserOperation()
    const context = await this.resolveTab(options.tabId, options.sessionId)
    const fallback = { width: 800, height: 600 }
    const viewport = (await this.evaluateJsonOn(context, buildViewportExpression()).catch(() => undefined)) as
      | { width?: number; height?: number }
      | undefined
    const x = options.x ?? Math.round((viewport?.width ?? fallback.width) / 2)
    const y = options.y ?? Math.round((viewport?.height ?? fallback.height) / 2)
    await this.send(
      "Input.dispatchMouseEvent",
      {
        type: "mouseWheel",
        x: Math.round(x),
        y: Math.round(y),
        deltaX: Math.round(options.deltaX ?? 0),
        deltaY: Math.round(options.deltaY ?? 0),
      },
      context,
    )
  }

  async screenshot(tabId?: string, sessionId?: string): Promise<{ mimeType: string; data: string }> {
    await this.authorizeBrowserOperation()
    const context = await this.resolveTab(tabId, sessionId)
    const result = await this.send<{ data?: string }>("Page.captureScreenshot", { format: "png" }, context)
    if (typeof result.data !== "string") {
      throw new CdpError("screenshot_failed", "The embedded browser did not return a screenshot.")
    }
    if (result.data.length > MAX_SCREENSHOT_CHARACTERS) {
      throw new CdpError("screenshot_failed", "The screenshot was too large to return.")
    }
    return { mimeType: "image/png", data: result.data }
  }

  async images(tabId?: string, options: { limit?: number; sessionId?: string } = {}): Promise<BrowserImage[]> {
    await this.authorizeBrowserOperation()
    const context = await this.resolveTab(tabId, options.sessionId)
    await this.ensureReadyOn(context)
    const raw = await this.evaluateJsonOn(context, buildImagesExpression(options.limit ?? 24))
    return parseBrowserImages(raw)
  }

  async saveImage(target: BrowserImageTarget & {
    path?: string
    filename?: string
    sessionId?: string
    allowOutside?: boolean
  }): Promise<{
    path: string
    bytes: number
    hash: string
    mimeType?: string
    src: string
    alt: string
    method: "download" | "fetch"
  }> {
    await this.authorizeBrowserOperation()
    const context = await this.resolveTab(target.tabId, target.sessionId)
    await this.ensureReadyOn(context)
    const raw = (await this.evaluateJsonOn(
      context,
      buildImageResolveExpression(requireImageTarget(target)),
    )) as Record<string, unknown>
    if (raw.reason === "stale_image_reference") {
      throw new CdpError(
        "stale_image_reference",
        "The image reference is from a previous document. Find it again.",
      )
    }
    if (raw.reason === "image_ambiguous") {
      throw new CdpError(
        "image_ambiguous",
        "Multiple page images matched the request. Be more specific.",
      )
    }
    if (raw.ok !== true || typeof raw.src !== "string") {
      throw new CdpError("image_not_found", "No page image matched the request.")
    }
    const src = raw.src
    const alt = typeof raw.alt === "string" ? escapeUntrustedText(raw.alt) : ""
    // The src came from the page, so it is untrusted input: a hostile page could
    // otherwise turn save_image into an SSRF fetch whose bytes land on disk.
    // It passes the same allowlist as a caller-supplied navigation URL before
    // any path is resolved and before the bridge or the page fetches anything.
    if (!src.startsWith("data:")) assertNavigableBrowserUrl(src)
    if (src.length > MAX_IMAGE_SOURCE_CHARACTERS) {
      throw new CdpError("image_fetch_failed", "The image is too large to save.")
    }
    const path = resolveImagePath(target.path, src, target.filename ?? (alt.length > 0 ? alt : undefined), undefined, {
      allowOutside: target.allowOutside === true,
    })
    const mimeType = mimeFromSource(src)
    if (src.startsWith("data:")) {
      const image = base64ImageDataUrl(src)
      if (image === undefined) throw new CdpError("image_fetch_failed", "Only a base64 image data URL can be saved.")
      if (image.bytes.length > MAX_FETCHED_IMAGE_BYTES) {
        throw new CdpError("image_fetch_failed", "The image is too large to save.")
      }
      const written = writeImageFile(path, image.bytes)
      return {
        path: written,
        ...verifyImageFile(written),
        mimeType: image.mimeType,
        src: escapeUntrustedText(src),
        alt,
        method: "fetch",
      }
    }
    try {
      const result = await this.send<{ saved?: boolean; path?: string; bytes?: number }>(
        "Omnia.saveImage",
        { url: src, path, allowOutside: target.allowOutside === true },
        context,
      )
      if (result?.saved === true) {
        const written = typeof result.path === "string" ? result.path : path
        const readback = verifyImageFile(written)
        if (typeof result.bytes === "number" && result.bytes !== readback.bytes) {
          throw new CdpError(
            "image_verify_failed",
            `The saved image read back as ${readback.bytes} bytes instead of the reported ${result.bytes}.`,
          )
        }
        return {
          path: written,
          ...readback,
          ...(mimeType === undefined ? {} : { mimeType }),
          src: escapeUntrustedText(src),
          alt,
          method: "download",
        }
      }
    } catch (error) {
      if (!(error instanceof CdpError) || !UNAVAILABLE_BRIDGE_CODES.has(error.code)) throw error
    }
    const fetched = (await this.evaluateJsonOn(context, buildImageFetchExpression(src))) as {
      data?: string
      mimeType?: string
      bytes?: number
      reason?: string
    }
    if (typeof fetched.data !== "string" || fetched.data.length > MAX_IMAGE_SOURCE_CHARACTERS) {
      throw new CdpError("image_fetch_failed", "The page could not read the image bytes.")
    }
    // The page supplies both the body and its declared type, so the read-back is
    // re-checked here exactly as the caller's own data: URL is: only a base64
    // image under the decoded cap reaches disk.
    const image = base64ImageDataUrl(fetched.data)
    if (image === undefined) throw new CdpError("image_fetch_failed", "The page did not return a base64 image.")
    if (image.bytes.length > MAX_FETCHED_IMAGE_BYTES) {
      throw new CdpError("image_fetch_failed", "The image is too large to save.")
    }
    const written = writeImageFile(path, image.bytes)
    return {
      path: written,
      ...verifyImageFile(written),
      mimeType: image.mimeType,
      src: escapeUntrustedText(src),
      alt,
      method: "fetch",
    }
  }

  async downloads(): Promise<BrowserDownload[]> {
    await this.authorizeBrowserOperation()
    const result = await this.send<{ downloads?: unknown }>("Omnia.downloads", {})
    if (result === null || typeof result !== "object" || !Array.isArray(result.downloads)) {
      throw new CdpError("cdp_error", "The embedded browser returned an unexpected download list.")
    }
    return result.downloads.flatMap((item) => {
      const download = parseBrowserDownload(item)
      return download === undefined ? [] : [download]
    })
  }

  // Pending challenges only arrive as Omnia.authRequired events; the bridge
  // offers no query command, so an unseen challenge is reported as none.
  async authRequired(): Promise<CdpAuthChallenge | null> {
    const preferred = [...this.authChallenges.keys()].at(-1)
    if (preferred === undefined) return null
    const challenge = this.authChallenges.get(preferred)
    return challenge === undefined ? null : { ...challenge }
  }

  async answerAuth(input: { username: string; password: string }): Promise<{ answered: true }> {
    await this.authorizeBrowserOperation()
    const preferred = [...this.authChallenges.keys()].at(-1)
    const tabId = preferred === undefined || preferred === "default" ? undefined : preferred
    const result = await this.send<{ answered?: unknown }>(
      "Omnia.auth",
      { ...(tabId === undefined ? {} : { tabId }), username: input.username, password: input.password },
      tabId,
    )
    if (result?.answered !== true) {
      throw new CdpError("cdp_error", "The embedded browser did not answer the authentication challenge.")
    }
    if (preferred !== undefined) this.authChallenges.delete(preferred)
    return { answered: true }
  }

  async upload(files: readonly string[], tabId?: string, sessionId?: string): Promise<{ files: string[] }> {
    if (files.length === 0) throw new CdpError("invalid_params", "The upload needs at least one file.")
    await this.authorizeBrowserOperation()
    const context = await this.resolveTab(tabId, sessionId)
    const pending = this.fileChoosers.get(context) ?? this.fileChoosers.get("default")
    if (pending === undefined) throw new CdpError("no_file_chooser", "The page is not waiting for files.")
    const result = await this.send<{ files?: unknown }>("Omnia.upload", { files: [...files], tabId: context }, context)
    if (result === null || typeof result !== "object" || !Array.isArray(result.files)) {
      throw new CdpError("cdp_error", "The embedded browser did not confirm the upload.")
    }
    this.fileChoosers.delete(context)
    this.fileChoosers.delete("default")
    return { files: result.files.filter((file): file is string => typeof file === "string") }
  }

  currentTab(sessionId?: string): string | undefined {
    return this.lastTabIds.get(sessionId ?? "default")
  }

  closeRuntime(): void {
    this.transport?.close()
    this.transport = undefined
    this.lastTabIds.clear()
    this.authChallenges.clear()
    this.fileChoosers.clear()
    this.dialogs.clear()
    this.isolatedWorlds.clear()
    this.intercepted.clear()
  }
}

function parseChord(key: string): ReturnType<typeof parseKeyChord> {
  try {
    return parseKeyChord(key)
  } catch (error) {
    throw new CdpError("invalid_key", error instanceof Error ? error.message : `The ${key} key is not supported.`)
  }
}

function parseBrowserDownload(value: unknown): BrowserDownload | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  if (
    typeof record.id !== "string" ||
    typeof record.url !== "string" ||
    typeof record.filename !== "string" ||
    typeof record.path !== "string" ||
    (record.state !== "progressing" &&
      record.state !== "completed" &&
      record.state !== "cancelled" &&
      record.state !== "interrupted")
  ) {
    return undefined
  }
  return {
    id: record.id,
    url: record.url,
    filename: record.filename,
    path: record.path,
    state: record.state,
    receivedBytes: typeof record.receivedBytes === "number" ? record.receivedBytes : 0,
    totalBytes: typeof record.totalBytes === "number" ? record.totalBytes : 0,
    startedAt: typeof record.startedAt === "number" ? record.startedAt : 0,
    ...(typeof record.finishedAt === "number" ? { finishedAt: record.finishedAt } : {}),
    ...(typeof record.mimeType === "string" ? { mimeType: record.mimeType } : {}),
    ...(typeof record.error === "string" ? { error: record.error } : {}),
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isNavigableTab(tab: RawTab): boolean {
  return isNavigableBrowserUrl(tab.url)
}

// Splits a base64 image data URL into its declared media type and decoded body,
// or returns undefined when the source is not one. Both saveImage write paths
// run every page-supplied payload through this, so a caller-supplied src and a
// body the page fetched itself are held to the same rule.
function base64ImageDataUrl(src: string): { readonly bytes: Buffer; readonly mimeType: string } | undefined {
  const match = BASE64_IMAGE_DATA_URL.exec(src)
  if (match === null) return undefined
  return { bytes: Buffer.from(match[3] ?? "", "base64"), mimeType: match[1] ?? "image/unknown" }
}

// A ref that is not a page-script id never reaches the page: there is no
// attribute or selector fallback left for it to re-point, so a forged or
// hand-written id fails closed instead of hitting the element map.
function requireElementRef(id: string): string {
  if (ELEMENT_REF.test(id)) return id
  throw new CdpError("invalid_target", "The element reference is not a page element id. Find the element again.")
}

function requireImageTarget(target: BrowserImageTarget): BrowserImageTarget {
  if (target.id === undefined) return target
  if (IMAGE_REF.test(target.id)) return target
  throw new CdpError("invalid_target", "The image reference is not a page image id. Find the image again.")
}

// A destroyed execution context is reported as a CDP error, not a page failure;
// the caller re-creates the isolated world and retries once.
function isStaleContextError(error: unknown): boolean {
  return error instanceof CdpError && typeof error.message === "string" && /context/iu.test(error.message)
}

// A missing tab is recoverable churn; every other bridge failure is real.
function isMissingTabError(error: unknown): error is CdpError {
  return error instanceof CdpError && (error.code === "not_available" || error.code === "no_tabs")
}

// An open that timed out or found no host window may still have registered the
// tab, so the bridge's live tab list is consulted before reporting failure.
function isRecoverableOpenError(error: CdpError): boolean {
  return error.code === "open_timeout" || error.code === "not_available"
}

// The desktop bridge marks failures with a stable code in the CDP error data.
function bridgeErrorCode(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined
  const code = (data as Record<string, unknown>).code
  return typeof code === "string" && code.length > 0 ? code : undefined
}

// Numeric CDP status codes are preserved as `cdp_<code>` instead of being
// collapsed into the generic cdp_error.
function numericBridgeErrorCode(code: unknown): string | undefined {
  return typeof code === "number" && Number.isFinite(code) ? `cdp_${code}` : undefined
}

// The bridge token travels in the endpoint query string, so any endpoint that
// leaves the process must have it stripped.
function redactedEndpoint(endpoint: string): string {
  return endpoint.replace(/([?&])token=[^&]*/u, "$1token=redacted")
}

function redactToken(value: string, token: string): string {
  if (token.length === 0) return value
  const encoded = encodeURIComponent(token)
  return value.replaceAll(token, "[redacted]").replaceAll(encoded, "[redacted]")
}
