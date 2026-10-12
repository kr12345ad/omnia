import { describe, expect, test } from "bun:test"
import {
  boundsCenter,
  runAllTrials,
  WRONG_TARGET_CONTROLS,
  HONEST_VERIFY_CONTROL_NAME,
  type PixelBounds,
  type HarnessAct,
  type HarnessAdapters,
  type HarnessElement,
  type HarnessObserve,
  type HarnessRequest,
} from "./index"

const TITLE = "OC | Quick hello"
const COMMAND_REF = "cua:window/kitty/OC | Quick hello/3/textfield/Command/1"
const LINUX_X11 = { platform: "linux", env: { DISPLAY: ":0" } }

function controlElement(name: string, bounds: PixelBounds): HarnessElement {
  return { ref: `cua:window/kitty/${TITLE}/3/button/${name}/1`, role: "button", name, bounds }
}

function windowElement(focused: boolean): HarnessElement {
  return {
    ref: "win-1",
    role: "window",
    name: `Kitty — ${TITLE}`,
    bounds: { x: 1180, y: 30, width: 740, height: 900 },
    states: focused ? ["focused"] : [],
  }
}

function minimizeControl() {
  return WRONG_TARGET_CONTROLS.find((control) => control.name === "Minimize")!
}

// A stub desktop that behaves the way the repaired system should: focusing a
// window focuses it, a click aimed at the named control lands on it, a
// change-free action reports not_verified, and a ref from an older observation
// is refused.
function greenAdapters(overrides: { clicked?: { x: number; y: number } } = {}): HarnessAdapters & {
  readonly requests: HarnessRequest[]
} {
  const requests: HarnessRequest[] = []
  let focused = false
  let commandFocused = false
  let generation = 0
  const minimize = minimizeControl()
  const act: HarnessAct = (request) => {
    requests.push(request)
    if (request.kind === "focus") {
      if (request.name === HONEST_VERIFY_CONTROL_NAME) commandFocused = true
      else focused = true
      return { ok: true, claimed: "verified" }
    }
    if (request.kind === "click") {
      if (request.observationId === undefined || request.generation === undefined) {
        return { ok: true, clicked: overrides.clicked ?? boundsCenter(minimize.bounds) }
      }
      const stale = request.observationId !== `obs-${generation}` || request.generation !== generation
      return stale
        ? { ok: false, refused: `Target ${request.ref} is from observation ${request.observationId}, not obs-${generation}; re-observe before acting.` }
        : { ok: true, clicked: boundsCenter(minimize.bounds) }
    }
    return { ok: true, claimed: "not_verified" }
  }
  const observe: HarnessObserve = (request) => {
    if (request?.fresh === true) generation += 1
    return {
      observationId: `obs-${generation}`,
      generation,
      activeWindowTitle: focused ? `Kitty — ${TITLE}` : "Desktop",
      screen: { width: 1920, height: 1080 },
      elements: [
        windowElement(focused),
        ...WRONG_TARGET_CONTROLS.map((control) => controlElement(control.name, control.bounds)),
        {
          ref: COMMAND_REF,
          role: "textfield",
          name: HONEST_VERIFY_CONTROL_NAME,
          value: "ls -la",
          states: commandFocused ? ["focused"] : [],
        },
      ],
    }
  }
  return { act, observe, requests }
}

describe("runAllTrials", () => {
  test("reports one pass rate over every trial on a green desktop", async () => {
    const report = await runAllTrials({ ...greenAdapters(), ...LINUX_X11 })
    expect(report.trials.map((trial) => trial.outcome)).toEqual([
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
    ])
    expect(report.trials.map((trial) => trial.name)).toEqual([
      "active window contains target title",
      "no blind screen-center click on off-center target",
      "click lands on the named control",
      "click stays clear of the Close button",
      "honest verification: no observed change means not_verified",
      "honest verification: a confirmed change may claim verified",
      "stale ref is refused",
      "a stale ref never clicks another element",
    ])
    expect(report.passed).toBe(8)
    expect(report.failed).toBe(0)
    expect(report.errors).toBe(0)
    expect(report.passRate).toBe(1)
  })

  test("a blind screen-center click fails the wrong-target trial and the pass rate", async () => {
    const report = await runAllTrials({ ...greenAdapters({ clicked: { x: 960, y: 539 } }), ...LINUX_X11 })
    expect(report.trials.map((trial) => trial.outcome)).toEqual([
      "pass",
      "fail",
      "fail",
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
    ])
    expect(report.failed).toBe(2)
    expect(report.passRate).toBe(6 / 8)
  })

  test("a focus that never lands fails the focus trial alone", async () => {
    const adapters = greenAdapters()
    // The act reports success, but nothing observes the window becoming active.
    const blind: HarnessAdapters = {
      ...adapters,
      act: (request) =>
        request.kind === "focus" && request.name !== HONEST_VERIFY_CONTROL_NAME
          ? { ok: true, claimed: "verified" }
          : adapters.act(request),
    }
    const report = await runAllTrials({ ...blind, ...LINUX_X11 })
    expect(report.trials[0]?.outcome).toBe("fail")
    expect(report.trials[0]?.detail).toContain("does not contain")
    expect(report.failed).toBe(1)
    expect(report.passRate).toBe(7 / 8)
  })

  test("a throwing act surfaces as an error trial instead of rejecting the run", async () => {
    const report = await runAllTrials({
      ...LINUX_X11,
      act: () => {
        throw new Error("driver unavailable")
      },
      observe: greenAdapters().observe,
    })
    // Every trial catches the same failure and reports it, so the run resolves
    // with four error trials instead of rejecting.
    expect(report.trials.filter((trial) => trial.outcome === "error").length).toBe(4)
    expect(report.errors).toBe(4)
    expect(report.passRate).toBe(0)
  })

  test("an unsupported host skips every trial without calling the adapters", async () => {
    let called = 0
    const report = await runAllTrials({
      platform: "darwin",
      env: {},
      act: () => {
        called += 1
        return { ok: true }
      },
      observe: () => {
        called += 1
        return undefined
      },
    })
    // Each trial emits one skipped result: its guards never run.
    expect(report.trials.length).toBe(4)
    expect(report.trials.every((trial) => trial.outcome === "skipped")).toBe(true)
    expect(report.passRate).toBe(0)
    expect(report.failed).toBe(0)
    expect(called).toBe(0)
  })

  test("the target title and control name reach every trial that needs them", async () => {
    const adapters = greenAdapters()
    const report = await runAllTrials({ ...adapters, ...LINUX_X11, title: "Scratch", controlName: "Close" })
    expect(report.trials[0]?.outcome).toBe("fail")
    // The Close click lands on Close, so both wrong-target guards pass.
    expect(report.trials[1]?.outcome).toBe("pass")
    expect(report.trials[2]?.evidence).toMatchObject({ controlName: "Close" })
    expect(adapters.requests.some((request) => request.kind === "focus" && request.name === "Scratch")).toBe(true)
    expect(adapters.requests.some((request) => request.kind === "click" && request.name === "Close")).toBe(true)
  })
})
