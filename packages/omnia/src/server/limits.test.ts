import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ApprovalRegistry, isApprovalGrantValid } from "../security/approval"
import { startOmniaServer } from "./server"
import { PermissionManager } from "./permissions"
import type { ServerComputerDriver } from "./computers"
import type { ActionResult, ComputerAction, FindRequest, Observation } from "../protocol"

function tempStores() {
  const dir = mkdtempSync(join(tmpdir(), "omnia-limits-"))
  return {
    credentialsFile: join(dir, "credentials.json"),
    authFile: join(dir, "auth.json"),
    superskillFile: join(dir, "superskills.json"),
    memoryFile: join(dir, "memories.json"),
    computerUseFile: join(dir, "computer-use.json"),
  }
}

function fakeDriver(): ServerComputerDriver {
  const observation: Observation = { id: "obs-1", backend: "test", elements: [] }
  return {
    id: "local",
    backend: "test",
    getInfo: async () => ({ id: "local", name: "Local", platform: "linux", backend: "test", connected: true }),
    capabilities: () => [],
    observe: async () => observation,
    find: async (request: FindRequest) => ({ query: request.query, matches: [] }),
    execute: async (_action: ComputerAction): Promise<ActionResult> => ({ success: true, status: "success", message: "ok", observation }),
  } as unknown as ServerComputerDriver
}

const auth = (server: { token: string }) => ({
  authorization: `Bearer ${server.token}`,
  "content-type": "application/json",
})

describe("server resource caps", () => {
  test("evicts the oldest tracked session past MAX_TRACKED_SESSIONS", async () => {
    const server = await startOmniaServer({ drivers: [fakeDriver()], ...tempStores() })
    try {
      for (let index = 0; index <= 500; index += 1) {
        await server.computers.execute("local", { action: "observe", sessionId: `session-${index}` })
      }
      const response = await fetch(`${server.url}/v1/sessions`, { headers: auth(server) })
      const body = (await response.json()) as { sessions: Array<{ id: string }> }
      expect(body.sessions).toHaveLength(500)
      expect(body.sessions.some((session) => session.id === "session-0")).toBe(false)
      expect(body.sessions[0]?.id).toBe("session-1")
      expect(body.sessions.at(-1)?.id).toBe("session-500")
    } finally {
      await server.stop()
    }
  })

  test("evicts the oldest capability write marker past its cap", async () => {
    let clock = 1_000_000
    const server = await startOmniaServer({ drivers: [fakeDriver()], now: () => clock, ...tempStores() })
    try {
      for (let index = 0; index <= 1000; index += 1) {
        await server.computers.observe("local", { applicationId: `app-${index}` })
      }
      clock += 1000
      await server.computers.observe("local", { applicationId: "app-0" })
      await server.computers.observe("local", { applicationId: "app-500" })

      const record = async (applicationId: string) => {
        const response = await fetch(
          `${server.url}/v1/memories?key=${encodeURIComponent(`application:${applicationId}:coverage`)}`,
          { headers: auth(server) },
        )
        const body = (await response.json()) as { memories: Array<{ updatedAt: number }> }
        return body.memories[0]
      }
      expect((await record("app-0"))?.updatedAt).toBe(clock)
      expect((await record("app-500"))?.updatedAt).toBe(1_000_000)
    } finally {
      await server.stop()
    }
  })

  test("drops an SSE subscriber that never drains instead of queueing without bound", async () => {
    const server = await startOmniaServer({ drivers: [fakeDriver()], ...tempStores() })
    const controller = new AbortController()
    try {
      const response = await fetch(`${server.url}/v1/events`, { headers: auth(server), signal: controller.signal })
      expect(response.status).toBe(200)
      const reader = response.body!.getReader()
      // The client never reads; the server must close the stream once its
      // bounded frame queue is exhausted.
      for (let index = 0; index < 5000; index += 1) {
        server.events.emit("computer.capabilities", { data: { index, filler: "x".repeat(200) } })
      }
      let closed = false
      try {
        for (let attempt = 0; attempt < 20 && !closed; attempt += 1) {
          const result = await Promise.race([
            reader.read(),
            new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 100)),
          ])
          closed = result !== undefined && result.done === true
        }
      } catch {
        closed = true
      }
      expect(closed).toBe(true)
    } finally {
      controller.abort()
      await server.stop()
    }
  })

  test("rate-limits pairing claims per address", async () => {
    const server = await startOmniaServer({ drivers: [fakeDriver()], ...tempStores() })
    try {
      const claim = () =>
        fetch(`${server.url}/v1/computers/pair/claim`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code: "ZZZZ-ZZZZ" }),
        })
      for (let attempt = 0; attempt < 10; attempt += 1) {
        expect((await claim()).status).toBe(404)
      }
      expect((await claim()).status).toBe(429)
    } finally {
      await server.stop()
    }
  })

  test("evicts the oldest session grant past MAX_SESSION_GRANTS", () => {
    const permissions = new PermissionManager({}, "ask_destructive", { maxSessionGrants: 2 })
    permissions.grant("grant-a", ["UI_CONTROL"])
    permissions.grant("grant-b", ["UI_CONTROL"])
    permissions.grant("grant-c", ["UI_CONTROL"])
    expect(permissions.grantedScopes("grant-a")).toEqual([])
    expect(permissions.grantedScopes("grant-b")).toContain("UI_CONTROL")
    expect(permissions.grantedScopes("grant-c")).toContain("UI_CONTROL")
  })

  test("expires session grants after their TTL", () => {
    let clock = 1000
    const permissions = new PermissionManager({}, "ask_destructive", { now: () => clock, grantTtlMs: 500 })
    permissions.grant("grant-a", ["UI_CONTROL"])
    expect(permissions.grantedScopes("grant-a")).toContain("UI_CONTROL")
    clock += 501
    expect(permissions.grantedScopes("grant-a")).toEqual([])
  })

  test("evicts the oldest approval snapshot past MAX_APPROVAL_SNAPSHOTS", () => {
    const registry = new ApprovalRegistry()
    const grants = Array.from({ length: 1001 }, (_, index) => {
      const operation = { action: "write", resources: [`file-${index}`] }
      return { operation, grant: registry.issue(operation, "user", { expiresInMs: 60_000 }) }
    })
    const first = grants[0]
    const last = grants.at(-1)
    expect(first).toBeDefined()
    expect(last).toBeDefined()
    if (first === undefined || last === undefined) return
    expect(isApprovalGrantValid(first.grant, first.operation)).toBe(false)
    expect(isApprovalGrantValid(last.grant, last.operation)).toBe(true)
    expect(registry.evaluate(first.operation).outcome).toBe("permission_required")
  })
})
