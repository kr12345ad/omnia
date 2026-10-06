// Reading an entitlement is not the same act as consuming one.
//
// The route used to do both unconditionally, so the app's OWN reads were billed
// to the customer: the composer mounts, asks `cloud_vision` with no image
// attached, and a paying Pro customer loses one of their 2000 monthly vision
// units every time a window opens. The "used" number the UI then shows them is
// inflated by our polling rather than by their use. That is the app metering its
// own meter, and it is not defensible to charge somebody for the app looking at
// its own state.
//
// So `POST /v1/billing/check` now takes an explicit `consume: false`, and this
// file pins the properties that make the split safe rather than merely
// available:
//
//   1. A READ SPENDS NOTHING. Many reads in a row leave the counter untouched -
//      which is the whole point, because the caller that motivated this polls.
//   2. A BARE POST STILL SPENDS. The default is unchanged, so every existing
//      enforcement call site keeps metering without being edited. The safety
//      argument lives entirely in this direction: charge-by-default means a gate
//      that never learned about the parameter cannot under-meter a paid
//      capability, where charge-only-when-asked would hand one away silently.
//   3. THE READ FORM IS NOT REACHABLE BY ACCIDENT. `consume` must be exactly the
//      boolean `false`. `"false"`, `0`, `null` and a missing field all spend,
//      because a typo on a display path must not quietly grant free use.
//   4. A READ ANSWERS THE SAME QUESTION A DECISION DOES. A read of a SPENT
//      allowance still reports the refusal - it just does not spend further to
//      report it. A read that answered `granted` over a spent allowance would be
//      the same bug running the other way.
//
// Nothing here restates a limit from plans.ts. Every assertion is about whether
// a COUNTER MOVED, read back out of the real on-disk state the real route wrote,
// so a change that stopped spending - or stopped refusing - fails here rather
// than in production.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startOmniaServer } from "./server"
import {
  EMPTY_STATE,
  applySubscription,
  check,
  currentDay,
  currentPeriod,
  readBillingState,
  writeBillingState,
  type BillingState,
} from "../billing/store"
import { PLANS, type Capability, type PlanId } from "../billing/plans"

type Server = Awaited<ReturnType<typeof startOmniaServer>>

const PROFILE_ID = 230746284
const PROFILE = String(PROFILE_ID)
const PRICED_PLANS = ["pro", "business", "enterprise", "free"] as const

let dir = ""
let billingFile = ""
let previous: Record<string, string | undefined> = {}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnia-check-consume-"))
  billingFile = join(dir, "billing.json")
  previous = {
    OMNIA_BILLING_FILE: process.env.OMNIA_BILLING_FILE,
    OMNIA_DATA_DIR: process.env.OMNIA_DATA_DIR,
    OMNIA_SERVER_URL: process.env.OMNIA_SERVER_URL,
    OMNIA_SERVER_TOKEN: process.env.OMNIA_SERVER_TOKEN,
  }
  process.env.OMNIA_BILLING_FILE = billingFile
  delete process.env.OMNIA_DATA_DIR
  delete process.env.OMNIA_SERVER_URL
  delete process.env.OMNIA_SERVER_TOKEN
})

afterEach(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // A leftover temp dir must never fail the run.
  }
})

async function startServer(): Promise<Server> {
  return startOmniaServer({
    authFile: join(dir, "auth.json"),
    credentialsFile: join(dir, "credentials.json"),
    memoryFile: join(dir, "memories.json"),
    superskillFile: join(dir, "superskills.json"),
    pairingsFile: join(dir, "pairings.json"),
    computerUseFile: join(dir, "computer-use.json"),
  })
}

/** Puts the profile on a live subscription, through the real store. */
function subscribe(plan: PlanId): BillingState {
  const state = applySubscription(
    EMPTY_STATE,
    {
      customerId: `cus_${plan}`,
      subscriptionId: `sub_${plan}`,
      status: "active",
      profileId: PROFILE,
      currentPeriodEnd: Date.parse("2099-01-01T00:00:00Z"),
    },
    plan,
    `evt_check_consume_${plan}`,
  ).state
  writeBillingState(billingFile, state)
  return state
}

async function post(
  server: Server,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${server.url}/v1/billing/check`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${server.token}`,
      "content-type": "application/json",
      "x-omnia-profile": PROFILE,
    },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

/**
 * The counter the real route actually left on disk.
 *
 * Keyed on the rule's OWN period, so this is not a second opinion about what a
 * monthly allowance looks like: it reads the same key `decide` reads, computed
 * the same way, and defaults to 0 when the route wrote nothing at all.
 */
function spent(capability: Capability, plan: PlanId): number {
  const period = PLANS[plan].capabilities[capability].period
  const key = `${capability}:${period === "day" ? currentDay() : currentPeriod()}`
  return readBillingState(billingFile).usage[PROFILE]?.counters[key] ?? 0
}

/** Everything the route recorded for this profile, or undefined if nothing. */
function recorded(): Record<string, number> | undefined {
  return readBillingState(billingFile).usage[PROFILE]?.counters
}

const EVERY_CAPABILITY = Object.keys(PLANS.free.capabilities) as Capability[]

describe("POST /v1/billing/check: a read does not spend", () => {
  test("many reads of the same capability leave the counter at zero", async () => {
    // The audit's own scenario, as a route: a Pro customer's monthly vision
    // units, read over and over by a UI that wants to know what it may show.
    subscribe("pro")
    const server = await startServer()
    try {
      // Far more reads than this plan allows uses in a month. If a read spent,
      // the allowance would run out somewhere inside this loop.
      for (let mount = 0; mount < 50; mount += 1) {
        const answer = await post(server, { capability: "cloud_vision", consume: false })
        expect(`${mount} -> ${answer.status} ${answer.body.code} used=${answer.body.used}`).toBe(
          `${mount} -> 200 granted used=0`,
        )
        expect(answer.body.consumed).toBe(false)
        // The number the UI shows the customer is the real one: no reads added
        // to it, so it does not drift upward under them.
        expect(spent("cloud_vision", "pro")).toBe(0)
      }
      expect(recorded()).toBeUndefined()
    } finally {
      await server.stop()
    }
  })

  test("reads of every capability, on every plan, record nothing at all", async () => {
    // The broad version of the same claim, over the whole matrix, so a
    // capability added later is covered by the shape of the loop rather than by
    // a row somebody remembered to add.
    const server = await startServer()
    try {
      for (const plan of PRICED_PLANS) {
        subscribe(plan)
        for (const capability of EVERY_CAPABILITY) {
          const answer = await post(server, { capability, consume: false })
          // The decision itself is unchanged by whether it spends: an excluded
          // capability is still excluded, and an included one still allowed.
          expect(answer.body.consumed).toBe(false)
          expect(answer.body.allowed).toBe(capability in PLANS[plan].capabilities && PLANS[plan].capabilities[capability].limit > 0)
        }
        // Not one key, on any plan, for any capability.
        expect(`${plan} -> ${JSON.stringify(recorded())}`).toBe(`${plan} -> undefined`)
      }
    } finally {
      await server.stop()
    }
  })

  test("a read of a SPENT allowance reports the refusal and spends nothing further", async () => {
    // The property that makes a read safe to poll forever: it cannot push a
    // counter further, so a UI re-reading on every render can neither charge the
    // customer again nor manufacture their own refusal.
    subscribe("free")
    const server = await startServer()
    try {
      // Free allows three vault logins a month. Spend them the way a real gate
      // does, then read the refusal as often as a composer would.
      for (let login = 0; login < 3; login += 1) {
        expect((await post(server, { capability: "vault_login" })).status).toBe(200)
      }
      expect(spent("vault_login", "free")).toBe(3)
      for (let poll = 0; poll < 10; poll += 1) {
        const answer = await post(server, { capability: "vault_login", consume: false })
        // Still refused. A read that answered `granted` here would be the same
        // bug in the other direction: the enforcement answer, weakened.
        expect(`${poll} -> ${answer.status} ${answer.body.code} used=${answer.body.used}`).toBe(
          `${poll} -> 402 limit_reached used=3`,
        )
        expect(answer.body.allowed).toBe(false)
        expect(answer.body.consumed).toBe(false)
        expect(spent("vault_login", "free")).toBe(3)
      }
    } finally {
      await server.stop()
    }
  })
})

describe("POST /v1/billing/check: the default still spends", () => {
  test("a bare POST charges exactly one unit", async () => {
    subscribe("pro")
    const server = await startServer()
    try {
      const answer = await post(server, { capability: "cloud_vision" })
      expect(answer.status).toBe(200)
      expect(answer.body.consumed).toBe(true)
      expect(spent("cloud_vision", "pro")).toBe(1)
    } finally {
      await server.stop()
    }
  })

  test("the same gate, called the consuming way, spends exactly one unit per call", async () => {
    // THE enforcement invariant. A read is only safe BECAUSE the gate is still
    // charged, so this asserts the charge survived the split: N consuming calls
    // cost N - not N-1, and not 1 however many arrive.
    subscribe("free")
    const server = await startServer()
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const answer = await post(server, { capability: "vault_login" })
        expect(`attempt ${attempt} -> ${answer.status} consumed=${answer.body.consumed}`).toBe(
          `attempt ${attempt} -> 200 consumed=true`,
        )
        // One per action. Never zero (a free capability) and never two (a
        // double charge, which is the other way to lose a paying customer).
        expect(spent("vault_login", "free")).toBe(attempt + 1)
      }
      // And the allowance the plan actually defines is still the ceiling.
      expect((await post(server, { capability: "vault_login" })).status).toBe(402)
      expect(spent("vault_login", "free")).toBe(3)
    } finally {
      await server.stop()
    }
  })

  test("reads and consuming calls interleave without either losing its meaning", async () => {
    // The pattern a real screen produces: a panel reading constantly while the
    // user acts occasionally. Each body is labelled with what it must cost.
    subscribe("free")
    const server = await startServer()
    try {
      const traffic: readonly (readonly [Record<string, unknown>, number])[] = [
        [{ capability: "vault_login", consume: false }, 0],
        [{ capability: "vault_login", consume: false }, 0],
        [{ capability: "vault_login" }, 1],
        [{ capability: "vault_login", consume: false }, 0],
        [{ capability: "vault_login" }, 1],
        [{ capability: "vault_login" }, 1],
      ]
      for (const [body, charge] of traffic) {
        const answer = await post(server, body)
        expect(`${JSON.stringify(body)} -> ${answer.status} consumed=${answer.body.consumed}`).toBe(
          `${JSON.stringify(body)} -> ${answer.status === 200 ? "200" : "402"} consumed=${charge === 1}`,
        )
      }
      // Three consuming calls spent three; the reads in between cost nothing.
      expect(spent("vault_login", "free")).toBe(3)
    } finally {
      await server.stop()
    }
  })

  test("the read form is unreachable by accident", async () => {
    // Everything a display path could plausibly send by mistake, each of which
    // must CHARGE. Under-metering a paid capability is worse than an inflated
    // counter, so an unrecognised value resolves to spending rather than to a
    // free read.
    subscribe("pro")
    const server = await startServer()
    try {
      const mistyped: Record<string, unknown>[] = [
        {},
        { consume: undefined },
        { consume: "false" },
        { consume: 0 },
        { consume: null },
        { consume: "no" },
        { consume: true },
      ]
      for (const extra of mistyped) {
        const answer = await post(server, { capability: "cloud_vision", ...extra })
        expect(`${JSON.stringify(extra)} -> consumed=${answer.body.consumed}`).toBe(
          `${JSON.stringify(extra)} -> consumed=true`,
        )
        expect(answer.body.allowed).toBe(true)
      }
      expect(spent("cloud_vision", "pro")).toBe(mistyped.length)
    } finally {
      await server.stop()
    }
  })

  test("an unknown capability is still a 400, and still spends nothing", async () => {
    // The read form is not a way to probe the route: an unrecognised capability
    // is refused before anything is decided, let alone charged.
    subscribe("pro")
    const server = await startServer()
    try {
      expect((await post(server, { capability: "everything", consume: false })).status).toBe(400)
      expect(recorded()).toBeUndefined()
    } finally {
      await server.stop()
    }
  })

  test("a check with no resolvable profile spends nothing, on either form", async () => {
    // The write is gated on a counter having actually moved rather than on the
    // profile being present, so this pins the two together: an anonymous caller
    // has nowhere to record a spend, so neither form may claim one.
    subscribe("pro")
    const server = await startServer()
    try {
      for (const body of [{ capability: "cloud_vision" }, { capability: "cloud_vision", consume: false }]) {
        const response = await fetch(`${server.url}/v1/billing/check`, {
          method: "POST",
          headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        })
        const answer = (await response.json()) as Record<string, unknown>
        expect(`${JSON.stringify(body)} -> consumed=${answer.consumed}`).toBe(`${JSON.stringify(body)} -> consumed=false`)
      }
      // The paying profile's allowance is untouched by somebody else's checks.
      expect(spent("cloud_vision", "pro")).toBe(0)
    } finally {
      await server.stop()
    }
  })
})

describe("the reply says which kind of answer it was", () => {
  test("a read and a decision are distinguishable from the response alone", async () => {
    subscribe("pro")
    const server = await startServer()
    try {
      const preview = await post(server, { capability: "cloud_vision", consume: false })
      const decision = await post(server, { capability: "cloud_vision" })
      // Same question, same answer, different cost - and the cost is on the wire
      // rather than something the caller has to remember about itself.
      expect(preview.body.code).toBe(decision.body.code)
      expect(preview.body.allowed).toBe(decision.body.allowed)
      expect(preview.body.limit).toBe(decision.body.limit)
      expect(preview.body.consumed).toBe(false)
      expect(decision.body.consumed).toBe(true)
    } finally {
      await server.stop()
    }
  })

  test("a refused consuming call reports consumed:false, because there was nothing to bill", async () => {
    subscribe("free")
    const server = await startServer()
    try {
      const answer = await post(server, { capability: "remote_shell" })
      expect(answer.status).toBe(402)
      expect(answer.body.code).toBe("not_entitled")
      // A consuming call that was refused spent nothing, and says so. Reporting
      // true here would tell a UI it had charged a customer for a refusal.
      expect(answer.body.consumed).toBe(false)
    } finally {
      await server.stop()
    }
  })

  test("the entitlement snapshot reports consumed:false on every capability", async () => {
    // The other read path in the product. It never spent to begin with - it is a
    // GET and only ever called decide() - but it now says so per capability, so
    // a caller can tell from the reply that reading the plan is free.
    subscribe("pro")
    const server = await startServer()
    try {
      const response = await fetch(`${server.url}/v1/billing/entitlement`, {
        headers: { authorization: `Bearer ${server.token}`, "x-omnia-profile": PROFILE },
      })
      expect(response.status).toBe(200)
      const json = (await response.json()) as { capabilities: Record<string, { consumed?: unknown }> }
      const capabilities = Object.values(json.capabilities)
      expect(capabilities.length).toBe(EVERY_CAPABILITY.length)
      expect(capabilities.every((entry) => entry.consumed === false)).toBe(true)
      expect(recorded()).toBeUndefined()
    } finally {
      await server.stop()
    }
  })
})

describe("the store's own split, with no route involved", () => {
  const state = applySubscription(
    EMPTY_STATE,
    {
      customerId: "cus_store",
      subscriptionId: "sub_store",
      status: "active",
      profileId: PROFILE,
      currentPeriodEnd: Date.parse("2099-01-01T00:00:00Z"),
    },
    "pro",
    "evt_store",
  ).state

  test("a read hands back the state it was given, by identity", () => {
    // The store's promise to its callers: on a read, `check` returns the SAME
    // object, so a caller can skip the write without diffing counters - and a
    // read provably mutated nothing.
    const preview = check(state, PROFILE, "cloud_vision", { consume: false })
    expect(preview.consumed).toBe(false)
    expect(preview.state).toBe(state)
    expect(preview.decision.allowed).toBe(true)
  })

  test("a consuming check returns a different state and reports the charge", () => {
    const charged = check(state, PROFILE, "cloud_vision", {})
    expect(charged.consumed).toBe(true)
    expect(charged.state).not.toBe(state)
    expect(charged.decision.allowed).toBe(true)
  })

  test("a refused check charges nothing, whichever way it was asked", () => {
    for (const consume of [true, false]) {
      const refused = check(state, PROFILE, "self_hosted", { consume })
      expect(`${consume} -> ${refused.decision.code}`).toBe(`${consume} -> not_entitled`)
      expect(`${consume} -> consumed=${refused.consumed}`).toBe(`${consume} -> consumed=false`)
      expect(refused.state).toBe(state)
    }
  })
})
