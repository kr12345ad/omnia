// Enforcement for the capabilities api.ts gates itself.
//
// Every test here proves the same two things, because a gate that runs after the
// work is not a gate: a refusal names the capability and the plan, AND the driver
// behind the refusal was never reached. The control plane is a real Omnia server
// answering the real POST /v1/billing/check from the real plan matrix, so no
// decision is duplicated here.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startOmniaServer } from "./server"
import type { ServerComputerDriver } from "./computers"
import type { ActionResult, ComputerAction, ComputerInfo, Observation } from "../protocol"
import { EMPTY_STATE, applySubscription, writeBillingState } from "../billing/store"

type Server = Awaited<ReturnType<typeof startOmniaServer>>

const PROFILE_ID = 230746284
const PROFILE_ID_TEXT = String(PROFILE_ID)

let dir = ""
let previous: Record<string, string | undefined> = {}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnia-capability-gate-"))
  previous = {
    OMNIA_SERVER_URL: process.env.OMNIA_SERVER_URL,
    OMNIA_SERVER_TOKEN: process.env.OMNIA_SERVER_TOKEN,
    OMNIA_BILLING_FILE: process.env.OMNIA_BILLING_FILE,
  }
  // Both servers read the same signed-in profile, so the control plane resolves
  // the entitlements for the same customer the gated server is asking about.
  writeFileSync(
    join(dir, "auth.json"),
    JSON.stringify({ profile: { id: PROFILE_ID, login: "capability-tester" }, token: "", signedInAt: 0 }),
  )
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
 * A driver that records whether the grab was ever installed.
 *
 * `grabs` is the assertion that matters: it is the difference between "the route
 * refused" and "the route refused before touching the machine".
 */
function createRecordingDriver() {
  const calls = { grabs: 0, releases: 0 }
  const driver: ServerComputerDriver = {
    id: "local",
    backend: "test",
    getInfo: async (): Promise<ComputerInfo> => ({
      id: "local",
      name: "Test Computer",
      platform: "linux",
      backend: "test",
      connected: true,
    }),
    capabilities: () => [],
    observe: async (): Promise<Observation> => ({ id: "obs-1", backend: "test", elements: [] }),
    find: async (request) => ({ query: request.query, matches: [] }),
    execute: async (action: ComputerAction): Promise<ActionResult> => ({
      success: true,
      status: "success",
      message: `Executed ${action.type}.`,
    }),
    grabInput: async (reason?: string) => {
      calls.grabs += 1
      return { success: true, status: "success", message: "Frozen.", frozen: true, supported: true, mode: "x11", ...(reason === undefined ? {} : { reason }) }
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

async function startControlPlane(): Promise<Server> {
  return startOmniaServer({
    authFile: join(dir, "auth.json"),
    credentialsFile: join(dir, "credentials.json"),
    memoryFile: join(dir, "memories.json"),
    superskillFile: join(dir, "superskills.json"),
    pairingsFile: join(dir, "pairings.json"),
    computerUseFile: join(dir, "computer-use.json"),
  })
}

/** Puts the signed-in profile on a live pro subscription, through the real store. */
function subscribeToPro(): void {
  const applied = applySubscription(
    EMPTY_STATE,
    {
      customerId: "cus_test",
      subscriptionId: "sub_test",
      status: "active",
      profileId: PROFILE_ID_TEXT,
      currentPeriodEnd: Date.now() + 86_400_000,
    },
    "pro",
    "evt_capability_gate",
  )
  writeBillingState(join(dir, "billing.json"), applied.state)
}

async function postJson(
  server: { url: string; token: string },
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${server.url}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

/** The gated server, pointed at the control plane the way the desktop sidecar is. */
async function startGated(controlPlane: Server) {
  const { driver, calls } = createRecordingDriver()
  process.env.OMNIA_SERVER_URL = controlPlane.url
  process.env.OMNIA_SERVER_TOKEN = controlPlane.token
  const server = await startOmniaServer({ drivers: [driver], authFile: join(dir, "auth.json") })
  return { server, calls }
}

describe("input_freeze is metered before the grab is installed", () => {
  test("a free plan is refused and the driver is never reached", async () => {
    const controlPlane = await startControlPlane()
    try {
      const { server, calls } = await startGated(controlPlane)
      try {
        const refused = await postJson(server, "/v1/input/freeze", { computerId: "local", reason: "agent task" })
        expect(refused.status).toBe(402)
        // The refusal is typed and names BOTH the capability and the plan, so the
        // caller can tell an upgrade prompt from a transient failure.
        expect(refused.body).toEqual({
          ok: false,
          error: {
            code: "capability_not_entitled",
            message: expect.stringContaining("input_freeze") as unknown as string,
            capability: "input_freeze",
            plan: "free",
            retryable: false,
          },
        })
        expect((refused.body.error as { message: string }).message).toContain("plan: free")
        // THE assertion: nothing reached the machine.
        expect(calls.grabs).toBe(0)
        // ...and nothing was reported as a successful freeze either.
        const state = await (await fetch(`${server.url}/v1/input/state?computerId=local`, {
          headers: { authorization: `Bearer ${server.token}` },
        })).json()
        expect(state).toMatchObject({ ok: true, frozen: false })
      } finally {
        await server.stop()
      }
    } finally {
      await controlPlane.stop()
    }
  })

  test("a pro plan freezes and the driver IS reached", async () => {
    const controlPlane = await startControlPlane()
    try {
      subscribeToPro()
      const { server, calls } = await startGated(controlPlane)
      try {
        const allowed = await postJson(server, "/v1/input/freeze", { computerId: "local" })
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

  test("release is never gated: a refused freeze is not a trap", async () => {
    const controlPlane = await startControlPlane()
    try {
      const { server, calls } = await startGated(controlPlane)
      try {
        expect((await postJson(server, "/v1/input/freeze", { computerId: "local" })).status).toBe(402)
        // The escape hatch must not depend on money: refusing it would leave a
        // customer unable to give their own input back.
        const released = await postJson(server, "/v1/input/release", { computerId: "local" })
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
})

describe("the gate's failure policy", () => {
  test("a configured but unreachable control plane refuses a hard-metered capability", async () => {
    // Port 1 is reserved and never listening, so this is a real transport failure
    // rather than a simulated one.
    const { driver, calls } = createRecordingDriver()
    process.env.OMNIA_SERVER_URL = "http://127.0.0.1:1"
    process.env.OMNIA_SERVER_TOKEN = "token-that-cannot-be-verified"
    const server = await startOmniaServer({ drivers: [driver], authFile: join(dir, "auth.json") })
    try {
      const refused = await postJson(server, "/v1/input/freeze", { computerId: "local" })
      // input_freeze is NEVER on free, which is hard metering: an unknown counter
      // cannot be honoured, so it fails CLOSED rather than serving unmetered use.
      expect(refused.status).toBe(503)
      expect(refused.body).toMatchObject({
        ok: false,
        error: {
          code: "entitlement_unavailable",
          capability: "input_freeze",
          // Retryable, and distinct from the 402: waiting fixes this one, paying
          // does not.
          retryable: true,
        },
      })
      expect((refused.body.error as { message: string }).message).toContain("could not be reached")
      expect(calls.grabs).toBe(0)
    } finally {
      await server.stop()
    }
  })

  test("no control plane configured at all stays open, so local installs are unaffected", async () => {
    // OMNIA_SERVER_URL and OMNIA_SERVER_TOKEN are both absent: this install never
    // opted into billing, so there is nothing to enforce and nothing to refuse.
    const { driver, calls } = createRecordingDriver()
    const server = await startOmniaServer({ drivers: [driver], authFile: join(dir, "auth.json") })
    try {
      const allowed = await postJson(server, "/v1/input/freeze", { computerId: "local" })
      expect(allowed.status).toBe(200)
      expect(allowed.body).toEqual({ ok: true, frozen: true, mode: "x11" })
      expect(calls.grabs).toBe(1)
    } finally {
      await server.stop()
    }
  })

  test("a hung control plane times out instead of hanging the action", async () => {
    const { driver, calls } = createRecordingDriver()
    const hung = Bun.serve({
      port: 0,
      // The deadline, not the socket, is what ends this: the gate must never let
      // a stalled control plane become the user's latency.
      fetch: () => new Promise<Response>(() => undefined),
    })
    process.env.OMNIA_SERVER_URL = `http://127.0.0.1:${hung.port}`
    process.env.OMNIA_SERVER_TOKEN = "token-that-cannot-be-verified"
    const server = await startOmniaServer({ drivers: [driver], authFile: join(dir, "auth.json") })
    try {
      const startedAt = Date.now()
      const refused = await postJson(server, "/v1/input/freeze", { computerId: "local" })
      expect(refused.status).toBe(503)
      expect(refused.body).toMatchObject({ ok: false, error: { code: "entitlement_unavailable" } })
      expect(Date.now() - startedAt).toBeLessThan(20_000)
      expect(calls.grabs).toBe(0)
    } finally {
      await server.stop()
      hung.stop(true)
    }
  }, 25_000)
})

describe("the plan matrix claims that match no code path", () => {
  // These capabilities are NEVER on free and have no route, driver or store
  // anywhere in the server, so nothing can be gated for them. The matrix should
  // say so rather than imply an enforcement that does not exist; this test fails
  // the day one of them grows a surface and the gate has to be wired.
  const NO_SURFACE = ["scheduled_runs", "api_access", "webhooks", "audit_export", "rbac", "sso", "self_hosted"] as const

  test("none of them has a route under /v1", async () => {
    const server = await startOmniaServer({ authFile: join(dir, "auth.json") })
    try {
      for (const capability of NO_SURFACE) {
        const response = await fetch(`${server.url}/v1/${capability.replace(/_/g, "-")}`, {
          method: "POST",
          headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
          body: JSON.stringify({ capability }),
        })
        expect(`${capability} -> ${response.status}`).toBe(`${capability} -> 404`)
      }
    } finally {
      await server.stop()
    }
  })
})