// The plan matrix as an ENFORCEMENT contract, not as a table of numbers.
//
// plans.ts is the only source of truth for what a plan may do, and every number
// in it is a promise about work that either happens or does not. A test that
// restates `PLANS.free.capabilities.live_view.limit` proves nothing: it would
// still pass if `decide()` stopped reading the limit, or if the enforcement
// route stopped consulting `decide()` at all.
//
// So every row below is asserted as the consequence it causes, through the real
// store and real counters:
//
//   - one unit UNDER the limit still works, so the boundary is not off by one;
//   - the request AT the limit is refused for a hard allowance and merely
//     degrades for a soft one, so the metering column has teeth;
//   - a limit of 0 refuses before any usage is considered at all;
//   - an unlimited allowance survives a counter large enough to stop anything
//     finite, so "unlimited" is not just a big number.
//
// The matrix is `satisfies Record<Capability, ...>`, so adding a capability to
// plans.ts without asserting what it allows is a type error here, and the
// key-set tests catch a capability added to one plan table but not the others.
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { PLANS, type Capability, type Metered, type PlanId } from "./plans"
import {
  EMPTY_STATE,
  applySubscription,
  billingStateReadable,
  consume,
  currentDay,
  currentPeriod,
  decide,
  readBillingState,
  resolvePlan,
  writeBillingState,
  type BillingState,
} from "./store"

const UNLIMITED = Number.POSITIVE_INFINITY

interface Row {
  readonly limit: number
  readonly metering: Metered
}

/**
 * What the free plan must actually do, capability by capability.
 *
 * Written out independently so the enforcement below has something to check
 * rather than something to echo.
 */
const FREE_MATRIX = {
  local_computer: { limit: UNLIMITED, metering: "soft" },
  // Remote control is included on free because it is what converts somebody.
  // Bounded by a session ceiling rather than by a request count.
  remote_computer: { limit: UNLIMITED, metering: "soft" },
  input_freeze: { limit: UNLIMITED, metering: "soft" },
  remote_shell: { limit: 0, metering: "hard" },
  clipboard: { limit: UNLIMITED, metering: "soft" },
  browser_automation: { limit: 500, metering: "hard" },
  credential_vault: { limit: 5, metering: "hard" },
  vault_login: { limit: 3, metering: "hard" },
  cloud_vision: { limit: 0, metering: "hard" },
  scheduled_runs: { limit: 0, metering: "hard" },
  live_view: { limit: 500, metering: "hard" },
  api_access: { limit: 0, metering: "hard" },
  webhooks: { limit: 0, metering: "hard" },
  subagents: { limit: UNLIMITED, metering: "soft" },
  audit_export: { limit: 0, metering: "hard" },
  rbac: { limit: 0, metering: "hard" },
  sso: { limit: 0, metering: "hard" },
  self_hosted: { limit: 0, metering: "hard" },
} satisfies Record<Capability, Row>

/** The same contract for the paid plan sold by self-service checkout. */
const PRO_MATRIX = {
  local_computer: { limit: UNLIMITED, metering: "soft" },
  remote_computer: { limit: UNLIMITED, metering: "soft" },
  input_freeze: { limit: UNLIMITED, metering: "soft" },
  remote_shell: { limit: UNLIMITED, metering: "soft" },
  clipboard: { limit: UNLIMITED, metering: "soft" },
  browser_automation: { limit: UNLIMITED, metering: "soft" },
  credential_vault: { limit: UNLIMITED, metering: "soft" },
  vault_login: { limit: 300, metering: "soft" },
  cloud_vision: { limit: 2_000, metering: "soft" },
  scheduled_runs: { limit: 50, metering: "soft" },
  live_view: { limit: UNLIMITED, metering: "soft" },
  api_access: { limit: UNLIMITED, metering: "soft" },
  webhooks: { limit: UNLIMITED, metering: "soft" },
  subagents: { limit: UNLIMITED, metering: "soft" },
  audit_export: { limit: 0, metering: "hard" },
  rbac: { limit: 0, metering: "hard" },
  sso: { limit: 0, metering: "hard" },
  self_hosted: { limit: 0, metering: "hard" },
} satisfies Record<Capability, Row>

const COMPUTERS: Readonly<Record<PlanId, number>> = { free: 3, pro: 5, business: Number.POSITIVE_INFINITY, enterprise: Number.POSITIVE_INFINITY }

const CAPABILITIES = Object.keys(FREE_MATRIX) as Capability[]
const PROFILE = "230746284"
// Fixed clock so the billing period under test is PERIOD and never "now".
const NOW = Date.parse("2026-03-17T12:00:00Z")
const PERIOD = currentPeriod(NOW)
const DAY = currentDay(NOW)

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // A leftover temp dir must never fail a test run.
    }
  }
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "omnia-matrix-"))
  dirs.push(dir)
  return dir
}

function tempFile(): string {
  return join(tempDir(), "billing.json")
}

function subscription(plan: PlanId) {
  return {
    customerId: "cus_matrix",
    subscriptionId: `sub_${plan}`,
    status: "active" as const,
    profileId: PROFILE,
    currentPeriodEnd: NOW + 86_400_000,
  }
}

/** The store a customer on `plan` actually has: a real subscription, no usage. */
function freshStore(plan: PlanId): BillingState {
  return applySubscription(EMPTY_STATE, subscription(plan), plan, `evt_seed_${plan}`).state
}

/** Burns `times` real requests through the real counter. */
function spend(plan: PlanId, capability: Capability, times: number): BillingState {
  let state = freshStore(plan)
  for (let index = 0; index < times; index += 1) state = consume(state, PROFILE, capability, { now: NOW })
  return state
}

/**
 * A store whose counters are as high as the store's own parser will accept.
 *
 * `readBillingState` clamps a counter to 1e12, so this is the largest usage a
 * crafted or long-lived state file can present. Anything unlimited must still
 * work through it; anything finite must already be refusing.
 */
function saturatedStore(plan: PlanId): BillingState {
  const counters: Record<string, number> = {}
  for (const capability of CAPABILITIES) {
    // Every capability is metered monthly, and browser_automation is daily, so
    // both key shapes have to be saturated - writing only the monthly key left
    // the daily allowance reading zero and the test asserting a grant.
    counters[`${capability}:${PERIOD}`] = 1e15
    counters[`${capability}:${DAY}`] = 1e15
  }
  const file = tempFile()
  writeBillingState(file, {
    ...freshStore(plan),
    usage: { [PROFILE]: { counters, updatedAt: NOW } },
  })
  return readBillingState(file)
}

describe("every capability in the plan table has an asserted limit", () => {
  // The guard this file exists for. `satisfies` fails the typecheck when a
  // capability is added to the union; this catches what slips past it: a
  // capability added to ONE plan table, or to none of them.
  test("the matrix names every capability in every plan", () => {
    const expected = CAPABILITIES.slice().sort().join(",")
    for (const plan of ["free", "pro", "business", "enterprise"] as const) {
      expect(`${plan}: ${Object.keys(PLANS[plan].capabilities).sort().join(",")}`).toBe(`${plan}: ${expected}`)
    }
  })

  test("no plan drops or invents a capability relative to free", () => {
    const reference = CAPABILITIES.slice().sort()
    for (const plan of ["pro", "business", "enterprise"] as const) {
      expect(Object.keys(PLANS[plan].capabilities).slice().sort()).toEqual(reference)
    }
  })

  test("the computer allowance is 3 on free and 5 on pro, and nothing above it is finite", () => {
    for (const plan of ["free", "pro"] as const) {
      expect(`${plan} computers=${PLANS[plan].computers}`).toBe(`${plan} computers=${COMPUTERS[plan]}`)
    }
    expect(PLANS.pro.computers).toBeGreaterThan(PLANS.free.computers)
    expect(Number.isFinite(PLANS.business.computers)).toBe(false)
    expect(Number.isFinite(PLANS.enterprise.computers)).toBe(false)
  })

  test("the free session ceiling is the only thing bounding remote control", () => {
    // remote_computer has no request ceiling, so the ceiling is the whole
    // promise. Pro lifts it; that difference is what an upgrade buys.
    expect(PLANS.free.capabilities.remote_computer.limit).toBe(UNLIMITED)
    expect(PLANS.free.capabilities.remote_computer.sessionMinutes).toBe(120)
    expect(PLANS.pro.capabilities.remote_computer.sessionMinutes).toBeUndefined()
  })

  test("upgrading never reduces an allowance or refuses a free unlimited basic", () => {
    const tiers = ["free", "pro", "business", "enterprise"] as const
    for (let index = 1; index < tiers.length; index += 1) {
      const previous = PLANS[tiers[index - 1]]
      const paid = PLANS[tiers[index]]
      expect(paid.computers).toBeGreaterThanOrEqual(previous.computers)
      const saturated = saturatedStore(paid.id)
      for (const capability of CAPABILITIES) {
        const before = previous.capabilities[capability]
        const after = paid.capabilities[capability]
        // A monthly paid budget must cover even a 31-day free daily budget.
        const minimum = before.period === "day" && after.period === "month" ? before.limit * 31 : before.limit
        expect(after.limit).toBeGreaterThanOrEqual(minimum)
        expect(after.sessionMinutes ?? UNLIMITED).toBeGreaterThanOrEqual(before.sessionMinutes ?? UNLIMITED)
        if (before.limit > 0) {
          expect(decide(freshStore(paid.id), PROFILE, capability, { now: NOW }).allowed).toBe(true)
        }
        if (FREE_MATRIX[capability].limit === UNLIMITED) {
          expect(decide(saturated, PROFILE, capability, { now: NOW, storeReadable: false })).toMatchObject({
            plan: paid.id,
            allowed: true,
            code: "granted",
            used: 1e12,
            limit: UNLIMITED,
          })
        }
      }
    }
  })
})

for (const plan of ["free", "pro"] as const) {
  const matrix = plan === "free" ? FREE_MATRIX : PRO_MATRIX
  describe(`${plan}: what each limit actually causes`, () => {
    for (const capability of CAPABILITIES) {
      const row = matrix[capability]
      const label = row.limit === UNLIMITED ? "unlimited" : `${row.limit} ${row.metering}`

      test(capability, () => {
        const fresh = decide(freshStore(plan), PROFILE, capability, { now: NOW })
        // The answer names the plan the customer is on, not the plan we wished
        // they were on.
        expect(fresh.plan).toBe(plan)
        expect(fresh.limit).toBe(row.limit)
        expect(fresh.metering).toBe(row.metering)

        if (row.limit === 0) {
          // Excluded outright: refused before a single unit of usage matters,
          // and no amount of recorded usage can buy it.
          expect(fresh.code).toBe("not_entitled")
          expect(fresh.allowed).toBe(false)
          expect(fresh.limit).toBe(0)
          const spent = decide(spend(plan, capability, 100), PROFILE, capability, { now: NOW })
          expect(spent.allowed).toBe(false)
          expect(spent.code).toBe("not_entitled")
          return
        }

        if (row.limit !== UNLIMITED) {
          // One UNDER the limit: the boundary is not early.
          const lastAllowed = decide(spend(plan, capability, row.limit - 1), PROFILE, capability, { now: NOW })
          expect(lastAllowed.code).toBe("granted")
          expect(lastAllowed.allowed).toBe(true)
          expect(lastAllowed.used).toBe(row.limit - 1)
          expect(lastAllowed.limit).toBe(row.limit)

          // AT the limit: the metering column decides whether this is a refusal.
          const boundary = decide(spend(plan, capability, row.limit), PROFILE, capability, { now: NOW })
          expect(boundary.used).toBe(row.limit)
          expect(boundary.limit).toBe(row.limit)
          expect(boundary.code).toBe("limit_reached")
          expect(boundary.metering).toBe(row.metering)
          expect(boundary.allowed).toBe(row.metering === "soft")
          // A hard refusal says the allowance is spent; a soft one admits it is
          // past fair use and keeps working. A caller can act on the difference.
          expect(boundary.reason).toMatch(row.metering === "hard" ? /allowance/ : /fair-use/)
          // The plan in the message is the one being charged.
          expect(boundary.reason).toContain(plan)
          return
        }

        // Unlimited. A counter at the store's own clamp is the strongest
        // statement available: nothing a state file can say stops this one.
        const saturated = saturatedStore(plan)
        expect(saturated.usage[PROFILE]?.counters[`${capability}:${PERIOD}`]).toBe(1e12)
        const decision = decide(saturated, PROFILE, capability, { now: NOW })
        expect(decision.allowed).toBe(true)
        expect(decision.code).toBe("granted")
        expect(decision.used).toBe(1e12)
        expect(decision.reason).toContain(`included in the ${plan} plan`)
        expect(`${label} -> ${decision.code}`).toBe(`${label} -> granted`)
      })
    }
  })
}

describe("a ceiling only counts as a ceiling if a finite one binds", () => {
  // The contrast that makes the unlimited rows meaningful: the same saturated
  // counters, the same store, the same profile, one decision apart.
  test("finite allowances bind at their own number and unlimited ones do not", () => {
    for (const plan of ["free", "pro"] as const) {
      const matrix = plan === "free" ? FREE_MATRIX : PRO_MATRIX
      const saturated = saturatedStore(plan)
      for (const capability of CAPABILITIES) {
        const row = matrix[capability]
        if (row.limit === UNLIMITED) continue
        const decision = decide(saturated, PROFILE, capability, { now: NOW })
        const label = `${plan}/${capability} metering=${row.metering} -> ${decision.code}`
        if (row.limit === 0) expect(label).toBe(`${plan}/${capability} metering=${row.metering} -> not_entitled`)
        else {
          // A finite ceiling is reached long before 1e12, so the answer is the
          // boundary answer and never a grant.
          expect(label).toBe(`${plan}/${capability} metering=${row.metering} -> limit_reached`)
          expect(decision.allowed).toBe(row.metering === "soft")
        }
      }
    }
  })

  test("a spent month does not follow the customer into the next one", () => {
    const january = Date.parse("2026-01-05T00:00:00Z")
    let state = freshStore("pro")
    // Pro has a finite soft allowance of 300 vault logins per month.
    for (let index = 0; index < 300; index += 1) {
      state = consume(state, PROFILE, "vault_login", { now: january })
    }
    const file = tempFile()
    writeBillingState(file, state)
    const read = readBillingState(file)
    const inJanuary = decide(read, PROFILE, "vault_login", { now: Date.parse("2026-01-20T00:00:00Z") })
    expect(inJanuary.used).toBe(300)
    expect(inJanuary.allowed).toBe(true)
    expect(inJanuary.limit).toBe(300)
    expect(inJanuary.code).toBe("limit_reached")
    // March is a fresh period: the fair-use warning from January does not
    // follow them across the month boundary.
    const inMarch = decide(read, PROFILE, "vault_login", { now: NOW })
    expect(inMarch.used).toBe(0)
    expect(inMarch.code).toBe("granted")
    expect(inMarch.allowed).toBe(true)
  })

  test("usage is stored under capability:YYYY-MM, which is what the store reads back", () => {
    const file = tempFile()
    writeBillingState(file, consume(EMPTY_STATE, PROFILE, "live_view", { now: NOW }))
    expect(Object.keys(readBillingState(file).usage[PROFILE]?.counters ?? {})).toEqual([`live_view:${PERIOD}`])
    expect(PERIOD).toBe("2026-03")
  })
})

describe("the failure policy, per capability, on the plan the customer is on", () => {
  // An unreadable store means the usage counters are unknown. The direction is
  // decided by the allowance, not by whether the capability is "paid": a hard
  // allowance cannot be honoured with an unknown counter, and a soft one is
  // meant to degrade rather than break.
  for (const plan of ["free", "pro"] as const) {
    const matrix = plan === "free" ? FREE_MATRIX : PRO_MATRIX
    describe(plan, () => {
      for (const capability of CAPABILITIES) {
        const row = matrix[capability]
        test(capability, () => {
          const readable = decide(freshStore(plan), PROFILE, capability, { now: NOW })
          const outage = decide(freshStore(plan), PROFILE, capability, { now: NOW, storeReadable: false })
          expect(outage.plan).toBe(plan)
          if (row.limit === 0) {
            // Nothing was ever granted, so an outage cannot take anything away:
            // the answer is the plan's, not the outage's.
            expect(outage.code).toBe("not_entitled")
            expect(outage.allowed).toBe(false)
          } else if (row.metering === "hard") {
            // Refused, and refused as UNKNOWN rather than as "over quota": the
            // customer has not spent anything, we simply cannot prove they have
            // not, and saying "you are out of quota" would be a lie.
            expect(outage.code).toBe("unknown")
            expect(outage.allowed).toBe(false)
            expect(readable.allowed).toBe(true)
            expect(outage.reason).toMatch(/cannot be confirmed/)
            expect(outage.reason).not.toMatch(/allowance/)
          } else {
            // Soft: still granted, with no sign that billing is unwell.
            expect(outage.code).toBe("granted")
            expect(outage.allowed).toBe(true)
            expect(outage.used).toBe(readable.used)
            expect(outage.reason).toBe(readable.reason)
          }
        })
      }
    })
  }

  test("an outage takes nothing away from a paying customer", () => {
    // The regression that mattered: a pro or business customer lost paid features
    // because the policy was evaluated against the FREE plan. Every allowance pro
    // grants is soft or unlimited, so everything it grants survives a store that
    // cannot be read.
    for (const capability of CAPABILITIES) {
      const granted = decide(freshStore("pro"), PROFILE, capability, { now: NOW }).allowed
      if (!granted) continue
      const outage = decide(freshStore("pro"), PROFILE, capability, { now: NOW, storeReadable: false })
      expect(`pro/${capability} during an outage -> ${outage.code}`).toBe(
        `pro/${capability} during an outage -> granted`,
      )
    }
    // The refusal direction is reachable on a paid plan only for capabilities
    // the plan does not include at all, which no outage can change.
    for (const capability of CAPABILITIES) {
      const outage = decide(freshStore("pro"), PROFILE, capability, { now: NOW, storeReadable: false })
      expect(`pro/${capability} outage allowed=${outage.allowed} code=${outage.code}`).toBe(
        `pro/${capability} outage allowed=${decide(freshStore("pro"), PROFILE, capability, { now: NOW }).allowed} code=${
          decide(freshStore("pro"), PROFILE, capability, { now: NOW }).allowed ? "granted" : "not_entitled"
        }`,
      )
    }
  })

  test("a free customer's hard allowance is not handed out unmetered when billing is unwell", () => {
    // The opposite half. On free these four ARE granted in normal operation, so
    // an unreadable counter is exactly the case that would turn a disk error
    // into unlimited use - a revenue leak dressed up as an outage.
    const atRisk = CAPABILITIES.filter(
      (capability) => FREE_MATRIX[capability].metering === "hard" && FREE_MATRIX[capability].limit > 0,
    ).sort()
    expect(atRisk).toEqual(["browser_automation", "credential_vault", "live_view", "vault_login"])
    for (const capability of atRisk) {
      expect(decide(freshStore("free"), PROFILE, capability, { now: NOW }).allowed).toBe(true)
      expect(decide(freshStore("free"), PROFILE, capability, { now: NOW, storeReadable: false }).allowed).toBe(false)
    }
  })

  test("a free customer's soft allowances keep working through an outage", () => {
    const atRisk = CAPABILITIES.filter(
      (capability) => FREE_MATRIX[capability].metering === "soft" && FREE_MATRIX[capability].limit > 0,
    ).sort()
    // Pinned deliberately: these are exactly the capabilities that must survive
    // OUR outage rather than being taken away from a customer who did nothing
    // wrong. All five are unlimited - "soft with no ceiling" is
    // still soft, and stripping them would break the free app entirely.
    expect(atRisk).toEqual(["clipboard", "input_freeze", "local_computer", "remote_computer", "subagents"])
    for (const capability of atRisk) {
      expect(decide(freshStore("free"), PROFILE, capability, { now: NOW, storeReadable: false }).allowed).toBe(true)
    }
  })

  test("a store that exists but does not parse is unreadable, and saying so is the whole point", () => {
    // billingStateReadable and readBillingState disagree here on purpose. The
    // reader returns an empty store so a corrupt file is never trusted; the
    // predicate is what lets a caller fail closed instead of concluding that
    // the customer simply has no subscription.
    const file = tempFile()
    writeBillingState(file, freshStore("pro"))
    expect(billingStateReadable(file)).toBe(true)
    expect(readBillingState(file).subscriptions).toHaveLength(1)
    writeFileSync(file, "{ this is not json", { mode: 0o600 })
    expect(billingStateReadable(file)).toBe(false)
    // The reader reports nothing rather than a half-parsed account, and only the
    // read itself moves the original bytes aside.
    expect(readBillingState(file)).toEqual(EMPTY_STATE)
    // The original bytes are preserved, not destroyed.
    expect(readdirSync(dirname(file)).filter((name) => name.includes(".corrupt."))).toHaveLength(1)
  })

  test("a store that is merely absent is READABLE: no data means the free plan", () => {
    // Armed fail-closed on a missing file, every fresh install refused the very
    // first vault login for every new user.
    const file = join(tempDir(), "never-written.json")
    expect(billingStateReadable(file)).toBe(true)
    expect(resolvePlan(readBillingState(file), PROFILE, NOW).id).toBe("free")
    // ...and because it is readable, an unknown hard counter is still refused on
    // its own merits rather than as an outage.
    expect(decide(readBillingState(file), PROFILE, "vault_login", { now: NOW, storeReadable: false }).code).toBe(
      "unknown",
    )
  })

  test("a subscription grants its plan to its own profile and nobody else", () => {
    for (const plan of ["free", "pro"] as const) {
      expect(resolvePlan(freshStore(plan), PROFILE, NOW).id).toBe(plan)
    }
    expect(resolvePlan(freshStore("pro"), "somebody-else", NOW).id).toBe("free")
    expect(resolvePlan(freshStore("pro"), undefined, NOW).id).toBe("free")
    // A lapsed period does not entitle: the same store, a clock past the end.
    expect(resolvePlan(freshStore("pro"), PROFILE, NOW + 86_400_001).id).toBe("free")
  })
})

describe("the store bounds what it will remember", () => {
  // MAX_PROCESSED_EVENTS and MAX_SUBSCRIPTIONS exist so a long-lived or hostile
  // state file cannot grow without limit. A bound nobody can observe is not a
  // bound, so these assert the eviction rather than the number.
  test("replay protection remembers the newest events and forgets the oldest", () => {
    let state = EMPTY_STATE
    for (let index = 0; index < 1_500; index += 1) {
      state = applySubscription(state, subscription("pro"), "pro", `evt_${index}`).state
    }
    // Bounded, not unbounded...
    expect(state.processedEvents.length).toBeLessThan(1_500)
    expect(state.processedEvents.length).toBe(1_000)
    // ...and what survived is the NEWEST window, the only window that can still
    // catch a replay.
    expect(state.processedEvents.at(-1)).toBe("evt_1499")
    expect(state.processedEvents).not.toContain("evt_0")
    // A forgotten id is re-appliable, which is the cost of a sliding window; a
    // remembered one is still recognised.
    expect(applySubscription(state, subscription("pro"), "pro", "evt_0").duplicate).toBe(false)
    const known = applySubscription(state, subscription("pro"), "pro", "evt_1499")
    expect(known.duplicate).toBe(true)
    expect(known.changed).toBe(false)
    // Bounding the event log did not throw away the subscription it belongs to.
    expect(known.state.subscriptions).toHaveLength(1)
    expect(resolvePlan(known.state, PROFILE, NOW).id).toBe("pro")
  })

  test("a state file carrying more events than the window keeps only the newest", () => {
    const file = tempFile()
    writeBillingState(file, {
      ...EMPTY_STATE,
      processedEvents: Array.from({ length: 1_200 }, (_, index) => `evt_${index}`),
    })
    const read = readBillingState(file)
    expect(read.processedEvents).toHaveLength(1_000)
    expect(read.processedEvents.at(-1)).toBe("evt_1199")
    expect(read.processedEvents).not.toContain("evt_0")
  })

  test("the subscription bound bites, and it bites from the newest end", () => {
    // Recorded as an observation, not as an endorsement: a state file with more
    // subscriptions than the bound is truncated at the END, so the most recently
    // added subscriber is the one that loses the plan entirely.
    const file = tempFile()
    writeBillingState(file, {
      ...EMPTY_STATE,
      subscriptions: Array.from({ length: 6_000 }, (_, index) => ({
        customerId: `cus_${index}`,
        subscriptionId: `sub_${index}`,
        status: "active" as const,
        plan: "pro" as const,
        profileId: `profile_${index}`,
        currentPeriodEnd: NOW + 86_400_000,
      })),
    })
    const read = readBillingState(file)
    expect(read.subscriptions.length).toBeLessThan(6_000)
    expect(read.subscriptions.length).toBe(5_000)
    expect(resolvePlan(read, "profile_0", NOW).id).toBe("pro")
    expect(resolvePlan(read, "profile_5_999", NOW).id).toBe("free")
  })

  test("the bound also holds while folding, so the list never grows past it", () => {
    let state = EMPTY_STATE
    for (let index = 0; index < 5_010; index += 1) {
      state = applySubscription(
        state,
        {
          customerId: `cus_${index}`,
          subscriptionId: `sub_${index}`,
          status: "active",
          profileId: `profile_${index}`,
          currentPeriodEnd: NOW + 86_400_000,
        },
        "pro",
        `evt_${index}`,
      ).state
    }
    expect(state.subscriptions.length).toBeLessThan(5_010)
    expect(state.subscriptions.length).toBe(5_000)
    expect(state.processedEvents.length).toBe(1_000)
  })

  test("a counter in a state file cannot be inflated past the parser's clamp", () => {
    const file = tempFile()
    writeBillingState(file, {
      ...EMPTY_STATE,
      usage: {
        [PROFILE]: {
          counters: { [`vault_login:${PERIOD}`]: Number.MAX_SAFE_INTEGER },
          updatedAt: NOW,
        },
      },
    })
    expect(readBillingState(file).usage[PROFILE]?.counters[`vault_login:${PERIOD}`]).toBe(1e12)
  })

  test("a counter key longer than the store accepts is dropped, not stored", () => {
    const file = tempFile()
    writeBillingState(file, {
      ...EMPTY_STATE,
      usage: {
        [PROFILE]: {
          counters: { [`vault_login:${PERIOD}${"x".repeat(200)}`]: 5, [`vault_login:${PERIOD}`]: 1 },
          updatedAt: NOW,
        },
      },
    })
    expect(Object.keys(readBillingState(file).usage[PROFILE]?.counters ?? {})).toEqual([`vault_login:${PERIOD}`])
  })
})
