import { plugin } from "bun"
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import type { MenuItemConstructorOptions } from "electron"
import {
  createDesktopNativeBundle,
  DESKTOP_NATIVE_ENGLISH,
  type DesktopNativeKey,
} from "@opencode-ai/app/i18n/desktop-native"

// Keep the shared menu and native translations real; substitute the Electron
// boundary and browser opener so choosing a menu item cannot launch anything.
type Item = MenuItemConstructorOptions
const installed: Item[][] = []
const trigger = mock((_id: string) => undefined)
const electron = {
  app: { isPackaged: false },
  BrowserWindow: { getFocusedWindow: () => undefined },
  Menu: {
    buildFromTemplate: (template: Item[]) => ({ template }),
    setApplicationMenu: (menu: { template: Item[] }) => installed.push(menu.template),
  },
}
plugin({
  name: "omnia-menu-electron",
  setup(build) {
    build.module("electron", () => ({ exports: { ...electron, default: electron }, loader: "object" }))
  },
})
mock.module("./windows", () => ({
  openExternalURL: () => undefined,
  createMainWindow: () => undefined,
  updateTitlebar: () => undefined,
}))

const { createMenu } = await import("./menu")
const { setNativeTranslations } = await import("./native-translations")
const deps = { trigger, checkForUpdates: () => undefined, relaunch: () => undefined }
const platform = process.platform
const english = createDesktopNativeBundle("en", (key) => DESKTOP_NATIVE_ENGLISH[key])
const copy = (key: DesktopNativeKey) => DESKTOP_NATIVE_ENGLISH[key]

function submenu(item: Item | undefined): Item[] {
  return Array.isArray(item?.submenu) ? item.submenu : []
}

function entries(item: Item): Item[] {
  return [item, ...submenu(item).flatMap(entries)]
}

function render(os = "darwin") {
  Object.defineProperty(process, "platform", { value: os, configurable: true })
  createMenu(deps)
  const template = installed.at(-1)
  if (!template) throw new Error("No menu installed")
  return template
}

function click(item: Item | undefined) {
  if (!item?.click) throw new Error("Missing menu action")
  item.click(undefined as never, undefined as never, undefined as never)
}

beforeEach(() => {
  installed.length = 0
  trigger.mockClear()
  setNativeTranslations(english)
})
afterEach(() => {
  Object.defineProperty(process, "platform", { value: platform, configurable: true })
})

describe("native Account navigation", () => {
  test("macOS places a direct Account action immediately after Settings", () => {
    const template = render()
    const app = submenu(template.find((item) => item.label === copy("desktop.menu.app")))
    const settings = app.findIndex((item) => item.label === copy("desktop.menu.settings"))
    const account = app[settings + 1]

    expect(account.label).toBe(copy("desktop.menu.account"))
    expect(account.enabled).toBe(true)
    expect(account.submenu).toBeUndefined()
    expect(template.map((item) => item.label)).not.toContain(copy("desktop.menu.account"))
    click(account)
    expect(trigger.mock.calls).toEqual([["settings.account"]])
  })

  for (const os of ["win32", "linux"]) {
    test(`${os} has an enabled Account action as the first entry in its top-level submenu`, () => {
      const template = render(os)
      const group = template.at(-1)
      expect(group?.label).toBe(copy("desktop.menu.account"))
      expect(group?.enabled).not.toBe(false)
      const items = submenu(group)
      expect(items).toHaveLength(1)
      expect(items[0].label).toBe(copy("desktop.menu.account"))
      expect(items[0].enabled).toBe(true)
      expect(items[0].submenu).toBeUndefined()
      click(items[0])
      expect(trigger.mock.calls).toEqual([["settings.account"]])
      expect(template.find((item) => item.label === copy("desktop.menu.app"))).toBeUndefined()
    })
  }

  test("installs navigation immediately, with billing actions and notices owned by the Settings page", () => {
    const labels = render()
      .flatMap(entries)
      .map((item) => item.label)
    expect(installed).toHaveLength(1)
    for (const key of [
      "desktop.menu.upgradePro",
      "desktop.menu.upgradeBusiness",
      "desktop.menu.manageBilling",
      "desktop.billing.signedOut",
      "desktop.billing.notConfigured",
      "desktop.billing.unreachable",
    ] as const)
      expect(labels).not.toContain(copy(key))
  })

  test("keeps the ordinary Settings command and platform accelerator", () => {
    for (const [os, accelerator] of [
      ["darwin", "Cmd+,"],
      ["win32", "Ctrl+,"],
      ["linux", "Ctrl+,"],
    ]) {
      trigger.mockClear()
      const template = render(os)
      const settings = template.flatMap(entries).find((item) => item.label === copy("desktop.menu.settings"))
      expect(settings?.accelerator).toBe(accelerator)
      click(settings)
      expect(trigger.mock.calls).toEqual([["settings.open"]])
    }
  })

  test("builds a Windows template with valid labels and no Command accelerators", () => {
    const template = render("win32")
    for (const item of template.flatMap(entries)) {
      if (item.type === "separator" || item.role !== undefined) continue
      expect(typeof item.label === "string" && item.label.length > 0).toBe(true)
    }
    expect(template.length).toBeGreaterThan(1)
    expect(JSON.stringify(template)).not.toContain("Cmd+")
  })

  test("localizes both the top-level Account label and its action", () => {
    setNativeTranslations({ locale: "de", messages: { ...english.messages, "desktop.menu.account": "Konto" } })
    const group = render("linux").at(-1)
    expect(group?.label).toBe("Konto")
    expect(submenu(group)[0].label).toBe("Konto")
    click(submenu(group)[0])
    expect(trigger.mock.calls).toEqual([["settings.account"]])
  })

  test("falls back to the shared English Account label for an older native bundle", () => {
    setNativeTranslations({
      locale: "de",
      messages: { ...english.messages, "desktop.menu.account": undefined } as unknown as typeof english.messages,
    })
    const app = submenu(render().find((item) => item.label === copy("desktop.menu.app")))
    const account = app.find((item) => item.label === copy("desktop.menu.account"))
    expect(account?.enabled).toBe(true)
    click(account)
    expect(trigger.mock.calls).toEqual([["settings.account"]])
  })
})
