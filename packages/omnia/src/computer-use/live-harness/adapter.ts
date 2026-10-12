// The desktop surface every trial drives.
//
// A trial never reaches a display itself: it asks `act` for one thing and
// reads the desktop back through `observe`, so every verdict is computed from
// a post-action observation rather than from what the action claimed. The
// stubs in the tests and the real adapters in run.ts implement the same two
// functions, which is what keeps the runnable gate and the unit tests honest
// about each other.
import { MATCH_THRESHOLD, scoreMatch } from "../match-score"
import { containsTitle, type PixelPoint } from "./assertions"
import type { TrialResult } from "./types"

export interface HarnessRequest {
  readonly kind: "focus" | "click" | "set-value"
  // The named target: a window title for focus, a control name otherwise.
  readonly name: string
  readonly ref?: string
  readonly observationId?: string
  readonly generation?: number
  readonly value?: string
}

// What the action actually did, as the tool observed it. `clicked` is only set
// when the pointer really moved, so a background/semantic delivery is
// distinguishable from a pointer click that could have missed.
export interface HarnessResponse {
  readonly ok: boolean
  readonly clicked?: PixelPoint
  readonly claimed?: "verified" | "not_verified"
  readonly refused?: string
  readonly detail?: string
}

export interface HarnessElement {
  readonly ref: string
  readonly name?: string
  readonly role?: string
  readonly text?: string
  readonly value?: string
  readonly bounds?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  readonly states?: readonly string[]
}

export interface HarnessObservation {
  readonly observationId?: string
  readonly generation?: number
  readonly activeWindowTitle?: string
  readonly screen?: { readonly width: number; readonly height: number }
  readonly elements?: readonly HarnessElement[]
}

export interface HarnessObserveRequest {
  // Force a fresh observation instead of a cached snapshot, so a ref captured
  // earlier can be aged past the current generation.
  readonly fresh?: boolean
}

export type HarnessAct = (
  request: HarnessRequest,
) => Promise<HarnessResponse | undefined> | HarnessResponse | undefined

export type HarnessObserve = (
  request?: HarnessObserveRequest,
) => Promise<HarnessObservation | undefined> | HarnessObservation | undefined

export interface HarnessAdapters {
  readonly act: HarnessAct
  readonly observe: HarnessObserve
}

// The screen centre of the desktop that was actually measured, so the
// centre-click guard is judged against the real screen instead of an assumed
// 1920x1080 one.
export function observedScreenCenter(observation: HarnessObservation | undefined): PixelPoint | undefined {
  const screen = observation?.screen
  if (screen === undefined || screen.width <= 0 || screen.height <= 0) return undefined
  return { x: screen.width / 2, y: screen.height / 2 }
}

// Windows resolve by title fragment, the way the production focus path
// resolves a named window.
export function findWindow(elements: readonly HarnessElement[] | undefined, title: string): HarnessElement | undefined {
  return (elements ?? []).find(
    (element) => element.role === "window" && element.name !== undefined && containsTitle(element.name, title),
  )
}

// Controls resolve through the one shared matcher, so a trial can never pass
// on an over-match the router would have rejected.
export function resolveElement(
  elements: readonly HarnessElement[] | undefined,
  name: string,
): HarnessElement | undefined {
  return (elements ?? [])
    .map((element) => ({ element, score: scoreMatch(name, element) }))
    .filter((entry) => entry.score >= MATCH_THRESHOLD)
    .sort((left, right) => right.score - left.score)[0]?.element
}

// Trial results are produced by the assertion helpers, which each carry their
// own evidence; the trial adds what only it knows (the request, the
// observation ids) without dropping what the assert already measured.
export function withEvidence(result: TrialResult, evidence: Record<string, unknown>): TrialResult {
  return { ...result, evidence: { ...(result.evidence ?? {}), ...evidence } }
}
