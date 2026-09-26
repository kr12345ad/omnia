import { describe, expect, test } from "bun:test"
import { MemoryPolicyError, MemoryStore, isVisible, type MemoryPolicy } from "./memory"

const policy: MemoryPolicy = {
  scopes: ["run", "session"],
  minConfidence: 0.4,
  maxItems: 3,
  maxAgeMs: 1_000,
  allowSensitive: false,
  allowSecrets: false,
  maxSensitivity: "internal",
}

describe("memory policy", () => {
  test("enforces scope, confidence, and sensitivity", () => {
    const store = new MemoryStore(policy, () => 100)
    store.write({ key: "goal", value: "ship", scope: "run", sensitivity: "internal", confidence: 0.8 })
    expect(store.get("run", "goal")?.value).toBe("ship")
    expect(() =>
      store.write({ key: "global", value: "no", scope: "global", sensitivity: "internal", confidence: 0.8 }),
    ).toThrow(MemoryPolicyError)
    expect(() =>
      store.write({ key: "secret", value: "no", scope: "run", sensitivity: "secret", confidence: 0.8 }),
    ).toThrow(MemoryPolicyError)
    expect(() =>
      store.write({ key: "low", value: "no", scope: "run", sensitivity: "internal", confidence: 0.2 }),
    ).toThrow(MemoryPolicyError)
  })

  test("hides expired and stale values", () => {
    let now = 100
    const store = new MemoryStore(policy, () => now)
    store.write({
      key: "temporary",
      value: { ok: true },
      scope: "session",
      sensitivity: "internal",
      confidence: 0.9,
      expiresAt: 200,
    })
    expect(store.get("session", "temporary")).toBeDefined()
    now = 200
    expect(store.get("session", "temporary")).toBeUndefined()
    now = 1_101
    expect(store.snapshot()).toEqual([])
  })

  test("returns immutable values and records", () => {
    const store = new MemoryStore(policy, () => 100)
    const value = { nested: { count: 1 } }
    const record = store.write({ key: "immutable", value, scope: "run", sensitivity: "internal", confidence: 0.9 })
    value.nested.count = 2
    expect(record.value).toEqual({ nested: { count: 1 } })
    expect(Object.isFrozen(record)).toBe(true)
    expect(Object.isFrozen(record.value)).toBe(true)
    expect(Object.isFrozen(store.snapshot())).toBe(true)
  })

  test("enforces item limits after removing expired records", () => {
    let now = 100
    const store = new MemoryStore({ ...policy, maxItems: 1, maxAgeMs: undefined }, () => now)
    store.write({ key: "old", value: 1, scope: "run", sensitivity: "internal", confidence: 0.9, expiresAt: 150 })
    now = 160
    store.write({ key: "new", value: 2, scope: "run", sensitivity: "internal", confidence: 0.9 })
    expect(store.list("run").map((item) => item.key)).toEqual(["new"])
  })

  test("visibility policy is deterministic", () => {
    const now = 100
    const record = {
      id: "memory-1",
      key: "key",
      value: "value",
      scope: "run" as const,
      sensitivity: "internal" as const,
      confidence: 0.5,
      createdAt: 90,
      updatedAt: 90,
      tags: [],
    }
    expect(isVisible(record, policy, now)).toBe(true)
    expect(isVisible({ ...record, expiresAt: now }, policy, now)).toBe(false)
  })
})
