import { plugin } from "bun"
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { EventEmitter } from "node:events"
import { tmpdir } from "node:os"
import type { MenuItemConstructorOptions } from "electron"
import { createDesktopNativeBundle, DESKTOP_NATIVE_ENGLISH } from "@opencode-ai/app/i18n/desktop-native"

// Exercise installed Electron-style menus and focus events. Account state is
// refreshed by Settings now; the native entry remains usable across rebuilds.
class TestMenu extends EventEmitter {
  items: (Omit<MenuItemConstructorOptions, "submenu"> & { submenu?: TestMenu })[]
  constructor(template: MenuItemConstructorOptions[]) {
    super()
    this.items = template.map((item) => ({
      ...item,
      submenu: Array.isArray(item.submenu) ? new TestMenu(item.submenu) : undefined,
    }))
  }
}

// getPath is part of the boundary other main-process modules read through
// electron-store, which imports the default binding.
const app = Object.assign(new EventEmitter(), { getPath: () => tmpdir() })
const installed: TestMenu[] = []
// This module registers its electron substitution process-wide, so it must
// expose a default export as well as the named members: electron-store imports
// the default, and without it every later file that reaches ./store fails with
// "Missing 'default' export in module 'electron'" from load order alone.
const electron = {
  app,
  BrowserWindow: { getFocusedWindow: () => undefined },
  Menu: {
    buildFromTemplate: (template: MenuItemConstructorOptions[]) => new TestMenu(template),
    setApplicationMenu: (menu: TestMenu) => installed.push(menu),
  },
}
plugin({
  name: "native-account-navigation-electron",
  setup(build) {
    build.module("electron", () => ({
      loader: "object",
      exports: { ...electron, default: electron },
    }))
  },
})
mock.module("./desktop-menu-actions", () => ({ runDesktopMenuAction: () => undefined }))
mock.module("./windows", () => ({ openExternalURL: () => undefined }))

const { createMenu } = await import("./menu?account-navigation-refresh")
const { setNativeTranslations } = await import("./native-translations")
const platform = process.platform
const english = createDesktopNativeBundle("en", (key) => DESKTOP_NATIVE_ENGLISH[key])
const calls: string[] = []
const deps = { trigger: (id: string) => calls.push(id), checkForUpdates: () => undefined, relaunch: () => undefined }

function accountItem(menu = installed.at(-1)!, label = DESKTOP_NATIVE_ENGLISH["desktop.menu.account"] as string) {
  const group = menu.items.find((item) => item.label === label)
  if (group) return group.submenu?.items[0] ?? group
  const application = menu.items.find((item) => item.label === DESKTOP_NATIVE_ENGLISH["desktop.menu.app"])
  const item = application?.submenu?.items.find((item) => item.label === label)
  if (!item) throw new Error("Account action missing")
  return item
}

function clickAccount() {
  const item = accountItem()
  expect(item.enabled).toBe(true)
  expect(item.submenu).toBeUndefined()
  if (!item.click) throw new Error("Account action missing")
  item.click(undefined as never, undefined as never, undefined as never)
}

beforeEach(() => {
  app.removeAllListeners()
  installed.length = 0
  calls.length = 0
  setNativeTranslations(english)
})
afterEach(() => {
  Object.defineProperty(process, "platform", { value: platform, configurable: true })
})

describe("native Account navigation across refreshes", () => {
  for (const os of ["darwin", "win32", "linux"]) {
    test(`focus and opening menus keep Account available without menu-side account refreshes on ${os}`, async () => {
      Object.defineProperty(process, "platform", { value: os, configurable: true })
      createMenu(deps)
      clickAccount()
      expect(app.listenerCount("browser-window-focus")).toBe(0)
      app.emit("browser-window-focus")
      for (const item of installed[0].items) item.submenu?.emit("menu-will-show")
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(installed).toHaveLength(1)
      clickAccount()
      expect(calls).toEqual(["settings.account", "settings.account"])
    })

    test(`a rebuilt ${os} menu routes Account through the latest command handler`, () => {
      Object.defineProperty(process, "platform", { value: os, configurable: true })
      createMenu(deps)
      clickAccount()
      const next = mock((_id: string) => undefined)
      createMenu({ ...deps, trigger: next })
      clickAccount()
      expect(installed).toHaveLength(2)
      expect(calls).toEqual(["settings.account"])
      expect(next.mock.calls).toEqual([["settings.account"]])
    })
  }

  test("a translation refresh updates Account navigation and its submenu together", () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true })
    createMenu(deps)
    setNativeTranslations({ locale: "de", messages: { ...english.messages, "desktop.menu.account": "Konto" } })
    createMenu(deps)
    expect(installed.at(-1)?.items.at(-1)?.label).toBe("Konto")
    expect(accountItem(installed.at(-1), "Konto").label).toBe("Konto")
    expect(accountItem(installed.at(-1), "Konto").enabled).toBe(true)
  })
})
