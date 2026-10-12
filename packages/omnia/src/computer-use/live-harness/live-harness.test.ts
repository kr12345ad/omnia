import { describe, expect, test } from "bun:test"
import { assertActiveWindowMatches, assertNotCenterClick, assertVerifiedHonest, summarize } from "./assertions"
import { FOCUS_TRIAL_TITLE, FocusTrial, runLiveHarness, type LiveAct, type LiveObserve } from "./focus-trial"
import type { TrialResult } from "./types"

const SCREEN_CENTER = { x: 960, y: 540 }
// Kitty "OC | Quick hello" body on the left half of a 1920x1080 screen; its
// center is ~540px away from screen center.
const OFF_CENTER_KITTY = { x: 40, y: 120, width: 760, height: 800 }
const LINUX_X11 = { platform: "linux", env: { DISPLAY: ":0" } }

// Returns each scripted title in order and repeats the last one on extra calls.
function scriptedObserve(titles: readonly (string | undefined)[]): LiveObserve {
  let calls = 0
  return () => {
    const title = titles[Math.min(calls, titles.length - 1)]
    calls += 1
    return title
  }
}

describe("assertActiveWindowMatches", () => {
  test("passes on an exact title", () => {
    expect(assertActiveWindowMatches("OC | Quick hello", "OC | Quick hello").outcome).toBe("pass")
  })

  test("passes on a case-insensitive substring that preserves the pipe", () => {
    expect(assertActiveWindowMatches("kitty — oc | quick hello", "OC | Quick hello").outcome).toBe("pass")
  })

  test("fails on a different window", () => {
    const result = assertActiveWindowMatches("Mozilla Firefox", "OC | Quick hello")
    expect(result.outcome).toBe("fail")
    expect(result.detail).toContain("does not contain")
  })

  test("fails on a missing post-observation", () => {
    const result = assertActiveWindowMatches(undefined, "OC | Quick hello")
    expect(result.outcome).toBe("fail")
    expect(result.detail).toContain("no post-observation")
  })
})

describe("assertNotCenterClick", () => {
  test("fires when the target is off-screen-center and the click lands on center", () => {
    const result = assertNotCenterClick({ x: 960, y: 539 }, OFF_CENTER_KITTY, SCREEN_CENTER)
    expect(result.outcome).toBe("fail")
    expect(result.detail).toContain("blind bounds-center click")
  })

  test("fires at exact screen center too", () => {
    expect(assertNotCenterClick({ x: 960, y: 540 }, OFF_CENTER_KITTY, SCREEN_CENTER).outcome).toBe("fail")
  })

  test("tolerance edge: 25px from center fires, 26px passes", () => {
    expect(assertNotCenterClick({ x: 985, y: 540 }, OFF_CENTER_KITTY, SCREEN_CENTER).outcome).toBe("fail")
    expect(assertNotCenterClick({ x: 986, y: 540 }, OFF_CENTER_KITTY, SCREEN_CENTER).outcome).toBe("pass")
  })

  test("passes when the click lands on the target", () => {
    expect(assertNotCenterClick({ x: 420, y: 520 }, OFF_CENTER_KITTY, SCREEN_CENTER).outcome).toBe("pass")
  })

  test("passes when the target itself sits on screen center", () => {
    const centered = { x: 860, y: 440, width: 200, height: 200 }
    expect(assertNotCenterClick({ x: 960, y: 539 }, centered, SCREEN_CENTER).outcome).toBe("pass")
  })

  test("passes when no click was recorded", () => {
    expect(assertNotCenterClick(undefined, OFF_CENTER_KITTY, SCREEN_CENTER).outcome).toBe("pass")
  })
})

describe("assertVerifiedHonest", () => {
  test("passes when a verified claim is backed by the observation", () => {
    expect(assertVerifiedHonest("verified", "OC | Quick hello", "Kitty — OC | Quick hello").outcome).toBe("pass")
  })

  test("fails a verified claim the observation does not support (the false-Verified bug)", () => {
    const result = assertVerifiedHonest("verified", "OC | Quick hello", "Mozilla Firefox")
    expect(result.outcome).toBe("fail")
    expect(result.detail).toContain("claimed verified")
  })

  test("fails a verified claim with no observation at all", () => {
    expect(assertVerifiedHonest("verified", "OC | Quick hello", undefined).outcome).toBe("fail")
  })

  test("passes an honest not_verified report", () => {
    expect(assertVerifiedHonest("not_verified", "OC | Quick hello", "Mozilla Firefox").outcome).toBe("pass")
  })
})

describe("summarize", () => {
  test("counts outcomes and excludes skipped trials from the pass rate", () => {
    const report = summarize([
      { name: "a", outcome: "pass", detail: "" },
      { name: "b", outcome: "pass", detail: "" },
      { name: "c", outcome: "fail", detail: "" },
      { name: "d", outcome: "error", detail: "" },
      { name: "e", outcome: "skipped", detail: "" },
    ])
    expect(report.passed).toBe(2)
    expect(report.failed).toBe(1)
    expect(report.errors).toBe(1)
    expect(report.passRate).toBe(0.5)
    expect(report.trials.length).toBe(5)
  })

  test("reports a zero pass rate with no trials", () => {
    const report = summarize([])
    expect(report.passRate).toBe(0)
    expect(report.trials.length).toBe(0)
  })
})

describe("FocusTrial", () => {
  test("correct focus passes, running observe -> act -> observe in order", async () => {
    const log: string[] = []
    const observe: LiveObserve = () => {
      log.push("observe")
      return log.filter((entry) => entry === "observe").length === 1 ? "Desktop" : `Kitty — ${FOCUS_TRIAL_TITLE}`
    }
    const act: LiveAct = (title) => {
      log.push(`act:${title}`)
      return undefined
    }
    const results = await new FocusTrial({ ...LINUX_X11, act, observe }).run()
    expect(results.map((result) => result.outcome)).toEqual(["pass"])
    expect(log).toEqual(["observe", `act:${FOCUS_TRIAL_TITLE}`, "observe"])
  })

  test("focus that does not change the window fails", async () => {
    const results = await new FocusTrial({
      ...LINUX_X11,
      act: () => undefined,
      observe: scriptedObserve(["LibreOffice Writer", "Mozilla Firefox"]),
    }).run()
    expect(results.map((result) => result.outcome)).toEqual(["fail"])
  })

  test("missing post-observation fails", async () => {
    const results = await new FocusTrial({
      ...LINUX_X11,
      act: () => undefined,
      observe: scriptedObserve(["Desktop", undefined]),
    }).run()
    expect(results.map((result) => result.outcome)).toEqual(["fail"])
    expect(results[0]?.detail).toContain("no post-observation")
  })

  test("wrong-target guard fails alongside the focus miss on the live (960,539) repro", async () => {
    const results = await new FocusTrial({
      ...LINUX_X11,
      act: () => ({ clicked: { x: 960, y: 539 }, targetBounds: OFF_CENTER_KITTY }),
      observe: scriptedObserve(["LibreOffice Writer", "Mozilla Firefox"]),
    }).run()
    expect(results.map((result) => result.outcome)).toEqual(["fail", "fail"])
    expect(results[1]?.name).toContain("screen-center")
  })

  test("a click that lands on the target passes the guard", async () => {
    const results = await new FocusTrial({
      ...LINUX_X11,
      act: () => ({ clicked: { x: 420, y: 520 }, targetBounds: OFF_CENTER_KITTY }),
      observe: scriptedObserve(["Desktop", `Kitty — ${FOCUS_TRIAL_TITLE}`]),
    }).run()
    expect(results.map((result) => result.outcome)).toEqual(["pass", "pass"])
  })

  test("non-Linux host skips without calling act or observe", async () => {
    let called = 0
    const results = await new FocusTrial({
      platform: "darwin",
      env: {},
      act: () => {
        called += 1
        return undefined
      },
      observe: () => {
        called += 1
        return "whatever"
      },
    }).run()
    expect(results.length).toBe(1)
    expect(results[0]?.outcome).toBe("skipped")
    expect(results[0]?.detail).toContain("darwin")
    expect(called).toBe(0)
  })

  test("Linux host without DISPLAY skips", async () => {
    const results = await new FocusTrial({
      platform: "linux",
      env: {},
      act: () => undefined,
      observe: () => "Kitty",
    }).run()
    expect(results[0]?.outcome).toBe("skipped")
    expect(results[0]?.detail).toContain("X11")
  })

  test("a throwing act produces an error trial, not a crash", async () => {
    const results = await new FocusTrial({
      ...LINUX_X11,
      act: () => {
        throw new Error("driver unavailable")
      },
      observe: scriptedObserve(["Desktop"]),
    }).run()
    expect(results.map((result: TrialResult) => result.outcome)).toEqual(["error"])
    expect(results[0]?.detail).toContain("driver unavailable")
  })
})

describe("runLiveHarness", () => {
  test("reports a full pass rate for a correct focus trial", async () => {
    const report = await runLiveHarness({
      ...LINUX_X11,
      act: () => undefined,
      observe: scriptedObserve(["Desktop", `Kitty — ${FOCUS_TRIAL_TITLE}`]),
    })
    expect(report.passed).toBe(1)
    expect(report.failed).toBe(0)
    expect(report.errors).toBe(0)
    expect(report.passRate).toBe(1)
  })

  test("reports the skip on an unsupported host", async () => {
    const report = await runLiveHarness({
      platform: "win32",
      env: {},
      act: () => undefined,
      observe: () => "Kitty",
    })
    expect(report.trials.length).toBe(1)
    expect(report.trials[0]?.outcome).toBe("skipped")
    expect(report.passRate).toBe(0)
  })
})
