import { describe, expect, test } from "bun:test"
import { assertStaleRefNeverClicks, assertStaleRefRefused } from "./assertions"
import type { HarnessAct, HarnessElement, HarnessObservation, HarnessObserve } from "./adapter"
import {
  STALE_REF_CONTROL_NAME,
  STALE_REF_TRIAL_NAME,
  StaleRefTrial,
} from "./stale-ref-trial"

const LINUX_X11 = { platform: "linux", env: { DISPLAY: ":0" } }
const CONTROL_REF = "cua:window/kitty/OC | Quick hello/3/button/Minimize/1"
// Where the control sits in the current observation once the window has moved.
const CURRENT_BOUNDS = { x: 210, y: 31, width: 32, height: 28 }
const STALE_MESSAGE = `Target ${CONTROL_REF} is from observation obs-1 (generation 1), not the current obs-2 (generation 2); re-observe before acting.`

function minimizeButton(overrides: Partial<HarnessElement> = {}): HarnessElement {
  return { ref: CONTROL_REF, role: "button", name: STALE_REF_CONTROL_NAME, bounds: CURRENT_BOUNDS, ...overrides }
}

function desktopObservation(overrides: Partial<HarnessObservation> = {}): HarnessObservation {
  return {
    observationId: "obs-1",
    generation: 1,
    activeWindowTitle: "Kitty — OC | Quick hello",
    screen: { width: 1920, height: 1080 },
    elements: [minimizeButton()],
    ...overrides,
  }
}

function stub(overrides: { act?: HarnessAct; observe?: HarnessObserve }): {
  act: HarnessAct
  observe: HarnessObserve
} {
  return {
    act: overrides.act ?? (() => ({ ok: false, refused: STALE_MESSAGE })),
    observe: overrides.observe ?? (() => desktopObservation()),
  }
}

describe("assertStaleRefRefused", () => {
  test("passes a refusal that says so", () => {
    const result = assertStaleRefRefused({ ok: false, reason: STALE_MESSAGE })
    expect(result.outcome).toBe("pass")
    expect(result.detail).toContain("refused")
  })

  test("fails an accepted stale ref", () => {
    const result = assertStaleRefRefused({ ok: true, reason: undefined })
    expect(result.outcome).toBe("fail")
    expect(result.detail).toContain("older observation")
  })

  test("fails a failure that reports no reason", () => {
    expect(assertStaleRefRefused({ ok: false, reason: undefined }).outcome).toBe("fail")
    expect(assertStaleRefRefused({ ok: false, reason: "   " }).outcome).toBe("fail")
  })
})

describe("assertStaleRefNeverClicks", () => {
  test("passes a refusal that clicked nothing", () => {
    expect(assertStaleRefNeverClicks(undefined, CURRENT_BOUNDS, CONTROL_REF).outcome).toBe("pass")
  })

  test("passes a click that is still inside the original element's bounds", () => {
    expect(assertStaleRefNeverClicks({ x: 224, y: 45 }, CURRENT_BOUNDS, CONTROL_REF).outcome).toBe("pass")
  })

  test("fails a click outside the original element's bounds", () => {
    const result = assertStaleRefNeverClicks({ x: 900, y: 600 }, CURRENT_BOUNDS, CONTROL_REF)
    expect(result.outcome).toBe("fail")
    expect(result.detail).toContain("rebound")
  })

  test("fails a click for an element the current observation cannot place", () => {
    expect(assertStaleRefNeverClicks({ x: 224, y: 45 }, undefined, CONTROL_REF).outcome).toBe("fail")
  })
})

describe("StaleRefTrial", () => {
  test("a refused stale ref passes both guards", async () => {
    const results = await new StaleRefTrial({ ...LINUX_X11, ...stub({}) }).run()
    expect(results.map((result) => result.outcome)).toEqual(["pass", "pass"])
    expect(results[0]?.evidence).toMatchObject({
      observationId: "obs-1",
      generation: 1,
      currentObservationId: "obs-1",
      currentGeneration: 1,
    })
  })

  test("an accepted stale ref fails the refusal guard", async () => {
    const results = await new StaleRefTrial({
      ...LINUX_X11,
      ...stub({ act: () => ({ ok: true, detail: "clicked at (224,45)" }) }),
    }).run()
    expect(results.map((result) => result.outcome)).toEqual(["fail", "pass"])
    expect(results[0]?.detail).toContain("older observation")
  })

  test("a stale ref that clicked a different element fails the rebind guard", async () => {
    // The window moved between observations, so the button the ref named is at
    // (210,31) and a click at (900,600) is a different element entirely.
    let calls = 0
    const results = await new StaleRefTrial({
      ...LINUX_X11,
      act: () => ({ ok: true, clicked: { x: 900, y: 600 } }),
      observe: () => {
        calls += 1
        return desktopObservation({
          observationId: calls === 1 ? "obs-1" : "obs-2",
          generation: calls === 1 ? 1 : 2,
        })
      },
    }).run()
    expect(results.map((result) => result.outcome)).toEqual(["fail", "fail"])
    expect(results[1]?.detail).toContain("rebound")
  })

  test("a refusal with no reason fails the refusal guard", async () => {
    const results = await new StaleRefTrial({
      ...LINUX_X11,
      ...stub({ act: () => ({ ok: false }) }),
    }).run()
    expect(results.map((result) => result.outcome)).toEqual(["fail", "pass"])
    expect(results[0]?.detail).toContain("no refusal")
  })

  test("an act that returns nothing fails the refusal guard", async () => {
    const results = await new StaleRefTrial({ ...LINUX_X11, ...stub({ act: () => undefined }) }).run()
    expect(results.map((result) => result.outcome)).toEqual(["fail", "pass"])
  })

  test("the act is asked for the ref and binding of the first observation", async () => {
    const requests: unknown[] = []
    const results = await new StaleRefTrial({
      ...LINUX_X11,
      act: (request) => {
        requests.push(request)
        return { ok: false, refused: STALE_MESSAGE }
      },
      observe: () => desktopObservation(),
    }).run()
    expect(results.map((result) => result.outcome)).toEqual(["pass", "pass"])
    expect(requests).toEqual([
      { kind: "click", name: STALE_REF_CONTROL_NAME, ref: CONTROL_REF, observationId: "obs-1", generation: 1 },
    ])
  })

  test("an observation without an observationId or generation skips the trial", async () => {
    const results = await new StaleRefTrial({
      ...LINUX_X11,
      ...stub({
        observe: () => desktopObservation({ observationId: undefined, generation: undefined }),
      }),
    }).run()
    expect(results.map((result) => result.outcome)).toEqual(["skipped"])
    expect(results[0]?.detail).toContain("cannot be aged")
  })

  test("a control absent from the observation skips the trial", async () => {
    const results = await new StaleRefTrial({
      ...LINUX_X11,
      ...stub({ observe: () => desktopObservation({ elements: [] }) }),
    }).run()
    expect(results.map((result) => result.outcome)).toEqual(["skipped"])
    expect(results[0]?.detail).toContain(STALE_REF_CONTROL_NAME)
  })

  test("non-Linux host skips without calling act or observe", async () => {
    let called = 0
    const results = await new StaleRefTrial({
      platform: "linux",
      env: { DISPLAY: "" },
      act: () => {
        called += 1
        return { ok: false, refused: STALE_MESSAGE }
      },
      observe: () => {
        called += 1
        return desktopObservation()
      },
    }).run()
    expect(results.map((result) => result.outcome)).toEqual(["skipped"])
    expect(results[0]?.detail).toContain("X11")
    expect(called).toBe(0)
  })

  test("a throwing act produces an error trial, not a crash", async () => {
    const results = await new StaleRefTrial({
      ...LINUX_X11,
      act: () => {
        throw new Error("driver unavailable")
      },
      observe: () => desktopObservation(),
    }).run()
    expect(results.map((result) => result.outcome)).toEqual(["error"])
    expect(results[0]?.detail).toContain("driver unavailable")
    expect(results[0]?.name).toBe(STALE_REF_TRIAL_NAME)
  })
})
