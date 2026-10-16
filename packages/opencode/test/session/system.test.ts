import { describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import type { Agent } from "../../src/agent/agent"
import { NamedError } from "@opencode-ai/core/util/error"
import { Skill } from "../../src/skill"
import { Permission } from "../../src/permission"
import type { Provider } from "../../src/provider/provider"
import { SystemPrompt } from "../../src/session/system"
import { MCP } from "../../src/mcp"
import { testEffect } from "../lib/effect"
import { OPENUI_EXTENSION_PROMPT, OPENUI_EXTENSION_SIGNATURES } from "@opencode-ai/core/openui/extensions"
import { OPENUI_SYSTEM_PROMPT } from "@opencode-ai/core/openui/prompt"

const skills: Skill.Info[] = [
  {
    name: "zeta-skill",
    description: "Zeta skill.",
    location: "/tmp/zeta-skill/SKILL.md",
    content: "# zeta-skill",
  },
  {
    name: "alpha-skill",
    description: "Alpha skill.",
    location: "/tmp/alpha-skill/SKILL.md",
    content: "# alpha-skill",
  },
  {
    name: "middle-skill",
    description: "Middle skill.",
    location: "/tmp/middle-skill/SKILL.md",
    content: "# middle-skill",
  },
  {
    name: "manual-skill",
    location: "/tmp/manual-skill/SKILL.md",
    content: "# manual-skill",
  },
]

const build: Agent.Info = {
  name: "build",
  mode: "primary",
  permission: Permission.fromConfig({ "*": "allow" }),
  options: {},
}

const it = testEffect(
  LayerNode.compile(SystemPrompt.node, [
    [
      MCP.node,
      Layer.mock(MCP.Service, {
        instructions: () =>
          Effect.succeed([
            {
              name: "guide-server",
              instructions: "Use lookup before mutate.",
              tools: [],
            },
            {
              name: "tool-server",
              instructions: "Prefer search before update.",
              tools: ["tool-server_search", "tool-server_update"],
            },
          ]),
      }),
    ],
    [
      Skill.node,
      Layer.succeed(
        Skill.Service,
        Skill.Service.of({
          get: (name) => Effect.succeed(skills.find((skill) => skill.name === name)),
          require: (name) => {
            const info = skills.find((skill) => skill.name === name)
            if (info) return Effect.succeed(info)
            return Effect.fail(new Skill.NotFoundError({ name, available: skills.map((skill) => skill.name) }))
          },
          all: () => Effect.succeed(skills),
          dirs: () => Effect.succeed([]),
          available: () => Effect.succeed(skills),
        }),
      ),
    ],
  ]),
)

describe("session.system", () => {
  test("selects the Meta prompt for Muse Spark model IDs", () => {
    for (const id of ["meta/muse-spark-preview", "muse-spark-1.1", "muse-spark-1.2"]) {
      const prompt = SystemPrompt.provider({ api: { id } } as Provider.Model)[0]
      expect(prompt).toContain("powered by Muse Spark,")
      expect(prompt).toContain("using Meta Muse Spark.")
      expect(prompt).not.toContain("{{MODEL_NAME}}")
    }
  })

  test("selects the Meta prompt for Muse Glimmer model IDs", () => {
    for (const id of ["meta/muse-glimmer", "meta/muse-glimmer-30b", "muse-glimmer-30b"]) {
      const prompt = SystemPrompt.provider({ api: { id } } as Provider.Model)[0]
      expect(prompt).toContain("powered by Muse Glimmer,")
      expect(prompt).toContain("using Meta Muse Glimmer.")
      expect(prompt).not.toContain("{{MODEL_NAME}}")
    }
  })

  test("chat mode contributes an operational playbook for chat sessions", () => {
    const playbook = SystemPrompt.chatMode().join("\n")
    expect(playbook).toContain("# Chat mode")
    // The disciplines that decide whether a coding agent's change actually
    // works: read before editing, verify before claiming, and report honestly.
    expect(playbook).toContain("Read a file end to end before editing it")
    expect(playbook).toContain("Run the project's tests, lint, and typecheck after editing")
    expect(playbook).toContain("Never report a task complete on the strength of an edit that was never")
    // Symbol navigation must be advertised, or agents grep instead of following
    // real definitions and call sites.
    expect(playbook).toContain("goToDefinition")
    expect(playbook).toContain("findReferences")
  })

  test("the chat-mode playbook is a system-prompt section, not a base prompt", () => {
    // It must not leak into a base provider prompt: that would change every
    // session, including non-code ones.
    for (const id of ["anthropic/claude-sonnet-4-5", "openai/gpt-5"]) {
      expect(SystemPrompt.provider({ api: { id } } as Provider.Model)[0]).not.toContain("# Code mode")
    }
  })

  test("selects the Kimi prompt for official provider model IDs", () => {
    for (const providerID of ["kimi-for-coding", "moonshotai", "moonshotai-cn"]) {
      const prompt = SystemPrompt.provider({ providerID, api: { id: "k3" } } as Provider.Model)[0]
      expect(prompt).toContain("# Prompt and Tool Use")
    }
  })

  test("the generated-UI prompt lets a model draw its own graphics, not only use the library's", () => {
    const prompt = SystemPrompt.renderUI().join("\n")

    // Both halves ship together. Losing the second is silent: the model simply
    // never learns it may draw, and every answer falls back to the built-in
    // charts even when the visual is the answer.
    expect(prompt).toContain(OPENUI_SYSTEM_PROMPT)
    expect(prompt).toContain(OPENUI_EXTENSION_PROMPT)

    // The fence is the contract with the client: it splits the answer on it and
    // draws the program instead of printing it.
    expect(prompt).toContain("```openui-lang")

    // A model can only choose the hand-drawn path if the section names the
    // components, says what the frame is allowed to do, and keeps the built-in
    // charts the default when they fit.
    expect(OPENUI_EXTENSION_PROMPT).toContain("### Generated graphics")
    expect(OPENUI_EXTENSION_PROMPT).toContain(OPENUI_EXTENSION_SIGNATURES.Html)
    expect(OPENUI_EXTENSION_PROMPT).toContain(OPENUI_EXTENSION_SIGNATURES.Svg)
    expect(OPENUI_EXTENSION_PROMPT).toContain("sandboxed frame with scripts enabled")
    // The last resort is a card that runs JavaScript, for the graphics no
    // vocabulary can express — and the prompt has to name the runtime it gets.
    expect(OPENUI_EXTENSION_PROMPT).toContain(OPENUI_EXTENSION_SIGNATURES.JsCard)
    expect(OPENUI_EXTENSION_PROMPT).toContain("Rules for JsCard:")
    expect(OPENUI_EXTENSION_PROMPT).toContain("setHeight(pixels)")
    expect(OPENUI_EXTENSION_PROMPT).toContain("Prefer the built-in charts above when they fit.")
  })

  test("the generated-UI prompt routes the drawing through the tool instead of a fence", () => {
    const prompt = SystemPrompt.renderUI().join("\n")

    // The fence streams the program through the transcript as markup before the
    // client draws it. The tool carries the same program in its arguments, so the
    // reply stays prose — which only happens if the model is told to prefer it.
    expect(prompt).toContain("`visualize`")
    expect(prompt).toContain("Do not put a fenced openui-lang block in your reply")
    // The fence is still the fallback, not an error: a run without the tool, or a
    // client that has not been taught the row, has to keep working.
    expect(prompt).toContain("Fall back to a fenced block only when the tool is unavailable")
  })

  test("the generated-UI prompt keeps prose the default, so a normal answer is not a card", () => {
    const prompt = SystemPrompt.renderUI().join("\n")

    // A catalogue of components reads as an instruction to use them: without
    // this restraint the model answers "what can you do" with a Card, and then
    // answers "stop using openui" with another Card.
    expect(prompt).toContain("Answer in plain markdown by default.")
    expect(prompt).toContain("Most replies need no drawing at all")
    expect(prompt).toContain("a list of what you can do")
    // The two cases the restraint exists for, stated as prohibitions.
    expect(prompt).toContain("Never wrap a prose answer in a component to make it look designed")
    expect(prompt).toContain("never answer a question about yourself, your capabilities, or the format of your replies with a component")
    expect(prompt).toContain("never make a drawing your entire reply")
    expect(prompt).toContain("At most one drawing per reply.")
  })

  it.effect("skills output is sorted by name and stable across calls", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const first = yield* prompt.skills(build)
      const second = yield* prompt.skills(build)
      const output = first ?? (yield* Effect.fail(new NamedError.Unknown({ message: "missing skills output" })))

      expect(first).toBe(second)

      const alpha = output.indexOf("<name>alpha-skill</name>")
      const middle = output.indexOf("<name>middle-skill</name>")
      const zeta = output.indexOf("<name>zeta-skill</name>")

      expect(alpha).toBeGreaterThan(-1)
      expect(middle).toBeGreaterThan(alpha)
      expect(zeta).toBeGreaterThan(middle)
      expect(output).not.toContain("manual-skill")
    }),
  )

  it.effect("MCP output includes connected server instructions", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const output = yield* prompt.mcp(build)

      expect(output).toBe(
        [
          "<mcp_instructions>",
          '  <server name="guide-server">',
          "    Use lookup before mutate.",
          "  </server>",
          '  <server name="tool-server">',
          "    Prefer search before update.",
          "  </server>",
          "</mcp_instructions>",
        ].join("\n"),
      )
    }),
  )

  it.effect("MCP output omits servers when all advertised tools are denied", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const output = yield* prompt.mcp(build, Permission.fromConfig({ "tool-server_*": "deny" }))

      expect(output).toBe(
        [
          "<mcp_instructions>",
          '  <server name="guide-server">',
          "    Use lookup before mutate.",
          "  </server>",
          "</mcp_instructions>",
        ].join("\n"),
      )
    }),
  )
})
