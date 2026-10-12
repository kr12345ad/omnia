import { describe, expect, test } from "bun:test"
import { computerDiffFallsBack, diffComputerElements, type ComputerDiffElement } from "./snapshot-diff"

const CAP = 120000

/** One realistic control: the fields the AT-SPI helper emits, Control 3 a text box. */
function control(index: number, overrides: ComputerDiffElement = {}): ComputerDiffElement {
  const role = index === 3 ? "textfield" : index % 4 === 0 ? "button" : index % 4 === 2 ? "checkbox" : "label"
  return {
    id: `atspi:${index}`,
    role,
    name: `Control ${index}`,
    text: `row ${Math.floor(index / 20)} of the synthetic desktop`,
    ...(role === "textfield" ? { value: `typed value ${index}` } : {}),
    description: `control number ${index} of the synthetic desktop`,
    states: ["enabled"],
    actions: role === "label" ? [] : ["focus", "click"],
    bounds: { x: 10 + (index % 20) * 60, y: 60 + Math.floor(index / 20) * 32, width: 120, height: 24 },
    metadata: { application: "code" },
    ...overrides,
  }
}

function desktop(count: number): ComputerDiffElement[] {
  return [
    {
      id: "win-editor",
      role: "window",
      name: "Quick hello — editor",
      states: ["focused"],
      bounds: { x: 40, y: 60, width: 1200, height: 800 },
      metadata: { application: "code" },
    },
    ...Array.from({ length: count }, (_, index) => control(index)),
  ]
}

function edit(
  baseline: readonly ComputerDiffElement[],
  id: string,
  changes: ComputerDiffElement | ((element: ComputerDiffElement) => ComputerDiffElement),
) {
  return baseline.map((element) => {
    if (element.id !== id) return element
    return typeof changes === "function" ? changes(element) : { ...element, ...changes }
  })
}

/** Shift one control 24px right: the move the latency harness measures. */
const MOVED = (element: ComputerDiffElement): ComputerDiffElement => ({
  ...element,
  bounds: {
    x: element.bounds!.x + 24,
    y: element.bounds!.y,
    width: element.bounds!.width,
    height: element.bounds!.height,
  },
})

/** The three per-step edits the latency harness measures: a rename, a move, a focus change. */
function withThreeChanges(baseline: readonly ComputerDiffElement[]): ComputerDiffElement[] {
  return baseline.map((element) => {
    if (element.id === "atspi:3") return { ...element, value: "typed value 3 (edited)" }
    if (element.id === "atspi:7") return MOVED(element)
    if (element.id === "atspi:11") return { ...element, states: ["enabled", "focused"] }
    return element
  })
}

describe("computer_snapshot diff projection", () => {
  test("reports no changes when both trees are identical", () => {
    const baseline = desktop(8)
    const diff = diffComputerElements(baseline, baseline)
    expect(diff.controls).toEqual([])
    expect(diff.windows).toEqual([])
    expect(diff.unchangedCount).toBe(8)
  })

  test("labels a bounds change as moved and counts the rest as unchanged", () => {
    const baseline = desktop(8)
    const diff = diffComputerElements(baseline, edit(baseline, "atspi:7", MOVED))
    expect(diff.controls.map((entry) => entry.element.id)).toEqual(["atspi:7"])
    expect(diff.controls[0]?.change).toBe("moved")
    expect(diff.windows).toEqual([])
    expect(diff.unchangedCount).toBe(7)
  })

  test("a moved control keeps the moved label even when its content changed too", () => {
    const baseline = desktop(4)
    const diff = diffComputerElements(
      baseline,
      edit(baseline, "atspi:3", { value: "edited", bounds: { x: 500, y: 60, width: 120, height: 24 } }),
    )
    expect(diff.controls).toHaveLength(1)
    expect(diff.controls[0]?.change).toBe("moved")
  })

  test("labels a value change as state-changed", () => {
    const baseline = desktop(8)
    const diff = diffComputerElements(baseline, edit(baseline, "atspi:3", { value: "typed value 3 (edited)" }))
    expect(diff.controls.map((entry) => entry.element.id)).toEqual(["atspi:3"])
    expect(diff.controls[0]?.change).toBe("state-changed")
    expect(diff.controls[0]?.element).toMatchObject({ value: "typed value 3 (edited)" })
    expect(diff.unchangedCount).toBe(7)
  })

  test("labels a state change as state-changed", () => {
    const baseline = desktop(12)
    const diff = diffComputerElements(baseline, edit(baseline, "atspi:11", { states: ["enabled", "focused"] }))
    expect(diff.controls.map((entry) => entry.element.id)).toEqual(["atspi:11"])
    expect(diff.controls[0]?.change).toBe("state-changed")
    expect(diff.controls[0]?.element).toMatchObject({ states: ["enabled", "focused"] })
    expect(diff.unchangedCount).toBe(11)
  })

  test("labels a control only in the current tree as added and one only in the baseline as removed", () => {
    const baseline = desktop(4)
    const current = baseline.filter((element) => element.id !== "atspi:2")
    const diff = diffComputerElements(baseline, [...current, control(99)])
    expect(diff.controls.map((entry) => [entry.change, entry.element.id])).toEqual([
      ["added", "atspi:99"],
      ["removed", "atspi:2"],
    ])
    expect(diff.unchangedCount).toBe(3)
    expect(diff.windows).toEqual([])
  })

  test("keys an element with no ref by its role occurrence", () => {
    const anonymous = (index: number, overrides: ComputerDiffElement = {}): ComputerDiffElement =>
      control(index, { id: undefined, ref: undefined, ...overrides })
    const baseline = [anonymous(0), anonymous(1), anonymous(2)]
    const current = baseline.map((element, index) => (index === 1 ? { ...element, name: "renamed" } : element))
    const diff = diffComputerElements(baseline, current)
    expect(diff.controls).toHaveLength(1)
    expect(diff.controls[0]?.element).toMatchObject({ name: "renamed" })
    expect(diff.unchangedCount).toBe(2)
  })

  test("separates windows from controls and never counts them as unchanged", () => {
    const baseline = desktop(4)
    const diff = diffComputerElements(baseline, edit(baseline, "win-editor", { name: "Quick hello — editor (edited)" }))
    expect(diff.controls).toEqual([])
    expect(diff.windows.map((entry) => [entry.change, entry.element.id])).toEqual([["state-changed", "win-editor"]])
    expect(diff.unchangedCount).toBe(4)
  })

  test("an element that only gains bounds has moved", () => {
    const baseline = [control(0, { bounds: undefined })]
    const current = [control(0)]
    expect(diffComputerElements(baseline, current).controls[0]?.change).toBe("moved")
    expect(diffComputerElements(current, baseline).controls[0]?.change).toBe("moved")
  })

  test("diffing a 200-control desktop reports the three changed controls, not the desktop", () => {
    const baseline = desktop(200)
    const diff = diffComputerElements(baseline, withThreeChanges(baseline))
    expect(diff.controls.map((entry) => [entry.change, entry.element.id])).toEqual([
      ["state-changed", "atspi:3"],
      ["moved", "atspi:7"],
      ["state-changed", "atspi:11"],
    ])
    expect(diff.unchangedCount).toBe(197)
    expect(diff.windows).toEqual([])
  })
})

describe("computer_snapshot diff fallback", () => {
  test("a diff smaller than the full payload and inside the cap is delivered", () => {
    expect(computerDiffFallsBack({ diffChars: 141, fullChars: 147436, cap: CAP })).toBe(false)
  })

  test("a diff over the char cap falls back", () => {
    expect(computerDiffFallsBack({ diffChars: CAP + 1, fullChars: CAP + 1000, cap: CAP })).toBe(true)
  })

  test("a diff larger than a full payload falls back", () => {
    expect(computerDiffFallsBack({ diffChars: 83419, fullChars: 83418, cap: CAP })).toBe(true)
  })

  test("the boundaries themselves are still delivered", () => {
    expect(computerDiffFallsBack({ diffChars: CAP, fullChars: CAP, cap: CAP })).toBe(false)
    expect(computerDiffFallsBack({ diffChars: 0, fullChars: 0, cap: CAP })).toBe(false)
  })
})
