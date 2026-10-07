import { plugin } from "bun"
import { afterEach, describe, expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import { realpathSync } from "node:fs"
import { createComponent, render } from "solid-js/web"
import type { BrowserPanelCommand } from "@/context/platform"
import { dict as en } from "@/i18n/en"

const local = createRequire(import.meta.url)
const vite = createRequire(realpathSync(local.resolve("vite")))
const solid = createRequire(realpathSync(local.resolve("vite-plugin-solid")))
plugin({
  name: "browser-panel-solid",
  setup(build) {
    build.onLoad({ filter: /\/app\/src\/components\/browser-panel\.tsx(?:\?.*)?$/ }, async (args) => {
      const path = args.path.split("?")[0]
      const fileRequire = createRequire(path)
      const stripped = await vite("esbuild").transform(await Bun.file(path).text(), { loader: "tsx", jsx: "preserve" })
      // Retag ONLY the component under test's own imports, so its context and
      // ui-kit dependencies resolve to ?browser-panel copies. Every other suite
      // keeps the shared modules: this file can neither inherit their mocks
      // nor impose its own on files that run after it.
      const isolated = stripped.code.replace(
        /(from\s*|import\s*)(["'])([^"']+)\2/g,
        (match: string, prefix: string, quote: string, specifier: string) => {
          const tag = (target: string) => `${prefix}${quote}${target}?browser-panel${quote}`
          if (
            specifier === "@/context/language" ||
            specifier === "@/context/platform" ||
            specifier === "@/context/settings"
          ) {
            return tag(specifier)
          }
          if (!specifier.startsWith("@opencode-ai/ui/")) return match
          const resolved = fileRequire.resolve(specifier)
          if (!resolved.includes("/ui/src/") || !resolved.endsWith(".tsx")) return match
          return `${prefix}${quote}${resolved}?browser-panel${quote}`
        },
      )
      const result = await solid("@babel/core").transformAsync(isolated, {
        filename: path,
        presets: [[solid("babel-preset-solid"), { generate: "dom", hydratable: false }]],
        configFile: false,
        babelrc: false,
      })
      return { contents: result.code, loader: "js" }
    })
  },
})

let command: (input: BrowserPanelCommand) => void = () => undefined
const registrations: number[] = []
const removals: number[] = []
const platform = {
  platform: "desktop",
  browserPanel: {
    register: async (input: { webContentsId: number }) => { registrations.push(input.webContentsId) },
    unregister: async (id: number) => { removals.push(id) },
    activate: async () => undefined,
    answerDialog: async () => undefined,
    onCommand: (listener: typeof command) => { command = listener; return () => { command = () => undefined } },
  },
}
mock.module("@/context/platform?browser-panel", () => ({ usePlatform: () => platform }))
mock.module("@/context/settings?browser-panel", () => ({
  useSettings: () => ({ general: {
    browserPanelOpen: () => true,
    browserPanelWidth: () => 500,
    setBrowserPanelOpen: () => undefined,
    setBrowserPanelWidth: () => undefined,
  } }),
}))
mock.module("@/context/language?browser-panel", () => ({ useLanguage: () => ({ t: (key: keyof typeof en) => en[key] }) }))
mock.module(`${local.resolve("@opencode-ai/ui/icon")}?browser-panel`, () => ({
  Icon: () => document.createElement("span"),
}))
mock.module(`${local.resolve("@opencode-ai/ui/icon-button")}?browser-panel`, () => ({
  IconButton: () => document.createElement("button"),
}))
mock.module(`${local.resolve("@opencode-ai/ui/tooltip")}?browser-panel`, () => ({
  Tooltip: (props: { children: unknown }) => props.children,
}))

const { BrowserPanel } = await import("@/components/browser-panel?browser-panel")
const cleanups: (() => void)[] = []
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
async function mount() {
  registrations.length = 0
  removals.length = 0
  const container = document.createElement("div")
  document.body.append(container)
  const dispose = render(() => createComponent(BrowserPanel, {}), container)
  cleanups.push(() => { dispose(); container.remove() })
  await settle()
  return { container, dispose }
}
afterEach(() => cleanups.splice(0).forEach((dispose) => dispose()))

describe("embedded browser panel", () => {
  test("a retried open keeps one webview even before dom-ready", async () => {
    const { container } = await mount()
    command({ kind: "open", requestId: "slow-source", url: "https://example.test/source" })
    await settle()
    const original = container.querySelector("webview")
    expect(original).not.toBeNull()
    command({ kind: "open", requestId: "slow-source", url: "https://example.test/source" })
    await settle()
    expect(container.querySelectorAll("webview")).toHaveLength(1)
    expect(container.querySelector("webview")).toBe(original)
    command({ kind: "open", requestId: "second-source", url: "https://example.test/second" })
    await settle()
    expect(container.querySelectorAll("webview")).toHaveLength(2)
  })

  test("navigation clears the visible dialog and unmount unregisters the guest", async () => {
    const { container, dispose } = await mount()
    command({ kind: "open", requestId: "source", url: "https://example.test/source" })
    await settle()
    const guest = container.querySelector("webview") as HTMLElement & { getWebContentsId: () => number }
    guest.getWebContentsId = () => 42
    guest.dispatchEvent(new Event("dom-ready"))
    await settle()
    expect(registrations).toEqual([42])
    command({ kind: "dialog", tabId: 42, type: "alert", message: "Old document dialog" })
    await settle()
    expect(container.textContent).toContain("Old document dialog")
    guest.dispatchEvent(Object.assign(new Event("did-navigate"), { url: "https://example.test/next" }))
    await settle()
    expect(container.textContent).not.toContain("Old document dialog")
    dispose()
    expect(removals).toEqual([42])
  })

  test("a refused address explains itself and a public one opens a tab", async () => {
    const { container } = await mount()
    const input = container.querySelector("input") as HTMLInputElement
    input.value = "localhost:3000"
    input.dispatchEvent(new Event("input", { bubbles: true }))
    await settle()
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    await settle()

    // The refused address is visible as refused instead of silently doing nothing.
    expect(container.textContent).toContain(en["browser.panel.address.blocked"])
    expect(input.getAttribute("aria-invalid")).toBe("true")
    expect(container.querySelectorAll("webview")).toHaveLength(0)

    input.value = "https://example.test/allowed"
    input.dispatchEvent(new Event("input", { bubbles: true }))
    await settle()
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    await settle()
    expect(container.textContent).not.toContain(en["browser.panel.address.blocked"])
    expect(container.querySelectorAll("webview")).toHaveLength(1)
  })
})
