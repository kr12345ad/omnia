export * from "./types"
export {
  assertActiveWindowMatches,
  assertClickHitsControl,
  assertNotCenterClick,
  assertOutsideCloseGuard,
  assertStaleRefNeverClicks,
  assertStaleRefRefused,
  assertVerifiedHonest,
  assertVerifiedOnlyOnChange,
  boundsCenter,
  containsTitle,
  summarize,
  CENTER_CLICK_TOLERANCE_PX,
  OFF_CENTER_DISTANCE_PX,
  type PixelBounds,
  type PixelPoint,
} from "./assertions"
export { desktopSkipReason, liveHarnessSkipReason } from "./desktop-gate"
export {
  findWindow,
  observedScreenCenter,
  resolveElement,
  withEvidence,
  type HarnessAct,
  type HarnessAdapters,
  type HarnessElement,
  type HarnessObservation,
  type HarnessObserve,
  type HarnessObserveRequest,
  type HarnessRequest,
  type HarnessResponse,
} from "./adapter"
export {
  FOCUS_TRIAL_NAME,
  FOCUS_TRIAL_TITLE,
  FocusTrial,
  LIVE_SCREEN_CENTER,
  focusTrialSkipReason,
  runLiveHarness,
  type FocusTrialOptions,
  type LiveAct,
  type LiveActOutcome,
  type LiveObserve,
} from "./focus-trial"
export {
  HONEST_VERIFY_CONTROL_NAME,
  HONEST_VERIFY_FOCUS_NAME,
  HONEST_VERIFY_TRIAL_NAME,
  HonestVerifyTrial,
  type HonestVerifyTrialOptions,
} from "./honest-verify-trial"
export {
  STALE_REF_CONTROL_NAME,
  STALE_REF_TRIAL_NAME,
  StaleRefTrial,
  type StaleRefTrialOptions,
} from "./stale-ref-trial"
export {
  WRONG_TARGET_CONTROL_NAME,
  WRONG_TARGET_CONTROLS,
  WRONG_TARGET_TRIAL_NAME,
  WRONG_TARGET_WINDOW_BOUNDS,
  WRONG_TARGET_WINDOW_TITLE,
  WrongTargetTrial,
  wrongTargetControl,
  type WrongTargetControl,
  type WrongTargetTrialOptions,
} from "./wrong-target-trial"
import type { HarnessAct, HarnessAdapters, HarnessObserve } from "./adapter"
import { summarize } from "./assertions"
import { FOCUS_TRIAL_TITLE, FocusTrial, type LiveAct, type LiveObserve } from "./focus-trial"
import { HonestVerifyTrial } from "./honest-verify-trial"
import { StaleRefTrial } from "./stale-ref-trial"
import { WRONG_TARGET_CONTROL_NAME, WrongTargetTrial } from "./wrong-target-trial"
import type { HarnessReport } from "./types"

export interface HarnessOptions extends HarnessAdapters {
  readonly platform?: string
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly title?: string
  readonly controlName?: string
}

// One report over every trial, run in order against the same injected desktop.
// The focus trial keeps its narrower adapter shape, so `runAllTrials` adapts
// the single contract onto it and every other trial consumes it directly.
export async function runAllTrials(options: HarnessOptions): Promise<HarnessReport> {
  const act: HarnessAct = (request) => options.act(request)
  const observe: HarnessObserve = (request) => options.observe(request)
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const focusAct: LiveAct = async (title) => (await act({ kind: "focus", name: title })) ?? {}
  const focusObserve: LiveObserve = async () => (await observe())?.activeWindowTitle
  const title = options.title ?? FOCUS_TRIAL_TITLE
  const controlName = options.controlName ?? WRONG_TARGET_CONTROL_NAME
  const results = [
    ...(await new FocusTrial({ act: focusAct, observe: focusObserve, platform, env, title }).run()),
    ...(await new WrongTargetTrial({ act, observe, platform, env, controlName, windowTitle: title }).run()),
    ...(await new HonestVerifyTrial({ act, observe, platform, env }).run()),
    ...(await new StaleRefTrial({ act, observe, platform, env, controlName }).run()),
  ]
  return summarize(results)
}
