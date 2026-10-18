import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ChatChannelsRuntime, type ChatMessage } from "./service"

const event: ChatMessage = {
  platform: "gchat",
  channelId: "spaces/S1",
  userId: "U1",
  text: "go",
  receivedAt: 0,
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3_000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await Bun.sleep(10)
  }
}

function runtimeWith(file: string): ChatChannelsRuntime {
  const runtime = new ChatChannelsRuntime({ file, verify: async () => ({ ok: true }) })
  // A channel answers as the account that connected it, so these delivery
  // tests run as a signed-in one.
  runtime.setIdentity(() => ({ id: 1, login: "tester", provider: "github" }))
  runtime.connect("gchat", { credentials: "x", audience: "y" })
  return runtime
}

describe("chat delivery failures", () => {
  test("a send that throws is recorded against the channel, not dropped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnia-chat-delivery-"))
    const runtime = runtimeWith(join(dir, "channels.json"))
    try {
      runtime.setAgentRunner(async () => "the answer")
      let attempts = 0
      runtime.setTransportFactory(() => ({
        start: () => {},
        stop: () => {},
        send: () => {
          attempts += 1
          throw new Error("Discord POST failed")
        },
        receive: () => event,
      }))

      await runtime.handleWebhook("gchat", new Headers(), "{}")
      await waitFor(() => attempts >= 1, "a send attempt")
      expect(runtime.describeOne("gchat")?.error).toContain("Discord POST failed")
    } finally {
      runtime.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a transport whose trace cannot be opened still sends the answer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnia-chat-delivery-"))
    const runtime = runtimeWith(join(dir, "channels.json"))
    try {
      runtime.setAgentRunner(async () => "the answer")
      const sent: string[] = []
      runtime.setTransportFactory(() => ({
        start: () => {},
        stop: () => {},
        send: (_message, reply) => sent.push(reply.text),
        trace: () => {
          throw new Error("trace API unavailable")
        },
        receive: () => event,
      }))

      await runtime.handleWebhook("gchat", new Headers(), "{}")
      await waitFor(() => sent.length === 1, "the answer")
      // Progress is optional; the answer is not. A successful turn clears the
      // channel error, so what matters here is that the reply still goes out.
      expect(sent[0]).toBe("the answer")
    } finally {
      runtime.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
