import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Effect, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Session } from "@/session/session"
import type { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID } from "../../src/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"

import { DiscussionRoomTool, parseDiscussionAssignments } from "../../src/tool/discussion"
import type { TaskPromptOps } from "../../src/tool/task"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const layer = () =>
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      BackgroundJob.node,
      EventV2Bridge.node,
      Config.node,
      CrossSpawnSpawner.node,
      Session.node,
      SessionProjector.node,
      SessionRunState.node,
      SessionStatus.node,
      Truncate.node,
      ToolRegistry.node,
      Database.node,
      RuntimeFlags.node,
      Ripgrep.node,
    ]),
  )

const it = testEffect(layer())

const seed = Effect.fn("DiscussionToolTest.seed")(function* (metadata?: Record<string, unknown>) {
  const session = yield* Session.Service
  const chat = yield* session.create({ title: "Room host", ...(metadata === undefined ? {} : { metadata }) })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

function promptText(input: SessionPrompt.PromptInput): string {
  return input.parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter((text) => text.length > 0)
    .join("\n")
}

function reply(input: SessionPrompt.PromptInput, text: string): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      mode: input.agent ?? "build",
      agent: input.agent ?? "build",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: input.model?.modelID ?? ref.modelID,
      providerID: input.model?.providerID ?? ref.providerID,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [{ id: PartID.ascending(), messageID: id, sessionID: input.sessionID, type: "text", text }],
  }
}

const DECISION = [
  "## Decision",
  "Ship the prototype.",
  "@strategist: Write the launch brief.",
  "@builder: Build the prototype.",
  "@researcher: Verify the market numbers.",
  "@critic: Stress-test the failure modes.",
].join("\n")

function stubOps(seen: SessionPrompt.PromptInput[]): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.sync(() => {
        seen.push(input)
        const text = promptText(input)
        if (input.agent === "discussion-manager") {
          return reply(input, text.includes("Decide now") ? DECISION : "Framing: decide whether to ship.")
        }
        if (text.includes("Break off")) return reply(input, `work report from ${input.agent}`)
        return reply(input, `position from ${input.agent}`)
      }),
  }
}

describe("discussion room tool", () => {
  it.instance("runs a five-agent meeting and breaks off into work", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* DiscussionRoomTool
      const def = yield* tool.init()
      const seen: SessionPrompt.PromptInput[] = []
      const promptOps = stubOps(seen)

      const result = yield* def.execute(
        { topic: "Ship feature X", goal: "decide and build it", rounds: 1 },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(5)
      const manager = kids.find((kid) => kid.agent === "discussion-manager")
      expect(manager).toBeDefined()
      const specialists = kids.filter((kid) => kid.agent !== "discussion-manager")
      expect(specialists.map((kid) => kid.agent).sort()).toEqual([
        "discussion-builder",
        "discussion-critic",
        "discussion-researcher",
        "discussion-strategist",
      ])
      for (const specialist of specialists) {
        expect((specialist.metadata as { discussion?: { role?: string } }).discussion?.role).toBe("specialist")
      }

      // Manager: framing + decision. Each specialist: position + break-off report.
      expect(seen.filter((input) => input.agent === "discussion-manager")).toHaveLength(2)
      expect(seen.filter((input) => input.agent === "discussion-strategist")).toHaveLength(2)

      const breakOff = seen.filter((input) => promptText(input).includes("Break off"))
      expect(breakOff).toHaveLength(4)
      const strategistBreakOff = breakOff.find((input) => input.agent === "discussion-strategist")
      expect(promptText(strategistBreakOff!)).toContain("Write the launch brief.")
      expect(promptText(strategistBreakOff!)).toContain("task tool")

      expect(result.output).toContain('<discussion id="')
      expect(result.output).toContain("<decision>")
      expect(result.output).toContain("@builder: Build the prototype.")
      expect(result.output).toContain('<specialist role="critic"')
      expect(result.output).toContain("work report from discussion-critic")
      expect(result.metadata.managerSessionId).toBe(manager!.id)
      expect(result.metadata.specialistSessionIds).toHaveLength(4)
    }),
  )

  it.instance("refuses to run in Code mode", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed({ mode: "code" })
      const tool = yield* DiscussionRoomTool
      const def = yield* tool.init()
      const exit = yield* def
        .execute(
          { topic: "Ship feature X" },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps([]) },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
    }),
  )
})

describe("discussion assignments", () => {
  it.instance("parses one assignment per specialist", () =>
    Effect.sync(() => {
      const assignments = parseDiscussionAssignments(
        ["Decision: go", "- @strategist: plan it", "@builder: build it", "* researcher: check it", "noise"].join("\n"),
      )
      expect(assignments.strategist).toBe("plan it")
      expect(assignments.builder).toBe("build it")
      expect(assignments.researcher).toBe("check it")
      expect(assignments.critic).toBeUndefined()
    }),
  )
})
