import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { createServer } from "node:net"
import { homedir } from "node:os"
import { join } from "node:path"
import { BidiClient, BidiError } from "./bidi"

export interface BrowserTabInfo {
  readonly id: string
  readonly url: string
  readonly title?: string
  readonly active?: boolean
}

export interface BrowserCandidate {
  readonly id: string
  readonly role: string
  readonly name: string
  readonly tag: string
  readonly visible: boolean
  readonly disabled: boolean
  readonly score: number
  readonly rect?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  readonly center?: { readonly x: number; readonly y: number }
}

export interface BrowserPageText {
  readonly url: string
  readonly title: string
  readonly text: string
  readonly length: number
  readonly hash: string
  readonly offset: number
  readonly totalLength: number
  readonly truncated: boolean
  readonly viewport?: { readonly width: number; readonly height: number }
}

export interface BrowserStatus {
  readonly running: boolean
  readonly endpoint?: string
  readonly browser?: string
  readonly tabs: number
}

export interface BrowserRuntimeOptions {
  readonly binary?: string
  readonly profileDir?: string
  readonly now?: () => number
  readonly log?: (message: string, meta?: Record<string, unknown>) => void
}

export const BROWSER_TEXT_LIMIT = 20000

const FIREFOX_CANDIDATES = ["firefox", "firefox-esr", "firefox-bin"]

function compact(text: string): string {
  return text.replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim()
}

function hash(text: string): string {
  return createHash("sha1").update(text, "utf8").digest("hex").slice(0, 16)
}

function buildFindExpression(query: string, role: string | undefined, limit: number): string {
  return `(() => {
    const query = ${JSON.stringify(query)}.toLowerCase();
    const roleFilter = ${role === undefined ? "null" : JSON.stringify(role.toLowerCase())};
    const limit = ${Math.max(1, Math.min(50, limit))};
    const roleMap = { a: "link", button: "button", textarea: "textbox", select: "combobox", summary: "button", label: "label" };
    const inputRole = (el) => el.type === "checkbox" ? "checkbox" : el.type === "radio" ? "radio" : (el.type === "submit" || el.type === "button" || el.type === "reset") ? "button" : "textbox";
    const roleOf = (el) => el.getAttribute("role") || (el.tagName.toLowerCase() === "input" ? inputRole(el) : roleMap[el.tagName.toLowerCase()] || el.tagName.toLowerCase());
    const nameOf = (el) => (el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("placeholder") || (el.labels && el.labels[0] ? el.labels[0].innerText : "") || el.value || el.innerText || el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 120);
    const visible = (el) => { const rect = el.getBoundingClientRect(); const style = getComputedStyle(el); return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none"; };
    const score = (name) => { const value = name.toLowerCase(); if (value === query) return 1; if (value.startsWith(query)) return 0.9; if (value.includes(query)) return 0.75; const words = query.split(/\\s+/).filter(Boolean); const hits = words.filter((word) => value.includes(word)).length; return hits > 0 ? (0.5 * hits) / words.length : 0; };
    const nodes = Array.from(document.querySelectorAll('a,button,input,textarea,select,summary,[role],[contenteditable="true"],[onclick]'));
    let sequence = window.__omniaSeq || 0;
    const candidates = [];
    for (const el of nodes) {
      const name = nameOf(el);
      if (!name) continue;
      const role = roleOf(el);
      if (roleFilter && role !== roleFilter) continue;
      const value = score(name);
      if (value <= 0) continue;
      sequence += 1;
      const id = "omnia-" + sequence;
      el.setAttribute("data-omnia-id", id);
      const box = el.getBoundingClientRect();
      candidates.push({ id, role, name, tag: el.tagName.toLowerCase(), visible: visible(el), disabled: el.disabled === true, score: value, rect: { x: Math.round(box.left), y: Math.round(box.top), width: Math.round(box.width), height: Math.round(box.height) }, center: { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) } });
    }
    window.__omniaSeq = sequence;
    candidates.sort((a, b) => (b.visible ? 1 : 0) - (a.visible ? 1 : 0) || b.score - a.score);
    const ranked = candidates.some((candidate) => candidate.visible) ? candidates.filter((candidate) => candidate.visible && candidate.rect.width > 0 && candidate.rect.height > 0) : candidates;
    return JSON.stringify(ranked.slice(0, limit));
  })()`
}

function buildRectExpression(id: string): string {
  return `(() => {
    const el = document.querySelector('[data-omnia-id="' + ${JSON.stringify(id)} + '"]');
    if (!el) return JSON.stringify({ ok: false, reason: "element_not_found" });
    el.scrollIntoView({ block: "center", inline: "center" });
    const rect = el.getBoundingClientRect();
    const name = (el.getAttribute("aria-label") || el.innerText || el.value || "").trim().replace(/\\s+/g, " ").slice(0, 120);
    const role = el.getAttribute("role") || el.tagName.toLowerCase();
    return JSON.stringify({ ok: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, name, role, disabled: el.disabled === true });
  })()`
}

function buildTypeExpression(id: string, text: string): string {
  return `(() => {
    const el = document.querySelector('[data-omnia-id="' + ${JSON.stringify(id)} + '"]');
    if (!el) return JSON.stringify({ ok: false, reason: "element_not_found" });
    el.scrollIntoView({ block: "center", inline: "center" });
    el.focus();
    if (el.isContentEditable) {
      el.textContent = ${JSON.stringify(text)};
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: ${JSON.stringify(text)} }));
    } else {
      const prototype = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
      if (descriptor && descriptor.set) descriptor.set.call(el, ${JSON.stringify(text)});
      else el.value = ${JSON.stringify(text)};
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return JSON.stringify({ ok: true, value: (el.value !== undefined ? el.value : el.textContent || "").slice(0, 200) });
  })()`
}

function buildReadExpression(): string {
  return `JSON.stringify({ url: location.href, title: document.title, text: document.body ? document.body.innerText : "", viewport: { width: window.innerWidth, height: window.innerHeight } })`
}

export class BrowserRuntime {
  private client: BidiClient | undefined
  private port: number | undefined
  private browserName: string | undefined
  private lastTabId: string | undefined
  private readonly binary: string | undefined
  private readonly profileDir: string
  private readonly log: (message: string, meta?: Record<string, unknown>) => void

  constructor(options: BrowserRuntimeOptions = {}) {
    this.binary = options.binary
    this.profileDir = options.profileDir ?? join(homedir(), ".local", "share", "omnia", "browser-profile")
    this.log = options.log ?? (() => undefined)
  }

  async ensure(): Promise<void> {
    if (this.client?.connected === true) return
    const existing = this.readMarker()
    if (existing !== undefined && (await this.probe(existing.port))) {
      try {
        await this.connect(existing.port)
        return
      } catch (error) {
        // Firefox allows one BiDi session at a time. If a previous session is
        // still held, retire that browser and start a clean one.
        this.log("reusing the browser failed; restarting it", {
          error: error instanceof Error ? error.message : String(error),
        })
        if (existing.pid !== undefined) await terminate(existing.pid)
      }
    }
    const port = await freePort()
    await this.launch(port)
    await this.connect(port)
    this.writeMarker(port)
  }

  private readMarker(): { port: number; pid?: number } | undefined {
    try {
      const marker = join(this.profileDir, "runtime.json")
      if (!existsSync(marker)) return undefined
      const parsed = JSON.parse(readFileSync(marker, "utf8")) as { port?: unknown; pid?: unknown }
      if (typeof parsed.port !== "number") return undefined
      return { port: parsed.port, ...(typeof parsed.pid === "number" ? { pid: parsed.pid } : {}) }
    } catch {
      return undefined
    }
  }

  private writeMarker(port: number): void {
    try {
      mkdirSync(this.profileDir, { recursive: true })
      writeFileSync(join(this.profileDir, "runtime.json"), JSON.stringify({ port, pid: this.pid }))
    } catch {
      // marker is best-effort
    }
  }

  private pid: number | undefined

  private async probe(port: number): Promise<boolean> {
    return fetch(`http://127.0.0.1:${port}/json/version`)
      .then((response) => response.ok)
      .catch(() => false)
  }

  private resolveBinary(): string {
    if (this.binary !== undefined && this.binary.length > 0) return this.binary
    const fromEnv = process.env.OMNIA_BROWSER_BIN
    if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv
    return FIREFOX_CANDIDATES[0]!
  }

  private async launch(port: number): Promise<void> {
    mkdirSync(this.profileDir, { recursive: true })
    const prefs = join(this.profileDir, "user.js")
    if (!existsSync(prefs)) {
      writeFileSync(
        prefs,
        [
          'user_pref("remote.active-protocols", 3);',
          'user_pref("remote.enabled", true);',
          'user_pref("browser.shell.checkDefaultBrowser", false);',
          'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
          'user_pref("toolkit.telemetry.enabled", false);',
          'user_pref("browser.startup.page", 0);',
          'user_pref("browser.sessionstore.resume_from_crash", false);',
          "",
        ].join("\n"),
      )
    }
    const binary = this.resolveBinary()
    this.log("launching browser", { binary, port, profile: this.profileDir })
    const child = spawn(
      binary,
      ["--no-remote", "--profile", this.profileDir, "--remote-debugging-port", String(port), "about:blank"],
      { detached: true, stdio: "ignore", env: { ...process.env } },
    )
    this.pid = child.pid
    child.once("error", (error) => this.log("browser launch failed", { error: error.message }))
    child.unref()
    const deadline = Date.now() + 25000
    while (Date.now() < deadline) {
      if (await this.probe(port)) return
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    throw new BidiError("launch_timeout", `The browser did not open a debug port. Check that ${binary} is installed.`)
  }

  private async connect(port: number): Promise<void> {
    const client = new BidiClient({ url: `ws://127.0.0.1:${port}/session` })
    await client.connect()
    const session = await client.send<{ capabilities?: { browserName?: string; browserVersion?: string } }>("session.new", {
      capabilities: { alwaysMatch: {} },
    })
    this.client = client
    this.port = port
    this.browserName = session.capabilities?.browserName
      ? `${session.capabilities.browserName} ${session.capabilities.browserVersion ?? ""}`.trim()
      : undefined
    this.log("browser connected", { port, browser: this.browserName })
  }

  private requireClient(): BidiClient {
    if (this.client === undefined || !this.client.connected) {
      throw new BidiError("not_running", "The browser runtime is not running.")
    }
    return this.client
  }

  private async resolveTab(tabId?: string): Promise<string> {
    if (tabId !== undefined && tabId.length > 0) {
      this.lastTabId = tabId
      return tabId
    }
    if (this.lastTabId !== undefined) {
      const tabs = await this.rawTabs().catch(() => [])
      if (tabs.some((tab) => tab.id === this.lastTabId)) return this.lastTabId
    }
    const fallback = await this.defaultTab()
    this.lastTabId = fallback
    return fallback
  }

  currentTab(): string | undefined {
    return this.lastTabId
  }

  private async ensureReady(tabId?: string): Promise<void> {
    const context = await this.resolveTab(tabId)
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const state = await this.evaluate("document.readyState", context).catch(() => undefined)
      if (state === "complete" || state === "interactive") return
      await new Promise((resolve) => setTimeout(resolve, 120))
    }
  }

  private async evaluate(expression: string, tabId?: string): Promise<unknown> {
    const client = this.requireClient()
    const context = await this.resolveTab(tabId)
    const result = await client.send<{ result?: { type?: string; value?: unknown } }>("script.evaluate", {
      expression,
      target: { context },
      awaitPromise: true,
      resultOwnership: "none",
    })
    const value = result.result?.value
    if (typeof value !== "string") throw new BidiError("evaluate_failed", "The page returned an unexpected value.")
    return JSON.parse(value) as unknown
  }

  private async defaultTab(): Promise<string> {
    const tabs = await this.rawTabs()
    const normal = tabs.find((tab) => !tab.url.startsWith("about:")) ?? tabs[0]
    if (normal === undefined) throw new BidiError("no_tabs", "The browser has no open tab.")
    return normal.id
  }

  private async rawTabs(): Promise<BrowserTabInfo[]> {
    const client = this.requireClient()
    const tree = await client.send<{ contexts?: Array<{ context?: string; url?: string }> }>("browsingContext.getTree", {})
    return (tree.contexts ?? []).flatMap((context) =>
      typeof context.context === "string"
        ? [{ id: context.context, url: typeof context.url === "string" ? context.url : "" }]
        : [],
    )
  }

  async status(): Promise<BrowserStatus> {
    if (this.client?.connected !== true) {
      const marker = this.readMarker()
      const reusable = marker !== undefined && (await this.probe(marker.port))
      return {
        running: reusable,
        ...(reusable ? { endpoint: `127.0.0.1:${marker.port}` } : {}),
        tabs: 0,
      }
    }
    const tabs = await this.rawTabs().catch(() => [])
    return {
      running: true,
      endpoint: this.port === undefined ? undefined : `127.0.0.1:${this.port}`,
      ...(this.browserName === undefined ? {} : { browser: this.browserName }),
      tabs: tabs.length,
    }
  }

  async tabs(): Promise<BrowserTabInfo[]> {
    const tabs = await this.rawTabs()
    return Promise.all(
      tabs.slice(0, 12).map(async (tab) => {
        await this.ensureReady(tab.id).catch(() => undefined)
        const title = await this.evaluate("document.title", tab.id).catch(() => undefined)
        return { ...tab, ...(typeof title === "string" ? { title } : {}) }
      }),
    )
  }

  async open(url?: string): Promise<BrowserTabInfo> {
    await this.ensure()
    const client = this.requireClient()
    const created = await client.send<{ context?: string }>("browsingContext.create", { type: "tab" })
    const id = created.context
    if (typeof id !== "string") throw new BidiError("open_failed", "The browser did not return a tab id.")
    this.lastTabId = id
    // Firefox ignores the url on create, so navigate explicitly and wait.
    if (url !== undefined && url.length > 0) {
      await client.send("browsingContext.navigate", { context: id, url, wait: "complete" })
    }
    await client.send("browsingContext.activate", { context: id }).catch(() => undefined)
    return { id, url: url ?? "about:blank" }
  }

  async activate(tabId: string): Promise<void> {
    this.lastTabId = tabId
    await this.requireClient().send("browsingContext.activate", { context: tabId })
  }

  async closeTab(tabId: string): Promise<void> {
    await this.requireClient().send("browsingContext.close", { context: tabId })
  }

  async navigate(url: string, tabId?: string): Promise<BrowserTabInfo> {
    await this.ensure()
    const context = await this.resolveTab(tabId)
    const result = await this.requireClient().send<{ url?: string }>("browsingContext.navigate", {
      context,
      url,
      wait: "complete",
    })
    return { id: context, url: typeof result.url === "string" ? result.url : url }
  }

  async back(tabId?: string): Promise<void> {
    const context = await this.resolveTab(tabId)
    await this.requireClient().send("browsingContext.traverseHistory", { context, delta: -1 })
  }

  async forward(tabId?: string): Promise<void> {
    const context = await this.resolveTab(tabId)
    await this.requireClient().send("browsingContext.traverseHistory", { context, delta: 1 })
  }

  async reload(tabId?: string): Promise<void> {
    const context = await this.resolveTab(tabId)
    await this.requireClient().send("browsingContext.reload", { context, wait: "complete" })
  }

  async read(tabId?: string, options?: { offset?: number; limit?: number }): Promise<BrowserPageText> {
    await this.ensureReady(tabId)
    const raw = (await this.evaluate(buildReadExpression(), tabId)) as {
      url?: string
      title?: string
      text?: string
      viewport?: { width?: number; height?: number }
    }
    const full = compact(raw.text ?? "")
    const offset = Math.max(0, options?.offset ?? 0)
    const limit = Math.max(0, options?.limit ?? BROWSER_TEXT_LIMIT)
    const text = full.slice(offset, offset + limit)
    const viewport =
      typeof raw.viewport?.width === "number" && typeof raw.viewport?.height === "number"
        ? { width: raw.viewport.width, height: raw.viewport.height }
        : undefined
    return {
      url: raw.url ?? "",
      title: raw.title ?? "",
      text,
      length: full.length,
      hash: hash(full),
      offset,
      totalLength: full.length,
      truncated: offset + text.length < full.length,
      ...(viewport === undefined ? {} : { viewport }),
    }
  }

  async find(query: string, options: { tabId?: string; role?: string; limit?: number } = {}): Promise<BrowserCandidate[]> {
    await this.ensureReady(options.tabId)
    const raw = (await this.evaluate(buildFindExpression(query, options.role, options.limit ?? 8), options.tabId)) as unknown
    if (!Array.isArray(raw)) return []
    const candidates = raw.flatMap((item): BrowserCandidate[] => {
      if (typeof item !== "object" || item === null) return []
      const record = item as Record<string, unknown>
      const rect = typeof record.rect === "object" && record.rect !== null ? (record.rect as Record<string, unknown>) : undefined
      const center =
        typeof record.center === "object" && record.center !== null ? (record.center as Record<string, unknown>) : undefined
      return [
        {
          id: String(record.id ?? ""),
          role: String(record.role ?? "element"),
          name: String(record.name ?? ""),
          tag: String(record.tag ?? ""),
          visible: record.visible === true,
          disabled: record.disabled === true,
          score: typeof record.score === "number" ? record.score : 0,
          ...(rect === undefined || typeof rect.width !== "number"
            ? {}
            : {
                rect: {
                  x: typeof rect.x === "number" ? rect.x : 0,
                  y: typeof rect.y === "number" ? rect.y : 0,
                  width: rect.width,
                  height: typeof rect.height === "number" ? rect.height : 0,
                },
              }),
          ...(center === undefined || typeof center.x !== "number" || typeof center.y !== "number"
            ? {}
            : { center: { x: center.x, y: center.y } }),
        },
      ]
    })
    const hasVisible = candidates.some((candidate) => candidate.visible)
    const ranked = hasVisible
      ? candidates.filter(
          (candidate) =>
            candidate.visible && candidate.rect !== undefined && candidate.rect.width > 0 && candidate.rect.height > 0,
        )
      : candidates
    return ranked.sort((a, b) => (b.visible ? 1 : 0) - (a.visible ? 1 : 0) || b.score - a.score)
  }

  private async pointerClick(x: number, y: number, tabId?: string): Promise<void> {
    const context = await this.resolveTab(tabId)
    // Input actions only land in the active tab, so bring the target forward first.
    await this.requireClient().send("browsingContext.activate", { context }).catch(() => undefined)
    await this.requireClient().send("input.performActions", {
      context,
      actions: [
        {
          type: "pointer",
          id: "omnia-mouse",
          parameters: { pointerType: "mouse" },
          actions: [
            { type: "pointerMove", x, y, duration: 160 },
            { type: "pointerDown", button: 0 },
            { type: "pointerUp", button: 0 },
          ],
        },
      ],
    })
  }

  async click(target: {
    tabId?: string
    id?: string
    x?: number
    y?: number
  }): Promise<{ clicked: boolean; name?: string; role?: string; x?: number; y?: number; rect?: { x: number; y: number; width: number; height: number } }> {
    if (target.id === undefined) {
      if (target.x === undefined || target.y === undefined) {
        throw new BidiError("invalid_target", "Clicking needs an element id or coordinates.")
      }
      await this.pointerClick(target.x, target.y, target.tabId)
      return { clicked: true, x: target.x, y: target.y }
    }
    await this.ensureReady(target.tabId)
    const rect = (await this.evaluate(buildRectExpression(target.id), target.tabId)) as {
      ok?: boolean
      x?: number
      y?: number
      width?: number
      height?: number
      name?: string
      role?: string
    }
    if (rect.ok !== true || typeof rect.x !== "number" || typeof rect.y !== "number") {
      throw new BidiError("element_not_found", "The element is no longer on the page. Find it again.")
    }
    await this.pointerClick(rect.x, rect.y, target.tabId)
    return {
      clicked: true,
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      ...(typeof rect.width === "number" && typeof rect.height === "number"
        ? { rect: { x: Math.round(rect.x - rect.width / 2), y: Math.round(rect.y - rect.height / 2), width: Math.round(rect.width), height: Math.round(rect.height) } }
        : {}),
      ...(typeof rect.name === "string" ? { name: rect.name } : {}),
      ...(typeof rect.role === "string" ? { role: rect.role } : {}),
    }
  }

  async type(target: { tabId?: string; id: string; text: string }): Promise<{ typed: boolean; value?: string }> {
    await this.ensureReady(target.tabId)
    const result = (await this.evaluate(buildTypeExpression(target.id, target.text), target.tabId)) as {
      ok?: boolean
      value?: string
    }
    if (result.ok !== true) throw new BidiError("element_not_found", "The field is no longer on the page. Find it again.")
    return { typed: true, ...(typeof result.value === "string" ? { value: result.value } : {}) }
  }

  async key(key: string, tabId?: string): Promise<void> {
    const context = await this.resolveTab(tabId)
    await this.requireClient().send("browsingContext.activate", { context }).catch(() => undefined)
    const code = key === "Enter" ? "Enter" : key === "Tab" ? "Tab" : key === "Escape" ? "Escape" : key
    await this.requireClient().send("input.performActions", {
      context,
      actions: [
        {
          type: "key",
          id: "omnia-keyboard",
          actions: [
            { type: "keyDown", value: code },
            { type: "keyUp", value: code },
          ],
        },
      ],
    })
  }

  async closeRuntime(): Promise<void> {
    this.client?.close()
    this.client = undefined
    if (this.pid !== undefined) {
      await terminate(this.pid)
      this.pid = undefined
    }
    this.clearMarker()
  }

  private clearMarker(): void {
    try {
      const marker = join(this.profileDir, "runtime.json")
      if (existsSync(marker)) writeFileSync(marker, JSON.stringify({}))
    } catch {
      // marker is best-effort
    }
  }
}

async function terminate(pid: number): Promise<void> {
  try {
    process.kill(pid, "SIGTERM")
  } catch {
    return
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 150))
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
  }
  try {
    process.kill(pid, "SIGKILL")
  } catch {
    // already gone
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address === null || typeof address === "string") {
        server.close()
        reject(new BidiError("port_failed", "Could not allocate a browser debug port."))
        return
      }
      const port = address.port
      server.close(() => resolve(port))
    })
  })
}
