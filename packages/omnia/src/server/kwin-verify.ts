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
  // The key must be exactly minimized/minimize; an anchored boundary keeps
  // unrelated keys such as "minimizable: true" from parsing as minimized.
  const match = text.match(/\bminimiz(?:ed|e)\b\s*[:=]\s*(true|false|1|0|yes|no)/i)
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

const isWindowIdentifier = (value: string): boolean =>
  /^(0x[0-9a-f]+|\d+)$/i.test(value) || /^[a-z][a-z0-9+.-]*:[^\s]+$/.test(value)

export function activeWindowIdFromObservation(observation: Observation | undefined): string | undefined {
  const focused = focusedWindowFromObservation(observation)
  if (focused?.id !== undefined) return focused.id
  const metadata = observation?.metadata
  if (typeof metadata === "object" && metadata !== null) {
    const record = metadata as Record<string, unknown>
    for (const key of ["activeWindowId", "windowId", "activeWindow"]) {
      const value = record[key]
      // Reject free text: some drivers put the active window title in
      // "activeWindow", which must never be compared as a window id.
      if (typeof value === "string" && value.length > 0 && isWindowIdentifier(value)) return value
    }
  }
  return undefined
}

export function isKWinWindowId(value: string | undefined): boolean {
  return value !== undefined && /^(0x[0-9a-f]+|\d+)$/i.test(value.trim())
}

// Explicit X11/KWin ids carried in observation metadata, used when the
// target is an AT-SPI element id that KWin/xprop cannot query directly.
export function kwinWindowIdFromObservation(observation: Observation | undefined, targetElementId?: string): string | undefined {
  const metadata = observation?.metadata as Record<string, unknown> | undefined
  // Optional chaining throughout: driver observations arrive as untrusted
  // JSON, so metadata can be null even though the protocol types it as an
  // object, and indexing it directly would throw inside verification.
  const direct = ["windowId", "activeWindowId", "x11WindowId"].flatMap((key) => {
    const value = metadata?.[key]
    return typeof value === "string" && isKWinWindowId(value) ? [value.trim()] : []
  })
  if (direct[0] !== undefined) return direct[0]
  const elements = observation?.elements ?? []
  const interesting = elements.filter(
    (element) =>
      element.role === "window" &&
      (element.id === targetElementId || (element.states ?? []).includes("focused")),
  )
  for (const element of interesting) {
    const elementMetadata = element.metadata as Record<string, unknown> | undefined
    for (const key of ["x11WindowId", "windowId", "windowHandle"]) {
      const value = elementMetadata?.[key]
      if (typeof value === "string" && isKWinWindowId(value)) return value.trim()
    }
  }
  return undefined
}

export function isWindowPresent(observation: Observation | undefined, windowId: string): boolean {
  return (observation?.elements ?? []).some((element) => element.id === windowId)
}

// Element-scoped X11/KWin id. Observation-level hints such as
// metadata.windowId/activeWindowId describe whichever window is active, so
// using them to identify a *target* would make the target look focused when
// it is not. Only the named element's own metadata is consulted.
export function windowElementIdFromObservation(observation: Observation | undefined, elementId: string | undefined): string | undefined {
  if (observation === undefined || elementId === undefined) return undefined
  const element = (observation.elements ?? []).find((candidate) => candidate.id === elementId)
  const metadata = element?.metadata
  for (const key of ["x11WindowId", "windowId", "windowHandle"]) {
    const value = metadata?.[key]
    if (typeof value === "string" && isKWinWindowId(value)) return value.trim()
  }
  return undefined
}

function sameWindowManagerId(left: string | undefined, right: string | undefined): boolean {
  if (left === undefined || right === undefined) return false
  const a = left.trim().toLowerCase()
  const b = right.trim().toLowerCase()
  if (a === b) return true
  const aValue = Number.parseInt(a, a.startsWith("0x") ? 16 : 10)
  const bValue = Number.parseInt(b, b.startsWith("0x") ? 16 : 10)
  return Number.isFinite(aValue) && aValue === bValue
}

// Presence check that also accepts explicit X11/KWin ids carried in element
// metadata, so an AT-SPI element id and a WM window id can both resolve.
export function windowPresentInObservation(observation: Observation | undefined, windowId: string | undefined): boolean | undefined {
  if (observation === undefined || windowId === undefined) return undefined
  return (observation.elements ?? []).some((element) => {
    if (element.id === windowId) return true
    const metadata = element.metadata as Record<string, unknown> | undefined
    return metadata?.x11WindowId === windowId || metadata?.windowId === windowId || metadata?.windowHandle === windowId
  })
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
// positive) -- focus change alone is handled by verifyFocusLoss. Restore and
// maximize expect the opposite direction, so a minimized=true observation
// must never verify them.
export function verifyWindowMinimized(input: {
  readonly minimized?: boolean
  readonly expectMinimized?: boolean
  readonly expectedWindowPresent?: boolean
  readonly beforeActiveWindow?: string
  readonly afterActiveWindow?: string
  readonly beforeFocusedId?: string
  readonly afterFocusedId?: string
  readonly method: string
}): Verification {
  const expect = input.expectMinimized ?? true
  if (input.minimized === true) {
    if (!expect) {
      return {
        status: "unverified",
        message: "Window manager reports the window minimized, opposite of the requested state.",
        method: input.method,
        evidence: [{ kind: "minimized", value: "true" }],
      }
    }
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
    if (!expect && input.expectedWindowPresent === true) {
      return {
        status: "verified",
        message: "Window manager reports the window is not minimized and it is still present.",
        method: input.method,
        evidence: [{ kind: "minimized", value: "false" }],
      }
    }
    // Explicitly not minimized when minimized was expected (or vice versa):
    // fail closed, even if focus moved (that may be a focus steal).
    return {
      status: "unverified",
      message: expect
        ? "Window manager reports the window is not minimized."
        : "Window manager reports the window is not minimized; presence could not be confirmed.",
      method: input.method,
      evidence: [{ kind: "minimized", value: "false" }],
    }
  }
  // minimized unknown: fall back to focus-loss semantics for minimize; other
  // directions have no positive evidence and stay unverified.
  if (!expect) {
    return {
      status: "unverified",
      message: "Window manager did not report the window state; cannot confirm restore or maximize.",
      method: input.method,
    }
  }
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
  // Direction of the requested transition. Minimize expects minimized=true;
  // restore/maximize expect minimized=false.
  readonly expectMinimized?: boolean
  // Focus actions get positive focus-gain verification instead of the
  // focus-loss semantics used by minimize.
  readonly expectFocused?: boolean
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Window-manager state decision shared by the KWin and X11 branches. The
// minimized field is only comparable when queried for a real WM window id;
// AT-SPI-only ids fall back to observation-based focus evidence.
function decideWithWindowManager(input: {
  readonly minimized?: boolean
  readonly activeWindowId: string
  readonly beforeFocusedId?: string
  readonly afterFocusedId?: string
  readonly wmTargetId?: string
  readonly expectMinimized?: boolean
  readonly present?: boolean
  readonly method: string
}): Verification {
  if (input.minimized !== undefined) {
    return verifyWindowMinimized({
      minimized: input.minimized,
      ...(input.expectMinimized === undefined ? {} : { expectMinimized: input.expectMinimized }),
      ...(input.present === undefined ? {} : { expectedWindowPresent: input.present }),
      beforeActiveWindow: input.wmTargetId ?? input.beforeFocusedId,
      afterActiveWindow: input.activeWindowId,
      beforeFocusedId: input.beforeFocusedId,
      afterFocusedId: input.afterFocusedId ?? input.activeWindowId,
      method: input.method,
    })
  }
  if (input.expectMinimized === false) {
    return {
      status: "unverified",
      message: "The window manager did not report the minimized state; cannot confirm restore or maximize.",
      method: input.method,
    }
  }
  const comparable = input.wmTargetId ?? (isKWinWindowId(input.beforeFocusedId) ? input.beforeFocusedId?.trim() : undefined)
  if (comparable === undefined) {
    return {
      status: "unverified",
      message: `The target window id is not a window-manager id; cannot compare it with ${input.method}.`,
      method: input.method,
    }
  }
  return verifyFocusLoss({
    beforeFocusedId: comparable,
    afterFocusedId: input.activeWindowId,
    expectedWindowId: comparable,
    method: input.method,
  })
}

// Full verifier with the required fallback chain and 500ms + re-query
// semantics. Returns verified ONLY on positive KWin/AT-SPI evidence.
export async function verifyWindowState(options: VerifyWindowStateOptions): Promise<Verification> {
  const settleMs = options.settleMs ?? KWIN_VERIFY_SETTLE_MS
  if (settleMs > 0) await sleep(settleMs)

  const expected = options.expectedWindowId
  const beforeFocusedId = expected ?? activeWindowIdFromObservation(options.before)
  let after = options.after
  if (options.reobserve !== undefined) {
    const fresh = await options.reobserve().catch(() => undefined)
    if (fresh !== undefined) after = fresh
  }
  const afterFocusedId = activeWindowIdFromObservation(after)
  if (options.expectFocused === true) {
    const target =
      expected === undefined
        ? undefined
        : (options.before?.elements ?? []).find((element) => element.id === expected) ??
          (after?.elements ?? []).find((element) => element.id === expected)
    const targetTitle = typeof target?.name === "string" && target.name.length > 0 ? target.name : undefined
    if (options.runShell !== undefined) {
      // Positive KWin/X11 check when it can be afforded: a WM-id match
      // verifies. Anything else falls through to the observation check,
      // which never verifies focus loss.
      const kwin = await queryKWinActiveWindow(options.runShell).catch(() => undefined)
      const active = kwin ?? (await queryX11ActiveWindow(options.runShell).catch(() => undefined))
      const targetWmId = isKWinWindowId(expected)
        ? expected?.trim()
        : windowElementIdFromObservation(options.before ?? after, expected)
      if (active !== undefined && sameWindowManagerId(targetWmId, active.windowId)) {
        return {
          status: "verified",
          message: `Window manager reports ${active.windowId} focused.`,
          method: kwin === undefined ? "x11-net-wm-state" : "kwin-dbus",
          evidence: [{ kind: "window-focused", value: JSON.stringify({ expected: targetWmId, active: active.windowId }) }],
        }
      }
    }
    return verifyFocusedWindow({
      ...(expected === undefined ? {} : { expectedWindowId: expected }),
      ...(targetTitle === undefined ? {} : { expectedTitle: targetTitle }),
      ...(after === undefined ? {} : { after }),
      method: "atspi-focus",
    })
  }
  // An AT-SPI element id cannot be queried by KWin/xprop. Use an explicit
  // X11 id from observation metadata when one is available; otherwise query
  // the active window so the state check is at least anchored to a real id.
  const wmTargetId = isKWinWindowId(expected)
    ? expected?.trim()
    : kwinWindowIdFromObservation(options.before ?? options.after, expected)
  const present = expected === undefined ? undefined : windowPresentInObservation(after, expected)

  // 1. KWin DBus (Wayland primary).
  if (options.runShell !== undefined) {
    const active = await queryKWinActiveWindow(options.runShell).catch(() => undefined)
    if (active !== undefined) {
      const minimized = await queryKWinMinimized(options.runShell, wmTargetId ?? active.windowId).catch(
        () => undefined,
      )
      return decideWithWindowManager({
        ...(minimized === undefined ? {} : { minimized: minimized.minimized }),
        activeWindowId: active.windowId,
        ...(beforeFocusedId === undefined ? {} : { beforeFocusedId }),
        ...(afterFocusedId === undefined ? {} : { afterFocusedId }),
        ...(wmTargetId === undefined ? {} : { wmTargetId }),
        ...(options.expectMinimized === undefined ? {} : { expectMinimized: options.expectMinimized }),
        ...(present === undefined ? {} : { present }),
        method: "kwin-dbus",
      })
    }

    // 1b. X11 fallback (xprop). Only reachable when KWin DBus gave nothing
    // (e.g. Plasma 5 where activeWindow is UnknownMethod).
    const x11active = await queryX11ActiveWindow(options.runShell).catch(() => undefined)
    if (x11active !== undefined) {
      const x11min = await queryX11Minimized(options.runShell, wmTargetId ?? x11active.windowId).catch(
        () => undefined,
      )
      return decideWithWindowManager({
        ...(x11min === undefined ? {} : { minimized: x11min.minimized }),
        activeWindowId: x11active.windowId,
        ...(beforeFocusedId === undefined ? {} : { beforeFocusedId }),
        ...(afterFocusedId === undefined ? {} : { afterFocusedId }),
        ...(wmTargetId === undefined ? {} : { wmTargetId }),
        ...(options.expectMinimized === undefined ? {} : { expectMinimized: options.expectMinimized }),
        ...(present === undefined ? {} : { present }),
        method: "x11-net-wm-state",
      })
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
  const metadata = input.after.metadata as Record<string, unknown> | undefined
  if (metadata?.truncated === true || metadata?.complete === false) {
    return {
      status: "unverified",
      message: `Close of ${input.expectedWindowId} cannot be confirmed: the observation was incomplete.`,
      method,
    }
  }
  if (!isWindowPresent(input.after, input.expectedWindowId) && windowPresentInObservation(input.after, input.expectedWindowId) !== true) {
    return {
      status: "verified",
      message: `Window ${input.expectedWindowId} is no longer present.`,
      method,
      evidence: [{ kind: "window-closed", value: input.expectedWindowId }],
    }
  }
  return { status: "unverified", message: `Window ${input.expectedWindowId} is still present.`, method }
}

// --- Focus harness (critic: titled window-focus trials + wrong-target guard) ---
//
// Regression: computer_visual click "focus the Kitty terminal (OC | Quick hello)"
// routed via semantic (40% conf) and clicked screen-center (960,539) twice --
// first falsely Verified, window never focused. No focus claim may verify
// without activeWindow==target, and a center-click on an off-center named
// window must FAIL closed.
//
// Locked tolerances (room decision):
//   center +/-25px, off-center >150px, activeWindow case-insensitive substring.

export const FOCUS_CENTER_TOLERANCE_PX = 25
export const FOCUS_OFF_CENTER_DISTANCE_PX = 150
export const REFERENCE_SCREEN_CENTER = { x: 960, y: 540 } as const

export interface FocusPoint {
  readonly x: number
  readonly y: number
}

export interface FocusBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export function screenCenterFor(width?: number, height?: number): FocusPoint {
  const w = width ?? 1920
  const h = height ?? 1080
  return { x: w / 2, y: h / 2 }
}

export function focusPointDistance(a: FocusPoint, b: FocusPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

export function targetCenterOf(bounds: FocusBounds): FocusPoint {
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
}

// True when a clicked point lands within +/-25px of screen center.
// Covers both (960,540) exact center and the observed (960,539) off-by-one.
export function isScreenCenterClick(
  point: FocusPoint,
  screen?: { readonly width?: number; readonly height?: number },
): boolean {
  const center = screenCenterFor(screen?.width, screen?.height)
  return focusPointDistance(point, center) <= FOCUS_CENTER_TOLERANCE_PX
}

// Wrong-target guard: FAIL when the click is a screen-center click while the
// named target window is off-center (>150px from the clicked point).
// Without target bounds the guard cannot judge and returns false.
export function isWrongTargetCenterClick(input: {
  readonly point: FocusPoint
  readonly targetBounds?: FocusBounds
  readonly screen?: { readonly width?: number; readonly height?: number }
}): boolean {
  if (input.targetBounds === undefined) return false
  if (!isScreenCenterClick(input.point, input.screen)) return false
  const targetCenter = targetCenterOf(input.targetBounds)
  return focusPointDistance(input.point, targetCenter) > FOCUS_OFF_CENTER_DISTANCE_PX
}

function normalizeWindowTitle(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ")
}

// Quoted-first title preserved verbatim (including "|"); matching is a
// case-insensitive substring: the live active window name must contain the
// expected title fragment. Empty expectations never match.
export function matchesWindowTitle(activeName: string | undefined, expectedTitle: string | undefined): boolean {
  if (activeName === undefined || expectedTitle === undefined) return false
  const active = normalizeWindowTitle(activeName)
  const expected = normalizeWindowTitle(expectedTitle)
  if (active.length === 0 || expected.length === 0) return false
  return active.includes(expected)
}

export function focusedWindowName(observation: Observation | undefined): string | undefined {
  const focused = focusedWindowFromObservation(observation)
  if (typeof focused?.name === "string" && focused.name.length > 0) return focused.name
  const metadata = observation?.metadata as Record<string, unknown> | undefined
  const title = metadata?.["windowTitle"]
  return typeof title === "string" && title.length > 0 ? title : undefined
}

// Positive focus-gain check. Verified ONLY when the post-action active window
// title substring-matches the expected title. Click coordinates alone never
// verify a focus claim -- this kills the (960,539) false-Verified class.
export function verifyWindowFocused(input: {
  readonly expectedTitle: string
  readonly afterTitle?: string
  readonly method?: string
}): Verification {
  const method = input.method ?? "atspi-focus"
  if (matchesWindowTitle(input.afterTitle, input.expectedTitle)) {
    return {
      status: "verified",
      message: `Window "${input.expectedTitle}" is focused (active: "${input.afterTitle ?? ""}").`,
      method,
      evidence: [{ kind: "window-focused", value: JSON.stringify({ expected: input.expectedTitle, active: input.afterTitle ?? null }) }],
    }
  }
  if (input.afterTitle === undefined) {
    return {
      status: "unverified",
      message: `Focus of "${input.expectedTitle}" cannot be confirmed: no active window was reported after the action.`,
      method,
    }
  }
  return {
    status: "unverified",
    message: `Window "${input.expectedTitle}" is not focused; active window is "${input.afterTitle}".`,
    method,
    evidence: [{ kind: "window-focused", value: JSON.stringify({ expected: input.expectedTitle, active: input.afterTitle }) }],
  }
}

// Positive focus-gain check for focus/focus_window/activate_app. The
// post-action observation must report the *target* window focused: same
// element id, same X11/KWin id carried by the target's own metadata, or a
// focused title that substring-matches the target's title. Any other active
// window (or none) stays unverified. This is the opposite decision from
// verifyFocusLoss, which treats "still focused" as failure -- correct for
// minimize, inverted for focus.
export function verifyFocusedWindow(input: {
  readonly expectedWindowId?: string
  readonly expectedTitle?: string
  readonly after?: Observation
  readonly method?: string
}): Verification {
  const method = input.method ?? "atspi-focus"
  const focusedId = activeWindowIdFromObservation(input.after)
  const focusedTitle = focusedWindowName(input.after)
  const targetWmId = windowElementIdFromObservation(input.after, input.expectedWindowId)
  const focusedWmId = windowElementIdFromObservation(input.after, focusedId)
  if (
    input.expectedWindowId !== undefined &&
    (focusedId === input.expectedWindowId || (targetWmId !== undefined && targetWmId === focusedWmId))
  ) {
    return {
      status: "verified",
      message: `Window ${input.expectedWindowId} is focused.`,
      method,
      evidence: [
        {
          kind: "window-focused",
          value: JSON.stringify({ expected: input.expectedWindowId, active: focusedId ?? input.expectedWindowId }),
        },
      ],
    }
  }
  if (matchesWindowTitle(focusedTitle, input.expectedTitle)) {
    return {
      status: "verified",
      message: `Window "${input.expectedTitle}" is focused (active: "${focusedTitle ?? ""}").`,
      method,
      evidence: [{ kind: "window-focused", value: JSON.stringify({ expected: input.expectedTitle, active: focusedTitle ?? null }) }],
    }
  }
  const label = input.expectedTitle ?? input.expectedWindowId ?? "the target window"
  const active = focusedTitle ?? focusedId
  return {
    status: "unverified",
    message:
      active === undefined
        ? `Window ${label} is not focused; no active window was reported after the action.`
        : `Window ${label} is not focused; active window is ${JSON.stringify(active)}.`,
    method,
    evidence: [
      {
        kind: "window-focused",
        value: JSON.stringify({ expected: input.expectedWindowId ?? input.expectedTitle ?? null, active: active ?? null }),
      },
    ],
  }
}

// Full focus-trial verdict used by the 20/20 harness: wrong-target guard first
// (center-click on off-center named window = FAIL closed), then positive
// activeWindow==target. Either failure returns unverified with explicit
// evidence so false greens are impossible.
export function verifyFocusTrial(input: {
  readonly expectedTitle: string
  readonly afterTitle?: string
  readonly clickedPoint?: FocusPoint
  readonly targetBounds?: FocusBounds
  readonly screen?: { readonly width?: number; readonly height?: number }
  readonly method?: string
}): Verification {
  const method = input.method ?? "atspi-focus"
  if (input.clickedPoint !== undefined && isWrongTargetCenterClick({ point: input.clickedPoint, targetBounds: input.targetBounds, screen: input.screen })) {
    const center = screenCenterFor(input.screen?.width, input.screen?.height)
    const targetCenter = input.targetBounds === undefined ? undefined : targetCenterOf(input.targetBounds)
    return {
      status: "unverified",
      message:
        `Wrong-target click: point (${input.clickedPoint.x}, ${input.clickedPoint.y}) is within ${FOCUS_CENTER_TOLERANCE_PX}px of screen-center ` +
        `(${center.x}, ${center.y}) while target "${input.expectedTitle}" is off-center ` +
        `${targetCenter === undefined ? "" : `(center ${Math.round(targetCenter.x)}, ${Math.round(targetCenter.y)}, >${FOCUS_OFF_CENTER_DISTANCE_PX}px away)`}. ` +
        `A screen-center click cannot focus a named off-center window; route titled focus intents to focus_window by title.`,
      method,
      evidence: [
        { kind: "wrong-target", value: JSON.stringify({ point: input.clickedPoint, targetCenter, expected: input.expectedTitle, active: input.afterTitle ?? null }) },
      ],
    }
  }
  return verifyWindowFocused({ expectedTitle: input.expectedTitle, afterTitle: input.afterTitle, method })
}
