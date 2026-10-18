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

  test("sends attached files ahead of the text so the provider sees them", async () => {
    const { server, calls, config } = fakeServer({
      "POST /session": { id: "ses_file", title: "Run" },
      "POST /session/ses_file/prompt_async": {},
      "GET /session/status": { ses_file: { type: "idle" } },
      "GET /session/ses_file/message": [
        { info: { role: "assistant" }, parts: [{ type: "text", text: "a cat" }] },
      ],
    })
    try {
      const result = await runHeadless(config, {
        prompt: "what is this?",
        pollMs: 10,
        timeoutMs: 5_000,
        files: [{ mime: "image/png", filename: "shot.png", url: "data:image/png;base64,AAAA" }],
      })
      expect(result.ok).toBe(true)
      const sent = calls.find((call) => call.path === "/session/ses_file/prompt_async")
      expect(sent?.body).toEqual({
        parts: [
          { type: "file", mime: "image/png", url: "data:image/png;base64,AAAA", filename: "shot.png" },
          { type: "text", text: "what is this?" },
        ],
      })
    } finally {
      server.stop()
    }
  })

  test("continues a named session without creating another", async () => {
    // The baseline read happens before the prompt, so the fixture is empty then
    // and holds the answer afterwards - exactly how a real transcript grows.
    let reads = 0
    const calls: Array<{ method: string; path: string }> = []
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url)
        calls.push({ method: request.method, path: url.pathname })
        if (request.method === "POST") return Response.json({})
        if (url.pathname === "/session/status") return Response.json({ ses_7: { type: "idle" } })
        if (url.pathname === "/session/ses_7/message") {
          reads += 1
          return Response.json(
            reads === 1 ? [] : [{ info: { role: "assistant" }, parts: [{ type: "text", text: "continued" }] }],
          )
        }
        return new Response("not found", { status: 404 })
      },
    })
    const config: OpenCodeRunnerConfig = { url: server.url.origin, username: "opencode", password: "secret" }
    try {
      const result = await runHeadless(config, { prompt: "again", sessionId: "ses_7", pollMs: 10, timeoutMs: 5_000 })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.sessionId).toBe("ses_7")
        expect(result.text).toBe("continued")
      }
      expect(calls.some((call) => call.method === "POST" && call.path === "/session")).toBe(false)
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

  test("a session that has not started yet is not finished", async () => {
    // The prompt is queued before opencode puts the session in its status map,
    // so an absent entry must not be read as "done" - that returned an empty
    // answer while the turn was still starting.
    let polls = 0
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url)
        if (request.method === "POST" && url.pathname === "/session") return Response.json({ id: "ses_5" })
        if (request.method === "POST") return Response.json({})
        if (url.pathname === "/session/status") {
          polls += 1
          if (polls === 1) return Response.json({})
          if (polls === 2) return Response.json({ ses_5: { type: "busy" } })
          return Response.json({ ses_5: { type: "idle" } })
        }
        if (url.pathname === "/session/ses_5/message") {
          return Response.json(
            polls < 2 ? [] : [{ info: { role: "assistant" }, parts: [{ type: "text", text: "pong" }] }],
          )
        }
        return new Response("not found", { status: 404 })
      },
    })
    const config: OpenCodeRunnerConfig = { url: server.url.origin, username: "opencode", password: "secret" }
    try {
      const result = await runHeadless(config, { prompt: "go", pollMs: 5, timeoutMs: 5_000 })
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.text).toBe("pong")
      expect(polls).toBeGreaterThanOrEqual(3)
    } finally {
      server.stop()
    }
  })

  // The run clamps its budget to five seconds, so this test needs headroom.
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
  }, 15_000)

  test("the assistant placeholder is not an answer", async () => {
    // opencode writes an empty assistant message as soon as the prompt is
    // admitted. Reading that as the answer returned an empty reply instantly.
    let polls = 0
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url)
        if (request.method === "POST") return Response.json({})
        if (url.pathname === "/session/status") return Response.json({ ses_ph: { type: "idle" } })
        if (url.pathname === "/session/ses_ph/message") {
          polls += 1
          return Response.json(
            polls < 3
              ? [
                  { info: { role: "user" }, parts: [{ type: "text", text: "go" }] },
                  { info: { role: "assistant", time: { created: 1 } }, parts: [] },
                ]
              : [
                  { info: { role: "user" }, parts: [{ type: "text", text: "go" }] },
                  { info: { role: "assistant", time: { created: 1 } }, parts: [] },
                  {
                    info: { role: "assistant", time: { created: 1, completed: 2 } },
                    parts: [{ type: "text", text: "PINEAPPLE" }],
                  },
                ],
          )
        }
        return new Response("not found", { status: 404 })
      },
    })
    const config: OpenCodeRunnerConfig = { url: server.url.origin, username: "opencode", password: "secret" }
    try {
      const result = await runHeadless(config, { prompt: "go", sessionId: "ses_ph", pollMs: 5, timeoutMs: 5_000 })
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.text).toBe("PINEAPPLE")
      expect(polls).toBeGreaterThanOrEqual(3)
    } finally {
      server.stop()
    }
  })

  test("an idle session that has not answered this turn yet is not finished", async () => {
    // A continued session is idle until the queued prompt starts. Reading that
    // idle as done returned an empty answer for a turn that had not begun.
    let polls = 0
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url)
        if (request.method === "POST") return Response.json({})
        if (url.pathname === "/session/status") {
          polls += 1
          return Response.json({ ses_idle: { type: polls === 1 ? "idle" : polls === 2 ? "busy" : "idle" } })
        }
        if (url.pathname === "/session/ses_idle/message") {
          return Response.json(
            polls < 3 ? [] : [{ info: { role: "assistant" }, parts: [{ type: "text", text: "finally" }] }],
          )
        }
        return new Response("not found", { status: 404 })
      },
    })
    const config: OpenCodeRunnerConfig = { url: server.url.origin, username: "opencode", password: "secret" }
    try {
      const result = await runHeadless(config, {
        prompt: "go",
        sessionId: "ses_idle",
        pollMs: 5,
        timeoutMs: 5_000,
      })
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.text).toBe("finally")
      expect(polls).toBeGreaterThanOrEqual(3)
    } finally {
      server.stop()
    }
  })

  test("an abort signal stops the session instead of waiting for idle", async () => {
    const { server, calls, config } = fakeServer({
      "POST /session": { id: "ses_stop", title: "Run" },
      "POST /session/ses_stop/prompt_async": {},
      "GET /session/status": { ses_stop: { type: "busy" } },
      "GET /session/ses_stop/message": [],
      "POST /session/ses_stop/abort": {},
    })
    try {
      const controller = new AbortController()
      const running = runHeadless(config, {
        prompt: "go",
        pollMs: 500,
        timeoutMs: 5_000,
        signal: controller.signal,
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      controller.abort()
      const result = await running
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.interrupted).toBe(true)
      expect(calls.some((call) => call.path === "/session/ses_stop/abort")).toBe(true)
    } finally {
      server.stop()
    }
  })

  test("a continued session answers the new turn instead of repeating the previous answer", async () => {
    // The dangerous window: the prompt is queued but the session is not in the
    // status map yet. The previous answer is already in the transcript, so the
    // run must only look at messages created after the prompt.
    const previous = [
      { info: { role: "user" }, parts: [{ type: "text", text: "old question" }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "old answer" }] },
    ]
    const answered = [
      ...previous,
      { info: { role: "user" }, parts: [{ type: "text", text: "new question" }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "new answer" }] },
    ]
    let reads = 0
    const progress: number[] = []
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url)
        if (request.method === "POST") return Response.json({})
        if (url.pathname === "/session/status") return Response.json({})
        if (url.pathname === "/session/ses_9/message") {
          reads += 1
          return Response.json(reads === 1 ? previous : answered)
        }
        return new Response("not found", { status: 404 })
      },
    })
    const config: OpenCodeRunnerConfig = { url: server.url.origin, username: "opencode", password: "secret" }
    try {
      const result = await runHeadless(config, {
        prompt: "new question",
        sessionId: "ses_9",
        pollMs: 5,
        timeoutMs: 5_000,
        onProgress: (messages) => progress.push(messages.length),
      })
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.text).toBe("new answer")
      // Progress carries this turn only, never the previous answer's steps.
      expect(progress[0]).toBe(2)
    } finally {
      server.stop()
    }
  })

  test("reports the transcript while the run is still working", async () => {
    let polls = 0
    const seen: number[] = []
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url)
        if (request.method === "POST" && url.pathname === "/session") return Response.json({ id: "ses_8" })
        if (request.method === "POST") return Response.json({})
        if (url.pathname === "/session/status") {
          polls += 1
          return Response.json(polls < 3 ? { ses_8: { type: "busy" } } : { ses_8: { type: "idle" } })
        }
        if (url.pathname === "/session/ses_8/message") {
          return Response.json([{ info: { role: "assistant" }, parts: [{ type: "reasoning", text: "working" }] }])
        }
        return new Response("not found", { status: 404 })
      },
    })
    const config: OpenCodeRunnerConfig = { url: server.url.origin, username: "opencode", password: "secret" }
    try {
      const result = await runHeadless(config, {
        prompt: "go",
        pollMs: 5,
        timeoutMs: 5_000,
        onProgress: (messages) => seen.push(messages.length),
      })
      expect(result.ok).toBe(true)
      expect(seen.length).toBeGreaterThanOrEqual(2)
    } finally {
      server.stop()
    }
  })

  test("a provider error on the assistant message fails the run instead of returning empty text", async () => {
    const { server, config } = fakeServer({
      "POST /session": { id: "ses_6", title: "Run" },
      "POST /session/ses_6/prompt_async": {},
      "GET /session/status": { ses_6: { type: "idle" } },
      "GET /session/ses_6/message": [
        { info: { role: "user" }, parts: [{ type: "text", text: "go" }] },
        {
          info: { role: "assistant", error: { name: "APIError", data: { message: "The provider refused the plan." } } },
          parts: [],
        },
      ],
    })
    try {
      const result = await runHeadless(config, { prompt: "go", pollMs: 10, timeoutMs: 5_000 })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain("refused the plan")
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
