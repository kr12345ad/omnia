import { execFile } from "node:child_process"
import { systemPreferences } from "electron"
import { Cua, Daemon } from "@opencode-ai/omnia"

// The Cua engine owns observation and semantic actions on every platform; the
// platform driver keeps the pieces the engine cannot express (pointer and
// keyboard synthesis, clipboard, screenshots, process launch, input freeze).
function platformFallbacks(driver: Daemon.HostDriver, platform: "darwin" | "win32"): Cua.CuaLegacyFallbacks {
  const label = platform === "darwin" ? "macOS" : "Windows"
  const unavailable = (message: string) => Promise.resolve({ success: false, status: "unavailable" as const, message })
  const screenshot = async () =>
    (await driver.execute({ type: "screenshot" })) as Awaited<ReturnType<Cua.CuaLegacyFallbacks["captureScreen"]>>
  return {
    capabilities: () => [...(driver.capabilities ?? [])],
    info: () => driver.getInfo(),
    activeWindowId: async () => undefined,
    captureScreen: screenshot,
    clickAt: (x, y, button = 1, count = 1) =>
      driver.execute({
        type: "click",
        target: { kind: "point", x, y },
        button: button === 3 ? "right" : button === 2 ? "middle" : "left",
        count,
      }),
    movePointer: (x, y) => driver.execute({ type: "move", target: { kind: "point", x, y } }),
    sendGlobalKey: (keys) => driver.execute({ type: "key", key: keys }),
    typeText: (value) => driver.execute({ type: "type", text: value }),
    scrollPointer: (direction, amount, x, y) =>
      driver.execute({
        type: "scroll",
        direction:
          direction === "up" || direction === "down" || direction === "left" || direction === "right"
            ? direction
            : "down",
        amount,
        ...(x === undefined || y === undefined ? {} : { target: { kind: "point", x, y } }),
      }),
    dragPointer: (fromX, fromY, toX, toY) =>
      driver.execute({
        type: "drag",
        from: { kind: "point", x: fromX, y: fromY },
        to: { kind: "point", x: toX, y: toY },
      }),
    hoverPointer: (x, y, holdMs) => driver.hoverPointer?.(x, y, holdMs) ?? unavailable("Hovering is not supported."),
    pointerPosition: () => driver.pointerPosition?.() ?? unavailable("Pointer position is not supported."),
    mouseDown: () => driver.mouseDown?.() ?? unavailable("Mouse buttons are not supported."),
    mouseUp: () => driver.mouseUp?.() ?? unavailable("Mouse buttons are not supported."),
    releaseStuckKeys: () => driver.releaseStuckKeys?.() ?? unavailable("Releasing keys is not supported."),
    readText: (input) => driver.readText?.(input) ?? unavailable("Reading element text is not supported."),
    readClipboard: () => driver.readClipboard?.() ?? unavailable("Reading the clipboard is not supported."),
    writeClipboard: (value) => driver.writeClipboard?.(value) ?? unavailable("Writing the clipboard is not supported."),
    writeClipboardImage: () => unavailable(`Clipboard images are not supported on ${label}.`),
    launchApp: (applicationId) => driver.execute({ type: "launch", applicationId }),
    openTarget: (target) => driver.execute({ type: "open", target }),
    runCommand: (request) => driver.runCommand?.(request) ?? unavailable("Shell commands are not supported."),
    closeWindowId: () => unavailable(`Window ids are not used on ${label}.`),
    minimizeWindowId: () => unavailable(`Minimizing by window id is not supported on ${label}.`),
    restoreWindowId: () => unavailable(`Restoring by window id is not supported on ${label}.`),
    grabInput: () => unavailable(`Input freeze is not supported on ${label}.`),
    releaseInput: () => unavailable(`Input freeze is not supported on ${label}.`),
    inputGrabState: () =>
      Promise.resolve({
        success: true,
        status: "success" as const,
        message: `Input freeze is not supported on ${label}.`,
        frozen: false,
        supported: false,
      }),
    subscribeInputGrab: () => () => {},
    dispose: () => driver.dispose?.(),
  }
}

// The desktop app no longer embeds the Omnia server. This driver backs the
// local runtime that registers with the hosted control plane and serves
// computer-control commands through the signed remote channel.
let accessibilityPromptShown = false
export function createPlatformHostDriver(platform: NodeJS.Platform = process.platform): Daemon.HostDriver | undefined {
  if (platform === "darwin") {
    // Trigger the macOS Accessibility prompt so the installed app registers in
    // System Settings > Privacy & Security > Accessibility and can be enabled.
    // Prompt at most once per launch: the system re-shows the dialog on every
    // call while untrusted, which reads as the app nagging. After the user
    // grants access they must relaunch the app for the grant to take effect.
    if (!systemPreferences.isTrustedAccessibilityClient(false) && !accessibilityPromptShown) {
      accessibilityPromptShown = true
      systemPreferences.isTrustedAccessibilityClient(true)
    }
    const legacy = Daemon.createDarwinHostDriver()
    return Cua.createCuaHostDriver({ platform: "darwin", legacy: platformFallbacks(legacy, "darwin"), surface: legacy })
  }
  // Windows was legacy-only; the CUA engine (UIA) now leads there too, with
  // the PowerShell driver kept as the fallback surface for capabilities the
  // engine cannot express.
  if (platform === "win32") {
    const legacy = Daemon.createWindowsHostDriver()
    return Cua.createCuaHostDriver({ platform: "win32", legacy: platformFallbacks(legacy, "win32"), surface: legacy })
  }
  const host = new Daemon.LinuxHostDriver()
  if (!host.available) return undefined
  return Daemon.createHostDriver(host)
}

// Flatpak sandboxes LibreOffice away from the accessibility bus, which hides
// its entire UI tree. Grant the narrow a11y bus permission once so the runtime
// can see the app's controls.
export async function ensureFlatpakAccessibility(): Promise<void> {
  if (process.platform !== "linux") return
  const run = (args: string[]) => new Promise<string | undefined>((resolve) => {
    execFile("flatpak", args, { timeout: 5000, killSignal: "SIGKILL", windowsHide: true }, (error, stdout) => {
      resolve(error ? undefined : stdout)
    })
  })
  if (await run(["info", "org.libreoffice.LibreOffice"]) === undefined) return
  const permissions = await run(["info", "--show-permissions", "org.libreoffice.LibreOffice"])
  if (permissions?.includes("org.a11y.Bus=talk")) return
  await run(["override", "--user", "--talk-name=org.a11y.Bus", "--env=NO_AT_BRIDGE=0", "org.libreoffice.LibreOffice"])
}
