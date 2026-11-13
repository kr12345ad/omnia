import { describe, expect, test } from "bun:test"
import { ChatApi, chatRunnable, chatTitle, mergeLive, readSse, toRenderedMessages } from "./api"

function sseResponse(chunks: string[]) {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )
}

function jsonFetch(handler: (url: string, init?: RequestInit) => unknown) {
  return (async (input: RequestInfo | URL, init?: RequestInit) =>
    Response.json(handler(String(input), init))) as unknown as typeof fetch
}

describe("chat api", () => {
  test("reads SSE events split across chunks and CRLF boundaries", async () => {
    const response = sseResponse([
      'data: {"type":"session.next.text.delta","data":{"delta":"hel',
      'lo"}}\n\n',
      'data: {"type":"session.next.step.ended","data":',
      '{"finish":"stop"}}\r\n\r\n',
    ])
    const events = []
    for await (const event of readSse(response)) events.push(event)

    expect(events).toEqual([
      { id: "", type: "session.next.text.delta", data: { delta: "hello" } },
      { id: "", type: "session.next.step.ended", data: { finish: "stop" } },
    ])
  })

  test("keeps user text and assistant text while dropping empty or internal messages", () => {
    const rendered = toRenderedMessages([
      { id: "msg_user", type: "user", text: "hi", time: { created: 1 } },
      {
        id: "msg_assistant",
        type: "assistant",
        content: [
          { type: "text", id: "part_1", text: "hello" },
          { type: "text", id: "part_2", text: " world" },
        ],
        time: { created: 2 },
      },
      {
        id: "msg_error",
        type: "assistant",
        content: [],
        error: { type: "unknown", message: "boom" },
        time: { created: 3 },
      },
      { id: "msg_empty", type: "user", text: "   ", time: { created: 4 } },
      { id: "msg_synthetic", type: "synthetic", text: "internal", time: { created: 5 } },
    ])

    expect(rendered).toEqual([
      { id: "msg_user", role: "user", text: "hi", createdAt: 1 },
      { id: "msg_assistant", role: "assistant", text: "hello world", createdAt: 2, error: undefined },
      { id: "msg_error", role: "assistant", text: "", createdAt: 3, error: "boom" },
    ])
  })

  test("keeps live text that the durable message list has not caught up with", () => {
    const messages = [
      { id: "msg_1", role: "assistant" as const, text: "hi", createdAt: 1 },
      { id: "msg_2", role: "user" as const, text: "there", createdAt: 2 },
    ]
    const merged = mergeLive(messages, { msg_1: "hi there", msg_3: "new" })

    expect(merged[0]?.text).toBe("hi there")
    expect(merged[1]?.text).toBe("there")
    expect(merged[2]).toEqual({ id: "msg_3", role: "assistant", text: "new", createdAt: 0 })
  })

  test("appends a delta suffix that arrived after a refresh", () => {
    const messages = [{ id: "msg_1", role: "assistant" as const, text: "Hello", createdAt: 1 }]

    expect(mergeLive(messages, { msg_1: " world" })[0]?.text).toBe("Hello world")
    expect(mergeLive(messages, { msg_1: "Hello world" })[0]?.text).toBe("Hello world")
  })

  test("resolves every request against a server path prefix and sends the auth header", async () => {
    const requests: { url: string; headers: unknown }[] = []
    const api = new ChatApi({
      baseUrl: "https://host/test1/omnia/",
      headers: { Authorization: "Basic abc" },
      fetch: jsonFetch((url, init) => {
        requests.push({ url, headers: init?.headers })
        return { directory: "/tmp" }
      }),
    })

    await api.location()

    expect(requests).toEqual([
      {
        url: "https://host/test1/omnia/api/location",
        headers: { accept: "application/json", Authorization: "Basic abc" },
      },
    ])
  })

  test("lists only active sessions owned by the tool-free chat agent", async () => {
    const api = new ChatApi({
      baseUrl: "https://host",
      fetch: jsonFetch(() => ({
        data: [
          { id: "ses_chat", agent: "chat", title: "Chat", time: { created: 1, updated: 2 } },
          { id: "ses_build", agent: "build", title: "Build", time: { created: 1, updated: 2 } },
          { id: "ses_archived", agent: "chat", title: "Old", time: { created: 1, updated: 2, archived: 3 } },
        ],
      })),
    })

    const sessions = await api.sessions("/tmp")
    expect(sessions.map((session) => session.id)).toEqual(["ses_chat"])
  })

  test("reads the newest message page and restores ascending order", async () => {
    let requested = ""
    const api = new ChatApi({
      baseUrl: "https://host",
      fetch: jsonFetch((url) => {
        requested = url
        return { data: [{ id: "msg_2" }, { id: "msg_1" }] }
      }),
    })

    const messages = await api.messages("ses_1")

    expect(new URL(requested).searchParams.get("order")).toBe("desc")
    expect(messages.map((message) => (message as { id: string }).id)).toEqual(["msg_1", "msg_2"])
  })

  test("keeps only models the v2 chat runner can execute", async () => {
    const api = new ChatApi({
      baseUrl: "https://host",
      fetch: jsonFetch(() => ({
        data: [
          { id: "native", providerID: "p", name: "Native", api: { type: "native", url: "https://p" } },
          { id: "openai", providerID: "p", name: "OpenAI", api: { type: "aisdk", package: "@ai-sdk/openai" } },
          { id: "anthropic", providerID: "p", name: "Anthropic", api: { type: "aisdk", package: "@ai-sdk/anthropic" } },
          {
            id: "compatible",
            providerID: "p",
            name: "Compatible",
            api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: "https://p" },
          },
          { id: "no-url", providerID: "p", name: "No URL", api: { type: "aisdk", package: "@ai-sdk/openai-compatible" } },
          { id: "google", providerID: "p", name: "Google", api: { type: "aisdk", package: "@ai-sdk/google" } },
        ],
      })),
    })

    expect((await api.models("/tmp")).map((model) => model.id)).toEqual(["openai", "anthropic", "compatible"])
    expect(chatRunnable({ id: "missing", providerID: "p", name: "Missing" })).toBe(false)
  })

  test("sends the model query as the protocol's deep location object", async () => {
    let requested = ""
    const api = new ChatApi({
      baseUrl: "https://host",
      fetch: jsonFetch((url) => {
        requested = url
        return { data: [] }
      }),
    })

    await api.models("/tmp/project")

    expect(new URL(requested).searchParams.get("location[directory]")).toBe("/tmp/project")
  })

  test("unwraps the active-session envelope", async () => {
    const api = new ChatApi({
      baseUrl: "https://host",
      fetch: jsonFetch(() => ({ data: { ses_1: { type: "running" } } })),
    })

    expect(await api.active()).toEqual({ ses_1: { type: "running" } })
  })

  test("derives a compact title from the first line", () => {
    expect(chatTitle("  Plan   my trip  \nThen pack")).toBe("Plan my trip")
    expect(chatTitle("x".repeat(70))).toBe(`${'x'.repeat(57)}...`)
    expect(chatTitle(" \n ")).toBeUndefined()
  })

  test("renames through the legacy session route on the shared session row", async () => {
    const requests: { url: string; method: string; headers: unknown; body?: string }[] = []
    const api = new ChatApi({
      baseUrl: "https://host/test1",
      headers: { Authorization: "Basic abc" },
      fetch: jsonFetch((url, init) => {
        requests.push({
          url,
          method: init?.method ?? "GET",
          headers: init?.headers,
          body: typeof init?.body === "string" ? init.body : undefined,
        })
        return { title: "Plan my trip" }
      }),
    })

    await api.rename("ses_1", "Plan my trip", "/tmp/project")

    expect(requests).toEqual([
      {
        url: "https://host/test1/session/ses_1",
        method: "PATCH",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          Authorization: "Basic abc",
          "x-opencode-directory": "/tmp/project",
        },
        body: JSON.stringify({ title: "Plan my trip" }),
      },
    ])
  })

  test("creates sessions on the tool-free chat agent", async () => {
    let body: unknown
    const api = new ChatApi({
      baseUrl: "https://host",
      fetch: jsonFetch((_url, init) => {
        body = JSON.parse(String(init?.body))
        return { data: { id: "ses_1", title: "", time: { created: 1, updated: 1 } } }
      }),
    })

    await api.createSession({ directory: "/tmp/project", model: { id: "model", providerID: "provider" } })

    expect(body).toEqual({
      agent: "chat",
      model: { id: "model", providerID: "provider" },
      location: { directory: "/tmp/project" },
    })
  })
})
