import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createPromptState, DEFAULT_PROMPT } from "./prompt-state"

describe("prompt state initialization", () => {
  test("initializes prompt text, cursor, and model together", () => {
    createRoot((dispose) => {
      const model = { providerID: "anthropic", modelID: "claude", variant: "high" }
      const prompt = createPromptState({ prompt: "hello", model })

      expect(prompt.current()).toEqual([{ type: "text", content: "hello", start: 0, end: 5 }])
      expect(prompt.cursor()).toBe(5)
      expect(prompt.model.current()).toEqual(model)
      expect(prompt.model.current()).not.toBe(model)
      dispose()
    })
  })

  test("uses the default prompt without initial values", () => {
    createRoot((dispose) => {
      const prompt = createPromptState()

      expect(prompt.current()).toEqual(DEFAULT_PROMPT)
      expect(prompt.cursor()).toBeUndefined()
      expect(prompt.model.current()).toBeUndefined()
      dispose()
    })
  })
})

describe("prompt reply", () => {
  test("rides with the draft and is dropped when the draft is reset", () => {
    createRoot((dispose) => {
      const prompt = createPromptState()
      prompt.reply.set({ messageID: "message-1", text: "the answer" })
      expect(prompt.reply.current()).toEqual({ messageID: "message-1", text: "the answer" })

      prompt.reset()
      expect(prompt.reply.current()).toBeUndefined()
      dispose()
    })
  })

  test("is per draft, so a new prompt starts without one", () => {
    createRoot((dispose) => {
      const first = createPromptState()
      first.reply.set({ messageID: "message-1", text: "the answer" })
      const second = createPromptState()
      expect(second.reply.current()).toBeUndefined()
      dispose()
    })
  })
})
