import { describe, expect, test } from "bun:test"
import type { Prompt } from "@/context/prompt"
import { prependQuote, replyQuote } from "./reply-quote"

describe("replyQuote", () => {
  test("quotes every line of the answered message", () => {
    expect(replyQuote("First line\n\nThird line")).toBe(
      ["> Replying to this message:", "> First line", ">", "> Third line", "", ""].join("\n"),
    )
  })

  test("ignores a message with no text", () => {
    expect(replyQuote("  \n ")).toBe("")
  })

  test("cuts a long message and says so", () => {
    const quote = replyQuote("x".repeat(40), 20)
    expect(quote).toContain(`> ${"x".repeat(20)}…`)
  })
})

describe("prependQuote", () => {
  test("starts the draft with the quote and places the cursor below it", () => {
    const draft: Prompt = [{ type: "text", content: "", start: 0, end: 0 }]
    const quote = replyQuote("the answer")
    const result = prependQuote(draft, quote)
    expect(result.prompt).toHaveLength(1)
    expect(result.prompt[0]).toMatchObject({ type: "text", content: quote, start: 0 })
    expect(result.cursor).toBe(quote.length)
  })

  test("keeps what the user already typed below the quote", () => {
    const draft: Prompt = [{ type: "text", content: "what about this?", start: 0, end: 16 }]
    const quote = replyQuote("the answer")
    const result = prependQuote(draft, quote)
    expect(result.prompt[0]).toMatchObject({ type: "text", content: quote + "what about this?" })
    expect(result.cursor).toBe(quote.length)
  })

  test("puts the cursor after the quote when a mention opens the draft", () => {
    const draft: Prompt = [
      { type: "file", content: "@src/index.ts", start: 0, end: 13, path: "src/index.ts" },
      { type: "text", content: "why?", start: 13, end: 17 },
    ]
    const quote = replyQuote("the answer")
    const result = prependQuote(draft, quote)
    expect(result.prompt[1]).toMatchObject({ type: "text", content: quote + "why?" })
    expect(result.cursor).toBe(13 + quote.length)
  })

  test("re-offsets the rest of the draft and keeps attachments", () => {
    const draft: Prompt = [
      { type: "file", content: "@src/index.ts", start: 0, end: 13, path: "src/index.ts" },
      { type: "image", id: "image-1", filename: "shot.png", mime: "image/png", blob: { id: "b", url: "blob:b" } },
    ]
    const quote = replyQuote("the answer")
    const result = prependQuote(draft, quote)
    expect(result.prompt[0]).toMatchObject({
      type: "text",
      content: quote,
      start: 0,
      end: quote.length,
    })
    expect(result.prompt[1]).toMatchObject({
      type: "file",
      start: quote.length,
      end: quote.length + 13,
    })
    expect(result.prompt[2]).toMatchObject({ type: "image", id: "image-1" })
  })
})
