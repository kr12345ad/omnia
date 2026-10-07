// GET/PUT /v1/specialists end to end against the real server.
//
// The billing control plane is a tiny local server that answers
// POST /v1/billing/check the way the real one does (200 allowed, 402 refused),
// so the entitlement decision under test is api.ts's, not a mocked return value.
// Every PUT that must be refused also proves the roster file was never written.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sessionProof } from "./api"
import { startOmniaServer } from "./server"
import { DEFAULT_SPECIALISTS, SPECIALIST_LIMITS } from "../specialists/types"

type Server = Awaited<ReturnType<typeof startOmniaServer>>
type Plan = "free" | "pro" | "error"

const ENV_KEYS = ["OMNIA_SERVER_URL", "OMNIA_SERVER_TOKEN", "OMNIA_PUBLIC_URL"] as const
const CONTROL_TOKEN = "control-plane-token"

const CUSTOM = [
  { role: "pm", name: "Product Manager", focus: "Scope, users, and what ships first." },
  { role: "sre", name: "SRE", focus: "Reliability, rollout, and on-call cost." },
  { name: "Lawyer", focus: "Licensing and compliance exposure." },
]

let dir = ""
let saved: Record<string, string | undefined> = {}
let checks: Array<{ capability: unknown; authorization: string | null }> = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnia-specialists-api-"))
  checks = []
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
  for (const key of ENV_KEYS) delete process.env[key]
  writeFileSync(
    join(dir, "auth.json"),
    JSON.stringify({ profile: { id: 230746284, login: "specialists-tester" }, token: "", signedInAt: 0 }),
  )
})

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // A leftover temp dir must never fail the run.
  }
})

const rosterFile = () => join(dir, "specialists.json")

/** Answers POST /v1/billing/check like the real control plane for `plan`. */
function startControlPlane(plan: Plan) {
  const control = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const url = new URL(request.url)
      if (request.method !== "POST" || url.pathname !== "/v1/billing/check") {
        return new Response("not found", { status: 404 })
      }
      const body = (await request.json()) as { capability?: unknown }
      checks.push({ capability: body.capability, authorization: request.headers.get("authorization") })
      if (plan === "error") return Response.json({ ok: false, error: "boom" }, { status: 500 })
      const allowed = plan === "pro"
      return Response.json(
        {
          ok: allowed,
          allowed,
          capability: body.capability,
          plan,
          ...(allowed ? {} : { reason: `${String(body.capability)} is not included in the ${plan} plan.` }),
          consumed: false,
        },
        { status: allowed ? 200 : 402 },
      )
    },
  })
  process.env.OMNIA_SERVER_URL = `http://127.0.0.1:${control.port}`
  process.env.OMNIA_SERVER_TOKEN = CONTROL_TOKEN
  return control
}

async function withServer(plan: Plan | "unconfigured" | "unreachable", fn: (server: Server) => Promise<void>) {
  const control = plan === "unconfigured" || plan === "unreachable" ? undefined : startControlPlane(plan)
  if (plan === "unreachable") {
    // Port 1 is reserved and never listening: a real transport failure.
    process.env.OMNIA_SERVER_URL = "http://127.0.0.1:1"
    process.env.OMNIA_SERVER_TOKEN = CONTROL_TOKEN
  }
  const server = await startOmniaServer({
    authFile: join(dir, "auth.json"),
    credentialsFile: join(dir, "credentials.json"),
    memoryFile: join(dir, "memories.json"),
    superskillFile: join(dir, "superskills.json"),
    pairingsFile: join(dir, "pairings.json"),
    computerUseFile: join(dir, "computer-use.json"),
    specialistsFile: rosterFile(),
  })
  try {
    await fn(server)
  } finally {
    await server.stop()
    control?.stop(true)
  }
}

async function call(
  server: Server,
  method: string,
  body?: unknown,
  headers: Record<string, string> = { authorization: `Bearer ${server.token}` },
) {
  const response = await fetch(`${server.url}/v1/specialists`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

const expectedLimits = {
  minCount: SPECIALIST_LIMITS.minCount,
  maxCount: SPECIALIST_LIMITS.maxCount,
  maxNameLength: SPECIALIST_LIMITS.maxNameLength,
  maxFocusLength: SPECIALIST_LIMITS.maxFocusLength,
}

const defaultsRoster = (entitled: boolean) => ({
  ok: true,
  entitled,
  custom: false,
  specialists: DEFAULT_SPECIALISTS,
  defaults: DEFAULT_SPECIALISTS,
  limits: expectedLimits,
})

const normalizedCustom = CUSTOM.map((entry) => ({ role: entry.role ?? "lawyer", name: entry.name, focus: entry.focus }))

function seedRosterFile() {
  writeFileSync(rosterFile(), JSON.stringify({ version: 1, specialists: normalizedCustom }), { mode: 0o600 })
}

describe("GET /v1/specialists", () => {
  test("with no control plane configured (self-hosted) the roster is entitled", async () => {
    await withServer("unconfigured", async (server) => {
      const response = await call(server, "GET")
      expect(response.status).toBe(200)
      expect(response.body).toEqual(defaultsRoster(true))
    })
  })

  test("free plan: not entitled, defaults, and never a 402", async () => {
    await withServer("free", async (server) => {
      const response = await call(server, "GET")
      expect(response.status).toBe(200)
      expect(response.body).toEqual(defaultsRoster(false))
      expect(checks).toEqual([{ capability: "custom_specialists", authorization: `Bearer ${CONTROL_TOKEN}` }])
    })
  })

  test("free plan with a saved roster on disk degrades to the defaults", async () => {
    seedRosterFile()
    await withServer("free", async (server) => {
      const response = await call(server, "GET")
      expect(response.status).toBe(200)
      expect(response.body).toEqual(defaultsRoster(false))
    })
    expect(JSON.parse(readFileSync(rosterFile(), "utf8")).specialists).toEqual(normalizedCustom)
  })

  test("pro plan with no saved roster: entitled, defaults", async () => {
    await withServer("pro", async (server) => {
      const response = await call(server, "GET")
      expect(response.status).toBe(200)
      expect(response.body).toEqual(defaultsRoster(true))
    })
  })

  test("billing service 500 degrades to defaults", async () => {
    seedRosterFile()
    await withServer("error", async (server) => {
      const response = await call(server, "GET")
      expect(response.status).toBe(200)
      expect(response.body).toEqual(defaultsRoster(false))
    })
  })

  test("unreachable billing service degrades to defaults", async () => {
    seedRosterFile()
    await withServer("unreachable", async (server) => {
      const response = await call(server, "GET")
      expect(response.status).toBe(200)
      expect(response.body).toEqual(defaultsRoster(false))
    })
  })
})

describe("PUT /v1/specialists", () => {
  test("pro: save then GET round-trips the normalized custom roster", async () => {
    await withServer("pro", async (server) => {
      const put = await call(server, "PUT", { specialists: CUSTOM })
      expect(put.status).toBe(200)
      expect(put.body).toEqual({
        ok: true,
        entitled: true,
        custom: true,
        specialists: normalizedCustom,
        defaults: DEFAULT_SPECIALISTS,
        limits: expectedLimits,
      })
      const get = await call(server, "GET")
      expect(get.status).toBe(200)
      expect(get.body).toEqual(put.body)
      expect(JSON.parse(readFileSync(rosterFile(), "utf8")).specialists).toEqual(normalizedCustom)
    })
  })

  test("pro: reset removes the saved roster and returns the defaults", async () => {
    seedRosterFile()
    await withServer("pro", async (server) => {
      expect((await call(server, "GET")).body.custom).toBe(true)
      const reset = await call(server, "PUT", { reset: true })
      expect(reset.status).toBe(200)
      expect(reset.body).toEqual(defaultsRoster(true))
      expect(existsSync(rosterFile())).toBe(false)
      expect((await call(server, "GET")).body).toEqual(defaultsRoster(true))
    })
  })

  test("free: 402 capability_not_entitled naming custom_specialists, nothing written", async () => {
    await withServer("free", async (server) => {
      const response = await call(server, "PUT", { specialists: CUSTOM })
      expect(response.status).toBe(402)
      expect(response.body.ok).toBe(false)
      const error = response.body.error as Record<string, unknown>
      expect(error).toMatchObject({
        code: "capability_not_entitled",
        capability: "custom_specialists",
        plan: "free",
        retryable: false,
      })
      expect(String(error.message)).toContain("custom_specialists")
      expect(existsSync(rosterFile())).toBe(false)
    })
  })

  test("free: reset is refused too and an existing file is left alone", async () => {
    seedRosterFile()
    await withServer("free", async (server) => {
      const response = await call(server, "PUT", { reset: true })
      expect(response.status).toBe(402)
      expect(JSON.parse(readFileSync(rosterFile(), "utf8")).specialists).toEqual(normalizedCustom)
    })
  })

  const longFocus = "x".repeat(SPECIALIST_LIMITS.maxFocusLength + 1)
  const invalid: Array<[string, unknown, string]> = [
    ["a single specialist", [CUSTOM[0]], "2 to 6"],
    ["seven specialists", Array.from({ length: 7 }, (_, i) => ({ name: `Spec ${String.fromCharCode(97 + i)}`, focus: "f" })), "2 to 6"],
    ["duplicate roles", [CUSTOM[0], { ...CUSTOM[1], role: "pm" }], 'share the role "pm"'],
    ["the reserved manager role", [CUSTOM[0], { role: "manager", name: "Boss", focus: "Run things." }], "reserved"],
    ["an oversized focus", [CUSTOM[0], { name: "Wordy", focus: longFocus }], "focus is longer"],
    ["a non-array", "pm, sre", "must be an array"],
    ["a missing specialists field", undefined, "must be an array"],
  ]
  for (const [label, specialists, message] of invalid) {
    test(`pro: ${label} is a 400 with a message and nothing is written`, async () => {
      await withServer("pro", async (server) => {
        const response = await call(server, "PUT", specialists === undefined ? {} : { specialists })
        expect(response.status).toBe(400)
        expect(response.body.ok).toBe(false)
        expect(typeof response.body.error).toBe("string")
        expect(String(response.body.error)).toContain(message)
        expect(existsSync(rosterFile())).toBe(false)
      })
    })
  }

  test("pro: an invalid roster does not overwrite a previously saved one", async () => {
    seedRosterFile()
    await withServer("pro", async (server) => {
      const response = await call(server, "PUT", { specialists: [CUSTOM[0]] })
      expect(response.status).toBe(400)
      expect(JSON.parse(readFileSync(rosterFile(), "utf8")).specialists).toEqual(normalizedCustom)
    })
  })

  test("a non-object body is a 400", async () => {
    await withServer("pro", async (server) => {
      expect((await call(server, "PUT", [1, 2])).status).toBe(400)
      expect(existsSync(rosterFile())).toBe(false)
    })
  })

  test("billing service 500: PUT refused with 503, nothing written", async () => {
    await withServer("error", async (server) => {
      const response = await call(server, "PUT", { specialists: CUSTOM })
      expect(response.status).toBe(503)
      expect(response.body.error).toMatchObject({
        code: "entitlement_unavailable",
        capability: "custom_specialists",
        retryable: true,
      })
      expect(existsSync(rosterFile())).toBe(false)
    })
  })

  test("unreachable billing service: PUT refused with 503, nothing written", async () => {
    await withServer("unreachable", async (server) => {
      const response = await call(server, "PUT", { specialists: CUSTOM })
      expect(response.status).toBe(503)
      expect(existsSync(rosterFile())).toBe(false)
    })
  })

  test("the signed-in desktop's own client token may save", async () => {
    await withServer("pro", async (server) => {
      const desktop = server.auth.mintDesktopToken({ id: 2, login: "signed-in-user" })
      if (desktop === undefined) throw new Error("the desktop token was not minted")
      const response = await call(server, "PUT", { specialists: CUSTOM }, { authorization: `Bearer ${desktop}` })
      expect(response.status).toBe(200)
      expect(response.body.custom).toBe(true)
    })
  })

  test("a provisioned agent client token is refused with 403 before billing, nothing written", async () => {
    await withServer("pro", async (server) => {
      const agent = server.auth.mintClientToken({ id: 9, login: "agent" })
      if (agent === undefined) throw new Error("the client token was not minted")
      const response = await call(server, "PUT", { specialists: CUSTOM }, { authorization: `Bearer ${agent}` })
      expect(response.status).toBe(403)
      expect(existsSync(rosterFile())).toBe(false)
      expect(checks).toEqual([])
    })
  })

  test("the server token with an agent origin is refused with 403", async () => {
    await withServer("pro", async (server) => {
      const response = await call(
        server,
        "PUT",
        { specialists: CUSTOM },
        { authorization: `Bearer ${server.token}`, "x-omnia-origin": "agent" },
      )
      expect(response.status).toBe(403)
      expect(existsSync(rosterFile())).toBe(false)
    })
  })

  test("a bound session claim on the server token is refused with 403", async () => {
    await withServer("pro", async (server) => {
      const response = await call(
        server,
        "PUT",
        { specialists: CUSTOM, sessionId: "session-1" },
        {
          authorization: `Bearer ${server.token}`,
          "x-omnia-session": "session-1",
          "x-omnia-session-proof": sessionProof(server.token, "session-1"),
        },
      )
      expect(response.status).toBe(403)
      expect(existsSync(rosterFile())).toBe(false)
    })
  })

  test("an unbound session claim is rejected before anything is written", async () => {
    await withServer("pro", async (server) => {
      const response = await call(
        server,
        "PUT",
        { specialists: CUSTOM },
        { authorization: `Bearer ${server.token}`, "x-omnia-session": "session-1" },
      )
      expect(response.status).toBe(401)
      expect(existsSync(rosterFile())).toBe(false)
    })
  })
})

describe("authentication and methods", () => {
  test("unauthenticated GET and PUT are 401 and nothing is written", async () => {
    await withServer("pro", async (server) => {
      expect((await call(server, "GET", undefined, {})).status).toBe(401)
      expect((await call(server, "PUT", { specialists: CUSTOM }, {})).status).toBe(401)
      expect((await call(server, "PUT", { specialists: CUSTOM }, { authorization: "Bearer wrong" })).status).toBe(401)
      expect(existsSync(rosterFile())).toBe(false)
      expect(checks).toEqual([])
    })
  })

  for (const method of ["POST", "DELETE", "PATCH"]) {
    test(`${method} is a 405`, async () => {
      await withServer("pro", async (server) => {
        const response = await call(server, method, method === "DELETE" ? undefined : { specialists: CUSTOM })
        expect(response.status).toBe(405)
        expect(response.body.ok).toBe(false)
        expect(existsSync(rosterFile())).toBe(false)
      })
    })
  }
})
