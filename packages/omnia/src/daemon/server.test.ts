import { describe, expect, test } from "bun:test"
import { startDaemon } from "./server"
import type { HostDriver } from "./host-driver"
import type { ActionResult, FindRequest, Observation } from "../protocol"

const observation: Observation = {
  id: "obs-stub",
  source: "accessibility",
  backend: "stub",
  elements: [
    {
      id: "atspi:0.1",
      role: "pushbutton",
      name: "Export",
      actions: ["click"],
      source: "accessibility",
      backend: "stub",
      reference: { kind: "element", elementId: "atspi:0.1", observationId: "obs-stub", generation: 1 },
      provenance: { source: "application", trust: "untrusted", authority: "none" },
      metadata: { atspiPath: [0, 1], atspiActions: ["click"] },
    },
  ],
  provenance: { source: "system", trust: "trusted", authority: "system" },
}

function stubDriver(): HostDriver {
  const match = { element: observation.elements![0]!, score: 1, reason: "stub" }
  return {
    id: "stub",
    backend: "stub",
    capabilities: [{ capability: "accessibility", status: "available", score: 1 }],
    getInfo: async () => ({ id: "stub", name: "Stub", platform: "test", backend: "stub", connected: true }),
    observe: async () => observation,
    find: async (request: FindRequest) => ({
      query: request.query,
      matches: [match],
      results: [match],
      elements: [observation.elements![0]!],
      references: [],
      observation,
      truncated: false,
    }),
    execute: async () => ({ success: true, status: "success", message: "stubbed" }) as ActionResult,
    revalidateTarget: async (reference) => ({
      valid: reference.elementId === "atspi:0.1",
      reference,
      reason: reference.elementId === "atspi:0.1" ? undefined : "Target is not present in the current observation.",
    }),
  }
}

async function call(url: string, token: string | undefined, path: string, body?: unknown) {
  const response = await fetch(`${url}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, json: (await response.json()) as Record<string, unknown> }
}

describe("daemon server", () => {
  test("serves info, capabilities, observe, find, and gated execute", async () => {
    const daemon = await startDaemon(stubDriver(), "test-token")
    try {
      const denied = await call(daemon.url, undefined, "/v1/info")
      expect(denied.status).toBe(401)

      const wrong = await call(daemon.url, "wrong", "/v1/info")
      expect(wrong.status).toBe(401)

      const info = await call(daemon.url, "test-token", "/v1/info")
      expect(info.status).toBe(200)
      expect(info.json.ok).toBe(true)

      const capabilities = await call(daemon.url, "test-token", "/v1/capabilities")
      expect(capabilities.status).toBe(200)

      const observe = await call(daemon.url, "test-token", "/v1/observe", {})
      expect(observe.status).toBe(200)
      expect((observe.json.observation as Observation).id).toBe("obs-stub")

      const find = await call(daemon.url, "test-token", "/v1/find", { query: "Export" })
      expect(find.status).toBe(200)

      const emptyQuery = await call(daemon.url, "test-token", "/v1/find", { query: "" })
      expect(emptyQuery.status).toBe(400)

      const unapproved = await call(daemon.url, "test-token", "/v1/execute", {
        target: { elementId: "atspi:0.1" },
        action: { type: "click" },
      })
      expect(unapproved.status).toBe(200)
      expect((unapproved.json.result as ActionResult).error).toMatchObject({ code: "approval_required" })

      const approved = await call(daemon.url, "test-token", "/v1/execute", {
        target: { elementId: "atspi:0.1", observationId: "obs-stub" },
        action: { type: "click" },
        approve: true,
      })
      expect(approved.status).toBe(200)
      expect((approved.json.result as ActionResult).success).toBe(true)

      const stale = await call(daemon.url, "test-token", "/v1/execute", {
        target: { elementId: "atspi:9.9", observationId: "obs-stub" },
        action: { type: "click" },
        approve: true,
      })
      expect((stale.json.result as ActionResult).error).toMatchObject({ code: "target_stale" })

      const unknown = await call(daemon.url, "test-token", "/v1/nope")
      expect(unknown.status).toBe(404)
    } finally {
      await daemon.stop()
    }
  })
})

test("refuses an empty daemon authentication token", async () => {
  await expect(startDaemon(stubDriver(), "")).rejects.toThrow("non-empty")
})
