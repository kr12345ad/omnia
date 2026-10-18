import type { ServerWebSocket } from "bun"
import { describe, expect, test } from "bun:test"
import { createDiscordTransport, splitReply } from "./discord"
import type { ChatMessage } from "./service"

function harness(options: { isConversation?: (channelId: string) => boolean } = {}) {
  const events: string[] = []
  const messages: ChatMessage[] = []
  const posts: Array<{
    method: string
    path: string
    body: Record<string, unknown> | undefined
    authorization: string | null
  }> = []
  let socket: ServerWebSocket<unknown> | undefined

  const api = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      const body = (await request.json().catch(() => undefined)) as Record<string, unknown> | undefined
      posts.push({ method: request.method, path, body, authorization: request.headers.get("authorization") })
      // The gateway reads the bot's own roles so a role mention can address it.
      // Discord's CDN answers the signed attachment link without the bot token.
      if (request.method === "GET" && path === "/file.png") {
        return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } })
      }
      if (request.method === "GET" && path === "/users/@me/guilds") return Response.json([{ id: "G1" }])
      if (request.method === "GET" && path === "/guilds/G1/members/bot-1") {
        return Response.json({ roles: ["1560837367546380379"] })
      }
      if (request.method === "POST" && /^\/channels\/[^/]+\/messages$/.test(path)) return Response.json({ id: "TRACE1" })
      if (request.method === "GET" && path === "/channels/C1/messages") {
        // A trace left behind by a run that died before deleting it.
        return Response.json([
          {
            id: "OLD1",
            content: "-# stale reasoning\u200b",
            author: { id: "bot-1", bot: true },
            timestamp: new Date(Date.now() - 60_000).toISOString(),
          },
          {
            id: "ANSWER1",
            content: "a real answer",
            author: { id: "bot-1", bot: true },
            timestamp: new Date(Date.now() - 60_000).toISOString(),
          },
        ])
      }
      return Response.json({ ok: true })
    },
  })

  const gateway = Bun.serve({
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return
      return new Response("upgrade required", { status: 400 })
    },
    websocket: {
      open(ws) {
        socket = ws
        ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 30_000 } }))
      },
      message(ws, raw) {
        const payload = JSON.parse(String(raw)) as { op: number }
        events.push(`op:${payload.op}`)
        if (payload.op === 2) {
          ws.send(JSON.stringify({ op: 0, t: "READY", d: { user: { id: "bot-1", username: "omnia" } } }))
        }
      },
    },
  })

  const transport = createDiscordTransport({
    token: "test-token",
    apiUrl: `http://127.0.0.1:${api.port}`,
    gatewayUrl: `ws://127.0.0.1:${gateway.port}/`,
    onMessage: (message) => messages.push(message),
    isConversation: options.isConversation ?? (() => false),
  })

  return {
    transport,
    messages,
    posts,
    events,
    url: `http://127.0.0.1:${api.port}`,
    deliver(payload: unknown) {
      socket?.send(JSON.stringify(payload))
    },
    async ready() {
      await waitFor(() => events.includes("op:2"), "identify")
    },
    close() {
      transport.stop()
      gateway.stop(true)
      api.stop(true)
    },
  }
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3_000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await Bun.sleep(10)
  }
}

describe("the discord transport", () => {
  test("answers a mention and posts the reply back to the same channel", async () => {
    const harnessed = harness()
    try {
      harnessed.transport.start()
      await harnessed.ready()
      harnessed.deliver({
        op: 0,
        t: "MESSAGE_CREATE",
        d: {
          id: "M1",
          channel_id: "C1",
          guild_id: "G1",
          content: "<@bot-1> deploy the site",
          author: { id: "U1", username: "krishnaa" },
        },
      })
      await waitFor(() => harnessed.messages.length === 1, "a message")
      const message = harnessed.messages[0]!
      expect(message.platform).toBe("discord")
      expect(message.text).toBe("deploy the site")
      expect(message.channelId).toBe("C1")
      expect(message.userId).toBe("U1")
      expect(message.userName).toBe("krishnaa")

      harnessed.transport.send(message, { text: "Deploying." })
      await waitFor(() => harnessed.posts.some((post) => post.path === "/channels/C1/messages"), "a reply")
      const reply = harnessed.posts.find((post) => post.path === "/channels/C1/messages")!
      expect(reply.body?.content).toBe("Deploying.")
      expect(reply.body?.allowed_mentions).toEqual({ parse: [] })
      expect(reply.authorization).toBe("Bot test-token")
      // The typing indicator tells a human that the agent is working.
      expect(harnessed.posts.some((post) => post.path === "/channels/C1/typing")).toBe(true)
    } finally {
      harnessed.close()
    }
  })

  test("ignores its own messages and guild chatter that does not name it", async () => {
    const harnessed = harness()
    try {
      harnessed.transport.start()
      await harnessed.ready()
      harnessed.deliver({
        op: 0,
        t: "MESSAGE_CREATE",
        d: { channel_id: "C1", guild_id: "G1", content: "<@bot-1> hi", author: { id: "B1", username: "omnia", bot: true } },
      })
      harnessed.deliver({
        op: 0,
        t: "MESSAGE_CREATE",
        d: { channel_id: "C1", guild_id: "G1", content: "just chatting", author: { id: "U2", username: "someone" } },
      })
      await Bun.sleep(100)
      expect(harnessed.messages).toEqual([])
    } finally {
      harnessed.close()
    }
  })

  test("keeps answering a channel that is already a conversation", async () => {
    const harnessed = harness({ isConversation: (channelId) => channelId === "C1" })
    try {
      harnessed.transport.start()
      await harnessed.ready()
      harnessed.deliver({
        op: 0,
        t: "MESSAGE_CREATE",
        d: { channel_id: "C1", guild_id: "G1", content: "and then?", author: { id: "U1", username: "krishnaa" } },
      })
      await waitFor(() => harnessed.messages.length === 1, "a follow-up")
      expect(harnessed.messages[0]!.text).toBe("and then?")
    } finally {
      harnessed.close()
    }
  })

  test("answers a reply to one of its own messages", async () => {
    const harnessed = harness()
    try {
      harnessed.transport.start()
      await harnessed.ready()
      harnessed.deliver({
        op: 0,
        t: "MESSAGE_CREATE",
        d: {
          channel_id: "C9",
          guild_id: "G1",
          content: "what about the tests?",
          author: { id: "U1", username: "krishnaa" },
          referenced_message: {
            author: { id: "bot-1", username: "omnia", bot: true },
            content: "The deploy broke on the migration step.",
          },
        },
      })
      await waitFor(() => harnessed.messages.length === 1, "a reply to the bot")
      expect(harnessed.messages[0]!.text).toBe("what about the tests?")
      // The reply is a question about the answered message, so that message
      // travels with it: the channel's session may not hold it.
      expect(harnessed.messages[0]!.replyTo).toEqual({
        author: "omnia",
        text: "The deploy broke on the migration step.",
      })
    } finally {
      harnessed.close()
    }
  })

  test("a reply with no quoted text carries no quote", async () => {
    const harnessed = harness()
    try {
      harnessed.transport.start()
      await harnessed.ready()
      harnessed.deliver({
        op: 0,
        t: "MESSAGE_CREATE",
        d: {
          channel_id: "C9",
          guild_id: "G1",
          content: "what about the tests?",
          author: { id: "U1", username: "krishnaa" },
          referenced_message: { author: { id: "bot-1", username: "omnia", bot: true } },
        },
      })
      await waitFor(() => harnessed.messages.length === 1, "a reply to the bot")
      expect(harnessed.messages[0]!.replyTo).toBeUndefined()
    } finally {
      harnessed.close()
    }
  })

  test("a mention of a role the bot wears addresses it", async () => {
    const harnessed = harness()
    try {
      harnessed.transport.start()
      await harnessed.ready()
      await waitFor(
        () => harnessed.posts.some((post) => post.path === "/guilds/G1/members/bot-1"),
        "the bot's roles",
      )
      harnessed.deliver({
        op: 0,
        t: "MESSAGE_CREATE",
        d: {
          channel_id: "C1",
          guild_id: "G1",
          content: "<@&1560837367546380379> what can you do from here",
          author: { id: "U1", username: "krishnaa" },
        },
      })
      await waitFor(() => harnessed.messages.length === 1, "a role mention")
      expect(harnessed.messages[0]!.text).toBe("what can you do from here")
    } finally {
      harnessed.close()
    }
  })

  test("edits one trace message while working and deletes it afterwards", async () => {
    const harnessed = harness()
    try {
      harnessed.transport.start()
      await harnessed.ready()
      const trace = harnessed.transport.trace!({ platform: "discord", channelId: "C1", userId: "U1", text: "go", receivedAt: 0 })
      trace!.update("-# thinking…")
      await waitFor(
        () => harnessed.posts.some((post) => post.method === "POST" && post.path === "/channels/C1/messages"),
        "a trace message",
      )
      trace!.update("-# ✓ bash · ls")
      await waitFor(
        () => harnessed.posts.some((post) => post.method === "PATCH" && post.path === "/channels/C1/messages/TRACE1"),
        "a trace edit",
      )
      trace!.remove()
      await waitFor(
        () => harnessed.posts.some((post) => post.method === "DELETE" && post.path === "/channels/C1/messages/TRACE1"),
        "a trace delete",
      )
      const contents = harnessed.posts
        .filter((post) => post.path === "/channels/C1/messages" || post.path.endsWith("/TRACE1"))
        .flatMap((post) => [post.body?.content])
      expect(contents.join("\n")).toContain("-# thinking…")
    } finally {
      harnessed.close()
    }
  })

  test("a new run sweeps the trace a dead run left behind", async () => {
    const harnessed = harness()
    try {
      harnessed.transport.start()
      await harnessed.ready()
      const trace = harnessed.transport.trace!({ platform: "discord", channelId: "C1", userId: "U1", text: "go", receivedAt: 0 })
      trace!.update("-# fresh run")
      await waitFor(
        () => harnessed.posts.some((post) => post.method === "DELETE" && post.path === "/channels/C1/messages/OLD1"),
        "the stale trace to be deleted",
      )
      // A real answer is not a trace and must survive the sweep.
      expect(harnessed.posts.some((post) => post.path === "/channels/C1/messages/ANSWER1")).toBe(false)
    } finally {
      harnessed.close()
    }
  })

  test("a removed trace stops editing instead of chasing a deleted message", async () => {
    const harnessed = harness()
    try {
      harnessed.transport.start()
      await harnessed.ready()
      const trace = harnessed.transport.trace!({ platform: "discord", channelId: "C1", userId: "U1", text: "go", receivedAt: 0 })
      trace!.update("-# thinking…")
      await waitFor(
        () => harnessed.posts.some((post) => post.method === "POST" && post.path === "/channels/C1/messages"),
        "a trace message",
      )
      trace!.remove()
      await waitFor(
        () => harnessed.posts.some((post) => post.method === "DELETE" && post.path === "/channels/C1/messages/TRACE1"),
        "a trace delete",
      )
      const before = harnessed.posts.length
      trace!.update("-# late update")
      await Bun.sleep(1_500)
      expect(harnessed.posts.length).toBe(before)
    } finally {
      harnessed.close()
    }
  })

  test("posts a long answer as several messages instead of cutting it off", async () => {
    const harnessed = harness()
    try {
      harnessed.transport.start()
      await harnessed.ready()
      const text = Array.from({ length: 400 }, (_, index) => `line ${index + 1} of a long answer`).join("\n")
      expect(text.length).toBeGreaterThan(2000)
      harnessed.transport.send(
        { platform: "discord", channelId: "C1", userId: "U1", text: "go", receivedAt: 0 },
        { text },
      )
      const pieces = splitReply(text)
      expect(pieces.length).toBeGreaterThan(1)
      await waitFor(
        () => harnessed.posts.filter((post) => post.method === "POST" && post.path === "/channels/C1/messages").length >= pieces.length,
        "every piece of the answer",
      )
      const contents = harnessed.posts
        .filter((post) => post.method === "POST" && post.path === "/channels/C1/messages")
        .map((post) => String(post.body?.content))
      expect(contents.every((content) => content.length <= 2000)).toBe(true)
      // Every piece of the answer is posted, with nothing dropped in between.
      expect(contents.join("\n").split(/\s+/).join(" ")).toBe(text.split(/\s+/).join(" "))
    } finally {
      harnessed.close()
    }
  })

  test("reconnects when Discord asks it to", async () => {
    const harnessed = harness()
    try {
      harnessed.transport.start()
      await harnessed.ready()
      harnessed.deliver({ op: 7 })
      await waitFor(() => harnessed.events.filter((event) => event === "op:2").length >= 2, "a second identify")
    } finally {
      harnessed.close()
    }
  })

  test("takes a direct message without a mention", async () => {
    const harnessed = harness()
    try {
      harnessed.transport.start()
      await harnessed.ready()
      harnessed.deliver({
        op: 0,
        t: "MESSAGE_CREATE",
        d: { channel_id: "D1", content: "what changed today?", author: { id: "U3", username: "dm-user" } },
      })
      await waitFor(() => harnessed.messages.length === 1, "a direct message")
      expect(harnessed.messages[0]!.text).toBe("what changed today?")
      expect(harnessed.messages[0]!.channelId).toBe("D1")
    } finally {
      harnessed.close()
    }
  })
})

describe("splitting a long discord reply", () => {
  test("keeps every message inside the 2000 character limit", () => {
    const text = "x".repeat(9_000)
    const chunks = splitReply(text)
    expect(chunks.length).toBe(5)
    expect(chunks.every((chunk) => chunk.length <= 2000)).toBe(true)
    expect(chunks.join("")).toBe(text)
  })

  test("cuts on a line break rather than through a word", () => {
    const chunks = splitReply("word ".repeat(1_000))
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((chunk) => chunk.length <= 2000 && !chunk.endsWith(" "))).toBe(true)
  })

  test("says the tail was omitted rather than dropping it silently", () => {
    const text = "word ".repeat(6_000)
    const chunks = splitReply(text)
    expect(chunks.length).toBeGreaterThan(8)
    expect(chunks.every((chunk) => chunk.length <= 2000)).toBe(true)
    expect(chunks.at(-1)).toContain("16,384")
  })
})

describe("discord attachments", () => {
  test("a screenshot comes through as a data url the model can see", async () => {
    const harnessed = harness({ isConversation: () => true })
    try {
      harnessed.transport.start()
      await harnessed.ready()
      harnessed.deliver({
        op: 0,
        t: "MESSAGE_CREATE",
        d: {
          id: "M2",
          channel_id: "C1",
          guild_id: "G1",
          content: "what is wrong here?",
          author: { id: "U1", username: "krishnaa" },
          attachments: [
            { filename: "shot.png", content_type: "image/png", url: `${harnessed.url}/file.png` },
          ],
        },
      })
      await waitFor(() => harnessed.messages.length === 1, "the message")
      const attachment = harnessed.messages[0]!.attachments?.[0]
      expect(attachment?.name).toBe("shot.png")
      expect(attachment?.mime).toBe("image/png")
      expect(await attachment?.load()).toBe("data:image/png;base64,iVBORw==")
    } finally {
      harnessed.close()
    }
  })

  test("a file with no words is still a message", async () => {
    const harnessed = harness({ isConversation: () => true })
    try {
      harnessed.transport.start()
      await harnessed.ready()
      harnessed.deliver({
        op: 0,
        t: "MESSAGE_CREATE",
        d: {
          id: "M3",
          channel_id: "C1",
          guild_id: "G1",
          content: "",
          author: { id: "U1", username: "krishnaa" },
          attachments: [{ filename: "shot.png", url: `${harnessed.url}/file.png` }],
        },
      })
      await waitFor(() => harnessed.messages.length === 1, "the file-only message")
      expect(harnessed.messages[0]!.text).toBe("")
      // Discord omits content_type for some uploads; the name still says what it is.
      expect(harnessed.messages[0]!.attachments?.[0]?.mime).toBe("image/png")
    } finally {
      harnessed.close()
    }
  })
})
