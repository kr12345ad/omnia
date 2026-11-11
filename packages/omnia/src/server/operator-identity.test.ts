/**
 * Operator identity is decided by the presented token, never by the headers or
 * the body. These are the regression guards for the authorization bypass where a
 * client token could look like the desktop UI by omitting x-omnia-origin and
 * x-omnia-session, reach the operator-only permission routes, and have its own
 * approve:true claim honored.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OMNIA_SESSION_ID_MAX_LENGTH, isOperatorRequest, presentsServerToken, sessionProof } from "./api"
import { startOmniaServer } from "./server"
import type { CommandRequest, ServerComputerDriver } from "./computers"
import type { GitHubProfile } from "../auth/github"
import type { ActionResult, ComputerAction, FindRequest, Observation } from "../protocol"

function fakeDriver(): { driver: ServerComputerDriver; commands: CommandRequest[] } {
  const commands: CommandRequest[] = []
  const observation: Observation = { id: "obs-1", elements: [] }
  const driver: ServerComputerDriver = {
    id: "local",
    backend: "test",
    getInfo: async () => ({ id: "local", name: "Local", platform: "linux", connected: true }),
    capabilities: () => [],
    observe: async (): Promise<Observation> => observation,
    find: async (request: FindRequest) => ({ query: request.query, matches: [] }),
    execute: async (action: ComputerAction): Promise<ActionResult> => ({
      success: true,
      status: "success",
      message: `Executed ${action.type}.`,
      observation,
    }),
    runCommand: async (request) => {
      commands.push(request)
      return {
        success: true,
        status: "success",
        message: "Command exited with code 0.",
        command: { exitCode: 0, stdout: "ok", stderr: "", truncated: false, timedOut: false, durationMs: 1 },
      }
    },
    grabInput: async () => ({ success: true, status: "success", message: "Input frozen.", frozen: true, mode: "test" }),
    releaseInput: async () => ({ success: true, status: "success", message: "Input released.", frozen: false }),
  }
  return { driver, commands }
}

type Server = Awaited<ReturnType<typeof startOmniaServer>>

async function withServer<T>(fn: (server: Server, clientToken: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "omnia-operator-identity-"))
  const { driver } = fakeDriver()
  const server = await startOmniaServer({
    drivers: [driver],
    credentialsFile: join(dir, "credentials.json"),
    authFile: join(dir, "auth.json"),
    superskillFile: join(dir, "superskills.json"),
    memoryFile: join(dir, "memories.json"),
    computerUseFile: join(dir, "computer-use.json"),
  })
  try {
    const clientToken = server.auth.mintClientToken({ id: 1, login: "thin-client" } satisfies GitHubProfile)
    if (clientToken === undefined) throw new Error("the client token was not minted")
    return await fn(server, clientToken)
  } finally {
    await server.stop()
  }
}

function headers(token: string, options: { sessionId?: string; origin?: string } = {}) {
  const sessionId = options.sessionId
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    // The proof is keyed by the token the caller actually presented, which is
    // what binds a session id to a caller.
    ...(sessionId === undefined ? {} : { "x-omnia-session-proof": sessionProof(token, sessionId) }),
    ...(options.origin === undefined ? {} : { "x-omnia-origin": options.origin }),
  }
}

const post = (server: Server, path: string, token: string, body: unknown, options?: { sessionId?: string; origin?: string }) =>
  fetch(`${server.url}${path}`, {
    method: "POST",
    headers: headers(token, options ?? {}),
    body: JSON.stringify(body),
  })

const scopes = async (server: Server) => {
  const snapshot = (await (
    await fetch(`${server.url}/v1/permissions`, { headers: headers(server.token) })
  ).json()) as { scopes: Array<{ scope: string; state: string }> }
  return snapshot.scopes.find((entry) => entry.scope === "SECRETS")?.state
}

describe("desktop identity", () => {
  // Regression guard: the desktop app authenticates with a client token, not the
  // server token. When only the server token counted as the UI, every settings
  // call failed with "approval required for FILES_READ" / "Denied by policy:
  // SECRETS" and the app was unusable after signing in.
  test("the signed-in desktop's own token can list credentials and memories", async () => {
    await withServer(async (server) => {
      const desktopToken = server.auth.mintDesktopToken({ id: 2, login: "signed-in-user" } satisfies GitHubProfile)
      if (desktopToken === undefined) throw new Error("the desktop token was not minted")

      for (const path of ["/v1/computers/local/credentials", "/v1/memories"]) {
        const response = await fetch(`${server.url}${path}`, { headers: headers(desktopToken) })
        expect(`${path} -> ${response.status}`).toBe(`${path} -> 200`)
      }
    })
  })

  test("the desktop token still cannot flip a permission scope", async () => {
    await withServer(async (server) => {
      const desktopToken = server.auth.mintDesktopToken({ id: 2, login: "signed-in-user" } satisfies GitHubProfile)
      if (desktopToken === undefined) throw new Error("the desktop token was not minted")
      const response = await post(server, "/v1/permissions", desktopToken, { scope: "SECRETS", state: "granted" })
      expect(response.status).toBe(403)
      expect(await scopes(server)).toBe("denied")
    })
  })

  // Regression guard: the agent sidecar runs on the desktop's own client token
  // (a "desktop"-kind token), not the server token. Requiring the server token
  // to forward its approvedScopes dropped the approval and refused every action
  // with "missing scopes: POINTER" for get_context and PROCESS_EXECUTE for
  // launch_app/run_command, so controlled computers could not be used at all.
  test("the signed-in desktop's own runtime can approve a prompt scope for its session", async () => {
    await withServer(async (server) => {
      const desktopToken = server.auth.mintDesktopToken({ id: 2, login: "signed-in-user" } satisfies GitHubProfile)
      if (desktopToken === undefined) throw new Error("the desktop token was not minted")
      const response = await post(
        server,
        "/v1/computers/local/actions",
        desktopToken,
        {
          action: "get_context",
          approve: true,
          approvedBy: "session:session-context",
          approvedScopes: ["UI_READ", "POINTER", "BROWSER"],
          sessionId: "session-context",
        },
        { sessionId: "session-context", origin: "agent" },
      )
      expect(response.status).toBe(200)
    })
  })

  test("a provisioned agent client token still cannot self-approve a prompt scope", async () => {
    await withServer(async (server, clientToken) => {
      const response = await post(
        server,
        "/v1/computers/local/actions",
        clientToken,
        {
          action: "get_context",
          approve: true,
          approvedScopes: ["UI_READ", "POINTER", "BROWSER"],
          sessionId: "session-context",
        },
        { sessionId: "session-context", origin: "agent" },
      )
      expect(response.status).toBe(428)
    })
  })
})

describe("operator identity", () => {
  test("a client token with no origin or session headers cannot flip a permission scope", async () => {
    await withServer(async (server, clientToken) => {
      const response = await post(server, "/v1/permissions", clientToken, {
        scope: "SECRETS",
        state: "granted",
      })
      expect(response.status).toBe(403)
      expect(await scopes(server)).toBe("denied")
    })
  })

  test("a client token without headers cannot mint an approval grant either", async () => {
    await withServer(async (server, clientToken) => {
      const response = await post(server, "/v1/permissions/approve", clientToken, {
        action: "run_command",
        computerId: "local",
        resources: ["echo hello"],
      })
      expect(response.status).toBe(403)
    })
  })

  test("the server token with no headers is still the operator", async () => {
    await withServer(async (server) => {
      const response = await post(server, "/v1/permissions", server.token, {
        scope: "SECRETS",
        state: "prompt",
      })
      expect(response.status).toBe(200)
      expect(await scopes(server)).toBe("prompt")
    })
  })

  test("a client token claiming agent origin and a proven session is an agent, not the operator", async () => {
    await withServer(async (server, clientToken) => {
      const denied = await post(
        server,
        "/v1/permissions",
        clientToken,
        { scope: "SECRETS", state: "granted", sessionId: "session-1" },
        { sessionId: "session-1", origin: "agent" },
      )
      expect(denied.status).toBe(403)

      // Least privilege: as an agent it passes through the permission gate, so
      // its own approve:true claim is not honored and the command is refused.
      const command = await post(
        server,
        "/v1/computers/local/actions",
        clientToken,
        {
          action: "run_command",
          command: "echo hello",
          approve: true,
          approvedScopes: ["PROCESS_EXECUTE"],
          sessionId: "session-1",
        },
        { sessionId: "session-1", origin: "agent" },
      )
      expect(command.status).toBe(428)
    })
  })

  test("a client token without headers is gated as an agent on input freeze", async () => {
    await withServer(async (server, clientToken) => {
      const response = await post(server, "/v1/input/freeze", clientToken, { computerId: "local" })
      expect(response.status).toBe(428)
    })
  })

  test("a fingerprint-bound operator grant still authorizes a client token", async () => {
    await withServer(async (server, clientToken) => {
      const issued = await post(server, "/v1/permissions/approve", server.token, {
        action: "run_command",
        computerId: "local",
        resources: ["echo hello"],
        command: "echo hello",
      })
      expect(issued.status).toBe(200)
      const approval = (await issued.json()) as { approval: { fingerprint: string } }
      const command = await post(
        server,
        "/v1/computers/local/actions",
        clientToken,
        {
          action: "run_command",
          command: "echo hello",
          approvalFingerprint: approval.approval.fingerprint,
          sessionId: "session-1",
        },
        { sessionId: "session-1", origin: "agent" },
      )
      expect(command.status).toBe(200)
    })
  })

  test("an over-long session id is rejected with 400 instead of reading as no session", async () => {
    await withServer(async (server, clientToken) => {
      const sessionId = "s".repeat(OMNIA_SESSION_ID_MAX_LENGTH + 1)
      for (const token of [server.token, clientToken]) {
        const response = await post(server, "/v1/permissions", token, { scope: "SECRETS", state: "granted", sessionId })
        expect(response.status).toBe(400)
        const body = (await response.json()) as { error?: string }
        expect(body.error).toBe("session_id_too_long")
      }
      expect(await scopes(server)).toBe("denied")
    })
  })

  test("classification reads the token, not the headers", () => {
    const context = { token: "operator-token" }
    const asRequest = (headers: Record<string, string>) => ({ headers }) as never
    const bare = asRequest({ authorization: "Bearer operator-token" })
    const agent = asRequest({ authorization: "Bearer operator-token", "x-omnia-origin": "agent" })
    const session = asRequest({ authorization: "Bearer operator-token", "x-omnia-session": "session-1" })
    const client = asRequest({ authorization: "Bearer client-token" })

    expect(presentsServerToken(context, bare)).toBe(true)
    expect(isOperatorRequest(context, bare)).toBe(true)
    expect(isOperatorRequest(context, agent)).toBe(false)
    expect(isOperatorRequest(context, session)).toBe(false)
    // A client token is never the operator, however it labels itself.
    expect(isOperatorRequest(context, client)).toBe(false)
    expect(presentsServerToken(context, client)).toBe(false)
    // An over-long session header still claims a session.
    expect(isOperatorRequest(context, asRequest({ authorization: "Bearer operator-token", "x-omnia-session": "s".repeat(500) }))).toBe(false)
  })
})