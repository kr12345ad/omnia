import { describe, expect, test } from "bun:test"
import type { BrowserController, BrowserImageSave } from "./computers"
import { RemoteComputerDriver } from "./remote"
import { browserFailureCode } from "../browser/errors"

function remoteDriver(): RemoteComputerDriver {
  return new RemoteComputerDriver({ id: "remote-1", name: "Remote", platform: "linux" })
}

async function expectForwarded<T>(
  instance: RemoteComputerDriver,
  operation: string,
  params: unknown,
  invoke: (browser: BrowserController) => Promise<T>,
  result: Awaited<T>,
): Promise<void> {
  const pending = invoke(instance.browser)
  const command = await instance.nextCommand(100)
  expect(command).toBeDefined()
  expect(command?.method).toBe("browser")
  expect(command?.params).toEqual({ operation, params })
  instance.complete({ id: command!.id, ok: true, result })
  expect(await pending).toEqual(result)
}

describe("remote browser controller", () => {
  test("forwards every browser operation as one browser command", async () => {
    const instance = remoteDriver()
    await expectForwarded(
      instance,
      "status",
      {},
      (browser) => browser.status(),
      { running: true, browser: "embedded", tabs: 2 },
    )
    await expectForwarded(
      instance,
      "open",
      { url: "https://example.com" },
      (browser) => browser.open("https://example.com"),
      { id: "tab-1", url: "https://example.com" },
    )
    await expectForwarded(
      instance,
      "tabs",
      {},
      (browser) => browser.tabs(),
      [{ id: "tab-1", url: "https://example.com", active: true }],
    )
    await expectForwarded(
      instance,
      "activate",
      { tabId: "tab-1" },
      (browser) => browser.activate("tab-1"),
      undefined,
    )
    await expectForwarded(
      instance,
      "closeTab",
      { tabId: "tab-1" },
      (browser) => browser.closeTab("tab-1"),
      undefined,
    )
    const navigated = { id: "tab-1", url: "https://target.example" }
    await expectForwarded(
      instance,
      "navigate",
      { url: "https://target.example", tabId: "tab-1", sessionId: "session-1" },
      (browser) => browser.navigate("https://target.example", "tab-1", "session-1"),
      navigated,
    )
    const page = { url: "https://target.example", title: "Target", text: "hello", length: 5, hash: "hash-1" }
    await expectForwarded(
      instance,
      "read",
      { tabId: "tab-1", options: { offset: 5, limit: 100, maxChars: 200, sessionId: "session-1" } },
      (browser) => browser.read("tab-1", { offset: 5, limit: 100, maxChars: 200, sessionId: "session-1" }),
      page,
    )
    const candidates = [{ id: "field-1", role: "textbox", name: "Search" }]
    await expectForwarded(
      instance,
      "find",
      { query: "Search", options: { tabId: "tab-1", role: "textbox", limit: 4, sessionId: "session-1" } },
      (browser) => browser.find("Search", { tabId: "tab-1", role: "textbox", limit: 4, sessionId: "session-1" }),
      candidates,
    )
    const images = [
      { id: "img-1", src: "https://example.com/logo.png", alt: "Logo", width: 10, height: 10, naturalWidth: 10, naturalHeight: 10, visible: true },
    ]
    await expectForwarded(
      instance,
      "images",
      { tabId: "tab-1", options: { limit: 4, sessionId: "session-1" } },
      (browser) => browser.images!("tab-1", { limit: 4, sessionId: "session-1" }),
      images,
    )
    const saveTarget = {
      tabId: "tab-1",
      id: "img-1",
      url: "https://example.com/logo.png",
      query: "logo",
      path: "/tmp/logo.png",
      filename: "logo.png",
      sessionId: "session-1",
    }
    const saved: BrowserImageSave = {
      path: "/tmp/logo.png",
      bytes: 12,
      src: "https://example.com/logo.png",
      alt: "Logo",
      method: "fetch",
    }
    await expectForwarded(instance, "saveImage", { target: saveTarget }, (browser) => browser.saveImage!(saveTarget), saved)
    const clickTarget = { tabId: "tab-1", sessionId: "session-1", id: "button-1", x: 10, y: 20 }
    await expectForwarded(
      instance,
      "click",
      { target: clickTarget },
      (browser) => browser.click(clickTarget),
      { clicked: true, name: "Export", role: "button" },
    )
    const typeTarget = { tabId: "tab-1", sessionId: "session-1", id: "field-1", text: "hello" }
    await expectForwarded(
      instance,
      "type",
      { target: typeTarget },
      (browser) => browser.type(typeTarget),
      { typed: true, value: "hello" },
    )
    await expectForwarded(
      instance,
      "readValue",
      { target: { tabId: "tab-1", sessionId: "session-1", id: "field-1" } },
      (browser) => browser.readValue!({ tabId: "tab-1", sessionId: "session-1", id: "field-1" }),
      { value: "hello" },
    )
    await expectForwarded(
      instance,
      "key",
      { key: "Enter", tabId: "tab-1", sessionId: "session-1" },
      (browser) => browser.key("Enter", "tab-1", "session-1"),
      undefined,
    )
    await expectForwarded(
      instance,
      "back",
      { tabId: "tab-1", sessionId: "session-1" },
      (browser) => browser.back("tab-1", "session-1"),
      undefined,
    )
    await expectForwarded(
      instance,
      "forward",
      { tabId: "tab-1", sessionId: "session-1" },
      (browser) => browser.forward("tab-1", "session-1"),
      undefined,
    )
    await expectForwarded(
      instance,
      "reload",
      { tabId: "tab-1", sessionId: "session-1" },
      (browser) => browser.reload("tab-1", "session-1"),
      undefined,
    )
  })

  test("exposes the optional image operations and omits the synchronous currentTab", () => {
    const instance = remoteDriver()
    expect(typeof instance.browser.images).toBe("function")
    expect(typeof instance.browser.saveImage).toBe("function")
    expect(instance.browser.currentTab).toBeUndefined()
  })

  test("rejects when the remote reports a browser failure", async () => {
    const instance = remoteDriver()
    const pending = instance.browser.status()
    const command = await instance.nextCommand(100)
    expect(command?.method).toBe("browser")
    instance.complete({ id: command!.id, ok: false, error: "The embedded browser is unavailable." })
    await expect(pending).rejects.toThrow("The embedded browser is unavailable.")
  })

  test("carries typed browser error codes across the remote channel", async () => {
    const instance = remoteDriver()
    const pending = instance.browser.status()
    const command = await instance.nextCommand(100)
    instance.complete({
      id: command!.id,
      ok: false,
      error: "The embedded browser did not open a tab in time.",
      code: "open_timeout",
    })
    const error = await pending.then(
      () => undefined,
      (reason: unknown) => reason as Error & { code?: string },
    )
    expect(error?.message).toContain("did not open a tab")
    expect(error?.code).toBe("open_timeout")
    expect(browserFailureCode(error)).toBe("open_timeout")
  })
})
