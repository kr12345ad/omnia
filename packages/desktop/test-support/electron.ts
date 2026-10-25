import { plugin } from "bun"

import { testUserData } from "./user-data"

// One Electron substitution for every main-process suite.
//
// Bun runs all test files in one process, and a module keeps the `electron` it
// resolved when it was first imported. A module one suite loads can therefore
// bind another suite's fake, so a fake that leaves members out — or records
// handlers privately — silently breaks the suite that owns the module. This
// one carries the whole surface those modules touch and keeps the handler and
// shell records in one place. Suites with a bespoke surface (windows, menus)
// spread this one and override only what they drive.
//
// `app.getPath("userData")` answers with the directory the current suite
// claimed, so no two suites share a session or control-plane file.

export const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
export const opened: string[] = []

let encryptionAvailable = true

export function setEncryptionAvailable(available: boolean): void {
  encryptionAvailable = available
}

class FakeBrowserWindow {
  destroyed = false
  static getAllWindows(): unknown[] {
    return []
  }
  static getFocusedWindow(): undefined {
    return undefined
  }
  static fromWebContents(): undefined {
    return undefined
  }
  constructor(_options?: unknown) {}
  setMenuBarVisibility() {}
  setIgnoreMouseEvents() {}
  setAlwaysOnTop() {}
  setVisibleOnAllWorkspaces() {}
  setFocusable() {}
  setSkipTaskbar() {}
  setSimpleFullScreen() {}
  setFullScreen() {}
  setBounds() {}
  showInactive() {}
  once() {}
  on() {}
  loadURL() {
    return Promise.resolve()
  }
  destroy() {
    this.destroyed = true
  }
  isDestroyed() {
    return this.destroyed
  }
}

export const fakeElectron = {
  app: {
    getPath: () => testUserData(),
    getAppPath: () => ".",
    on: () => undefined,
    once: () => undefined,
    isPackaged: false,
  },
  systemPreferences: { isTrustedAccessibilityClient: () => false },
  powerSaveBlocker: { start: () => 1, stop: () => undefined, isStarted: () => false },
  screen: {
    getDisplayNearestPoint: () => ({ x: 0, y: 0 }),
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 800, height: 600 } }),
    on: () => undefined,
    removeListener: () => undefined,
  },
  BrowserWindow: FakeBrowserWindow,
  safeStorage: {
    isEncryptionAvailable: () => encryptionAvailable,
    encryptString: (value: string) => Buffer.from(`omnia-test:${value}`, "utf8"),
    decryptString: (value: Buffer) => {
      const text = Buffer.from(value).toString("utf8")
      if (!text.startsWith("omnia-test:")) throw new Error("not produced by the test safe storage")
      return text.slice("omnia-test:".length)
    },
  },
  shell: {
    openExternal: async (url: string) => {
      opened.push(url)
    },
  },
  crashReporter: { start: () => undefined },
  netLog: { startLogging: async () => undefined, stopLogging: async () => undefined, currentlyLogging: false },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    },
    on: () => undefined,
    removeListener: () => undefined,
  },
}

plugin({
  name: "omnia-test-electron",
  setup(build) {
    build.module("electron", () => ({ exports: { ...fakeElectron, default: fakeElectron }, loader: "object" }))
  },
})
