import { computeAim, isCenterGuess, type Aim, type AimStrategy } from "./aim"
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

// A titled-window click is nameable: the target either resolves to a window
// control or names a window title. Only those clicks are held to the aim rules,
// because a wrong click there destroys or lowers the target window instead of
// missing a button inside it.
function isTitledWindowClick(targetDescription?: string, taskContext?: string): boolean {
  return (
    isTitleBarTarget(targetDescription, taskContext) ||
    extractWindowTitleFragment(targetDescription, taskContext) !== undefined
  )
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

// A centre-of-bounds aim carries no evidence about where the control actually
// is, so the safety layer reports it instead of letting the click pass quietly.
// Returns undefined for every strategy that resolves an actionable point.
export function describeAimRisk(aim: Aim): string | undefined {
  if (!isCenterGuess(aim)) return undefined
  return (
    `Aim (${aim.x}, ${aim.y}) resolved with strategy "bounds-center": the element exposes no focus point, ` +
    `no provider aim hint, and a role that does not identify an actionable region, so the click target is ` +
    `only a guess inside the bounding box. Resolve a ref, supply a focus point or aim hint, or ground with a ` +
    `screenshot cropped around the control before clicking.`
  )
}

// Window-control cluster guard. A control this close to the title-bar corner is
// one jitter step (±10px) from the button next door, because Minimize and Close
// sit 9px apart there.
export const TITLE_BAR_CORNER_GUARD_PX = 24

// Roles that mean "this element is one of the window controls". The vocabulary
// matches the TITLE_BAR_EDGE table in ./aim, because that table is also what
// resolves the safe role-inset aim for each of them.
const TITLE_BAR_BUTTON_ROLES: ReadonlySet<string> = new Set([
  "close",
  "closebutton",
  "minimize",
  "minimizebutton",
  "maximize",
  "maximizebutton",
  "restore",
  "restorebutton",
])
// Accessible names for the same cluster. The name has to name the button and
// nothing else, so a content button ("Close sidebar") never counts.
const TITLE_BAR_BUTTON_NAME = /^\s*(close|minimi[sz]e|maximi[sz]e|restore)\s*((button|control|window|icon)\b|[x\u00d7])?\s*$/i

const AIM_STRATEGIES: readonly AimStrategy[] = ["control-center", "focus-point", "role-inset", "provider-hint", "bounds-center"]

export interface ClickRiskBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface ClickRiskInput {
  readonly aim: { readonly x: number; readonly y: number; readonly strategy: string }
  readonly elementRole?: string
  readonly elementName?: string
  readonly bounds: ClickRiskBounds
  readonly windowTitle?: string
}

export interface ClickRiskResult {
  readonly risk: "low" | "medium" | "high"
  readonly reason: string
}

// A strategy outside the aim vocabulary resolved the point from nothing the
// safety layer can inspect, so it is not evidence about where the control is.
export function isKnownAimStrategy(value: string): value is AimStrategy {
  return (AIM_STRATEGIES as readonly string[]).includes(value)
}

function usableBounds(bounds: ClickRiskBounds): boolean {
  return (
    Number.isFinite(bounds.x) &&
    Number.isFinite(bounds.y) &&
    Number.isFinite(bounds.width) &&
    Number.isFinite(bounds.height) &&
    bounds.width > 0 &&
    bounds.height > 0
  )
}

// Why the element cannot be identified at all, or undefined when it can.
function unresolvableElement(bounds: ClickRiskBounds, role: string | undefined, name: string | undefined): string | undefined {
  if (!usableBounds(bounds)) return `bounds ${bounds.x},${bounds.y} ${bounds.width}x${bounds.height} are not a usable rectangle`
  if ((role ?? "").trim().length === 0 && (name ?? "").trim().length === 0) return "the element exposes no role and no name"
  return undefined
}

function isTitleBarButton(role: string | undefined, name: string | undefined): boolean {
  if (TITLE_BAR_BUTTON_ROLES.has((role ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, ""))) return true
  return TITLE_BAR_BUTTON_NAME.test((name ?? "").trim())
}

// Gap from the element's bounds to the window-control corner region. The
// window's own geometry is not part of the risk input, so the region comes
// from the reference screen the ban thresholds are calibrated to (1920x1080):
// an element already inside that region has a gap of zero.
function titleBarCornerGap(bounds: ClickRiskBounds): number {
  const { xThreshold, yThreshold, width } = titleBarThresholds(undefined, "linux")
  const dx = Math.max(xThreshold - (bounds.x + bounds.width), bounds.x - width, 0)
  const dy = Math.max(bounds.y - yThreshold, -(bounds.y + bounds.height), 0)
  return Math.hypot(dx, dy)
}

// How risky one click is, before any region policy applies. The aim strategy
// is the evidence: a metadata-resolved strategy (control-center, focus-point,
// role-inset, provider-hint) names a point the element itself vouches for,
// while bounds-center is a guess and only survives away from the window
// controls. `medium` means the click may proceed but has to be recorded.
export function evaluateClickRisk(params: ClickRiskInput): ClickRiskResult {
  const strategy = params.aim.strategy
  const centerGuess = strategy === "bounds-center"
  // A centre guess on a control of a titled window is the recorded P0 failure:
  // the window names itself, its control cluster lives in the title strip, and
  // Close/Minimize are 9px apart there.
  if (centerGuess && (params.windowTitle ?? "").trim().length > 0) {
    return { risk: "high", reason: "center-guess on a titled control; Close/Minimize sit 9px apart" }
  }
  // Window controls are only separable by the role inset; every other strategy
  // aims into a cluster whose buttons are one jitter step apart.
  if (isTitleBarButton(params.elementRole, params.elementName) && strategy !== "role-inset") {
    const safe = computeAim({ bounds: params.bounds, role: params.elementRole })
    const label = params.elementRole ?? params.elementName ?? "window control"
    return {
      risk: "high",
      reason:
        `aim strategy "${strategy}" on the ${label} button is not the role inset ` +
        `(aim ${safe.x},${safe.y} instead); Close/Minimize sit 9px apart inside ±10px vision jitter`,
    }
  }
  // A centre guess this close to the window-control corner has nothing to
  // separate it from the button next door.
  if (centerGuess && titleBarCornerGap(params.bounds) <= TITLE_BAR_CORNER_GUARD_PX) {
    return {
      risk: "high",
      reason:
        `center-guess at (${params.aim.x},${params.aim.y}) lands within ${TITLE_BAR_CORNER_GUARD_PX}px of the window's top-right ` +
        `title-bar corner; Close/Minimize sit 9px apart inside ±10px vision jitter`,
    }
  }
  // Nothing identifies the element or the strategy, so nothing vouches for the
  // aim: the click may proceed, but it is recorded as uncertain.
  if (!isKnownAimStrategy(strategy)) {
    return {
      risk: "medium",
      reason: `aim strategy "${strategy}" is outside the aim vocabulary, so the click target cannot be confirmed`,
    }
  }
  const unresolvable = unresolvableElement(params.bounds, params.elementRole, params.elementName)
  if (unresolvable !== undefined) {
    return {
      risk: "medium",
      reason: `unresolvable element: ${unresolvable}, so the click target cannot be confirmed`,
    }
  }
  return {
    risk: "low",
    reason: `aim (${params.aim.x},${params.aim.y}) resolved from element metadata with strategy "${strategy}"`,
  }
}

export interface TitleBarBanResult {
  readonly banned: boolean
  readonly reason?: string
  // A `medium` click risk is allowed but recorded here, so nothing that grounds
  // without evidence about the target passes quietly.
  readonly warnings?: readonly string[]
}

// A `medium` click risk is allowed but recorded, so the caller surface shows
// the uncertainty instead of the click passing quietly.
function allowedWithWarnings(warnings: readonly string[]): TitleBarBanResult {
  return warnings.length === 0 ? { banned: false } : { banned: false, warnings }
}

// The click-risk half of the verdict, or undefined when the call carries no
// element to judge (aim and element bounds are both required).
function clickRiskFor(options: {
  readonly aim?: Aim
  readonly elementRole?: string
  readonly elementName?: string
  readonly bounds?: ClickRiskBounds
  readonly windowTitle?: string
}): ClickRiskResult | undefined {
  if (options.aim === undefined || options.bounds === undefined) return undefined
  return evaluateClickRisk({
    aim: options.aim,
    ...(options.elementRole === undefined ? {} : { elementRole: options.elementRole }),
    ...(options.elementName === undefined ? {} : { elementName: options.elementName }),
    bounds: options.bounds,
    ...(options.windowTitle === undefined ? {} : { windowTitle: options.windowTitle }),
  })
}

// Ban: reject full-screen grounding targeting the title-bar region unless
// via the trusted crop path (image.serverCrop or an explicit `crop` flag from
// the provider's own crop result) or an explicit opt-in flag. Call with the
// grounded point when available (post-grounding check), or with only
// descriptions to deflect before grounding. The region side comes from the
// controlled computer's platform (macOS top-left, Linux/Windows top-right).
// Pass the resolved element (`aim` plus its role/name/bounds and the window
// title) to run the click-risk gate: a `high` risk is a refusal no opt-in or
// trusted crop can admit, and a `medium` risk comes back in `warnings`.
export function checkTitleBarBan(options: {
  readonly point?: SafetyPoint
  readonly targetDescription?: string
  readonly taskContext?: string
  readonly image?: ImageReference
  readonly allowTitleBarClicks?: boolean
  readonly crop?: boolean
  readonly platform?: ComputerUsePlatform
  readonly aim?: Aim
  readonly elementRole?: string
  readonly elementName?: string
  readonly bounds?: ClickRiskBounds
  readonly windowTitle?: string
}): TitleBarBanResult {
  // Element-level risk first: it is the most specific statement about the
  // click, and a high risk is refused with its own reason.
  const warnings: string[] = []
  const risk = clickRiskFor(options)
  if (risk?.risk === "high") return { banned: true, reason: risk.reason }
  if (risk?.risk === "medium") warnings.push(risk.reason)
  // A centre guess has no evidence of hitting any named control, so no opt-in
  // or trusted-crop path may silently admit it.
  const aimRisk = options.aim === undefined ? undefined : describeAimRisk(options.aim)
  if (aimRisk !== undefined && isTitledWindowClick(options.targetDescription, options.taskContext)) {
    return {
      banned: true,
      reason:
        `${aimRisk} The target names a titled window or a window control, and Minimize (1834,45) vs Close ` +
        `(1843,45) are 9px apart, so a bounds-centre guess on that cluster hits the wrong control.`,
    }
  }
  if (options.allowTitleBarClicks === true) return allowedWithWarnings(warnings)
  if (options.crop === true || isCropPath(options.image)) return allowedWithWarnings(warnings)
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
  return allowedWithWarnings(warnings)
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
