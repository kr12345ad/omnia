// The chat channel routes: who may manage a channel, what a response may carry,
// and what a platform's own webhook can reach.
//
// A channel holds a platform's credentials, so these tests describe a boundary
// rather than a feature: management belongs to the signed-in desktop, a secret
// written in is never handed back, and the one unauthenticated path - the
// platform's webhook - is verified per platform and grants nothing on its own.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startOmniaServer } from "./server"

type Server = Awaited<ReturnType<typeof startOmniaServer>>

let dir = ""
let previous: Record<string, string | undefined> = {}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnia-chat-channels-"))
  previous = {
    OMNIA_SERVER_URL: process.env.OMNIA_SERVER_URL,
    OMNIA_SERVER_TOKEN: process.env.OMNIA_SERVER_TOKEN,
  }
  // No control plane configured: the entitlement gate is inert, so what these
  // tests describe is the route contract and not one plan's answer.
  delete process.env.OMNIA_SERVER_URL
  delete process.env.OMNIA_SERVER_TOKEN
})

afterEach(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(dir, { recursive: true, force: true })
})

async function withServer<T>(fn: (server: Server) => Promise<T>): Promise<T> {
  // A channel answers as the account that connected it, so these routes are
  // exercised as one signed-in operator rather than a signed-out plane.
  writeFileSync(
    join(dir, "auth.json"),
    JSON.stringify({ profile: { id: 1, login: "tester", provider: "github" }, token: "", signedInAt: 1 }),
  )
  const server = await startOmniaServer({
    token: "operator-token",
    authFile: join(dir, "auth.json"),
    credentialsFile: join(dir, "credentials.json"),
    chatChannelsFile: join(dir, "chat-channels.json"),
    // Never touch the operator's real conversation bindings from a test.
    chatSessionsFile: join(dir, "chat-sessions.json"),
  })
  try {
    return await fn(server)
  } finally {
    await server.stop()
  }
}

const operator = (server: Server) => ({ authorization: `Bearer ${server.token}` })

function send(server: Server, path: string, method: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${server.url}${path}`, {
    method,
    headers: { ...operator(server), "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
}

const connect = (server: Server, body: unknown) => send(server, "/v1/chat/channels", "POST", body)

const SLACK = { botToken: "xoxb-live-token", signingSecret: "slack-signing-secret" }

describe("chat channels", () => {
  test("the platform catalog is served to the operator with each platform's fields", async () => {
    await withServer(async (server) => {
      const response = await fetch(`${server.url}/v1/chat/platforms`, { headers: operator(server) })
      expect(response.status).toBe(200)
      const json = (await response.json()) as {
        platforms: Array<{ id: string; fields: Array<{ key: string; required?: boolean }> }>
      }
      const ids = json.platforms.map((platform) => platform.id)
      expect(ids).toContain("slack")
      expect(ids).toContain("telegram")
      expect(json.platforms.find((platform) => platform.id === "slack")?.fields.map((field) => field.key)).toEqual([
        "botToken",
        "signingSecret",
        "appId",
      ])
    })
  })

  test("an unauthenticated caller cannot read or write the channel table", async () => {
    await withServer(async (server) => {
      const read = await fetch(`${server.url}/v1/chat/channels`)
      expect(read.status).toBe(401)
      const write = await fetch(`${server.url}/v1/chat/channels`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ platform: "slack", credentials: SLACK }),
      })
      expect(write.status).toBe(401)
      const list = await fetch(`${server.url}/v1/chat/channels`, { headers: operator(server) })
      expect(((await list.json()) as { channels: unknown[] }).channels).toEqual([])
    })
  })

  test("connecting stores only the platform's own fields and never returns a value", async () => {
    await withServer(async (server) => {
      const created = await connect(server, {
        platform: "slack",
        credentials: { ...SLACK, injected: "not a slack field" },
      })
      expect(created.status).toBe(200)
      const body = (await created.json()) as { channel: { platform: string; enabled: boolean; configured: string[] } }
      expect(body.channel.platform).toBe("slack")
      expect(body.channel.enabled).toBe(true)
      // Exactly the platform's own fields, so a client cannot park arbitrary
      // values in the channel table.
      expect([...body.channel.configured].sort()).toEqual(["botToken", "signingSecret"])

      const listed = await fetch(`${server.url}/v1/chat/channels`, { headers: operator(server) })
      const text = await listed.text()
      expect(text).not.toContain(SLACK.botToken)
      expect(text).not.toContain(SLACK.signingSecret)
      expect(text).not.toContain("not a slack field")
    })
  })

  test("an unknown platform and a missing required field are refused with the field named", async () => {
    await withServer(async (server) => {
      const unknown = await connect(server, { platform: "myspace", credentials: {} })
      expect(unknown.status).toBe(400)

      const missing = await connect(server, { platform: "slack", credentials: { botToken: "xoxb-live-token" } })
      expect(missing.status).toBe(400)
      expect(await missing.text()).toContain("Signing secret")

      const list = await fetch(`${server.url}/v1/chat/channels`, { headers: operator(server) })
      expect(((await list.json()) as { channels: unknown[] }).channels).toEqual([])
    })
  })

  test("a channel is enabled, disabled and removed through its own platform id", async () => {
    await withServer(async (server) => {
      await connect(server, { platform: "slack", credentials: SLACK })

      const disabled = await send(server, "/v1/chat/channels/slack", "PATCH", { enabled: false })
      expect(disabled.status).toBe(200)
      expect(((await disabled.json()) as { channel: { enabled: boolean } }).channel.enabled).toBe(false)

      const unknown = await send(server, "/v1/chat/channels/telegram", "PATCH", { enabled: false })
      expect(unknown.status).toBe(404)

      const removed = await send(server, "/v1/chat/channels/slack", "DELETE", {})
      expect(removed.status).toBe(200)
      expect(((await removed.json()) as { removed: boolean }).removed).toBe(true)

      const list = await fetch(`${server.url}/v1/chat/channels`, { headers: operator(server) })
      expect(((await list.json()) as { channels: unknown[] }).channels).toEqual([])
    })
  })

  test("a webhook for a channel that is not connected grants nothing", async () => {
    await withServer(async (server) => {
      const response = await fetch(`${server.url}/v1/chat/slack/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "hello" }),
      })
      expect(response.status).toBe(404)
    })
  })

  test("a signed Slack delivery is accepted only with a valid signature", async () => {
    await withServer(async (server) => {
      await connect(server, { platform: "slack", credentials: SLACK })
      const body = JSON.stringify({ user: "U1", channel: "C1", text: "deploy the site" })
      const timestamp = String(Math.floor(Date.now() / 1000))
      const signature = `v0=${createHmac("sha256", SLACK.signingSecret)
        .update(`v0:${timestamp}:${body}`)
        .digest("hex")}`

      const forged = await fetch(`${server.url}/v1/chat/slack/webhook`, {
        method: "POST",
        headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": "v0=deadbeef" },
        body,
      })
      expect(forged.status).toBe(401)

      const signed = await fetch(`${server.url}/v1/chat/slack/webhook`, {
        method: "POST",
        headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": signature },
        body,
      })
      expect(signed.status).toBe(200)
      expect(((await signed.json()) as { ok: boolean }).ok).toBe(true)

      // The refused delivery recorded a reason and the accepted one cleared it,
      // so a forged delivery cannot leave a working channel looking broken.
      const listed = await fetch(`${server.url}/v1/chat/channels`, { headers: operator(server) })
      const channels = ((await listed.json()) as { channels: Array<{ error?: string }> }).channels
      expect(channels[0]?.error).toBeUndefined()
    })
  })
})
