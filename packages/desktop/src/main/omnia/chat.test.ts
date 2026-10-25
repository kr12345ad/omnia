import { rmSync } from "node:fs"
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { writeTestAuthSession } from "../../../test-support/auth-session"
import { handlers } from "../../../test-support/electron"
import { activateTestUserData, useTestUserData } from "../../../test-support/user-data"
import { forgetEnterpriseProfile } from "./enterprise"

// One Electron substitution serves every main-process suite, so the handlers
// this file registers are read from the shared record and its fake app answers
// with a userData directory this suite owns.
const userData = useTestUserData("omnia-chat-")

const controlPlane = "https://control.example/omnia"
// The signed-in session is a real file in this suite's userData directory, so
// no module in this process is replaced for later suites.
let session: { url: string; clientToken: string } | undefined

// Other files in this directory replace ./server-call process-wide; restore its
// real delegation so these handlers reach the control-plane client under test.
const controlPlaneModule = await import("./control-plane")
mock.module("./server-call", () => ({ serverCall: controlPlaneModule.controlPlaneCall }))

const chat = await import("./chat")
chat.registerChatIpcHandlers()

type CapturedRequest = { url: string; method: string; body: unknown }
const requests: CapturedRequest[] = []
let responses: Response[] = []
const originalFetch = globalThis.fetch

const CHANNEL = { platform: "slack", enabled: true, configured: ["botToken", "signingSecret"] }

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function invoke(channel: string, ...args: unknown[]) {
  return Promise.resolve(handlers.get(channel)!({}, ...args))
}

beforeEach(() => {
  activateTestUserData(userData)
  // The real reader consults this, so no module is replaced for later suites.
  process.env.OMNIA_CONTROL_PLANE_URL = controlPlane
  delete process.env.OMNIA_ENTERPRISE_PROFILE
  forgetEnterpriseProfile()
  requests.length = 0
  responses = []
  session = { url: controlPlane, clientToken: "client-token" }
  writeTestAuthSession(userData, session)
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    })
    return responses.shift() ?? jsonResponse({ ok: true })
  }) as unknown as typeof fetch
})

afterAll(() => {
  globalThis.fetch = originalFetch
  delete process.env.OMNIA_CONTROL_PLANE_URL
  delete process.env.OMNIA_TEST_USER_DATA
  rmSync(userData, { force: true, recursive: true })
  mock.restore()
})

describe("chat IPC handlers", () => {
  test("registers the five channels", () => {
    for (const channel of [
      "chat-platforms",
      "chat-channels",
      "chat-connect",
      "chat-disconnect",
      "chat-set-enabled",
    ]) {
      expect(handlers.has(channel)).toBe(true)
    }
  })

  test("reads the catalog and the channel list without the envelope", async () => {
    responses = [
      jsonResponse({ ok: true, platforms: [{ id: "slack", name: "Slack" }] }),
      jsonResponse({ ok: true, channels: [CHANNEL] }),
    ]
    expect(await invoke("chat-platforms")).toEqual([{ id: "slack", name: "Slack" }])
    expect(await invoke("chat-channels")).toEqual([CHANNEL])
    expect(requests).toEqual([
      { url: `${controlPlane}/v1/chat/platforms`, method: "GET", body: undefined },
      { url: `${controlPlane}/v1/chat/channels`, method: "GET", body: undefined },
    ])
  })

  test("connects with POST and answers the server's own summary", async () => {
    responses = [jsonResponse({ ok: true, channel: CHANNEL })]
    const input = { platform: "slack", credentials: { botToken: "xoxb-token" } }
    expect(await invoke("chat-connect", input)).toEqual(CHANNEL)
    expect(requests).toEqual([{ url: `${controlPlane}/v1/chat/channels`, method: "POST", body: input }])
  })

  test("disconnects and enables through an encoded platform path", async () => {
    responses = [jsonResponse({ ok: true, removed: true }), jsonResponse({ ok: true, channel: { ...CHANNEL, enabled: false } })]
    expect(await invoke("chat-disconnect", "a/b")).toBe(true)
    expect(await invoke("chat-set-enabled", "slack", false)).toEqual({ ...CHANNEL, enabled: false })
    expect(requests).toEqual([
      { url: `${controlPlane}/v1/chat/channels/a%2Fb`, method: "DELETE", body: undefined },
      { url: `${controlPlane}/v1/chat/channels/slack`, method: "PATCH", body: { enabled: false } },
    ])
  })

  test("a removal the server did not confirm is not reported as removed", async () => {
    responses = [jsonResponse({ ok: true, removed: false })]
    expect(await invoke("chat-disconnect", "slack")).toBe(false)
  })

  test("rejects a refusal with the server's own message", async () => {
    responses = [
      jsonResponse(
        {
          ok: false,
          error: {
            code: "capability_not_entitled",
            message: "Chat channels are included in Pro.",
            capability: "chat_channels",
            plan: "free",
            retryable: false,
          },
        },
        402,
      ),
    ]
    const error = await invoke("chat-connect", { platform: "slack", credentials: {} }).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe("Chat channels are included in Pro.")
  })

  test("asks for a sign-in before the user has one", async () => {
    session = undefined
    writeTestAuthSession(userData, undefined)
    await expect(invoke("chat-channels")).rejects.toThrow("Sign in")
    expect(requests).toHaveLength(0)
  })
})
