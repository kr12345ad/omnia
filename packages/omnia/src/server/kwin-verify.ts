// KWin state verifier for Wayland window-management actions.
//
// Background: UI-TARS grounding fails on tiny title-bar buttons
// (Minimize (1834,45) vs Close (1843,45), 9px apart). A first click falsely
// reported Verified while the window stayed open/focused because the generic
// observation-diff verifier accepts *any* state change.
//
// This module replaces generic change-detection for window-management
// actions with positive KWin state checks:
//
//   Fallback chain: KWin DBus -> AT-SPI/accessibility focus check -> observation.
//
// Notes on platform coverage:
// - xdotool/wmctrl are dead on Wayland and are deliberately NOT used.
// - On X11 (incl. Plasma 5 X11) `xprop -root _NET_ACTIVE_WINDOW` and
//   `_NET_WM_STATE`/`_NET_WM_STATE_HIDDEN` remain the reliable path and are
//   used as an X11 fallback (the Linux host driver already uses xprop).
// - On Plasma 5.27 (X11-only, verified 2026-09-27 via qdbus-qt5):
//     `org.kde.KWin.activeWindow` does NOT exist at /KWin (UnknownMethod).
//     `queryWindowInfo` requires interactive picking (UserCancel).
//     `getWindowInfo <x11id>` returns empty for X11 ids.
//   The `activeWindow` method is expected on Plasma 6 Wayland (per task
//   context); we try it first and degrade gracefully when absent.
// - Minimized state via KWin is queried with `getWindowInfo <id>` and parsed
//   for a `minimized` field. The exact QVariantMap shape varies by Plasma
//   version (see uncertainties in the task report); parsing is intentionally
//   lenient and returns undefined when the field is absent.

import type { Observation, UIElement, Verification } from "../protocol"

export const KWIN_VERIFY_SETTLE_MS = 500

export const KWIN_DBUS_SERVICE = "org.kde.KWin"
export const KWIN_DBUS_PATH = "/KWin"
export const KWIN_DBUS_ACTIVE_METHOD = "org.kde.KWin.activeWindow"
export const KWIN_DBUS_WINDOW_INFO_METHOD = "org.kde.KWin.getWindowInfo"

export interface KWinShellResult {
  readonly stdout: string
  readonly exitCode: number | null
}

// Minimal shell abstraction so the verifier works both from
// ComputerManager (via driver.runCommand) and from unit tests.
export type KWinShellRunner = (command: string) => Promise<KWinShellResult | undefined>

export interface KWinActiveWindow {
  readonly windowId: string
  readonly command: string
}

export interface KWinMinimizedState {
  readonly minimized: boolean
  readonly command: string
}

// Candidate qdbus invocations across Plasma/Qt versions. qdbus-qt5 exists on
// Plasma 5 systems where the `qdbus` wrapper is missing; qdbus6 is the
// Plasma 6 name. All three speak the same session-bus API.
export const KWIN_ACTIVE_WINDOW_COMMANDS: readonly string[] = [
  `qdbus ${KWIN_DBUS_SERVICE} ${KWIN_DBUS_PATH} ${KWIN_DBUS_ACTIVE_METHOD}`,
  `qdbus6 ${KWIN_DBUS_SERVICE} ${KWIN_DBUS_PATH} ${KWIN_DBUS_ACTIVE_METHOD}`,
  `qdbus-qt5 ${KWIN_DBUS_SERVICE} ${KWIN_DBUS_PATH} ${KWIN_DBUS_ACTIVE_METHOD}`,
]

export function kwinWindowInfoCommands(windowId: string): string[] {
  const safe = windowId.trim()
  // Reject shell metacharacters: ids are hex (0x...) or decimal ints.
  if (!/^(0x[0-9a-fA-F]+|\d+)$/.test(safe)) return []
  return [
    `qdbus ${KWIN_DBUS_SERVICE} ${KWIN_DBUS_PATH} ${KWIN_DBUS_WINDOW_INFO_METHOD} ${safe}`,
    `qdbus6 ${KWIN_DBUS_SERVICE} ${KWIN_DBUS_PATH} ${KWIN_DBUS_WINDOW_INFO_METHOD} ${safe}`,
    `qdbus-qt5 ${KWIN_DBUS_SERVICE} ${KWIN_DBUS_PATH} ${KWIN_DBUS_WINDOW_INFO_METHOD} ${safe}`,
  ]
}

// X11 fallback via xprop (already used by LinuxHostDriver.windows()).
// Dead on Wayland (xprop cannot see Wayland windows) but reliable on X11,
// so it stays as a fallback -- never as the Wayland primary.
export const X11_ACTIVE_WINDOW_COMMAND = "xprop -root _NET_ACTIVE_WINDOW"

export function x11WindowStateCommand(windowId: string): string | undefined {
  const safe = windowId.trim().toLowerCase()
  if (!/^0x[0-9a-f]+$/.test(safe)) return undefined
  return `xprop -id ${safe} _NET_WM_STATE`
}

// KWin `activeWindow` prints the active window id. Observed shapes:
// - Plasma 6 (expected): decimal int, e.g. "123456", or hex "0x...", "0" = none.
// - UnknownMethod errors go to stdout via qdbus-qt5 ("Error: ...") and must
//   not parse as an id.
export function parseKWinActiveWindow(stdout: string): string | undefined {
  const trimmed = stdout.trim()
  if (trimmed.length === 0) return undefined
  if (/error|unknownmethod|user\s*cancel|cancelled/i.test(trimmed)) return undefined
  const hex = trimmed.match(/0x[0-9a-fA-F]+/)
  if (hex?.[0] !== undefined) {
    return hex[0].toLowerCase() === "0x0" ? undefined : hex[0].toLowerCase()
  }
  const dec = trimmed.match(/^\d+\s*$/)
  if (dec !== null) {
    return trimmed === "0" ? undefined : trimmed
  }
  // QVariantMap-style output may embed the id; fall through to undefined
  // rather than guessing.
  return undefined
}

// Lenient parse of `getWindowInfo` QVariantMap output for a minimized flag.
// Returns undefined when the field is absent so callers fall through to
// AT-SPI instead of claiming unverified success.
export function parseKWinMinimized(stdout: string): boolean | undefined {
  const text = stdout.trim()
  if (text.length === 0) return undefined
  if (/error|unknownmethod|cancelled/i.test(text)) return undefined
  const match = text.match(/minimiz\w*\s*[:=]\s*(true|false|1|0|yes|no)/i)
  if (match?.[1] === undefined) return undefined
  const value = match[1].toLowerCase()
  return value === "true" || value === "1" || value === "yes"
}

// _NET_WM_STATE(ATOM) = _NET_WM_STATE_HIDDEN, ... means minimized/iconified.
export function parseX11Minimized(stdout: string): boolean | undefined {
  if (/no such window|cannot open display|invalid window/i.test(stdout)) return undefined
  if (!/_NET_WM_STATE/i.test(stdout)) return undefined
  return /_NET_WM_STATE_HIDDEN/i.test(stdout)
}

export function parseX11ActiveWindow(stdout: string): string | undefined {
  const match = stdout.match(/window id #\s*(0x[0-9a-fA-F]+)/)
  const id = match?.[1]?.toLowerCase()
  if (id === undefined || id === "0x0") return undefined
  return id
}

export async function queryKWinActiveWindow(run: KWinShellRunner): Promise<KWinActiveWindow | undefined> {
  for (const command of KWIN_ACTIVE_WINDOW_COMMANDS) {
    const result = await run(command).catch(() => undefined)
    if (result === undefined) continue
    const windowId = parseKWinActiveWindow(result.stdout)
    if (windowId !== undefined) return { windowId, command }
    // Empty/parse-failure: try next binary (e.g. qdbus missing -> qdbus6).
    // UnknownMethod output also parses to undefined; keep trying.
  }
  return undefined
}

export async function queryKWinMinimized(
  run: KWinShellRunner,
  windowId: string | undefined,
): Promise<KWinMinimizedState | undefined> {
  if (windowId === undefined) return undefined
  for (const command of kwinWindowInfoCommands(windowId)) {
    const result = await run(command).catch(() => undefined)
    if (result === undefined) continue
    const minimized = parseKWinMinimized(result.stdout)
    if (minimized !== undefined) return { minimized, command }
  }
  return undefined
}

export async function queryX11ActiveWindow(run: KWinShellRunner): Promise<KWinActiveWindow | undefined> {
  const result = await run(X11_ACTIVE_WINDOW_COMMAND).catch(() => undefined)
  if (result === undefined) return undefined
  const windowId = parseX11ActiveWindow(result.stdout)
  if (windowId === undefined) return undefined
  return { windowId, command: X11_ACTIVE_WINDOW_COMMAND }
}

export async function queryX11Minimized(
  run: KWinShellRunner,
  windowId: string | undefined,
): Promise<KWinMinimizedState | undefined> {
  if (windowId === undefined) return undefined
  const command = x11WindowStateCommand(windowId)
  if (command === undefined) return undefined
  const result = await run(command).catch(() => undefined)
  if (result === undefined) return undefined
  const minimized = parseX11Minimized(result.stdout)
  if (minimized === undefined) return undefined
  return { minimized, command }
}

// --- Observation (AT-SPI) helpers ---

export function focusedWindowFromObservation(observation: Observation | undefined): UIElement | undefined {
  const elements = observation?.elements ?? []
  return elements.find((element) => element.role === "window" && (element.states ?? []).includes("focused"))
}

export function activeWindowIdFromObservation(observation: Observation | undefined): string | undefined {
  const focused = focusedWindowFromObservation(observation)
  if (focused?.id !== undefined) return focused.id
  const metadata = observation?.metadata
  if (typeof metadata === "object" && metadata !== null) {
    const record = metadata as Record<string, unknown>
    for (const key of ["activeWindowId", "windowId", "activeWindow"]) {
      const value = record[key]
      if (typeof value === "string" && value.length > 0) return value
    }
  }
  return undefined
}

export function isWindowPresent(observation: Observation | undefined, windowId: string): boolean {
  return (observation?.elements ?? []).some((element) => element.id === windowId)
}

// Pure focus-loss decision. Never returns verified without positive
// evidence that the previously focused window lost focus.
export function verifyFocusLoss(input: {
  readonly beforeFocusedId?: string
  readonly afterFocusedId?: string
  readonly expectedWindowId?: string
  readonly method: string
}): Verification {
  const target = input.expectedWindowId ?? input.beforeFocusedId
  if (target === undefined) {
    return {
      status: "unverified",
      message: "Focus-loss cannot be confirmed: no previously focused window was recorded.",
      method: input.method,
    }
  }
  const after = input.afterFocusedId
  if (after === undefined) {
    // No window reports focused after the action: focus left the window
    // (minimize-to-taskbar / desktop focus). Counts as loss.
    return {
      status: "verified",
      message: `Focus left window ${target}: no window reports focused after the action.`,
      method: input.method,
      evidence: [{ kind: "focus-loss", value: JSON.stringify({ before: target, after: null }) }],
    }
  }
  if (after !== target) {
    return {
      status: "verified",
      message: `Focus moved from ${target} to ${after}.`,
      method: input.method,
      evidence: [{ kind: "focus-loss", value: JSON.stringify({ before: target, after }) }],
    }
  }
  return {
    status: "unverified",
    message: `Window ${target} is still focused; the minimize/focus action did not take effect.`,
    method: input.method,
  }
}

// Pure minimized decision. Verified requires minimized===true (KWin/xprop
// positive) -- focus change alone is handled by verifyFocusLoss.
export function verifyWindowMinimized(input: {
  readonly minimized?: boolean
  readonly beforeActiveWindow?: string
  readonly afterActiveWindow?: string
  readonly beforeFocusedId?: string
  readonly afterFocusedId?: string
  readonly method: string
}): Verification {
  if (input.minimized === true) {
    return {
      status: "verified",
      message: "Window manager reports the window minimized.",
      method: input.method,
      evidence: [
        { kind: "minimized", value: "true" },
        ...(input.beforeActiveWindow === undefined && input.afterActiveWindow === undefined
          ? []
          : [{ kind: "active-window", value: JSON.stringify({ before: input.beforeActiveWindow ?? null, after: input.afterActiveWindow ?? null }) }]),
      ],
    }
  }
  if (input.minimized === false) {
    // Explicitly not minimized: fail closed, even if focus moved (that may
    // be a focus steal, not a minimize).
    return {
      status: "unverified",
      message: "Window manager reports the window is not minimized.",
      method: input.method,
      evidence: [{ kind: "minimized", value: "false" }],
    }
  }
  // minimized unknown: fall back to focus-loss semantics.
  return verifyFocusLoss({
    beforeFocusedId: input.beforeFocusedId ?? input.beforeActiveWindow,
    afterFocusedId: input.afterFocusedId ?? input.afterActiveWindow,
    method: input.method,
  })
}

export interface VerifyWindowStateOptions {
  readonly runShell?: KWinShellRunner
  readonly before?: Observation
  readonly after?: Observation
  readonly reobserve?: () => Promise<Observation | undefined>
  readonly expectedWindowId?: string
  readonly settleMs?: number
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Full verifier with the required fallback chain and 500ms + re-query
// semantics. Returns verified ONLY on positive KWin/AT-SPI evidence.
export async function verifyWindowState(options: VerifyWindowStateOptions): Promise<Verification> {
  const settleMs = options.settleMs ?? KWIN_VERIFY_SETTLE_MS
  if (settleMs > 0) await sleep(settleMs)

  const beforeFocusedId = options.expectedWindowId ?? activeWindowIdFromObservation(options.before)
  let after = options.after
  if (options.reobserve !== undefined) {
    const fresh = await options.reobserve().catch(() => undefined)
    if (fresh !== undefined) after = fresh
  }
  const afterFocusedId = activeWindowIdFromObservation(after)

  // 1. KWin DBus (Wayland primary).
  if (options.runShell !== undefined) {
    const active = await queryKWinActiveWindow(options.runShell).catch(() => undefined)
    if (active !== undefined) {
      const minimized = await queryKWinMinimized(options.runShell, options.expectedWindowId ?? active.windowId).catch(
        () => undefined,
      )
      // minimized==true is decisive. minimized==false is decisive
      // non-minimized. minimized==undefined degrades to KWin focus check.
      if (minimized !== undefined) {
        return verifyWindowMinimized({
          minimized: minimized.minimized,
          beforeActiveWindow: beforeFocusedId,
          afterActiveWindow: active.windowId,
          beforeFocusedId,
          afterFocusedId: afterFocusedId ?? active.windowId,
          method: "kwin-dbus",
        })
      }
      // KWin answered activeWindow but has no minimized field for this
      // Plasma version: use KWin active-window change as focus evidence.
      const focus = verifyFocusLoss({
        beforeFocusedId,
        afterFocusedId: afterFocusedId ?? active.windowId,
        expectedWindowId: options.expectedWindowId,
        method: "kwin-dbus",
      })
      if (focus.status === "verified") return focus
      // KWin says the same window is still active: fail closed now, but
      // still allow AT-SPI below to confirm a minimize that KWin missed?
      // No -- KWin is authoritative when it answers. Return its verdict,
      // annotated with the attempted minimized query.
      if (beforeFocusedId !== undefined) return focus
    }

    // 1b. X11 fallback (xprop). Only reachable when KWin DBus gave nothing
    // (e.g. Plasma 5 where activeWindow is UnknownMethod).
    const x11active = await queryX11ActiveWindow(options.runShell).catch(() => undefined)
    if (x11active !== undefined) {
      const x11min = await queryX11Minimized(options.runShell, options.expectedWindowId ?? x11active.windowId).catch(
        () => undefined,
      )
      if (x11min !== undefined) {
        return verifyWindowMinimized({
          minimized: x11min.minimized,
          beforeActiveWindow: beforeFocusedId,
          afterActiveWindow: x11active.windowId,
          beforeFocusedId,
          afterFocusedId: afterFocusedId ?? x11active.windowId,
          method: "x11-net-wm-state",
        })
      }
      const focus = verifyFocusLoss({
        beforeFocusedId,
        afterFocusedId: afterFocusedId ?? x11active.windowId,
        expectedWindowId: options.expectedWindowId,
        method: "x11-net-active-window",
      })
      if (focus.status === "verified" || beforeFocusedId !== undefined) return focus
    }
  }

  // 2. AT-SPI / accessibility focus check (computer_observe).
  if (beforeFocusedId !== undefined || afterFocusedId !== undefined) {
    const focus = verifyFocusLoss({
      beforeFocusedId,
      afterFocusedId,
      expectedWindowId: options.expectedWindowId,
      method: "atspi-focus",
    })
    // AT-SPI is decisive in both directions when a before id exists:
    // verified on loss, unverified (fail closed) when still focused.
    if (beforeFocusedId !== undefined) return focus
    if (focus.status === "verified") return focus
  }

  // 3. Observation fallback: no positive evidence -> unverified.
  // Deliberately NOT verifyOutcome-style hasChanges: any unrelated delta
  // (pointer move, clock tick) must not verify a window action.
  return {
    status: "unverified",
    message:
      "No window-manager confirmation: KWin DBus gave no answer and the focused window is unchanged or unknown. Re-observe before retrying; on Wayland ensure qdbus/qdbus6 can reach org.kde.KWin.",
    method: "observation",
  }
}

// Closed-window check: verified only when the expected window id is absent
// from the fresh observation.
export function verifyWindowClosed(input: {
  readonly expectedWindowId?: string
  readonly after?: Observation
  readonly method?: string
}): Verification {
  const method = input.method ?? "observation"
  if (input.expectedWindowId === undefined) {
    return { status: "unverified", message: "Close cannot be confirmed: no window id was recorded before the action.", method }
  }
  if (input.after === undefined) {
    return { status: "unverified", message: `Close of ${input.expectedWindowId} cannot be confirmed: no fresh observation.`, method }
  }
  if (!isWindowPresent(input.after, input.expectedWindowId)) {
    return {
      status: "verified",
      message: `Window ${input.expectedWindowId} is no longer present.`,
      method,
      evidence: [{ kind: "window-closed", value: input.expectedWindowId }],
    }
  }
  return { status: "unverified", message: `Window ${input.expectedWindowId} is still present.`, method }
}
