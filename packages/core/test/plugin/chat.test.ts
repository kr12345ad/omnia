import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { PluginHost } from "@opencode-ai/core/plugin/host"
import { ChatPlugin } from "@opencode-ai/core/plugin/chat"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

describe("chat plugin", () => {
  it.effect("registers a hidden chat agent that denies every tool", () =>
    Effect.gen(function* () {
      const agents = yield* AgentV2.Service
      const plugin = yield* PluginV2.Service
      const host = yield* PluginHost.make(plugin)

      yield* ChatPlugin.Plugin.effect(host)

      const chat = yield* agents.get(AgentV2.ID.make("chat"))
      expect(chat).toMatchObject({
        id: "chat",
        mode: "primary",
        hidden: true,
      })
      expect(chat?.system).toContain("You have no tools")
      expect(chat?.permissions).toEqual([{ action: "*", resource: "*", effect: "deny" }])
    }),
  )
})
