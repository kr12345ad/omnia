import { plugin } from "bun"
import { createRequire } from "node:module"
import { realpathSync } from "node:fs"
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { createRoot, type JSX, type ParentProps } from "solid-js"
import { createComponent, isServer, render } from "solid-js/web"
import type { CommandOption } from "@/context/command"
import { dict as en } from "@/i18n/en"

// Run the actual dialogs, Settings command hook, and tab widgets in the browser
// transform. The individual Settings pages are boundaries for navigation tests.
const fromApp = createRequire(import.meta.url)
const fromVite = createRequire(realpathSync(fromApp.resolve("vite")))
const fromSolid = createRequire(realpathSync(fromApp.resolve("vite-plugin-solid")))
const esbuild = fromVite("esbuild")
const babel = fromSolid("@babel/core")
const solidPreset = fromSolid("babel-preset-solid")
plugin({
  name: "settings-account-navigation-solid",
  setup(build) {
    build.onLoad({ filter: /\.css$/ }, () => ({ contents: "export default {}", loader: "js" }))
    build.onLoad(
      {
        filter:
          /\/(ui\/src\/.*|app\/src\/components\/(dialog-settings|settings-dialog|settings-v2\/dialog-settings-v2))\.tsx(?:\?.*)?$/,
      },
      async (args) => {
        const path = args.path.split("?")[0]
        const stripped = await esbuild.transform(await Bun.file(path).text(), { loader: "tsx", jsx: "preserve" })
        const local = createRequire(path)
        const isolated = stripped.code.replace(
          /(from\s*|import\s*)(["'])([^"']+)\2/g,
          (match: string, prefix: string, quote: string, specifier: string) => {
            if (
              specifier === "@opencode-ai/ui/dialog" ||
              specifier === "@opencode-ai/ui/v2/dialog-v2" ||
              specifier === "@opencode-ai/ui/context/dialog"
            )
              return match
            if (!specifier.startsWith("@opencode-ai/ui/") && !specifier.startsWith(".")) return match
            if (!path.includes("/ui/src/") && !specifier.startsWith("@opencode-ai/ui/")) return match
            const resolved = local.resolve(specifier)
            if (!resolved.includes("/ui/src/") || !resolved.endsWith(".tsx")) return match
            return `${prefix}${quote}${resolved}?settings-account-navigation${quote}`
          },
        )
        const result = await babel.transformAsync(isolated, {
          filename: path,
          presets: [[solidPreset, { generate: "dom", hydratable: false }]],
          configFile: false,
          babelrc: false,
          sourceMaps: false,
        })
        return { contents: result?.code ?? stripped.code, loader: "js" }
      },
    )
  },
})

function panel(name: string) {
  const element = document.createElement("div")
  element.dataset.testPanel = name
  return element
}

const account = mock((_props: Record<string, unknown>) => panel("account"))
mock.module("../src/components/settings-account", () => ({ SettingsAccount: account }))
for (const [path, name] of [
  ["settings-general", "SettingsGeneral"],
  ["settings-keybinds", "SettingsKeybinds"],
  ["settings-providers", "SettingsProviders"],
  ["settings-models", "SettingsModels"],
  ["settings-servers", "SettingsServers"],
  ["settings-superskills", "SettingsSuperskills"],
  ["settings-mcp-marketplace", "SettingsMcpMarketplace"],
  ["settings-memory", "SettingsMemory"],
  ["settings-computers", "SettingsComputers"],
  ["settings-computer-use", "SettingsComputerUse"],
  ["settings-v2/general", "SettingsGeneralV2"],
  ["settings-v2/providers", "SettingsProvidersV2"],
  ["settings-v2/models", "SettingsModelsV2"],
  ["settings-v2/servers", "SettingsServersV2"],
])
  mock.module(`@/components/${path}`, () => ({ [name]: () => panel(path) }))

const shown: (() => JSX.Element)[] = []
let options: CommandOption[] = []
const params: { id?: string } = { id: "session-account-test" }
mock.module("@/context/command", () => ({
  useCommand: () => ({ register: (_key: string, source: () => CommandOption[]) => (options = source()) }),
}))
mock.module("@solidjs/router", () => ({ useParams: () => params }))
mock.module("@/context/language", () => ({
  useLanguage: () => ({ t: (key: keyof typeof en) => en[key] }),
}))
mock.module("@/context/platform", () => ({ usePlatform: () => ({ version: "26.10.0" }) }))
mock.module("@/context/layout", () => ({ useLayout: () => ({ route: () => ({ type: "home" }) }) }))
mock.module("@/context/tabs", () => ({ useTabs: () => ({ store: [] }) }))
mock.module("@/context/server-sync", () => ({ useServerSync: () => () => ({ session: new Map() }) }))
mock.module("@opencode-ai/ui/context/dialog", () => ({
  useDialog: () => ({ show: (factory: () => JSX.Element) => shown.push(factory) }),
}))
mock.module("@opencode-ai/ui/dialog", () => ({ Dialog: (props: ParentProps) => props.children }))
mock.module("@opencode-ai/ui/v2/dialog-v2", () => ({ Dialog: (props: ParentProps) => props.children }))

const legacy = isServer ? undefined : await import("@/components/dialog-settings")
const v2 = isServer ? undefined : await import("@/components/settings-v2/dialog-settings-v2")
const settings = isServer ? undefined : await import("@/components/settings-dialog")
const cleanups: (() => void)[] = []
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

async function mount(factory: () => JSX.Element) {
  const container = document.createElement("div")
  document.body.append(container)
  const dispose = render(factory, container)
  cleanups.push(() => {
    dispose()
    container.remove()
  })
  await settle()
  return container
}

function tab(container: HTMLElement, value: string) {
  const item = container.querySelector<HTMLElement>(`[role=tab][data-value="${value}"]`)
  if (!item) throw new Error(`Missing tab: ${value}`)
  return item
}

function expectAccount(container: HTMLElement) {
  expect(tab(container, "account").getAttribute("aria-selected")).toBe("true")
  const content = container.querySelector<HTMLElement>(
    `[id="${tab(container, "account").getAttribute("aria-controls")}"]`,
  )
  expect(content).not.toBeNull()
  expect(content!.querySelector("[data-test-panel=account]")).not.toBeNull()
  expect(account.mock.calls.length).toBeGreaterThan(0)
  expect(Object.keys(account.mock.calls.at(-1)![0])).toEqual([])
}

beforeEach(() => {
  options = []
  shown.length = 0
  account.mockClear()
})
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
})

describe.skipIf(isServer)("Settings Account navigation", () => {
  for (const [name, module] of [
    ["legacy", legacy],
    ["v2", v2],
  ] as const) {
    test(`${name} opens MCP Marketplace from its Settings tab`, async () => {
      const container = await mount(() => createComponent(module!.DialogSettings, { defaultValue: "marketplace" }))
      expect(tab(container, "marketplace").textContent).toBe("MCP Marketplace")
      expect(tab(container, "marketplace").getAttribute("aria-selected")).toBe("true")
      expect(container.querySelector('[data-test-panel="settings-mcp-marketplace"]')).not.toBeNull()
    })
    test(`${name} opens directly to the shared Account page`, async () => {
      const container = await mount(() => createComponent(module!.DialogSettings, { defaultValue: "account" }))
      expectAccount(container)
      expect(tab(container, "account").textContent).toBe(en["desktop.menu.account"])
      const tabs = [...container.querySelectorAll("[role=tab]")]
      expect(tabs.indexOf(tab(container, "account"))).toBe(tabs.indexOf(tab(container, "general")) + 1)
    })

    test(`${name} lets the user navigate between General and Account`, async () => {
      const container = await mount(() => createComponent(module!.DialogSettings, {}))
      expect(tab(container, "general").getAttribute("aria-selected")).toBe("true")
      tab(container, "account").dispatchEvent(
        new PointerEvent("pointerdown", { button: 0, pointerType: "mouse", bubbles: true }),
      )
      await settle()
      expectAccount(container)
      tab(container, "general").dispatchEvent(
        new PointerEvent("pointerdown", { button: 0, pointerType: "mouse", bubbles: true }),
      )
      await settle()
      expect(tab(container, "general").getAttribute("aria-selected")).toBe("true")
    })
  }

  test("registers settings.account and its selection opens Account rather than General", async () => {
    createRoot((dispose) => {
      cleanups.push(dispose)
      settings!.useSettingsCommand()
    })
    const command = options.find((option) => option.id === "settings.account")
    expect(command?.title).toBe(en["desktop.menu.account"])
    expect(command?.category).toBe(en["command.category.settings"])
    expect(command?.disabled).not.toBe(true)
    command?.onSelect?.()
    await settle()
    expect(shown).toHaveLength(1)
    expectAccount(await mount(shown[0]))
    expect(options.find((option) => option.id === "settings.open")?.keybind).toBe("mod+comma")
  })

  test("ordinary Settings still opens General", async () => {
    createRoot((dispose) => {
      cleanups.push(dispose)
      settings!.useSettingsCommand()
    })
    options.find((option) => option.id === "settings.open")?.onSelect?.()
    await settle()
    expect(shown).toHaveLength(1)
    const container = await mount(shown[0])
    expect(tab(container, "general").getAttribute("aria-selected")).toBe("true")
  })

  test("the MCP Marketplace command opens its page directly", async () => {
    createRoot((dispose) => {
      cleanups.push(dispose)
      settings!.useSettingsCommand()
    })
    const command = options.find((option) => option.id === "settings.mcp-marketplace")
    expect(command?.title).toBe("MCP Marketplace")
    command?.onSelect?.()
    await settle()
    expect(shown).toHaveLength(1)
    const container = await mount(shown[0])
    expect(tab(container, "marketplace").getAttribute("aria-selected")).toBe("true")
  })
})
