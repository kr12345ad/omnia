import { execFile } from "node:child_process"
import { powerSaveBlocker } from "electron"
import { write as writeLog } from "../logging"

export interface AgentPower {
  preventSleep(): void
  allowSleep(): void
  destroy(): void
}

type X11State = { screensaverTimeout: number; dpmsEnabled: boolean }

const COMMAND_TIMEOUT_MS = 5000
const SCREEN_SAVER_DEST = "org.freedesktop.ScreenSaver"
const SCREEN_SAVER_PATH = "/ScreenSaver"

export function createAgentPower(): AgentPower {
  let blocker: number | undefined
  let inhibitCookie: string | undefined
  let active = false
  let x11State: X11State | undefined
  let x11RestoreNeeded = false
  // Bumped on every transition so a late `xset q` reply cannot resurrect
  // stale state after the screensaver has already been restored.
  let x11Generation = 0

  const run = (command: string, args: string[], onOutput?: (output: string) => void) => {
    execFile(command, args, { timeout: COMMAND_TIMEOUT_MS }, (error, stdout) => {
      if (error) {
        writeLog("agent", `${command} failed`, { args, error: String(error) }, "warn")
        return
      }
      onOutput?.(stdout)
    })
  }

  const parseX11State = (query: string): X11State | undefined => {
    const timeout = /timeout:\s+(\d+)/.exec(query)
    const dpms = /DPMS is (Enabled|Disabled)/.exec(query)
    if (!timeout || !dpms) return undefined
    return { screensaverTimeout: Number.parseInt(timeout[1], 10), dpmsEnabled: dpms[1] === "Enabled" }
  }

  const canUseXset = () => process.platform === "linux" && Boolean(process.env.DISPLAY)

  const inhibitScreenSaver = () => {
    if (process.platform !== "linux") return
    run(
      "dbus-send",
      [
        "--session",
        "--print-reply",
        `--dest=${SCREEN_SAVER_DEST}`,
        SCREEN_SAVER_PATH,
        `${SCREEN_SAVER_DEST}.Inhibit`,
        "string:Omnia",
        "string:AgentWorking",
      ],
      (output) => {
        const cookie = /uint32\s+(\d+)/.exec(output)?.[1]
        if (cookie) inhibitCookie = cookie
      },
    )
  }

  const uninhibitScreenSaver = () => {
    if (process.platform !== "linux") return
    if (inhibitCookie === undefined) return
    run("dbus-send", [
      "--session",
      "--print-reply",
      `--dest=${SCREEN_SAVER_DEST}`,
      SCREEN_SAVER_PATH,
      `${SCREEN_SAVER_DEST}.UnInhibit`,
      `uint32:${inhibitCookie}`,
    ])
    inhibitCookie = undefined
  }

  const disableX11Screensaver = () => {
    if (!canUseXset()) return
    const generation = ++x11Generation
    run("xset", ["q"], (output) => {
      if (generation !== x11Generation || !active) return
      x11State = parseX11State(output)
    })
    run("xset", ["s", "off", "-dpms"])
    x11RestoreNeeded = true
  }

  const restoreX11Screensaver = () => {
    if (!x11RestoreNeeded) return
    x11Generation++
    x11RestoreNeeded = false
    // Restore the user's original timeout when it was readable; otherwise fall
    // back to the X server defaults.
    if (x11State?.screensaverTimeout === 0) run("xset", ["s", "off"])
    else run("xset", ["s", "reset"])
    if (x11State === undefined || x11State.dpmsEnabled) {
      run("xset", ["+dpms"])
      run("xset", ["dpms", "force", "on"])
    }
    x11State = undefined
  }

  const preventSleep = () => {
    if (active) return
    active = true
    if (blocker === undefined || !powerSaveBlocker.isStarted(blocker)) {
      blocker = powerSaveBlocker.start("prevent-display-sleep")
    }
    inhibitScreenSaver()
    disableX11Screensaver()
  }

  const allowSleep = () => {
    if (!active) return
    active = false
    if (blocker !== undefined) {
      if (powerSaveBlocker.isStarted(blocker)) powerSaveBlocker.stop(blocker)
      blocker = undefined
    }
    uninhibitScreenSaver()
    restoreX11Screensaver()
  }

  return {
    preventSleep,
    allowSleep,
    destroy: allowSleep,
  }
}
