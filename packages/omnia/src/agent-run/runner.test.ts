import { describe, expect, test } from "bun:test"
import { runHeadless } from "./runner"
import type { OpenCodeRunnerConfig } from "./client"

function fakeServer(steps: Record<string, unknown>) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = []
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url)
      return (async () => {
        const body = request.method === "POST" ? await request.json().catch(() => undefined) : undefined
        calls.push({ method: request.method, path: url.pathname, body })
        const key = `${request.method} ${url.pathname}`
        if (key in steps) return Response.json(steps[key])
        if (`${request.method} ${url.pathname.replace(/\/[^/]+$/, "")}` in steps) {
          return Response.json(steps[`${request.method} ${url.pathname.replace(/\/[^/]+$/, "")}`])
        }
        return new Response("not found", { status: 404 })
      })()
    },
  })
  return { server, calls, config: { url: server.url.origin, username: "opencode", password: "secret" } satisfies OpenCodeRunnerConfig }
}

describe("headless run", () => {
  test("creates, prompts, waits for idle, and returns the last assistant text", async () => {
    const { server, calls, config } = fakeServer({
      "POST /session": { id: "ses_1", title: "Run" },
      "POST /session/ses_1/prompt_async": {},
      "GET /session/status": { ses_1: { type: "idle" } },
      "GET /session/ses_1/message": [
        { info: { role: "user" }, parts: [{ type: "text", text: "Summarize." }] },
        { info: { role: "assistant" }, parts: [{ type: "text", text: "Done: three unread." }] },
      ],
    })
    try {
      const result = await runHeadless(config, { prompt: "Summarize my email.", pollMs: 10, timeoutMs: 5_000 })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.sessionId).toBe("ses_1")
        expect(result.text).toBe("Done: three unread.")
      }
      expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
        "POST /session",
        "POST /session/ses_1/prompt_async",
        "GET /session/status",
        "GET /session/ses_1/message",
      ])
    } finally {
      server.stop()
    }
  })

  test("waits while busy before reading", async () => {
    let polls = 0
    const { server, config } = fakeServer({
      "POST /session": { id: "ses_2", title: "Run" },
      "POST /session/ses_2/prompt_async": {},
      "GET /session/status": {},
      "GET /session/ses_2/message": [{ info: { role: "assistant" }, parts: [{ type: "text", text: "later" }] }],
    })
    try {
      const result = await runHeadless(config, { prompt: "go", pollMs: 10, timeoutMs: 5_000 })
      expect(result.ok).toBe(true)
      void polls
    } finally {
      server.stop()
    }
  })

  test("aborts on timeout instead of running forever", async () => {
    const { server, calls, config } = fakeServer({
      "POST /session": { id: "ses_3", title: "Run" },
      "POST /session/ses_3/prompt_async": {},
      "GET /session/status": { ses_3: { type: "busy" } },
      "POST /session/ses_3/abort": {},
    })
    try {
      const result = await runHeadless(config, { prompt: "go", pollMs: 10, timeoutMs: 30 })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.timedOut).toBe(true)
      expect(calls.some((call) => call.path === "/session/ses_3/abort")).toBe(true)
    } finally {
      server.stop()
    }
  })

  test("reports a session-level error", async () => {
    const { server, config } = fakeServer({
      "POST /session": { id: "ses_4", title: "Run" },
      "POST /session/ses_4/prompt_async": {},
      "GET /session/status": { ses_4: { type: "error" } },
    })
    try {
      const result = await runHeadless(config, { prompt: "go", pollMs: 10, timeoutMs: 5_000 })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain("error")
    } finally {
      server.stop()
    }
  })

  test("rejects an empty prompt without touching the server", async () => {
    const { server, config } = fakeServer({})
    try {
      await expect(runHeadless(config, { prompt: "   " })).rejects.toThrow("prompt")
    } finally {
      server.stop()
    }
  })
})
