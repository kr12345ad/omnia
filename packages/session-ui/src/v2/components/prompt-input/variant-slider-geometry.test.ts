import { describe, expect, test } from "bun:test"
import { promptInputV2VariantPosition, promptInputV2VariantStop } from "./variant-slider-geometry"

describe("the effort slider", () => {
  test("lands on the nearest named stop as the pointer travels", () => {
    // Three stops: Default, Fast, Thinking.
    expect([0, 0.2, 0.24].map((at) => promptInputV2VariantStop(at, 3))).toEqual([0, 0, 0])
    expect([0.3, 0.5, 0.7].map((at) => promptInputV2VariantStop(at, 3))).toEqual([1, 1, 1])
    expect([0.8, 1].map((at) => promptInputV2VariantStop(at, 3))).toEqual([2, 2])
  })

  test("adds a stop for every level the model exposes", () => {
    expect([0, 0.5, 1].map((at) => promptInputV2VariantStop(at, 2))).toEqual([0, 1, 1])
    expect([0, 0.25, 0.5, 0.75, 1].map((at) => promptInputV2VariantStop(at, 5))).toEqual([0, 1, 2, 3, 4])
  })

  test("clamps a pointer that leaves the rail and survives a single level", () => {
    expect(promptInputV2VariantStop(-3, 4)).toBe(0)
    expect(promptInputV2VariantStop(9, 4)).toBe(3)
    expect(promptInputV2VariantStop(0.5, 1)).toBe(0)
  })

  test("reads the rail from the edge the text starts on", () => {
    const rail = { left: 100, width: 200 }
    expect(promptInputV2VariantPosition(100, rail, false)).toBe(0)
    expect(promptInputV2VariantPosition(200, rail, false)).toBe(0.5)
    expect(promptInputV2VariantPosition(300, rail, false)).toBe(1)
    expect(promptInputV2VariantPosition(200, rail, true)).toBe(0.5)
    expect(promptInputV2VariantPosition(100, rail, true)).toBe(1)
    expect(promptInputV2VariantPosition(300, rail, true)).toBe(0)
  })

  test("never divides by a rail that has not been laid out", () => {
    expect(promptInputV2VariantPosition(12, { left: 0, width: 0 }, false)).toBe(0)
  })
})
