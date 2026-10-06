import { BrowserWindow, Menu } from "electron"
import type { MenuItemConstructorOptions } from "electron"
import { DESKTOP_NATIVE_ENGLISH } from "@opencode-ai/app/i18n/desktop-native"
import {
  DESKTOP_MENU,
  desktopMenuVisible,
  type DesktopMenuEntry,
  type DesktopMenuPlatform,
  type DesktopMenuRole,
} from "@opencode-ai/app/desktop-menu"

import { UPDATER_ENABLED } from "./constants"
import { runDesktopMenuAction } from "./desktop-menu-actions"
import { openExternalURL } from "./windows"
import { nativeT } from "./native-translations"

type Deps = {
  trigger: (id: string) => void
  checkForUpdates: () => void
  relaunch: () => void
}

export function createMenu(deps: Deps) {
  const platform = desktopPlatform()
  const account = accountItem(deps)
  const template =
    platform === "macos"
      ? applicationTemplate(deps, platform)
      : [...applicationTemplate(deps, platform), { label: account.label, submenu: [account] }]
  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
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
  return {
    label: nativeT("desktop.menu.account") ?? DESKTOP_NATIVE_ENGLISH["desktop.menu.account"],
    enabled: true,
    click: () => deps.trigger("settings.account"),
  }
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
