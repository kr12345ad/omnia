import { describe, expect, test } from "bun:test"
import { contextWindowPercent, contextWindowTokens, promptTokens } from "../src/session/usage"

const tokens = (input: number, output: number, reasoning: number, read: number, write: number) => ({
  input,
  output,
  reasoning,
  cache: { read, write },
})

describe("session context usage", () => {
  test("counts cached tokens as part of the prompt", () => {
    // `input` is the uncached delta. A cached 190k-token conversation reports a
    // tiny input, so reading it alone under-reports the window.
    expect(promptTokens(tokens(10_000, 500, 0, 170_000, 10_000))).toBe(190_000)
  })

  test("includes visible output and excludes reasoning", () => {
    expect(contextWindowTokens(tokens(300, 100, 900, 25, 25))).toBe(450)
  })

  test("clamps a full window instead of reporting more than 100%", () => {
    expect(contextWindowPercent(tokens(990, 30, 0, 0, 0), 1000)).toBe(100)
  })

  test("a missing or unusable limit is unknown, never zero percent", () => {
    expect(contextWindowPercent(tokens(10, 10, 0, 0, 0), undefined)).toBeUndefined()
    expect(contextWindowPercent(tokens(10, 10, 0, 0, 0), 0)).toBeUndefined()
    expect(contextWindowPercent(tokens(10, 10, 0, 0, 0), Number.NaN)).toBeUndefined()
  })
})
