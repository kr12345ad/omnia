import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ModelSummary, OpenCodeRunnerConfig, SessionSummary } from "../agent-run/client"
import type { HeadlessRunInput, HeadlessRunResult } from "../agent-run/runner"
import { CHAT_PLATFORMS } from "./platforms"
import { chatPrompt, conversationKey, createChatAgentRunner, renderTrace } from "./runner"
import type { ChatMessage } from "./service"
import { ChatSessionStore } from "./sessions"

const config: OpenCodeRunnerConfig = { url: "http://127.0.0.1:1", username: "opencode", password: "secret" }

function message(text: string, channelId = "C1"): ChatMessage {
  return { platform: "discord", channelId, userId: "U1", userName: "krishnaa", text, receivedAt: 0 }
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "omnia-chat-sessions-"))
  const sessions = new ChatSessionStore({ file: join(dir, "sessions.json") })
  return { sessions, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function harness(
  handler: (input: HeadlessRunInput) => HeadlessRunResult | Promise<HeadlessRunResult>,
  listed: SessionSummary[] = [],
  catalog: ModelSummary[] = [],
  model?: () => { providerID: string; modelID: string } | undefined,
) {
  const { sessions, cleanup } = setup()
  const inputs: HeadlessRunInput[] = []
  const runner = createChatAgentRunner({
    sessions,
    resolve: () => config,
    run: async (_config, input) => {
      inputs.push(input)
      return handler(input)
    },
    list: async () => listed,
    models: async () => catalog,
    ...(model === undefined ? {} : { model }),
  })
  return { sessions, inputs, runner, cleanup }
}

const CATALOG: ModelSummary[] = [
  { providerID: "opencode-go", modelID: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
  { providerID: "anthropic", modelID: "claude-sonnet-4", name: "Claude Sonnet 4" },
]

const answer = (sessionId: string, text = "ok"): HeadlessRunResult => ({ ok: true, sessionId, text, elapsedMs: 1 })

describe("the chat prompt", () => {
  test("names the platform, the sender and the raw message", () => {
    const prompt = chatPrompt(message("what broke the deploy?"))
    expect(prompt).toContain("discord")
    expect(prompt).toContain("krishnaa")
    expect(prompt).toContain("C1")
    expect(prompt.endsWith("what broke the deploy?")).toBe(true)
  })

  test("quotes the message a reply answers so the question has a subject", () => {
    const prompt = chatPrompt({
      ...message("what about the tests?"),
      replyTo: { author: "omnia", text: "The deploy broke on the migration step." },
    })
    expect(prompt).toContain("It is a reply to an earlier message from omnia")
    expect(prompt).toContain("> The deploy broke on the migration step.")
    expect(prompt.endsWith("what about the tests?")).toBe(true)
  })

  test("a conversation is one per channel", () => {
    expect(conversationKey(message("hi", "C1"))).toBe("discord:C1")
    expect(conversationKey(message("hi", "C2"))).not.toBe(conversationKey(message("hi", "C1")))
  })
})

describe("the live trace", () => {
  test("renders reasoning and tool steps as subtext and leaves the answer out", () => {
    const trace = renderTrace([
      {
        info: { role: "assistant" },
        parts: [
          { type: "reasoning", text: "Let me look at the config\nand then decide" },
          { type: "tool", tool: "bash", state: { status: "completed", title: "ls -la" } },
          { type: "text", text: "the answer itself" },
        ],
      },
    ])
    expect(trace).toContain("-# 🧠 Let me look at the config")
    expect(trace).toContain("-# ✓ bash · ls -la")
    expect(trace).not.toContain("the answer itself")
    expect(trace.split("\n").every((line) => line.startsWith("-# "))).toBe(true)
  })

  test("says it is thinking before there is anything to show", () => {
    expect(renderTrace([])).toBe("-# thinking…")
  })

  test("shows the elapsed time so a long run never reads as stuck", () => {
    expect(renderTrace([], 65_000)).toBe("-# thinking… · 1:05")
    const withStep = renderTrace(
      [{ info: { role: "assistant" }, parts: [{ type: "tool", tool: "bash", state: { status: "completed", title: "ls" } }] }],
      9_000,
    )
    expect(withStep).toBe("-# ✓ bash · ls · 0:09")
  })

  test("shows a failed tool and keeps only the last steps", () => {
    const parts = Array.from({ length: 12 }, (_, index) => ({
      type: "tool",
      tool: "bash",
      state: { status: "error", title: `cmd ${index}` },
    }))
    const trace = renderTrace([{ info: { role: "assistant" }, parts }])
    expect(trace).toContain("✗ bash")
    expect(trace.split("\n")).toHaveLength(8)
  })

  test("a tool without a title falls back to its command", () => {
    const trace = renderTrace([
      { info: { role: "assistant" }, parts: [{ type: "tool", tool: "bash", state: { status: "running", input: { command: "git status" } } }] },
    ])
    expect(trace).toContain("… bash · git status")
  })
})

describe("chat session continuity", () => {
  test("the first message opens a session and later messages continue it", async () => {
    const { runner, inputs, sessions, cleanup } = harness(() => answer("ses_1"))
    try {
      expect(await runner(message("first"))).toBe("ok")
      expect(await runner(message("second"))).toBe("ok")
      expect(inputs[0]?.sessionId).toBeUndefined()
      expect(inputs[0]?.title).toContain("discord")
      expect(inputs[1]?.sessionId).toBe("ses_1")
      expect(sessions.get("discord:C1")).toBe("ses_1")
    } finally {
      cleanup()
    }
  })

  test("each channel gets its own session", async () => {
    let created = 0
    const { runner, inputs, sessions, cleanup } = harness((input) => {
      created += input.sessionId === undefined ? 1 : 0
      return answer(input.sessionId ?? `ses_${created}`)
    })
    try {
      await runner(message("hello", "C1"))
      await runner(message("hello", "C2"))
      await runner(message("again", "C1"))
      expect(sessions.get("discord:C1")).toBe("ses_1")
      expect(sessions.get("discord:C2")).toBe("ses_2")
      expect(inputs[2]?.sessionId).toBe("ses_1")
    } finally {
      cleanup()
    }
  })

  test("a stale session is replaced instead of leaving the channel dead", async () => {
    const { runner, sessions, cleanup } = harness((input) => {
      if (input.sessionId !== undefined) throw new Error("The paired opencode server answered HTTP 404 for /session/x/prompt_async.")
      return answer("ses_new", "recovered")
    })
    try {
      sessions.bind("discord:C1", "ses_gone")
      expect(await runner(message("still there?"))).toBe("recovered")
      expect(sessions.get("discord:C1")).toBe("ses_new")
    } finally {
      cleanup()
    }
  })
})

describe("conversation commands", () => {
  test("/session reports the bound session without spending a turn", async () => {
    const { runner, inputs, sessions, cleanup } = harness(() => answer("ses_1"))
    try {
      sessions.bind("discord:C1", "ses_1")
      const reply = await runner(message("/session"))
      expect(reply).toContain("ses_1")
      expect(inputs).toHaveLength(0)
    } finally {
      cleanup()
    }
  })

  test("/new starts over", async () => {
    const { runner, inputs, sessions, cleanup } = harness(() => answer("ses_1"))
    try {
      sessions.bind("discord:C1", "ses_1")
      expect(await runner(message("/new"))).toContain("fresh session")
      expect(sessions.get("discord:C1")).toBeUndefined()
      await runner(message("start again"))
      expect(inputs[0]?.sessionId).toBeUndefined()
    } finally {
      cleanup()
    }
  })

  test("/sessions lists what can be resumed", async () => {
    const { runner, cleanup } = harness(() => answer("ses_1"), [
      { id: "ses_a", title: "Deploy fix" },
      { id: "ses_b", title: "Email triage" },
    ])
    try {
      const reply = await runner(message("/sessions"))
      expect(reply).toContain("ses_a")
      expect(reply).toContain("Deploy fix")
      expect(reply).toContain("/resume")
    } finally {
      cleanup()
    }
  })

  test("/resume binds an existing session and verifies it exists first", async () => {
    const { runner, inputs, sessions, cleanup } = harness(() => answer("ses_a"), [{ id: "ses_a", title: "Deploy fix" }])
    try {
      expect(await runner(message("/resume ses_b"))).toContain("No session ses_b")
      expect(sessions.get("discord:C1")).toBeUndefined()

      expect(await runner(message("/resume ses_a"))).toContain("ses_a")
      await runner(message("continue please"))
      expect(inputs[0]?.sessionId).toBe("ses_a")
    } finally {
      cleanup()
    }
  })

  test("a plain message that only looks like a path is not a command", async () => {
    const { runner, inputs, cleanup } = harness(() => answer("ses_1"))
    try {
      await runner(message("/etc/passwd is broken"))
      expect(inputs).toHaveLength(1)
    } finally {
      cleanup()
    }
  })
})

const noEnvModel = () => undefined

describe("switching models from chat", () => {
  test("/models lists the catalog and marks the current choice without spending a turn", async () => {
    const { runner, inputs, sessions, cleanup } = harness(() => answer("ses_1"), [], CATALOG)
    try {
      sessions.setModel("discord:C1", { providerID: "anthropic", modelID: "claude-sonnet-4" })
      const reply = await runner(message("/models"))
      expect(reply).toContain("1. opencode-go/deepseek-v4.1-flash — DeepSeek V4.1 Flash")
      // The current model's id is bold, so the marker is readable at a glance.
      expect(reply).toContain("2. **anthropic/claude-sonnet-4** — Claude Sonnet 4 ← current")
      expect(inputs).toHaveLength(0)
    } finally {
      cleanup()
    }
  })

  test("/models 2 switches this channel and the next turn uses it", async () => {
    const { runner, inputs, sessions, cleanup } = harness(() => answer("ses_1"), [], CATALOG)
    try {
      expect(await runner(message("/models 2"))).toContain("anthropic/claude-sonnet-4")
      expect(sessions.getModel("discord:C1")).toEqual({ providerID: "anthropic", modelID: "claude-sonnet-4" })
      await runner(message("go"))
      expect(inputs[0]?.model).toEqual({ providerID: "anthropic", modelID: "claude-sonnet-4" })
    } finally {
      cleanup()
    }
  })

  test("one channel's model does not follow the bot into another channel", async () => {
    const { runner, inputs, cleanup } = harness(() => answer("ses_1"), [], CATALOG, noEnvModel)
    try {
      await runner(message("/models anthropic/claude-sonnet-4", "C1"))
      await runner(message("go", "C2"))
      expect(inputs[0]?.model).toBeUndefined()
    } finally {
      cleanup()
    }
  })

  test("/models default goes back to the server's choice", async () => {
    const { runner, inputs, sessions, cleanup } = harness(() => answer("ses_1"), [], CATALOG, noEnvModel)
    try {
      sessions.setModel("discord:C1", { providerID: "anthropic", modelID: "claude-sonnet-4" })
      expect(await runner(message("/models default"))).toContain("server's default")
      expect(sessions.getModel("discord:C1")).toBeUndefined()
      await runner(message("go"))
      expect(inputs[0]?.model).toBeUndefined()
    } finally {
      cleanup()
    }
  })

  test("an unknown model or index is refused and leaves the choice alone", async () => {
    const { runner, sessions, cleanup } = harness(() => answer("ses_1"), [], CATALOG)
    try {
      sessions.setModel("discord:C1", { providerID: "anthropic", modelID: "claude-sonnet-4" })
      expect(await runner(message("/models nope"))).toContain("No model matches")
      expect(await runner(message("/models 9"))).toContain("There is no model 9")
      expect(sessions.getModel("discord:C1")).toEqual({ providerID: "anthropic", modelID: "claude-sonnet-4" })
    } finally {
      cleanup()
    }
  })

  test("!model list separates the free tier and warns that it is rate limited", async () => {
    const withFree: ModelSummary[] = [
      { providerID: "opencode", modelID: "deepseek-v4.1-flash-free", name: "DeepSeek V4.1 Flash Free", free: true },
      { providerID: "opencode-go", modelID: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
    ]
    const { runner, cleanup } = harness(() => answer("ses_1"), [], withFree)
    try {
      const reply = await runner(message("!model list"))
      // Paid models are numbered first so a paid pick keeps its number.
      expect(reply).toContain("1. opencode-go/deepseek-v4.1-flash — DeepSeek V4.1 Flash")
      expect(reply).toContain("Free models (rate limited):")
      expect(reply).toContain("2. opencode/deepseek-v4.1-flash-free — DeepSeek V4.1 Flash Free · free (rate limited)")
      expect(reply).toContain("throttled")
    } finally {
      cleanup()
    }
  })

  test("picking a free model warns, and it is the model the turn uses", async () => {
    const withFree: ModelSummary[] = [
      { providerID: "opencode", modelID: "deepseek-v4.1-flash-free", name: "DeepSeek V4.1 Flash Free", free: true },
      { providerID: "opencode-go", modelID: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
    ]
    const { runner, inputs, sessions, cleanup } = harness(() => answer("ses_1"), [], withFree, noEnvModel)
    try {
      const reply = await runner(message("!model 2"))
      expect(reply).toContain("rate-limited")
      expect(sessions.getModel("discord:C1")).toEqual({ providerID: "opencode", modelID: "deepseek-v4.1-flash-free" })
      await runner(message("go"))
      expect(inputs[0]?.model).toEqual({ providerID: "opencode", modelID: "deepseek-v4.1-flash-free" })
    } finally {
      cleanup()
    }
  })

  test("!model list shows the catalog without spending a turn", async () => {
    const { runner, inputs, cleanup } = harness(() => answer("ses_1"), [], CATALOG)
    try {
      const reply = await runner(message("!model list"))
      expect(reply).toContain("opencode-go/deepseek-v4.1-flash")
      expect(reply).toContain("anthropic/claude-sonnet-4")
      expect(inputs).toHaveLength(0)
    } finally {
      cleanup()
    }
  })

  test("!model switches by name and by index", async () => {
    const { runner, sessions, cleanup } = harness(() => answer("ses_1"), [], CATALOG)
    try {
      expect(await runner(message("!model anthropic/claude-sonnet-4"))).toContain("anthropic/claude-sonnet-4")
      expect(sessions.getModel("discord:C1")).toEqual({ providerID: "anthropic", modelID: "claude-sonnet-4" })
      expect(await runner(message("!model 1"))).toContain("opencode-go/deepseek-v4.1-flash")
      expect(sessions.getModel("discord:C1")).toEqual({ providerID: "opencode-go", modelID: "deepseek-v4.1-flash" })
    } finally {
      cleanup()
    }
  })

  test("!model search finds models by id or name and tags each one free or paid", async () => {
    const catalog: ModelSummary[] = [
      { providerID: "opencode-go", modelID: "longcat-2.5-preview-free", name: "LongCat 2.5 Preview Free", free: true },
      { providerID: "opencode-go", modelID: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
      { providerID: "opencode", modelID: "big-pickle", name: "Big Pickle", free: true },
    ]
    const { runner, inputs, cleanup } = harness(() => answer("ses_1"), [], catalog)
    try {
      const reply = await runner(message('!model search "longcat"'))
      expect(reply).toContain('1 model matching "longcat"')
      // Paid models are numbered first, so this result is number 2 in the same
      // list !model <number> picks from.
      expect(reply).toContain("2. opencode-go/longcat-2.5-preview-free — LongCat 2.5 Preview Free · free")
      // A search is an answer, not a turn.
      expect(inputs).toHaveLength(0)
    } finally {
      cleanup()
    }
  })

  test("a search bolds the model this channel already answers with and keeps ← current", async () => {
    const catalog: ModelSummary[] = [
      { providerID: "opencode-go", modelID: "beam-free", name: "Beam Free", free: true },
      { providerID: "opencode-go", modelID: "beam-pro", name: "Beam Pro" },
    ]
    const { runner, sessions, cleanup } = harness(() => answer("ses_1"), [], catalog)
    try {
      sessions.setModel("discord:C1", { providerID: "opencode-go", modelID: "beam-free" })
      const reply = await runner(message("!model search beam"))
      expect(reply).toContain("**opencode-go/beam-free** — Beam Free · free ← current")
      // A model that is not selected stays plain.
      expect(reply).toContain("opencode-go/beam-pro — Beam Pro · paid")
      expect(reply).not.toContain("**opencode-go/beam-pro**")
    } finally {
      cleanup()
    }
  })

  test("search filters by --free and --paid, and names the price of every match", async () => {
    const catalog: ModelSummary[] = [
      { providerID: "opencode-go", modelID: "longcat-2.5-preview-free", name: "LongCat 2.5 Preview Free", free: true },
      { providerID: "opencode-go", modelID: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
      { providerID: "opencode", modelID: "big-pickle", name: "Big Pickle", free: true },
    ]
    const { runner, cleanup } = harness(() => answer("ses_1"), [], catalog)
    try {
      const free = await runner(message("!model search --free"))
      expect(free).toContain("2 free models:")
      expect(free).toContain("· free")
      expect(free).not.toContain("deepseek-v4.1-flash — DeepSeek V4.1 Flash")

      const paid = await runner(message("!model search --paid"))
      expect(paid).toContain("1 paid model:")
      expect(paid).toContain("deepseek-v4.1-flash — DeepSeek V4.1 Flash · paid")
      expect(paid).not.toContain("longcat")
    } finally {
      cleanup()
    }
  })

  test("a search result can be picked by its printed number, on any platform", async () => {
    const catalog: ModelSummary[] = [
      { providerID: "opencode-go", modelID: "longcat-2.5-preview-free", name: "LongCat 2.5 Preview Free", free: true },
      { providerID: "opencode-go", modelID: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
    ]
    const { runner, sessions, cleanup } = harness(() => answer("ses_1"), [], catalog)
    try {
      const slack: ChatMessage = { platform: "slack", channelId: "D1", userId: "U1", text: "!model search longcat", receivedAt: 0 }
      expect(await runner(slack)).toContain("2. opencode-go/longcat-2.5-preview-free")
      // The platform does not change how a command is read.
      expect(await runner({ ...slack, platform: "gchat", text: "!model 2" })).toContain("opencode-go/longcat-2.5-preview-free")
      expect(sessions.getModel("gchat:D1")).toEqual({ providerID: "opencode-go", modelID: "longcat-2.5-preview-free" })
    } finally {
      cleanup()
    }
  })

  test("a search that matches nothing, or asks for both prices, explains itself", async () => {
    const { runner, cleanup } = harness(() => answer("ses_1"), [], CATALOG)
    try {
      expect(await runner(message("!model search nosuchmodel"))).toContain("No model matches")
      expect(await runner(message("!model search free --free --paid"))).toContain("Choose one of --free or --paid")
      expect(await runner(message("!model search x --costly"))).toContain("Unknown flag --costly")
    } finally {
      cleanup()
    }
  })

  test("the ! prefix works where Discord's slash picker gets in the way", async () => {
    const { runner, sessions, cleanup } = harness(() => answer("ses_1"), [], CATALOG)
    try {
      expect(await runner(message("!models 2"))).toContain("anthropic/claude-sonnet-4")
      expect(sessions.getModel("discord:C1")).toEqual({ providerID: "anthropic", modelID: "claude-sonnet-4" })
    } finally {
      cleanup()
    }
  })

  test("a bare model id offered by two providers asks for the full name", async () => {
    const shared: ModelSummary[] = [
      { providerID: "alpha", modelID: "shared" },
      { providerID: "beta", modelID: "shared" },
    ]
    const { runner, sessions, cleanup } = harness(() => answer("ses_1"), [], shared)
    try {
      const reply = await runner(message("/models shared"))
      expect(reply).toContain("alpha, beta")
      expect(sessions.getModel("discord:C1")).toBeUndefined()
    } finally {
      cleanup()
    }
  })
})

describe("the chat agent runner", () => {
  test("a timed out run says why instead of echoing an error object", async () => {
    const { runner, cleanup } = harness(() => ({
      ok: false,
      sessionId: "S1",
      error: "budget",
      timedOut: true,
      elapsedMs: 5,
    }))
    try {
      expect(await runner(message("go"))).toBe("That took longer than Omnia's chat budget, so the run was stopped.")
    } finally {
      cleanup()
    }
  })

  test("a provider refusal is repeated back rather than hidden", async () => {
    const { runner, cleanup } = harness(() => ({
      ok: false,
      sessionId: "S1",
      error: "OpenCode's free tier can only be used from within OpenCode.",
      timedOut: false,
      elapsedMs: 5,
    }))
    try {
      const reply = await runner(message("go"))
      expect(reply).toContain("could not answer")
      expect(reply).toContain("free tier")
    } finally {
      cleanup()
    }
  })

  test("the configured chat model is sent with the prompt", async () => {
    const previous = process.env.OMNIA_CHAT_MODEL
    process.env.OMNIA_CHAT_MODEL = "opencode-go/deepseek-v4.1-flash"
    const { runner, inputs, cleanup } = harness(() => answer("ses_1"))
    try {
      await runner(message("go"))
      expect(inputs[0]?.model).toEqual({ providerID: "opencode-go", modelID: "deepseek-v4.1-flash" })
    } finally {
      if (previous === undefined) delete process.env.OMNIA_CHAT_MODEL
      else process.env.OMNIA_CHAT_MODEL = previous
      cleanup()
    }
  })

  test("a control plane with no executor says so plainly", async () => {
    const { sessions, cleanup } = setup()
    try {
      const runner = createChatAgentRunner({
        sessions,
        resolve: () => undefined,
        run: async () => {
          throw new Error("must not run")
        },
      })
      expect(await runner(message("go"))).toContain("no headless executor configured")
    } finally {
      cleanup()
    }
  })
})

describe("interrupting a running turn", () => {
  /** A turn that stays busy until it is aborted, like a real model run. */
  const busy = (sessions: ChatSessionStore) => {
    const signals: AbortSignal[] = []
    const runner = createChatAgentRunner({
      sessions,
      resolve: () => config,
      run: async (_config, input) => {
        const signal = input.signal
        if (signal === undefined) throw new Error("a chat turn must be interruptible")
        signals.push(signal)
        await new Promise<void>((resolve) => {
          if (signal.aborted) return resolve()
          signal.addEventListener("abort", () => resolve(), { once: true })
        })
        return {
          ok: false,
          sessionId: "ses_stop",
          error: "The run was interrupted.",
          timedOut: false,
          interrupted: true,
          elapsedMs: 1,
        }
      },
    })
    return { runner, signals }
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 5))

  test("/stop aborts this channel's turn and resumes the same session afterwards", async () => {
    const { sessions, cleanup } = setup()
    const { runner, signals } = busy(sessions)
    try {
      const running = runner(message("do the long work"))
      await settle()
      expect(await runner(message("/stop"))).toBe("Stopping the turn running in this channel.")
      expect(await running).toBe("Stopped.")
      expect(signals[0]?.aborted).toBe(true)
      // The session survived the interruption, so the next message continues it.
      expect(sessions.get("discord:C1")).toBe("ses_stop")
    } finally {
      cleanup()
    }
  })

  test("every platform interrupts with the same command", async () => {
    const { sessions, cleanup } = setup()
    const { runner } = busy(sessions)
    try {
      for (const platform of CHAT_PLATFORMS) {
        const channelId = `${platform.id}-1`
        const running = runner({ platform: platform.id, channelId, userId: "U1", text: "long job", receivedAt: 0 })
        await settle()
        const stopped = await runner({ platform: platform.id, channelId, userId: "U1", text: "!stop", receivedAt: 0 })
        expect(stopped).toContain("Stopping")
        expect(await running).toBe("Stopped.")
      }
    } finally {
      cleanup()
    }
  })

  test("stopping one channel leaves another channel's turn running", async () => {
    const { sessions, cleanup } = setup()
    const { runner } = busy(sessions)
    try {
      const first = runner(message("job one", "C1"))
      const second = runner(message("job two", "C2"))
      await settle()
      expect(await runner(message("/stop", "C1"))).toContain("Stopping")
      expect(await first).toBe("Stopped.")
      let settled = false
      void second.then(() => {
        settled = true
      })
      await settle()
      expect(settled).toBe(false)
      await runner(message("/stop", "C2"))
      expect(await second).toBe("Stopped.")
    } finally {
      cleanup()
    }
  })

  test("stopping with nothing running says so instead of failing", async () => {
    const { runner, inputs, cleanup } = harness(() => answer("ses_1"))
    try {
      expect(await runner(message("!stop"))).toBe("Nothing is running in this channel right now.")
      expect(inputs).toHaveLength(0)
    } finally {
      cleanup()
    }
  })
})

describe("files attached in chat", () => {
  const attachment = (name: string, mime: string, url: string | undefined) => ({
    name,
    mime,
    load: async () => url,
  })

  test("an image reaches the model as a file part and is named in the prompt", async () => {
    const { runner, inputs, cleanup } = harness(() => answer("ses_1"))
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=="
    try {
      const reply = await runner({
        ...message("what is this?"),
        attachments: [attachment("shot.png", "image/png", png)],
      })
      expect(reply).toBe("ok")
      expect(inputs[0]?.files).toEqual([{ mime: "image/png", filename: "shot.png", url: png }])
      expect(inputs[0]?.prompt).toContain("shot.png")
    } finally {
      cleanup()
    }
  })

  test("a screenshot with no words is still a prompt", async () => {
    const { runner, inputs, cleanup } = harness(() => answer("ses_1"))
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=="
    try {
      await runner({ ...message(""), attachments: [attachment("shot.png", "image/png", png)] })
      expect(inputs[0]?.prompt).toContain("no text of its own")
      expect(inputs[0]?.files).toHaveLength(1)
    } finally {
      cleanup()
    }
  })

  test("text is inlined, and an unreadable or unsupported file is named instead of failing the turn", async () => {
    const { runner, inputs, cleanup } = harness(() => answer("ses_1"))
    const notes = "data:text/markdown;base64,IyBOb3Rlcw=="
    try {
      const reply = await runner({
        ...message("read these"),
        attachments: [
          attachment("notes.md", "text/markdown", notes),
          attachment("archive.zip", "application/zip", "data:application/zip;base64,AA=="),
          attachment("broken.png", "image/png", undefined),
        ],
      })
      expect(reply).toBe("ok")
      // opencode inlines text/plain; a markdown subtype would arrive as a file.
      expect(inputs[0]?.files).toEqual([{ mime: "text/plain", filename: "notes.md", url: notes }])
      expect(inputs[0]?.prompt).toContain("archive.zip")
      expect(inputs[0]?.prompt).toContain("broken.png")
    } finally {
      cleanup()
    }
  })
})
