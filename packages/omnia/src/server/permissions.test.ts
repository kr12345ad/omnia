import { describe, expect, test } from "bun:test"
import { PermissionManager } from "./permissions"

describe("autonomous permission boundaries", () => {
  test("autonomy alone cannot execute processes or release secrets", () => {
    const manager = new PermissionManager({ SECRETS: "prompt" }, "fully_autonomous")
    for (const required of [["PROCESS_EXECUTE"], ["SECRETS"], ["UI_CONTROL", "PROCESS_EXECUTE"]] as const) {
      const result = manager.evaluate(required)
      expect(result.allowed).toBe(false)
      expect(result.status).toBe("permission_required")
      expect(result.missing.length).toBeGreaterThan(0)
    }
    expect(manager.evaluate(["UI_CONTROL"]).allowed).toBe(true)
  })

  test("explicit scope approval works, but cannot lift a denied scope", () => {
    const manager = new PermissionManager({}, "fully_autonomous")
    expect(manager.evaluate(["PROCESS_EXECUTE"], { approval: { approved: true, scopes: ["PROCESS_EXECUTE"] } }).allowed).toBe(true)
    expect(manager.evaluate(["SECRETS"], { approval: { approved: true, scopes: ["SECRETS"] } }).allowed).toBe(false)
    expect(manager.evaluate(["PROCESS_EXECUTE"], { approval: { approved: true, scopes: ["UI_CONTROL"] } }).allowed).toBe(false)
  })
})
