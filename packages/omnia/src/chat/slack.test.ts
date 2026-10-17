import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ChatChannelsRuntime, type ChatMessage } from "./service"
import { createSlackTransport, slackChallenge, toSlackMarkdown } from "./slack"

const MESSAGE: ChatMessage = {
  platform: "slack",
  channelId: "C1",
  userId: "U1",
  text: "go",
  threadId: "111.222",
  receivedAt: 0,
}

function harness() {
  const calls: Array<{ method: string; body: Record<string, unknown> | undefined; authorization: string | null }> = []
  let counter = 0

  const api = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const body = (await request.json().catch(() => undefined)) as Record<string, unknown> | undefined
      calls.push({ method: url.pathname.replace("/api/", ""), body, authorization: request.headers.get("authorization") })
      if (url.pathname === "/api/chat.postMessage") {
        return Response.json({ ok: true, ts: `ts-${++counter}`, channel: body?.channel })
      }
      return Response.json({ ok: true })
    },
  })

  const messages: ChatMessage[] = []
  const errors: string[] = []
  const transport = createSlackTransport({
    token: "xoxb-test",
    apiUrl: `http://127.0.0.1:${api.port}/api`,
    onMessage: (message) => messages.push(message),
    onError: (error) => errors.push(error),
  })

  return { transport, calls, messages, errors, close: () => api.stop(true) }
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await Bun.sleep(20)
  }
}

function event(payload: Record<string, unknown>, eventId = "Ev1"): string {
  return JSON.stringify({ type: "event_callback", event_id: eventId, event: payload })
}

describe("the slack transport", () => {
  test("reads a mention with the app mention stripped and answers in a thread", () => {
    const harnessed = harness()
    try {
      const message = harnessed.transport!.receive!(
        event({
          type: "app_mention",
          channel: "C1",
          user: "U1",
          text: "<@U0BOT> deploy the site",
          ts: "111.222",
        }),
      )
      expect(message).toMatchObject({
        platform: "slack",
        channelId: "C1",
        userId: "U1",
        text: "deploy the site",
        // A mention outside a thread starts one on the question, so the answer
        // cannot scatter down a busy channel.
        threadId: "111.222",
      })
    } finally {
      harnessed.close()
    }
  })

  test("keeps the thread a question was asked in and reads slack links", () => {
    const harnessed = harness()
    try {
      const message = harnessed.transport!.receive!(
        event({
          type: "message",
          channel: "C1",
          user: "U2",
          text: "check <https://example.test/report|the report> &amp; summarize",
          ts: "222.333",
          thread_ts: "111.222",
        }),
      )
      expect(message).toMatchObject({ text: "check the report (https://example.test/report) & summarize", threadId: "111.222" })
    } finally {
      harnessed.close()
    }
  })

  test("ignores its own posts, edits and a delivery slack repeats", () => {
    const harnessed = harness()
    try {
      const transport = harnessed.transport!
      expect(transport.receive!(event({ type: "message", channel: "C1", bot_id: "B1", text: "hi" }))).toBeUndefined()
      expect(transport.receive!(event({ type: "message", channel: "C1", user: "U1", subtype: "message_changed" }))).toBeUndefined()
      const question = event({ type: "message", channel: "C1", user: "U1", text: "hello", ts: "1.1" }, "Ev9")
      expect(transport.receive!(question)).toBeDefined()
      // Slack resends an event it did not see acknowledged; the turn runs once.
      expect(transport.receive!(question)).toBeUndefined()
    } finally {
      harnessed.close()
    }
  })

  test("answers over chat.postMessage with mrkdwn and the thread", async () => {
    const harnessed = harness()
    try {
      harnessed.transport!.send(MESSAGE, { text: "**Deploying.** [log](https://example.test/log)" })
      await waitFor(() => harnessed.calls.length === 1, "a reply")
      const sent = harnessed.calls[0]!
      expect(sent.method).toBe("chat.postMessage")
      expect(sent.body).toMatchObject({ channel: "C1", thread_ts: "111.222", text: "*Deploying.* <https://example.test/log|log>" })
      expect(sent.authorization).toBe("Bearer xoxb-test")
    } finally {
      harnessed.close()
    }
  })

  test("delivers an answer longer than one message as consecutive messages", async () => {
    const harnessed = harness()
    try {
      const paragraph = "a line that is long enough to matter\n"
      harnessed.transport!.send(MESSAGE, { text: paragraph.repeat(400) })
      await waitFor(() => harnessed.calls.length >= 2, "the split answer")
      const total = harnessed.calls.map((call) => String(call.body?.text)).join("")
      expect(total.length).toBeGreaterThan(3_800)
      expect(harnessed.calls.every((call) => String(call.body?.text).length <= 3_800)).toBe(true)
    } finally {
      harnessed.close()
    }
  })

  test("edits one trace message while working and deletes it afterwards", async () => {
    const harnessed = harness()
    try {
      const trace = harnessed.transport!.trace!(MESSAGE)!
      trace.update("reading files")
      await waitFor(() => harnessed.calls.some((call) => call.method === "chat.postMessage"), "the trace")
      trace.update("running tests")
      await waitFor(() => harnessed.calls.some((call) => call.method === "chat.update"), "the trace edit")
      trace.remove()
      await waitFor(() => harnessed.calls.some((call) => call.method === "chat.delete"), "the trace removal")
      const update = harnessed.calls.find((call) => call.method === "chat.update")!
      expect(update.body).toMatchObject({ channel: "C1", ts: "ts-1", text: "running tests" })
    } finally {
      harnessed.close()
    }
  })

  test("reports a refused call instead of dropping the answer", async () => {
    const api = Bun.serve({
      port: 0,
      fetch: () => Response.json({ ok: false, error: "not_in_channel" }),
    })
    const errors: string[] = []
    const transport = createSlackTransport({
      token: "xoxb-test",
      apiUrl: `http://127.0.0.1:${api.port}/api`,
      onMessage: () => {},
      onError: (error) => errors.push(error),
    })
    try {
      transport!.send(MESSAGE, { text: "hello" })
      await waitFor(() => errors.length === 1, "the failure")
      expect(errors[0]).toContain("not_in_channel")
    } finally {
      api.stop(true)
    }
  })
})

describe("the slack request url handshake", () => {
  test("reads the challenge out of the verification event", () => {
    expect(slackChallenge(JSON.stringify({ type: "url_verification", challenge: "abc123" }))).toBe("abc123")
    expect(slackChallenge(event({ type: "message", text: "hi" }))).toBeUndefined()
  })

  test("echoes it so the webhook can answer slack while the app is being saved", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnia-slack-"))
    const runtime = new ChatChannelsRuntime({ file: join(dir, "channels.json"), verify: async () => ({ ok: true }) })
    try {
      runtime.connect("slack", { botToken: "xoxb-test", signingSecret: "secret" })
      const answered = await runtime.handleWebhook(
        "slack",
        new Headers({ "x-slack-signature": "v0=ignored" }),
        JSON.stringify({ type: "url_verification", challenge: "abc123" }),
      )
      expect(answered).toEqual({ ok: true, status: 200, challenge: "abc123" })
    } finally {
      runtime.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("slack mrkdwn", () => {
  test("turns headings, task lists, tables and bold into what slack draws", () => {
    const converted = toSlackMarkdown(
      "# Results\n\n- [x] shipped\n- [ ] pending\n\n| name | total |\n| --- | --- |\n| a | 1 |\n\n**done**\n",
    )
    expect(converted).toContain("*Results*")
    expect(converted).toContain("- ☑ shipped")
    expect(converted).toContain("- ☐ pending")
    expect(converted).toContain("| a    | 1     |")
    expect(converted).toContain("*done*")
  })

  test("leaves a code block exactly as the model wrote it", () => {
    const source = "```md\n# not a heading\n**not bold**\n```"
    expect(toSlackMarkdown(source)).toBe(source)
  })
})
