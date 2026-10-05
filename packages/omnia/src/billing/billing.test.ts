import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { createHmac } from "node:crypto"
import { PLANS, planFor, planTier, failsClosed, type Capability, type PlanId } from "./plans"
import {
  PINNED_STRIPE_API_VERSION,
  REFUNDED,
  StripeSignatureError,
  defersEntitlement,
  entitles,
  newOrderingLedger,
  parseStripeEvent,
  parseSignatureHeader,
  planForPrice,
  recordApplied,
  refundedSubscriptions,
  stripeApiVersion,
  stripeRequestHeaders,
  subscriptionFromEvent,
  superseded,
  verifyStripeSignature,
  type SubscriptionStatus,
} from "./stripe"
import {
  applySubscription,
  consume,
  currentDay,
  currentPeriod,
  decide,
  EMPTY_STATE,
  readBillingState,
  resolvePlan,
  writeBillingState,
  type BillingState,
} from "./store"
import { startOmniaServer } from "../server/server"

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

function liveSubscription(plan: PlanId, subscriptionId: string, profileId = "p1") {
  return {
    customerId: "cus_1",
    subscriptionId,
    status: "active" as SubscriptionStatus,
    plan,
    profileId,
    currentPeriodEnd: Date.now() + 86_400_000,
  }
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

  test("a second subscription is added, not swapped in", () => {
    const subscription = subscriptionFromEvent(event)!
    const first = applySubscription(EMPTY_STATE, subscription, "pro", "evt_1")
    const upgraded = applySubscription(first.state, { ...subscription, subscriptionId: "sub_2" }, "business", "evt_2")
    expect(upgraded.state.subscriptions).toHaveLength(2)
    expect(resolvePlan(upgraded.state, "230746284").id).toBe("business")
  })

  test("a late cancellation of the OLD subscription does not downgrade the customer", () => {
    // Stripe does not guarantee event ordering. The real sequence for an upgrade
    // is: sub_A created, sub_B created, then sub_A cancelled. Folding that last
    // event by profileId deleted sub_B and dropped a paying customer to free.
    const subscription = subscriptionFromEvent(event)!
    const first = applySubscription(EMPTY_STATE, subscription, "pro", "evt_1")
    const upgraded = applySubscription(first.state, { ...subscription, subscriptionId: "sub_2" }, "business", "evt_2")
    const lateCancellation = applySubscription(
      upgraded.state,
      { ...subscription, status: "canceled" },
      "pro",
      "evt_3",
    )
    expect(lateCancellation.state.subscriptions).toHaveLength(2)
    expect(resolvePlan(lateCancellation.state, "230746284").id).toBe("business")
  })

  test("the same subscription id is updated in place", () => {
    const subscription = subscriptionFromEvent(event)!
    const first = applySubscription(EMPTY_STATE, subscription, "pro", "evt_1")
    const canceled = applySubscription(first.state, { ...subscription, status: "canceled" }, "pro", "evt_2")
    expect(canceled.state.subscriptions).toHaveLength(1)
    expect(canceled.state.subscriptions[0]?.status).toBe("canceled")
    expect(resolvePlan(canceled.state, "230746284").id).toBe("free")
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

  test("every allowance states its metering period, and only free browser work is daily", () => {
    // The period is data, not a comment, so the matrix can be checked: this is the
    // whole of the daily surface. Everything else is drawn monthly.
    const daily = (Object.keys(PLANS) as PlanId[]).flatMap((id) =>
      (Object.keys(PLANS[id].capabilities) as Capability[])
        .filter((capability) => PLANS[id].capabilities[capability].period === "day")
        .map((capability) => `${id}:${capability}`),
    )
    expect(daily).toEqual(["free:browser_automation"])
  })

  test("a paid browser allowance is still a monthly one", () => {
    // The period change was for the free daily budget only; a paid allowance is
    // billed monthly and must not refill every midnight.
    expect(PLANS.pro.capabilities.browser_automation).toMatchObject({ metering: "soft", limit: 2_000, period: "month" })
    expect(PLANS.pro.capabilities.vault_login.period).toBe("month")
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

  test("the most generous subscription wins on tier, not on price", () => {
    // Enterprise is priced at 0 because it is sold by hand. Ranking by monthlyUsd
    // resolved an enterprise subscriber sharing a profile with a pro one to PRO,
    // which is the whole reason the comparison is a tier index now.
    const priced = applySubscription(EMPTY_STATE, liveSubscription("pro", "sub_1"), "pro", "evt_1").state
    const both = applySubscription(priced, liveSubscription("enterprise", "sub_2"), "enterprise", "evt_2").state
    expect(resolvePlan(both, "p1").id).toBe("enterprise")
  })

  test("the tier ladder is total, and its rank does not read the price", () => {
    // Every shipped plan is ranked, free is the floor, and no two plans share a
    // rank: there is no tie for "most generous" to break by arrival order.
    const tiers = (Object.keys(PLANS) as PlanId[]).map((id) => planTier(PLANS[id]))
    expect(new Set(tiers).size).toBe(tiers.length)
    expect(Math.min(...tiers)).toBe(planTier(PLANS.free))
    expect(planTier(PLANS.enterprise)).toBeGreaterThan(planTier(PLANS.business))
    expect(planTier(PLANS.business)).toBeGreaterThan(planTier(PLANS.pro))
    // A discount cannot move a customer: business at a dollar still outranks pro.
    expect(planTier({ ...PLANS.business, monthlyUsd: 1 })).toBeGreaterThan(planTier(PLANS.pro))
    // ...and neither can a premium, which is the same statement the other way.
    expect(planTier({ ...PLANS.pro, monthlyUsd: 10_000 })).toBeLessThan(planTier(PLANS.business))
  })

  test("the resolved plan does not depend on the order events arrived in", () => {
    // Stripe does not guarantee ordering, so "most generous wins" has to be a max
    // over a total order rather than a running comparison against price.
    const pro = applySubscription(EMPTY_STATE, liveSubscription("pro", "sub_1"), "pro", "evt_1").state
    const business = applySubscription(pro, liveSubscription("business", "sub_2"), "business", "evt_2").state
    const reordered = applySubscription(
      applySubscription(EMPTY_STATE, liveSubscription("business", "sub_2"), "business", "evt_2").state,
      liveSubscription("pro", "sub_1"),
      "pro",
      "evt_1",
    ).state
    expect(resolvePlan(business, "p1").id).toBe("business")
    expect(resolvePlan(reordered, "p1").id).toBe("business")
    expect(resolvePlan({ ...business, subscriptions: [...business.subscriptions].reverse() }, "p1").id).toBe("business")
  })

  test("a lapsed or unknown plan never outranks a live one", () => {
    // free is tier 0 and is also the fallback, so a lapsed subscription cannot
    // displace anything and cannot widen access on its own.
    const live = applySubscription(EMPTY_STATE, liveSubscription("pro", "sub_1"), "pro", "evt_1").state
    const lapsed = {
      ...live,
      subscriptions: [
        ...live.subscriptions,
        { ...live.subscriptions[0]!, subscriptionId: "sub_old", plan: "enterprise" as const, currentPeriodEnd: 0 },
      ],
    }
    expect(resolvePlan(lapsed, "p1").id).toBe("pro")
  })
})

describe("metering periods", () => {
  const at = (iso: string) => Date.parse(iso)

  test("the daily counter resets at the next UTC midnight", () => {
    const lastSecond = at("2026-02-01T23:59:59Z")
    let state = EMPTY_STATE
    for (let i = 0; i < PLANS.free.capabilities.browser_automation.limit; i += 1) {
      state = consume(state, "p1", "browser_automation", { now: lastSecond })
    }
    expect(decide(state, "p1", "browser_automation", { now: lastSecond }).code).toBe("limit_reached")
    // The refusal names the budget it came out of, because it is back in a second.
    expect(decide(state, "p1", "browser_automation", { now: lastSecond }).reason).toContain("allowance today")

    const tomorrow = decide(state, "p1", "browser_automation", { now: lastSecond + 1_000 })
    expect(tomorrow.allowed).toBe(true)
    expect(tomorrow.code).toBe("granted")
    expect(tomorrow.used).toBe(0)
  })

  test("a daily spend is keyed on the day, and the elapsed key is dropped", () => {
    // 250/day replaces 250/month, so the key is a date rather than a month and the
    // file cannot accumulate one dead key per day forever.
    let state = consume(EMPTY_STATE, "p1", "browser_automation", { now: at("2026-02-01T10:00:00Z") })
    expect(Object.keys(state.usage.p1!.counters)).toEqual(["browser_automation:2026-02-01"])
    state = consume(state, "p1", "browser_automation", { now: at("2026-02-02T10:00:00Z") })
    expect(Object.keys(state.usage.p1!.counters)).toEqual(["browser_automation:2026-02-02"])
    expect(state.usage.p1!.counters["browser_automation:2026-02-02"]).toBe(1)
  })

  test("a spent monthly key does not refuse a daily allowance", () => {
    // The migration case: counters written under the old monthly key are simply
    // not this capability's counter any more. Reading them would keep denying for
    // a month; ignoring them can only ever be the more generous direction.
    const before = {
      ...EMPTY_STATE,
      usage: { p1: { counters: { "browser_automation:2026-01": 250 }, updatedAt: 0 } },
    }
    expect(decide(before, "p1", "browser_automation", { now: at("2026-02-01T12:00:00Z") }).allowed).toBe(true)
    expect(currentDay(at("2026-02-01T12:00:00Z"))).toBe("2026-02-01")
    expect(currentPeriod(at("2026-02-01T12:00:00Z"))).toBe("2026-02")
  })

test("a genuinely monthly allowance does not refill on a day boundary", () => {
    // vault_login is 3 for the billing period, not 3 a day. Spent in January, so
    // every day boundary crossed inside January has to stay refused - only the
    // month rolling over gives the budget back.
    let state = EMPTY_STATE
    for (let i = 0; i < PLANS.free.capabilities.vault_login.limit; i += 1) {
      state = consume(state, "p1", "vault_login", { now: at("2026-01-15T00:00:00Z") })
    }
    expect(Object.keys(state.usage.p1!.counters)).toEqual(["vault_login:2026-01"])
    expect(decide(state, "p1", "vault_login", { now: at("2026-01-16T00:00:00Z")}).allowed).toBe(false)
    expect(decide(state, "p1", "vault_login", { now: at("2026-01-31T23:59:59Z")}).allowed).toBe(false)
    expect(decide(state, "p1", "vault_login", { now: at("2026-01-31T23:59:59Z")}).used).toBe(3)
    // ...and it does come back when the month rolls over.
    const february = decide(state, "p1", "vault_login", { now: at("2026-02-01T00:00:00Z") })
    expect(february.allowed).toBe(true)
    expect(february.used).toBe(0)
    // The counter is spent, not deleted: the month it belongs to is still on disk
    // until the next spend in that profile prunes it.
    expect(Object.keys(state.usage.p1!.counters)).toEqual(["vault_login:2026-01"])
  })

  test("a paid monthly allowance survives the day boundary", () => {
    const subscribed = applySubscription(EMPTY_STATE, liveSubscription("pro", "sub_1"), "pro", "evt_1").state
    let state = subscribed
    for (let i = 0; i < PLANS.pro.capabilities.browser_automation.limit; i += 1) {
      state = consume(state, "p1", "browser_automation", { now: at("2026-02-01T10:00:00Z") })
    }
    // Soft, so it still works - but a new day must not hand the allowance back.
    const nextDay = decide(state, "p1", "browser_automation", { now: at("2026-02-02T10:00:00Z") })
    expect(nextDay.code).toBe("limit_reached")
    expect(nextDay.used).toBe(PLANS.pro.capabilities.browser_automation.limit)
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

  test("a monthly allowance is counted per calendar month", () => {
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

  test("the dead session counter is gone from the record", () => {
    // Nothing ever read or wrote sessionSeconds, and the free session ceiling is
    // enforced from the live session's own clock in remote/entitlement.ts. A file
    // written before the field went must not resurrect it into the record.
    const file = tempFile()
    writeFileSync(
      file,
      JSON.stringify({
        usage: { p1: { counters: {}, sessionSeconds: { "remote_computer:99999999": 99_999_999 }, updatedAt: 1 } },
      }),
      { mode: 0o600 },
    )
    const state = readBillingState(file)
    expect(Object.hasOwn(state.usage.p1!, "sessionSeconds")).toBe(false)
    // The ceiling itself is a plan value, and still exactly where it was.
    expect(PLANS.free.capabilities.remote_computer.sessionMinutes).toBe(120)
  })
})


// ---- the three gaps the audit found -------------------------------------------------
//
// 1. No Stripe API version was pinned, and `current_period_end` moved from the
//    subscription object to `items.data[]` on 2025-03-31.basil, so on an upgraded
//    account every event would have been silently ignored with a 200.
// 2. `event.created` was parsed and never used, so an older event delivered after
//    a newer one could undo a cancellation.
// 3. `charge.refunded` and `invoice.payment_failed` were not handled at all, so a
//    refunded customer kept their plan indefinitely.

describe("the pinned stripe api version", () => {
  let saved: string | undefined

  beforeEach(() => {
    saved = process.env.STRIPE_API_VERSION
    delete process.env.STRIPE_API_VERSION
  })

  afterEach(() => {
    if (saved === undefined) delete process.env.STRIPE_API_VERSION
    else process.env.STRIPE_API_VERSION = saved
  })

  test("defaults to a dated pin, not to a moving account default", () => {
    expect(PINNED_STRIPE_API_VERSION).toBe("2024-10-28.acacia")
    expect(PINNED_STRIPE_API_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.[a-z]+$/)
    expect(stripeApiVersion()).toBe(PINNED_STRIPE_API_VERSION)
  })

  test("an operator override is honoured", () => {
    // The pin is a compatibility decision, not a policy: moving to basil is a
    // one-line config change now that the period end is read from both places.
    process.env.STRIPE_API_VERSION = "2025-03-31.basil"
    expect(stripeApiVersion()).toBe("2025-03-31.basil")
    expect(stripeRequestHeaders()["Stripe-Version"]).toBe("2025-03-31.basil")
  })

  test("an unusable override falls back to the pin instead of reaching the header", () => {
    // A malformed value becomes an outbound header, so a stray newline or comma
    // would be a malformed request at best and a header injection at worst.
    for (const bad of [
      "",
      "   ",
      "latest",
      "not a version",
      "2025-03-31.basil\r\nX-Omnia-Admin: 1",
      "2025-03-31.basil, 2024-10-28.acacia",
    ]) {
      process.env.STRIPE_API_VERSION = bad
      expect(`${JSON.stringify(bad)} -> ${stripeApiVersion()}`).toBe(
        `${JSON.stringify(bad)} -> ${PINNED_STRIPE_API_VERSION}`,
      )
    }
  })

  test("no call site can drop or replace the version header", () => {
    expect(stripeRequestHeaders({ "Stripe-Version": "0.0.0", authorization: "Bearer x" })).toEqual({
      "Stripe-Version": PINNED_STRIPE_API_VERSION,
      authorization: "Bearer x",
    })
  })
})

describe("the period end after the basil move", () => {
  const subscription = (object: Record<string, unknown>) => ({
    id: "evt_items",
    type: "customer.subscription.updated",
    created: 1_700_000_000,
    data: {
      object: {
        id: "sub_items",
        customer: "cus_items",
        status: "active",
        metadata: { profileId: "230746284" },
        ...object,
      },
    },
  })

  test("reads it from items.data[] when the subscription object no longer has it", () => {
    // The exact shape since 2025-03-31.basil: no top-level current_period_end, so
    // the previous code discarded this event and answered {ok:true,ignored:true}.
    const folded = subscriptionFromEvent(subscription({ items: { data: [{ id: "si_1", current_period_end: 1_800_000_000 }] } }))
    expect(folded?.currentPeriodEnd).toBe(1_800_000_000_000)
  })

  test("the subscription-level value still wins, which is what the pin guarantees", () => {
    const folded = subscriptionFromEvent(
      subscription({ current_period_end: 1_700_000_000, items: { data: [{ current_period_end: 1_800_000_000 }] } }),
    )
    expect(folded?.currentPeriodEnd).toBe(1_700_000_000_000)
  })

  test("the latest item period wins when items are on different cycles", () => {
    const folded = subscriptionFromEvent(
      subscription({
        items: {
          data: [
            { id: "si_monthly", current_period_end: 1_800_000_000 },
            { id: "si_yearly", current_period_end: 1_900_000_000 },
          ],
        },
      }),
    )
    expect(folded?.currentPeriodEnd).toBe(1_900_000_000_000)
  })

  test("an event with no readable period end anywhere is discarded", () => {
    for (const object of [
      { items: "nope" },
      { items: {} },
      // A string where the period end belongs is not a number, so there is no
      // period to read at all.
      { current_period_end: "soon" },
      {},
    ]) {
      expect(subscriptionFromEvent(subscription(object))).toBeUndefined()
    }
  })

  test("an items array with no usable period end folds to 0, which cannot entitle anybody", () => {
    // basil puts the period end on the items, so an event that HAS items but no
    // usable end on them is a real subscription with an unreadable end - not an
    // event to throw away. It folds with currentPeriodEnd 0, and 0 is the one
    // value resolvePlan refuses, so an unparseable end can never be read as
    // "paid through". The refusal is load-bearing, so it is asserted end to end
    // rather than as a shape check on the fold.
    for (const object of [
      { items: { data: [] } },
      { items: { data: [{ id: "si_1" }] } },
      { items: { data: [{ current_period_end: "soon" }] } },
    ]) {
      const folded = subscriptionFromEvent(subscription(object))
      expect(folded?.currentPeriodEnd).toBe(0)
      const state = applySubscription(EMPTY_STATE, folded!, "pro", "evt_unusable_period").state
      // Any clock at all: there is no future this record can reach.
      expect(resolvePlan(state, "230746284", 1_800_000_000_000).id).toBe("free")
      expect(resolvePlan(state, "230746284", 0).id).toBe("free")
    }
  })
})

describe("event ordering", () => {
  test("an event older than the one already applied is refused", () => {
    const ledger = newOrderingLedger()
    recordApplied(ledger, "sub_1", 2_000)
    expect(superseded(ledger, "sub_1", 1_999)).toBe(true)
    expect(superseded(ledger, "sub_1", 2_000)).toBe(false)
    expect(superseded(ledger, "sub_1", 2_001)).toBe(false)
  })

  test("a different subscription is never affected, however old it is", () => {
    // The upgrade path: sub_B goes live, then the cancellation of sub_A arrives
    // late. Sharing one watermark per profile would swallow that cancellation and
    // leave a cancelled subscription live.
    const ledger = newOrderingLedger()
    recordApplied(ledger, "sub_b", 2_000)
    expect(superseded(ledger, "sub_a", 1_000)).toBe(false)
    expect(superseded(ledger, "sub_a", 2_000)).toBe(false)
  })

  test("an event with no usable timestamp is applied rather than guessed at", () => {
    // parseStripeEvent reports a missing `created` as 0. Dropping those would
    // throw away real cancellations, and `created: 0` must never move a watermark
    // either - it is not evidence of anything.
    const ledger = newOrderingLedger()
    recordApplied(ledger, "sub_1", 2_000)
    recordApplied(ledger, "sub_2", 0)
    expect(superseded(ledger, "sub_1", 0)).toBe(false)
    expect(superseded(ledger, "sub_2", 1_000)).toBe(false)
    recordApplied(ledger, "sub_2", 1_500)
    expect(superseded(ledger, "sub_2", 1_499)).toBe(true)
  })

  test("the ledger cannot be grown without bound by remote input", () => {
    const ledger = newOrderingLedger()
    for (let i = 0; i < 5_001; i += 1) recordApplied(ledger, `sub_${i}`, i + 1)
    expect(ledger.applied.size).toBe(5_000)
  })

  test("a late older event cannot undo a newer cancellation", () => {
    const subscription = subscriptionFromEvent({
      id: "evt_1",
      type: "customer.subscription.updated",
      created: 2_000,
      data: {
        object: {
          id: "sub_ordered",
          customer: "cus_ordered",
          status: "active",
          current_period_end: 1_800_000_000,
          metadata: { profileId: "230746284" },
        },
      },
    })!
    const ledger = newOrderingLedger()
    recordApplied(ledger, subscription.subscriptionId, 2_000)
    const canceled = applySubscription(EMPTY_STATE, { ...subscription, status: "canceled" }, "pro", "evt_cancel")
    recordApplied(ledger, subscription.subscriptionId, 2_500)
    expect(resolvePlan(canceled.state, "230746284").id).toBe("free")
    // The pre-cancellation update, re-delivered late.
    expect(superseded(ledger, subscription.subscriptionId, 2_000)).toBe(true)
  })
})

describe("refunds and failed payments", () => {
  const held = [
    { customerId: "cus_1", subscriptionId: "sub_1" },
    { customerId: "cus_2", subscriptionId: "sub_2" },
  ]
  const charge = (object: Record<string, unknown>) => ({
    id: "evt_refund",
    type: "charge.refunded",
    created: 2_000,
    data: { object: { id: "ch_1", customer: "cus_1", amount: 1500, ...object } },
  })

  test("a full refund takes the plan away from every subscription of that customer", () => {
    // A charge names a customer, never a subscription, so all of that customer's
    // subscriptions are revoked together. Guessing one would leave a refunded
    // customer on a plan they did not pay for.
    expect(refundedSubscriptions(charge({ refunded: true }), held).map((entry) => entry.subscriptionId)).toEqual(["sub_1"])
    expect(refundedSubscriptions(charge({ refunded: true, customer: "cus_2" }), held)).toHaveLength(1)
  })

  test("a partial refund does not revoke anything", () => {
    // Stripe fires charge.refunded for partial refunds too, with refunded: false.
    expect(refundedSubscriptions(charge({ refunded: false, amount_refunded: 500 }), held)).toEqual([])
    expect(refundedSubscriptions(charge({ amount_refunded: 1500 }), held)).toEqual([])
  })

  test("an unattributable refund changes nothing", () => {
    expect(refundedSubscriptions(charge({ refunded: true, customer: "cus_unknown" }), held)).toEqual([])
    expect(refundedSubscriptions(charge({ refunded: true, customer: undefined }), held)).toEqual([])
    expect(refundedSubscriptions(charge({ refunded: true }), [])).toEqual([])
    expect(refundedSubscriptions({ id: "evt_x", type: "charge.refunded", created: 1, data: null }, held)).toEqual([])
  })

  test("a refund can never be an upgrade: only charge.refunded means anything", () => {
    // Anything that is not a completed refund resolves to no subscriptions at all,
    // so no payload shape can be turned into an entitlement.
    for (const type of ["customer.subscription.updated", "charge.succeeded", "invoice.payment_failed", "charge.dispute.created"]) {
      expect(refundedSubscriptions({ ...charge({ refunded: true }), type }, held)).toEqual([])
    }
  })

  test("the refunded marker does not entitle, whatever the plan says", () => {
    const subscription = subscriptionFromEvent({
      id: "evt_1",
      type: "customer.subscription.updated",
      created: 1_000,
      data: {
        object: {
          id: "sub_refunded",
          customer: "cus_refunded",
          status: "active",
          current_period_end: 1_800_000_000,
          metadata: { profileId: "230746284" },
        },
      },
    })!
    const paid = applySubscription(EMPTY_STATE, subscription, "pro", "evt_paid")
    expect(resolvePlan(paid.state, "230746284").id).toBe("pro")
    const refunded = applySubscription(
      paid.state,
      { ...subscription, status: REFUNDED },
      "pro",
      "evt_refunded_paid",
    )
    // The plan is still recorded, and still worth nothing.
    expect(refunded.state.subscriptions[0]?.plan).toBe("pro")
    expect(entitles(REFUNDED)).toBe(false)
    expect(resolvePlan(refunded.state, "230746284").id).toBe("free")
    expect(decide(refunded.state, "230746284", "remote_shell").allowed).toBe(false)
  })

  test("a failed invoice payment is deferred to stripe's own status machine", () => {
    // Stripe retries the payment and only flips the subscription to `unpaid` when
    // it gives up, which is the event that actually revokes access.
    expect(defersEntitlement({ id: "evt_1", type: "invoice.payment_failed", created: 1, data: {} })).toBe(true)
    expect(defersEntitlement({ id: "evt_1", type: "invoice.paid", created: 1, data: {} })).toBe(false)
    expect(defersEntitlement({ id: "evt_1", type: "customer.subscription.updated", created: 1, data: {} })).toBe(false)
  })
})

// ---- the same three gaps, through the real HTTP webhook -------------------------------

describe("the webhook route end to end", () => {
  const WEBHOOK = "whsec_wire_test"
  const PRICE_PRO = "price_pro_wire"
  const realFetch = globalThis.fetch
  let dir = ""
  let saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omnia-billing-wire-"))
    dirs.push(dir)
    saved = {
      STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
      STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
      STRIPE_PRICE_PRO: process.env.STRIPE_PRICE_PRO,
      STRIPE_PRICE_BUSINESS: process.env.STRIPE_PRICE_BUSINESS,
      STRIPE_API_VERSION: process.env.STRIPE_API_VERSION,
      OMNIA_PUBLIC_URL: process.env.OMNIA_PUBLIC_URL,
      OMNIA_BILLING_FILE: process.env.OMNIA_BILLING_FILE,
    }
    process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK
    process.env.STRIPE_SECRET_KEY = "sk_test_fake"
    process.env.STRIPE_PRICE_PRO = PRICE_PRO
    delete process.env.STRIPE_PRICE_BUSINESS
    delete process.env.STRIPE_API_VERSION
    process.env.OMNIA_PUBLIC_URL = "https://example.test/omnia"
    process.env.OMNIA_BILLING_FILE = join(dir, "billing.json")
  })

  afterEach(() => {
    globalThis.fetch = realFetch
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  async function withServer<T>(fn: (server: { url: string; token: string }) => Promise<T>): Promise<T> {
    const server = await startOmniaServer({
      credentialsFile: join(dir, "credentials.json"),
      authFile: join(dir, "auth.json"),
      superskillFile: join(dir, "superskills.json"),
      memoryFile: join(dir, "memories.json"),
      computerUseFile: join(dir, "computer-use.json"),
    })
    try {
      return await fn(server)
    } finally {
      await server.stop()
    }
  }

  function signed(body: string, timestamp = Math.floor(Date.now() / 1000)): string {
    const digest = createHmac("sha256", WEBHOOK).update(`${timestamp}.${body}`, "utf8").digest("hex")
    return `t=${timestamp},v1=${digest}`
  }

  async function deliver(server: { url: string }, event: unknown) {
    const body = JSON.stringify(event)
    const response = await fetch(`${server.url}/v1/billing/stripe/webhook`, {
      method: "POST",
      headers: { "stripe-signature": signed(body) },
      body,
    })
    return { status: response.status, json: (await response.json()) as Record<string, unknown> }
  }

  const PROFILE = "230746284"
  // A subscription id per test, and that is not decoration. The webhook's ordering
  // watermarks are module scoped (billing-api.ts), so they outlive each test and
  // are keyed on the SUBSCRIPTION id: reusing one id across tests made a test's
  // first event look older than the previous test's last one, so it was answered
  // `stale` and never written. Each test now owns its subscription, so the
  // watermark it sees is the one it set.
  const subscriptionEvent = (
    subscriptionId: string,
    event: Record<string, unknown> = {},
    object: Record<string, unknown> = {},
  ) => ({
    id: "evt_wire_1",
    type: "customer.subscription.updated",
    created: 2_000,
    ...event,
    data: {
      object: {
        id: subscriptionId,
        customer: "cus_wire",
        status: "active",
        price: { id: PRICE_PRO },
        metadata: { profileId: PROFILE },
        // The basil shape: no top-level period end anywhere but items.data[].
        items: { data: [{ id: "si_wire", current_period_end: 2_000_000_000 }] },
        ...object,
      },
    },
  })

  const checkShell = async (server: { url: string; token: string }) => {
    const response = await fetch(`${server.url}/v1/billing/check`, {
      method: "POST",
      headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json", "x-omnia-profile": PROFILE },
      body: JSON.stringify({ capability: "remote_shell" }),
    })
    return (await response.json()) as { allowed: boolean; plan: string }
  }

  test("a basil-shaped event on the wire still grants the plan", async () => {
    await withServer(async (server) => {
      const delivered = await deliver(server, subscriptionEvent("sub_wire_basil"))
      expect(delivered.status).toBe(200)
      expect(delivered.json.ignored).toBeUndefined()
      expect(readBillingState(process.env.OMNIA_BILLING_FILE).subscriptions[0]?.plan).toBe("pro")
    })
  })

  test("an older event delivered after a newer one cannot undo it", async () => {
    await withServer(async (server) => {
      await deliver(server, subscriptionEvent("sub_wire_stale", {}, { status: "canceled" }))
      // Stripe re-delivers the pre-cancellation update, created 400s earlier.
      const late = await deliver(server, subscriptionEvent("sub_wire_stale", { id: "evt_wire_late", created: 1_600 }))
      expect(late.json.stale).toBe(true)
      const state = readBillingState(process.env.OMNIA_BILLING_FILE)
      expect(state.subscriptions).toHaveLength(1)
      expect(state.subscriptions[0]?.status).toBe("canceled")
    })
  })

  test("a refund downgrades the customer and an old event cannot give it back", async () => {
    await withServer(async (server) => {
      await deliver(server, subscriptionEvent("sub_wire_refund"))
      expect((await checkShell(server)).plan).toBe("pro")

      const refunded = await deliver(server, {
        id: "evt_wire_refund",
        type: "charge.refunded",
        created: 2_500,
        data: { object: { id: "ch_wire", customer: "cus_wire", amount: 1500, amount_refunded: 1500, refunded: true } },
      })
      expect(refunded.json.refunded).toEqual(["sub_wire_refund"])
      expect(readBillingState(process.env.OMNIA_BILLING_FILE).subscriptions[0]?.status).toBe(REFUNDED)
      expect(await checkShell(server)).toMatchObject({ allowed: false, plan: "free" })

      // A replayed older subscription event must not resurrect the refunded plan.
      const late = await deliver(server, subscriptionEvent("sub_wire_refund", { id: "evt_wire_2", created: 2_100 }))
      expect(late.json.stale).toBe(true)
      expect(await checkShell(server)).toMatchObject({ allowed: false, plan: "free" })
    })
  })

  test("a failed invoice payment does not instantly destroy access", async () => {
    await withServer(async (server) => {
      await deliver(server, subscriptionEvent("sub_wire_invoice"))
      const failed = await deliver(server, {
        id: "evt_wire_failed",
        type: "invoice.payment_failed",
        created: 2_500,
        data: { object: { id: "in_wire", customer: "cus_wire" } },
      })
      // Acknowledged so Stripe stops retrying an event we deliberately deferred...
      expect(failed.json.deferred).toBe(true)
      // ...and the subscription is untouched, because Stripe will retry the card.
      expect(readBillingState(process.env.OMNIA_BILLING_FILE).subscriptions[0]?.status).toBe("active")
      expect((await checkShell(server)).plan).toBe("pro")
      // And when Stripe does give up, `unpaid` revokes as it always did.
      await deliver(server, subscriptionEvent("sub_wire_invoice", { id: "evt_wire_unpaid", created: 3_000 }, { status: "unpaid" }))
      expect(await checkShell(server)).toMatchObject({ allowed: false, plan: "free" })
    })
  })

  test("both outbound stripe calls send the pinned version header", async () => {
    const sent: (string | null)[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (!url.startsWith("https://api.stripe.com/")) return realFetch(input as RequestInfo, init)
      sent.push(new Headers(init.headers).get("Stripe-Version"))
      const target = url.includes("checkout") ? "checkout.stripe.com/c/pay/cs_wire" : "billing.stripe.com/p/session_wire"
      return new Response(JSON.stringify({ url: `https://${target}` }), { status: 200 })
    }) as typeof fetch

    await withServer(async (server) => {
      const headers = {
        authorization: `Bearer ${server.token}`,
        "content-type": "application/json",
        "x-omnia-profile": PROFILE,
      }
      const checkout = await fetch(`${server.url}/v1/billing/checkout`, {
        method: "POST",
        headers,
        body: JSON.stringify({ plan: "pro" }),
      })
      expect(checkout.status).toBe(200)
      // The portal needs a subscription to exist before it will make the call.
      writeBillingState(process.env.OMNIA_BILLING_FILE!, {
        ...EMPTY_STATE,
        subscriptions: [
          {
            customerId: "cus_wire",
            subscriptionId: "sub_wire",
            status: "active",
            plan: "pro",
            profileId: PROFILE,
            currentPeriodEnd: 2_000_000_000_000,
          },
        ],
      })
      const portal = await fetch(`${server.url}/v1/billing/portal`, { method: "POST", headers, body: "{}" })
      expect(portal.status).toBe(200)
    })
    // Checkout AND portal, both carrying the pin that keeps the payload shape.
    expect(sent).toEqual([PINNED_STRIPE_API_VERSION, PINNED_STRIPE_API_VERSION])
  })

  test("an operator override is what actually goes on the wire", async () => {
    process.env.STRIPE_API_VERSION = "2025-03-31.basil"
    const sent: (string | null)[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (!url.startsWith("https://api.stripe.com/")) return realFetch(input as RequestInfo, init)
      sent.push(new Headers(init.headers).get("Stripe-Version"))
      return new Response(JSON.stringify({ url: "https://checkout.stripe.com/c/pay/cs_wire" }), { status: 200 })
    }) as typeof fetch
    await withServer(async (server) => {
      const response = await fetch(`${server.url}/v1/billing/checkout`, {
        method: "POST",
        headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json", "x-omnia-profile": PROFILE },
        body: JSON.stringify({ plan: "pro" }),
      })
      expect(response.status).toBe(200)
    })
    expect(sent).toEqual(["2025-03-31.basil"])
  })
})

describe("state bounds", () => {
  test("processed event ids are capped, newest kept", () => {
    let state = EMPTY_STATE
    for (let i = 1; i <= 1005; i += 1) {
      state = applySubscription(state, liveSubscription("pro", `sub_${i}`), "pro", `evt_${i}`).state
    }
    expect(state.processedEvents).toHaveLength(1000)
    // 1005 folded, 1000 kept: the oldest five (evt_1..evt_5) fell off the back.
    expect(state.processedEvents[0]).toBe("evt_6")
    expect(state.processedEvents.at(-1)).toBe("evt_1005")
    // An evicted id is forgotten, and is therefore re-appliable. That is the cost
    // of a count-based bound, stated rather than hidden: reaching it needs 1000
    // further events folded into this file inside the 300s signature tolerance,
    // which is the arithmetic in MAX_PROCESSED_EVENTS.
    expect(applySubscription(state, liveSubscription("pro", "sub_1005"), "pro", "evt_5").duplicate).toBe(false)
    // The oldest SURVIVING id is still caught, so the window is a window and not
    // a cliff.
    expect(applySubscription(state, liveSubscription("pro", "sub_1005"), "pro", "evt_6").duplicate).toBe(true)
  })

  test("a read trims an oversized event list and an oversized subscription list", () => {
    const file = tempFile()
    writeFileSync(
      file,
      JSON.stringify({
        subscriptions: Array.from({ length: 5001 }, (_, i) => ({
          customerId: "cus_1",
          subscriptionId: `sub_${i}`,
          status: "active",
          plan: "pro",
          profileId: `p${i}`,
          currentPeriodEnd: 1_900_000_000_000,
        })),
        processedEvents: Array.from({ length: 1200 }, (_, i) => `evt_${i}`),
      }),
      { mode: 0o600 },
    )
    const state = readBillingState(file)
    // Read keeps the OLDEST 5000 and drops the newest; folding keeps the newest.
    // See MAX_SUBSCRIPTIONS: the parse stops at the cap, so the file is read in
    // order, and the next fold trims it back from the other end.
    expect(state.subscriptions).toHaveLength(5000)
    expect(state.subscriptions[0]?.subscriptionId).toBe("sub_0")
    expect(state.subscriptions.at(-1)?.subscriptionId).toBe("sub_4999")
    expect(state.processedEvents).toHaveLength(1000)
    expect(state.processedEvents[0]).toBe("evt_200")
  })

  test("the subscription cap keeps the record just applied", () => {
    // Trimming from the front dropped the event being folded whenever the cap bit,
    // so a paid upgrade past 5000 subscriptions silently did not land.
    const existing = Array.from({ length: 5000 }, (_, i) => ({
      customerId: "cus_1",
      subscriptionId: `sub_${i}`,
      status: "active" as SubscriptionStatus,
      plan: "pro" as const,
      profileId: `p${i}`,
      currentPeriodEnd: Date.now() + 86_400_000,
    }))
    const state = applySubscription({ ...EMPTY_STATE, subscriptions: existing }, liveSubscription("business", "sub_new"), "business", "evt_1").state
    expect(state.subscriptions).toHaveLength(5000)
    expect(state.subscriptions.at(-1)?.subscriptionId).toBe("sub_new")
    expect(resolvePlan(state, "p1").id).toBe("business")
  })
})
