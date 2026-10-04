import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { EventBus } from "./events"
import { PermissionManager, type ApprovalPolicy, type OmniaScope, type PermissionState } from "./permissions"
import {
  ComputerManager,
  type BrowserController,
  type BrowserDialogAnswer,
  type BrowserDialogSummary,
  type ServerComputerDriver,
} from "./computers"
import { CdpError } from "../browser/cdp"
import { BrowserUrlError } from "../browser/url-policy"
import type { ActionResult, ComputerAction, Observation } from "../protocol"

function errorCode(error: ActionResult["error"]): string | undefined {
  return typeof error === "object" && error !== null ? error.code : error
}

function baseDriver(overrides: Partial<ServerComputerDriver> = {}): ServerComputerDriver {
  const driver: ServerComputerDriver = {
    id: "local",
    backend: "test",
    getInfo: async () => ({ id: "local", name: "Test Computer", platform: "linux", connected: true }),
    capabilities: () => [],
    observe: async (): Promise<Observation> => ({ id: "obs-1", elements: [] }),
    find: async (request) => ({ query: request.query, matches: [] }),
    execute: async (action: ComputerAction): Promise<ActionResult> => ({
      success: true,
      status: "success",
      message: `Executed ${action.type}.`,
    }),
  }
  return Object.assign(driver, overrides)
}

function createManager(
  driver: ServerComputerDriver,
  options: {
    browser?: BrowserController
    permissions?: Partial<Record<OmniaScope, PermissionState>>
    policy?: ApprovalPolicy
  } = {},
): { manager: ComputerManager; events: EventBus } {
  const events = new EventBus({ serverId: "test" })
  const permissions = new PermissionManager(options.permissions ?? {}, options.policy ?? "fully_autonomous")
  const manager = new ComputerManager({
    events,
    permissions,
    ...(options.browser === undefined ? {} : { browser: options.browser }),
  })
  manager.register(driver)
  return { manager, events }
}

function browserHarness(overrides: Partial<BrowserController> = {}) {
  const state = {
    readCalls: 0,
    readTabs: [] as Array<string | undefined>,
    actionTabs: [] as Array<{ action: string; tabId?: string }>,
    tabCalls: 0,
    activated: [] as string[],
    closed: [] as string[],
    savedPaths: [] as Array<string | undefined>,
    saveTargets: [] as Array<{ path?: string; allowOutside?: boolean }>,
    page: {
      url: "https://example.com",
      title: "Example",
      text: "hello page",
      length: 10,
      hash: "hash-1",
      documentId: "doc-1",
    },
    tabs: [{ id: "tab-1", url: "https://example.com" }] as Array<{ id: string; url: string; title?: string }>,
  }
  const browser: BrowserController = {
    status: async () => ({ running: true, browser: "test 1.0", tabs: state.tabs.length }),
    open: async (url) => {
      const tab = { id: `tab-${state.tabs.length + 1}`, url: url ?? "about:blank" }
      state.tabs.push(tab)
      return tab
    },
    tabs: async () => {
      state.tabCalls += 1
      return [...state.tabs]
    },
    activate: async (tabId) => {
      state.activated.push(tabId)
    },
    closeTab: async (tabId) => {
      state.closed.push(tabId)
    },
    navigate: async (url, tabId) => {
      state.page = { ...state.page, url, hash: `hash-${url}` }
      return { id: tabId ?? "tab-1", url }
    },
    read: async (tabId) => {
      state.readCalls += 1
      state.readTabs.push(tabId)
      return { ...state.page }
    },
    find: async (query) => [{ id: "field-1", role: "textbox", name: query, visible: true, disabled: false, score: 1 }],
    images: async () => [],
    saveImage: async (target) => {
      state.savedPaths.push(target.path)
      state.saveTargets.push({
        ...(target.path === undefined ? {} : { path: target.path }),
        ...(target.allowOutside === undefined ? {} : { allowOutside: target.allowOutside }),
      })
      return {
        path: target.path ?? "/tmp/image.png",
        bytes: 12,
        hash: "hash-image",
        src: "https://example.com/image.png",
        alt: "image",
        method: "fetch" as const,
      }
    },
    click: async () => {
      state.page = { ...state.page, hash: "hash-after-click" }
      return { clicked: true, name: "Export", role: "button" }
    },
    type: async (target) => ({ typed: true, value: target.text }),
    key: async () => undefined,
    back: async (tabId) => {
      state.actionTabs.push({ action: "back", ...(tabId === undefined ? {} : { tabId }) })
    },
    forward: async (tabId) => {
      state.actionTabs.push({ action: "forward", ...(tabId === undefined ? {} : { tabId }) })
    },
    reload: async (tabId) => {
      state.actionTabs.push({ action: "reload", ...(tabId === undefined ? {} : { tabId }) })
    },
  }
  return { browser: { ...browser, ...overrides }, state }
}

describe("browser verification uses per-action readback", () => {
  test("navigate verifies against an independent page URL, not a hash delta", async () => {
    const { browser, state } = browserHarness({
      navigate: async (_url, tabId) => ({ id: tabId ?? "tab-1", url: "https://redirected.example" }),
    })
    const { manager } = createManager(baseDriver(), { browser })
    const outcome = await manager.execute("local", { action: "browser_navigate", url: "https://target.example", sessionId: "s" })
    expect(outcome.httpStatus).toBe(200)
    expect(outcome.result.verification?.status).toBe("unverified")
    expect(outcome.result.verification?.method).toBe("browser-url-readback")
    // Exactly one readback; no tab listing around the action.
    expect(state.readCalls).toBe(1)
    expect(state.tabCalls).toBe(0)
  })

  test("navigate verifies when the page read reports the navigated URL", async () => {
    const { browser } = browserHarness()
    const { manager } = createManager(baseDriver(), { browser })
    const outcome = await manager.execute("local", { action: "browser_navigate", url: "https://target.example", sessionId: "s" })
    expect(outcome.result.verification?.status).toBe("verified")
    expect(outcome.result.verification?.method).toBe("browser-url-readback")
    expect((outcome.result.metadata as { tab?: { id?: string } }).tab?.id).toBe("tab-1")
  })

  test("navigate reports an explicit unverified when the readback fails", async () => {
    const { browser } = browserHarness({
      read: async () => {
        throw new CdpError("not_available", "no page")
      },
    })
    const { manager } = createManager(baseDriver(), { browser })
    const outcome = await manager.execute("local", { action: "browser_navigate", url: "https://target.example", sessionId: "s" })
    expect(outcome.result.success).toBe(true)
    expect(outcome.result.verification?.status).toBe("unverified")
    expect(outcome.result.verification?.message).toContain("not_available")
  })

  test("click needs a page change readback; an unchanged page is not verified", async () => {
    const changed = browserHarness()
    const changedManager = createManager(baseDriver(), { browser: changed.browser }).manager
    const verified = await changedManager.execute("local", {
      action: "browser_click",
      target: { elementId: "field-1" },
      sessionId: "s",
    })
    expect(verified.result.verification?.status).toBe("verified")
    expect(verified.result.verification?.method).toBe("browser-click-readback")
    expect(changed.state.readCalls).toBe(2)

    const stuck = browserHarness({ click: async () => ({ clicked: true, name: "Export", role: "button" }) })
    const stuckManager = createManager(baseDriver(), { browser: stuck.browser }).manager
    const unverified = await stuckManager.execute("local", {
      action: "browser_click",
      target: { elementId: "field-1" },
      sessionId: "s",
    })
    expect(unverified.result.success).toBe(true)
    expect(unverified.result.verification?.status).toBe("unverified")
  })

  test("an unrelated new tab does not verify a click", async () => {
    const { browser, state } = browserHarness({
      click: async () => {
        state.tabs.push({ id: "tab-9", url: "https://other.example" })
        return { clicked: true, name: "Export", role: "button" }
      },
    })
    const { manager } = createManager(baseDriver(), { browser })
    const outcome = await manager.execute("local", {
      action: "browser_click",
      target: { elementId: "field-1" },
      sessionId: "s",
    })
    expect(outcome.result.success).toBe(true)
    expect(outcome.result.verification?.status).toBe("unverified")
    // No tab listing is performed at all: tab-count deltas are not evidence.
    expect(state.tabCalls).toBe(0)
  })

  test("click readback failure is explicit and never verified", async () => {
    const { browser } = browserHarness({
      read: async () => {
        throw new CdpError("load_timeout", "slow")
      },
    })
    const { manager } = createManager(baseDriver(), { browser })
    const outcome = await manager.execute("local", { action: "browser_click", target: { elementId: "x" }, sessionId: "s" })
    expect(outcome.result.verification?.status).toBe("unverified")
    expect(outcome.result.verification?.message).toContain("could not be read back")
  })

  test("back/forward verify on an independent URL change", async () => {
    const { browser } = browserHarness({
      back: async () => {
        // The harness page changes only through navigate; simulate the history move here.
      },
    })
    const { manager } = createManager(baseDriver(), { browser })
    const before = await manager.execute("local", { action: "browser_read", sessionId: "s" })
    expect(before.httpStatus).toBe(200)
    const outcome = await manager.execute("local", { action: "browser_back", sessionId: "s" })
    expect(outcome.result.verification?.status).toBe("unverified")
    expect(outcome.result.verification?.method).toBe("browser-history-readback")
  })

  test("history navigation verifies when the URL changes", async () => {
    const { browser, state } = browserHarness({
      back: async () => {
        state.page = { ...state.page, url: "https://previous.example", hash: "hash-previous" }
      },
    })
    const { manager } = createManager(baseDriver(), { browser })
    const outcome = await manager.execute("local", { action: "browser_back", sessionId: "s" })
    expect(outcome.result.verification?.status).toBe("verified")
    expect(outcome.result.verification?.method).toBe("browser-history-readback")
  })

  test("reload is unverified when the document generation is unchanged", async () => {
    const { browser, state } = browserHarness()
    const { manager } = createManager(baseDriver(), { browser })
    const outcome = await manager.execute("local", { action: "browser_reload", sessionId: "s" })
    expect(outcome.result.success).toBe(true)
    expect(outcome.result.verification?.status).toBe("unverified")
    expect(outcome.result.verification?.method).toBe("browser-reload-readback")
    expect(outcome.result.verification?.message).toContain("no reload evidence")
    expect(state.readCalls).toBe(2)
  })

  test("reload verifies on an independent navigation change with an unchanged document generation", async () => {
    const { browser, state } = browserHarness({
      reload: async () => {
        state.page = { ...state.page, url: "https://changed.example", hash: "hash-changed" }
      },
    })
    const { manager } = createManager(baseDriver(), { browser })
    const outcome = await manager.execute("local", { action: "browser_reload", sessionId: "s" })
    expect(outcome.result.verification?.status).toBe("verified")
    expect(outcome.result.verification?.method).toBe("browser-reload-readback")
    expect(outcome.result.verification?.message).toContain("navigated")
  })

  test("reload verifies only when an independent read shows a new document", async () => {
    const { browser, state } = browserHarness({
      reload: async () => {
        state.page = { ...state.page, documentId: "doc-2" }
      },
    })
    const { manager } = createManager(baseDriver(), { browser })
    const outcome = await manager.execute("local", { action: "browser_reload", sessionId: "s" })
    expect(outcome.result.verification?.status).toBe("verified")
    expect(outcome.result.verification?.method).toBe("browser-reload-readback")
    expect(outcome.result.verification?.evidence?.[0]?.value).toContain("doc-1")
    expect(outcome.result.verification?.evidence?.[0]?.value).toContain("doc-2")
  })

  test("a controller that cannot move a history action answers no_history", async () => {
    const { browser } = browserHarness({
      back: async () => {
        throw new CdpError("no_history", "There is no previous page in this tab.")
      },
    })
    const { manager } = createManager(baseDriver(), { browser })
    const outcome = await manager.execute("local", { action: "browser_back", sessionId: "s" })
    expect(outcome.httpStatus).toBe(409)
    expect(errorCode(outcome.result.error)).toBe("no_history")
  })

  test("back/forward perform the action and both reads on the same resolved tab", async () => {
    const { browser, state } = browserHarness({
      currentTab: () => "tab-1",
      back: async (tabId) => {
        state.actionTabs.push({ action: "back", ...(tabId === undefined ? {} : { tabId }) })
        state.page = { ...state.page, documentId: "doc-2" }
      },
    })
    const { manager } = createManager(baseDriver(), { browser })
    const outcome = await manager.execute("local", { action: "browser_back", sessionId: "s" })
    expect(outcome.result.verification?.status).toBe("verified")
    expect(state.readTabs).toEqual(["tab-1", "tab-1"])
    expect(state.actionTabs).toEqual([{ action: "back", tabId: "tab-1" }])
  })

  test("history navigation verifies on a document change with an unchanged URL", async () => {
    const { browser, state } = browserHarness({
      forward: async () => {
        state.page = { ...state.page, documentId: "doc-2" }
      },
    })
    const { manager } = createManager(baseDriver(), { browser })
    const outcome = await manager.execute("local", { action: "browser_forward", sessionId: "s" })
    expect(outcome.result.verification?.status).toBe("verified")
    expect(outcome.result.verification?.method).toBe("browser-history-readback")
  })

  test("key press verifies only from an independent page change", async () => {
    const { browser, state } = browserHarness()
    const { manager } = createManager(baseDriver(), { browser })
    const stuck = await manager.execute("local", { action: "browser_key", key: "Enter", sessionId: "s" })
    expect(stuck.result.success).toBe(true)
    expect(stuck.result.verification?.status).toBe("unverified")
    expect(stuck.result.verification?.method).toBe("browser-key-readback")

    browser.key = async () => {
      state.page = { ...state.page, hash: "hash-after-key" }
    }
    const changed = await manager.execute("local", { action: "browser_key", key: "Enter", sessionId: "s" })
    expect(changed.result.verification?.status).toBe("verified")
    expect(changed.result.verification?.method).toBe("browser-key-readback")
  })

  test("open verifies from an independent page read of the opened URL", async () => {
    const good = browserHarness()
    const verified = await createManager(baseDriver(), { browser: good.browser }).manager.execute("local", {
      action: "browser_open",
      url: "https://example.com",
      sessionId: "s",
    })
    expect(verified.result.verification?.status).toBe("verified")
    expect(verified.result.verification?.method).toBe("browser-url-readback")

    const bad = browserHarness({ open: async () => ({ id: "tab-2", url: "https://claimed.example" }) })
    const unverified = await createManager(baseDriver(), { browser: bad.browser }).manager.execute("local", {
      action: "browser_open",
      url: "https://claimed.example",
      sessionId: "s",
    })
    expect(unverified.result.verification?.status).toBe("unverified")
    expect(unverified.result.verification?.message).toContain("example.com")
  })

  test("activate verifies only when the active tab can be read back", async () => {
    const unknown = browserHarness()
    const unverified = await createManager(baseDriver(), { browser: unknown.browser }).manager.execute("local", {
      action: "browser_activate_tab",
      tab: "tab-1",
    })
    expect(unverified.result.verification?.status).toBe("unverified")
    expect(unverified.result.verification?.method).toBe("browser-activate-readback")

    const known = browserHarness({ currentTab: () => "tab-1" })
    const verified = await createManager(baseDriver(), { browser: known.browser }).manager.execute("local", {
      action: "browser_activate_tab",
      tab: "tab-1",
    })
    expect(verified.result.verification?.status).toBe("verified")
    expect(verified.result.verification?.method).toBe("browser-activate-readback")

    const wrong = browserHarness({ currentTab: () => "tab-9" })
    const mismatch = await createManager(baseDriver(), { browser: wrong.browser }).manager.execute("local", {
      action: "browser_activate_tab",
      tab: "tab-1",
    })
    expect(mismatch.result.verification?.status).toBe("unverified")
  })

  test("a browser target resolved in another observation is refused as target_stale", async () => {
    const { browser } = browserHarness()
    let clicks = 0
    browser.click = async () => {
      clicks += 1
      return { clicked: true, name: "Export", role: "button" }
    }
    const { manager } = createManager(baseDriver(), { browser })
    const stale = await manager.execute("local", {
      action: "browser_click",
      target: { kind: "element", elementId: "field-1@doc-42", observationId: "doc-7" },
      sessionId: "s",
    })
    expect(stale.httpStatus).toBe(409)
    expect(errorCode(stale.result.error)).toBe("target_stale")
    expect(clicks).toBe(0)

    const conflicting = await manager.execute("local", {
      action: "browser_click",
      target: { kind: "element", elementId: "field-1@doc-42", observationId: "doc-7" },
      observationId: "doc-9",
      sessionId: "s",
    })
    expect(errorCode(conflicting.result.error)).toBe("target_stale")
    expect(clicks).toBe(0)

    const matched = await manager.execute("local", {
      action: "browser_click",
      target: { kind: "element", elementId: "field-1@doc-42", observationId: "doc-42" },
      sessionId: "s",
    })
    expect(matched.result.success).toBe(true)
    expect(clicks).toBe(1)
  })
})

describe("browser_type independent readback", () => {
  test("a controller-echoed value is not trusted; the field is re-read", async () => {
    const { browser } = browserHarness({
      type: async (target) => ({ typed: true, value: `echo:${target.text}` }),
    })
    const { manager } = createManager(baseDriver(), { browser })
    const outcome = await manager.execute("local", {
      action: "browser_type",
      target: { elementId: "field-1" },
      text: "acme industrial",
      sessionId: "s",
    })
    expect(outcome.result.verification?.status).toBe("verified")
    expect(outcome.result.verification?.method).toBe("browser-value-readback")
  })

  test("a matching controller value cannot verify when the independent read disagrees", async () => {
    const { browser } = browserHarness({
      type: async (target) => ({ typed: true, value: target.text }),
      find: async () => [{ id: "field-1", role: "textbox", name: "something else", visible: true, disabled: false, score: 1 }],
    })
    const { manager } = createManager(baseDriver(), { browser })
    const outcome = await manager.execute("local", {
      action: "browser_type",
      target: { elementId: "field-1" },
      text: "acme industrial",
      sessionId: "s",
    })
    expect(outcome.result.success).toBe(true)
    expect(outcome.result.verification?.status).toBe("unverified")
  })

  test("a missing field in the re-read stays unverified", async () => {
    const { browser } = browserHarness({ find: async () => [] })
    const { manager } = createManager(baseDriver(), { browser })
    const outcome = await manager.execute("local", {
      action: "browser_type",
      target: { elementId: "field-1" },
      text: "acme industrial",
      sessionId: "s",
    })
    expect(outcome.result.verification?.status).toBe("unverified")
  })
})

describe("browser error taxonomy and tab ownership", () => {
  test("typed runtime failures map to their HTTP status and code", async () => {
    const missing = browserHarness({
      navigate: async () => {
        throw new CdpError("element_not_found", "The element is gone.")
      },
    })
    const missingOutcome = await createManager(baseDriver(), { browser: missing.browser }).manager.execute("local", {
      action: "browser_navigate",
      url: "https://target.example",
      sessionId: "s",
    })
    expect(missingOutcome.httpStatus).toBe(404)
    expect(errorCode(missingOutcome.result.error)).toBe("element_not_found")
    expect(missingOutcome.result.message).toBe("The element is gone.")

    const blocked = browserHarness({
      navigate: async () => {
        throw new BrowserUrlError("https://blocked.example")
      },
    })
    const blockedOutcome = await createManager(baseDriver(), { browser: blocked.browser }).manager.execute("local", {
      action: "browser_navigate",
      url: "https://blocked.example",
      sessionId: "s",
    })
    expect(blockedOutcome.httpStatus).toBe(400)
    expect(errorCode(blockedOutcome.result.error)).toBe("url_blocked")
  })

  test("unknown failures stay generic and do not leak messages", async () => {
    const { browser } = browserHarness({
      navigate: async () => {
        throw new Error("secret page content at /home/user/private")
      },
    })
    const outcome = await createManager(baseDriver(), { browser }).manager.execute("local", {
      action: "browser_navigate",
      url: "https://target.example",
      sessionId: "s",
    })
    expect(outcome.httpStatus).toBe(500)
    expect(errorCode(outcome.result.error)).toBe("browser_error")
    expect(outcome.result.message).toBe("The browser action failed.")
  })

  test("agent sessions cannot activate or close tabs they do not own", async () => {
    const { browser, state } = browserHarness()
    const { manager } = createManager(baseDriver(), { browser })
    const denied = await manager.execute("local", { action: "browser_activate_tab", tab: "999", sessionId: "s1" })
    expect(denied.httpStatus).toBe(403)
    expect(errorCode(denied.result.error)).toBe("tab_not_owned")
    expect(state.activated).toHaveLength(0)

    const opened = await manager.execute("local", { action: "browser_open", url: "https://example.com", sessionId: "s1" })
    expect(opened.result.success).toBe(true)
    const openedTab = (opened.result.metadata as { tab?: { id?: string } }).tab?.id
    expect(openedTab).toBeString()

    const allowed = await manager.execute("local", { action: "browser_activate_tab", tab: openedTab!, sessionId: "s1" })
    expect(allowed.httpStatus).toBe(200)
    expect(state.activated).toContain(openedTab!)

    const closeDenied = await manager.execute("local", { action: "browser_close_tab", tab: "999", sessionId: "s1" })
    expect(closeDenied.httpStatus).toBe(403)
    const closeAllowed = await manager.execute("local", { action: "browser_close_tab", tab: openedTab!, sessionId: "s1" })
    expect(closeAllowed.httpStatus).toBe(200)
    expect(state.closed).toContain(openedTab!)
  })

  test("desktop calls keep unrestricted tab access", async () => {
    const { browser, state } = browserHarness()
    const { manager } = createManager(baseDriver(), { browser })
    const outcome = await manager.execute("local", { action: "browser_activate_tab", tab: "999" })
    expect(outcome.httpStatus).toBe(200)
    expect(state.activated).toEqual(["999"])
  })

  test("read metadata reports the action's effective tab, not a process-wide cache", async () => {
    const { browser } = browserHarness({
      currentTab: (sessionId) => (sessionId === "session-x" ? "tab-x" : "tab-global"),
    })
    const { manager } = createManager(baseDriver(), { browser })
    const outcome = await manager.execute("local", { action: "browser_read", sessionId: "session-x" })
    expect((outcome.result.metadata as { tab?: string }).tab).toBe("tab-x")
  })

  test("image and save APIs answer explicitly when the runtime lacks them", async () => {
    const { browser } = browserHarness()
    const bare = { ...browser } as Record<string, unknown>
    delete bare.images
    delete bare.saveImage
    const { manager } = createManager(baseDriver(), { browser: bare as unknown as BrowserController })
    const images = await manager.execute("local", { action: "browser_images", sessionId: "s" })
    expect(images.httpStatus).toBe(501)
    expect(errorCode(images.result.error)).toBe("operation_unavailable")
    const save = await manager.execute("local", { action: "browser_save_image", path: join(tmpdir(), "img.png"), sessionId: "s" })
    expect(save.httpStatus).toBe(501)
  })
})

describe("browser image path sandbox", () => {
  test("writes outside the sandbox require FILES_WRITE and answer 403 when denied", async () => {
    const { browser, state } = browserHarness()
    const { manager } = createManager(baseDriver(), {
      browser,
      permissions: { BROWSER: "granted", FILES_WRITE: "denied" },
      policy: "ask_destructive",
    })
    const outcome = await manager.execute("local", { action: "browser_save_image", path: "/etc/omnia-evil.png", sessionId: "s" })
    expect(outcome.httpStatus).toBe(403)
    expect(errorCode(outcome.result.error)).toBe("permission_denied")
    expect(state.savedPaths).toHaveLength(0)
  })

  test("traversal out of the downloads sandbox is rejected", async () => {
    const { browser, state } = browserHarness()
    const { manager } = createManager(baseDriver(), {
      browser,
      permissions: { BROWSER: "granted", FILES_WRITE: "denied" },
      policy: "ask_destructive",
    })
    const traversal = join(homedir(), "Downloads", "omnia", "..", "..", "escape.png")
    const outcome = await manager.execute("local", { action: "browser_save_image", path: traversal, sessionId: "s" })
    expect(outcome.httpStatus).toBe(403)
    expect(state.savedPaths).toHaveLength(0)
  })

  test("an unapproved out-of-sandbox write answers 428", async () => {
    const { browser } = browserHarness()
    const { manager } = createManager(baseDriver(), {
      browser,
      permissions: { BROWSER: "granted", FILES_WRITE: "prompt" },
      policy: "ask_destructive",
    })
    const outcome = await manager.execute("local", { action: "browser_save_image", path: "/etc/omnia-evil.png", sessionId: "s" })
    expect(outcome.httpStatus).toBe(428)
    expect(errorCode(outcome.result.error)).toBe("files_write_required")
  })

  test("sandboxed temp writes proceed without FILES_WRITE", async () => {
    const { browser, state } = browserHarness()
    const { manager } = createManager(baseDriver(), { browser })
    const target = join(tmpdir(), "omnia-image-test.png")
    const outcome = await manager.execute("local", { action: "browser_save_image", path: target, sessionId: "s" })
    expect(outcome.httpStatus).toBe(200)
    expect(state.savedPaths).toEqual([target])
  })
})

describe("browser controller resolution", () => {
  test("prefers the computer driver's browser over the global controller", async () => {
    const global = browserHarness()
    const local = browserHarness({
      status: async () => ({ running: true, browser: "driver-browser", tabs: 7 }),
    })
    const { manager } = createManager(baseDriver({ browser: local.browser }), { browser: global.browser })
    const outcome = await manager.execute("local", { action: "browser_status" })
    expect(outcome.httpStatus).toBe(200)
    expect((outcome.result.metadata as { status?: unknown }).status).toEqual({
      running: true,
      browser: "driver-browser",
      tabs: 7,
    })
  })

  test("falls back to the global controller when the driver has no browser", async () => {
    const global = browserHarness()
    const { manager } = createManager(baseDriver(), { browser: global.browser })
    const outcome = await manager.execute("local", { action: "browser_status" })
    expect(outcome.httpStatus).toBe(200)
    expect((outcome.result.metadata as { status?: { browser?: string } }).status?.browser).toBe("test 1.0")
  })

  test("answers operation_unavailable when neither the driver nor the server has a browser", async () => {
    const { manager } = createManager(baseDriver())
    const outcome = await manager.execute("local", { action: "browser_status" })
    expect(outcome.httpStatus).toBe(501)
    expect(outcome.result.success).toBe(false)
    expect(errorCode(outcome.result.error)).toBe("operation_unavailable")
  })
})

describe("browser dialogs", () => {
  test("the dialog action answers a pending dialog with independent readback", async () => {
    let pending: BrowserDialogSummary | null = { type: "confirm", message: "Leave?" }
    const handled: BrowserDialogAnswer[] = []
    const { browser } = browserHarness({
      pendingDialog: async () => pending,
      handleDialog: async (input) => {
        handled.push(input)
        pending = null
        return { handled: true }
      },
    })
    const { manager } = createManager(baseDriver(), { browser })
    const outcome = await manager.execute("local", { action: "browser_dialog", dialog: "accept", sessionId: "s" })
    expect(outcome.httpStatus).toBe(200)
    expect(outcome.result.success).toBe(true)
    expect(outcome.result.verification?.status).toBe("verified")
    expect(outcome.result.verification?.method).toBe("browser-dialog-readback")
    expect(handled).toHaveLength(1)
    expect(handled[0]).toMatchObject({ accept: true, sessionId: "s" })
    expect((outcome.result.metadata as { dialog?: { type?: string } }).dialog?.type).toBe("confirm")
  })

  test("the dialog action carries prompt text and expectations to the runtime", async () => {
    let pending: BrowserDialogSummary | null = { type: "prompt", message: "Name?", defaultPrompt: "Ada" }
    const handled: BrowserDialogAnswer[] = []
    const { browser } = browserHarness({
      pendingDialog: async () => pending,
      handleDialog: async (input) => {
        handled.push(input)
        pending = null
        return { handled: true }
      },
    })
    const { manager } = createManager(baseDriver(), { browser })
    const outcome = await manager.execute("local", {
      action: "browser_dialog",
      dialog: "accept",
      promptText: "Grace",
      expectedType: "prompt",
      expectedMessage: "Name?",
      sessionId: "s",
    })
    expect(outcome.result.success).toBe(true)
    expect(handled[0]).toMatchObject({ accept: true, promptText: "Grace", expectedType: "prompt", expectedMessage: "Name?" })
  })

  test("dialog_not_open and dialog_mismatch are rejected with 409", async () => {
    const none = browserHarness({ pendingDialog: async () => null, handleDialog: async () => ({ handled: true }) })
    const noneOutcome = await createManager(baseDriver(), { browser: none.browser }).manager.execute("local", {
      action: "browser_dialog",
      dialog: "dismiss",
      sessionId: "s",
    })
    expect(noneOutcome.httpStatus).toBe(409)
    expect(errorCode(noneOutcome.result.error)).toBe("dialog_not_open")

    const stale = browserHarness({
      pendingDialog: async () => ({ type: "alert", message: "Hi" }),
      handleDialog: async () => ({ handled: true }),
    })
    const mismatch = await createManager(baseDriver(), { browser: stale.browser }).manager.execute("local", {
      action: "browser_dialog",
      dialog: "accept",
      expectedType: "confirm",
      sessionId: "s",
    })
    expect(mismatch.httpStatus).toBe(409)
    expect(errorCode(mismatch.result.error)).toBe("dialog_mismatch")
  })

  test("a dialog that is still pending after the answer is unverified", async () => {
    const { browser } = browserHarness({
      pendingDialog: async () => ({ type: "alert", message: "Hi" }),
      handleDialog: async () => ({ handled: true }),
    })
    const { manager } = createManager(baseDriver(), { browser })
    const outcome = await manager.execute("local", { action: "browser_dialog", dialog: "dismiss", sessionId: "s" })
    expect(outcome.result.success).toBe(true)
    expect(outcome.result.verification?.status).toBe("unverified")
    expect(outcome.result.verification?.message).toContain("still pending")
  })

  test("a pending dialog blocks other browser actions with dialog_open", async () => {
    const { browser, state } = browserHarness({
      pendingDialog: async () => ({ type: "alert", message: "Hi" }),
      handleDialog: async () => ({ handled: true }),
    })
    const { manager } = createManager(baseDriver(), { browser })
    const click = await manager.execute("local", {
      action: "browser_click",
      target: { elementId: "field-1" },
      sessionId: "s",
    })
    expect(click.httpStatus).toBe(409)
    expect(errorCode(click.result.error)).toBe("dialog_open")
    expect((click.result.metadata as { dialog?: { message?: string } }).dialog?.message).toBe("Hi")
    expect(state.readCalls).toBe(0)

    const status = await manager.execute("local", { action: "browser_status", sessionId: "s" })
    expect(status.httpStatus).toBe(409)
    expect(errorCode(status.result.error)).toBe("dialog_open")
    expect((status.result.metadata as { dialog?: { type?: string } }).dialog?.type).toBe("alert")

    const read = await manager.execute("local", { action: "browser_read", sessionId: "s" })
    expect(read.httpStatus).toBe(409)
    expect(errorCode(read.result.error)).toBe("dialog_open")
    expect((read.result.metadata as { dialog?: { type?: string } }).dialog?.type).toBe("alert")
  })

  test("a dialog that appears during a read is reported in the read metadata", async () => {
    let queried = 0
    const { browser } = browserHarness({
      pendingDialog: async () => {
        queried += 1
        return queried === 1 ? null : { type: "confirm", message: "Later" }
      },
      handleDialog: async () => ({ handled: true }),
    })
    const { manager } = createManager(baseDriver(), { browser })
    const outcome = await manager.execute("local", { action: "browser_read", sessionId: "s" })
    expect(outcome.httpStatus).toBe(200)
    expect((outcome.result.metadata as { dialog?: { message?: string } }).dialog?.message).toBe("Later")
  })
})

describe("browser events", () => {
  test("open emits browser.launched and navigate emits browser.navigated", async () => {
    const { browser } = browserHarness()
    const { manager, events } = createManager(baseDriver(), { browser })
    await manager.execute("local", { action: "browser_open", url: "https://launch.example", sessionId: "s" })
    await manager.execute("local", { action: "browser_navigate", url: "https://nav.example", sessionId: "s" })
    const launched = events.since(0).filter((event) => event.type === "browser.launched")
    const navigated = events.since(0).filter((event) => event.type === "browser.navigated")
    expect(launched).toHaveLength(1)
    expect(launched[0]?.computerId).toBe("local")
    expect(launched[0]?.data).toMatchObject({ url: "https://launch.example" })
    expect(navigated).toHaveLength(1)
    expect(navigated[0]?.computerId).toBe("local")
    expect(navigated[0]?.data).toMatchObject({ url: "https://nav.example" })
  })

  test("history moves emit browser.navigated but reload does not", async () => {
    const { browser, state } = browserHarness({
      back: async () => {
        state.page = { ...state.page, documentId: "doc-2" }
      },
    })
    const { manager, events } = createManager(baseDriver(), { browser })
    await manager.execute("local", { action: "browser_back", sessionId: "s" })
    await manager.execute("local", { action: "browser_reload", sessionId: "s" })
    const navigated = events.since(0).filter((event) => event.type === "browser.navigated")
    expect(navigated).toHaveLength(1)
    expect(navigated[0]?.data).toMatchObject({ url: "https://example.com" })
  })
})

describe("browser tab integrity", () => {
  test("agent tab listings include only tabs the session owns", async () => {
    const { browser } = browserHarness()
    const { manager } = createManager(baseDriver(), { browser })
    const first = await manager.execute("local", { action: "browser_open", url: "https://one.example", sessionId: "s1" })
    const firstTab = (first.result.metadata as { tab?: { id?: string } }).tab?.id
    const second = await manager.execute("local", { action: "browser_open", url: "https://two.example", sessionId: "s2" })
    const secondTab = (second.result.metadata as { tab?: { id?: string } }).tab?.id
    expect(firstTab).toBeString()
    expect(secondTab).toBeString()

    const listed = await manager.execute("local", { action: "browser_tabs", sessionId: "s1" })
    const tabs = (listed.result.metadata as { tabs?: Array<{ id: string }> }).tabs ?? []
    expect(tabs.map((entry) => entry.id)).toEqual([firstTab!])
    expect(tabs.map((entry) => entry.id)).not.toContain(secondTab)
  })

  test("close_tab verifies a real close and refuses to claim a stuck one", async () => {
    const closing = browserHarness()
    closing.browser.closeTab = async (tabId) => {
      closing.state.tabs = closing.state.tabs.filter((entry) => entry.id !== tabId)
    }
    const closingManager = createManager(baseDriver(), { browser: closing.browser }).manager
    const opened = await closingManager.execute("local", {
      action: "browser_open",
      url: "https://one.example",
      sessionId: "s",
    })
    const tab = (opened.result.metadata as { tab?: { id?: string } }).tab?.id
    expect(tab).toBeString()
    const verified = await closingManager.execute("local", { action: "browser_close_tab", tab: tab!, sessionId: "s" })
    expect(verified.result.verification?.status).toBe("verified")
    expect(verified.result.verification?.method).toBe("browser-tabs-readback")

    const stuck = browserHarness()
    const stuckManager = createManager(baseDriver(), { browser: stuck.browser }).manager
    const stuckOpen = await stuckManager.execute("local", {
      action: "browser_open",
      url: "https://two.example",
      sessionId: "s",
    })
    const stuckTab = (stuckOpen.result.metadata as { tab?: { id?: string } }).tab?.id
    const unverified = await stuckManager.execute("local", {
      action: "browser_close_tab",
      tab: stuckTab!,
      sessionId: "s",
    })
    expect(unverified.result.verification?.status).toBe("unverified")
    expect(unverified.result.verification?.message).toContain("still reports")
  })

  test("the session tab allowlist fails at the cap instead of evicting the oldest entry", async () => {
    const { browser } = browserHarness()
    const { manager } = createManager(baseDriver(), { browser })
    for (let index = 0; index < 64; index += 1) {
      const opened = await manager.execute("local", {
        action: "browser_open",
        url: `https://site-${index}.example`,
        sessionId: "s",
      })
      expect(opened.result.success).toBe(true)
    }
    const overflow = await manager.execute("local", {
      action: "browser_open",
      url: "https://overflow.example",
      sessionId: "s",
    })
    expect(overflow.httpStatus).toBe(409)
    expect(errorCode(overflow.result.error)).toBe("tab_limit")
    const listed = await manager.execute("local", { action: "browser_tabs", sessionId: "s" })
    expect(((listed.result.metadata as { tabs?: unknown[] }).tabs ?? []).length).toBe(64)
  })
})

describe("browser image verification", () => {
  test("save_image reports the runtime disk readback as verification evidence", async () => {
    const { browser } = browserHarness()
    const { manager } = createManager(baseDriver(), { browser })
    const outcome = await manager.execute("local", { action: "browser_save_image", query: "logo", sessionId: "s" })
    expect(outcome.httpStatus).toBe(200)
    expect(outcome.result.verification?.status).toBe("verified")
    expect(outcome.result.verification?.method).toBe("browser-image-readback")
    expect((outcome.result.metadata as { hash?: string }).hash).toBe("hash-image")
  })

  test("an approved out-of-sandbox save passes allowOutside to the runtime", async () => {
    const { browser, state } = browserHarness()
    const { manager } = createManager(baseDriver(), {
      browser,
      permissions: { BROWSER: "granted", FILES_WRITE: "granted" },
      policy: "ask_destructive",
    })
    const outcome = await manager.execute("local", {
      action: "browser_save_image",
      path: "/etc/omnia-approved.png",
      sessionId: "s",
    })
    expect(outcome.httpStatus).toBe(200)
    expect(state.saveTargets[0]?.allowOutside).toBe(true)
  })

  test("copy_image stages inside the downloads sandbox and verifies the clipboard write", async () => {
    const downloads = mkdtempSync(join(tmpdir(), "omnia-copy-"))
    const previous = process.env.OMNIA_BROWSER_DOWNLOAD_DIR
    process.env.OMNIA_BROWSER_DOWNLOAD_DIR = downloads
    try {
      const copied: string[] = []
      const { browser, state } = browserHarness()
      const { manager } = createManager(
        baseDriver({
          writeClipboardImage: async (path) => {
            copied.push(path)
            return { success: true, status: "success", message: "copied" }
          },
        }),
        { browser },
      )
      const outcome = await manager.execute("local", { action: "browser_copy_image", query: "logo", sessionId: "s" })
      expect(outcome.httpStatus).toBe(200)
      expect(state.savedPaths).toHaveLength(1)
      expect(state.savedPaths[0]?.startsWith(downloads)).toBe(true)
      expect(copied[0]?.startsWith(downloads)).toBe(true)
      expect(outcome.result.verification?.status).toBe("verified")
      expect(outcome.result.verification?.method).toBe("browser-clipboard-image")
    } finally {
      if (previous === undefined) delete process.env.OMNIA_BROWSER_DOWNLOAD_DIR
      else process.env.OMNIA_BROWSER_DOWNLOAD_DIR = previous
      rmSync(downloads, { recursive: true, force: true })
    }
  })

  test("browser_downloads verifies completed non-empty downloads", async () => {
    const { browser } = browserHarness({
      downloads: async () => [
        {
          id: "d1",
          url: "https://example.com/f.txt",
          filename: "f.txt",
          path: "/home/user/Downloads/omnia/f.txt",
          state: "completed",
          receivedBytes: 10,
          totalBytes: 10,
          startedAt: 1,
          finishedAt: 2,
        },
      ],
    })
    const { manager } = createManager(baseDriver(), { browser })
    const outcome = await manager.execute("local", { action: "browser_downloads" })
    expect(outcome.result.success).toBe(true)
    expect(outcome.result.verification?.status).toBe("verified")
    expect(outcome.result.verification?.method).toBe("browser-download-registry")
    expect(JSON.stringify(outcome.result.metadata)).toContain("f.txt")
  })

  test("browser_downloads stays unverified while a download is progressing", async () => {
    const { browser } = browserHarness({
      downloads: async () => [
        {
          id: "d1",
          url: "https://example.com/f.txt",
          filename: "f.txt",
          path: "/home/user/Downloads/omnia/f.txt",
          state: "progressing",
          receivedBytes: 4,
          totalBytes: 10,
          startedAt: 1,
        },
      ],
    })
    const { manager } = createManager(baseDriver(), { browser })
    const outcome = await manager.execute("local", { action: "browser_downloads" })
    expect(outcome.result.success).toBe(true)
    expect(outcome.result.verification?.status).toBe("unverified")
  })

  test("browser_auth answers a pending challenge and verifies the page readback", async () => {
    const answered: Array<{ username: string; password: string }> = []
    const { browser } = browserHarness({
      authRequired: async () => ({ url: "https://example.com", host: "example.com", realm: "Restricted", isProxy: false }),
      answerAuth: async (input) => {
        answered.push(input)
        return { answered: true }
      },
    })
    const { manager } = createManager(baseDriver(), { browser })
    const outcome = await manager.execute("local", {
      action: "browser_auth",
      username: "tomsmith",
      password: "SuperSecretPassword!",
      expectedHost: "example.com",
    })
    expect(outcome.result.success).toBe(true)
    expect(answered).toEqual([{ username: "tomsmith", password: "SuperSecretPassword!" }])
    expect(outcome.result.verification?.status).toBe("verified")
    expect(outcome.result.verification?.method).toBe("browser-auth-readback")
  })

  test("browser_auth fails closed when no challenge is pending or the host differs", async () => {
    const { browser } = browserHarness({
      authRequired: async () => ({ url: "https://example.com", host: "example.com", realm: "R", isProxy: false }),
      answerAuth: async () => ({ answered: true }),
    })
    const { manager } = createManager(baseDriver(), { browser })
    const mismatch = await manager.execute("local", {
      action: "browser_auth",
      username: "u",
      password: "p",
      expectedHost: "other.example",
    })
    expect(mismatch.httpStatus).toBe(409)
    expect(errorCode(mismatch.result.error)).toBe("auth_host_mismatch")
    const { browser: empty } = browserHarness({ authRequired: async () => null, answerAuth: async () => ({ answered: true }) })
    const { manager: manager2 } = createManager(baseDriver(), { browser: empty })
    const none = await manager2.execute("local", { action: "browser_auth", username: "u", password: "p" })
    expect(none.httpStatus).toBe(409)
    expect(errorCode(none.result.error)).toBe("no_auth_challenge")
  })
})
