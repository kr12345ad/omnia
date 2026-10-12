import { describe, expect, test } from "bun:test"
import { assertVerifiedOnlyOnChange } from "./assertions"
import type { HarnessAct, HarnessElement, HarnessObservation, HarnessObserve } from "./adapter"
import {
  HONEST_VERIFY_CONTROL_NAME,
  HONEST_VERIFY_FOCUS_NAME,
  HONEST_VERIFY_TRIAL_NAME,
  HonestVerifyTrial,
} from "./honest-verify-trial"

const LINUX_X11 = { platform: "linux", env: { DISPLAY: ":0" } }
const CONTROL_REF = "cua:window/kitty/OC | Quick hello/3/textfield/Command/1"

function commandField(overrides: Partial<HarnessElement> = {}): HarnessElement {
  return { ref: CONTROL_REF, role: "textfield", name: HONEST_VERIFY_CONTROL_NAME, value: "current value", ...overrides }
}

function desktopObservation(overrides: Partial<HarnessObservation> = {}): HarnessObservation {
  return {
    observationId: "obs-1",
    generation: 1,
    activeWindowTitle: "Kitty — OC | Quick hello",
    screen: { width: 1920, height: 1080 },
    elements: [commandField()],
    ...overrides,
  }
}

function stub(overrides: { act?: HarnessAct; observe?: HarnessObserve }): {
  act: HarnessAct
  observe: HarnessObserve
} {
  return {
    act: overrides.act ?? (() => ({ ok: true })),
    observe: overrides.observe ?? (() => desktopObservation()),
  }
}

describe("assertVerifiedOnlyOnChange", () => {
  test("passes an honest not_verified report", () => {
    const result = assertVerifiedOnlyOnChange("not_verified", false)
    expect(result.outcome).toBe("pass")
  })

  test("passes a verified claim the observation backs", () => {
    expect(assertVerifiedOnlyOnChange("verified", true).outcome).toBe("pass")
  })

  test("fails a verified claim with no observed change", () => {
    const result = assertVerifiedOnlyOnChange("verified", false)
    expect(result.outcome).toBe("fail")
    expect(result.detail).toContain("no change")
  })
})

describe("HonestVerifyTrial", () => {
  test("a change-free action reported not_verified passes", async () => {
    const results = await new HonestVerifyTrial({
      ...LINUX_X11,
      ...stub({ act: () => ({ ok: true, claimed: "not_verified", detail: "The value was already correct." }) }),
    }).run()
    expect(results.map((result) => result.outcome)).toEqual(["pass", "pass"])
    expect(results[0]?.name).toBe(HONEST_VERIFY_TRIAL_NAME)
    expect(results[1]?.name).toBe(HONEST_VERIFY_FOCUS_NAME)
    expect(results[0]?.evidence).toMatchObject({ scenario: "set-value to the current value", value: "current value" })
  })

  test("the false-Verified bug: a change-free action reported verified fails", async () => {
    const results = await new HonestVerifyTrial({
      ...LINUX_X11,
      ...stub({ act: () => ({ ok: true, claimed: "verified" }) }),
    }).run()
    expect(results.map((result) => result.outcome)).toEqual(["fail", "fail"])
    expect(results[0]?.detail).toContain("claimed verified")
  })

  test("a tool that reports nothing at all cannot claim verified", async () => {
    // An undefined response means the action produced no report, which reads as
    // not_verified rather than as a pass.
    const results = await new HonestVerifyTrial({ ...LINUX_X11, ...stub({ act: () => undefined }) }).run()
    expect(results.map((result) => result.outcome)).toEqual(["pass", "pass"])
  })

  test("a verified claim backed by an observed change passes both scenarios", async () => {
    // The observation order is: before, after the change-free set-value (the
    // value is what it was, so no change), after the probe focus (the control
    // now reports focused, which is a change).
    const observations = [
      desktopObservation(),
      desktopObservation({ observationId: "obs-2", generation: 2 }),
      desktopObservation({ observationId: "obs-3", generation: 3, elements: [commandField({ states: ["focused"] })] }),
    ]
    let calls = 0
    const results = await new HonestVerifyTrial({
      ...LINUX_X11,
      act: (request) => ({ ok: true, claimed: request.kind === "focus" ? "verified" : "not_verified" }),
      observe: () => {
        const observation = observations[Math.min(calls, observations.length - 1)] ?? desktopObservation()
        calls += 1
        return observation
      },
    }).run()
    expect(results.map((result) => result.outcome)).toEqual(["pass", "pass"])
    expect(results[1]?.evidence).toMatchObject({ scenario: "focus the control" })
  })

  test("a control that vanished from the post-observation cannot verify", async () => {
    let calls = 0
    const results = await new HonestVerifyTrial({
      ...LINUX_X11,
      act: () => ({ ok: true, claimed: "verified" }),
      observe: () => {
        calls += 1
        return calls === 1 ? desktopObservation() : desktopObservation({ elements: [] })
      },
    }).run()
    expect(results.map((result) => result.outcome)).toEqual(["fail", "fail"])
  })

  test("a control with no observable value skips the change-free scenario only", async () => {
    const results = await new HonestVerifyTrial({
      ...LINUX_X11,
      ...stub({
        observe: () => desktopObservation({ elements: [commandField({ value: undefined })] }),
        act: () => ({ ok: true, claimed: "not_verified" }),
      }),
    }).run()
    expect(results.map((result) => result.outcome)).toEqual(["skipped", "pass"])
    expect(results[0]?.detail).toContain("no value")
  })

  test("a control absent from the observation skips the whole trial", async () => {
    const results = await new HonestVerifyTrial({
      ...LINUX_X11,
      ...stub({ observe: () => desktopObservation({ elements: [] }) }),
    }).run()
    expect(results.map((result) => result.outcome)).toEqual(["skipped"])
    expect(results[0]?.detail).toContain(HONEST_VERIFY_CONTROL_NAME)
  })

  test("non-Linux host skips without calling act or observe", async () => {
    let called = 0
    const results = await new HonestVerifyTrial({
      platform: "win32",
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
    expect(results.map((result) => result.outcome)).toEqual(["skipped"])
    expect(results[0]?.detail).toContain("win32")
    expect(called).toBe(0)
  })

  test("a throwing observe produces an error trial, not a crash", async () => {
    const results = await new HonestVerifyTrial({
      ...LINUX_X11,
      act: () => ({ ok: true }),
      observe: () => {
        throw new Error("observation unavailable")
      },
    }).run()
    expect(results.map((result) => result.outcome)).toEqual(["error"])
    expect(results[0]?.detail).toContain("observation unavailable")
    expect(results[0]?.name).toBe(HONEST_VERIFY_TRIAL_NAME)
  })

  test("the change-free act is asked for the value the control already holds", async () => {
    const requests: string[] = []
    const results = await new HonestVerifyTrial({
      ...LINUX_X11,
      act: (request) => {
        requests.push(`${request.kind}:${request.value ?? ""}`)
        return { ok: true, claimed: "not_verified" }
      },
      observe: () => desktopObservation(),
    }).run()
    expect(results.map((result) => result.outcome)).toEqual(["pass", "pass"])
    expect(requests).toEqual(["set-value:current value", "focus:"])
  })
})
