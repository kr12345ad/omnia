import { plugin } from "bun"
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { EventEmitter } from "node:events"
import type { MenuItemConstructorOptions } from "electron"
import { DESKTOP_NATIVE_ENGLISH } from "@opencode-ai/app/i18n/desktop-native"
import type { BillingAccount } from "./omnia/billing"

// Electron's menu/focus events and the account read are the external boundaries.
// The installed native menus and their refresh handlers are the shipped code.
class TestMenu extends EventEmitter {
  items: { label?: string; enabled?: boolean; submenu?: TestMenu }[]
  constructor(template: MenuItemConstructorOptions[]) {
    super()
    this.items = template.map((item) => ({
      label: item.label,
      enabled: item.enabled,
      submenu: Array.isArray(item.submenu) ? new TestMenu(item.submenu) : undefined,
    }))
  }
}

const app = new EventEmitter()
const installed: TestMenu[] = []
plugin({
  name: "native-account-refresh-electron",
  setup(build) {
    build.module("electron", () => ({
      loader: "object",
      exports: {
        app,
        BrowserWindow: { getFocusedWindow: () => undefined },
        dialog: { showMessageBox: async () => ({ response: 0 }) },
        Menu: {
          buildFromTemplate: (template: MenuItemConstructorOptions[]) => new TestMenu(template),
          setApplicationMenu: (menu: TestMenu) => installed.push(menu),
        },
      },
    }))
  },
})

let account: BillingAccount
let read: () => Promise<BillingAccount>
let reads = 0
mock.module("./omnia/billing", () => ({
  readBillingAccount: () => {
    reads++
    return read()
  },
  // Deliberately permissive: menu.ts must independently enforce configuration.
  canUpgradeTo: () => true,
  canManageBilling: () => true,
  startBillingCheckout: async () => "https://checkout.example/pro",
  startBillingPortal: async () => "https://billing.example/portal",
}))
mock.module("./omnia/control-plane", () => ({ ControlPlaneRequestError: class extends Error {} }))
mock.module("./desktop-menu-actions", () => ({ runDesktopMenuAction: () => undefined }))
mock.module("./windows", () => ({ openExternalURL: () => undefined }))
mock.module("./logging", () => ({ write: () => undefined }))
mock.module("./native-translations", () => ({
  nativeT: (key: keyof typeof DESKTOP_NATIVE_ENGLISH) => DESKTOP_NATIVE_ENGLISH[key],
}))

const deps = { trigger: () => undefined, checkForUpdates: () => undefined, relaunch: () => undefined }
const platform = process.platform
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
let cases = 0

async function mount(os: string) {
  Object.defineProperty(process, "platform", { value: os, configurable: true })
  const menu = await import(`./menu?refresh-case=${cases++}`)
  menu.createMenu(deps)
  await settle()
  return menu
}

function accountMenu(menu = installed.at(-1)!): TestMenu {
  for (const item of menu.items) {
    if (item.label === DESKTOP_NATIVE_ENGLISH["desktop.menu.account"] && item.submenu) return item.submenu
    if (item.label === DESKTOP_NATIVE_ENGLISH["desktop.menu.app"] && item.submenu) return accountMenu(item.submenu)
  }
  throw new Error("Account menu missing")
}

function deferred() {
  let resolve!: (value: BillingAccount) => void
  const promise = new Promise<BillingAccount>((done) => (resolve = done))
  return { promise, resolve }
}

beforeEach(() => {
  app.removeAllListeners()
  installed.length = 0
  reads = 0
  account = { plan: "free", billingConfigured: false, notice: "unconfigured" }
  read = async () => account
})
afterEach(() => {
  Object.defineProperty(process, "platform", { value: platform, configurable: true })
})

describe("native account refresh", () => {
  for (const os of ["darwin", "win32", "linux"]) {
    test(`focus picks up backend configuration and sign-in on ${os}`, async () => {
      const menu = await mount(os)
      expect(app.listenerCount("browser-window-focus")).toBe(1)
      expect(
        accountMenu().items.find((item) => item.label === DESKTOP_NATIVE_ENGLISH["desktop.menu.upgradePro"])?.enabled,
      ).toBe(false)
      account = { plan: "free", billingConfigured: true, notice: undefined }
      app.emit("browser-window-focus")
      await settle()
      expect(reads).toBe(2)
      expect(
        accountMenu().items.find((item) => item.label === DESKTOP_NATIVE_ENGLISH["desktop.menu.upgradePro"])?.enabled,
      ).toBe(true)
      account = { plan: undefined, billingConfigured: false, notice: "signed_out" }
      app.emit("browser-window-focus")
      await settle()
      expect(accountMenu().items.map((item) => item.label)).toContain(
        DESKTOP_NATIVE_ENGLISH["desktop.billing.signedOut"],
      )
      account = { plan: "pro", billingConfigured: true, notice: undefined }
      menu.createMenu(deps)
      await settle()
      expect(app.listenerCount("browser-window-focus")).toBe(1)
      expect(reads).toBe(4)
      expect(accountMenu().items.map((item) => item.label)).toContain("Plan: pro")
    })
  }

  test("opening Account reloads false -> true without a recursive rebuild fetch", async () => {
    await mount("darwin")
    expect(reads).toBe(1)
    account = { plan: "free", billingConfigured: true, notice: undefined }
    accountMenu().emit("menu-will-show")
    await settle()
    expect(reads).toBe(2)
    expect(
      accountMenu().items.find((item) => item.label === DESKTOP_NATIVE_ENGLISH["desktop.menu.upgradePro"])?.enabled,
    ).toBe(true)
    expect(accountMenu().items.map((item) => item.label)).not.toContain(
      DESKTOP_NATIVE_ENGLISH["desktop.billing.notConfigured"],
    )
  })

  test("coalesces focus/menu events and discards a stale response", async () => {
    await mount("darwin")
    const old = deferred()
    const latest = deferred()
    read = () => (reads === 2 ? old.promise : latest.promise)
    app.emit("browser-window-focus")
    for (let i = 0; i < 20; i++) accountMenu().emit("menu-will-show")
    expect(reads).toBe(2)
    old.resolve({ plan: "free", billingConfigured: true, notice: undefined })
    await settle()
    expect(reads).toBe(3)
    expect(accountMenu().items.map((item) => item.label)).toContain(
      DESKTOP_NATIVE_ENGLISH["desktop.billing.notConfigured"],
    )
    latest.resolve({ plan: "pro", billingConfigured: true, notice: undefined })
    await settle()
    expect(reads).toBe(3)
    expect(accountMenu().items.map((item) => item.label)).toContain("Plan: pro")
  })

  test("billingConfigured alone disables actions and explains the unavailable configuration", async () => {
    account = { plan: "free", billingConfigured: false, notice: undefined }
    await mount("darwin")
    const items = accountMenu().items
    for (const key of [
      "desktop.menu.upgradePro",
      "desktop.menu.upgradeBusiness",
      "desktop.menu.manageBilling",
    ] as const)
      expect(items.find((item) => item.label === DESKTOP_NATIVE_ENGLISH[key])?.enabled).toBe(false)
    expect(items.map((item) => item.label)).toContain(DESKTOP_NATIVE_ENGLISH["desktop.billing.notConfigured"])
  })
})
