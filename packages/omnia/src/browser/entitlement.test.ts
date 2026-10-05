// Billing enforcement in the browser layer.
//
// These tests run against the real control plane (a real Omnia server, the real
// plan table, the real counters) rather than a stubbed decision function, so
// what they prove is the whole path: browser operation -> POST /v1/billing/check
// -> decide()/consume() -> back to the browser layer as an allow or a refusal.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CdpRuntime } from "./cdp"
import type { CdpTransport } from "./cdp"
import { BrowserEntitlementError, BrowserEntitlementGate } from "./entitlement"
import { browserFailureStatus } from "./errors"
import { CredentialStore } from "../credentials/store"
import type { BillingEnv } from "../billing/client"
import { PLANS } from "../billing/plans"
import { readBillingState } from "../billing/store"
import { startOmniaServer } from "../server/server"

const PROFILE = "424242"
const SECRET = "correct-horse-battery-staple"
const TOKEN = "browser-billing-test-token"
/** Port 1 is reserved and nothing listens there, so a check cannot be attempted. */
const UNREACHABLE = "http://127.0.0.1:1"

type ControlPlane = Awaited<ReturnType<typeof startOmniaServer>>

let dir = ""
let server: ControlPlane
let vault: CredentialStore
let credentialId = ""
let billingFile = ""
let previousBillingFile: string | undefined

/**
 * The gate points at the control plane the way production does: through the
 * environment. There is deliberately no endpoint or token option on the gate, so
 * a test that wants a different control plane - including one that is not there
 * at all - hands over a different environment.
 */
function gate(
  profileId: string = PROFILE,
  options: {
    readonly url?: string
    readonly token?: string
    readonly log?: (message: string, meta?: Record<string, unknown>) => void
  } = {},
): BrowserEntitlementGate {
  return new BrowserEntitlementGate({
    env: {
      OMNIA_SERVER_URL: options.url ?? server.url,
      OMNIA_SERVER_TOKEN: options.token ?? server.token,
    } satisfies BillingEnv,
    profileId,
    timeoutMs: 5_000,
    ...(options.log === undefined ? {} : { log: options.log }),
  })
}

/**
 * The counter the control plane actually kept, rather than a caller's tally.
 *
 * Deliberately NOT keyed on the month that happens to be current when the
 * assertion runs. The control plane keys each counter by the month its own clock
 * read at the moment it consumed the unit, so a run that spends a unit at 23:59
 * and asserts at 00:00 used to look up a period that had no counters in it and
 * report zero. Summing the capability's counters across every period is the
 * number that was actually spent, whenever the assertions land.
 */
function used(capability: "browser_automation" | "vault_login" | "credential_vault", profileId = PROFILE): number {
  const counters = readBillingState(billingFile).usage[profileId]?.counters ?? {}
  return Object.entries(counters)
    .filter(([key]) => key.startsWith(`${capability}:`))
    .reduce((total, [, count]) => total + count, 0)
}

/**
 * A page with a lot of nodes on it.
 *
 * The size is the point: an operation that returns four hundred nodes has to
 * cost exactly one request, so the allowance cannot be spent on DOM size.
 */
function crowdedTransport(nodes: number): CdpTransport & { calls: () => number } {
  const body = Array.from({ length: nodes }, (_, index) => `node ${index}`).join(" ")
  let calls = 0
  return {
    connected: true,
    calls: () => calls,
    close: () => undefined,
    async send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      calls += 1
      if (method === "Omnia.tabs") return { tabs: [{ id: "tab-1", url: "https://example.test/", active: true }] } as T
      const expression = typeof params.expression === "string" ? params.expression : ""
      if (expression.includes("readyState")) return { result: { value: JSON.stringify("complete") } } as T
      return {
        result: {
          value: JSON.stringify({ url: "https://example.test/", title: "Crowded", text: body, viewport: { width: 1, height: 1 } }),
        },
      } as T
    },
  }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "omnia-browser-billing-"))
  // Saved and restored, not just deleted: bun runs every test file in one
  // process, so a var left pointing at a directory this file is about to remove
  // leaks into the next file and points its billing state at a deleted path.
  previousBillingFile = process.env.OMNIA_BILLING_FILE
  billingFile = join(dir, "billing.json")
  process.env.OMNIA_BILLING_FILE = billingFile
  server = await startOmniaServer({
    token: TOKEN,
    credentialsFile: join(dir, "credentials.json"),
    authFile: join(dir, "auth.json"),
    superskillFile: join(dir, "superskills.json"),
    memoryFile: join(dir, "memories.json"),
    computerUseFile: join(dir, "computer-use.json"),
  })
  vault = new CredentialStore({ file: join(dir, "vault-credentials.json") })
  credentialId = vault.save({
    computerId: "local",
    name: "example",
    kind: "username_password",
    username: "someone",
    secret: SECRET,
  }).id
})

afterAll(async () => {
  await server?.stop()
  if (previousBillingFile === undefined) delete process.env.OMNIA_BILLING_FILE
  else process.env.OMNIA_BILLING_FILE = previousBillingFile
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // A leftover temp dir must never fail the run.
  }
})

describe("vault_login", () => {
  test("is refused before the credential store is read at all", async () => {
    const reader = () => {
      throw new Error("the vault was read on a refused login")
    }
    for (let attempt = 0; attempt < PLANS.free.capabilities.vault_login.limit; attempt += 1) {
      await gate().vaultLogin(() => "granted")
    }
    expect(used("vault_login")).toBe(3)

    let reads = 0
    const error = await gate()
      .vaultLogin(() => {
        reads += 1
        return vault.get(credentialId)
      })
      .then(
        () => undefined,
        (failure: unknown) => failure,
      )

    expect(error).toBeInstanceOf(BrowserEntitlementError)
    expect(reads).toBe(0)
    expect(vault.get(credentialId)?.secret).toBe(SECRET)
    expect((error as BrowserEntitlementError).entitlement.code).toBe("limit_reached")
    expect(browserFailureStatus((error as BrowserEntitlementError).code)).toBe(402)
  })

  test("never puts the credential value in the refusal or in a log line", async () => {
    const logged: string[] = []
    const lines: string[] = []
    const watching = gate(PROFILE, {
      log: (message) => logged.push(`${message} ${JSON.stringify(lines)}`),
    })
    let reads = 0
    await watching
      .vaultLogin(() => {
        reads += 1
        lines.push(SECRET)
        return vault.get(credentialId)
      })
      .catch((failure: unknown) => lines.push((failure as Error).message))

    expect(reads).toBe(0)
    const said = [...lines, ...logged].join("\n")
    expect(said.length).toBeGreaterThan(0)
    expect(said).not.toContain(SECRET)
  })

  test("reads the vault exactly once when it is entitled", async () => {
    const other = "424243"
    let reads = 0
    const credential = await gate(other).vaultLogin(() => {
      reads += 1
      return vault.get(credentialId)
    })
    expect(reads).toBe(1)
    expect(credential?.id).toBe(credentialId)
  })

  test("a hard allowance fails closed when the control plane is unreachable", async () => {
    // Port 1 is reserved and nothing listens there, so the check cannot even be
    // attempted - the counter is unknown, and an unknown counter cannot honour a
    // hard limit.
    let reads = 0
    await gate(PROFILE, { url: UNREACHABLE })
      .vaultLogin(() => {
        reads += 1
        return vault.get(credentialId)
      })
      .then(
        () => expect.unreachable("an unreachable control plane must not grant a hard allowance"),
        (failure: unknown) => {
          expect((failure as BrowserEntitlementError).entitlement.code).toBe("unreachable")
          expect(browserFailureStatus((failure as BrowserEntitlementError).code)).toBe(503)
        },
      )
    expect(reads).toBe(0)
  })
})

describe("credential_vault", () => {
  test("is metered separately from the logins it enables", async () => {
    const other = "424244"
    await gate(other).vaultLogin(() => vault.get(credentialId))
    await gate(other).vaultListing(() => vault.summaries("local"))
    expect(used("credential_vault", other)).toBe(1)
    expect(used("vault_login", other)).toBe(1)
  })

  test("fails open on a transport error because its free allowance is soft", async () => {
    let listed = 0
    const listing = await gate(PROFILE, { url: UNREACHABLE }).vaultListing(() => {
      listed += 1
      return vault.summaries("local")
    })
    expect(listed).toBe(1)
    expect(listing.length).toBe(1)
  })
})

describe("browser_automation", () => {
  test("charges one request per operation no matter how many nodes it returns", async () => {
    const other = "424245"
    const transport = crowdedTransport(400)
    const runtime = new CdpRuntime({
      endpoint: "ws://127.0.0.1:9",
      token: "bridge-token",
      transport,
      entitlement: gate(other),
    })

    const page = await runtime.read()
    expect(page.text.length).toBeGreaterThan(0)
    expect(transport.calls()).toBeGreaterThan(1)
    expect(used("browser_automation", other)).toBe(1)

    const before = transport.calls()
    await runtime.find("node")
    expect(transport.calls()).toBeGreaterThan(before)
    expect(used("browser_automation", other)).toBe(2)
  })

  test("charges a composite action once, not once per internal call", async () => {
    const other = "424246"
    const runtime = new CdpRuntime({
      endpoint: "ws://127.0.0.1:9",
      token: "bridge-token",
      transport: crowdedTransport(12),
      entitlement: gate(other),
    })

    // What a browser_login looks like from here: read, find, type, read again.
    // One user action, so one request.
    const charged = await gate(other).operation("browser_automation", async () => {
      await runtime.read()
      await runtime.find("node")
      await runtime.click({ x: 1, y: 1 })
      return runtime.read()
    })
    expect(charged.text.length).toBeGreaterThan(0)
    expect(used("browser_automation", other)).toBe(1)
  })

  test("never lets vault_login ride along on a browser automation span", async () => {
    const other = "424247"
    const refused = gate(other)
    for (let attempt = 0; attempt < PLANS.free.capabilities.vault_login.limit; attempt += 1) {
      await refused.vaultLogin(() => undefined)
    }
    let reads = 0
    await refused
      .operation("browser_automation", async () => {
        await refused.vaultLogin(() => {
          reads += 1
          return vault.get(credentialId)
        })
      })
      .catch(() => undefined)
    expect(used("browser_automation", other)).toBe(1)
    expect(reads).toBe(0)
  })

  test("refuses the operation before any browser work is attempted", async () => {
    const other = "424248"
    const spent = gate(other)
    for (let attempt = 0; attempt < PLANS.free.capabilities.browser_automation.limit; attempt += 1) {
      await spent.authorize("browser_automation")
    }

    const transport = crowdedTransport(3)
    const runtime = new CdpRuntime({
      endpoint: "ws://127.0.0.1:9",
      token: "bridge-token",
      transport,
      entitlement: spent,
    })
    expect(used("browser_automation", other)).toBe(PLANS.free.capabilities.browser_automation.limit)

    // Zero CDP traffic: the refusal landed before the runtime touched the bridge.
    await expect(runtime.navigate("https://example.test/")).rejects.toMatchObject({ code: "billing_required" })
    await expect(runtime.read()).rejects.toMatchObject({ code: "billing_required" })
    await expect(runtime.click({ x: 1, y: 1 })).rejects.toMatchObject({ code: "billing_required" })
    expect(transport.calls()).toBe(0)

    // A URL the policy rejects is still just a rejected URL, and costs nothing.
    await expect(runtime.navigate("file:///etc/passwd")).rejects.toMatchObject({ code: "url_blocked" })
    expect(used("browser_automation", other)).toBe(PLANS.free.capabilities.browser_automation.limit)
  })

  test("spends the allowance across real operations and then refuses", async () => {
    const other = "424249"
    const limit = PLANS.free.capabilities.browser_automation.limit
    const runtime = new CdpRuntime({
      endpoint: "ws://127.0.0.1:9",
      token: "bridge-token",
      transport: crowdedTransport(4),
      entitlement: gate(other),
    })

    for (let attempt = 0; attempt < limit; attempt += 1) {
      await runtime.read()
    }
    expect(used("browser_automation", other)).toBe(limit)

    const failure = await runtime.read().then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(BrowserEntitlementError)
    expect((failure as BrowserEntitlementError).entitlement).toMatchObject({
      code: "limit_reached",
      used: limit,
      limit,
    })
    // Refused, not charged: a denial does not spend the allowance.
    expect(used("browser_automation", other)).toBe(limit)
  })

  test("tab introspection is not billed as browser work", async () => {
    const other = "424250"
    const runtime = new CdpRuntime({
      endpoint: "ws://127.0.0.1:9",
      token: "bridge-token",
      transport: crowdedTransport(2),
      entitlement: gate(other),
    })
    await runtime.status()
    await runtime.tabs()
    await runtime.currentDialog()
    expect(used("browser_automation", other)).toBe(0)
  })

  test("an install with no billing configured keeps working", async () => {
    const inert = new BrowserEntitlementGate()
    expect(inert.configured).toBe(false)
    const transport = crowdedTransport(2)
    const runtime = new CdpRuntime({
      endpoint: "ws://127.0.0.1:9",
      token: "bridge-token",
      transport,
      entitlement: inert,
    })
    expect((await runtime.read()).text.length).toBeGreaterThan(0)
    expect(transport.calls()).toBeGreaterThan(0)
    // The unconfigured path never claims a capability is entitled; it says so.
    expect((await inert.check("vault_login")).code).toBe("unconfigured")
  })
})

describe("the gate resolves nothing a caller hands it", () => {
  test("the endpoint is the one the environment names", () => {
    const fromEnvironment = BrowserEntitlementGate.fromEnv({
      OMNIA_SERVER_TOKEN: server.token,
      OMNIA_SERVER_URL: server.url,
    })
    expect(fromEnvironment.configured).toBe(true)
    expect(fromEnvironment.endpoint).toBe(server.url)
  })

  test("a host with no port is inert, never a request to port 80", async () => {
    // This is the desktop sidecar's shape: the UI sets URL and TOKEN and never
    // PORT. The gate used to build http://127.0.0.1 out of exactly this and POST
    // the bearer in cleartext to whatever happened to be listening there, while
    // every hard-metered capability came back "unreachable" and was refused.
    const halfConfigured = BrowserEntitlementGate.fromEnv({
      OMNIA_SERVER_TOKEN: server.token,
      OMNIA_SERVER_HOST: "127.0.0.1",
    })
    expect(halfConfigured.endpoint).toBeUndefined()
    expect(halfConfigured.configured).toBe(false)
    expect((await halfConfigured.check("vault_login")).code).toBe("unconfigured")
  })
})