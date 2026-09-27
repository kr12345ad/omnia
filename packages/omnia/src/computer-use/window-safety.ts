import type {
  ComputerUseAction,
  ComputerUsePlatform,
  ImageReference,
  SemanticElement,
} from "./types"

// P0 fix for UI-TARS grounding failure on tiny title-bar buttons.
// Context: Minimize (1834,45) vs Close (1843,45) are 9px apart on 1920x1080.
// UI-TARS jitter (±10px) makes full-screen vision clicks on window controls
// unsafe. Decision P0:
//   - ban full-screen title-bar clicks (keyboard/semantic-first),
//   - 25px Close guard (15px is unsafe given jitter),
//   - window-management intents default to keyboard/semantic
//     (Win+Down, Alt+Space+N, KWin DBus) instead of vision click.

export const TITLE_BAR_BAN_Y_PX = 120
export const TITLE_BAR_BAN_X_PX = 1520
export const CLOSE_GUARD_DISTANCE_PX = 25

// Reference Close-X for 1920x1080. Scaled proportionally for other sizes
// (see scaleKnownCloseToImage). Kept as a constant so the guard has a
// static fallback when no semantic Close element is available.
export const KNOWN_CLOSE_POINT_1080P = { x: 1843, y: 45 } as const
export const REFERENCE_SCREEN = { width: 1920, height: 1080 } as const

export interface SafetyPoint {
  readonly x: number
  readonly y: number
}

const WINDOW_MANAGEMENT_PATTERN = /minimi[sz]e|unminimi[sz]e|\bfocus\b|show\s*desktop|restore\s*(window|down)|window\s*menu/i
const MINIMIZE_PATTERN = /minimi[sz]e/i
const FOCUS_PATTERN = /\bfocus\b|activate\s+window|bring\s+.*front|switch\s+to/i
const TITLE_BAR_TARGET_PATTERN =
  /minimi[sz]e|maximi[sz]e|restore\s*(window|down)?|close(\s*(button|x|window))?|title[-\s]?bar|window\s*control|caption\s*button|window\s*button|top[-\s]?right.*(button|corner|control)|["']?x["']?\s*button/i
const CLOSE_ELEMENT_PATTERN = /^\s*close(\s*(button|x|window))?\s*$/i

export function isCropPath(image: ImageReference | undefined): boolean {
  return image?.region !== undefined
}

export function effectiveAllowTitleBarClicks(options: {
  readonly preferences?: { readonly allowTitleBarClicks?: boolean }
  readonly settings?: { readonly allowTitleBarClicks?: boolean }
}): boolean {
  return options.preferences?.allowTitleBarClicks ?? options.settings?.allowTitleBarClicks ?? false
}

export function isWindowManagementIntent(targetDescription?: string, taskContext?: string): boolean {
  const haystack = `${targetDescription ?? ""}\n${taskContext ?? ""}`
  if (haystack.trim().length === 0) return false
  return WINDOW_MANAGEMENT_PATTERN.test(haystack)
}

export function isMinimizeIntent(targetDescription?: string, taskContext?: string): boolean {
  const haystack = `${targetDescription ?? ""}\n${taskContext ?? ""}`
  return MINIMIZE_PATTERN.test(haystack)
}

export function isFocusIntent(targetDescription?: string, taskContext?: string): boolean {
  const haystack = `${targetDescription ?? ""}\n${taskContext ?? ""}`
  return FOCUS_PATTERN.test(haystack)
}

export function isTitleBarTarget(targetDescription?: string, taskContext?: string): boolean {
  const haystack = `${targetDescription ?? ""}\n${taskContext ?? ""}`
  if (haystack.trim().length === 0) return false
  return TITLE_BAR_TARGET_PATTERN.test(haystack)
}

// Title-bar region: top strip, right side where window controls live.
// Thresholds scale with screenshot size so the ban works beyond 1080p:
//   xThreshold = width - 400 (1520 at 1920w), yThreshold = min(120, 12% of height).
// This covers the generic window-control cluster, not just the single
// 1843,45 Close point.
export function titleBarThresholds(image: ImageReference | undefined): { xThreshold: number; yThreshold: number; width: number; height: number } {
  const width = image?.width ?? REFERENCE_SCREEN.width
  const height = image?.height ?? REFERENCE_SCREEN.height
  const xThreshold = image?.width === undefined ? TITLE_BAR_BAN_X_PX : Math.max(0, width - 400)
  const yThreshold = Math.min(TITLE_BAR_BAN_Y_PX, Math.round(height * 0.12))
  return { xThreshold, yThreshold, width, height }
}

export function isTitleBarPoint(point: SafetyPoint, image?: ImageReference): boolean {
  const { xThreshold, yThreshold } = titleBarThresholds(image)
  return point.y < yThreshold && point.x > xThreshold
}

export function scaleKnownCloseToImage(image: ImageReference | undefined): SafetyPoint {
  const width = image?.width ?? REFERENCE_SCREEN.width
  const height = image?.height ?? REFERENCE_SCREEN.height
  return {
    x: Math.round((KNOWN_CLOSE_POINT_1080P.x / REFERENCE_SCREEN.width) * width),
    y: Math.round((KNOWN_CLOSE_POINT_1080P.y / REFERENCE_SCREEN.height) * height),
  }
}

// Dynamic Close points from semantic context (authoritative when present)
// plus the scaled static fallback. Semantic Close buttons are matched by
// exact-ish name/text ("Close", "Close window") with role button-ish, or any
// element whose center already falls in the title-bar region and mentions close.
export function findKnownClosePoints(
  elements: readonly SemanticElement[] | undefined,
  image: ImageReference | undefined,
): SafetyPoint[] {
  const points: SafetyPoint[] = [scaleKnownCloseToImage(image)]
  if (elements === undefined) return points
  for (const element of elements) {
    if (element.bounds === undefined) continue
    const name = `${element.name ?? ""} ${element.text ?? ""}`.trim()
    if (name.length === 0) continue
    const isCloseName = CLOSE_ELEMENT_PATTERN.test(name) || /close/i.test(name)
    if (!isCloseName) continue
    const center = {
      x: Math.round(element.bounds.x + element.bounds.width / 2),
      y: Math.round(element.bounds.y + element.bounds.height / 2),
    }
    // Avoid duplicates of the static point (within 2px).
    if (points.every((p) => distance(p, center) > 2)) points.push(center)
  }
  return points
}

export function distance(a: SafetyPoint, b: SafetyPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

export function closestCloseDistance(point: SafetyPoint, closePoints: readonly SafetyPoint[]): { distance: number; close: SafetyPoint | undefined } {
  let best: SafetyPoint | undefined
  let bestDist = Number.POSITIVE_INFINITY
  for (const close of closePoints) {
    const d = distance(point, close)
    if (d < bestDist) {
      bestDist = d
      best = close
    }
  }
  return { distance: bestDist, close: best }
}

export interface GuardResult {
  readonly safe: boolean
  readonly reason?: string
}

// 25px guard: reject any Minimize point within 25px of a known Close-X.
// 15px is unsafe because UI-TARS jitter is ±10px, leaving only ~5px margin.
export function checkCloseGuard(point: SafetyPoint, closePoints: readonly SafetyPoint[]): GuardResult {
  const { distance: d, close } = closestCloseDistance(point, closePoints)
  if (d < CLOSE_GUARD_DISTANCE_PX && close !== undefined) {
    return {
      safe: false,
      reason:
        `Grounded point (${point.x}, ${point.y}) is ${d.toFixed(1)}px from Close-X ` +
        `(${close.x}, ${close.y}), inside the ${CLOSE_GUARD_DISTANCE_PX}px guard ` +
        `(15px is unsafe with ±10px vision jitter). Refine with a cropped screenshot ` +
        `around the Minimize button or use keyboard/semantic minimize (Super+Down, Alt+Space+N) instead of a full-screen click.`,
    }
  }
  return { safe: true }
}

export interface TitleBarBanResult {
  readonly banned: boolean
  readonly reason?: string
}

// Ban: reject full-screen grounding targeting the title-bar region unless
// via the crop path (image.region present) or an explicit opt-in flag.
// Call with the grounded point when available (post-grounding check), or
// with only descriptions to deflect before grounding.
export function checkTitleBarBan(options: {
  readonly point?: SafetyPoint
  readonly targetDescription?: string
  readonly taskContext?: string
  readonly image?: ImageReference
  readonly allowTitleBarClicks?: boolean
}): TitleBarBanResult {
  if (options.allowTitleBarClicks === true) return { banned: false }
  if (isCropPath(options.image)) return { banned: false }
  const { xThreshold, yThreshold } = titleBarThresholds(options.image)
  if (options.point !== undefined && isTitleBarPoint(options.point, options.image)) {
    return {
      banned: true,
      reason:
        `Point (${options.point.x}, ${options.point.y}) falls in the title-bar window-control region ` +
        `(x>${xThreshold}, y<${yThreshold}). Full-screen title-bar clicks are banned: Minimize (1834,45) vs Close (1843,45) are 9px apart, ` +
        `inside UI-TARS jitter. Use a cropped screenshot around the target, enable allowTitleBarClicks explicitly, ` +
        `or use keyboard/semantic window management (Super+Down, Alt+Space+N, KWin DBus) instead.`,
    }
  }
  if (options.point === undefined && isTitleBarTarget(options.targetDescription, options.taskContext)) {
    return {
      banned: true,
      reason:
        `Target "${options.targetDescription ?? options.taskContext ?? ""}" resolves to a title-bar window control. ` +
        `Full-screen vision grounding for title-bar buttons is banned (9px Minimize/Close separation vs ±10px jitter). ` +
        `Use keyboard/semantic window management (Super+Down, Alt+Space+N, KWin DBus) or retry with a cropped screenshot around the button.`,
    }
  }
  return { banned: false }
}

// Fallback: window-management intents default to keyboard/semantic instead
// of a vision click. Minimize -> Super+Down (Cmd+M on macOS). Focus is
// primarily semantic (focus element); the keyboard Alt+Tab step is a generic
// fallback when no semantic window matches. Alt+Space+N and KWin DBus
// (`qdbus org.kde.kwin /KWin ...`) are documented alternatives for the agent
// layer; this single-key action keeps the computer-use action atomic.
export function windowManagementFallback(options: {
  readonly targetDescription?: string
  readonly taskContext?: string
  readonly platform?: ComputerUsePlatform
}): ComputerUseAction {
  const platform = options.platform ?? "linux"
  if (isMinimizeIntent(options.targetDescription, options.taskContext)) {
    if (platform === "macos") return { type: "key", key: "Cmd+m" }
    return { type: "key", key: "Super+Down" }
  }
  // Focus / activate fallback. Semantic focus-by-element is preferred by the
  // caller; this keyboard step is only the generic fallback.
  return { type: "key", key: "Alt+Tab" }
}

export function windowManagementFallbackReason(options: {
  readonly targetDescription?: string
  readonly taskContext?: string
  readonly platform?: ComputerUsePlatform
}): string {
  const action = windowManagementFallback(options)
  const isMin = isMinimizeIntent(options.targetDescription, options.taskContext)
  if (isMin) {
    return (
      `Window-management intent "${options.targetDescription ?? options.taskContext ?? "minimize"}" defaults to keyboard/semantic ` +
      `instead of a full-screen vision click (title-bar ban; 9px Minimize/Close separation). ` +
      `Keyboard fallback: ${action.key} (alternatives: Alt+Space then N for the window menu, KWin DBus minimize via qdbus org.kde.kwin).`
    )
  }
  return (
    `Window-management intent "${options.targetDescription ?? options.taskContext ?? "focus"}" defaults to semantic/keyboard ` +
    `instead of a full-screen vision click. Semantic focus-by-element preferred; keyboard fallback: ${action.key}.`
  )
}
