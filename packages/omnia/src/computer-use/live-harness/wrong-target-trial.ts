import {
  assertClickHitsControl,
  assertNotCenterClick,
  assertOutsideCloseGuard,
  boundsCenter,
  type PixelBounds,
  type PixelPoint,
} from "./assertions"
import { findWindow, observedScreenCenter, resolveElement, type HarnessAct, type HarnessObserve, withEvidence } from "./adapter"
import { desktopSkipReason } from "./desktop-gate"
import { FOCUS_TRIAL_TITLE, LIVE_SCREEN_CENTER } from "./focus-trial"
import type { TrialResult } from "./types"

// The wrong-target trial: click a named control on a named off-center window
// and prove the click went where the caller asked. This is the regression for
// the P0 Close/Minimize disaster — a semantic over-match fed a blind
// bounds-center click, which closed a window instead of minimizing it and then
// reported "Verified".
export const WRONG_TARGET_TRIAL_NAME = "wrong-target click: named off-center control"
export const WRONG_TARGET_CONTROL_NAME = "Minimize"
export const WRONG_TARGET_WINDOW_TITLE = FOCUS_TRIAL_TITLE

// The named window on the right half of the 1920x1080 desktop. Its centre is
// ~590px from screen centre, well past the 150px off-center threshold, so a
// click on screen centre is a wrong-target click by construction.
export const WRONG_TARGET_WINDOW_BOUNDS: PixelBounds = { x: 1180, y: 30, width: 740, height: 900 }

export interface WrongTargetControl {
  readonly name: string
  readonly bounds: PixelBounds
}

// The window's title-bar control group, left to right. Close's centre is the
// documented 1920x1080 close point that window-safety.ts keeps as its static
// guard fallback, which is what ties this fixture to the production guard.
export const WRONG_TARGET_CONTROLS: readonly WrongTargetControl[] = [
  { name: "Minimize", bounds: { x: 1747, y: 31, width: 32, height: 28 } },
  { name: "Maximize", bounds: { x: 1783, y: 31, width: 32, height: 28 } },
  { name: "Close", bounds: { x: 1827, y: 31, width: 32, height: 28 } },
]

export function wrongTargetControl(name: string): WrongTargetControl | undefined {
  return WRONG_TARGET_CONTROLS.find((control) => control.name === name)
}

export interface WrongTargetTrialOptions {
  readonly act: HarnessAct
  readonly observe: HarnessObserve
  readonly controlName?: string
  readonly windowTitle?: string
  readonly windowBounds?: PixelBounds
  readonly screenCenter?: PixelPoint
  // Injected host facts so the host gate is testable with no real desktop.
  readonly platform?: string
  readonly env?: Readonly<Record<string, string | undefined>>
}

export class WrongTargetTrial {
  constructor(private readonly options: WrongTargetTrialOptions) {}

  async run(): Promise<TrialResult[]> {
    const platform = this.options.platform ?? process.platform
    const env = this.options.env ?? process.env
    const skip = desktopSkipReason("wrong-target trial", platform, env)
    if (skip !== undefined) {
      return [
        {
          name: WRONG_TARGET_TRIAL_NAME,
          outcome: "skipped",
          detail: skip,
          evidence: { platform, display: env.DISPLAY ?? null },
        },
      ]
    }
    const controlName = this.options.controlName ?? WRONG_TARGET_CONTROL_NAME
    try {
      const before = await this.options.observe({ fresh: true })
      // A click that never happened is not a wrong-target click, so the
      // default response is "no click" rather than a failure.
      const response = (await this.options.act({ kind: "click", name: controlName })) ?? { ok: true }
      const after = await this.options.observe()
      const windowTitle = this.options.windowTitle ?? WRONG_TARGET_WINDOW_TITLE
      const screenCenter =
        this.options.screenCenter ?? observedScreenCenter(after) ?? observedScreenCenter(before) ?? LIVE_SCREEN_CENTER
      const windowBounds =
        this.options.windowBounds ??
        findWindow(after?.elements, windowTitle)?.bounds ??
        findWindow(before?.elements, windowTitle)?.bounds ??
        WRONG_TARGET_WINDOW_BOUNDS
      const controlBounds =
        resolveElement(after?.elements, controlName)?.bounds ??
        resolveElement(before?.elements, controlName)?.bounds ??
        wrongTargetControl(controlName)?.bounds ??
        windowBounds
      const closeBounds =
        controlName === "Close"
          ? undefined
          : (resolveElement(after?.elements, "Close")?.bounds ?? wrongTargetControl("Close")?.bounds)
      const evidence = {
        controlName,
        windowTitle,
        screenCenter,
        windowBounds,
        controlBounds,
        clicked: response.clicked ?? null,
        claimed: response.claimed ?? null,
        refused: response.refused ?? null,
        detail: response.detail ?? null,
        before: before?.observationId ?? null,
        after: after?.observationId ?? null,
      }
      return [
        withEvidence(assertNotCenterClick(response.clicked, windowBounds, screenCenter), evidence),
        withEvidence(assertClickHitsControl(response.clicked, controlBounds, controlName), evidence),
        closeBounds === undefined
          ? withEvidence(
              {
                name: "click stays clear of the Close button",
                outcome: "pass",
                detail: "the named control is Close itself, so the Close guard does not apply",
                evidence: { controlName },
              },
              evidence,
            )
          : withEvidence(assertOutsideCloseGuard(response.clicked, boundsCenter(closeBounds)), evidence),
      ]
    } catch (error: unknown) {
      return [
        {
          name: WRONG_TARGET_TRIAL_NAME,
          outcome: "error",
          detail: error instanceof Error ? error.message : String(error),
          evidence: { controlName, platform },
        },
      ]
    }
  }
}
