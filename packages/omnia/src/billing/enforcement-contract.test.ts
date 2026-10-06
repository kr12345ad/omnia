// The enforcement contract at the call site: POST /v1/billing/check.
//
// plan-matrix.test.ts already proves what `decide()` returns for every capability,
// through the real store and real counters. This file proves the three things only
// the route can show:
//
//   1. THE ROUTE IS WHERE THE LIMIT BITES. Every capability in every plan is
//      driven through the real HTTP route and the consequence is asserted: a
//      refusal is a 402 with the capability, the plan, the metering and the
//      reason in the body; a grant is a 200 that MOVES THE COUNTER ON DISK. A
//      route that stopped reading the limit, or stopped writing the spend, would
//      pass every store-level test and fail here.
//
//   2. THE FAILURE POLICY, PER CAPABILITY, ON BOTH PLANS, WITH A GENUINELY
//      UNREADABLE STORE. Not a flag passed to decide() but a corrupt file on
//      disk, so the policy is exercised the way an outage actually reaches it -
//      and so the answer a paying customer gets during one is pinned rather than
//      assumed.
//
//   3. THE METERING PERIOD IS OBSERVABLE AT THE CALL SITE. browser_automation is
//      budgeted DAILY on free (`capability:YYYY-MM-DD`) and MONTHLY on pro
//      (`capability:YYYY-MM`). That distinction was wrong once - it was described
//      as a daily budget and metered monthly - so both halves are pinned from the
//      outside: a spent month must not refill at midnight, and a spent day must
//      come back at midnight, through the route a real client calls.
//
// Nothing here restates a number from plans.ts on its own. Every row below drives
// the route and asserts what the limit CAUSED, and the row tables are `satisfies
// Record<Capability, ...>`, so adding a capability to the union without deciding
// what it does to a customer is a typecheck error rather than a silent pass.
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test"
import { createHmac } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startOmniaServer } from "../server/server"
import { BillingClient } from "./client"
import { EMPTY_STATE, applySubscription, readBillingState, writeBillingState, type BillingState } from "./store"
import { PLANS, type Capability, type Metered, type PlanId } from "./plans"

type Server = Awaited<ReturnType<typeof startOmniaServer>>

const UNLIMITED = Number.POSITIVE_INFINITY
/** The store's own parser clamp: the largest counter any state file can present. */
const SATURATED = 1e12
const PROFILE = "230746284"
const WEBHOOK_SECRET = "whsec_enforcement_contract"
const PRICE_PRO = "price_pro_enforcement"
/** Today, as the store will key a counter. Computed per call, never cached across a faked clock. */
const today = (): string => new Date().toISOString().slice(0, 10)
const thisMonth = (): string => new Date().toISOString().slice(0, 7)

let dir = ""
let billingFile = ""
let previous: Record<string, string | undefined> = {}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnia-enforcement-contract-"))
  billingFile = join(dir, "billing.json")
  previous = {
    OMNIA_BILLING_FILE: process.env.OMNIA_BILLING_FILE,
    OMNIA_DATA_DIR: process.env.OMNIA_DATA_DIR,
    OMNIA_SERVER_URL: process.env.OMNIA_SERVER_URL,
    OMNIA_SERVER_TOKEN: process.env.OMNIA_SERVER_TOKEN,
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
    STRIPE_PRICE_PRO: process.env.STRIPE_PRICE_PRO,
    STRIPE_PRICE_BUSINESS: process.env.STRIPE_PRICE_BUSINESS,
  }
  process.env.OMNIA_BILLING_FILE = billingFile
  delete process.env.OMNIA_DATA_DIR
  delete process.env.OMNIA_SERVER_URL
  delete process.env.OMNIA_SERVER_TOKEN
})

afterEach(() => {
  setSystemTime()
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

interface Row {
  readonly limit: number
  readonly metering: Metered
}

/**
 * What the free plan must actually do, written out independently so the
 * enforcement below has something to check rather than something to echo.
 */
const FREE_MATRIX = {
  local_computer: { limit: UNLIMITED, metering: "soft" },
  remote_computer: { limit: UNLIMITED, metering: "soft" },
  input_freeze: { limit: 0, metering: "hard" },
  remote_shell: { limit: 0, metering: "hard" },
  clipboard: { limit: 0, metering: "hard" },
  browser_automation: { limit: 250, metering: "hard" },
  credential_vault: { limit: 1, metering: "soft" },
  vault_login: { limit: 3, metering: "hard" },
  cloud_vision: { limit: 0, metering: "hard" },
  scheduled_runs: { limit: 0, metering: "hard" },
  live_view: { limit: 20, metering: "soft" },
  api_access: { limit: 0, metering: "hard" },
  webhooks: { limit: 0, metering: "hard" },
  audit_export: { limit: 0, metering: "hard" },
  rbac: { limit: 0, metering: "hard" },
  sso: { limit: 0, metering: "hard" },
  self_hosted: { limit: 0, metering: "hard" },
  subagents: { limit: 2, metering: "soft" },
} satisfies Record<Capability, Row>

/** The same contract for the plan sold by self-service checkout. */
const PRO_MATRIX = {
  local_computer: { limit: UNLIMITED, metering: "soft" },
  remote_computer: { limit: UNLIMITED, metering: "soft" },
  input_freeze: { limit: UNLIMITED, metering: "soft" },
  remote_shell: { limit: UNLIMITED, metering: "soft" },
  clipboard: { limit: UNLIMITED, metering: "soft" },
  browser_automation: { limit: 2_000, metering: "soft" },
  credential_vault: { limit: UNLIMITED, metering: "soft" },
  vault_login: { limit: 300, metering: "soft" },
  cloud_vision: { limit: 2_000, metering: "soft" },
  scheduled_runs: { limit: 50, metering: "soft" },
  live_view: { limit: 500, metering: "soft" },
  api_access: { limit: UNLIMITED, metering: "soft" },
  webhooks: { limit: UNLIMITED, metering: "soft" },
  audit_export: { limit: 0, metering: "hard" },
  rbac: { limit: 0, metering: "hard" },
  sso: { limit: 0, metering: "hard" },
  self_hosted: { limit: 0, metering: "hard" },
  subagents: { limit: 10, metering: "soft" },
} satisfies Record<Capability, Row>

const CAPABILITIES = Object.keys(FREE_MATRIX) as Capability[]

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

/**
 * A real store holding `plan`'s subscription for the profile plus `counters`.
 *
 * The counters are written the way the store writes them, so the route reads
 * exactly the keys a real client would have produced.
 */
function store(plan: PlanId, counters: Record<string, number> = {}): BillingState {
  const subscribed =
    plan === "free"
      ? EMPTY_STATE
      : applySubscription(
          EMPTY_STATE,
          {
            customerId: "cus_contract",
            subscriptionId: `sub_${plan}`,
            status: "active",
            profileId: PROFILE,
            // Far enough ahead that no test's clock can lapse it.
            currentPeriodEnd: Date.parse("2099-01-01T00:00:00Z"),
          },
          plan,
          `evt_contract_${plan}`,
        ).state
  return {
    ...subscribed,
    usage: Object.keys(counters).length === 0 ? {} : { [PROFILE]: { counters, updatedAt: Date.now() } },
  }
}

/** The counter the store holds for this profile, or undefined if there is none. */
function countersOnDisk(): Record<string, number> | undefined {
  return readBillingState(billingFile).usage[PROFILE]?.counters
}

function check(
  server: Server,
  capability: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  return fetch(`${server.url}/v1/billing/check`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${server.token}`,
      "content-type": "application/json",
      "x-omnia-profile": PROFILE,
      ...headers,
    },
    body: JSON.stringify({ capability }),
  }).then(async (response) => ({ status: response.status, body: (await response.json()) as Record<string, unknown> }))
}

describe("every capability, through the enforcement route", () => {
  test("the matrix names every capability the plans do", () => {
    // The guard that makes the rest of this file exhaustive: a capability added
    // to plans.ts without a row here has no asserted consequence, and a
    // capability added to one plan table alone is caught by comparing all four.
    for (const plan of ["free", "pro", "business", "enterprise"] as const) {
      expect(`${plan}: ${Object.keys(PLANS[plan].capabilities).sort().join(",")}`).toBe(
        `${plan}: ${CAPABILITIES.slice().sort().join(",")}`,
      )
    }
  })

  for (const [plan, matrix] of [
    ["free", FREE_MATRIX],
    ["pro", PRO_MATRIX],
  ] as const) {
    describe(plan, () => {
      test(`${plan}: a capability this plan excludes is refused before any usage matters`, async () => {
        const server = await startServer()
        try {
          for (const capability of CAPABILITIES) {
            if (matrix[capability].limit !== 0) continue
            writeBillingState(billingFile, store(plan))
            const answer = await check(server, capability)
            expect(`${plan}/${capability} -> ${answer.status} ${answer.body.code}`).toBe(
              `${plan}/${capability} -> 402 not_entitled`,
            )
            expect(answer.body.plan).toBe(plan)
            expect(answer.body.capability).toBe(capability)
            expect(answer.body.limit).toBe(0)
            expect(answer.body.metering).toBe(matrix[capability].metering)
            expect(answer.body.reason).toContain(`not included in the ${plan} plan`)
            // Nothing was recorded: a capability nobody may use cannot spend an
            // allowance, so the store must not even hold a key for it.
            expect(countersOnDisk()).toBeUndefined()
          }
        } finally {
          await server.stop()
        }
      })

      test(`${plan}: a finite allowance grants the last unit, records it, and then refuses`, async () => {
        const server = await startServer()
        try {
          for (const capability of CAPABILITIES) {
            const row = matrix[capability]
            if (row.limit === 0 || row.limit === UNLIMITED) continue
            const key = `${capability}:${periodFor(capability, plan)}`
            // One UNDER the limit. The grant has to name the plan it is charging
            // and report the number it is charging against.
            writeBillingState(billingFile, store(plan, { [key]: row.limit - 1 }))
            const last = await check(server, capability)
            expect(last.status).toBe(200)
            expect(last.body.ok).toBe(true)
            expect(last.body.allowed).toBe(true)
            expect(last.body.code).toBe("granted")
            expect(last.body.plan).toBe(plan)
            expect(last.body.capability).toBe(capability)
            expect(last.body.used).toBe(row.limit - 1)
            expect(last.body.limit).toBe(row.limit)
            expect(last.body.metering).toBe(row.metering)
            expect(last.body.reason).toContain(`included in the ${plan} plan`)
            // The grant MOVED THE COUNTER. A route that answered from the plan
            // table alone would pass everything above and fail here.
            expect(countersOnDisk()?.[key]).toBe(row.limit)

            // AT the limit. The metering column is what decides whether this is a
            // refusal or a shrug, so it has to reach the wire.
            const boundary = await check(server, capability)
            expect(boundary.body.used).toBe(row.limit)
            expect(boundary.body.code).toBe("limit_reached")
            expect(boundary.body.allowed).toBe(row.metering === "soft")
            expect(boundary.status).toBe(row.metering === "hard" ? 402 : 200)
            expect(`${plan}/${capability} ${row.metering} -> ${boundary.status}`).toBe(
              `${plan}/${capability} ${row.metering} -> ${row.metering === "hard" ? 402 : 200}`,
            )
            expect(boundary.body.reason).toContain(plan)
            // A refused request spends nothing further: the counter is not
            // incremented by the refusal that reported it spent.
            expect(countersOnDisk()?.[key]).toBe(row.limit)
          }
        } finally {
          await server.stop()
        }
      })

      test(`${plan}: unlimited survives a counter the store has already clamped`, async () => {
        const server = await startServer()
        try {
          for (const capability of CAPABILITIES) {
            if (matrix[capability].limit !== UNLIMITED) continue
            // Every key shape this capability could be read from, saturated: an
            // allowance of "unlimited" has to survive the largest counter the
            // store's own parser will accept, and a key from another period must
            // not change the answer.
            writeBillingState(billingFile, store(plan, {
              [`${capability}:${thisMonth()}`]: SATURATED * 1_000_000,
              [`${capability}:${today()}`]: SATURATED * 1_000_000,
              [`${capability}:2000-01`]: SATURATED,
            }))
            const answer = await check(server, capability)
            expect(`${plan}/${capability} -> ${answer.status} ${answer.body.code}`).toBe(
              `${plan}/${capability} -> 200 granted`,
            )
            expect(answer.body.used).toBe(SATURATED)
            // JSON has no Infinity, so an unlimited allowance reaches the wire as
            // null. Pinned because a client that read it as "no limit given" would
            // be guessing, and because the canonical client's recovery from it is
            // only worth anything if the shape really is this.
            expect(answer.body.limit).toBeNull()
            // The answer is about the plan, not about the counter being silly.
            expect(answer.body.plan).toBe(plan)
          }
        } finally {
          await server.stop()
        }
      })
    })
  }

  test("a client reads an unlimited allowance back off the wire, not as null", async () => {
    // The route's own answer above reports `limit: null` for an unlimited rule.
    // The canonical client must recover it from the plan table rather than treat
    // the null as a number it does not have, because "unlimited" rendered as
    // "unknown" is how a UI starts showing a usage bar for a capability that has
    // no ceiling.
    writeBillingState(billingFile, store("pro"))
    const server = await startServer()
    try {
      const client = new BillingClient({
        env: { OMNIA_SERVER_URL: server.url, OMNIA_SERVER_TOKEN: server.token },
        profileId: PROFILE,
      })
      for (const capability of ["input_freeze", "credential_vault"] as const) {
        const answer = await client.check(capability)
        expect(`${capability} limit -> ${answer.limit}`).toBe(`${capability} limit -> ${UNLIMITED}`)
        expect(answer.allowed).toBe(true)
        expect(answer.origin).toBe("control-plane")
        expect(answer.degraded).toBe(false)
      }
      // A finite limit arrives as itself, from the wire.
      const finite = await client.check("subagents")
      expect(`${finite.limit}/${finite.used}`).toBe("10/0")
    } finally {
      await server.stop()
    }
  })

  test("the route refuses a capability it does not check rather than defaulting to a grant", async () => {
    // The check route reads its list from the plan table, so a name the product
    // has never heard of cannot be answered with somebody's plan.
    writeBillingState(billingFile, store("pro"))
    const server = await startServer()
    try {
      for (const capability of ["everything", "", "constructor", "toString", "vault_login "]) {
        const answer = await check(server, capability)
        expect(`${capability} -> ${answer.status}`).toBe(`${capability} -> 400`)
      }
      // ...and a refusal on that path records nothing either.
      expect(countersOnDisk()).toBeUndefined()
    } finally {
      await server.stop()
    }
  })
})

describe("an unreadable store, per capability, on the plan the customer is on", () => {
  // A corrupt file, not a flag. This is what an outage actually looks like at the
  // call site: the store cannot be read, so the plan cannot be resolved from it,
  // and the route answers from the free plan's own rules.
  async function withUnreadableStore<T>(plan: PlanId, run: (server: Server) => Promise<T>): Promise<T> {
    writeBillingState(billingFile, store(plan))
    writeFileSync(billingFile, "{ this is not json at all", { mode: 0o600 })
    const server = await startServer()
    try {
      return await run(server)
    } finally {
      await server.stop()
    }
  }

  test("on free, a hard allowance is refused as UNKNOWN rather than as an exhausted quota", async () => {
    await withUnreadableStore("free", async (server) => {
      const atRisk = CAPABILITIES.filter(
        (capability) => FREE_MATRIX[capability].metering === "hard" && FREE_MATRIX[capability].limit > 0,
      )
      expect(atRisk).toEqual(["browser_automation", "vault_login"])
      for (const capability of atRisk) {
        const answer = await check(server, capability)
        expect(`${capability} -> ${answer.status} ${answer.body.code}`).toBe(`${capability} -> 402 unknown`)
        expect(answer.body.allowed).toBe(false)
        // Refused as "we cannot tell", not as "you are out of allowance": this
        // customer has spent nothing, and saying otherwise would be a lie.
        expect(answer.body.reason).toMatch(/cannot be confirmed/)
        expect(answer.body.reason).not.toMatch(/allowance/)
        expect(answer.body.limit).toBe(FREE_MATRIX[capability].limit)
      }
    })
  })

  test("on free, a soft allowance keeps working, because an outage must not brick the app", async () => {
    await withUnreadableStore("free", async (server) => {
      const atRisk = CAPABILITIES.filter(
        (capability) => FREE_MATRIX[capability].metering === "soft" && FREE_MATRIX[capability].limit > 0,
      ).sort()
      expect(atRisk).toEqual(["credential_vault", "live_view", "local_computer", "remote_computer", "subagents"])
      for (const capability of atRisk) {
        const answer = await check(server, capability)
        expect(`${capability} -> ${answer.status} ${answer.body.code}`).toBe(`${capability} -> 200 granted`)
        expect(answer.body.reason).toBe(`${capability} is included in the free plan.`)
      }
    })
  })

  test("a capability the plan never included is not changed by an outage", async () => {
    await withUnreadableStore("free", async (server) => {
      for (const capability of CAPABILITIES.filter((entry) => FREE_MATRIX[entry].limit === 0)) {
        const answer = await check(server, capability)
        // The answer is the plan's, not the outage's: there was nothing to take
        // away, so the outage must not change the code a caller sees.
        expect(`${capability} -> ${answer.status} ${answer.body.code}`).toBe(`${capability} -> 402 not_entitled`)
      }
    })
  })

  test("an outage writes nothing over the bytes it could not read", async () => {
    await withUnreadableStore("free", async (server) => {
      await check(server, "vault_login")
      await check(server, "live_view")
      // A usage write here would replace every paid subscription in the file
      // with an empty store, which is how a corrupt file becomes permanent
      // data loss.
      expect(readFileSync(billingFile, "utf8")).toBe("{ this is not json at all")
    })
  })

  test("a paying customer is answered on the FREE plan while the store is unreadable", async () => {
    // THE GAP, pinned as observed. The policy in plans.ts says the failure
    // direction must be evaluated against the plan the customer is actually on,
    // because a disk error must not strip features from somebody who paid. At the
    // call site the plan cannot be read from the file that is unreadable, so it
    // resolves to free - and a pro customer then loses every capability pro
    // added:
    //
    //   - pro-only capabilities come back not_entitled, i.e. "upgrade", which is
    //     the opposite advice for a customer who already upgraded;
    //   - capabilities free does have come back `unknown`, because they are hard
    //     on free, so the outage refuses them too.
    //
    // The half that survives is everything free already allowed, which is why
    // the outage is survivable rather than total. Pinned so the blast radius is
    // visible instead of assumed.
    await withUnreadableStore("pro", async (server) => {
      const paidOnly = ["input_freeze", "remote_shell", "clipboard", "cloud_vision", "scheduled_runs", "api_access", "webhooks"]
      for (const capability of paidOnly) {
        const answer = await check(server, capability)
        expect(`pro outage ${capability} -> ${answer.status} ${answer.body.code} plan=${answer.body.plan}`).toBe(
          `pro outage ${capability} -> 402 not_entitled plan=free`,
        )
      }
      for (const capability of ["vault_login", "browser_automation"]) {
        const answer = await check(server, capability)
        expect(`pro outage ${capability} -> ${answer.status} ${answer.body.code}`).toBe(
          `pro outage ${capability} -> 402 unknown`,
        )
      }
      const kept = await check(server, "live_view")
      expect(`pro outage live_view -> ${kept.status} ${kept.body.code}`).toBe("pro outage live_view -> 200 granted")
    })
  })

  test("the outage does not revoke anything permanently: a restored store restores the plan", async () => {
    const server = await startServer()
    try {
      writeBillingState(billingFile, store("pro"))
      expect((await check(server, "input_freeze")).status).toBe(200)
      writeFileSync(billingFile, "{ not json", { mode: 0o600 })
      expect((await check(server, "input_freeze")).status).toBe(402)
      // The corrupt file is moved aside by a read rather than overwritten, so
      // restoring the last good copy is all it takes.
      writeBillingState(billingFile, store("pro"))
      const restored = await check(server, "input_freeze")
      expect(restored.status).toBe(200)
      expect(restored.body.plan).toBe("pro")
    } finally {
      await server.stop()
    }
  })

  test("a paying customer keeps their features when the CONTROL PLANE is unreachable", async () => {
    // The clause that matters, pinned with the real client and a real transport:
    // the canonical client remembers the plan the control plane last named, so
    // our own outage cannot take a paid feature away. This is the behaviour the
    // freeze route's own gate does NOT have - see enforcement-call-sites.test.ts.
    const controlPlane = await startServer()
    writeBillingState(billingFile, store("pro"))
    const client = new BillingClient({
      env: { OMNIA_SERVER_URL: controlPlane.url, OMNIA_SERVER_TOKEN: controlPlane.token },
      profileId: PROFILE,
      timeoutMs: 1_000,
    })
    try {
      // Learn the plan from the control plane, exactly as production does.
      const learned = await client.check("vault_login")
      expect(learned.plan).toBe("pro")
      expect(learned.origin).toBe("control-plane")
      await controlPlane.stop()

      for (const capability of CAPABILITIES) {
        const answer = await client.check(capability)
        if (!answer.allowed) {
          // The only refusals left are capabilities pro does not include, and an
          // outage cannot change what a plan includes.
          expect(`outage ${capability} -> ${answer.code}`).toBe(`outage ${capability} -> unreachable`)
          continue
        }
        expect(`outage ${capability} allowed=${answer.allowed} origin=${answer.origin} plan=${answer.plan}`).toBe(
          `outage ${capability} allowed=true origin=fail-open plan=pro`,
        )
        expect(answer.degraded).toBe(true)
      }
      // Every capability pro includes survives the outage, including the ones a
      // free store would have refused as hard-metered.
      for (const capability of ["vault_login", "browser_automation", "cloud_vision", "input_freeze"] as const) {
        const answer = await client.check(capability)
        expect(`${capability} through our outage -> ${answer.allowed} ${answer.origin}`).toBe(
          `${capability} through our outage -> true fail-open`,
        )
      }
      // ...while a free customer's hard allowance is still refused, so the
      // fail-open direction is not a hole in the free tier.
      const freeClient = new BillingClient({
        env: { OMNIA_SERVER_URL: "http://127.0.0.1:1", OMNIA_SERVER_TOKEN: "token" },
        profileId: PROFILE,
        timeoutMs: 1_000,
      })
      for (const capability of ["vault_login", "browser_automation"] as const) {
        const answer = await freeClient.check(capability)
        expect(`free outage ${capability} -> ${answer.allowed} ${answer.origin}`).toBe(
          `free outage ${capability} -> false fail-closed`,
        )
      }
    } finally {
      await controlPlane.stop()
    }
  })
})

describe("a daily allowance is a day, and a spent month is a month", () => {
  // The bug this pins: browser_automation is budgeted 250 a DAY on free and
  // 2000 a MONTH on pro. It was metered monthly while being described as daily,
  // so one busy afternoon could spend a month of the budget and leave the account
  // dead until the first. The counter key is derived from the rule's own period,
  // which makes the two indistinguishable from outside unless they are checked.
  const day = (iso: string): void => {
    setSystemTime(new Date(iso))
  }
  const today = "2026-03-17"
  const tomorrow = "2026-03-18"

  test("free browser automation is refused today and granted at the next UTC midnight", async () => {
    day(`${today}T12:00:00Z`)
    // The daily key at the limit and the monthly key at zero: the refusal can
    // only come from the daily counter, so the daily counter is what this route
    // reads.
    writeBillingState(billingFile, store("free", { [`browser_automation:${today}`]: 250, "browser_automation:2026-03": 0 }))
    const server = await startServer()
    try {
      const spent = await check(server, "browser_automation")
      expect(spent.status).toBe(402)
      expect(spent.body.code).toBe("limit_reached")
      expect(spent.body.used).toBe(250)
      // The refusal names the budget it came out of, because it is back in hours.
      expect(spent.body.reason).toContain("allowance today")

      day(`${tomorrow}T00:00:01Z`)
      const reset = await check(server, "browser_automation")
      expect(reset.status).toBe(200)
      expect(reset.body.used).toBe(0)
      expect(reset.body.code).toBe("granted")
      // The spend is recorded against the new day and the elapsed key is dropped,
      // so the state file cannot accumulate one dead key per day forever.
      expect(Object.keys(countersOnDisk() ?? {})).toEqual([`browser_automation:${tomorrow}`])
      expect(countersOnDisk()?.[`browser_automation:${tomorrow}`]).toBe(1)
    } finally {
      await server.stop()
    }
  })

  test("a spent MONTHLY counter is not this capability's counter, and cannot refuse a daily allowance", async () => {
    // The migration case, through the route: counters written under the old
    // monthly key are ignored rather than obeyed, and reading them would keep
    // denying for a month.
    day(`${today}T12:00:00Z`)
    writeBillingState(billingFile, store("free", { "browser_automation:2026-03": 250 }))
    const server = await startServer()
    try {
      const answer = await check(server, "browser_automation")
      expect(`${answer.status} ${answer.body.code} used=${answer.body.used}`).toBe("200 granted used=0")
      expect(Object.keys(countersOnDisk() ?? {})).toEqual([`browser_automation:${today}`])
    } finally {
      await server.stop()
    }
  })

  test("pro browser automation stays monthly: a spent month does NOT refill at midnight", async () => {
    day(`${today}T12:00:00Z`)
    writeBillingState(billingFile, store("pro", { "browser_automation:2026-03": 2_000 }))
    const server = await startServer()
    try {
      const spent = await check(server, "browser_automation")
      // Soft metering, so it is still allowed - but a new day must not hand the
      // allowance back, which is the same confusion in the paid direction.
      expect(spent.status).toBe(200)
      expect(spent.body.code).toBe("limit_reached")
      expect(spent.body.allowed).toBe(true)
      expect(spent.body.used).toBe(2_000)
      expect(spent.body.reason).not.toContain("today")

      day(`${tomorrow}T00:00:01Z`)
      const nextDay = await check(server, "browser_automation")
      expect(nextDay.body.used).toBe(2_000)
      expect(nextDay.body.code).toBe("limit_reached")
      expect(Object.keys(countersOnDisk() ?? {})).toEqual(["browser_automation:2026-03"])
    } finally {
      await server.stop()
    }
  })

  test("a spent free vault-login month survives every day boundary inside that month", async () => {
    day("2026-01-15T12:00:00Z")
    writeBillingState(billingFile, store("free"))
    const server = await startServer()
    try {
      // Three logins is three for the billing period, spent through the route.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const allowed = await check(server, "vault_login")
        expect(`attempt ${attempt} -> ${allowed.status}`).toBe(`attempt ${attempt} -> 200`)
      }
      expect(Object.keys(countersOnDisk() ?? {})).toEqual(["vault_login:2026-01"])
      expect((await check(server, "vault_login")).status).toBe(402)

      day("2026-01-16T00:00:01Z")
      const secondDay = await check(server, "vault_login")
      expect(`${secondDay.status} used=${secondDay.body.used}`).toBe("402 used=3")
      day("2026-01-31T23:59:59Z")
      const lastDay = await check(server, "vault_login")
      expect(`${lastDay.status} used=${lastDay.body.used}`).toBe("402 used=3")
      // ...and it comes back only when the month rolls over.
      day("2026-02-01T00:00:01Z")
      const february = await check(server, "vault_login")
      expect(`${february.status} used=${february.body.used}`).toBe("200 used=0")
    } finally {
      await server.stop()
    }
  })

  test("the two periods draw on separate counters, so neither can starve the other", async () => {
    day(`${today}T12:00:00Z`)
    writeBillingState(billingFile, store("free", { [`browser_automation:${today}`]: 250, "vault_login:2026-03": 3 }))
    const server = await startServer()
    try {
      // Exhausted on both, and each refusal is about its own budget.
      const browser = await check(server, "browser_automation")
      expect(browser.body.reason).toContain("allowance today")
      const vault = await check(server, "vault_login")
      expect(vault.body.reason).not.toContain("today")
      expect(vault.body.reason).toContain("3/3")
      // A refusal on one capability never touches the other's key.
      expect(Object.keys(countersOnDisk() ?? {}).sort()).toEqual([
        `browser_automation:${today}`,
        "vault_login:2026-03",
      ])
    } finally {
      await server.stop()
    }
  })
})

describe("the store's bounds hold at the call site", () => {
  test("an oversized state file is answered from the bounded window, not the whole file", async () => {
    // A file nobody wrote this code: the read has to stop at the caps, and the
    // decision has to be about what survived. Recorded as observed, not endorsed:
    // the read keeps the OLDEST subscriptions, so the most recently added
    // subscriber is the one that loses the plan.
    writeBillingState(billingFile, {
      ...EMPTY_STATE,
      processedEvents: Array.from({ length: 1_200 }, (_, index) => `evt_${index}`),
      subscriptions: Array.from({ length: 6_000 }, (_, index) => ({
        customerId: `cus_${index}`,
        subscriptionId: `sub_${index}`,
        status: "active",
        plan: "pro",
        // Past the read cap, so this profile is the one the file's own bounds drop.
        profileId: index >= 5_000 ? "222222222" : String(1_000_000_000 + index),
        currentPeriodEnd: Date.parse("2099-01-01T00:00:00Z"),
      })),
    })
    const server = await startServer()
    try {
      // 6,000 subscriptions and 1,200 event ids in the file; the route answered.
      const oldest = await check(server, "input_freeze", { "x-omnia-profile": "1000000000" })
      expect(`oldest subscriber -> ${oldest.status} ${oldest.body.plan}`).toBe("oldest subscriber -> 200 pro")
      const newest = await check(server, "input_freeze", { "x-omnia-profile": "222222222" })
      expect(`newest subscriber -> ${newest.status} ${newest.body.plan}`).toBe("newest subscriber -> 402 free")
      // The counters survived the same read, so metering is unaffected by the
      // bounds above it.
      const read = readBillingState(billingFile)
      expect(read.subscriptions).toHaveLength(5_000)
      expect(read.processedEvents).toHaveLength(1_000)
    } finally {
      await server.stop()
    }
  })

  test("folding past the event window through the real webhook keeps the newest window and the record just applied", async () => {
    process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET
    process.env.STRIPE_PRICE_PRO = PRICE_PRO
    const server = await startServer()
    try {
      const timestamp = Math.floor(Date.now() / 1000)
      let lastStatus = 0
      // More events than the replay window remembers, so the cap is genuinely
      // reached rather than approached.
      for (let index = 0; index < 1_050; index += 1) {
        const body = JSON.stringify({
          id: `evt_${index}`,
          type: "customer.subscription.updated",
          created: index + 1,
          data: {
            object: {
              id: `sub_${index}`,
              customer: "cus_window",
              status: "active",
              current_period_end: 2_000_000_000,
              price: { id: PRICE_PRO },
              metadata: { profileId: PROFILE },
            },
          },
        })
        const response = await fetch(`${server.url}/v1/billing/stripe/webhook`, {
          method: "POST",
          headers: {
            "stripe-signature": `t=${timestamp},v1=${createHmac("sha256", WEBHOOK_SECRET).update(`${timestamp}.${body}`, "utf8").digest("hex")}`,
            "content-type": "application/json",
          },
          body,
        })
        lastStatus = response.status
        await response.text()
      }
      expect(lastStatus).toBe(200)
      const read = readBillingState(billingFile)
      // Bounded, and the NEWEST kept: a sliding window that trimmed the wrong end
      // would drop the event being applied and silently lose an upgrade.
      expect(read.processedEvents).toHaveLength(1_000)
      expect(read.processedEvents.at(-1)).toBe("evt_1049")
      expect(read.processedEvents).not.toContain("evt_0")
      // The subscription that was folded last is still there and still entitles.
      expect(read.subscriptions.at(-1)?.subscriptionId).toBe("sub_1049")
      const answer = await check(server, "input_freeze")
      expect(`after the cap -> ${answer.status} ${answer.body.plan}`).toBe("after the cap -> 200 pro")

      // A forgotten id is re-appliable, which is the price of the window; a
      // remembered one is still recognised. Both go through the same route.
      const replayOld = await webhook(server, "evt_0", `sub_replayed`, timestamp)
      expect(replayOld).toMatchObject({ ok: true, duplicate: false })
      const replayNew = await webhook(server, "evt_1049", `sub_replayed`, timestamp)
      expect(replayNew).toMatchObject({ ok: true, duplicate: true })
      expect(readBillingState(billingFile).processedEvents).toHaveLength(1_000)
    } finally {
      await server.stop()
    }
  }, 60_000)
})

// ---- helpers that need the matrix's own words, not plans.ts's ----------------

/** The counter key the route will read for this capability on this plan. */
function periodFor(capability: Capability, plan: PlanId): string {
  // The rule's own period decides the key shape, and browser_automation on free is
  // the only daily allowance in the matrix; everything else is drawn monthly.
  const daily: readonly Capability[] = plan === "free" ? ["browser_automation"] : []
  return daily.includes(capability) ? today() : thisMonth()
}

async function webhook(
  server: Server,
  eventId: string,
  subscriptionId: string,
  timestamp: number,
): Promise<Record<string, unknown>> {
  const body = JSON.stringify({
    id: eventId,
    type: "customer.subscription.updated",
    created: Math.floor(Date.now() / 1_000) + 5_000,
    data: {
      object: {
        id: subscriptionId,
        customer: "cus_window",
        status: "active",
        current_period_end: 2_000_000_000,
        price: { id: PRICE_PRO },
        metadata: { profileId: PROFILE },
      },
    },
  })
  const response = await fetch(`${server.url}/v1/billing/stripe/webhook`, {
    method: "POST",
    headers: {
      "stripe-signature": `t=${timestamp},v1=${createHmac("sha256", WEBHOOK_SECRET).update(`${timestamp}.${body}`, "utf8").digest("hex")}`,
      "content-type": "application/json",
    },
    body,
  })
  return (await response.json()) as Record<string, unknown>
}