import { describe, expect, test } from "bun:test"
import type { Message } from "@opencode-ai/sdk/v2/client"
import { getLiveSessionContext, getSessionContext } from "./session-context-metrics"

const assistant = (
  id: string,
  tokens: { input: number; output: number; reasoning: number; read: number; write: number },
  cost: number,
  providerID = "openai",
  modelID = "gpt-4.1",
) => {
  return {
    id,
    role: "assistant",
    providerID,
    modelID,
    cost,
    tokens: {
      input: tokens.input,
      output: tokens.output,
      reasoning: tokens.reasoning,
      cache: {
        read: tokens.read,
        write: tokens.write,
      },
    },
    time: { created: 1 },
  } as unknown as Message
}

const user = (id: string) => {
  return {
    id,
    role: "user",
    cost: 0,
    time: { created: 1 },
  } as unknown as Message
}

describe("getSessionContext", () => {
  test("computes context totals and usage from latest assistant with tokens", () => {
    const messages = [
      user("u1"),
      assistant("a1", { input: 600, output: 200, reasoning: 100, read: 50, write: 50 }, 0.5),
      assistant("a2", { input: 300, output: 100, reasoning: 50, read: 25, write: 25 }, 1.25),
    ]
    const providers = [
      {
        id: "openai",
        name: "OpenAI",
        models: {
          "gpt-4.1": {
            name: "GPT-4.1",
            limit: { context: 1000 },
          },
        },
      },
    ]

    const ctx = getSessionContext(messages, providers)

    expect(ctx?.message.id).toBe("a2")
    // 300 uncached input + 25 read + 25 written + 100 output.
    expect(ctx?.total).toBe(450)
    // The prompt includes the cached tokens, which `tokens.input` excludes.
    expect(ctx?.input).toBe(350)
    expect(ctx?.cached).toBe(50)
    expect(ctx?.output).toBe(100)
    expect(ctx?.reasoning).toBe(50)
    expect(ctx?.usage).toBe(45)
    expect(ctx?.providerLabel).toBe("OpenAI")
    expect(ctx?.modelLabel).toBe("GPT-4.1")
  })

  test("counts cached prompt tokens toward the window instead of only the uncached delta", () => {
    // A cached 190k-token conversation reports a tiny `input`; reading it alone
    // told the user they were at 1% while the model was nearly full.
    const messages = [assistant("a1", { input: 10_000, output: 500, reasoning: 0, read: 170_000, write: 10_000 }, 0)]
    const providers = [{ id: "openai", models: { "gpt-4.1": { limit: { context: 200_000 } } } }]

    const ctx = getSessionContext(messages, providers)

    expect(ctx?.total).toBe(190_500)
    expect(ctx?.usage).toBe(95)
  })

  test("never reports more than a full window", () => {
    const messages = [assistant("a1", { input: 990, output: 30, reasoning: 0, read: 0, write: 0 }, 0)]
    const providers = [{ id: "openai", models: { "gpt-4.1": { limit: { context: 1000 } } } }]

    const ctx = getSessionContext(messages, providers)

    expect(ctx?.total).toBe(1020)
    expect(ctx?.usage).toBe(100)
  })

  test("preserves fallback labels and null usage when model metadata is missing", () => {
    const messages = [assistant("a1", { input: 40, output: 10, reasoning: 0, read: 0, write: 0 }, 0.1, "p-1", "m-1")]
    const providers = [{ id: "p-1", models: {} }]

    const ctx = getSessionContext(messages, providers)

    expect(ctx?.providerLabel).toBe("p-1")
    expect(ctx?.modelLabel).toBe("m-1")
    expect(ctx?.limit).toBeUndefined()
    expect(ctx?.usage).toBeNull()
  })

  test("recomputes when message array is mutated in place", () => {
    const messages = [assistant("a1", { input: 10, output: 10, reasoning: 10, read: 10, write: 10 }, 0.25)]
    const providers = [{ id: "openai", models: {} }]

    const one = getSessionContext(messages, providers)
    messages.push(assistant("a2", { input: 100, output: 20, reasoning: 0, read: 0, write: 0 }, 0.75))
    const two = getSessionContext(messages, providers)

    expect(one?.message.id).toBe("a1")
    expect(two?.message.id).toBe("a2")
  })

  test("returns undefined when inputs are undefined", () => {
    const ctx = getSessionContext(undefined, undefined)

    expect(ctx).toBeUndefined()
  })
})

describe("getLiveSessionContext", () => {
  const providers = [{ id: "openai", models: { "gpt-4.1": { limit: { context: 1_000 } } } }]

  test("stays on reported usage when the session is idle", () => {
    const messages = [user("u1"), assistant("a1", { input: 100, output: 0, reasoning: 0, read: 0, write: 0 }, 0)]
    const parts = { u1: [{ type: "text", text: "x".repeat(400) }] }

    expect(getLiveSessionContext(messages, parts, providers, false)?.total).toBe(100)
  })

  test("adds a cheap character estimate for text after the token-bearing turn", () => {
    const messages = [user("u1"), assistant("a1", { input: 100, output: 10, reasoning: 0, read: 0, write: 0 }, 0), user("u2")]
    const parts = {
      // a1's text is already inside its reported output, so only the new user
      // message should move the meter.
      a1: [{ type: "text", text: "y".repeat(40) }],
      u2: [{ type: "text", text: "x".repeat(40) }],
    }

    expect(getLiveSessionContext(messages, parts, providers, true)?.total).toBe(120)
  })

  test("counts a streaming assistant response after the last usage report", () => {
    const messages = [
      user("u1"),
      assistant("a1", { input: 100, output: 0, reasoning: 0, read: 0, write: 0 }, 0),
      assistant("a2", { input: 0, output: 0, reasoning: 0, read: 0, write: 0 }, 0),
    ]
    const parts = { a2: [{ type: "text", text: "z".repeat(80) }] }

    expect(getLiveSessionContext(messages, parts, providers, true)?.total).toBe(120)
  })

  test("keeps moving while the token-bearing assistant message is still streaming", () => {
    const messages = [assistant("a1", { input: 100, output: 0, reasoning: 0, read: 0, write: 0 }, 0)]
    const parts = { a1: [{ type: "text", text: "x".repeat(800) }] }

    const ctx = getLiveSessionContext(messages, parts, providers, true)

    // 800 text characters are about 200 tokens beyond the report's output.
    expect(ctx?.total).toBe(300)
    expect(ctx?.usage).toBe(30)
  })

  test("counts tool output that has entered a later message", () => {
    const messages = [
      assistant("a1", { input: 100, output: 0, reasoning: 0, read: 0, write: 0 }, 0),
      assistant("a2", { input: 0, output: 0, reasoning: 0, read: 0, write: 0 }, 0),
    ]
    const parts = { a2: [{ type: "tool", state: { output: "y".repeat(800) } }] }

    expect(getLiveSessionContext(messages, parts, providers, true)?.total).toBe(300)
  })

  test("does not count text already included in the reported output", () => {
    const messages = [assistant("a1", { input: 100, output: 10, reasoning: 0, read: 0, write: 0 }, 0)]
    const parts = { a1: [{ type: "text", text: "x".repeat(40) }] }

    expect(getLiveSessionContext(messages, parts, providers, true)?.total).toBe(110)
  })

  test("adds streaming overflow and later messages once", () => {
    const messages = [
      assistant("a1", { input: 100, output: 50, reasoning: 0, read: 0, write: 0 }, 0),
      user("u2"),
    ]
    const parts = {
      a1: [{ type: "text", text: "y".repeat(800) }],
      u2: [{ type: "text", text: "x".repeat(400) }],
    }

    // Reported 100 + 50 output; a1: 200 estimated - 50 output = 150; u2: 100.
    expect(getLiveSessionContext(messages, parts, providers, true)?.total).toBe(400)
  })

  test("estimates the first prompt before any assistant reports usage", () => {
    const messages = [user("u1")]
    const parts = { u1: [{ type: "text", text: "x".repeat(800) }] }

    expect(getLiveSessionContext(messages, parts, providers, true)).toEqual({ total: 200, usage: null })
  })

  test("hides the estimate while idle or when the prompt has no text", () => {
    const messages = [user("u1")]
    const parts = { u1: [{ type: "text", text: "x".repeat(800) }] }

    expect(getLiveSessionContext(messages, parts, providers, false)).toBeUndefined()
    expect(getLiveSessionContext(messages, {}, providers, true)).toBeUndefined()
  })
})
