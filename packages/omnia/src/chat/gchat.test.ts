import { describe, expect, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkGChatApp, createGChatTransport, toGChatMarkdown } from "./gchat"
import { ChatChannelsRuntime, type ChatMessage } from "./service"

const keys = generateKeyPairSync("rsa", {
  modulusLength: 2_048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
})

const CREDENTIALS = JSON.stringify({
  type: "service_account",
  project_id: "omnia-test",
  client_email: "omnia@omnia-test.iam.gserviceaccount.com",
  private_key: keys.privateKey,
})

const MESSAGE: ChatMessage = {
  platform: "gchat",
  channelId: "spaces/S1",
  userId: "users/U1",
  text: "go",
  threadId: "spaces/S1/threads/T1",
  receivedAt: 0,
}

function harness(options: { now?: () => number } = {}) {
  const calls: Array<{
    method: string
    path: string
    body: Record<string, unknown> | undefined
    authorization: string | null
  }> = []
  let counter = 0

  const api = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const body = (await request.json().catch(() => undefined)) as Record<string, unknown> | undefined
      calls.push({
        method: request.method,
        path: `${url.pathname}${url.search}`,
        body,
        authorization: request.headers.get("authorization"),
      })
      if (url.pathname === "/token") return Response.json({ access_token: `token-${++counter}`, expires_in: 3_600 })
      if (request.method === "POST" && /^\/v1\/spaces\/[^/]+\/messages$/.test(url.pathname)) {
        return Response.json({ name: `spaces/S1/messages/M${++counter}` })
      }
      if (request.method === "PATCH") return Response.json({ name: url.pathname.replace("/v1/", "") })
      return new Response(null, { status: 204 })
    },
  })

  const messages: ChatMessage[] = []
  const errors: string[] = []
  const transport = createGChatTransport({
    credentials: CREDENTIALS,
    apiUrl: `http://127.0.0.1:${api.port}/v1`,
    tokenUrl: `http://127.0.0.1:${api.port}/token`,
    onMessage: (message) => messages.push(message),
    onError: (error) => errors.push(error),
    ...(options.now === undefined ? {} : { now: options.now }),
  })

  return {
    transport,
    calls,
    messages,
    errors,
    close: () => api.stop(true),
  }
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await Bun.sleep(20)
  }
}

describe("the google chat transport", () => {
  test("reads a message event, with the app mention already stripped", () => {
    const harnessed = harness()
    try {
      const message = harnessed.transport!.receive!(
        JSON.stringify({
          type: "MESSAGE",
          space: { name: "spaces/S1", type: "ROOM" },
          message: {
            name: "spaces/S1/messages/M1",
            text: "@Omnia deploy the site",
            argumentText: " deploy the site",
            sender: { name: "users/U1", displayName: "Ada", type: "HUMAN" },
            thread: { name: "spaces/S1/threads/T1" },
          },
        }),
      )
      expect(message).toMatchObject({
        platform: "gchat",
        channelId: "spaces/S1",
        userId: "users/U1",
        userName: "Ada",
        text: "deploy the site",
        threadId: "spaces/S1/threads/T1",
      })
    } finally {
      harnessed.close()
    }
  })

  test("reads the wrapped event shape newer Chat apps receive", () => {
    const harnessed = harness()
    try {
      const message = harnessed.transport!.receive!(
        JSON.stringify({
          commonEventObject: { hostApp: "CHAT" },
          chat: {
            user: { name: "users/U2", displayName: "Grace" },
            space: { name: "spaces/S2" },
            messagePayload: {
              space: { name: "spaces/S2" },
              message: {
                name: "spaces/S2/messages/M9",
                text: "what changed?",
                sender: { name: "users/U2", type: "HUMAN" },
              },
            },
          },
        }),
      )
      expect(message).toMatchObject({ channelId: "spaces/S2", userId: "users/U2", userName: "Grace", text: "what changed?" })
    } finally {
      harnessed.close()
    }
  })

  test("ignores its own messages and a delivery Google repeats", () => {
    const harnessed = harness()
    try {
      const transport = harnessed.transport!
      const bot = JSON.stringify({
        type: "MESSAGE",
        space: { name: "spaces/S1" },
        message: { name: "spaces/S1/messages/M2", text: "hi", sender: { name: "users/BOT", type: "BOT" } },
      })
      expect(transport.receive!(bot)).toBeUndefined()

      const human = JSON.stringify({
        type: "MESSAGE",
        space: { name: "spaces/S1" },
        message: { name: "spaces/S1/messages/M3", text: "hello", sender: { name: "users/U1", type: "HUMAN" } },
      })
      expect(transport.receive!(human)).toBeDefined()
      // Google retries a delivery it could not answer; the turn must run once.
      expect(transport.receive!(human)).toBeUndefined()
    } finally {
      harnessed.close()
    }
  })

  test("answers in the user's thread with markdown rendering requested", async () => {
    const harnessed = harness()
    try {
      harnessed.transport!.send(MESSAGE, { text: "**Deploying.**" })
      await waitFor(
        () => harnessed.calls.some((call) => call.method === "POST" && call.path.startsWith("/v1/spaces/S1/messages")),
        "a reply",
      )
      const reply = harnessed.calls.find((call) => call.method === "POST" && call.path.startsWith("/v1/spaces/S1/messages"))!
      expect(reply.body?.text).toBe("**Deploying.**")
      // Without this every `**bold**` and `[link](url)` arrives as literal text.
      expect(reply.body?.markupSyntax).toBe("MARKUP_SYNTAX_MARKDOWN")
      expect(reply.body?.thread).toEqual({ name: "spaces/S1/threads/T1" })
      expect(reply.path).toContain("messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD")
      expect(reply.authorization).toMatch(/^Bearer token-/)
    } finally {
      harnessed.close()
    }
  })

  test("signs in once and reuses the access token", async () => {
    const harnessed = harness()
    try {
      harnessed.transport!.send(MESSAGE, { text: "one" })
      await waitFor(() => harnessed.calls.some((call) => call.method === "POST" && call.path.startsWith("/v1/spaces")), "a reply")
      harnessed.transport!.send(MESSAGE, { text: "two" })
      await waitFor(
        () =>
          harnessed.calls.filter((call) => call.method === "POST" && call.path.startsWith("/v1/spaces")).length >= 2,
        "the second reply",
      )
      expect(harnessed.calls.filter((call) => call.path === "/token").length).toBe(1)
    } finally {
      harnessed.close()
    }
  })

  test("requests a fresh token once the old one has expired", async () => {
    let clock = 1_000_000
    const harnessed = harness({ now: () => clock })
    try {
      harnessed.transport!.send(MESSAGE, { text: "one" })
      await waitFor(() => harnessed.calls.some((call) => call.path === "/token"), "a token")
      clock += 3_600_000
      harnessed.transport!.send(MESSAGE, { text: "two" })
      await waitFor(() => harnessed.calls.filter((call) => call.path === "/token").length === 2, "a refreshed token")
    } finally {
      harnessed.close()
    }
  })

  test("delivers an answer longer than one message as consecutive messages", async () => {
    const harnessed = harness()
    try {
      const text = Array.from({ length: 300 }, (_, index) => `line ${index + 1} of a long answer`).join("\n")
      harnessed.transport!.send(MESSAGE, { text })
      const posted = () => harnessed.calls.filter((call) => call.method === "POST" && call.path.startsWith("/v1/spaces/S1/messages"))
      await waitFor(() => posted().length >= 2, "the answer in pieces")
      await Bun.sleep(200)
      const pieces = posted().map((call) => String(call.body?.text))
      expect(pieces.every((piece) => piece.length <= 4_000)).toBe(true)
      expect(pieces.join("\n").split(/\s+/).join(" ")).toBe(text.split(/\s+/).join(" "))
    } finally {
      harnessed.close()
    }
  })

  test("edits one trace message while working and deletes it afterwards", async () => {
    const harnessed = harness()
    try {
      const trace = harnessed.transport!.trace!(MESSAGE)!
      trace.update("thinking…")
      await waitFor(
        () => harnessed.calls.some((call) => call.method === "POST" && call.path.startsWith("/v1/spaces")),
        "a trace message",
      )
      trace.update("✓ bash · ls")
      await waitFor(() => harnessed.calls.some((call) => call.method === "PATCH"), "a trace edit")
      trace.remove()
      await waitFor(() => harnessed.calls.some((call) => call.method === "DELETE"), "a trace delete")
      expect(harnessed.calls.find((call) => call.method === "PATCH")?.body?.text).toContain("bash")
    } finally {
      harnessed.close()
    }
  })

  test("refuses credentials that are not a service account", () => {
    const errors: string[] = []
    const transport = createGChatTransport({
      credentials: "{}",
      onMessage: () => {},
      onError: (error) => errors.push(error),
    })
    expect(transport).toBeUndefined()
    expect(errors[0]).toContain("service-account")
  })
})

describe("the google chat webhook", () => {
  test("acknowledges the delivery while the agent turn is still running", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnia-gchat-"))
    const runtime = new ChatChannelsRuntime({ file: join(dir, "channels.json"), verify: async () => ({ ok: true }) })
    try {
      runtime.connect("gchat", { credentials: "{}", audience: "https://example.test/webhook" })
      let release: (() => void) | undefined
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      runtime.setAgentRunner(async () => {
        await gate
        return "the answer"
      })
      const sent: string[] = []
      runtime.setTransportFactory(() => ({
        start: () => {},
        stop: () => {},
        send: (_message, reply) => sent.push(reply.text),
        receive: (body) => {
          const event = JSON.parse(body) as { message?: { text?: string } }
          if (event.message?.text === undefined) return undefined
          return {
            platform: "gchat",
            channelId: "spaces/S1",
            userId: "users/U1",
            text: event.message.text,
            receivedAt: 0,
          }
        },
      }))

      const acknowledged = await runtime.handleWebhook(
        "gchat",
        new Headers({ authorization: "Bearer google-token" }),
        JSON.stringify({ type: "MESSAGE", message: { name: "spaces/S1/messages/M1", text: "go" } }),
      )
      // Google gives the app 30 seconds; a turn takes minutes, so the delivery
      // is acknowledged first and answered over the transport afterwards.
      expect(acknowledged).toEqual({ ok: true, status: 200 })
      expect(sent).toEqual([])

      release!()
      await waitFor(() => sent.length === 1, "the answer")
      expect(sent[0]).toBe("the answer")
    } finally {
      runtime.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("asks Google to retry when its transport never started", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnia-gchat-"))
    const runtime = new ChatChannelsRuntime({ file: join(dir, "channels.json"), verify: async () => ({ ok: true }) })
    try {
      runtime.connect("gchat", { credentials: "not a service account", audience: "https://example.test/webhook" })
      const answered = await runtime.handleWebhook(
        "gchat",
        new Headers({ authorization: "Bearer google-token" }),
        JSON.stringify({ type: "MESSAGE", message: { text: "go" } }),
      )
      // Answering with a turn on the raw JSON would be worse than a retry.
      expect(answered).toEqual({ ok: false, status: 503 })
      expect(runtime.describeOne("gchat")?.error).toContain("service-account")
    } finally {
      runtime.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("the google chat app check", () => {
  function stub(handler: (url: URL, request: Request) => Response) {
    const api = Bun.serve({ port: 0, fetch: (request) => handler(new URL(request.url), request) })
    return {
      apiUrl: `http://127.0.0.1:${api.port}/v1`,
      tokenUrl: `http://127.0.0.1:${api.port}/token`,
      close: () => api.stop(true),
    }
  }

  test("reports nothing when the app answers", async () => {
    const server = stub((url) =>
      url.pathname === "/token"
        ? Response.json({ access_token: "token", expires_in: 3_600 })
        : Response.json({ spaces: [] }),
    )
    try {
      const problem = await checkGChatApp({ credentials: CREDENTIALS, apiUrl: server.apiUrl, tokenUrl: server.tokenUrl })
      expect(problem).toBeUndefined()
    } finally {
      server.close()
    }
  })

  test("names the missing console app when google has none", async () => {
    const server = stub((url) =>
      url.pathname === "/token"
        ? Response.json({ access_token: "token", expires_in: 3_600 })
        : // Google's own answer for a project whose Chat app was never configured.
          Response.json(
            {
              error: {
                code: 404,
                message:
                  "Google Chat app not found. To create a Chat app, you must turn on the Chat API and configure the app in the Google Cloud console.",
                status: "NOT_FOUND",
              },
            },
            { status: 404 },
          ),
    )
    try {
      const problem = await checkGChatApp({ credentials: CREDENTIALS, apiUrl: server.apiUrl, tokenUrl: server.tokenUrl })
      expect(problem).toContain("no Chat app configured")
      // The real prerequisite has to be in the message, not a bare status code.
      expect(problem).toContain("Google Workspace")
    } finally {
      server.close()
    }
  })

  test("surfaces a key google refuses", async () => {
    const server = stub(() => Response.json({ error: "invalid_grant" }, { status: 400 }))
    try {
      const problem = await checkGChatApp({ credentials: CREDENTIALS, tokenUrl: server.tokenUrl })
      expect(problem).toContain("rejected the service-account key")
      expect(problem).toContain("400")
    } finally {
      server.close()
    }
  })

  test("rejects credentials that are not a service account", async () => {
    expect(await checkGChatApp({ credentials: "{}" })).toContain("service-account")
  })

  test("records the reason on the channel so the panel can show it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnia-gchat-"))
    const runtime = new ChatChannelsRuntime({ file: join(dir, "channels.json") })
    try {
      runtime.connect("gchat", { credentials: "{}", audience: "https://example.test/webhook" })
      expect(runtime.describeOne("gchat")?.error).toBeUndefined()
      runtime.setChannelCheck(async (platform) => (platform === "gchat" ? "configure the app" : undefined))
      expect(await runtime.verify("gchat")).toBe("configure the app")
      expect(runtime.describeOne("gchat")?.error).toBe("configure the app")
      // Once the console is configured the stale reason goes away.
      runtime.setChannelCheck(async () => undefined)
      expect(await runtime.verify("gchat")).toBeUndefined()
      expect(runtime.describeOne("gchat")?.error).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("google chat markdown", () => {
  test("turns headings, task lists and tables into something Chat can draw", () => {
    const converted = toGChatMarkdown(
      "# Results\n\n- [x] shipped\n- [ ] pending\n\n| name | total |\n| --- | --- |\n| a | 1 |\n| bb | 22 |\n",
    )
    expect(converted).toContain("*Results*")
    expect(converted).toContain("- ☑ shipped")
    expect(converted).toContain("- ☐ pending")
    expect(converted).toContain("| name | total |")
    expect(converted).toContain("| a    | 1     |")
  })

  test("leaves a code block exactly as the model wrote it", () => {
    const source = "```md\n# not a heading\n- [ ] not a task\n```"
    expect(toGChatMarkdown(source)).toBe(source)
  })
})
