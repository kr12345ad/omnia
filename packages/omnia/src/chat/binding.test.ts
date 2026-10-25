// A chat channel answers as the account that connected it. These tests are the
// boundary between "the right person is signed in" and "somebody else is": a
// different account, a signed-out control plane or an edited channel file all
// stop every channel before an agent turn is spent.
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ChatChannelsRuntime, type ChatMessage } from "./service"

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function storeFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "omnia-chat-binding-"))
  dirs.push(dir)
  return join(dir, "chat-channels.json")
}

const OWNER = { id: 230746284, login: "kr12345ad", provider: "github" as const }
const OTHER = { id: 99, login: "intruder", provider: "github" as const }

const message: ChatMessage = {
  platform: "slack",
  channelId: "C1",
  userId: "U1",
  text: "deploy the site",
  receivedAt: 1,
}

function runtime(file: string, profile: typeof OWNER | typeof OTHER | undefined, secret = "server-token") {
  const channels = new ChatChannelsRuntime({ file, secret })
  channels.setIdentity(() => profile)
  channels.setAgentRunner(async () => "answered")
  return channels
}

describe("chat channel account binding", () => {
  test("binds the channel to the account that connected it", () => {
    const file = storeFile()
    const owner = runtime(file, OWNER)
    owner.connect("slack", { botToken: "xoxb-token" })

    expect(owner.describeOne("slack")?.owner).toEqual({
      provider: "github",
      id: "230746284",
      login: "kr12345ad",
    })
    // The binding is signed, so the file cannot be edited into another account.
    const stored = JSON.parse(readFileSync(file, "utf8")) as {
      channels: Array<{ owner?: { login?: string }; ownerBinding?: string }>
    }
    expect(stored.channels[0]?.owner?.login).toBe("kr12345ad")
    expect(stored.channels[0]?.ownerBinding).toMatch(/^[0-9a-f]{64}$/)
  })

  test("answers normally while the bound account is signed in", async () => {
    const file = storeFile()
    const owner = runtime(file, OWNER)
    owner.connect("slack", { botToken: "xoxb-token" })

    expect((await owner.answer(message)).reply).toBe("answered")
    expect(owner.describeOne("slack")?.error).toBeUndefined()
  })

  test("refuses every channel after a different account signs in", async () => {
    const file = storeFile()
    runtime(file, OWNER).connect("slack", { botToken: "xoxb-token" })

    let runs = 0
    const other = runtime(file, OTHER)
    other.setAgentRunner(async () => {
      runs += 1
      return "answered"
    })
    const answered = await other.answer(message)

    // No agent turn: the model is never reached under the new account. The
    // channel is told why instead of going silent.
    expect(runs).toBe(0)
    expect(answered.reply).toContain("bound to @kr12345ad")
    expect(answered.ok).toBe(true)
    // The reason lands where the settings panel shows it.
    expect(other.describeOne("slack")?.error).toContain("bound to @kr12345ad")
    // A refused message is not counted as an answered one.
    expect(other.describeOne("slack")?.messageCount ?? 0).toBe(0)
  })

  test("refuses while nobody is signed in", async () => {
    const file = storeFile()
    runtime(file, OWNER).connect("slack", { botToken: "xoxb-token" })

    const signedOut = runtime(file, undefined)
    expect((await signedOut.answer(message)).reply).toContain("no Omnia account is signed in")
    expect(signedOut.describeOne("slack")?.error).toContain("no Omnia account is signed in")
  })

  test("refuses a channel whose stored binding was edited", async () => {
    const file = storeFile()
    runtime(file, OWNER).connect("slack", { botToken: "xoxb-token" })

    // Point the channel at the intruder's id while keeping the original
    // signature: the identity check passes and the signature is what refuses.
    const stored = JSON.parse(readFileSync(file, "utf8")) as {
      channels: Array<{ owner?: unknown }>
    }
    stored.channels[0]!.owner = { provider: "github", id: "99", login: "kr12345ad", boundAt: 1 }
    writeFileSync(file, JSON.stringify(stored))

    const tampered = runtime(file, OTHER)
    expect((await tampered.answer(message)).reply).toContain("binding was altered")
    expect(tampered.describeOne("slack")?.error).toContain("binding was altered")
  })

  test("resumes once the bound account signs back in", async () => {
    const file = storeFile()
    runtime(file, OWNER).connect("slack", { botToken: "xoxb-token" })
    expect((await runtime(file, OTHER).answer(message)).reply).toContain("bound to @kr12345ad")

    const restored = runtime(file, OWNER)
    expect((await restored.answer(message)).reply).toBe("answered")
    // Signing back in clears the pause the other account recorded.
    expect(restored.describeOne("slack")?.error).toBeUndefined()
  })

  test("a process with no account does not hold a channel bound elsewhere", () => {
    const file = storeFile()
    runtime(file, OWNER).connect("slack", { botToken: "xoxb-token" })

    // Installs share the channel file by path, so a server nobody signed into
    // would otherwise connect the bot and answer every message with the pause
    // notice while the owner's process is connected too.
    const signedOut = runtime(file, undefined)
    const started: string[] = []
    signedOut.setTransportFactory(({ platform }) => {
      started.push(platform)
      return { start: () => {}, stop: () => {}, send: () => {} }
    })

    expect(started).toEqual([])
    // The reason still lands where the settings panel shows it.
    expect(signedOut.describeOne("slack")?.error).toContain("no Omnia account is signed in")
  })

  test("the transport starts once its owner signs in", () => {
    const file = storeFile()
    runtime(file, OWNER).connect("slack", { botToken: "xoxb-token" })

    let profile: typeof OWNER | typeof OTHER | undefined
    const channels = new ChatChannelsRuntime({ file, secret: "server-token" })
    channels.setIdentity(() => profile)
    const started: string[] = []
    channels.setTransportFactory(({ platform }) => {
      started.push(platform)
      return { start: () => {}, stop: () => {}, send: () => {} }
    })
    expect(started).toEqual([])

    profile = OWNER
    channels.sync()
    expect(started).toEqual(["slack"])
  })

  test("an install that signed out keeps answering with the reason", async () => {
    const file = storeFile()
    const owner = runtime(file, OWNER)
    owner.connect("slack", { botToken: "xoxb-token" })

    let profile: typeof OWNER | undefined = OWNER
    owner.setIdentity(() => profile)
    const started: string[] = []
    owner.setTransportFactory(({ platform }) => {
      started.push(platform)
      return { start: () => {}, stop: () => {}, send: () => {} }
    })
    expect(started).toEqual(["slack"])

    // Signing out is this install's own doing, so the connection stays and the
    // channel says why instead of going quiet. Another install that never had
    // an account never got this far.
    profile = undefined
    owner.sync()
    expect(started).toEqual(["slack"])
    expect((await owner.answer(message)).reply).toContain("no Omnia account is signed in")
  })

  test("another account cannot reconnect or remove an owned channel", () => {
    const file = storeFile()
    runtime(file, OWNER).connect("slack", { botToken: "xoxb-token" })

    const other = runtime(file, OTHER)
    // Removing a channel would be the way around the binding, so it is refused
    // for the same reason reconnecting is.
    expect(() => other.disconnect("slack")).toThrow(/bound to @kr12345ad/)
    expect(() => other.connect("slack", { botToken: "xoxb-intruder" })).toThrow(/bound to @kr12345ad/)
    expect(other.describeOne("slack")?.owner?.login).toBe("kr12345ad")
  })

  test("a channel connected before the binding existed waits for its owner to reconnect it", async () => {
    const file = storeFile()
    writeFileSync(
      file,
      JSON.stringify({ channels: [{ platform: "slack", enabled: true, credentials: { botToken: "xoxb-token" } }] }),
    )

    // Never inferred from whoever is running: two Omnia processes share this
    // file, so the owner has to be the account that reconnects it.
    const owner = runtime(file, OWNER)
    expect(owner.describeOne("slack")?.owner).toBeUndefined()
    expect((await owner.answer(message)).reply).toContain("not bound to an account yet")
    expect(owner.describeOne("slack")?.error).toContain("not bound to an account yet")

    owner.connect("slack", { botToken: "xoxb-token" })
    expect(owner.describeOne("slack")?.owner?.login).toBe("kr12345ad")
    expect((await owner.answer(message)).reply).toBe("answered")
    expect((await runtime(file, OTHER).answer(message)).reply).toContain("bound to @kr12345ad")
  })

  test("the webhook answers a paused delivery with the reason", async () => {
    const file = storeFile()
    runtime(file, OWNER).connect("slack", { botToken: "xoxb-token", signingSecret: "signing-secret" })

    const other = new ChatChannelsRuntime({ file, secret: "server-token", verify: async () => ({ ok: true }) })
    other.setIdentity(() => OTHER)
    const answered = await other.handleWebhook(
      "slack",
      new Headers(),
      JSON.stringify({ user: "U1", channel: "C1", text: "deploy the site" }),
    )

    // The platform gets a normal 200 carrying the reason, not a silent 200.
    expect(answered.status).toBe(200)
    expect(answered.reply).toContain("bound to @kr12345ad")
  })
})
