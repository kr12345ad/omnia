import { describe, expect, test } from "bun:test"
import { CLOSE_GUARD_DISTANCE_PX, KNOWN_CLOSE_POINT_1080P } from "../window-safety"
import { assertClickHitsControl, assertOutsideCloseGuard, boundsCenter } from "./assertions"
import {
  wrongTargetControl,
  WRONG_TARGET_CONTROLS,
  WRONG_TARGET_TRIAL_NAME,
  WrongTargetTrial,
} from "./wrong-target-trial"
import type { HarnessAct, HarnessElement, HarnessObservation, HarnessObserve } from "./adapter"

const SCREEN_CENTER = { x: 960, y: 540 }
const LINUX_X11 = { platform: "linux", env: { DISPLAY: ":0" } }

// The named control's centre in the documented fixture.
const MINIMIZE_CENTER = boundsCenter(wrongTargetControl("Minimize")!.bounds)
const MAXIMIZE_CENTER = boundsCenter(wrongTargetControl("Maximize")!.bounds)
const CLOSE_CENTER = boundsCenter(wrongTargetControl("Close")!.bounds)

// A stub desktop: the named window with its title-bar control group, measured
// on the 1920x1080 screen the repro was recorded on.
function desktopObservation(overrides: Partial<HarnessObservation> = {}): HarnessObservation {
  return {
    observationId: "obs-1",
    generation: 1,
    activeWindowTitle: "Mozilla Firefox",
    screen: { width: 1920, height: 1080 },
    elements: [
      {
        ref: "win-1",
        role: "window",
        name: "Kitty — OC | Quick hello",
        bounds: { x: 1180, y: 30, width: 740, height: 900 },
        states: [],
      },
      ...WRONG_TARGET_CONTROLS.map(
        (control, index): HarnessElement => ({
          ref: `cua:window/kitty/OC | Quick hello/3/button/${control.name}/${index}`,
          role: "button",
          name: control.name,
          bounds: control.bounds,
        }),
      ),
    ],
    ...overrides,
  }
}

function stub(overrides: {
  act?: HarnessAct
  observe?: HarnessObserve
}): { act: HarnessAct; observe: HarnessObserve } {
  return {
    act: overrides.act ?? (() => ({ ok: true, clicked: MINIMIZE_CENTER })),
    observe: overrides.observe ?? (() => desktopObservation()),
  }
}

describe("wrong-target fixture", () => {
  test("the Close control sits on the documented 1920x1080 close point", () => {
    expect(CLOSE_CENTER).toEqual({ x: KNOWN_CLOSE_POINT_1080P.x, y: KNOWN_CLOSE_POINT_1080P.y })
  })

  test("the fixture leaves room for a correct Minimize click", () => {
    // The rollout note records Minimize and Close 9px apart on some themes,
    // which is why the Close guard exists at all. This fixture keeps a real
    // gap, so a correct click on Minimize is provably clear of the guard.
    expect(CLOSE_CENTER.x - MINIMIZE_CENTER.x).toBeGreaterThan(CLOSE_GUARD_DISTANCE_PX)
    expect(MAXIMIZE_CENTER.x).toBeGreaterThan(MINIMIZE_CENTER.x)
    expect(CLOSE_CENTER.x).toBeGreaterThan(MAXIMIZE_CENTER.x)
  })
})

describe("assertClickHitsControl", () => {
  test("passes when the click is inside the named control", () => {
    const result = assertClickHitsControl(MINIMIZE_CENTER, wrongTargetControl("Minimize")!.bounds, "Minimize")
    expect(result.outcome).toBe("pass")
  })

  test("fails when the click lands on a sibling control", () => {
    const result = assertClickHitsControl(CLOSE_CENTER, wrongTargetControl("Minimize")!.bounds, "Minimize")
    expect(result.outcome).toBe("fail")
    expect(result.detail).toContain("outside")
  })

  test("passes when no click was recorded", () => {
    expect(assertClickHitsControl(undefined, wrongTargetControl("Minimize")!.bounds, "Minimize").outcome).toBe("pass")
  })
})

describe("assertOutsideCloseGuard", () => {
  test("passes when the click is clear of the close point", () => {
    expect(assertOutsideCloseGuard(MINIMIZE_CENTER, CLOSE_CENTER).outcome).toBe("pass")
  })

  test("fires when the click lands on the close point", () => {
    const result = assertOutsideCloseGuard(CLOSE_CENTER, CLOSE_CENTER)
    expect(result.outcome).toBe("fail")
    expect(result.detail).toContain("Close guard")
  })

  test("passes when no click was recorded", () => {
    expect(assertOutsideCloseGuard(undefined, CLOSE_CENTER).outcome).toBe("pass")
  })

  test("honours the guard distance it is given", () => {
    // 13px from the close point: clear of a 10px guard, inside a 20px one.
    expect(assertOutsideCloseGuard({ x: 1830, y: 45 }, CLOSE_CENTER, 10).outcome).toBe("pass")
    expect(assertOutsideCloseGuard({ x: 1830, y: 45 }, CLOSE_CENTER, 20).outcome).toBe("fail")
  })
})

describe("WrongTargetTrial", () => {
  test("a click on the named control passes every guard", async () => {
    const results = await new WrongTargetTrial({ ...LINUX_X11, ...stub({}) }).run()
    expect(results.map((result) => result.outcome)).toEqual(["pass", "pass", "pass"])
    expect(results[0]?.name).toContain("screen-center")
    expect(results[1]?.name).toContain("named control")
    expect(results[2]?.name).toContain("Close")
  })

  test("the (960,539) blind screen-center click fails the wrong-target guard", async () => {
    const results = await new WrongTargetTrial({
      ...LINUX_X11,
      ...stub({ act: () => ({ ok: true, clicked: { x: 960, y: 539 } }) }),
    }).run()
    expect(results.map((result) => result.outcome)).toEqual(["fail", "fail", "pass"])
    expect(results[0]?.detail).toContain("blind bounds-center click")
    expect(results[1]?.detail).toContain("outside")
  })

  test("a click that lands on Close fails both the hit test and the Close guard", async () => {
    const results = await new WrongTargetTrial({
      ...LINUX_X11,
      ...stub({ act: () => ({ ok: true, clicked: CLOSE_CENTER }) }),
    }).run()
    expect(results.map((result) => result.outcome)).toEqual(["pass", "fail", "fail"])
  })

  test("a click on a sibling that is not Close fails the hit test only", async () => {
    const results = await new WrongTargetTrial({
      ...LINUX_X11,
      ...stub({ act: () => ({ ok: true, clicked: MAXIMIZE_CENTER }) }),
    }).run()
    expect(results.map((result) => result.outcome)).toEqual(["pass", "fail", "pass"])
  })

  test("an action that never clicked passes, with the refusal recorded", async () => {
    const results = await new WrongTargetTrial({
      ...LINUX_X11,
      ...stub({ act: () => ({ ok: false, refused: "Minimize is not exposed as an action" }) }),
    }).run()
    expect(results.map((result) => result.outcome)).toEqual(["pass", "pass", "pass"])
    expect(results[0]?.evidence).toMatchObject({ refused: "Minimize is not exposed as an action" })
  })

  test("measures against the observed window and screen, not the documented fixture", async () => {
    // The window sits left of centre on a smaller screen, so the observed
    // screen centre is (500,400) and a click there is a wrong-target click
    // even though the documented 1920x1080 centre is untouched.
    const results = await new WrongTargetTrial({
      ...LINUX_X11,
      act: () => ({ ok: true, clicked: { x: 500, y: 400 } }),
      observe: () =>
        desktopObservation({
          screen: { width: 1000, height: 800 },
          elements: [
            {
              ref: "win-1",
              role: "window",
              name: "Kitty — OC | Quick hello",
              bounds: { x: 100, y: 20, width: 300, height: 700 },
            },
          ],
        }),
    }).run()
    expect(results.map((result) => result.outcome)).toEqual(["fail", "fail", "pass"])
    expect(results[0]?.detail).toContain("(500,400)")
  })

  test("non-Linux host skips without calling act or observe", async () => {
    let called = 0
    const results = await new WrongTargetTrial({
      platform: "darwin",
      env: {},
      act: () => {
        called += 1
        return { ok: true }
      },
      observe: () => {
        called += 1
        return desktopObservation()
      },
    }).run()
    expect(results.length).toBe(1)
    expect(results[0]?.outcome).toBe("skipped")
    expect(results[0]?.detail).toContain("darwin")
    expect(called).toBe(0)
  })

  test("Linux host without DISPLAY skips", async () => {
    const results = await new WrongTargetTrial({
      platform: "linux",
      env: {},
      act: () => ({ ok: true }),
      observe: () => desktopObservation(),
    }).run()
    expect(results[0]?.outcome).toBe("skipped")
    expect(results[0]?.detail).toContain("X11")
  })

  test("a throwing act produces an error trial, not a crash", async () => {
    const results = await new WrongTargetTrial({
      ...LINUX_X11,
      act: () => {
        throw new Error("driver unavailable")
      },
      observe: () => desktopObservation(),
    }).run()
    expect(results.map((result) => result.outcome)).toEqual(["error"])
    expect(results[0]?.detail).toContain("driver unavailable")
    expect(results[0]?.name).toBe(WRONG_TARGET_TRIAL_NAME)
  })

  test("naming the Close control as the target disables the Close guard", async () => {
    const results = await new WrongTargetTrial({
      ...LINUX_X11,
      ...stub({ act: () => ({ ok: true, clicked: CLOSE_CENTER }) }),
      controlName: "Close",
    }).run()
    expect(results.map((result) => result.outcome)).toEqual(["pass", "pass", "pass"])
    expect(results[2]?.detail).toContain("does not apply")
  })
})
