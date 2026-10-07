import { test, expect, _electron } from "@playwright/test"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CdpRuntime } from "@opencode-ai/omnia/browser/cdp"

const binary = process.env.OMNIA_E2E_BINARY ?? "../desktop/dist/linux-unpacked/io.omnia.desktop"

test("embedded browser keeps its target through twenty source navigations and a debugger reset", async () => {
  const root = mkdtempSync(join(tmpdir(), "omnia-browser-e2e-"))
  // Serve deterministic public-host fixtures without contacting third parties.
  // Only this test's Electron process maps *.test to the loopback server.
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://source.test")
    response.writeHead(200, { "content-type": "text/html" })
    response.end(`<html><head><title>Source ${url.pathname}</title></head><body><h1>Research ${url.pathname}</h1><p>Evidence from ${request.headers.host}</p><input aria-label="Research notes" /></body></html>`)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("The fixture server did not bind a port.")
  const application = await _electron.launch({
    executablePath: binary,
    args: ["--host-resolver-rules=MAP *.test 127.0.0.1"],
    env: {
      ...process.env,
      DISPLAY: process.env.DISPLAY ?? ":0",
      XDG_CONFIG_HOME: root,
      OMNIA_DISABLE_UPDATES: "1",
    },
  })
  try {
    const page = await application.firstWindow()
    await expect(page.locator('[data-component="first-run-gate"]')).toBeVisible()
    await application.evaluate(async ({ session }) => {
      await session.fromPartition("persist:omnia-browser").setProxy({ mode: "direct" })
    })
    // Exercise the shipped preload/IPC registration, not a synthetic target.
    const tabId = await page.evaluate(async (url) => {
      const view = document.createElement("webview") as HTMLElement & {
        getWebContentsId(): number
        getURL(): string
      }
      view.setAttribute("partition", "persist:omnia-browser")
      view.setAttribute("style", "position:fixed;inset:20px;width:800px;height:600px;z-index:9999")
      const ready = new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("The browser fixture did not load.")), 20_000)
        view.addEventListener("dom-ready", async () => {
          clearTimeout(timer)
          const id = view.getWebContentsId()
          const api = (window as unknown as { api: {
            browserPanel: { register(input: { webContentsId: number; url: string }): Promise<unknown> }
          } }).api
          await api.browserPanel.register({ webContentsId: id, url: view.getURL() })
          resolve(id)
        }, { once: true })
      })
      view.setAttribute("src", url)
      document.body.append(view)
      return ready
    }, `http://start.test:${address.port}/start`)
    const bridge = await application.evaluate(() => ({
      endpoint: process.env.OMNIA_BROWSER_WS,
      token: process.env.OMNIA_BROWSER_TOKEN,
    }))
    if (!bridge.endpoint || !bridge.token) throw new Error("The packaged browser bridge is not configured.")
    const runtime = new CdpRuntime({ endpoint: bridge.endpoint, token: bridge.token })
    try {
      const documents = new Set<string | undefined>()
      for (const index of Array.from({ length: 20 }, (_, index) => index)) {
        const url = `http://source-${index}.test:${address.port}/article-${index}`
        expect((await runtime.navigate(url, String(tabId))).url).toBe(url)
        const read = await runtime.read(String(tabId))
        expect(read.url).toBe(url)
        expect(read.text).toContain(`article-${index}`)
        documents.add(read.documentId)
      }
      expect(documents.size).toBe(20)
      const field = (await runtime.find("Research notes", { tabId: String(tabId) }))[0]
      expect(field).toBeDefined()
      await runtime.type({ tabId: String(tabId), id: field.id, text: "Packaged browser verified" })
      expect((await runtime.value({ tabId: String(tabId), id: field.id })).value).toBe("Packaged browser verified")
      await application.evaluate(({ webContents }, id) => webContents.fromId(id)?.debugger.detach(), tabId)
      expect((await runtime.read(String(tabId))).url).toContain("source-19.test")
      expect((await runtime.screenshot(String(tabId))).data.length).toBeGreaterThan(0)
      expect((await runtime.tabs()).map((tab) => tab.id)).toContain(String(tabId))
    } finally {
      runtime.closeRuntime()
    }
  } finally {
    await application.close()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    rmSync(root, { recursive: true, force: true })
  }
})
