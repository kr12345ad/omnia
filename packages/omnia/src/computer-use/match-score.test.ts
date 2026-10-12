import { describe, expect, test } from "bun:test"
import { clearScoreCache, MATCH_THRESHOLD, scoreMatch } from "./match-score"

describe("match-score cache", () => {
  test("returns identical scores on repeat calls", () => {
    clearScoreCache()
    const first = scoreMatch("Export", { name: "Export button", role: "button" })
    const second = scoreMatch("Export", { name: "Export button", role: "button" })
    expect(second).toBe(first)
    expect(first).toBeGreaterThanOrEqual(MATCH_THRESHOLD)
  })

  test("clearScoreCache resets without changing results", () => {
    const before = scoreMatch("Save", { name: "Save", role: "menuitem" })
    clearScoreCache()
    expect(scoreMatch("Save", { name: "Save", role: "menuitem" })).toBe(before)
  })

  test("distinct candidates do not collide", () => {
    clearScoreCache()
    const hit = scoreMatch("Command", { name: "Command line", role: "textfield" })
    const miss = scoreMatch("Command", { name: "Comfort settings", role: "textfield" })
    expect(hit).toBeGreaterThanOrEqual(MATCH_THRESHOLD)
    expect(miss).toBe(0)
  })

  test("cache is bounded", () => {
    clearScoreCache()
    for (let i = 0; i < 3000; i += 1) scoreMatch(`query-${i}`, { name: `name-${i}` })
    // Still correct after eviction pressure.
    expect(scoreMatch("Export", { name: "Export button", role: "button" })).toBeGreaterThanOrEqual(MATCH_THRESHOLD)
  })
})
