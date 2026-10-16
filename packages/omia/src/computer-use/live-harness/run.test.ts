import { describe, expect, test } from "bun:test"
import { createLiveAdapters, formatReport, harnessControlName, harnessWindowTitle, main, WINDOW_ENV, CONTROL_ENV } from "./run"
import type { HarnessReport } from "./types"

const ARMED = { OMNIA_LIVE_HARNESS: "1", DISPLAY: ":0" }
const DISARMED = { OMNIA_LIVE_HARNESS: "0", DISPLAY: ":0" }

describe("liveHarnessSkipReason", () => {
  test("an unarmed environment is a skip, however much display it has", () => {
    expect(main(DISARMED)).resolves.toBe(0)
  })

  test("an armed environment without a display is still a skip", () => {
    expect(main({ OMNIA_LIVE_HARNESS: "1" })).resolves.toBe(0)
  })

  test("the skip reason names the missing arm or display", async () => {
    expect(createLiveAdapters(DISARMED)).toBeUndefined()
    expect(createLiveAdapters({ OMNIA_LIVE_HARNESS: "1" })).toBeUndefined()
  })
})

describe("createLiveAdapters", () => {
  test("never builds a driver while the harness is disarmed", () => {
    expect(createLiveAdapters(DISARMED)).toBeUndefined()
  })

  test("the armed environment is what admits the real adapters", () => {
    // Armed and displayed, so the adapters exist — but nothing has touched the
    // display yet, and this test never calls them.
    expect(createLiveAdapters(ARMED)).toBeDefined()
  })
})

describe("harness target names", () => {
  test("defaults to the documented Kitty window and its Minimize control", () => {
    expect(harnessWindowTitle({})).toBe("OC | Quick hello")
    expect(harnessControlName({})).toBe("Minimize")
  })

  test("honours the operator's overrides", () => {
    expect(harnessWindowTitle({ [WINDOW_ENV]: "  Scratch  " })).toBe("Scratch")
    expect(harnessControlName({ [CONTROL_ENV]: "Close" })).toBe("Close")
  })
})

describe("formatReport", () => {
  test("sums the outcomes and keeps skipped trials out of the pass rate", () => {
    const report: HarnessReport = {
      trials: [
        { name: "a", outcome: "pass", detail: "fine" },
        { name: "b", outcome: "fail", detail: "wrong target" },
        { name: "c", outcome: "error", detail: "driver unavailable" },
        { name: "d", outcome: "skipped", detail: "no desktop" },
      ],
      passed: 1,
      failed: 1,
      errors: 1,
      passRate: 1 / 3,
    }
    const text = formatReport(report)
    expect(text).toContain("1 pass, 1 fail, 1 error, 1 skipped (pass rate 33%)")
    expect(text).toContain("fail     b — wrong target")
    expect(text).toContain("error    c — driver unavailable")
  })

  test("a harness that skipped everything reports a zero pass rate", () => {
    const text = formatReport({ trials: [], passed: 0, failed: 0, errors: 0, passRate: 0 })
    expect(text).toContain("0 pass, 0 fail, 0 error, 0 skipped (pass rate 0%)")
  })
})
