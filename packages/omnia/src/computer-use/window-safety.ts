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
export const TITLE_BAR_CROP_WIDTH = 400
export const TITLE_BAR_CROP_HEIGHT = 120

// Reference Close-X for 1920x1080. Scaled proportionally for other sizes
// (see scaleKnownCloseToImage). Kept as a constant so the guard has a
// static fallback when no semantic Close element is available.
export const KNOWN_CLOSE_POINT_1080P = { x: 1843, y: 45 } as const
export const REFERENCE_SCREEN = { width: 1920, height: 1080 } as const

export interface SafetyPoint {
  readonly x: number
  readonly y: number
}

const WINDOW_MANAGEMENT_PATTERN =
  /minimi[sz]e|unminimi[sz]e|\bfocus\b|show\s*desktop|restore\s+(?:the\s+)?(?:window|down)|unmaximi[sz]e|window\s*menu/i
// "unminimize"/"unmaximize" must not trigger the minimize fallback.
const MINIMIZE_PATTERN = /(?<!un)minimi[sz]e/i
const RESTORE_PATTERN = /unminimi[sz]e|unmaximi[sz]e|de-?maximi[sz]e|restore\s+(?:the\s+)?(?:window|down)/i
const SHOW_DESKTOP_PATTERN = /show\s*desktop/i
const WINDOW_MENU_PATTERN = /window\s*menu/i
const FOCUS_PATTERN = /\bfocus\b|activate\s+window|bring\s+.*front|switch\s+to/i
// Titled window-focus routing: verb-led predicate with negative guard so
// "click link in Kitty" stays on the click path. Requires a focus verb +
// a window noun + an extractable title fragment (quoted-first, pipe-aware).
const WINDOW_FOCUS_VERB = /\b(focus|activate|bring[\s\S]*?front|raise|switch\s+to|select\s+(?:the\s+)?(?:window|terminal))\b/i
const WINDOW_FOCUS_NOUN = /\b(window|terminal|kitty|app|dialog|application)\b/i
const WINDOW_FOCUS_INNER_GUARD =
  /(click|type|press|scroll|drag|hover|select\s+text|right-?\s*click)[\s\S]*(link|button|tab|field|textbox|text\s*field|icon|menu|item|inside|within|in\s+the)\b/i
const WINDOW_TITLE_STOPWORDS = new Set([
  "window",
  "terminal",
  "kitty",
  "app",
  "dialog",
  "application",
  "focus",
  "click",
  "the",
  "a",
  "an",
  "to",
  "in",
  "on",
])
// "close" only counts as a title-bar target in a window-control context:
// "close the dialog/sidebar/file" is a content action, not Close-X.
const TITLE_BAR_TARGET_PATTERN =
  /minimi[sz]e|maximi[sz]e|restore\s+(?:window|down)|close\s+(?:button|window|icon|control)|(?:window|title[-\s]?bar|caption)\s*close\b|title[-\s]?bar|window\s*control|caption\s*button|window\s*button|top[-\s]?right.*(?:button|corner|control)|["']?[x\u00d7]["']?\s*button/i
const CLOSE_ELEMENT_PATTERN = /^\s*close(\s*(button|x|window))?\s*$/i

export function isCropPath(image: ImageReference | undefined): boolean {
  // Only the trusted server-side crop path sets serverCrop; a caller-supplied
  // screenshot.region must not disable the title-bar ban.
  return image?.serverCrop === true
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
  if (!WINDOW_MANAGEMENT_PATTERN.test(haystack)) return false
  // A bare "focus" can name a field inside a window ("focus the email
  // field"); only treat it as window management when a window noun is present.
  if (/\bfocus\b/i.test(haystack) && !WINDOW_FOCUS_NOUN.test(haystack)) return false
  return true
}

export function isMinimizeIntent(targetDescription?: string, taskContext?: string): boolean {
  const haystack = `${targetDescription ?? ""}\n${taskContext ?? ""}`
  return MINIMIZE_PATTERN.test(haystack)
}

export function isRestoreIntent(targetDescription?: string, taskContext?: string): boolean {
  const haystack = `${targetDescription ?? ""}\n${taskContext ?? ""}`
  return RESTORE_PATTERN.test(haystack)
}

export function isFocusIntent(targetDescription?: string, taskContext?: string): boolean {
  const haystack = `${targetDescription ?? ""}\n${taskContext ?? ""}`
  return FOCUS_PATTERN.test(haystack)
}

// Quoted-first title extractor, pipe-preserving and case-preserving.
//  1. "OC | Quick hello" (double/single/curly quotes) verbatim.
//  2. titled|named|called <title> up to " / ", newline, or end (strips trailing
//     window/terminal nouns and trailing periods).
// Returns undefined when no titled fragment is present.
export function extractWindowTitleFragment(targetDescription?: string, taskContext?: string): string | undefined {
  const sources = [targetDescription ?? "", taskContext ?? ""]
  for (const src of sources) {
    if (src.length === 0) continue
    // Paired quotes only: opening straight/curly double quotes close with the
    // matching double quote, and single quotes pair with single quotes.
    const quoted = src.match(/["\u201c]([^"\u201c\u201d]{2,120})["\u201d]|'([^']{2,120})'/)
    const captured = quoted?.[1] ?? quoted?.[2]
    if (captured !== undefined) {
      const value = captured.trim().replace(/\s+/g, " ")
      if (value.length >= 2) return value
    }
  }
  for (const src of sources) {
    if (src.length === 0) continue
    const titled = src.match(/(?:titled|named|called|title[d]?)\s*[:\u2014\-\u2013]?\s*([^\n]+)/i)
    if (titled?.[1] !== undefined) {
      let value = titled[1].trim()
      // Only a spaced slash separates a title from trailing context; a slash
      // inside a filename-like title ("a/b") must not truncate it.
      const slash = value.search(/\s\/\s/)
      if (slash >= 0) value = value.slice(0, slash).trim()
      value = value.replace(/\s+(window|terminal|app|dialog)$/i, "").trim()
      value = value.replace(/[.\s]+$/, "").trim()
      // Drop captures that are just verbs/nouns with no real title.
      if (value.length >= 2 && /[A-Za-z0-9|]{2,}/.test(value)) return value
    }
  }
  return undefined
}

function tokenizeWindowTitle(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9|]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !WINDOW_TITLE_STOPWORDS.has(token))
}

// Verb-led focus predicate: focus verb + window noun + extractable title,
// with a negative guard so in-window clicks ("click link in Kitty") never
// route to focus_window. Bare "click ..." never routes.
export function isWindowFocusIntent(targetDescription?: string, taskContext?: string): boolean {
  const haystack = `${targetDescription ?? ""}\n${taskContext ?? ""}`
  if (haystack.trim().length === 0) return false
  if (/^click\s/i.test((targetDescription ?? "").trim())) return false
  if (WINDOW_FOCUS_INNER_GUARD.test(haystack)) return false
  if (!WINDOW_FOCUS_VERB.test(haystack)) return false
  if (!WINDOW_FOCUS_NOUN.test(haystack)) return false
  if (extractWindowTitleFragment(targetDescription, taskContext) === undefined) return false
  return true
}

// Resolve an extracted fragment against live window titles. Prefers exact
// (case-insensitive), then substring, then token overlap (>=2 tokens + >=1
// distinctive len>=4). Returns undefined on ties so the caller falls back
// to vision instead of focusing the wrong window.
export function resolveWindowTitleFragment(fragment: string, candidates: readonly string[]): string | undefined {
  const frag = fragment.trim()
  if (frag.length === 0 || candidates.length === 0) return undefined
  const fragLow = frag.toLowerCase()
  const exact = candidates.find((candidate) => candidate.toLowerCase() === fragLow)
  if (exact !== undefined) return exact
  // Substring matches can tie too: never focus the arbitrarily-first window
  // when several titles contain the fragment.
  const substrings = candidates.filter((candidate) => {
    const low = candidate.toLowerCase()
    return low.includes(fragLow) || fragLow.includes(low)
  })
  if (substrings.length === 1) return substrings[0]
  if (substrings.length > 1) return undefined
  const fragTokens = tokenizeWindowTitle(fragLow)
  if (fragTokens.length < 2) return undefined
  let best: string | undefined
  let bestScore = 0
  let tied = false
  for (const candidate of candidates) {
    const candTokens = tokenizeWindowTitle(candidate.toLowerCase())
    const overlap = fragTokens.filter((token) => candTokens.includes(token))
    const distinctive = overlap.filter((token) => token.length >= 4)
    if (overlap.length >= 2 && distinctive.length >= 1) {
      if (overlap.length > bestScore) {
        bestScore = overlap.length
        best = candidate
        tied = false
      } else if (overlap.length === bestScore && bestScore > 0) {
        tied = true
      }
    }
  }
  if (tied) return undefined
  return best
}

export function isTitleBarTarget(targetDescription?: string, taskContext?: string): boolean {
  const haystack = `${targetDescription ?? ""}\n${taskContext ?? ""}`
  if (haystack.trim().length === 0) return false
  return TITLE_BAR_TARGET_PATTERN.test(haystack)
}

// Title-bar region: top strip where window controls live. Linux/Windows keep
// controls top-right; macOS keeps them top-left, so the x side flips with the
// controlled computer's platform. Thresholds scale with screenshot size so the
// ban works beyond 1080p:
//   xThreshold = width - 400 (1520 at 1920w) for linux/windows,
//   xThreshold = 400 for macos (left side),
//   yThreshold = 120 * (height / 1080), clamped (120 at 1080p, 240 at 4K).
// This covers the generic window-control cluster, not just the single
// 1843,45 Close point.
export function titleBarThresholds(
  image: ImageReference | undefined,
  platform: ComputerUsePlatform = "linux",
): { xThreshold: number; yThreshold: number; width: number; height: number } {
  const width = image?.width ?? REFERENCE_SCREEN.width
  const height = image?.height ?? REFERENCE_SCREEN.height
  const xThreshold =
    platform === "macos" ? 400 : image?.width === undefined ? TITLE_BAR_BAN_X_PX : Math.max(0, width - 400)
  const scaled = Math.round(TITLE_BAR_BAN_Y_PX * (height / REFERENCE_SCREEN.height))
  const yThreshold = Math.max(48, Math.min(480, scaled))
  return { xThreshold, yThreshold, width, height }
}

export function isTitleBarPoint(
  point: SafetyPoint,
  image?: ImageReference,
  platform: ComputerUsePlatform = "linux",
): boolean {
  const { xThreshold, yThreshold } = titleBarThresholds(image, platform)
  if (platform === "macos") return point.y < yThreshold && point.x < xThreshold
  return point.y < yThreshold && point.x > xThreshold
}

// Platform geometry: window controls live top-right on Linux/Windows but
// top-left on macOS, so the static Close fallback must not be mirrored.
export function scaleKnownCloseToImage(
  image: ImageReference | undefined,
  platform: ComputerUsePlatform = "linux",
): SafetyPoint {
  const width = image?.width ?? REFERENCE_SCREEN.width
  const height = image?.height ?? REFERENCE_SCREEN.height
  if (platform === "macos") {
    return {
      x: Math.round((20 / REFERENCE_SCREEN.width) * width),
      y: Math.round((20 / REFERENCE_SCREEN.height) * height),
    }
  }
  return {
    x: Math.round((KNOWN_CLOSE_POINT_1080P.x / REFERENCE_SCREEN.width) * width),
    y: Math.round((KNOWN_CLOSE_POINT_1080P.y / REFERENCE_SCREEN.height) * height),
  }
}

// High-resolution crop strip for tiny window controls. Linux/Windows crop the
// top-right 400x120 at full resolution; macOS crops the top-left instead.
// Screenshot space only: the caller maps model coords back via region offset.
export function titleBarCropRegion(
  image: ImageReference,
  platform: ComputerUsePlatform = "linux",
): { x: number; y: number; width: number; height: number } {
  const width = Math.min(TITLE_BAR_CROP_WIDTH, image.width)
  const height = Math.min(TITLE_BAR_CROP_HEIGHT, image.height)
  if (platform === "macos") return { x: 0, y: 0, width, height }
  return { x: Math.max(0, image.width - width), y: 0, width, height }
}

// Dynamic Close points from semantic context plus the scaled static fallback.
// Exact-ish names ("Close", "Close window", "Close button", "Close X") always
// count; a name that merely contains "close" only counts when its center is in
// the title-bar region ("Close sidebar" must not be treated as Close-X). The
// static fallback is skipped for crops because it is calibrated to full-screen
// proportions.
export function findKnownClosePoints(
  elements: readonly SemanticElement[] | undefined,
  image: ImageReference | undefined,
  platform: ComputerUsePlatform = "linux",
): SafetyPoint[] {
  const points: SafetyPoint[] = image?.region === undefined ? [scaleKnownCloseToImage(image, platform)] : []
  if (elements === undefined) return points
  for (const element of elements) {
    if (element.bounds === undefined) continue
    const name = `${element.name ?? ""} ${element.text ?? ""}`.trim()
    if (name.length === 0) continue
    const center = {
      x: Math.round(element.bounds.x + element.bounds.width / 2),
      y: Math.round(element.bounds.y + element.bounds.height / 2),
    }
    const isCloseName = CLOSE_ELEMENT_PATTERN.test(name) || (/close/i.test(name) && isTitleBarPoint(center, image, platform))
    if (!isCloseName) continue
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
// via the trusted crop path (image.serverCrop or an explicit `crop` flag from
// the provider's own crop result) or an explicit opt-in flag. Call with the
// grounded point when available (post-grounding check), or with only
// descriptions to deflect before grounding. The region side comes from the
// controlled computer's platform (macOS top-left, Linux/Windows top-right).
export function checkTitleBarBan(options: {
  readonly point?: SafetyPoint
  readonly targetDescription?: string
  readonly taskContext?: string
  readonly image?: ImageReference
  readonly allowTitleBarClicks?: boolean
  readonly crop?: boolean
  readonly platform?: ComputerUsePlatform
}): TitleBarBanResult {
  if (options.allowTitleBarClicks === true) return { banned: false }
  if (options.crop === true || isCropPath(options.image)) return { banned: false }
  const platform = options.platform ?? "linux"
  const { xThreshold, yThreshold } = titleBarThresholds(options.image, platform)
  if (options.point !== undefined && isTitleBarPoint(options.point, options.image, platform)) {
    const side = platform === "macos" ? `x<${xThreshold}` : `x>${xThreshold}`
    return {
      banned: true,
      reason:
        `Point (${options.point.x}, ${options.point.y}) falls in the title-bar window-control region ` +
        `(${side}, y<${yThreshold}). Full-screen title-bar clicks are banned: Minimize (1834,45) vs Close (1843,45) are 9px apart, ` +
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
// of a vision click. Minimize -> Super+Down (Cmd+M on macOS). Restore clicks
// must not fall back to Minimize: unminimize/restore use the platform restore
// shortcut where one exists and an explicit unsupported action otherwise.
export function windowManagementFallback(options: {
  readonly targetDescription?: string
  readonly taskContext?: string
  readonly platform?: ComputerUsePlatform
}): ComputerUseAction {
  const platform = options.platform ?? "linux"
  const haystack = `${options.targetDescription ?? ""}\n${options.taskContext ?? ""}`
  if (isMinimizeIntent(options.targetDescription, options.taskContext)) {
    if (platform === "macos") return { type: "key", key: "Cmd+m" }
    return { type: "key", key: "Super+Down" }
  }
  if (isRestoreIntent(options.targetDescription, options.taskContext)) {
    if (platform === "macos") {
      return {
        type: "unsupported",
        text: "Unminimizing or restoring a window has no reliable keyboard shortcut on macOS; use the Dock or the window menu.",
      }
    }
    if (platform === "windows") return { type: "key", key: "Win+Up" }
    return { type: "key", key: "Super+Up" }
  }
  if (SHOW_DESKTOP_PATTERN.test(haystack)) {
    if (platform === "macos") return { type: "key", key: "F11" }
    if (platform === "windows") return { type: "key", key: "Win+d" }
    return { type: "key", key: "Super+d" }
  }
  if (WINDOW_MENU_PATTERN.test(haystack)) {
    return {
      type: "unsupported",
      text: "The window menu needs a two-step Alt+Space shortcut and has no atomic keyboard fallback.",
    }
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
  if (action.type === "unsupported") {
    return (
      `Window-management intent "${options.targetDescription ?? options.taskContext ?? "window"}" has no safe keyboard fallback. ` +
      `${action.text ?? ""} Full-screen title-bar clicks remain banned.`
    )
  }
  if (isMinimizeIntent(options.targetDescription, options.taskContext)) {
    return (
      `Window-management intent "${options.targetDescription ?? options.taskContext ?? "minimize"}" defaults to keyboard/semantic ` +
      `instead of a full-screen vision click (title-bar ban; 9px Minimize/Close separation). ` +
      `Keyboard fallback: ${action.key} (alternatives: Alt+Space then N for the window menu, KWin DBus minimize via qdbus org.kde.kwin).`
    )
  }
  if (isRestoreIntent(options.targetDescription, options.taskContext)) {
    return (
      `Window-management intent "${options.targetDescription ?? options.taskContext ?? "restore"}" defaults to the platform restore ` +
      `shortcut instead of a full-screen vision click. Keyboard fallback: ${action.key}.`
    )
  }
  return (
    `Window-management intent "${options.targetDescription ?? options.taskContext ?? "focus"}" defaults to semantic/keyboard ` +
    `instead of a full-screen vision click. Semantic focus-by-element preferred; keyboard fallback: ${action.key}.`
  )
}
