import { BrowserWindow, screen } from "electron"
import { write as writeLog } from "../logging"

export interface AgentOverlay {
  showWorking(): void
  hideWorking(): void
  isVisible(): boolean
  destroy(): void
}

const OVERLAY_PAGE = "overlay.html"

// The overlay is a transparent, click-through, always-on-top window that only
// paints the working ring at the screen edges. It is created on demand and
// destroyed on hide: a permanently hidden BrowserWindow would keep the app
// alive after the last real window closes and would break window recovery.
export function createAgentOverlay(): AgentOverlay {
  let win: BrowserWindow | undefined
  let destroyed = false
  let ready = false
  let pendingShow = false
  const mac = process.platform === "darwin"

  // On macOS a real fullscreen window creates its own Space, so the ring would
  // appear on a new desktop instead of the active one. The overlay follows the
  // display under the cursor and uses simple fullscreen, which stays on the
  // current Space. Linux keeps the real fullscreen path for the KDE panel.
  const targetDisplay = () =>
    mac ? screen.getDisplayNearestPoint(screen.getCursorScreenPoint()) : screen.getPrimaryDisplay()

  const applyMacState = () => {
    if (!win || win.isDestroyed()) return
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    win.setAlwaysOnTop(true, "screen-saver")
    win.setSimpleFullScreen(true)
  }

  const syncBounds = () => {
    if (!win || win.isDestroyed()) return
    win.setBounds(targetDisplay().bounds)
    if (mac) applyMacState()
  }

  screen.on("display-metrics-changed", syncBounds)
  screen.on("display-added", syncBounds)
  screen.on("display-removed", syncBounds)

  const destroyWindow = () => {
    const current = win
    win = undefined
    ready = false
    pendingShow = false
    if (!current || current.isDestroyed()) return
    current.destroy()
  }

  const present = () => {
    if (!win || win.isDestroyed() || !pendingShow) return
    pendingShow = false
    const bounds = targetDisplay().bounds
    win.setBounds(bounds)
    win.showInactive()
    // Fullscreen transitions can reset the input region; re-assert it so the
    // overlay never intercepts clicks meant for the panel or the app.
    if (process.platform === "linux") win.setIgnoreMouseEvents(true)
    else win.setIgnoreMouseEvents(true, { forward: true })
    if (mac) {
      applyMacState()
      setTimeout(() => {
        if (!win || win.isDestroyed()) return
        win.setBounds(targetDisplay().bounds)
        applyMacState()
        win.setIgnoreMouseEvents(true, { forward: true })
      }, 50)
      return
    }
    // KWin only treats the window as fullscreen/above once it is mapped, so
    // re-assert the state after show; without this the overlay is a plain
    // normal window clamped to the work area and the ring misses the panel.
    win.setFullScreen(true)
    win.setAlwaysOnTop(true, "screen-saver")
    setTimeout(() => {
      if (!win || win.isDestroyed()) return
      win.setBounds(bounds)
      win.setFullScreen(true)
      win.setAlwaysOnTop(true, "screen-saver")
      if (process.platform === "linux") win.setIgnoreMouseEvents(true)
      else win.setIgnoreMouseEvents(true, { forward: true })
    }, 50)
  }

  const create = () => {
    const created = new BrowserWindow({
      ...targetDisplay().bounds,
      show: false,
      transparent: true,
      frame: false,
      hasShadow: false,
      skipTaskbar: true,
      focusable: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: !mac,
      acceptFirstMouse: true,
      // A real fullscreen window is what lets the ring cover the KDE panel at
      // the bottom edge; KWin keeps normal above-docks windows below the panel.
      // macOS uses simple fullscreen instead so no extra Space is created.
      fullscreen: !mac,
      title: "Omnia",
      backgroundColor: "#00000000",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    })
    created.setMenuBarVisibility(false)
    // Electron only honors `forward` on Windows and macOS; passing it on Linux
    // can leave the input region active and block clicks on the panel below.
    if (process.platform === "linux") created.setIgnoreMouseEvents(true)
    else created.setIgnoreMouseEvents(true, { forward: true })
    created.setAlwaysOnTop(true, "screen-saver")
    created.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    created.setFocusable(false)
    created.setSkipTaskbar(true)
    if (mac) created.setSimpleFullScreen(true)
    created.once("ready-to-show", () => {
      if (win !== created || created.isDestroyed()) return
      ready = true
      present()
    })
    created.on("closed", () => {
      if (win === created) win = undefined
    })

    const devUrl = process.env.ELECTRON_RENDERER_URL
    const url = devUrl ? new URL(OVERLAY_PAGE, devUrl).toString() : `oc://renderer/${OVERLAY_PAGE}`
    void created.loadURL(url).catch((error) => writeLog("overlay", "failed to load overlay", { error }, "error"))

    win = created
    return created
  }

  return {
    showWorking() {
      if (destroyed) return
      const current = win && !win.isDestroyed() ? win : create()
      current.setAlwaysOnTop(true, "screen-saver")
      if (mac) current.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
      pendingShow = true
      if (ready) present()
    },
    hideWorking() {
      destroyWindow()
    },
    isVisible() {
      if (!win || win.isDestroyed()) return false
      return win.isVisible()
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      screen.removeListener("display-metrics-changed", syncBounds)
      screen.removeListener("display-added", syncBounds)
      screen.removeListener("display-removed", syncBounds)
      destroyWindow()
    },
  }
}
