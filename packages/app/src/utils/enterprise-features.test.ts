import { describe, expect, test } from "bun:test"
import { managedFeatureGranted } from "./enterprise-features"

describe("managedFeatureGranted", () => {
  test("withholds a surface the admin never switched on", () => {
    expect(managedFeatureGranted({ chatChannels: false }, "chatChannels")).toBe(false)
    expect(managedFeatureGranted({}, "chatChannels")).toBe(false)
  })

  test("withholds everything while the policy has not resolved", () => {
    expect(managedFeatureGranted(undefined, "chatChannels")).toBe(false)
  })

  test("allows an explicitly enabled surface", () => {
    expect(managedFeatureGranted({ chatChannels: true }, "chatChannels")).toBe(true)
  })
})
