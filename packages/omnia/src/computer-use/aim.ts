// Aim-point selection for computer-use clicks.
//
// Contract (docs/computer-use-reliability.md, rule 2): never click the center of
// a bounding box by default. Every strategy here resolves the point from element
// metadata; `bounds-center` exists only for element kinds with no better hint
// and must be recorded as a guess by the caller.

export type AimStrategy = "control-center" | "focus-point" | "role-inset" | "provider-hint" | "bounds-center"

export interface AimBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface AimElement {
  readonly bounds: AimBounds
  readonly role?: string
  readonly focusPoint?: { readonly x: number; readonly y: number } | null
  readonly aimHint?: { readonly x: number; readonly y: number } | null
}

export interface Aim {
  readonly x: number
  readonly y: number
  readonly strategy: AimStrategy
}

// 12% of the thickness/size: enough to leave the rounded, provider-drawn edge of
// a title-bar button or scrollbar bar without crossing into a neighbour.
export const AIM_INSET_RATIO = 0.12

// Linux/Windows keep window controls top-right: Close sits at the group's right
// edge, Minimize at the group's left edge, Maximize/Restore next to Close. The
// inset keeps a click off the shared group edge, where a 9px Minimize/Close
// separation makes centre-of-bounds clicks land on the wrong button.
const TITLE_BAR_EDGE: Readonly<Record<string, "left" | "right">> = {
  close: "right",
  closebutton: "right",
  minimize: "left",
  minimizebutton: "left",
  maximize: "right",
  maximizebutton: "right",
  restore: "right",
  restorebutton: "right",
}

const SCROLLBAR_ROLES: ReadonlySet<string> = new Set(["scrollbar", "scrollbarbutton", "scrollbargrip"])

// Small toggle-style controls: the actionable region is the control itself, so
// the role decides the point and the centre of the bounds is already exact.
const TOGGLE_ROLES: ReadonlySet<string> = new Set([
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "checkbox",
  "checkbutton",
  "radio",
  "radiobutton",
  "switch",
  "togglebutton",
])

const CONTROL_ROLES: ReadonlySet<string> = new Set([
  "button",
  "link",
  "textfield",
  "searchbox",
  "tab",
  "treeitem",
  "slider",
  "spinbutton",
  "combobox",
  "listbox",
  "listitem",
  "option",
  "gridcell",
  "cell",
  "menubutton",
  "splitbutton",
])

const ROLE_ALIASES: Readonly<Record<string, string>> = {
  pushbutton: "button",
  axbutton: "button",
  textbox: "textfield",
  entry: "textfield",
  search: "searchbox",
  searchfield: "searchbox",
  radiobutton: "radio",
  toggle: "switch",
  check: "checkbox",
  checkbutton: "checkbox",
}

function normalizeRole(role: string): string {
  const compact = role.toLowerCase().replace(/[^a-z0-9]/g, "")
  return ROLE_ALIASES[compact] ?? compact
}

function center(bounds: AimBounds): { x: number; y: number } {
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
}

// A scrollbar element is the bar itself; inset from the bar's outer edge along
// its thickness so the point stays on the bar and never on the track padding
// beside it, while the scroll direction stays neutral to avoid a jump-scroll.
function scrollbarPoint(bounds: AimBounds): { x: number; y: number } {
  const vertical = bounds.height > bounds.width
  const inset = Math.max(1, Math.round((vertical ? bounds.width : bounds.height) * AIM_INSET_RATIO))
  const middle = center(bounds)
  if (vertical) return { x: bounds.x + bounds.width - inset, y: middle.y }
  return { x: middle.x, y: bounds.y + bounds.height - inset }
}

// Role-specific points. Returns undefined when the role says nothing about
// where the actionable region is, which is what makes the caller fall through
// to control-center or the bounds-center guess.
function rolePoint(role: string, bounds: AimBounds): { x: number; y: number } | undefined {
  const edge = TITLE_BAR_EDGE[role]
  if (edge !== undefined) {
    const inset = Math.max(1, Math.round(bounds.width * AIM_INSET_RATIO))
    return {
      x: edge === "right" ? bounds.x + bounds.width - inset : bounds.x + inset,
      y: center(bounds).y,
    }
  }
  if (SCROLLBAR_ROLES.has(role)) return scrollbarPoint(bounds)
  if (TOGGLE_ROLES.has(role)) return center(bounds)
  return undefined
}

// Round to integers, then clamp so the reported point is never outside the
// element's own bounds.
function toAim(point: { x: number; y: number }, bounds: AimBounds, strategy: AimStrategy): Aim {
  return {
    x: Math.min(Math.max(Math.round(point.x), bounds.x), bounds.x + bounds.width),
    y: Math.min(Math.max(Math.round(point.y), bounds.y), bounds.y + bounds.height),
    strategy,
  }
}

export function computeAim(element: AimElement): Aim {
  const bounds = element.bounds
  const hint = element.aimHint ?? undefined
  if (hint !== undefined) return toAim(hint, bounds, "provider-hint")
  const focus = element.focusPoint ?? undefined
  if (focus !== undefined) return toAim(focus, bounds, "focus-point")
  const role = element.role === undefined ? undefined : normalizeRole(element.role)
  if (role !== undefined) {
    const inset = rolePoint(role, bounds)
    if (inset !== undefined) return toAim(inset, bounds, "role-inset")
    if (CONTROL_ROLES.has(role)) return toAim(center(bounds), bounds, "control-center")
  }
  // No hint, no focus point, and a role that does not describe an actionable
  // region: the centre of the bounds is a guess and is labelled as one.
  return toAim(center(bounds), bounds, "bounds-center")
}

export function isCenterGuess(aim: { readonly strategy: AimStrategy }): boolean {
  return aim.strategy === "bounds-center"
}
