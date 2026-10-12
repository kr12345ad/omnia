import {
  assertActiveWindowMatches,
  assertNotCenterClick,
  summarize,
  type PixelBounds,
  type PixelPoint,
} from "./assertions"
import { desktopSkipReason } from "./desktop-gate"
import type { HarnessReport, TrialResult } from "./types"

// The rollout repro target from FOCUS_ROLLOUT.strategist.md: the Kitty window
// "OC | Quick hello" on a 1920x1080 KDE X11 desktop.
export const FOCUS_TRIAL_TITLE = "OC | Quick hello"
export const FOCUS_TRIAL_NAME = "focus_window: active window contains target title"
export const LIVE_SCREEN_CENTER: PixelPoint = { x: 960, y: 540 }

export interface LiveActOutcome {
  // A real act reports the point it actually clicked plus the bounds of the
  // control it aimed at, so the wrong-target guard can judge the click. A
  // focus_window action performs no click at all and leaves both undefined,
  // which is the path that fixed the (960,539) bug.
  readonly clicked?: PixelPoint
  readonly targetBounds?: PixelBounds
}

export type LiveAct = (title: string) => Promise<LiveActOutcome | undefined> | LiveActOutcome | undefined

// Returns the active window title, or undefined when no post-observation exists.
export type LiveObserve = () => Promise<string | undefined> | string | undefined

export interface FocusTrialOptions {
  readonly act: LiveAct
  readonly observe: LiveObserve
  readonly title?: string
  // Injected host facts so the host gate is testable with no real desktop.
  readonly platform?: string
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly screenCenter?: PixelPoint
}

// The trial only runs on a Linux/X11 host; anywhere else it refuses with a
// reason instead of throwing against a missing X server.
export function focusTrialSkipReason(platform: string, env: Readonly<Record<string, string | undefined>>): string | undefined {
  return desktopSkipReason("focus trial", platform, env)
}

// Focus trial: observe -> act(focus title) -> observe -> assert the active window
// contains the target title, plus the wrong-target guard whenever the act
// reported a click. Everything (act, observe, host facts) is injected, so it
// runs with no real desktop and no input synthesis.
export class FocusTrial {
  constructor(private readonly options: FocusTrialOptions) {}

  async run(): Promise<TrialResult[]> {
    const platform = this.options.platform ?? process.platform
    const env = this.options.env ?? process.env
    const skip = focusTrialSkipReason(platform, env)
    if (skip !== undefined) {
      return [
        {
          name: FOCUS_TRIAL_NAME,
          outcome: "skipped",
          detail: skip,
          evidence: { platform, display: env.DISPLAY ?? null },
        },
      ]
    }
    const title = this.options.title ?? FOCUS_TRIAL_TITLE
    try {
      const before = await this.options.observe()
      const outcome = (await this.options.act(title)) ?? {}
      const after = await this.options.observe()
      const focus = assertActiveWindowMatches(after, title)
      const trials: TrialResult[] = [
        {
          ...focus,
          evidence: {
            ...(focus.evidence ?? {}),
            platform,
            before: before ?? null,
            after: after ?? null,
            clicked: outcome.clicked ?? null,
            targetBounds: outcome.targetBounds ?? null,
          },
        },
      ]
      if (outcome.clicked !== undefined && outcome.targetBounds !== undefined) {
        trials.push(
          assertNotCenterClick(outcome.clicked, outcome.targetBounds, this.options.screenCenter ?? LIVE_SCREEN_CENTER),
        )
      }
      return trials
    } catch (error: unknown) {
      return [
        {
          name: FOCUS_TRIAL_NAME,
          outcome: "error",
          detail: error instanceof Error ? error.message : String(error),
          evidence: { title, platform },
        },
      ]
    }
  }
}

export async function runLiveHarness(options: FocusTrialOptions): Promise<HarnessReport> {
  return summarize(await new FocusTrial(options).run())
}
