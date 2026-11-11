// Enforcement at the two call sites that refuse a capability BEFORE the work
// happens, pinned as an enforcement contract rather than as a restatement of the
// plan table.
//
// There are two of them and the contract is the same for both:
//
//   1. THE DECISION PRECEDES THE OPERATION. A refusal that arrives after the grab
//      is installed is somebody's keyboard held until they pay. A refusal that
//      arrives after the credential is read is a secret already in memory for a
//      request nobody was entitled to make. So every test below asserts the
//      driver call count, not just the status code - the difference between "the
//      route refused" and "the route refused before touching the machine or the
//      vault".
//
//   2. THE STATUS SAYS WHICH OF TWO THINGS HAPPENED. 402 is a DECISION: this plan
//      does not include the capability, and paying fixes it. 503 is OUR outage:
//      we could not establish the allowance, and waiting fixes it. A control
//      plane answering 5xx is the second case, not the first - reporting an
//      outage as "not included in your plan" both lies to the customer and
//      applies free-plan policy to somebody who paid.
//
//   3. input_freeze IS NOT ONE OF THOSE CAPABILITIES ANY MORE. It is a safety
//      basic and unlimited on every plan, because the whole point of a freeze is
//      that a human can take the machine back: an agent that can click but whose
//      owner cannot safely reclaim the mouse is a hostage situation, not a
//      pricing tier. So the freeze route fails OPEN - allowed on free, allowed
//      during a 5xx, allowed after its own check deadline expires - and the
//      decision contract above is pinned on vault_login, which is still hard
//      metered on free and still refuses. What each gate does when it cannot
//      reach billing is asserted per gate below, because the two gates genuinely
//      disagree: api.ts judges the failure against a plan and can fail open,
//      computers.ts holds no plan at all and fails closed for everyone.
//
//   4. THE ESCAPE HATCH IS NEVER GATED. POST /v1/input/release is the way back
//      out of a grab, so it has to work while the freeze route is refusing, and
//      it has to work during our own outage. It asks billing nothing at all.
//
// The gate in api.ts and the gate in computers.ts do not agree about which
// question to ask the control plane, and the tests here pin what each of them
// actually does, including the two places where that difference costs something.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startOmniaServer } from "./server"
import { sessionProof } from "./api"
import { EventBus } from "./events"
import { PermissionManager, type ApprovalPolicy, type OmniaScope, type PermissionState } from "./permissions"
import { ComputerManager, type BrowserController, type ServerComputerDriver } from "./computers"
import { CredentialStore } from "../credentials"
import { EMPTY_STATE, applySubscription, readBillingState, writeBillingState } from "../billing/store"
import type { PlanId } from "../billing/plans"
import type { ActionResult, ComputerAction, Observation } from "../protocol"

type Server = Awaited<ReturnType<typeof startOmniaServer>>

const PROFILE_ID = 230746284
const PROFILE = String(PROFILE_ID)
const SECRET = "hunter2-must-not-be-read"

let dir = ""
let previous: Record<string, string | undefined> = {}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnia-enforcement-sites-"))
  previous = {
    OMNIA_SERVER_URL: process.env.OMNIA_SERVER_URL,
    OMNIA_SERVER_TOKEN: process.env.OMNIA_SERVER_TOKEN,
    OMNIA_BILLING_FILE: process.env.OMNIA_BILLING_FILE,
  }
  process.env.OMNIA_BILLING_FILE = join(dir, "billing.json")
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

/**
 * A driver that counts the two irreversible operations.
 *
 * `grabs` is the assertion that matters for the freeze route and `releases` is
 * the one that matters for the escape hatch: a refusal is only real if the
 * machine was left alone, and an escape hatch is only real if it reaches it.
 */
function createInputDriver(): { driver: ServerComputerDriver; calls: { grabs: number; releases: number } } {
  const calls = { grabs: 0, releases: 0 }
  const driver: ServerComputerDriver = {
    id: "local",
    backend: "test",
    getInfo: async () => ({ id: "local", name: "Test Computer", platform: "linux", backend: "test", connected: true }),
    capabilities: () => [],
    observe: async (): Promise<Observation> => ({ id: "obs-1", backend: "test", elements: [] }),
    find: async (request) => ({ query: request.query, matches: [] }),
    execute: async (action: ComputerAction): Promise<ActionResult> => ({
      success: true,
      status: "success",
      message: `Executed ${action.type}.`,
    }),
    grabInput: async () => {
      calls.grabs += 1
      return { success: true, status: "success", message: "Frozen.", frozen: true, supported: true, mode: "x11" }
    },
    releaseInput: async () => {
      calls.releases += 1
      return { success: true, status: "success", message: "Released.", frozen: false, supported: true, releasedBy: "request" }
    },
    inputGrabState: async () => ({
      success: true,
      status: "success",
      message: "State.",
      frozen: calls.grabs > 0,
      supported: true,
    }),
  }
  return { driver, calls }
}

/** A control plane that only ever answers one way, however it is asked. */
interface StubControlPlane {
  readonly url: string
  readonly stop: () => void
}

function answeringControlPlane(payload: Record<string, unknown>, status: number): StubControlPlane {
  const server = Bun.serve({ port: 0, fetch: () => Response.json(payload, { status }) })
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}

/**
 * A control plane that accepts the connection and then never says anything.
 *
 * Distinct from an unreachable one on purpose: here the request reaches a host
 * and dies waiting, so the only thing that can end the wait is the call site's
 * own deadline. That is the timeout case, and it cannot be faked with a 5xx.
 */
async function silentControlPlane(): Promise<StubControlPlane> {
  const listener = createServer(() => undefined)
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve))
  const address = listener.address()
  const port = typeof address === "object" && address !== null ? address.port : 0
  return { url: `http://127.0.0.1:${port}`, stop: () => void listener.close() }
}

/** The control plane, with a signed-in profile only when asked for one. */
async function startControlPlane(options: { signedIn?: boolean } = {}): Promise<Server> {
  const authFile = join(dir, options.signedIn === true ? "cp-signed-in.json" : "cp-nobody.json")
  if (options.signedIn === true) {
    writeFileSync(authFile, JSON.stringify({ profile: { id: PROFILE_ID, login: "tester" }, token: "", signedInAt: 0 }))
  }
  return startOmniaServer({
    authFile,
    credentialsFile: join(dir, "cp-credentials.json"),
    memoryFile: join(dir, "cp-memories.json"),
    superskillFile: join(dir, "cp-superskills.json"),
    pairingsFile: join(dir, "cp-pairings.json"),
    computerUseFile: join(dir, "cp-computer-use.json"),
  })
}

/** Puts the signed-in profile on a live subscription, through the real store. */
function subscribe(plan: PlanId): void {
  writeBillingState(
    join(dir, "billing.json"),
    applySubscription(
      EMPTY_STATE,
      {
        customerId: "cus_sites",
        subscriptionId: `sub_${plan}`,
        status: "active",
        profileId: PROFILE,
        currentPeriodEnd: Date.now() + 86_400_000 * 30,
      },
      plan,
      `evt_sites_${plan}`,
    ).state,
  )
}

/** A server with a signed-in profile, pointed at a control plane the way a desktop sidecar is. */
async function startGated(controlPlane: Server, driver: ServerComputerDriver): Promise<Server> {
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ profile: { id: PROFILE_ID, login: "tester" }, token: "", signedInAt: 0 }))
  process.env.OMNIA_SERVER_URL = controlPlane.url
  process.env.OMNIA_SERVER_TOKEN = controlPlane.token
  return startOmniaServer({ drivers: [driver], authFile: join(dir, "auth.json") })
}

async function post(
  server: Server,
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${server.url}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

describe("POST /v1/input/freeze: billing is consulted before the grab, and cannot take it away", () => {
  test("a free plan is allowed and the grab happens: reclaiming the mouse is a basic, not a feature", async () => {
    const controlPlane = await startControlPlane()
    try {
      const { driver, calls } = createInputDriver()
      const server = await startGated(controlPlane, driver)
      try {
        // The gate really was asked, and the answer it got is the one a free
        // customer is entitled to. Read without consuming, so this probe is not
        // itself the usage the freeze below records.
        const answered = await post(
          controlPlane,
          "/v1/billing/check",
          { capability: "input_freeze", consume: false },
          { "x-omnia-profile": PROFILE },
        )
        expect(answered.status).toBe(200)
        expect(answered.body).toMatchObject({
          allowed: true,
          code: "granted",
          capability: "input_freeze",
          plan: "free",
          metering: "soft",
        })
        const allowed = await post(server, "/v1/input/freeze", { computerId: "local", reason: "agent task" })
        expect(allowed.status).toBe(200)
        expect(allowed.body).toEqual({ ok: true, frozen: true, mode: "x11" })
        // The assertion that still has teeth in the other direction: the machine
        // WAS touched. A refusal that arrives after the grab is installed is a
        // keyboard held until somebody pays, so this route must be the last
        // thing that decides, and on free it decides yes.
        expect(calls.grabs).toBe(1)
        const state = await fetch(`${server.url}/v1/input/state?computerId=local`, {
          headers: { authorization: `Bearer ${server.token}` },
        })
        expect(await state.json()).toMatchObject({ ok: true, frozen: true })
      } finally {
        await server.stop()
      }
    } finally {
      await controlPlane.stop()
    }
  })

  test("a control plane that answers 5xx is not a decision, and a safety basic is served anyway", async () => {
    // The same distinction as before, with the answer it now has to give. The
    // gate reads anything but 200/402 as OUR failure, and what it does with a
    // failure is plans.ts's call: input_freeze is a soft allowance on every plan,
    // so it fails open. A hard allowance in the same 500 is still refused as
    // 503 - pinned on vault_login below, which is exactly the case this route
    // used to be standing in for.
    const broken = answeringControlPlane({ ok: false, error: "upstream is unwell" }, 500)
    const { driver, calls } = createInputDriver()
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ profile: { id: PROFILE_ID, login: "tester" }, token: "", signedInAt: 0 }))
    process.env.OMNIA_SERVER_URL = broken.url
    process.env.OMNIA_SERVER_TOKEN = "token"
    const server = await startOmniaServer({ drivers: [driver], authFile: join(dir, "auth.json") })
    try {
      const allowed = await post(server, "/v1/input/freeze", { computerId: "local" })
      expect(allowed.status).toBe(200)
      expect(calls.grabs).toBe(1)
    } finally {
      await server.stop()
      broken.stop()
    }
  })

  test("a paid plan does not lose the capability when the control plane is unreachable", async () => {
    // THE GAP, and it now points the other way. This gate holds no memory of
    // which plan the customer is on - `lastKnownPlan` is a local of a single
    // call - so a failure is judged against `free`. That used to be the reason a
    // pro customer was refused input_freeze during our own outage, with `plan:
    // "free"` in the body telling them they were on the free plan. With
    // input_freeze unlimited on free it is the reason everybody's freeze
    // survives one: a soft allowance on free fails open, and the 503 that used to
    // name the wrong plan is unreachable here, because only a capability that is
    // hard on free can arm it and this route gates none.
    subscribe("pro")
    const { driver, calls } = createInputDriver()
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ profile: { id: PROFILE_ID, login: "tester" }, token: "", signedInAt: 0 }))
    process.env.OMNIA_SERVER_URL = "http://127.0.0.1:1"
    process.env.OMNIA_SERVER_TOKEN = "token"
    const server = await startOmniaServer({ drivers: [driver], authFile: join(dir, "auth.json") })
    try {
      const allowed = await post(server, "/v1/input/freeze", { computerId: "local" })
      expect(allowed.status).toBe(200)
      expect(allowed.body).toEqual({ ok: true, frozen: true, mode: "x11" })
      expect(calls.grabs).toBe(1)
    } finally {
      await server.stop()
    }
  })

  test("a control plane that never answers cannot hold a safety basic hostage", async () => {
    // The timeout rather than the transport failure. The gate's own deadline
    // (CAPABILITY_CHECK_TIMEOUT_MS) is the only thing that can end this wait,
    // and what it answers when the deadline passes is still yes: a hung billing
    // service must not be able to freeze the route that hands the machine back.
    const silent = await silentControlPlane()
    const { driver, calls } = createInputDriver()
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ profile: { id: PROFILE_ID, login: "tester" }, token: "", signedInAt: 0 }))
    process.env.OMNIA_SERVER_URL = silent.url
    process.env.OMNIA_SERVER_TOKEN = "token"
    const server = await startOmniaServer({ drivers: [driver], authFile: join(dir, "auth.json") })
    try {
      const asked = Date.now()
      const allowed = await post(server, "/v1/input/freeze", { computerId: "local" })
      expect(allowed.status).toBe(200)
      expect(calls.grabs).toBe(1)
      // The wait really happened, so the 200 above is a deadline that expired
      // rather than a control plane that happened to answer.
      expect(Date.now() - asked).toBeGreaterThanOrEqual(4_000)
    } finally {
      await server.stop()
      silent.stop()
    }
  }, 30_000)

  test("a 402 from the control plane IS a decision, and it still comes before the grab", async () => {
    // The free plan can no longer produce this answer for input_freeze, so the
    // stub does. What is under test is the gate's shape, which the matrix change
    // does not touch: a decision is honoured, it names the capability and the
    // plan, and the machine is left alone. The same wire contract is what a real
    // paid capability gets - see vault_login below.
    const refusing = answeringControlPlane(
      {
        ok: false,
        allowed: false,
        code: "not_entitled",
        capability: "input_freeze",
        plan: "free",
        used: 0,
        limit: 0,
        metering: "hard",
        reason: "input_freeze is not included in the free plan.",
      },
      402,
    )
    const { driver, calls } = createInputDriver()
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ profile: { id: PROFILE_ID, login: "tester" }, token: "", signedInAt: 0 }))
    process.env.OMNIA_SERVER_URL = refusing.url
    process.env.OMNIA_SERVER_TOKEN = "token"
    const server = await startOmniaServer({ drivers: [driver], authFile: join(dir, "auth.json") })
    try {
      const refused = await post(server, "/v1/input/freeze", { computerId: "local", reason: "agent task" })
      expect(refused.status).toBe(402)
      expect(refused.body).toEqual({
        ok: false,
        error: {
          code: "capability_not_entitled",
          message: expect.stringContaining("input_freeze") as unknown as string,
          capability: "input_freeze",
          plan: "free",
          // Upgrading fixes this one. Retrying does not, and a client that
          // retries a 402 forever is a support ticket instead of an upgrade.
          retryable: false,
        },
      })
      expect((refused.body.error as { message: string }).message).toContain("plan: free")
      expect(calls.grabs).toBe(0)
      const state = await fetch(`${server.url}/v1/input/state?computerId=local`, {
        headers: { authorization: `Bearer ${server.token}` },
      })
      expect(await state.json()).toMatchObject({ ok: true, frozen: false })
    } finally {
      await server.stop()
      refusing.stop()
    }
  })

  test("billing no longer refusing leaves the permission gate as the last word on the grab", async () => {
    // With free included, the ordering this route documents is no longer
    // observable here: nothing about this request can produce a billing refusal,
    // so the permission gate is the only thing left between it and the machine.
    // That is still worth pinning - an agent-originated freeze with UI_CONTROL
    // unapproved is 428 and grabs nothing, while the desktop's own freeze is
    // allowed through. The "billing before approval" ordering itself is pinned
    // against vault_login in the driver gate below, where a refusal still exists.
    const controlPlane = await startControlPlane()
    try {
      const { driver, calls } = createInputDriver()
      writeFileSync(join(dir, "auth.json"), JSON.stringify({ profile: { id: PROFILE_ID, login: "tester" }, token: "", signedInAt: 0 }))
      process.env.OMNIA_SERVER_URL = controlPlane.url
      process.env.OMNIA_SERVER_TOKEN = controlPlane.token
      const server = await startOmniaServer({
        drivers: [driver],
        authFile: join(dir, "auth.json"),
        permissions: { UI_CONTROL: "prompt" },
      })
      try {
        const asAgent = await post(server, "/v1/input/freeze", { computerId: "local" }, { "x-omnia-origin": "agent" })
        expect(asAgent.status).toBe(428)
        expect(calls.grabs).toBe(0)
        const asOperator = await post(server, "/v1/input/freeze", { computerId: "local" })
        expect(asOperator.status).toBe(200)
        expect(calls.grabs).toBe(1)
      } finally {
        await server.stop()
      }
    } finally {
      await controlPlane.stop()
    }
  })

  test("the asking profile is forwarded, so the usage is charged to THAT plan", async () => {
    // The control plane here has nobody signed in - the shape of a shared
    // control plane serving many desktops. Entitlements are per profile, so the
    // gate has to name whose plan it is asking about; if it did not, every
    // desktop on the host would be answered for the anonymous free plan.
    //
    // input_freeze is unlimited on every plan, so the status code can no longer
    // tell the two answers apart - and a 200 that proves nothing is worse than
    // no assertion. The billing store can: the counter lands under the forwarded
    // profile, and `consume` declines to record anything at all when there is no
    // profile, so this is empty if the header is not sent.
    const controlPlane = await startControlPlane()
    try {
      subscribe("pro")
      const { driver, calls } = createInputDriver()
      const server = await startGated(controlPlane, driver)
      try {
        const allowed = await post(server, "/v1/input/freeze", { computerId: "local" })
        expect(allowed.status).toBe(200)
        expect(calls.grabs).toBe(1)
        const usage = readBillingState(join(dir, "billing.json")).usage
        expect(Object.keys(usage)).toEqual([PROFILE])
        const counters = usage[PROFILE]?.counters ?? {}
        expect(Object.keys(counters).filter((key) => key.startsWith("input_freeze:"))).toHaveLength(1)
        expect(Object.values(counters)).toEqual([1])
      } finally {
        await server.stop()
      }
    } finally {
      await controlPlane.stop()
    }
  })
})

describe("POST /v1/input/release: never gated, including during our own outage", () => {
  test("a refused freeze does not trap the caller: release reaches the driver", async () => {
    // The freeze above that the free plan can no longer produce, so the stub
    // refuses. Release asks billing nothing, and the way out has to work while
    // the way in is being refused - refusing the way out is strictly worse than
    // never allowing the way in.
    const refusing = answeringControlPlane(
      {
        ok: false,
        allowed: false,
        code: "not_entitled",
        capability: "input_freeze",
        plan: "free",
        used: 0,
        limit: 0,
        metering: "hard",
        reason: "input_freeze is not included in the free plan.",
      },
      402,
    )
    const { driver, calls } = createInputDriver()
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ profile: { id: PROFILE_ID, login: "tester" }, token: "", signedInAt: 0 }))
    process.env.OMNIA_SERVER_URL = refusing.url
    process.env.OMNIA_SERVER_TOKEN = "token"
    const server = await startOmniaServer({ drivers: [driver], authFile: join(dir, "auth.json") })
    try {
      expect((await post(server, "/v1/input/freeze", { computerId: "local" })).status).toBe(402)
      expect(calls.grabs).toBe(0)
      const released = await post(server, "/v1/input/release", { computerId: "local" })
      expect(released.status).toBe(200)
      expect(released.body).toMatchObject({ ok: true, frozen: false })
      expect(calls.releases).toBe(1)
    } finally {
      await server.stop()
      refusing.stop()
    }
  })

  test("release works while billing is completely unreachable", async () => {
    // The case that is easy to get wrong: gating release "for symmetry" with
    // freeze. During our own outage the freeze route fails OPEN and installs the
    // grab anyway, so a customer whose grab is already installed needs the way
    // out more urgently than ever, not less - and the route serving the way in
    // is exactly the route that cannot be trusted to serve the way out.
    const { driver, calls } = createInputDriver()
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ profile: { id: PROFILE_ID, login: "tester" }, token: "", signedInAt: 0 }))
    process.env.OMNIA_SERVER_URL = "http://127.0.0.1:1"
    process.env.OMNIA_SERVER_TOKEN = "token"
    const server = await startOmniaServer({ drivers: [driver], authFile: join(dir, "auth.json") })
    try {
      expect((await post(server, "/v1/input/freeze", { computerId: "local" })).status).toBe(200)
      expect(calls.grabs).toBe(1)
      const released = await post(server, "/v1/input/release", { computerId: "local" })
      expect(released.status).toBe(200)
      expect(released.body).toMatchObject({ ok: true, frozen: false, releasedBy: "request" })
      expect(calls.releases).toBe(1)
    } finally {
      await server.stop()
    }
  })

  test("release works on an install that never configured billing at all", async () => {
    const { driver, calls } = createInputDriver()
    const server = await startOmniaServer({ drivers: [driver], authFile: join(dir, "auth.json") })
    try {
      const released = await post(server, "/v1/input/release", { computerId: "local" })
      expect(released.status).toBe(200)
      expect(calls.releases).toBe(1)
    } finally {
      await server.stop()
    }
  })

  test("release is not gated, but it is still permission-checked", async () => {
    // Un-gated must not mean un-checked: an agent-originated release with
    // UI_CONTROL denied is still refused, so releasing is not a way around the
    // permission model either.
    const controlPlane = await startControlPlane()
    try {
      const { driver, calls } = createInputDriver()
      writeFileSync(join(dir, "auth.json"), JSON.stringify({ profile: { id: PROFILE_ID, login: "tester" }, token: "", signedInAt: 0 }))
      process.env.OMNIA_SERVER_URL = controlPlane.url
      process.env.OMNIA_SERVER_TOKEN = controlPlane.token
      const server = await startOmniaServer({
        drivers: [driver],
        authFile: join(dir, "auth.json"),
        permissions: { UI_CONTROL: "denied" },
      })
      try {
        const denied = await post(server, "/v1/input/release", { computerId: "local" }, { "x-omnia-origin": "agent" })
        expect(denied.status).toBe(403)
        expect(calls.releases).toBe(0)
      } finally {
        await server.stop()
      }
    } finally {
      await controlPlane.stop()
    }
  })
})

// ---- the driver gate in computers.ts -------------------------------------------------

/**
 * A credential store that counts reads.
 *
 * A real store with real records; only the read entry points are counted, because
 * "the vault was not touched" is otherwise unobservable from outside and the
 * whole point of this gate is that it runs before the read.
 */
class CountingCredentials extends CredentialStore {
  reads = 0
  override get(id: string) {
    this.reads += 1
    return super.get(id)
  }
  override list(computerId?: string) {
    this.reads += 1
    return super.list(computerId)
  }
  override match(query: Parameters<CredentialStore["match"]>[0]) {
    this.reads += 1
    return super.match(query)
  }
}

function createBrowser(): BrowserController {
  return {
    status: async () => ({ running: true, browser: "test", tabs: 1 }),
    open: async (url) => ({ id: "tab-1", url: url ?? "about:blank" }),
    tabs: async () => [{ id: "tab-1", url: "https://example.com" }],
    activate: async () => undefined,
    closeTab: async () => undefined,
    navigate: async (_url, tabId) => ({ id: tabId ?? "tab-1", url: "https://example.com" }),
    read: async () => ({ url: "https://example.com", title: "Login", text: "sign in", length: 7, hash: "hash-1" }),
    find: async () => [
      { id: "field-1", role: "textbox", name: "Email", visible: true, disabled: false, score: 1 },
      { id: "field-2", role: "textbox", name: "Password", visible: true, disabled: false, score: 1 },
    ],
    click: async () => ({ clicked: true, name: "Sign in", role: "button" }),
    type: async () => ({ typed: true }),
    readValue: async () => ({}),
    key: async () => undefined,
    back: async () => undefined,
    forward: async () => undefined,
    reload: async () => undefined,
  }
}

async function createDriverHarness(
  options: {
    readonly permissions?: Partial<Record<OmniaScope, PermissionState>>
    readonly approvalPolicy?: ApprovalPolicy
  } = {},
): Promise<{
  manager: ComputerManager
  credentials: CountingCredentials
  credentialId: string
  navigations: () => number
}> {
  let navigations = 0
  const driver: ServerComputerDriver = {
    id: "local",
    backend: "test",
    getInfo: async () => ({ id: "local", name: "Test Computer", platform: "linux", backend: "test", connected: true }),
    capabilities: () => [],
    observe: async (): Promise<Observation> => ({ id: "obs-1", backend: "test", elements: [] }),
    find: async (request) => ({ query: request.query, matches: [] }),
    execute: async (action: ComputerAction): Promise<ActionResult> => ({
      success: true,
      status: "success",
      message: `Executed ${action.type}.`,
    }),
  }
  const credentials = new CountingCredentials({ file: join(dir, "driver-credentials.json") })
  const manager = new ComputerManager({
    events: new EventBus({ serverId: "test" }),
    permissions: new PermissionManager(
      options.permissions ?? { SECRETS: "prompt" },
      options.approvalPolicy ?? "fully_autonomous",
    ),
    credentials,
    browser: {
      ...createBrowser(),
      navigate: async (url, tabId) => {
        navigations += 1
        return { id: tabId ?? "tab-1", url: url ?? "https://example.com" }
      },
    },
  })
  manager.register(driver)
  const credential = credentials.save({ computerId: "local", name: "login", secret: SECRET, username: "krishna" })
  const opened = await manager.execute("local", {
    action: "browser_open",
    url: "https://example.com",
    ...APPROVAL,
    approvedScopes: ["BROWSER"],
  })
  expect(opened.httpStatus).toBe(200)
  expect(opened.result.success).toBe(true)
  // Setup is outside the operation under test; denial counters start at zero.
  credentials.reads = 0
  navigations = 0
  return { manager, credentials, credentialId: credential.id, navigations: () => navigations }
}

const APPROVAL = {
  approve: true,
  approvedBy: "session:test",
  sessionId: "session-1",
  approvedScopes: ["UI_CONTROL", "BROWSER", "KEYBOARD", "SECRETS"],
} as const

/** A browser_login the way an agent asks for one: nothing pre-approved. */
function agentLogin(harness: Awaited<ReturnType<typeof createDriverHarness>>): Parameters<ComputerManager["execute"]>[1] {
  return { action: "browser_login", credential: harness.credentialId, sessionId: APPROVAL.sessionId, origin: "agent" }
}

/** Spends the free vault_login allowance the way a real caller would. */
async function spendVaultLogin(controlPlane: Server, times: number): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await post(controlPlane, "/v1/billing/check", { capability: "vault_login" }, { "x-omnia-profile": PROFILE })
  }
}

describe("the driver gate refuses a stored-credential login before the vault is read", () => {
  test("a spent hard allowance is a 402 naming the capability and the plan, with zero vault reads", async () => {
    // vault_login is the capability this file's decision contract is pinned on:
    // still hard metered on free (three a month), so a decision still exists.
    // The control plane has the profile signed in, so the gate's question
    // resolves against this customer's own allowance.
    const controlPlane = await startControlPlane({ signedIn: true })
    try {
      process.env.OMNIA_SERVER_URL = controlPlane.url
      process.env.OMNIA_SERVER_TOKEN = controlPlane.token
      await spendVaultLogin(controlPlane, 3)
      const harness = await createDriverHarness()
      harness.credentials.reads = 0
      const outcome = await harness.manager.execute("local", {
        action: "browser_login",
        credential: harness.credentialId,
        ...APPROVAL,
        approvedScopes: [...APPROVAL.approvedScopes],
      })
      expect(outcome.httpStatus).toBe(402)
      expect(outcome.result.success).toBe(false)
      expect(outcome.result.error).toMatchObject({ code: "capability_not_entitled" })
      // ActionResult has no details bag, so the capability and the plan have to
      // be in the message: a refusal the user cannot act on is a support ticket
      // instead of an upgrade.
      expect((outcome.result.error as { message: string }).message).toBe(
        "vault_login has used its free allowance (3/3). (vault_login, plan: free)",
      )
      expect(outcome.result.message).toContain("vault_login")
      // THE assertion. The secret never came out of the store, and the browser
      // was never driven.
      expect(harness.credentials.reads).toBe(0)
      expect(harness.navigations()).toBe(0)
      // ...and the secret is nowhere in what came back.
      expect(JSON.stringify(outcome.result)).not.toContain(SECRET)
    } finally {
      await controlPlane.stop()
    }
  })

  test("billing is consulted before the operator is asked to approve anything", async () => {
    // Moved here from the freeze route, which can no longer produce the
    // contrast: input_freeze is included on free, so nothing about an
    // unapproved agent freeze can show which of the two gates ran first. A
    // browser_login is the case that has both - it needs the SECRETS approval
    // AND the entitlement, so an operator must never be asked to approve a
    // login that billing is about to refuse.
    const controlPlane = await startControlPlane({ signedIn: true })
    try {
      process.env.OMNIA_SERVER_URL = controlPlane.url
      process.env.OMNIA_SERVER_TOKEN = controlPlane.token
      await spendVaultLogin(controlPlane, 3)
      const harness = await createDriverHarness({
        permissions: { BROWSER: "prompt", SECRETS: "prompt" },
        approvalPolicy: "ask_destructive",
      })
      harness.credentials.reads = 0
      const refused = await harness.manager.execute("local", agentLogin(harness))
      // 402, not 428: the entitlement was settled first, and the vault was not
      // read and the browser not driven to reach that answer.
      expect(refused.httpStatus).toBe(402)
      expect(refused.result.error).toMatchObject({ code: "capability_not_entitled" })
      expect(harness.credentials.reads).toBe(0)
      expect(harness.navigations()).toBe(0)
      // Pro's vault_login is a soft monthly allowance, so this customer is
      // entitled again and the very same unapproved request now stops at the
      // permission gate - which is what proves the 402 above was billing's
      // answer and not a permission answer in disguise.
      subscribe("pro")
      const unapproved = await harness.manager.execute("local", agentLogin(harness))
      expect(unapproved.httpStatus).toBe(428)
      expect(unapproved.result.error).toMatchObject({ code: "permission_required" })
      expect(harness.navigations()).toBe(0)
    } finally {
      await controlPlane.stop()
    }
  })

  test("an unreachable control plane is a retryable 503, and still reads nothing", async () => {
    process.env.OMNIA_SERVER_URL = "http://127.0.0.1:1"
    process.env.OMNIA_SERVER_TOKEN = "token"
    const harness = await createDriverHarness()
    harness.credentials.reads = 0
    const outcome = await harness.manager.execute("local", {
      action: "browser_login",
      credential: harness.credentialId,
      ...APPROVAL,
      approvedScopes: [...APPROVAL.approvedScopes],
    })
    expect(outcome.httpStatus).toBe(503)
    expect(outcome.result.error).toMatchObject({ code: "entitlement_unavailable", retryable: true })
    // Our problem, named as ours: "try again shortly" rather than "upgrade".
    expect((outcome.result.error as { message: string }).message).toContain("This is our problem, not yours")
    expect((outcome.result.error as { message: string }).message).toContain("vault_login")
    expect(harness.credentials.reads).toBe(0)
    expect(harness.navigations()).toBe(0)
  })

  test("a control plane that answers 5xx is OUR outage too: 503, retryable, and still reads nothing", async () => {
    // Ported from the freeze route, which can no longer fail closed for anything.
    // A hard allowance has no counter to be trusted, so a 500 is refused as ours
    // rather than reported as a decision the customer has to pay to change.
    const broken = answeringControlPlane({ ok: false, error: "upstream is unwell" }, 500)
    try {
      process.env.OMNIA_SERVER_URL = broken.url
      process.env.OMNIA_SERVER_TOKEN = "token"
      const harness = await createDriverHarness()
      harness.credentials.reads = 0
      const outcome = await harness.manager.execute("local", {
        action: "browser_login",
        credential: harness.credentialId,
        ...APPROVAL,
        approvedScopes: [...APPROVAL.approvedScopes],
      })
      expect(outcome.httpStatus).toBe(503)
      expect(outcome.result.error).toMatchObject({ code: "entitlement_unavailable", retryable: true })
      expect((outcome.result.error as { message: string }).message).toContain("This is our problem, not yours")
      expect(harness.credentials.reads).toBe(0)
      expect(harness.navigations()).toBe(0)
    } finally {
      broken.stop()
    }
  })

  test("a control plane that never answers is OUR outage at the gate's own deadline", async () => {
    // The timeout rather than the transport failure, and the reason this gate
    // carries its own five second ceiling: a hung billing service must not hang
    // the action. Same 503 as any other unconfirmed allowance, because the cause
    // is the same - the counter cannot be established.
    const silent = await silentControlPlane()
    try {
      process.env.OMNIA_SERVER_URL = silent.url
      process.env.OMNIA_SERVER_TOKEN = "token"
      const harness = await createDriverHarness()
      harness.credentials.reads = 0
      const asked = Date.now()
      const outcome = await harness.manager.execute("local", {
        action: "browser_login",
        credential: harness.credentialId,
        ...APPROVAL,
        approvedScopes: [...APPROVAL.approvedScopes],
      })
      expect(Date.now() - asked).toBeGreaterThanOrEqual(4_000)
      expect(outcome.httpStatus).toBe(503)
      expect(outcome.result.error).toMatchObject({ code: "entitlement_unavailable", retryable: true })
      expect(harness.credentials.reads).toBe(0)
      expect(harness.navigations()).toBe(0)
    } finally {
      silent.stop()
    }
  }, 30_000)

  test("a paying customer is refused an allowance they are entitled to, because this gate holds no plan", async () => {
    // THE GAP, one layer down from where the api.ts gate used to hold it and
    // still open. Pro entitles its holder to 300 soft vault_logins a month, and
    // the control plane says so while it is reachable; this gate answers the same
    // outage for the same customer with 503, because it holds no plan at all
    // rather than judging the failure against one. api.ts's `unconfirmed` fails
    // open for a soft allowance on a paid plan - which is why input_freeze
    // survives an outage above and this login does not. The canonical client
    // (../billing/client, which the browser and CUA gates use) remembers the plan
    // the control plane last named and fails open as well; see
    // enforcement-contract.test.ts for the client half.
    const controlPlane = await startControlPlane({ signedIn: true })
    try {
      subscribe("pro")
      const entitled = await post(
        controlPlane,
        "/v1/billing/check",
        { capability: "vault_login", consume: false },
        { "x-omnia-profile": PROFILE },
      )
      expect(entitled.body).toMatchObject({
        allowed: true,
        code: "granted",
        plan: "pro",
        capability: "vault_login",
        limit: 300,
        metering: "soft",
      })
      process.env.OMNIA_SERVER_URL = "http://127.0.0.1:1"
      process.env.OMNIA_SERVER_TOKEN = controlPlane.token
      const harness = await createDriverHarness()
      harness.credentials.reads = 0
      const outcome = await harness.manager.execute("local", {
        action: "browser_login",
        credential: harness.credentialId,
        ...APPROVAL,
        approvedScopes: [...APPROVAL.approvedScopes],
      })
      expect(outcome.httpStatus).toBe(503)
      expect(outcome.result.error).toMatchObject({ code: "entitlement_unavailable", retryable: true })
      expect(harness.credentials.reads).toBe(0)
      expect(harness.navigations()).toBe(0)
    } finally {
      await controlPlane.stop()
    }
  })

  test("no control plane configured leaves a local install working", async () => {
    // An install that never opted into billing has nothing to enforce. Refusing
    // here would break every self-hosted and desktop install in the product.
    delete process.env.OMNIA_SERVER_URL
    delete process.env.OMNIA_SERVER_TOKEN
    const harness = await createDriverHarness()
    harness.credentials.reads = 0
    const outcome = await harness.manager.execute("local", {
      action: "browser_login",
      credential: harness.credentialId,
      ...APPROVAL,
      approvedScopes: [...APPROVAL.approvedScopes],
    })
    expect(outcome.httpStatus).toBe(200)
    expect(outcome.result.error).toBeUndefined()
    expect(harness.credentials.reads).toBeGreaterThan(0)
  })

  test("an entitled login does read the vault, so the refusal above is the gate and not the harness", async () => {
    const controlPlane = await startControlPlane({ signedIn: true })
    try {
      process.env.OMNIA_SERVER_URL = controlPlane.url
      process.env.OMNIA_SERVER_TOKEN = controlPlane.token
      const harness = await createDriverHarness()
      harness.credentials.reads = 0
      const outcome = await harness.manager.execute("local", {
        action: "browser_login",
        credential: harness.credentialId,
        ...APPROVAL,
        approvedScopes: [...APPROVAL.approvedScopes],
      })
      expect(outcome.httpStatus).toBe(200)
      expect(outcome.result.error).toBeUndefined()
      expect(harness.credentials.reads).toBeGreaterThan(0)
    } finally {
      await controlPlane.stop()
    }
  })
})

describe("what the driver gate does not cover", () => {
  test("it asks the control plane without naming the asking profile", async () => {
    // THE SECOND GAP, pinned as observed. This gate sends the capability and
    // nothing else, so the control plane resolves the answer from its OWN
    // signed-in profile - and for a shared control plane, from nobody at all.
    //
    // A free customer's vault_login allowance is already spent to zero above.
    // Point this gate at a control plane with nobody signed in and the same
    // request is granted, because the answer is about an anonymous profile whose
    // allowance is untouched - and nothing is ever recorded against the customer
    // either, so this call site can never exhaust the allowance it is checking.
    const spent = await startControlPlane({ signedIn: true })
    try {
      process.env.OMNIA_SERVER_URL = spent.url
      process.env.OMNIA_SERVER_TOKEN = spent.token
      await spendVaultLogin(spent, 3)
      const harness = await createDriverHarness()
      harness.credentials.reads = 0
      const refused = await harness.manager.execute("local", {
        action: "browser_login",
        credential: harness.credentialId,
        ...APPROVAL,
        approvedScopes: [...APPROVAL.approvedScopes],
      })
      expect(refused.httpStatus).toBe(402)
    } finally {
      await spent.stop()
    }

    const anonymous = await startControlPlane()
    try {
      process.env.OMNIA_SERVER_URL = anonymous.url
      process.env.OMNIA_SERVER_TOKEN = anonymous.token
      const harness = await createDriverHarness()
      harness.credentials.reads = 0
      const granted = await harness.manager.execute("local", {
        action: "browser_login",
        credential: harness.credentialId,
        ...APPROVAL,
        approvedScopes: [...APPROVAL.approvedScopes],
      })
      expect(granted.httpStatus).toBe(200)
      expect(granted.result.error).toBeUndefined()
      // The customer whose allowance is spent had their secret read anyway.
      expect(harness.credentials.reads).toBeGreaterThan(0)
      // And the check itself spent nothing: the counter is the one the direct
      // calls left behind.
      const answer = await post(anonymous, "/v1/billing/check", { capability: "vault_login" }, {
        "x-omnia-profile": PROFILE,
      })
      expect(answer.body.used).toBe(3)
    } finally {
      await anonymous.stop()
    }
  })

  test("a browser action with no credential attached never reaches the gate at all", async () => {
    // The third gap, and the largest: this gate fires only for actions carrying
    // a `credential`, so agent-originated browser work that drives the embedded
    // browser without one - navigate, click, read - is never metered at this call
    // site even though browser_automation is a hard 500-a-day allowance on free.
    // The control plane here would refuse every capability it is asked about -
    // including the ones free no longer refuses, since it is not reading the plan
    // table - and it is never asked, which is the proof.
    const asked: string[] = []
    const controlPlane = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url)
        asked.push(url.pathname)
        const capability = ((await request.json().catch(() => ({}))) as { capability?: string }).capability ?? "browser_automation"
        return Response.json({
          ok: false,
          allowed: false,
          code: "not_entitled",
          capability,
          plan: "free",
          used: 0,
          limit: 0,
          metering: "hard",
          reason: `${capability} is not included in the free plan.`,
        })
      },
    })
    try {
      writeFileSync(join(dir, "auth.json"), JSON.stringify({ profile: { id: PROFILE_ID, login: "tester" }, token: "", signedInAt: 0 }))
      process.env.OMNIA_SERVER_URL = `http://127.0.0.1:${controlPlane.port}`
      process.env.OMNIA_SERVER_TOKEN = "token"
      let navigations = 0
      const driver: ServerComputerDriver = {
        id: "local",
        backend: "test",
        getInfo: async () => ({ id: "local", name: "Test", platform: "linux", backend: "test", connected: true }),
        capabilities: () => [],
        observe: async (): Promise<Observation> => ({ id: "obs-1", backend: "test", elements: [] }),
        find: async (request) => ({ query: request.query, matches: [] }),
        execute: async (action: ComputerAction): Promise<ActionResult> => ({
          success: true,
          status: "success",
          message: `Executed ${action.type}.`,
        }),
      }
      const server = await startOmniaServer({
        drivers: [driver],
        browser: {
          ...createBrowser(),
          navigate: async (url, tabId) => {
            navigations += 1
            return { id: tabId ?? "tab-1", url: url ?? "https://example.com" }
          },
        },
        authFile: join(dir, "auth.json"),
        permissions: { BROWSER: "granted" },
      })
      try {
        const opened = await server.computers.execute("local", {
          action: "browser_open",
          url: "https://example.com",
          ...APPROVAL,
          approvedScopes: ["BROWSER"],
        })
        expect(opened.httpStatus).toBe(200)
        expect(opened.result.success).toBe(true)
        navigations = 0
        asked.length = 0
        const response = await fetch(`${server.url}/v1/computers/local/actions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${server.token}`,
            "content-type": "application/json",
            "x-omnia-origin": "agent",
            "x-omnia-session": APPROVAL.sessionId,
            "x-omnia-session-proof": sessionProof(server.token, APPROVAL.sessionId),
          },
          body: JSON.stringify({
            action: "browser_navigate",
            url: "https://example.com",
            approve: true,
            approvedBy: "session:test",
            approvedScopes: ["BROWSER"],
          }),
        })
        expect(response.status).toBe(200)
        expect(navigations).toBe(1)
        // The billing service was never asked about a capability this call site
        // is supposed to be metering.
        expect(asked).toEqual([])
      } finally {
        await server.stop()
      }
    } finally {
      controlPlane.stop(true)
    }
  })
})

describe("stored-secret alternate actions enforce the free login budget", () => {
  for (const action of ["type", "browser_type", "browser_auth"]) {
    test(`${action} refuses before reading the vault when the allowance is spent`, async () => {
      const controlPlane = await startControlPlane({ signedIn: true })
      try {
        const harness = await createDriverHarness()
        await spendVaultLogin(controlPlane, 3)
        process.env.OMNIA_SERVER_URL = controlPlane.url
        process.env.OMNIA_SERVER_TOKEN = controlPlane.token
        const outcome = await harness.manager.execute("local", {
          action, credential: harness.credentialId, ...APPROVAL,
        })
        expect(outcome.httpStatus).toBe(402)
        expect(harness.credentials.reads).toBe(0)
      } finally {
        await controlPlane.stop()
      }
    })
  }
})
