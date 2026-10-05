import { describe, expect, test } from "bun:test"
import { EMPTY_STATE, decide, readBillingState } from "./store"
import { failsClosed } from "./plans"
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// The regression that mattered: a paying customer lost paid features because
// the fail-closed rule was evaluated against the FREE plan.
describe("failure policy follows the plan the customer is on", () => {
  test("free hard-metered capabilities are refused when the store is unreadable", () => {
    expect(failsClosed("vault_login", "free")).toBe(true)
    expect(failsClosed("browser_automation", "free")).toBe(true)
    expect(decide(EMPTY_STATE, "p", "vault_login", { storeReadable: false }).code).toBe("unknown")
  })

  test("a PAID plan keeps its features through our own outage", () => {
    // Pro meters the vault softly, so an unreadable store must not take it away.
    expect(failsClosed("vault_login", "pro")).toBe(false)
    expect(failsClosed("browser_automation", "pro")).toBe(false)
    expect(failsClosed("cloud_vision", "pro")).toBe(false)
  })

  test("a subscription with an unknown period end does not entitle forever", () => {
    const state = {
      ...EMPTY_STATE,
      subscriptions: [
        {
          customerId: "c",
          subscriptionId: "s",
          status: "active" as const,
          plan: "business" as const,
          profileId: "p",
          currentPeriodEnd: 0,
        },
      ],
    }
    const decision = decide(state, "p", "remote_shell", { now: 1_800_000_000_000 })
    expect(decision.plan).toBe("free")
    expect(decision.allowed).toBe(false)
  })
})

describe("state file hardening", () => {
  test("a symlink at the billing path is not followed on read", () => {
    const dir = mkdtempSync(join(tmpdir(), "omnia-link-"))
    const target = join(dir, "attacker.json")
    writeFileSync(
      target,
      JSON.stringify({
        subscriptions: [
          { customerId: "c", subscriptionId: "s", status: "active", plan: "enterprise", profileId: "p", currentPeriodEnd: 9e15 },
        ],
      }),
      { mode: 0o600 },
    )
    const link = join(dir, "billing.json")
    symlinkSync(target, link)
    expect(readBillingState(link)).toEqual(EMPTY_STATE)
  })

  test("a prototype-shaped profile id is dropped", () => {
    const dir = mkdtempSync(join(tmpdir(), "omnia-proto-"))
    const file = join(dir, "billing.json")
    writeFileSync(
      file,
      JSON.stringify({ usage: { __proto__: { counters: { "vault_login:2026-01": 999 } } } }),
      { mode: 0o600 },
    )
    const state = readBillingState(file)
    expect(Object.keys(state.usage)).toHaveLength(0)
    expect(decide(state, "__proto__", "vault_login").used).toBe(0)
  })
})
