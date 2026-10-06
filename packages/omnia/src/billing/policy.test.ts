import { afterEach, describe, expect, test } from "bun:test"
import { EMPTY_STATE, decide, readBillingState } from "./store"
import { failsClosed } from "./plans"
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// The regression that mattered: a paying customer lost paid features because
// the fail-closed rule was evaluated against the FREE plan.
describe("failure policy follows the plan the customer is on", () => {
  test("free hard-metered capabilities are refused when the store is unreadable", () => {
    for (const capability of ["vault_login", "browser_automation", "credential_vault", "live_view"] as const) {
      expect(failsClosed(capability, "free")).toBe(true)
      expect(decide(EMPTY_STATE, "p", capability, { storeReadable: false })).toMatchObject({
        allowed: false,
        code: "unknown",
        plan: "free",
      })
    }
  })

  test("unlimited free basics remain granted when the store is unreadable", () => {
    for (const capability of ["local_computer", "remote_computer", "input_freeze", "clipboard", "subagents"] as const) {
      expect(failsClosed(capability, "free")).toBe(false)
      expect(decide(EMPTY_STATE, "p", capability, { storeReadable: false })).toMatchObject({
        allowed: true,
        code: "granted",
        plan: "free",
        limit: Number.POSITIVE_INFINITY,
      })
    }
  })

  test("a PAID plan keeps its features through our own outage", () => {
    const now = Date.parse("2026-03-17T12:00:00Z")
    const state = {
      ...EMPTY_STATE,
      subscriptions: [
        {
          customerId: "c",
          subscriptionId: "s",
          status: "active" as const,
          plan: "pro" as const,
          profileId: "p",
          currentPeriodEnd: now + 86_400_000,
        },
      ],
    }
    for (const capability of ["vault_login", "browser_automation", "credential_vault", "cloud_vision", "live_view", "subagents"] as const) {
      expect(failsClosed(capability, "pro")).toBe(false)
      expect(decide(state, "p", capability, { now, storeReadable: false })).toMatchObject({
        allowed: true,
        code: "granted",
        plan: "pro",
      })
    }
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
    dirs.push(dir)
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
    dirs.push(dir)
    const file = join(dir, "billing.json")
    writeFileSync(
      file,
      // Computed keys are own JSON properties; a literal __proto__ would only
      // change the fixture's prototype and never exercise the parser's guard.
      JSON.stringify({
        usage: {
          ["__proto__"]: { counters: { "vault_login:2026-01": 999 } },
          constructor: { counters: { "vault_login:2026-01": 999 } },
          prototype: { counters: { "vault_login:2026-01": 999 } },
          p: { counters: { "vault_login:2026-01": 1 } },
        },
      }),
      { mode: 0o600 },
    )
    const state = readBillingState(file)
    expect(Object.keys(state.usage)).toEqual(["p"])
    for (const profile of ["__proto__", "constructor", "prototype"]) {
      expect(decide(state, profile, "vault_login", { now: Date.parse("2026-01-15T00:00:00Z") }).used).toBe(0)
    }
    expect(decide(state, "p", "vault_login", { now: Date.parse("2026-01-15T00:00:00Z") }).used).toBe(1)
  })
})
