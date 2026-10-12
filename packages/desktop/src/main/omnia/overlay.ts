import { BrowserWindow, screen } from "electron"
import { write as writeLog } from "../logging"

export interface AgentOverlay {
  showWorking(): void
  hideWorking(): void
  isVisible(): boolean
  destroy(): void
}

export interface AgentTargetHighlightInput {
  readonly bounds: { x: number; y: number; width: number; height: number }
  /** The point the action will actually use, when the resolution reported one. */
  readonly aim?: { x: number; y: number }
  /** A bounds-center aim is a guess, and it is painted as one. */
  readonly guess: boolean
}

export interface AgentTargetHighlight {
  show(input: AgentTargetHighlightInput): void
  hide(): void
  isVisible(): boolean
  destroy(): void
}

const OVERLAY_PAGE = "overlay.html"
const HIGHLIGHT_ID = "omnia-agent-target"
// Room around the target for the outline itself: a 1px control keeps a visible
// ring instead of being drawn over its own border.
const HIGHLIGHT_PAD = 8
// A highlight is owned by a hovered approval. A renderer that goes away without
// clearing it must not leave a marker on the desktop forever.
const HIGHLIGHT_TTL_MS = 60_000
const HIGHLIGHT_COLOR = "#4f9dff"
const HIGHLIGHT_GUESS_COLOR = "#f5a524"

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

// A click-through window sized to one target's bounds, used only while a human
// is deciding a computer-use permission. It shares the overlay page but nothing
// else: unlike the working ring it is created on demand and destroyed on hide,
// and it never paints on its own because only createAgentTargetHighlight ever
// asks it to.
export function createAgentTargetHighlight(): AgentTargetHighlight {
  let win: BrowserWindow | undefined
  let current: AgentTargetHighlightInput | undefined
  let ready = false
  let destroyed = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const clearTimer = () => {
    if (timer === undefined) return
    clearTimeout(timer)
    timer = undefined
  }

  const rectFor = (input: AgentTargetHighlightInput) => {
    const width = Math.max(2, Math.round(input.bounds.width))
    const height = Math.max(2, Math.round(input.bounds.height))
    return {
      x: Math.round(input.bounds.x) - HIGHLIGHT_PAD,
      y: Math.round(input.bounds.y) - HIGHLIGHT_PAD,
      width: width + HIGHLIGHT_PAD * 2,
      height: height + HIGHLIGHT_PAD * 2,
      target: { width, height },
    }
  }

  const paint = () => {
    const view = win
    const input = current
    if (view === undefined || view.isDestroyed() || input === undefined) return
    const rect = rectFor(input)
    const color = input.guess ? HIGHLIGHT_GUESS_COLOR : HIGHLIGHT_COLOR
    const border = input.guess ? "dashed" : "solid"
    const spot =
      input.aim === undefined
        ? undefined
        : {
            x: Math.min(Math.max(Math.round(input.aim.x) - rect.x, 5), Math.max(5, rect.width - 5)),
            y: Math.min(Math.max(Math.round(input.aim.y) - rect.y, 5), Math.max(5, rect.height - 5)),
          }
    const dotX = spot === undefined ? -100 : spot.x - 5
    const dotY = spot === undefined ? -100 : spot.y - 5
    const code = `(() => {
      const root = document.getElementById(${JSON.stringify(HIGHLIGHT_ID)}) ?? document.createElement("div")
      root.id = ${JSON.stringify(HIGHLIGHT_ID)}
      root.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647"
      root.replaceChildren()
      const box = document.createElement("div")
      box.style.cssText = "position:absolute;left:${HIGHLIGHT_PAD}px;top:${HIGHLIGHT_PAD}px;width:${rect.target.width}px;height:${rect.target.height}px;box-sizing:border-box;border:2px ${border} ${color};border-radius:4px;background:${color}1f"
      root.appendChild(box)
      const dot = document.createElement("div")
      dot.style.cssText = "position:absolute;left:${dotX}px;top:${dotY}px;width:10px;height:10px;border-radius:50%;background:${color};box-shadow:0 0 0 1px rgba(0,0,0,0.5)"
      root.appendChild(dot)
      if (!root.isConnected) document.documentElement.appendChild(root)
      return true
    })()`
    void view.webContents.executeJavaScript(code).catch(() => undefined)
  }

  const destroyWindow = () => {
    const view = win
    win = undefined
    ready = false
    current = undefined
    clearTimer()
    if (view === undefined || view.isDestroyed()) return
    view.destroy()
  }

  const create = () => {
    const input = current
    if (input === undefined) return undefined
    const rect = rectFor(input)
    const created = new BrowserWindow({
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
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
      fullscreenable: false,
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
    // The marker must never take a click meant for the control it outlines.
    if (process.platform === "linux") created.setIgnoreMouseEvents(true)
    else created.setIgnoreMouseEvents(true, { forward: true })
    created.setAlwaysOnTop(true, "screen-saver")
    created.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    created.setFocusable(false)
    created.setSkipTaskbar(true)
    created.once("ready-to-show", () => {
      if (win !== created || created.isDestroyed()) return
      ready = true
      paint()
      created.showInactive()
    })
    created.on("closed", () => {
      if (win === created) win = undefined
    })

    const devUrl = process.env.ELECTRON_RENDERER_URL
    const url = devUrl ? new URL(OVERLAY_PAGE, devUrl).toString() : `oc://renderer/${OVERLAY_PAGE}`
    void created.loadURL(url).catch((error) => writeLog("overlay", "failed to load target highlight", { error }, "error"))

    win = created
    return created
  }

  return {
    show(input: AgentTargetHighlightInput) {
      if (destroyed) return
      current = input
      clearTimer()
      timer = setTimeout(() => {
        timer = undefined
        destroyWindow()
      }, HIGHLIGHT_TTL_MS)
      timer.unref?.()
      if (win !== undefined && !win.isDestroyed()) {
        win.setBounds(rectFor(input))
        paint()
        return
      }
      create()
      if (ready) {
        win?.showInactive()
        paint()
      }
    },
    hide() {
      destroyWindow()
    },
    isVisible() {
      if (win === undefined || win.isDestroyed()) return false
      return win.isVisible()
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      destroyWindow()
    },
  }
}
