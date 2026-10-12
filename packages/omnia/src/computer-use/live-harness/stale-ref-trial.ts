import { assertStaleRefNeverClicks, assertStaleRefRefused } from "./assertions"
import { resolveElement, type HarnessAct, type HarnessObserve, withEvidence } from "./adapter"
import { desktopSkipReason } from "./desktop-gate"
import type { TrialResult } from "./types"

// The stale-ref trial: a ref belongs to the observation it came from. Handing
// the tool a ref from an older observation must be refused outright, never
// re-resolved by name onto whatever now answers to it — a silent rebind is how
// a click lands on a control the caller never named.
export const STALE_REF_TRIAL_NAME = "stale ref: refused, never rebound"
export const STALE_REF_CONTROL_NAME = "Minimize"

export interface StaleRefTrialOptions {
  readonly act: HarnessAct
  readonly observe: HarnessObserve
  readonly controlName?: string
  // Injected host facts so the host gate is testable with no real desktop.
  readonly platform?: string
  readonly env?: Readonly<Record<string, string | undefined>>
}

export class StaleRefTrial {
  constructor(private readonly options: StaleRefTrialOptions) {}

  async run(): Promise<TrialResult[]> {
    const platform = this.options.platform ?? process.platform
    const env = this.options.env ?? process.env
    const skip = desktopSkipReason("stale-ref trial", platform, env)
    if (skip !== undefined) {
      return [
        {
          name: STALE_REF_TRIAL_NAME,
          outcome: "skipped",
          detail: skip,
          evidence: { platform, display: env.DISPLAY ?? null },
        },
      ]
    }
    const controlName = this.options.controlName ?? STALE_REF_CONTROL_NAME
    try {
      const first = await this.options.observe({ fresh: true })
      const target = resolveElement(first?.elements, controlName)
      if (target === undefined) {
        return [
          {
            name: STALE_REF_TRIAL_NAME,
            outcome: "skipped",
            detail: `the current observation has no control named "${controlName}", so no ref can be captured for it`,
            evidence: { controlName, observationId: first?.observationId ?? null },
          },
        ]
      }
      const observationId = first?.observationId
      const generation = first?.generation
      if (observationId === undefined && generation === undefined) {
        return [
          {
            name: STALE_REF_TRIAL_NAME,
            outcome: "skipped",
            detail: "the observation carries no observationId and no generation, so a ref cannot be aged past it",
            evidence: { controlName, ref: target.ref },
          },
        ]
      }
      // Age the ref: a second, fresh observation is now the current one.
      const second = await this.options.observe({ fresh: true })
      const response = await this.options.act({
        kind: "click",
        name: controlName,
        ref: target.ref,
        ...(observationId === undefined ? {} : { observationId }),
        ...(generation === undefined ? {} : { generation }),
      })
      const evidence = {
        controlName,
        ref: target.ref,
        observationId: observationId ?? null,
        generation: generation ?? null,
        currentObservationId: second?.observationId ?? null,
        currentGeneration: second?.generation ?? null,
        clicked: response?.clicked ?? null,
        refused: response?.refused ?? null,
      }
      return [
        withEvidence(
          assertStaleRefRefused({
            ok: response?.ok ?? false,
            reason: response?.refused ?? response?.detail,
          }),
          evidence,
        ),
        withEvidence(
          assertStaleRefNeverClicks(
            response?.clicked,
            (second?.elements ?? []).find((element) => element.ref === target.ref)?.bounds,
            target.ref,
          ),
          evidence,
        ),
      ]
    } catch (error: unknown) {
      return [
        {
          name: STALE_REF_TRIAL_NAME,
          outcome: "error",
          detail: error instanceof Error ? error.message : String(error),
          evidence: { controlName, platform },
        },
      ]
    }
  }
}
