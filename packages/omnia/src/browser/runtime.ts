// Embedded-only browser runtime. The desktop app owns the <webview> pages and
// exposes them through a token-authenticated loopback CDP bridge
// (OMNIA_BROWSER_WS / OMNIA_BROWSER_TOKEN); this class is the server-side
// facade over that bridge. There is no external browser process to launch,
// adopt, or fall back to: missing bridge configuration is a hard error.

import { CdpError, CdpRuntime } from "./cdp"
import type { BrowserDownload, CdpAuthChallenge, CdpNavigationResult } from "./cdp"
import { BrowserEntitlementGate } from "./entitlement"
import { BROWSER_RAW_TEXT_LIMIT, BROWSER_TEXT_LIMIT } from "./page-script"
import type {
  BrowserCandidate,
  BrowserFindCoverage,
  BrowserImage,
  BrowserImageTarget,
  BrowserPageText,
  BrowserStatus,
  BrowserTabInfo,
} from "./page-script"

export { BROWSER_RAW_TEXT_LIMIT, BROWSER_TEXT_LIMIT }
export type {
  BrowserCandidate,
  BrowserDownload,
  BrowserFindCoverage,
  BrowserPageText,
  BrowserStatus,
  BrowserTabInfo,
  CdpAuthChallenge,
}

export interface BrowserDialog {
  readonly type: string
  readonly message: string
  readonly defaultPrompt?: string
  readonly frameUrl?: string
  readonly hasBrowserHandler?: boolean
}

export interface BrowserDialogAnswer {
  readonly tabId?: string
  readonly sessionId?: string
  readonly accept: boolean
  readonly promptText?: string
  readonly expectedType?: string
  readonly expectedMessage?: string
}

// The dialog commands land on CdpRuntime, which the browser CDP layer owns.
// This structural view keeps the facade compiling independently while using the
// frozen method names currentDialog/handleDialog.
type DialogRuntime = CdpRuntime & {
  currentDialog(tabId?: string, sessionId?: string): Promise<BrowserDialog | null>
  handleDialog(input: BrowserDialogAnswer): Promise<{ handled: boolean }>
}

export interface BrowserRuntimeOptions {
  readonly now?: () => number
  readonly log?: (message: string, meta?: Record<string, unknown>) => void
  readonly embedded?: { readonly endpoint: string; readonly token: string }
  /**
   * Billing gate for browser_automation. The runtime charges the underlying
   * CdpRuntime per operation, so this is only a way to point that gate at a
   * control plane; passing it twice would not double-charge.
   */
  readonly entitlement?: BrowserEntitlementGate
}

export class BrowserRuntime {
  private cdp: CdpRuntime | undefined
  private ensuring: Promise<void> | undefined
  private readonly embedded: { readonly endpoint: string; readonly token: string } | undefined
  private readonly entitlement: BrowserEntitlementGate
  private readonly log: (message: string, meta?: Record<string, unknown>) => void
  // Kept for callers that inject a clock; the embedded bridge owns all timing.
  private readonly now: () => number

  constructor(options: BrowserRuntimeOptions = {}) {
    this.embedded = options.embedded ?? embeddedFromEnv()
    this.entitlement = options.entitlement ?? BrowserEntitlementGate.fromEnv()
    this.log = options.log ?? (() => undefined)
    this.now = options.now ?? Date.now
  }

  /** The billing gate, so a composite action can charge one request for a span. */
  get entitlementGate(): BrowserEntitlementGate {
    return this.entitlement
  }

  private embeddedRuntime(): CdpRuntime {
    if (this.embedded === undefined || this.embedded.endpoint.length === 0 || this.embedded.token.length === 0) {
      throw new CdpError("not_available", "The embedded browser is not available.")
    }
    this.cdp ??= new CdpRuntime({
      endpoint: this.embedded.endpoint,
      token: this.embedded.token,
      log: this.log,
      entitlement: this.entitlement,
    })
    return this.cdp
  }

  async status(): Promise<BrowserStatus> {
    return this.embeddedRuntime().status()
  }

  async tabs(): Promise<BrowserTabInfo[]> {
    return this.embeddedRuntime().tabs()
  }

  async open(url?: string): Promise<BrowserTabInfo> {
    return this.embeddedRuntime().open(url)
  }

  async activate(tabId: string): Promise<void> {
    return this.embeddedRuntime().activate(tabId)
  }

  async closeTab(tabId: string): Promise<void> {
    return this.embeddedRuntime().closeTab(tabId)
  }

  async navigate(url: string, tabId?: string, sessionId?: string): Promise<BrowserTabInfo> {
    return this.embeddedRuntime().navigate(url, tabId, sessionId)
  }

  async back(tabId?: string, sessionId?: string): Promise<CdpNavigationResult> {
    return this.embeddedRuntime().back(tabId, sessionId)
  }

  async forward(tabId?: string, sessionId?: string): Promise<CdpNavigationResult> {
    return this.embeddedRuntime().forward(tabId, sessionId)
  }

  async reload(tabId?: string, sessionId?: string): Promise<CdpNavigationResult> {
    return this.embeddedRuntime().reload(tabId, sessionId)
  }

  async pendingDialog(tabId?: string, sessionId?: string): Promise<BrowserDialog | null> {
    const runtime = this.embeddedRuntime() as DialogRuntime
    return runtime.currentDialog(tabId, sessionId)
  }

  async handleDialog(input: BrowserDialogAnswer): Promise<{ handled: boolean }> {
    const runtime = this.embeddedRuntime() as DialogRuntime
    return runtime.handleDialog(input)
  }

  async read(
    tabId?: string,
    options?: { offset?: number; limit?: number; sessionId?: string },
  ): Promise<BrowserPageText> {
    return this.embeddedRuntime().read(tabId, options)
  }

  async find(
    query: string,
    options: { tabId?: string; role?: string; limit?: number; sessionId?: string } = {},
  ): Promise<BrowserCandidate[]> {
    return this.embeddedRuntime().find(query, options)
  }

  async images(tabId?: string, options: { limit?: number; sessionId?: string } = {}): Promise<BrowserImage[]> {
    return this.embeddedRuntime().images(tabId, options)
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
    return this.embeddedRuntime().saveImage(target)
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
  }> {
    return this.embeddedRuntime().click(target)
  }

  async upload(files: readonly string[], tabId?: string, sessionId?: string): Promise<{ files: string[] }> {
    return this.embeddedRuntime().upload(files, tabId, sessionId)
  }

  async hover(target: { tabId?: string; sessionId?: string; id?: string; x?: number; y?: number }): Promise<{
    hovered: boolean
    name?: string
    role?: string
    x?: number
    y?: number
  }> {
    return this.embeddedRuntime().hover(target)
  }

  async select(
    target: { tabId?: string; sessionId?: string; id: string },
    value?: string,
    text?: string,
  ): Promise<{ selected: boolean; value?: string }> {
    return this.embeddedRuntime().select(target, value, text)
  }

  async drag(
    from: { tabId?: string; sessionId?: string; id?: string; x?: number; y?: number },
    to: { tabId?: string; sessionId?: string; id?: string; x?: number; y?: number },
  ): Promise<{ dragged: boolean; method?: "drag_events" | "mouse" }> {
    return this.embeddedRuntime().drag(from, to)
  }

  async type(target: {
    tabId?: string
    sessionId?: string
    id: string
    text: string
  }): Promise<{ typed: boolean; value?: string }> {
    return this.embeddedRuntime().type(target)
  }

  async readValue(target: {
    tabId?: string
    sessionId?: string
    id: string
  }): Promise<{ value?: string; sensitive?: boolean }> {
    return this.embeddedRuntime().value(target)
  }

  async key(key: string, tabId?: string, sessionId?: string): Promise<void> {
    return this.embeddedRuntime().key(key, tabId, sessionId)
  }

  async scroll(
    options: { tabId?: string; sessionId?: string; deltaX?: number; deltaY?: number; x?: number; y?: number } = {},
  ): Promise<void> {
    return this.embeddedRuntime().scroll(options)
  }

  async screenshot(tabId?: string, sessionId?: string): Promise<{ mimeType: string; data: string }> {
    return this.embeddedRuntime().screenshot(tabId, sessionId)
  }

  async downloads(): Promise<BrowserDownload[]> {
    return this.embeddedRuntime().downloads()
  }

  async authRequired(): Promise<CdpAuthChallenge | null> {
    return this.embeddedRuntime().authRequired()
  }

  async answerAuth(input: { username: string; password: string }): Promise<{ answered: true }> {
    return this.embeddedRuntime().answerAuth(input)
  }

  currentTab(sessionId?: string): string | undefined {
    return this.cdp?.currentTab(sessionId)
  }

  async closeRuntime(): Promise<void> {
    this.cdp?.closeRuntime()
    this.cdp = undefined
  }

  async ensure(): Promise<void> {
    if (this.cdp?.connected === true) return
    this.ensuring ??= this.startRuntime().finally(() => {
      this.ensuring = undefined
    })
    return this.ensuring
  }

  private async startRuntime(): Promise<void> {
    const runtime = this.embeddedRuntime()
    await runtime.ensure()
    // closeRuntime() can drop this.cdp while the bridge handshake is still in
    // flight; the socket then lands on an instance nobody references, so close
    // it here instead of leaking the connection.
    if (this.cdp !== runtime) runtime.closeRuntime()
  }
}

function embeddedFromEnv(): { readonly endpoint: string; readonly token: string } | undefined {
  const endpoint = process.env.OMNIA_BROWSER_WS
  const token = process.env.OMNIA_BROWSER_TOKEN
  if (endpoint === undefined || endpoint.length === 0) return undefined
  if (token === undefined || token.length === 0) return undefined
  return { endpoint, token }
}
