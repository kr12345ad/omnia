import { describe, expect, test } from "bun:test"
import { iconSpriteMarkup } from "./icon"

const symbolOf = (name: string) => {
  const match = iconSpriteMarkup().match(new RegExp(`<symbol id="opencode-icon-${name}"[\\s\\S]*?</symbol>`))
  return match?.[0] ?? ""
}

describe("icon sprite", () => {
  test("ships Google's four-color mark on its own 18 grid", () => {
    const google = symbolOf("google")
    expect(google).toContain('viewBox="0 0 18 18"')
    expect(google.match(/<path /g)).toHaveLength(4)
    for (const color of ["#4285F4", "#34A853", "#FBBC05", "#EA4335"]) expect(google).toContain(color)
  })

  test("keeps the Google mark independent of the icon color", () => {
    expect(symbolOf("google")).not.toContain("currentColor")
  })
})
