import { describe, expect, test } from "bun:test"
import { contextPressure, formatContextTokens } from "./context-meter-format"

describe("the composer context meter", () => {
  test("uses compact token notation", () => {
    expect([0, 7, 999, 1_000, 1_234, 9_900, 12_345, 999_999, 1_000_000, 1_250_000].map(formatContextTokens)).toEqual([
      "0",
      "7",
      "999",
      "1k",
      "1.2k",
      "9.9k",
      "12k",
      "1m",
      "1m",
      "1.3m",
    ])
  })

  test("colors the readout by context pressure", () => {
    expect(contextPressure(100, undefined)).toBe("normal")
    expect(contextPressure(100, 0)).toBe("normal")
    expect(contextPressure(599, 1_000)).toBe("normal")
    expect(contextPressure(600, 1_000)).toBe("warning")
    expect(contextPressure(850, 1_000)).toBe("warning")
    expect(contextPressure(851, 1_000)).toBe("danger")
    expect(contextPressure(2_000, 1_000)).toBe("danger")
  })
})
