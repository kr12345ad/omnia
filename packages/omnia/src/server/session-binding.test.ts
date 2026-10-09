import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { IncomingMessage } from "node:http"
import { MAX_CLIENT_SESSION_BINDINGS, SessionUnboundError, checkSessionBinding, sessionProof, type ApiContext } from "./api"
import { startOmniaServer } from "./server"
import type { ServerComputerDriver } from "./computers"
import type { ActionResult, ComputerAction, FindRequest, Observation } from "../protocol"

function fakeDriver(): ServerComputerDriver {
  const observation: Observation = {
    id: "obs-1",
    backend: "test",
    elements: [
      {
        id: "el-1",
        role: "button",
        name: "Go",
        states: [],
        actions: ["click"],
        bounds: { x: 1, y: 2, width: 3, height: 4 },
      },
    ],
  }
  return {
    id: "local",
    backend: "test",
    getInfo: async () => ({ id: "local", name: "Local", platform: "linux", backend: "test", connected: true }),
    capabilities: () => [],
    observe: async () => observation,
    find: async (request: FindRequest) => ({ query: request.query, matches: [] }),
    execute: async (_action: ComputerAction): Promise<ActionResult> => ({
      success: true,
      status: "success",
      message: "ok",
      observation,
    }),
    revalidateTarget: async () => ({ valid: true }),
  } as unknown as ServerComputerDriver
}

async function withServer<T>(fn: (server: Awaited<ReturnType<typeof startOmniaServer>>) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "omnia-session-binding-"))
  const server = await startOmniaServer({
    drivers: [fakeDriver()],
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

function headers(server: { token: string }, proof?: string): Record<string, string> {
  return {
    authorization: `Bearer ${server.token}`,
    "content-type": "application/json",
    ...(proof === undefined ? {} : { "x-omnia-session-proof": proof }),
  }
}

function clickBody(sessionId: string, approve = true): string {
  return JSON.stringify({
    action: "click",
    target: { elementId: "el-1" },
    ...(approve ? { approve: true, approvedScopes: ["UI_CONTROL"] } : {}),
    sessionId,
  })
}

describe("session binding", () => {
  test("sessionProof is a deterministic lowercase hex HMAC", () => {
    const proof = sessionProof("token-a", "session-1")
    expect(proof).toMatch(/^[0-9a-f]{64}$/)
    expect(sessionProof("token-a", "session-1")).toBe(proof)
    expect(sessionProof("token-a", "session-2")).not.toBe(proof)
    expect(sessionProof("token-b", "session-1")).not.toBe(proof)
  })

  test("rejects a sessionId without a proof", async () => {
    await withServer(async (server) => {
      const response = await fetch(`${server.url}/v1/computers/local/actions`, {
        method: "POST",
        headers: headers(server),
        body: clickBody("session-1"),
      })
      expect(response.status).toBe(401)
      const body = (await response.json()) as { error?: string }
      expect(body.error).toBe("session_unbound")
    })
  })

  test("rejects a mismatched proof", async () => {
    await withServer(async (server) => {
      const response = await fetch(`${server.url}/v1/computers/local/actions`, {
        method: "POST",
        headers: headers(server, sessionProof(server.token, "other-session")),
        body: clickBody("session-1"),
      })
      expect(response.status).toBe(401)
      const body = (await response.json()) as { error?: string }
      expect(body.error).toBe("session_unbound")
    })
  })

  test("rejects a proof signed with a different token", async () => {
    await withServer(async (server) => {
      const response = await fetch(`${server.url}/v1/computers/local/actions`, {
        method: "POST",
        headers: headers(server, sessionProof("not-the-server-token", "session-1")),
        body: clickBody("session-1"),
      })
      expect(response.status).toBe(401)
    })
  })

  test("accepts a proof signed with the presented client token", () => {
    const context = { token: "operator-token", auth: { isClientToken: (token: string) => token === "client-token" } } as unknown as ApiContext
    const bound = {
      headers: {
        authorization: "Bearer client-token",
        "x-omnia-session-proof": sessionProof("client-token", "session-1"),
      },
    } as unknown as IncomingMessage
    expect(() => checkSessionBinding(context, bound, { sessionId: "session-1" })).not.toThrow()
    const wrongKey = {
      headers: {
        authorization: "Bearer client-token",
        "x-omnia-session-proof": sessionProof("operator-token", "session-1"),
      },
    } as unknown as IncomingMessage
    expect(() => checkSessionBinding(context, wrongKey, { sessionId: "session-1" })).toThrow(SessionUnboundError)
  })

  test("a second credential cannot claim an already bound session with its own valid HMAC", () => {
    const context = { token: "operator-token", auth: { isClientToken: (token: string) => ["client-a", "client-b"].includes(token) } } as unknown as ApiContext
    const request = (token: string) => ({ headers: {
      authorization: `Bearer ${token}`,
      "x-omnia-session-proof": sessionProof(token, "victim-session"),
    } }) as unknown as IncomingMessage
    checkSessionBinding(context, request("client-a"), { sessionId: "victim-session" })
    expect(() => checkSessionBinding(context, request("client-b"), { sessionId: "victim-session" })).toThrow(SessionUnboundError)
    expect(() => checkSessionBinding(context, request("client-a"), { sessionId: "victim-session" })).not.toThrow()
  })

  test("public OAuth requests with chosen invalid token/proof cannot reserve a session", async () => {
    await withServer(async (server) => {
      const response = await fetch(`${server.url}/v1/auth/github/status`, { headers: {
        authorization: "Bearer attacker-chosen",
        "x-omnia-session": "public-claimed-session",
        "x-omnia-session-proof": sessionProof("attacker-chosen", "public-claimed-session"),
      } })
      expect(response.status).toBe(401)
      const legitimate = await fetch(`${server.url}/v1/computers/local/actions`, {
        method: "POST", headers: headers(server, sessionProof(server.token, "public-claimed-session")),
        body: JSON.stringify({ action: "observe", sessionId: "public-claimed-session" }),
      })
      expect(legitimate.status).toBe(200)
    })
  })

  test("one authenticated client cannot consume the entire shared binding capacity", () => {
    const context = { token: "operator-token", auth: { isClientToken: (token: string) => ["client-a", "client-b"].includes(token) } } as unknown as ApiContext
    const bind = (token: string, sessionId: string) => checkSessionBinding(context, { headers: {
      authorization: `Bearer ${token}`, "x-omnia-session-proof": sessionProof(token, sessionId),
    } } as unknown as IncomingMessage, { sessionId })
    for (let index = 0; index < MAX_CLIENT_SESSION_BINDINGS; index++) bind("client-a", `session-${index}`)
    expect(() => bind("client-a", "one-too-many")).toThrow("capacity")
    expect(() => bind("client-b", "unrelated-client-session")).not.toThrow()
    expect(() => bind("operator-token", "operator-session")).not.toThrow()
    expect(() => bind("client-a", "session-0")).not.toThrow()
  })

  test("batch session overrides are rejected before any driver action", async () => {
    await withServer(async (server) => {
      for (const session of [undefined, "outer-session"]) {
        const response = await fetch(`${server.url}/v1/computers/local/do`, {
          method: "POST",
          headers: headers(server, session === undefined ? undefined : sessionProof(server.token, session)),
          body: JSON.stringify({
            ...(session === undefined ? {} : { sessionId: session }),
            steps: [{ action: "observe" }, { action: "observe", sessionId: "victim-session" }],
          }),
        })
        expect(response.status).toBe(400)
        expect((await response.json()).error).toBe("session_mismatch")
      }
      const response = await fetch(`${server.url}/v1/sessions`, { headers: headers(server) })
      expect((await response.json()).sessions).toHaveLength(0)
    })
  })

  test("rejects a body sessionId that disagrees with the x-omnia-session header", async () => {
    await withServer(async (server) => {
      const response = await fetch(`${server.url}/v1/computers/local/actions`, {
        method: "POST",
        headers: {
          ...headers(server, sessionProof(server.token, "session-header")),
          "x-omnia-session": "session-header",
        },
        body: clickBody("session-body"),
      })
      expect(response.status).toBe(400)
      const body = (await response.json()) as { error?: string }
      expect(body.error).toBe("session_mismatch")
    })
  })

  test("a valid proof keeps the existing permission gate", async () => {
    await withServer(async (server) => {
      const denied = await fetch(`${server.url}/v1/computers/local/actions`, {
        method: "POST",
        headers: headers(server, sessionProof(server.token, "session-1")),
        body: clickBody("session-1", false),
      })
      expect(denied.status).toBe(428)

      const allowed = await fetch(`${server.url}/v1/computers/local/actions`, {
        method: "POST",
        headers: headers(server, sessionProof(server.token, "session-1")),
        body: clickBody("session-1"),
      })
      expect(allowed.status).toBe(200)

      const sessions = (await (
        await fetch(`${server.url}/v1/sessions`, { headers: headers(server) })
      ).json()) as { sessions: Array<{ id: string }> }
      expect(sessions.sessions.some((session) => session.id === "session-1")).toBe(true)
    })
  })

  test("binds an x-omnia-session header without a body sessionId", async () => {
    await withServer(async (server) => {
      const response = await fetch(`${server.url}/v1/computers/local/actions`, {
        method: "POST",
        headers: {
          ...headers(server, sessionProof(server.token, "session-header")),
          "x-omnia-session": "session-header",
        },
        body: JSON.stringify({ action: "click", target: { elementId: "el-1" }, approve: true, approvedScopes: ["UI_CONTROL"] }),
      })
      expect(response.status).toBe(200)
    })
  })

  test("desktop requests without a sessionId are unaffected", async () => {
    await withServer(async (server) => {
      const response = await fetch(`${server.url}/v1/computers/local/actions`, {
        method: "POST",
        headers: headers(server),
        body: JSON.stringify({ action: "click", target: { elementId: "el-1" }, approve: true, approvedScopes: ["UI_CONTROL"] }),
      })
      expect(response.status).toBe(200)
    })
  })

  test("agent origin without a sessionId still needs no proof", async () => {
    await withServer(async (server) => {
      const response = await fetch(`${server.url}/v1/computers/local/actions`, {
        method: "POST",
        headers: { ...headers(server), "x-omnia-origin": "agent" },
        body: JSON.stringify({ action: "observe" }),
      })
      expect(response.status).toBe(200)
    })
  })
})
