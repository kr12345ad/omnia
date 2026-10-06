import { app, BrowserWindow, dialog, Menu } from "electron"
import type { MenuItemConstructorOptions } from "electron"
import {
  DESKTOP_NATIVE_ENGLISH,
  formatDesktopNativeMessage,
  type DesktopNativeKey,
} from "@opencode-ai/app/i18n/desktop-native"
import {
  DESKTOP_MENU,
  desktopMenuVisible,
  type DesktopMenuEntry,
  type DesktopMenuPlatform,
  type DesktopMenuRole,
} from "@opencode-ai/app/desktop-menu"

import { UPDATER_ENABLED } from "./constants"
import { runDesktopMenuAction } from "./desktop-menu-actions"
import { write as writeLog } from "./logging"
import {
  canManageBilling,
  canUpgradeTo,
  readBillingAccount,
  startBillingCheckout,
  startBillingPortal,
  type BillingAccount,
  type BillingAccountNotice,
  type CheckoutPlan,
} from "./omnia/billing"
import { ControlPlaneRequestError } from "./omnia/control-plane"
import { openExternalURL } from "./windows"
import { nativeT } from "./native-translations"

type Deps = {
  trigger: (id: string) => void
  checkForUpdates: () => void
  relaunch: () => void
}

// Nothing is known about the account until the entitlement call answers, and
// until it does the menu must not offer an upgrade the server would refuse.
// This state carries no notice on purpose: a notice is a statement about the
// user, and before the answer arrives the only true statement is that there is
// nothing to say yet. Telling a signed-in user to sign in while a slow control
// plane is being waited on is a false claim, so the group shows no row at all
// until the server has actually said something.
const UNKNOWN_ACCOUNT: BillingAccount = { plan: undefined, billingConfigured: false, notice: undefined }

let account = UNKNOWN_ACCOUNT
let accountHooked = false
let accountRead: Promise<void> | undefined
let accountRefresh = false
let menuDeps: Deps

export function createMenu(deps: Deps) {
  menuDeps = deps
  installMenu(deps)
  // Checkout and sign-in both happen outside the window on every desktop OS.
  if (!accountHooked) {
    accountHooked = true
    app.on("browser-window-focus", () => void syncAccount(menuDeps))
  }
  void syncAccount(deps)
}

function installMenu(deps: Deps) {
  // Account was macOS-only, which left Windows and Linux users with no way to
  // see their plan, upgrade, or be told billing is unconfigured. The Account
  // group is now built on every platform: it sits under the application menu on
  // macOS, and is appended to the menu itself everywhere else. The menu is built
  // from the shared template rather than from whatever was installed before,
  // because on Windows and Linux nothing has been installed yet.
  const platform = desktopPlatform()
  const template =
    platform === "macos"
      ? applicationTemplate(deps, platform)
      : [...applicationTemplate(deps, platform), accountItem(deps)]
  const menu = Menu.buildFromTemplate(template)
  hookAccountMenu(menu, deps)
  Menu.setApplicationMenu(menu)
}

function hookAccountMenu(menu: Menu, deps: Deps) {
  for (const item of menu.items ?? []) {
    if (!item.submenu) continue
    if (item.label === accountLabel("desktop.menu.account") || item.label === nativeT("desktop.menu.app"))
      item.submenu.on("menu-will-show", () => void syncAccount(deps))
    hookAccountMenu(item.submenu, deps)
  }
}

/** The shared menu separates macOS from the Ctrl-accelerated platforms. */
function desktopPlatform(): DesktopMenuPlatform {
  return process.platform === "darwin" ? "macos" : "windows"
}

function applicationTemplate(deps: Deps, platform: DesktopMenuPlatform): MenuItemConstructorOptions[] {
  return DESKTOP_MENU.filter((menu) => desktopMenuVisible(menu, platform)).map((menu) => {
    if (menu.role) return { role: nativeRole(menu.role), label: nativeT(menu.labelKey) }
    const entries = menu.items?.filter((entry) => desktopMenuVisible(entry, platform)) ?? []
    return {
      label: nativeT(menu.labelKey),
      submenu:
        menu.id === "app"
          ? appSubmenu(entries, deps, platform)
          : entries.map((entry) => nativeItem(entry, deps, platform)),
    }
  })
}

/** The application menu, with Account under Settings where it belongs. */
function appSubmenu(
  entries: readonly DesktopMenuEntry[],
  deps: Deps,
  platform: DesktopMenuPlatform,
): MenuItemConstructorOptions[] {
  const settings = entries.findIndex((entry) => entry.type === "item" && entry.command === "settings.open")
  const at = settings < 0 ? 0 : settings + 1
  return [
    ...entries.slice(0, at).map((entry) => nativeItem(entry, deps, platform)),
    accountItem(deps),
    ...entries.slice(at).map((entry) => nativeItem(entry, deps, platform)),
  ]
}

function accountItem(deps: Deps): MenuItemConstructorOptions {
  return { label: accountLabel("desktop.menu.account"), submenu: accountSubmenu(deps) }
}

function accountSubmenu(deps: Deps): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = []
  // Greyed rather than clickable: this row reports the plan and does nothing.
  if (account.plan !== undefined)
    items.push({ label: accountLabel("desktop.menu.plan", { plan: account.plan }), enabled: false })
  if (items.length > 0) items.push({ type: "separator" })
  items.push(
    {
      label: accountLabel("desktop.menu.upgradePro"),
      enabled: account.billingConfigured && canUpgradeTo(account, "pro"),
      click: () => void openCheckout(deps, "pro"),
    },
    {
      label: accountLabel("desktop.menu.upgradeBusiness"),
      enabled: account.billingConfigured && canUpgradeTo(account, "business"),
      click: () => void openCheckout(deps, "business"),
    },
    {
      label: accountLabel("desktop.menu.manageBilling"),
      enabled: account.billingConfigured && canManageBilling(account),
      click: () => void openPortal(deps),
    },
  )
  // A disabled item that says why beats a greyed menu that silently does
  // nothing when the server has no Stripe key.
  const notice =
    account.notice ?? (account.plan !== undefined && !account.billingConfigured ? "unconfigured" : undefined)
  if (notice !== undefined)
    items.push({ type: "separator" }, { label: accountLabel(NOTICE_KEY[notice]), enabled: false })
  return items
}

function syncAccount(deps: Deps): Promise<void> {
  if (accountRead) {
    accountRefresh = true
    return accountRead
  }
  accountRead = (async () => {
    do {
      accountRefresh = false
      const next = await readBillingAccount()
      if (accountRefresh || sameAccount(next, account)) continue
      account = next
      // Installing an updated menu must not trigger another account read.
      installMenu(deps)
    } while (accountRefresh)
  })().finally(() => {
    accountRead = undefined
  })
  return accountRead
}

function sameAccount(a: BillingAccount, b: BillingAccount) {
  return a.plan === b.plan && a.billingConfigured === b.billingConfigured && a.notice === b.notice
}

async function openCheckout(deps: Deps, plan: CheckoutPlan) {
  try {
    openExternalURL(await startBillingCheckout(plan))
  } catch (error) {
    reportBillingFailure(deps, "checkout", error)
  }
}

async function openPortal(deps: Deps) {
  try {
    openExternalURL(await startBillingPortal())
  } catch (error) {
    reportBillingFailure(deps, "portal", error)
  }
}

function reportBillingFailure(deps: Deps, action: "checkout" | "portal", error: unknown) {
  // The server's own refusal is already a sentence a person can act on. A
  // transport failure is not, so it is replaced rather than shown raw.
  const message =
    error instanceof ControlPlaneRequestError ? error.message : accountLabel("desktop.billing.unreachable")
  writeLog("billing", `${action} failed`, { error }, "warn")
  void syncAccount(deps)
  const options = {
    type: "error" as const,
    title: accountLabel("desktop.billing.title"),
    message,
  }
  const win = BrowserWindow.getFocusedWindow()
  void (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options))
}

function nativeItem(entry: DesktopMenuEntry, deps: Deps, platform: DesktopMenuPlatform): MenuItemConstructorOptions {
  if (entry.type === "separator") return { type: "separator" }
  if (entry.role) return { role: nativeRole(entry.role), label: entry.labelKey ? nativeT(entry.labelKey) : undefined }

  const item: MenuItemConstructorOptions = {
    label: entry.labelKey ? nativeT(entry.labelKey) : undefined,
    accelerator: entry.accelerator?.[platform],
    enabled: entry.enabled === "updater" ? UPDATER_ENABLED : undefined,
  }

  if (entry.command) {
    const command = entry.command
    item.click = () => deps.trigger(command)
  }
  if (entry.action) {
    const action = entry.action
    item.click = () =>
      runDesktopMenuAction(BrowserWindow.getFocusedWindow(), action, {
        checkForUpdates: deps.checkForUpdates,
        relaunch: deps.relaunch,
      })
  }
  if (entry.href) {
    const href = entry.href
    item.click = () => openExternalURL(href)
  }

  return item
}

function nativeRole(role: DesktopMenuRole) {
  return role as NonNullable<MenuItemConstructorOptions["role"]>
}

const NOTICE_KEY = {
  signed_out: "desktop.billing.signedOut",
  unconfigured: "desktop.billing.notConfigured",
  unreachable: "desktop.billing.unreachable",
} as const satisfies Record<BillingAccountNotice, DesktopNativeKey>

function accountLabel(key: DesktopNativeKey, params?: Record<string, string | number>) {
  // nativeT is asked without the params on purpose: a bundle missing the key
  // answers undefined, and formatting undefined would throw while substituting
  // the placeholder instead of falling back.
  const translated = nativeT(key)
  return formatDesktopNativeMessage(typeof translated === "string" ? translated : DESKTOP_NATIVE_ENGLISH[key], params)
}
