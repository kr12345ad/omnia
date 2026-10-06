// Enforcement at the two call sites that refuse a paid capability BEFORE the work
// happens, pinned as an enforcement contract rather than as a restatement of the
// plan table.
//
// There are two of them and the contract is the same for both:
//
//   1. THE DECISION PRECEDES THE OPERATION. A refusal that arrives after the grab
//      is installed is not a refusal, it is somebody's keyboard held until they
//      pay. A refusal that arrives after the credential is read is a secret
//      already in memory for a request nobody was entitled to make. So every test
//      below asserts the driver call count, not just the status code - the
//      difference between "the route refused" and "the route refused before
//      touching the machine or the vault".
//
//   2. THE STATUS SAYS WHICH OF TWO THINGS HAPPENED. 402 is a DECISION: this plan
//      does not include the capability, and paying fixes it. 503 is OUR outage:
//      we could not establish the allowance, and waiting fixes it. A control
//      plane answering 5xx is the second case, not the first - reporting an
//      outage as "not included in your plan" both lies to the customer and
//      applies free-plan policy to somebody who paid.
//
//   3. THE ESCAPE HATCH IS NEVER GATED. POST /v1/input/release is the way back out
//      of a grab, so it has to work while the freeze route is refusing - which
//      means it has to work during a 402 AND during our own outage.
//
// The gate in api.ts and the gate in computers.ts do not agree about which
// question to ask the control plane, and the tests here pin what each of them
// actually does, including the two places where that difference costs something.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startOmniaServer } from "./server"
import { EventBus } from "./events"
import { PermissionManager } from "./permissions"
import { ComputerManager, type BrowserController, type ServerComputerDriver } from "./computers"
import { CredentialStore } from "../credentials"
import { EMPTY_STATE, applySubscription, writeBillingState } from "../billing/store"
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

describe("POST /v1/input/freeze: the decision comes before the grab", () => {
  test("a free plan is refused with a 402 naming the capability and the plan, and no grab happens", async () => {
    const controlPlane = await startControlPlane()
    try {
      const { driver, calls } = createInputDriver()
      const server = await startGated(controlPlane, driver)
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
        // The assertion that separates a gate from a check: the machine was
        // never touched, and nothing is reported as frozen.
        expect(calls.grabs).toBe(0)
        const state = await fetch(`${server.url}/v1/input/state?computerId=local`, {
          headers: { authorization: `Bearer ${server.token}` },
        })
        expect(await state.json()).toMatchObject({ ok: true, frozen: false })
      } finally {
        await server.stop()
      }
    } finally {
      await controlPlane.stop()
    }
  })

  test("billing is consulted before the operator is asked to approve anything", async () => {
    // An agent-originated freeze with UI_CONTROL unapproved is 428 at the
    // permission gate. With a free plan it must be 402 instead: no operator is
    // ever asked to approve a freeze that billing is about to refuse.
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
        expect(asAgent.status).toBe(402)
        expect((asAgent.body.error as { code: string }).code).toBe("capability_not_entitled")
        expect(calls.grabs).toBe(0)
        // With the capability included, the same request now reaches the
        // permission gate, which is what proves the 402 above was billing's
        // answer and not a permission answer in disguise.
        subscribe("pro")
        const agentOnPro = await post(server, "/v1/input/freeze", { computerId: "local" }, { "x-omnia-origin": "agent" })
        expect(agentOnPro.status).toBe(428)
        expect(calls.grabs).toBe(0)
      } finally {
        await server.stop()
      }
    } finally {
      await controlPlane.stop()
    }
  })

  test("a control plane that answers 5xx is OUR outage: 503, retryable, and no grab", async () => {
    // The distinction a 402 cannot carry. A 500 is the billing service failing,
    // not deciding, and reporting it as "not included in your plan" applies free
    // policy to whoever asked.
    const broken = Bun.serve({ port: 0, fetch: () => new Response("upstream is unwell", { status: 500 }) })
    const { driver, calls } = createInputDriver()
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ profile: { id: PROFILE_ID, login: "tester" }, token: "", signedInAt: 0 }))
    process.env.OMNIA_SERVER_URL = `http://127.0.0.1:${broken.port}`
    process.env.OMNIA_SERVER_TOKEN = "token"
    const server = await startOmniaServer({ drivers: [driver], authFile: join(dir, "auth.json") })
    try {
      const refused = await post(server, "/v1/input/freeze", { computerId: "local" })
      expect(refused.status).toBe(503)
      expect(refused.body).toMatchObject({
        ok: false,
        error: { code: "entitlement_unavailable", capability: "input_freeze", retryable: true },
      })
      expect((refused.body.error as { message: string }).message).toContain("HTTP 500")
      expect(calls.grabs).toBe(0)
    } finally {
      await server.stop()
      broken.stop(true)
    }
  })

  test("the asking profile is forwarded, so a paying customer is answered on THEIR plan", async () => {
    // The control plane here has nobody signed in - the shape of a shared
    // control plane serving many desktops. Entitlements are per profile, so the
    // gate has to name whose plan it is asking about; if it did not, every
    // desktop on the host would be answered for the anonymous free plan.
    const controlPlane = await startControlPlane()
    try {
      subscribe("pro")
      const { driver, calls } = createInputDriver()
      const server = await startGated(controlPlane, driver)
      try {
        const allowed = await post(server, "/v1/input/freeze", { computerId: "local" })
        expect(allowed.status).toBe(200)
        expect(allowed.body).toEqual({ ok: true, frozen: true, mode: "x11" })
        expect(calls.grabs).toBe(1)
      } finally {
        await server.stop()
      }
    } finally {
      await controlPlane.stop()
    }
  })

  test("a paid plan loses the capability when the control plane is unreachable, and says it is on free", async () => {
    // THE GAP, pinned as observed. This gate holds no memory of which plan the
    // customer is on, so it evaluates the failure policy against `free`, where
    // input_freeze is hard-metered, and refuses. Two consequences, both real:
    //
    //   - a paying customer is refused a capability they bought during our own
    //     outage, which is the exact inverse of the policy in plans.ts; and
    //   - the refusal names plan "free" in its body, so the message tells a pro
    //     customer they are on the free plan.
    //
    // The canonical client (../billing/client, which the browser and CUA gates
    // use) answers the same outage for the same customer with allowed=true,
    // because it remembers the plan the control plane last named. Two gates, one
    // outage, opposite answers - pinned here so the disagreement is visible
    // rather than discovered. See enforcement-contract.test.ts for the client
    // half.
    const { driver, calls } = createInputDriver()
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ profile: { id: PROFILE_ID, login: "tester" }, token: "", signedInAt: 0 }))
    process.env.OMNIA_SERVER_URL = "http://127.0.0.1:1"
    process.env.OMNIA_SERVER_TOKEN = "token"
    const server = await startOmniaServer({ drivers: [driver], authFile: join(dir, "auth.json") })
    try {
      const refused = await post(server, "/v1/input/freeze", { computerId: "local" })
      expect(refused.status).toBe(503)
      expect(refused.body).toMatchObject({
        ok: false,
        error: {
          code: "entitlement_unavailable",
          capability: "input_freeze",
          // The plan in the body is hardcoded, so it is `free` even for the
          // paying customer this gate is refusing.
          plan: "free",
          retryable: true,
        },
      })
      expect(calls.grabs).toBe(0)
    } finally {
      await server.stop()
    }
  })
})

describe("POST /v1/input/release: never gated, including during our own outage", () => {
  test("a 402 freeze does not trap the caller: release reaches the driver", async () => {
    const controlPlane = await startControlPlane()
    try {
      const { driver, calls } = createInputDriver()
      const server = await startGated(controlPlane, driver)
      try {
        expect((await post(server, "/v1/input/freeze", { computerId: "local" })).status).toBe(402)
        const released = await post(server, "/v1/input/release", { computerId: "local" })
        expect(released.status).toBe(200)
        expect(released.body).toMatchObject({ ok: true, frozen: false })
        expect(calls.releases).toBe(1)
      } finally {
        await server.stop()
      }
    } finally {
      await controlPlane.stop()
    }
  })

  test("release works while billing is completely unreachable", async () => {
    // The case that is easy to get wrong: gating release "for symmetry" with
    // freeze. During our own outage the freeze route answers 503, and a customer
    // whose grab is already installed needs the way out more urgently than
    // ever, not less.
    const { driver, calls } = createInputDriver()
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ profile: { id: PROFILE_ID, login: "tester" }, token: "", signedInAt: 0 }))
    process.env.OMNIA_SERVER_URL = "http://127.0.0.1:1"
    process.env.OMNIA_SERVER_TOKEN = "token"
    const server = await startOmniaServer({ drivers: [driver], authFile: join(dir, "auth.json") })
    try {
      expect((await post(server, "/v1/input/freeze", { computerId: "local" })).status).toBe(503)
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

function createDriverHarness(): {
  manager: ComputerManager
  credentials: CountingCredentials
  credentialId: string
  navigations: () => number
} {
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
    permissions: new PermissionManager({ SECRETS: "prompt" }, "fully_autonomous"),
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
  return { manager, credentials, credentialId: credential.id, navigations: () => navigations }
}

const APPROVAL = {
  approve: true,
  approvedBy: "session:test",
  sessionId: "session-1",
  approvedScopes: ["UI_CONTROL", "BROWSER", "KEYBOARD", "SECRETS"],
} as const

/** Spends the free vault_login allowance the way a real caller would. */
async function spendVaultLogin(controlPlane: Server, times: number): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await post(controlPlane, "/v1/billing/check", { capability: "vault_login" }, { "x-omnia-profile": PROFILE })
  }
}

describe("the driver gate refuses a stored-credential login before the vault is read", () => {
  test("a spent hard allowance is a 402 naming the capability and the plan, with zero vault reads", async () => {
    // The control plane has the profile signed in, so the gate's question
    // resolves against this customer's own allowance.
    const controlPlane = await startControlPlane({ signedIn: true })
    try {
      process.env.OMNIA_SERVER_URL = controlPlane.url
      process.env.OMNIA_SERVER_TOKEN = controlPlane.token
      await spendVaultLogin(controlPlane, 3)
      const harness = createDriverHarness()
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

  test("an unreachable control plane is a retryable 503, and still reads nothing", async () => {
    process.env.OMNIA_SERVER_URL = "http://127.0.0.1:1"
    process.env.OMNIA_SERVER_TOKEN = "token"
    const harness = createDriverHarness()
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

  test("no control plane configured leaves a local install working", async () => {
    // An install that never opted into billing has nothing to enforce. Refusing
    // here would break every self-hosted and desktop install in the product.
    delete process.env.OMNIA_SERVER_URL
    delete process.env.OMNIA_SERVER_TOKEN
    const harness = createDriverHarness()
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
      const harness = createDriverHarness()
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
      const harness = createDriverHarness()
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
      const harness = createDriverHarness()
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
    // site even though browser_automation is a hard 250-a-day allowance on free.
    // The control plane here would refuse every browser action; it is never
    // asked, which is the proof.
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
        const response = await fetch(`${server.url}/v1/computers/local/actions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${server.token}`,
            "content-type": "application/json",
            "x-omnia-origin": "agent",
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