import { CLOSE_GUARD_DISTANCE_PX, KNOWN_CLOSE_POINT_1080P } from "../window-safety"
import type { HarnessReport, TrialResult } from "./types"

// Locked trial tolerances from FOCUS_ROLLOUT.strategist.md Phase 3: a click
// within +/-25px of screen center on a target whose own center sits more than
// 150px away is the blind bounds-center click this program exists to catch.
export const CENTER_CLICK_TOLERANCE_PX = 25
export const OFF_CENTER_DISTANCE_PX = 150

export interface PixelPoint {
  readonly x: number
  readonly y: number
}

export interface PixelBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

function normalizeTitle(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ")
}

function pointDistance(a: PixelPoint, b: PixelPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

export function boundsCenter(bounds: PixelBounds): PixelPoint {
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
}

function containsPoint(bounds: PixelBounds, point: PixelPoint): boolean {
  return (
    point.x >= bounds.x &&
    point.x <= bounds.x + bounds.width &&
    point.y >= bounds.y &&
    point.y <= bounds.y + bounds.height
  )
}

// Case-insensitive substring match on titles, preserving pipes and dashes
// ("Kitty — OC | Quick hello" contains "OC | Quick hello"). Empty expectations
// never match, so a trial cannot pass against an unnamed target.
export function containsTitle(observed: string, expected: string): boolean {
  const active = normalizeTitle(observed)
  const wanted = normalizeTitle(expected)
  if (active.length === 0 || wanted.length === 0) return false
  return active.includes(wanted)
}

// Contract rule 1: the pass requires a post-action observation. A missing
// observation is a FAIL ("no post-observation"), never a silent pass.
export function assertActiveWindowMatches(observed: string | undefined, expectedTitle: string): TrialResult {
  const name = "active window contains target title"
  if (observed === undefined) {
    return {
      name,
      outcome: "fail",
      detail: "no post-observation: the active window was never observed after the action",
      evidence: { expectedTitle },
    }
  }
  if (containsTitle(observed, expectedTitle)) {
    return {
      name,
      outcome: "pass",
      detail: `active window "${observed}" contains "${expectedTitle}"`,
      evidence: { observed, expectedTitle },
    }
  }
  return {
    name,
    outcome: "fail",
    detail: `active window "${observed}" does not contain "${expectedTitle}"`,
    evidence: { observed, expectedTitle },
  }
}

// The blind center-click guard. Fails only when BOTH hold: the named target's
// center is more than offCenterPx from screen center, and the clicked point
// landed within tolerancePx of screen center. A click that lands on the target,
// or a target that genuinely sits on screen center, passes. A missing click
// (for example a focus_window action that never clicked) passes.
export function assertNotCenterClick(
  clicked: PixelPoint | undefined,
  targetBounds: PixelBounds,
  screenCenter: PixelPoint,
  tolerancePx = CENTER_CLICK_TOLERANCE_PX,
  offCenterPx = OFF_CENTER_DISTANCE_PX,
): TrialResult {
  const name = "no blind screen-center click on off-center target"
  if (clicked === undefined) {
    return { name, outcome: "pass", detail: "no click was recorded", evidence: { screenCenter } }
  }
  const targetCenter = { x: targetBounds.x + targetBounds.width / 2, y: targetBounds.y + targetBounds.height / 2 }
  const targetOffset = pointDistance(screenCenter, targetCenter)
  const clickOffset = pointDistance(clicked, screenCenter)
  const evidence = { clicked, targetCenter, screenCenter, targetOffset, clickOffset, tolerancePx, offCenterPx }
  if (targetOffset <= offCenterPx) {
    return {
      name,
      outcome: "pass",
      detail: `target center is ${targetOffset}px from screen center (<= ${offCenterPx}px), so a center click is not a wrong-target click`,
      evidence,
    }
  }
  if (clickOffset > tolerancePx) {
    return {
      name,
      outcome: "pass",
      detail: `click (${clicked.x},${clicked.y}) is ${clickOffset}px from screen center (> ${tolerancePx}px tolerance)`,
      evidence,
    }
  }
  return {
    name,
    outcome: "fail",
    detail:
      `click (${clicked.x},${clicked.y}) landed on screen center (${screenCenter.x},${screenCenter.y}) while the target center is ${targetOffset}px away (> ${offCenterPx}px): blind bounds-center click`,
    evidence,
  }
}

// A click that misses the named control's own bounds is a wrong-target click
// even when it never touches screen centre, which is how the Close button gets
// hit while Minimize was asked for.
export function assertClickHitsControl(
  clicked: PixelPoint | undefined,
  controlBounds: PixelBounds,
  controlName: string,
): TrialResult {
  const name = "click lands on the named control"
  if (clicked === undefined) {
    return {
      name,
      outcome: "pass",
      detail: `no click was recorded for "${controlName}"`,
      evidence: { controlName, clicked: null, controlBounds },
    }
  }
  const evidence = { controlName, clicked, controlBounds }
  if (containsPoint(controlBounds, clicked)) {
    return {
      name,
      outcome: "pass",
      detail: `click (${clicked.x},${clicked.y}) is inside the "${controlName}" bounds (${controlBounds.x},${controlBounds.y},${controlBounds.width}x${controlBounds.height})`,
      evidence,
    }
  }
  return {
    name,
    outcome: "fail",
    detail: `click (${clicked.x},${clicked.y}) is outside the "${controlName}" bounds (${controlBounds.x},${controlBounds.y},${controlBounds.width}x${controlBounds.height}): wrong-target click`,
    evidence,
  }
}

// P0 Close/Minimize: Minimize and Close sit 9px apart on some 1920x1080 KDE
// themes, so a click aimed at any other control must stay clear of the
// documented close point by at least the production Close guard.
export function assertOutsideCloseGuard(
  clicked: PixelPoint | undefined,
  closePoint: PixelPoint = KNOWN_CLOSE_POINT_1080P,
  guardPx = CLOSE_GUARD_DISTANCE_PX,
): TrialResult {
  const name = "click stays clear of the Close button"
  if (clicked === undefined) {
    return { name, outcome: "pass", detail: "no click was recorded", evidence: { clicked: null, closePoint, guardPx } }
  }
  const distance = pointDistance(clicked, closePoint)
  const evidence = { clicked, closePoint, distance, guardPx }
  if (distance >= guardPx) {
    return {
      name,
      outcome: "pass",
      detail: `click (${clicked.x},${clicked.y}) is ${distance}px from the close point (${closePoint.x},${closePoint.y}), clear of the ${guardPx}px guard`,
      evidence,
    }
  }
  return {
    name,
    outcome: "fail",
    detail: `click (${clicked.x},${clicked.y}) is ${distance}px from the close point (${closePoint.x},${closePoint.y}), inside the ${guardPx}px Close guard`,
    evidence,
  }
}

// Contract rule 1 on the verification flag: a "verified" claim is honest only
// when an observation containing the expected title backs it. "not_verified" is
// always honest, even with nothing observed.
export function assertVerifiedHonest(
  status: "verified" | "not_verified",
  expected: string,
  observed: string | undefined,
): TrialResult {
  const name = "verification claim matches the observation"
  if (status === "not_verified") {
    return {
      name,
      outcome: "pass",
      detail: `reported not_verified for "${expected}"`,
      evidence: { status, expected, observed: observed ?? null },
    }
  }
  if (observed !== undefined && containsTitle(observed, expected)) {
    return {
      name,
      outcome: "pass",
      detail: `verified claim is backed by observed "${observed}"`,
      evidence: { status, expected, observed },
    }
  }
  return {
    name,
    outcome: "fail",
    detail: `claimed verified without an observation containing "${expected}"`,
    evidence: { status, expected, observed: observed ?? null },
  }
}

// Contract rule 1 applied to element state: a "verified" claim needs an
// observed change. An action the post-observation shows nothing for is the
// false-Verified bug, so it may only ever be reported as "not_verified".
export function assertVerifiedOnlyOnChange(
  status: "verified" | "not_verified",
  changed: boolean,
): TrialResult {
  const name = "verification requires an observed change"
  if (status === "not_verified") {
    return { name, outcome: "pass", detail: "reported not_verified", evidence: { status, changed } }
  }
  if (changed) {
    return {
      name,
      outcome: "pass",
      detail: "verified claim is backed by an observed change",
      evidence: { status, changed },
    }
  }
  return {
    name,
    outcome: "fail",
    detail: "claimed verified although the post-observation shows no change",
    evidence: { status, changed },
  }
}

// Contract rule 4: a ref is generation-scoped, so acting on one from an older
// observation must be refused. The refusal has to say so — a silent no-op
// leaves the caller unable to tell a refusal from a lost action.
export function assertStaleRefRefused(input: {
  readonly ok: boolean
  readonly reason: string | undefined
}): TrialResult {
  const name = "stale ref is refused"
  const evidence = { ok: input.ok, reason: input.reason ?? null }
  if (input.ok) {
    return {
      name,
      outcome: "fail",
      detail: `the tool acted on a ref from an older observation${input.reason === undefined ? "" : `: ${input.reason}`}`,
      evidence,
    }
  }
  if (input.reason === undefined || input.reason.trim().length === 0) {
    return {
      name,
      outcome: "fail",
      detail: "the tool reported no refusal, so a stale ref was neither acted on nor refused with a reason",
      evidence,
    }
  }
  return { name, outcome: "pass", detail: `refused: ${input.reason}`, evidence }
}

// A refusal is only complete when nothing was delivered: a stale ref that still
// produced a pointer event somewhere is the silent rebind rule 4 bans. The
// click must land inside the bounds the current observation gives the original
// ref, or the target was never the element the caller named.
export function assertStaleRefNeverClicks(
  clicked: PixelPoint | undefined,
  currentBounds: PixelBounds | undefined,
  ref: string,
): TrialResult {
  const name = "a stale ref never clicks another element"
  if (clicked === undefined) {
    return { name, outcome: "pass", detail: "no click was recorded", evidence: { ref, clicked: null } }
  }
  if (currentBounds === undefined) {
    return {
      name,
      outcome: "fail",
      detail: `click (${clicked.x},${clicked.y}) was delivered for ${ref}, which has no bounds in the current observation, so the click cannot be shown to be the original element`,
      evidence: { ref, clicked, currentBounds: null },
    }
  }
  const evidence = { ref, clicked, currentBounds }
  if (containsPoint(currentBounds, clicked)) {
    return {
      name,
      outcome: "pass",
      detail: `click (${clicked.x},${clicked.y}) is inside the current bounds of ${ref}`,
      evidence,
    }
  }
  return {
    name,
    outcome: "fail",
    detail: `click (${clicked.x},${clicked.y}) is outside the current bounds of ${ref}: the stale ref was rebound to a different element`,
    evidence,
  }
}

// Skipped trials never ran, so they cannot lower the pass rate. A harness that
// skipped everything reports 0 instead of dividing by zero.
export function summarize(results: readonly TrialResult[]): HarnessReport {
  const passed = results.filter((result) => result.outcome === "pass").length
  const failed = results.filter((result) => result.outcome === "fail").length
  const errors = results.filter((result) => result.outcome === "error").length
  const executed = passed + failed + errors
  return {
    trials: results,
    passed,
    failed,
    errors,
    passRate: executed === 0 ? 0 : passed / executed,
  }
}
