import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { VisualizeTool } from "../../src/tool/visualize"
import { Truncate } from "@/tool/truncate"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Truncate.node, Agent.node])))

const ctx = {
  sessionID: SessionID.make("ses_visualize_test"),
  messageID: MessageID.make("msg_visualize_test"),
  callID: "call_visualize_test",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const program = 'root = Card([CardHeader("Weekly report"), BarChart(["a"], [Series("n", [1])])])'

describe("tool.visualize", () => {
  it.instance("carries the program to the client without echoing it into the result", () =>
    Effect.gen(function* () {
      const info = yield* VisualizeTool
      expect(info.id).toBe("visualize")

      const tool = yield* info.init()
      const result = yield* tool.execute({ code: program, title: "Weekly report" }, ctx)

      expect(result.title).toBe("Rendered Weekly report")
      expect(result.output).toBe("Rendered Weekly report.")
      expect(result.output).not.toContain("BarChart")
      expect(JSON.stringify(result.metadata)).not.toContain("BarChart")
    }),
  )

  it.instance("names the drawing without a title argument", () =>
    Effect.gen(function* () {
      const info = yield* VisualizeTool
      const tool = yield* info.init()

      const result = yield* tool.execute({ code: program }, ctx)

      expect(result.title).toBe("Rendered a visualization")
      expect(result.output).toBe("Rendered the visualization.")
    }),
  )
})
