import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "fs/promises"
import os from "os"
import path from "path"
import { Effect } from "effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Handoff } from "@/handoff"
import { HandoffDormant } from "@/handoff/dormant"
import { HandoffPacket } from "@/handoff/packet"
import { HandoffTrigger } from "@/handoff/trigger"
import { Session } from "@/session/session"
import { Agent } from "@/agent/agent"
import { MessageID, PartID, SessionID } from "@/session/schema"
import type { TaskPromptOps } from "@/tool/task"

const directory = await mkdtemp(path.join(os.tmpdir(), "omnia-handoff-"))

afterAll(async () => {
  await rm(directory, { recursive: true, force: true })
})

async function project(name: string) {
  const root = path.join(directory, name)
  await Bun.write(
    path.join(root, ".omnia/agents/log-analyzer.md"),
    [
      "---",
      "description: Reads a failing test log and explains the first real failure.",
      "dormant: true",
      "agent: explore",
      "triggers:",
      "  - test-failure",
      "targets:",
      "  - src/cart.test.ts",
      "---",
      "You are a failure analyst. Do not edit files.",
      "",
    ].join("\n"),
  )
  return root
}

const session = (root: string) => ({
  id: "ses_handoff_test",
  agent: "build",
  directory: root,
})

describe("trigger detection", () => {
  test("recognizes test runners", () => {
    for (const command of [
      "bun test src/cart.test.ts",
      "npm test",
      "pnpm run test:unit",
      "npx vitest run",
      "python -m pytest -q",
      "go test ./...",
      "cargo test",
      "make test",
      "node --test",
    ]) {
      expect(HandoffTrigger.isTestCommand(command)).toBe(true)
    }
  })

  test("does not wake on unrelated commands", () => {
    for (const command of [
      "git commit -m test",
      "echo test",
      "grep -R 'test' src",
      "npm run build",
    ]) {
      expect(HandoffTrigger.isTestCommand(command)).toBe(false)
    }
  })
})

describe("dormant registry", () => {
  test("scans metadata and only hydrates the body on demand", async () => {
    const root = await project("registry")
    const agents = await HandoffDormant.scan(root)

    expect(agents).toHaveLength(1)
    expect(agents[0]).toMatchObject({
      name: "log-analyzer",
      agent: "explore",
      triggers: ["test-failure"],
      targets: ["src/cart.test.ts"],
    })
    expect("prompt" in agents[0]!).toBe(false)
    expect(await HandoffDormant.prompt(agents[0]!)).toContain("Do not edit files")
  })

  test("matches declared triggers and patterns", async () => {
    const root = await project("match")
    const agent = (await HandoffDormant.scan(root))[0]!
    expect(HandoffDormant.matches(agent, { kind: "test-failure", command: "bun test" })).toBe(true)
    expect(HandoffDormant.matches(agent, { kind: "manual" })).toBe(false)
  })
})

describe("execution packet", () => {
  test("records a failing test and its log only when a dormant agent claims it", async () => {
    const root = await project("packet")
    const prepared = await Handoff.prepare({
      root,
      session: session(root),
      tool: "bash",
      args: { command: "bun test src/cart.test.ts" },
      result: {
        output: "1 fail\nExpected 3, received 2\n  at src/cart.test.ts:14",
        metadata: { exit: 1 },
      },
      messages: [],
    })

    expect(prepared).toBeDefined()
    expect(prepared!.packet.status).toBe("running")
    expect(prepared!.packet.trigger).toMatchObject({ kind: "test-failure" })
    expect(prepared!.packet.targets).toEqual(["src/cart.test.ts"])
    expect(prepared!.logText).toContain("received 2")

    const packet = await HandoffPacket.read(root, session(root).id)
    expect(packet).toMatchObject({
      version: 1,
      sessionID: session(root).id,
      status: "running",
      trigger: { kind: "test-failure" },
    })
    expect(await Bun.file(HandoffPacket.logPath(root, session(root).id)).text()).toContain(
      "Expected 3, received 2",
    )
  })

  test("leaves ordinary test failures alone when no dormant agent matches", async () => {
    const root = path.join(directory, "unclaimed")
    const prepared = await Handoff.prepare({
      root,
      session: session(root),
      tool: "bash",
      args: { command: "bun test" },
      result: { output: "no tests", metadata: { exit: 1 } },
      messages: [],
    })
    expect(prepared).toBeUndefined()
    expect(await Bun.file(path.join(root, ".omnia")).exists()).toBe(false)
  })

  test("does not trigger on a successful command", async () => {
    const root = await project("success")
    const prepared = await Handoff.prepare({
      root,
      session: session(root),
      tool: "bash",
      args: { command: "bun test" },
      result: { output: "pass", metadata: { exit: 0 } },
      messages: [],
    })
    expect(prepared).toBeUndefined()
  })

  test("triggers a handoff from a regular subagent session", async () => {
    const root = await project("subagent")
    const prepared = await Handoff.prepare({
      root,
      session: { ...session(root), parentID: "ses_parent", metadata: { sessionMode: "build" } },
      tool: "bash",
      args: { command: "bun test" },
      result: { output: "fail", metadata: { exit: 1 } },
      messages: [],
    })
    expect(prepared).toBeDefined()
    expect(prepared!.packet.sessionID).toBe(session(root).id)
    expect(prepared!.packet.parentSessionID).toBe("ses_parent")
  })

  test("does not recurse from a handoff-spawned session", async () => {
    const root = await project("handoff-child")
    const prepared = await Handoff.prepare({
      root,
      session: {
        ...session(root),
        parentID: "ses_subagent",
        metadata: { handoff: { packet: "pkt_handoff", parent: "ses_parent" } },
      },
      tool: "bash",
      args: { command: "bun test" },
      result: { output: "fail", metadata: { exit: 1 } },
      messages: [],
    })
    expect(prepared).toBeUndefined()
  })

  test("creates an inbox for a target session that never failed a test", async () => {
    const root = path.join(directory, "inbox")
    await HandoffPacket.appendInbox(root, "ses_fresh", {
      role: "agent",
      sessionID: "ses_sender",
      text: "hello from a peer",
    })
    const inbox = await Bun.file(HandoffPacket.inboxPath(root, "ses_fresh")).text()
    expect(inbox).toContain("hello from a peer")
    expect(inbox).toContain('"sessionID":"ses_sender"')
  })
})

describe("hydration", () => {
  test("runs the child, completes the packet, and pushes the summary back", async () => {
    const root = await project("hydrate")
    const prepared = await Handoff.prepare({
      root,
      session: session(root),
      tool: "bash",
      args: { command: "bun test src/cart.test.ts" },
      result: { output: "1 fail\nExpected 3, received 2", metadata: { exit: 1 } },
      messages: [],
    })
    expect(prepared).toBeDefined()

    const calls: Array<{ sessionID: SessionID; text: string }> = []
    const childID = SessionID.make("ses_child")
    const parentID = SessionID.make(session(root).id)
    const reply = (id: SessionID, text: string): SessionV1.WithParts => ({
      info: {
        id: MessageID.ascending(),
        sessionID: id,
        role: "assistant",
        parentID: MessageID.ascending(),
        mode: "explore",
        agent: "explore",
        path: { cwd: root, root },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ModelV2.ID.make("test-model"),
        providerID: ProviderV2.ID.make("test"),
        time: { created: 1 },
      } satisfies SessionV1.Assistant,
      parts: [
        {
          id: PartID.ascending(),
          sessionID: id,
          messageID: MessageID.ascending(),
          type: "text",
          text,
        },
      ],
    })

    const ops = {
      cancel: () => Effect.void,
      resolvePromptParts: () => Effect.succeed([]),
      prompt: (input) => {
        const text = input.parts.find((part) => part.type === "text")?.text ?? ""
        calls.push({ sessionID: input.sessionID, text })
        return Effect.succeed(
          input.sessionID === childID
            ? reply(childID, "Cause: tax is added before rounding. Fix src/cart.ts.")
            : reply(parentID, "delivered"),
        )
      },
    } satisfies TaskPromptOps

    const sessions = {
      create: () => Effect.succeed({ id: childID } as Session.Info),
    } as unknown as Session.Interface
    const agents = {
      get: () => Effect.succeed({ name: "explore" } as Agent.Info),
    } as unknown as Agent.Interface

    await Effect.runPromise(
      Handoff.run({
        prepared: prepared!,
        agent: prepared!.matches[0]!,
        parent: { id: parentID, agent: "build" },
        ops,
        sessions,
        agents,
      }),
    )

    expect(calls[0]?.sessionID).toBe(childID)
    expect(calls[0]?.text).toContain("# Omnia dormant handoff")
    expect(calls[0]?.text).toContain("Expected 3, received 2")
    expect(calls[1]?.sessionID).toBe(parentID)
    expect(calls[1]?.text).toContain("<handoff_result")
    expect(calls[1]?.text).toContain("tax is added before rounding")

    const finished = await HandoffPacket.read(root, session(root).id)
    expect(finished?.status).toBe("completed")
    expect(finished?.summary).toContain("tax is added before rounding")
    expect(finished?.taskID).toBe(childID)
    expect(await Bun.file(HandoffPacket.inboxPath(root, session(root).id)).text()).toContain(
      "<handoff_result",
    )
  })

  test("keeps a foreground run quiet and lets the caller return the summary itself", async () => {
    const root = await project("hydrate-foreground")
    const prepared = await Handoff.prepare({
      root,
      session: session(root),
      tool: "bash",
      args: { command: "bun test src/cart.test.ts" },
      result: { output: "1 fail\nExpected 3, received 2", metadata: { exit: 1 } },
      messages: [],
    })
    expect(prepared).toBeDefined()

    const calls: Array<{ sessionID: SessionID; text: string }> = []
    const childID = SessionID.make("ses_child_foreground")
    const parentID = SessionID.make(session(root).id)
    const reply = (id: SessionID, text: string): SessionV1.WithParts => ({
      info: {
        id: MessageID.ascending(),
        sessionID: id,
        role: "assistant",
        parentID: MessageID.ascending(),
        mode: "explore",
        agent: "explore",
        path: { cwd: root, root },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ModelV2.ID.make("test-model"),
        providerID: ProviderV2.ID.make("test"),
        time: { created: 1 },
      } satisfies SessionV1.Assistant,
      parts: [
        {
          id: PartID.ascending(),
          sessionID: id,
          messageID: MessageID.ascending(),
          type: "text",
          text,
        },
      ],
    })

    const ops = {
      cancel: () => Effect.void,
      resolvePromptParts: () => Effect.succeed([]),
      prompt: (input) => {
        const text = input.parts.find((part) => part.type === "text")?.text ?? ""
        calls.push({ sessionID: input.sessionID, text })
        return Effect.succeed(reply(childID, "Cause: tax is added before rounding."))
      },
    } satisfies TaskPromptOps

    const sessions = {
      create: () => Effect.succeed({ id: childID } as Session.Info),
    } as unknown as Session.Interface
    const agents = {
      get: () => Effect.succeed({ name: "explore" } as Agent.Info),
    } as unknown as Agent.Interface

    await Effect.runPromise(
      Handoff.run({
        prepared: prepared!,
        agent: prepared!.matches[0]!,
        parent: { id: parentID, agent: "build" },
        ops,
        sessions,
        agents,
        deliver: false,
      }),
    )

    // Foreground callers read the packet, so the run must not also prompt the
    // parent or append a duplicate handoff result to its inbox.
    expect(calls).toHaveLength(1)
    expect(calls[0]?.sessionID).toBe(childID)
    expect(await Bun.file(HandoffPacket.inboxPath(root, session(root).id)).exists()).toBe(false)

    const finished = await HandoffPacket.read(root, session(root).id)
    expect(finished?.status).toBe("completed")
    expect(finished?.summary).toContain("tax is added before rounding")
  })
})

describe("prompt framing", () => {
  test("keeps the cacheable prefix free of per-run values", async () => {
    const root = await project("cache")
    const agent = (await HandoffDormant.scan(root))[0]!
    const body = await HandoffDormant.prompt(agent)
    const first = HandoffTrigger.staticContext(agent, root, session(root).id, body)
    const second = HandoffTrigger.staticContext(agent, root, session(root).id, body)

    expect(first).toBe(second)
    expect(first).not.toContain("bun test")
    expect(first).not.toContain("2026-")
    expect(first).toContain("Output contract")
  })

  test("labels a cross-session message with its sender", () => {
    const text = HandoffTrigger.envelope({ from: "ses_child", agent: "explore", message: "found the cause" })

    expect(text).toContain('<handoff_message from="session:ses_child" agent="explore">')
    expect(text).toContain("found the cause")
    expect(text).toContain("</handoff_message>")
  })
})
