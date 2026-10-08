// /v1/runs end to end against the real server.
//
// The billing control plane and the paired opencode server are both tiny local
// servers, so the entitlement gate and the headless execution under test are
// api.ts's real code, not a mocked return value.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startOmniaServer } from "./server"

type Server = Awaited<ReturnType<typeof startOmniaServer>>
type Plan = "free" | "pro" | "error"

const ENV_KEYS = ["OMNIA_SERVER_URL", "OMNIA_SERVER_TOKEN", "OMNIA_OPENCODE_URL", "OMNIA_OPENCODE_PASSWORD"] as const
const CONTROL_TOKEN = "control-plane-token"

let dir = ""
let saved: Record<string, string | undefined> = {}
let checks: string[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnia-runs-api-"))
  checks = []
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
  for (const key of ENV_KEYS) delete process.env[key]
  writeFileSync(
    join(dir, "auth.json"),
    JSON.stringify({ profile: { id: 230746284, login: "runs-tester" }, token: "", signedInAt: 0 }),
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

const runsFile = () => join(dir, "runs.json")

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
      checks.push(String(body.capability))
      if (plan === "error") return Response.json({ ok: false, error: "boom" }, { status: 500 })
      const allowed = plan === "pro"
      return Response.json(
        {
          ok: allowed,
          allowed,
          capability: body.capability,
          plan,
          ...(allowed ? {} : { reason: `${String(body.capability)} is not included in the ${plan} plan.` }),
        },
        { status: allowed ? 200 : 402 },
      )
    },
  })
  process.env.OMNIA_SERVER_URL = `http://127.0.0.1:${control.port}`
  process.env.OMNIA_SERVER_TOKEN = CONTROL_TOKEN
  return control
}

/** The paired opencode server: create session, accept prompt, go idle. */
function startOpenCode() {
  const seen: string[] = []
  const opencode = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const url = new URL(request.url)
      seen.push(`${request.method} ${url.pathname}`)
      if (request.method === "POST" && url.pathname === "/session") {
        return Response.json({ id: "ses_run", title: "t" })
      }
      if (request.method === "POST" && url.pathname === "/session/ses_run/prompt_async") return Response.json({})
      if (request.method === "GET" && url.pathname === "/session/status") {
        return Response.json({ ses_run: { type: "idle" } })
      }
      if (request.method === "GET" && url.pathname === "/session/ses_run/message") {
        return Response.json([
          { info: { role: "assistant" }, parts: [{ type: "text", text: "Done." }] },
        ])
      }
      return new Response("not found", { status: 404 })
    },
  })
  process.env.OMNIA_OPENCODE_URL = opencode.url.origin
  process.env.OMNIA_OPENCODE_PASSWORD = "opencode-secret"
  return { opencode, seen }
}

async function withServer(
  plan: Plan | "unconfigured",
  fn: (server: Server) => Promise<void>,
  options: { runner?: boolean } = {},
) {
  const control = plan === "unconfigured" ? undefined : startControlPlane(plan)
  const runner = options.runner === true ? startOpenCode() : undefined
  const server = await startOmniaServer({
    authFile: join(dir, "auth.json"),
    credentialsFile: join(dir, "credentials.json"),
    memoryFile: join(dir, "memories.json"),
    superskillFile: join(dir, "superskills.json"),
    pairingsFile: join(dir, "pairings.json"),
    computerUseFile: join(dir, "computer-use.json"),
    runsFile: runsFile(),
  })
  try {
    await fn(server)
  } finally {
    await server.stop()
    control?.stop(true)
    runner?.opencode.stop(true)
  }
}

const headers = (server: Server) => ({ authorization: `Bearer ${server.token}`, "content-type": "application/json" })

describe("GET /v1/runs", () => {
  test("lists scheduled runs, empty at first", async () => {
    await withServer("pro", async (server) => {
      const response = await fetch(`${server.url}/v1/runs`, { headers: headers(server) })
      expect(response.status).toBe(200)
      expect((await response.json()).runs).toEqual([])
    })
  })
})

describe("POST /v1/runs", () => {
  test("free plan is refused with the paid capability named and nothing is stored", async () => {
    await withServer("free", async (server) => {
      const response = await fetch(`${server.url}/v1/runs`, {
        method: "POST",
        headers: headers(server),
        body: JSON.stringify({ name: "Morning summary", prompt: "Summarize my email.", intervalMinutes: 60 }),
      })
      expect(response.status).toBe(402)
      expect(checks).toContain("scheduled_runs")
      expect(existsSync(runsFile())).toBe(false)
    })
  })

  test("pro creates the run and GET lists it", async () => {
    await withServer("pro", async (server) => {
      const response = await fetch(`${server.url}/v1/runs`, {
        method: "POST",
        headers: headers(server),
        body: JSON.stringify({ name: "Morning summary", prompt: "Summarize my email.", intervalMinutes: 60 }),
      })
      expect(response.status).toBe(200)
      const run = (await response.json()).run as { id: string; name: string }
      expect(run.name).toBe("Morning summary")
      const list = await fetch(`${server.url}/v1/runs`, { headers: headers(server) })
      expect(((await list.json()).runs as unknown[]).length).toBe(1)
    })
  })

  test("invalid input is a 400 with a message and nothing stored", async () => {
    await withServer("pro", async (server) => {
      const response = await fetch(`${server.url}/v1/runs`, {
        method: "POST",
        headers: headers(server),
        body: JSON.stringify({ name: "", prompt: "x", intervalMinutes: 60 }),
      })
      expect(response.status).toBe(400)
      expect(existsSync(runsFile())).toBe(false)
    })
  })
})

describe("PATCH/DELETE /v1/runs/:id", () => {
  test("patch updates and delete removes", async () => {
    await withServer("pro", async (server) => {
      const created = await fetch(`${server.url}/v1/runs`, {
        method: "POST",
        headers: headers(server),
        body: JSON.stringify({ name: "tick", prompt: "go", intervalMinutes: 15 }),
      })
      const run = (await created.json()).run as { id: string }
      const patched = await fetch(`${server.url}/v1/runs/${run.id}`, {
        method: "PATCH",
        headers: headers(server),
        body: JSON.stringify({ intervalMinutes: 30, enabled: false }),
      })
      expect(patched.status).toBe(200)
      expect(((await patched.json()).run as { intervalMinutes: number }).intervalMinutes).toBe(30)
      const deleted = await fetch(`${server.url}/v1/runs/${run.id}`, {
        method: "DELETE",
        headers: headers(server),
      })
      expect(deleted.status).toBe(200)
      const list = await fetch(`${server.url}/v1/runs`, { headers: headers(server) })
      expect(((await list.json()).runs as unknown[]).length).toBe(0)
    })
  })
})

describe("POST /v1/runs/once", () => {
  test("runs headlessly through the paired opencode server when entitled", async () => {
    await withServer(
      "pro",
      async (server) => {
        const response = await fetch(`${server.url}/v1/runs/once`, {
          method: "POST",
          headers: headers(server),
          body: JSON.stringify({ prompt: "Summarize my email.", timeoutMs: 10_000 }),
        })
        expect(response.status).toBe(200)
        const body = await response.json()
        expect(body.ok).toBe(true)
        expect(body.sessionId).toBe("ses_run")
        expect(body.text).toBe("Done.")
        expect(checks).toContain("api_access")
      },
      { runner: true },
    )
  })

  test("free plan never reaches the opencode server", async () => {
    await withServer(
      "free",
      async (server) => {
        const response = await fetch(`${server.url}/v1/runs/once`, {
          method: "POST",
          headers: headers(server),
          body: JSON.stringify({ prompt: "Summarize my email." }),
        })
        expect(response.status).toBe(402)
        expect(checks).toContain("api_access")
      },
      { runner: true },
    )
  })

  test("an unconfigured runner is an honest 503, never a silent no-op", async () => {
    await withServer("pro", async (server) => {
      const response = await fetch(`${server.url}/v1/runs/once`, {
        method: "POST",
        headers: headers(server),
        body: JSON.stringify({ prompt: "Summarize my email." }),
      })
      expect(response.status).toBe(503)
      expect((await response.json()).error).toContain("OMNIA_OPENCODE_URL")
    })
  })
})
