import { describe, expect, it } from "bun:test"

import { stagedCliVersion } from "./utils"

describe("stagedCliVersion", () => {
  it("reports the client version as a 1.x release instead of the 0.0.0 preview", () => {
    // A 0.0.0-<channel>-<build> string sorts below 1.18.0, so Zen's free tier
    // refuses the engine; 1.19.4-next-1635 is the same byte length and a 1.x
    // prerelease, which the tier accepts.
    expect(stagedCliVersion("1.19.4", "0.0.0-next-16350")).toBe("1.19.4-next-1635")
  })

  it("never changes the byte length, so the binary can be patched in place", () => {
    const preview = "0.0.0-next-16350"
    expect(stagedCliVersion("1.19.4", preview)).toHaveLength(preview.length)
    expect(stagedCliVersion("1.20.0", preview)).toHaveLength(preview.length)
  })

  it("fails the build rather than shipping an unpatched engine", () => {
    expect(() => stagedCliVersion("1.19.4", "0.0.0-a")).toThrow(/Cannot fit client version 1.19.4/)
  })
})
