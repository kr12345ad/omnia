import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { createHmac } from "node:crypto"
import { PLANS, planFor, failsClosed, type Capability } from "./plans"
import {
  StripeSignatureError,
  entitles,
  parseStripeEvent,
  parseSignatureHeader,
  planForPrice,
  subscriptionFromEvent,
  verifyStripeSignature,
} from "./stripe"
import {
  applySubscription,
  consume,
  currentPeriod,
  decide,
  EMPTY_STATE,
  readBillingState,
  resolvePlan,
  writeBillingState,
} from "./store"

const SECRET = "whsec_test_secret"
const dirs: string[] = []

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "omnia-billing-"))
  dirs.push(dir)
  return join(dir, "billing.json")
}

function sign(body: string, timestamp: number, secret = SECRET): string {
  const digest = createHmac("sha256", secret).update(`${timestamp}.${body}`, "utf8").digest("hex")
  return `t=${timestamp},v1=${digest}`
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    // Best effort: a leftover temp dir must never fail a test run.
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // A leftover temp dir must never fail the run.
    }
  }
})

describe("stripe signature verification", () => {
  test("accepts a correctly signed body", () => {
    const body = JSON.stringify({ id: "evt_1", type: "checkout.session.completed" })
    const now = 1_700_000_000
    expect(verifyStripeSignature(body, sign(body, now), SECRET, { nowSeconds: now }).timestamp).toBe(now)
  })

  test("rejects a tampered body", () => {
    const now = 1_700_000_000
    const header = sign(JSON.stringify({ id: "evt_1" }), now)
    expect(() => verifyStripeSignature(JSON.stringify({ id: "evt_2" }), header, SECRET, { nowSeconds: now })).toThrow(
      StripeSignatureError,
    )
  })

  test("rejects the wrong secret", () => {
    const body = "{}"
    const now = 1_700_000_000
    expect(() => verifyStripeSignature(body, sign(body, now, "whsec_other"), SECRET, { nowSeconds: now })).toThrow(
      StripeSignatureError,
    )
  })

  test("rejects a replayed event outside the tolerance window", () => {
    const body = "{}"
    const stale = 1_700_000_000
    // Correctly signed, but five minutes too old to accept.
    expect(() =>
      verifyStripeSignature(body, sign(body, stale), SECRET, { nowSeconds: stale + 301 }),
    ).toThrow(/tolerance/)
  })

  test("rejects a missing, empty or signature-less header", () => {
    for (const header of [undefined, null, "", "v1=abc", "t=123", "garbage"]) {
      expect(() => verifyStripeSignature("{}", header, SECRET)).toThrow(StripeSignatureError)
    }
  })

  test("refuses to verify with no configured secret", () => {
    expect(() => verifyStripeSignature("{}", "t=1,v1=aa", "")).toThrow(/no webhook secret/)
  })

  test("tolerates extra schemes and surrounding whitespace", () => {
    const body = "{}"
    const now = 1_700_000_000
    const digest = createHmac("sha256", SECRET).update(`${now}.${body}`, "utf8").digest("hex")
    const header = `t=${now}, v0=ignored, v1=${digest} ,v1=alsowrong`
    expect(() => verifyStripeSignature(body, header, SECRET, { nowSeconds: now })).not.toThrow()
  })

  test("parses multiple v1 values without collapsing them", () => {
    expect(parseSignatureHeader("t=5,v1=aa,v1=bb").signatures).toEqual(["aa", "bb"])
  })
})

describe("stripe event parsing", () => {
  test("rejects non-JSON and non-objects", () => {
    for (const body of ["", "null", "[]", '"x"', "{"]) {
      expect(() => parseStripeEvent(body)).toThrow(StripeSignatureError)
    }
  })

  test("requires an id and a type", () => {
    expect(() => parseStripeEvent(JSON.stringify({ type: "x" }))).toThrow(/id/)
    expect(() => parseStripeEvent(JSON.stringify({ id: "evt_1" }))).toThrow(/type/)
  })
})

describe("subscription folding", () => {
  const event = {
    id: "evt_1",
    type: "customer.subscription.updated",
    created: 0,
    data: {
      object: {
        id: "sub_1",
        customer: "cus_1",
        status: "active",
        current_period_end: 1_800_000_000,
        metadata: { profileId: "230746284" },
      },
    },
  }

  test("reads a well formed subscription", () => {
    const subscription = subscriptionFromEvent(event)
    expect(subscription?.profileId).toBe("230746284")
    expect(subscription?.status).toBe("active")
  })

  test("ignores an unexpected payload rather than upgrading anybody", () => {
    // A missing customer, a missing profile or a non-numeric period end must
    // discard the event entirely rather than half-apply it.
    for (const object of [
      { ...event.data.object, customer: undefined },
      { ...event.data.object, metadata: {} },
      { ...event.data.object, current_period_end: "soon" },
    ]) {
      expect(subscriptionFromEvent({ ...event, data: { object } })).toBeUndefined()
    }
  })

  test("an unrecognised status folds to incomplete rather than granting access", () => {
    const folded = subscriptionFromEvent({ ...event, data: { object: { ...event.data.object, status: "wat" } } })
    expect(folded?.status).toBe("incomplete")
    expect(entitles(folded?.status ?? "incomplete")).toBe(false)
  })

  test("an unknown status never entitles", () => {
    expect(entitles("incomplete")).toBe(false)
    expect(entitles("canceled")).toBe(false)
    expect(entitles("unpaid")).toBe(false)
    expect(entitles("active")).toBe(true)
    expect(entitles("trialing")).toBe(true)
    expect(entitles("past_due")).toBe(true)
  })

  test("an unmapped price id grants nothing", () => {
    expect(planForPrice("price_unknown", { price_pro: "pro" })).toBeUndefined()
    expect(planForPrice("price_pro", { price_pro: "pro" })).toBe("pro")
  })

  test("a replayed event id is a no-op", () => {
    const subscription = subscriptionFromEvent(event)!
    const first = applySubscription(EMPTY_STATE, subscription, "pro", "evt_1")
    expect(first.changed).toBe(true)
    const second = applySubscription(first.state, subscription, "pro", "evt_1")
    expect(second.duplicate).toBe(true)
    expect(second.state.subscriptions).toHaveLength(1)
  })

  test("a newer subscription replaces the profile's old one", () => {
    const subscription = subscriptionFromEvent(event)!
    const first = applySubscription(EMPTY_STATE, subscription, "pro", "evt_1")
    const upgraded = applySubscription(first.state, { ...subscription, subscriptionId: "sub_2" }, "business", "evt_2")
    expect(upgraded.state.subscriptions).toHaveLength(1)
    expect(resolvePlan(upgraded.state, "230746284").id).toBe("business")
  })

  test("a lapsed period does not entitle", () => {
    const subscription = subscriptionFromEvent(event)!
    const applied = applySubscription(EMPTY_STATE, subscription, "pro", "evt_1")
    expect(resolvePlan(applied.state, "230746284", 1_900_000_000_000).id).toBe("free")
  })

  test("an unknown profile stays free", () => {
    expect(resolvePlan(EMPTY_STATE, undefined).id).toBe("free")
    expect(resolvePlan(EMPTY_STATE, "nobody").id).toBe("free")
  })
})

describe("plan resolution", () => {
  test("the free tier matches the agreed limits", () => {
    expect(PLANS.free.computers).toBe(3)
    expect(PLANS.free.capabilities.vault_login.limit).toBe(3)
    expect(PLANS.free.capabilities.remote_computer.sessionMinutes).toBe(120)
    expect(PLANS.free.capabilities.browser_automation.limit).toBe(250)
    // Free includes remote control; the shell, the clipboard and unattended runs
    // do not come with it.
    expect(PLANS.free.capabilities.remote_shell.limit).toBe(0)
    expect(PLANS.free.capabilities.clipboard.limit).toBe(0)
    expect(PLANS.free.capabilities.scheduled_runs.limit).toBe(0)
  })

  test("an unknown plan id degrades to free", () => {
    expect(planFor("platinum").id).toBe("free")
    expect(planFor(undefined).id).toBe("free")
    expect(planFor({}).id).toBe("free")
  })

  test("no plan is more expensive than the one above it", () => {
    expect(PLANS.pro.monthlyUsd).toBeGreaterThan(PLANS.free.monthlyUsd)
    expect(PLANS.business.monthlyUsd).toBeGreaterThan(PLANS.pro.monthlyUsd)
    const caps = Object.keys(PLANS.free.capabilities) as Capability[]
    for (const capability of caps) {
      expect(PLANS.enterprise.capabilities[capability].limit).toBeGreaterThanOrEqual(
        PLANS.business.capabilities[capability].limit,
      )
    }
  })

})

describe("decisions", () => {
  test("free may use a local computer but not the remote shell", () => {
    expect(decide(EMPTY_STATE, undefined, "local_computer").allowed).toBe(true)
    const shell = decide(EMPTY_STATE, undefined, "remote_shell")
    expect(shell.allowed).toBe(false)
    expect(shell.code).toBe("not_entitled")
  })

  test("a spent hard limit is refused", () => {
    let state = EMPTY_STATE
    for (let i = 0; i < 3; i += 1) state = consume(state, "p1", "vault_login")
    const denied = decide(state, "p1", "vault_login")
    expect(denied.allowed).toBe(false)
    expect(denied.used).toBe(3)
    expect(denied.limit).toBe(3)
  })

  test("a spent soft limit still works and says why", () => {
    // subagents is SOFT(2) on free: past the allowance it degrades, it does not break.
    let state = consume(consume(consume(EMPTY_STATE, "p1", "subagents"), "p1", "subagents"), "p1", "subagents")
    const decision = decide(state, "p1", "subagents")
    expect(decision.allowed).toBe(true)
    expect(decision.code).toBe("limit_reached")
    expect(decision.metering).toBe("soft")
    expect(decision.reason).toMatch(/fair-use/)
  })

  test("an unreadable store refuses a hard-metered capability and allows a soft one", () => {
    // vault_login is hard-metered, so unknown usage must not become free usage.
    expect(decide(EMPTY_STATE, "p1", "vault_login", { storeReadable: false }).code).toBe("unknown")
    expect(decide(EMPTY_STATE, "p1", "browser_automation", { storeReadable: false }).code).toBe("unknown")
    // A capability the plan does not include is refused either way.
    expect(decide(EMPTY_STATE, "p1", "remote_shell", { storeReadable: false }).code).toBe("not_entitled")
    // Soft-metered and free capabilities keep working through an outage.
    expect(decide(EMPTY_STATE, "p1", "local_computer", { storeReadable: false }).allowed).toBe(true)
    expect(decide(EMPTY_STATE, "p1", "subagents", { storeReadable: false }).allowed).toBe(true)
  })

  test("fail-closed tracks hard metering, not plan inclusion", () => {
    expect(failsClosed("vault_login")).toBe(true)
    expect(failsClosed("browser_automation")).toBe(true)
    expect(failsClosed("local_computer")).toBe(false)
    expect(failsClosed("subagents")).toBe(false)
  })

  test("usage is counted per calendar month", () => {
    const january = consume(EMPTY_STATE, "p1", "vault_login", { now: Date.parse("2026-01-15T00:00:00Z") })
    const february = decide(january, "p1", "vault_login", { now: Date.parse("2026-02-01T00:00:00Z") })
    expect(february.allowed).toBe(true)
    expect(currentPeriod(Date.parse("2026-02-01T00:00:00Z"))).toBe("2026-02")
  })

  test("a pro subscriber is not stopped by the free allowance", () => {
    const subscription = {
      customerId: "cus_1",
      subscriptionId: "sub_1",
      status: "active" as const,
      profileId: "p1",
      currentPeriodEnd: Date.now() + 86_400_000,
    }
    let state = applySubscription(EMPTY_STATE, subscription, "pro", "evt_1").state
    for (let i = 0; i < 5; i += 1) state = consume(state, "p1", "vault_login")
    expect(decide(state, "p1", "remote_shell").allowed).toBe(true)
    expect(decide(state, "p1", "vault_login").code).toBe("granted")
  })

  test("consuming without a profile changes nothing", () => {
    expect(consume(EMPTY_STATE, undefined, "vault_login")).toBe(EMPTY_STATE)
  })
})

describe("persistence", () => {
  test("round trips and is owner-only", () => {
    const file = tempFile()
    const state = consume(applySubscription(EMPTY_STATE, {
      customerId: "cus_1",
      subscriptionId: "sub_1",
      status: "active",
      profileId: "p1",
      currentPeriodEnd: 0,
    }, "pro", "evt_1").state, "p1", "vault_login")
    writeBillingState(file, state)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readBillingState(file).subscriptions[0]?.plan).toBe("pro")
    expect(readBillingState(file).usage.p1).toBeDefined()
  })

  test("a corrupt file is quarantined, not silently emptied", () => {
    const file = tempFile()
    writeFileSync(file, "{not json", { mode: 0o600 })
    expect(readBillingState(file)).toEqual(EMPTY_STATE)
    // The original bytes are moved aside, not deleted and not overwritten.
    expect(existsSync(file)).toBe(false)
    const quarantined = readdirSync(dirname(file)).filter((name) => name.includes(".corrupt."))
    expect(quarantined).toHaveLength(1)
    expect(readFileSync(join(dirname(file), quarantined[0]!), "utf8")).toBe("{not json")
  })

  test("valid JSON that is not a record is also quarantined", () => {
    const file = tempFile()
    writeFileSync(file, "null", { mode: 0o600 })
    expect(readBillingState(file)).toEqual(EMPTY_STATE)
  })

  test("refuses to write through a symlink", () => {
    const dir = mkdtempSync(join(tmpdir(), "omnia-billing-"))
    dirs.push(dir)
    const target = join(dir, "real.json")
    const link = join(dir, "billing.json")
    writeFileSync(target, "{}", { mode: 0o600 })
    symlinkSync(target, link)
    expect(() => writeBillingState(link, EMPTY_STATE)).toThrow(/symlink/)
  })

  test("a missing file reads as empty", () => {
    expect(readBillingState(join(tempFile(), "nope.json"))).toEqual(EMPTY_STATE)
  })

  test("junk entries are dropped rather than trusted", () => {
    const file = tempFile()
    writeFileSync(
      file,
      JSON.stringify({
        subscriptions: [{ customerId: 1 }, { customerId: "c", subscriptionId: "s", status: "active", profileId: "p", currentPeriodEnd: 0 }],
        usage: { p1: { counters: { "vault_login:2026-01": -5 }, sessionSeconds: {} } },
        processedEvents: ["evt_1", 7],
      }),
      { mode: 0o600 },
    )
    const state = readBillingState(file)
    expect(state.subscriptions).toHaveLength(1)
    expect(state.usage.p1?.counters["vault_login:2026-01"]).toBe(0)
    expect(state.processedEvents).toEqual(["evt_1"])
  })
})