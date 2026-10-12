import { assertVerifiedOnlyOnChange } from "./assertions"
import { resolveElement, type HarnessAct, type HarnessElement, type HarnessObserve, type HarnessObservation, withEvidence } from "./adapter"
import { desktopSkipReason } from "./desktop-gate"
import type { TrialResult } from "./types"

// The honest-verify trial: an action whose post-observation shows no change may
// only ever be reported as "not_verified". This is the regression for the
// second half of the P0 — the first centre-click was reported "Verified" with
// the window never focused.
export const HONEST_VERIFY_TRIAL_NAME = "honest verification: no observed change means not_verified"
export const HONEST_VERIFY_CONTROL_NAME = "Command"
export const HONEST_VERIFY_FOCUS_NAME = "honest verification: a confirmed change may claim verified"
export const NO_CHANGE_ASSERTION_NAME = "verification requires an observed change"

// A control's observable state: the value the backend reports plus the states
// it reports. Both are compared, because an action can be real without moving
// the value (a focus action only moves the states).
interface ControlState {
  readonly value: string | undefined
  readonly states: readonly string[]
}

function controlState(observation: HarnessObservation | undefined, ref: string): ControlState | undefined {
  const element = (observation?.elements ?? []).find((candidate) => candidate.ref === ref)
  if (element === undefined) return undefined
  return { value: element.value, states: element.states ?? [] }
}

function stateKey(state: ControlState): string {
  return `${state.value ?? ""}\u0000${[...state.states].sort().join(",")}`
}

// A vanished control reads as "no change": there is nothing to confirm, so any
// verified claim attached to it is exactly the false-Verified bug.
function stateChanged(before: HarnessObservation | undefined, after: HarnessObservation | undefined, ref: string): boolean {
  const first = controlState(before, ref)
  const second = controlState(after, ref)
  if (second === undefined) return false
  return first === undefined || stateKey(first) !== stateKey(second)
}

function bindingOf(observation: HarnessObservation | undefined, element: HarnessElement) {
  return {
    ref: element.ref,
    ...(observation?.observationId === undefined ? {} : { observationId: observation.observationId }),
    ...(observation?.generation === undefined ? {} : { generation: observation.generation }),
  }
}

// The tool's own claim, read conservatively: a tool that reported nothing
// certainly did not claim verified.
function claimed(response: { readonly claimed?: "verified" | "not_verified" } | undefined): "verified" | "not_verified" {
  return response?.claimed ?? "not_verified"
}

// The assertion names the rule; the trial names the scenario, so the report
// shows which of the two runs produced the verdict.
function named(result: TrialResult, name: string): TrialResult {
  return { ...result, name }
}

export interface HonestVerifyTrialOptions {
  readonly act: HarnessAct
  readonly observe: HarnessObserve
  readonly controlName?: string
  // Injected host facts so the host gate is testable with no real desktop.
  readonly platform?: string
  readonly env?: Readonly<Record<string, string | undefined>>
}

export class HonestVerifyTrial {
  constructor(private readonly options: HonestVerifyTrialOptions) {}

  async run(): Promise<TrialResult[]> {
    const platform = this.options.platform ?? process.platform
    const env = this.options.env ?? process.env
    const skip = desktopSkipReason("honest-verify trial", platform, env)
    if (skip !== undefined) {
      return [
        {
          name: HONEST_VERIFY_TRIAL_NAME,
          outcome: "skipped",
          detail: skip,
          evidence: { platform, display: env.DISPLAY ?? null },
        },
      ]
    }
    const controlName = this.options.controlName ?? HONEST_VERIFY_CONTROL_NAME
    try {
      const before = await this.options.observe({ fresh: true })
      const target = resolveElement(before?.elements, controlName)
      if (target === undefined) {
        return [
          {
            name: HONEST_VERIFY_TRIAL_NAME,
            outcome: "skipped",
            detail: `the current observation has no control named "${controlName}", so no action can be staged against it`,
            evidence: { controlName, observationId: before?.observationId ?? null },
          },
        ]
      }
      const results: TrialResult[] = []
      const original = target.value
      // Scenario A: write back the value the control already holds. The action
      // cannot change anything, so a "verified" claim would be a lie.
      if (original === undefined) {
        results.push({
          name: NO_CHANGE_ASSERTION_NAME,
          outcome: "skipped",
          detail: `the observation exposes no value for "${controlName}", so a change-free action cannot be staged against it`,
          evidence: { controlName, ref: target.ref },
        })
      } else {
        const response =
          (await this.options.act({
            kind: "set-value",
            name: controlName,
            ...bindingOf(before, target),
            value: original,
          })) ?? { ok: true }
        const after = await this.options.observe()
        results.push(
          named(
            withEvidence(assertVerifiedOnlyOnChange(claimed(response), stateChanged(before, after, target.ref)), {
              scenario: "set-value to the current value",
              controlName,
              ref: target.ref,
              value: original,
              before: before?.observationId ?? null,
              after: after?.observationId ?? null,
              detail: response.detail ?? null,
            }),
            HONEST_VERIFY_TRIAL_NAME,
          ),
        )
      }
      // Scenario B: focus the control. Whether that changes the states depends
      // on the desktop, and the verdict has to follow the observation either
      // way rather than the action's own report.
      const response = (await this.options.act({ kind: "focus", name: controlName, ...bindingOf(before, target) })) ?? {
        ok: true,
      }
      const after = await this.options.observe()
      results.push(
        named(
          withEvidence(assertVerifiedOnlyOnChange(claimed(response), stateChanged(before, after, target.ref)), {
            scenario: "focus the control",
            controlName,
            ref: target.ref,
            before: before?.observationId ?? null,
            after: after?.observationId ?? null,
            detail: response.detail ?? null,
          }),
          HONEST_VERIFY_FOCUS_NAME,
        ),
      )
      return results
    } catch (error: unknown) {
      return [
        {
          name: HONEST_VERIFY_TRIAL_NAME,
          outcome: "error",
          detail: error instanceof Error ? error.message : String(error),
          evidence: { controlName, platform },
        },
      ]
    }
  }
}
