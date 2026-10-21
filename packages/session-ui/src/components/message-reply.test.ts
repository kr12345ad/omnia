import { describe, expect, test } from "bun:test"
import { replyQuote, splitReplyQuote } from "./message-reply"

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

describe("splitReplyQuote", () => {
  test("separates the quoted answer from the reply text", () => {
    expect(splitReplyQuote(replyQuote("First line\n\nThird line") + "does this still apply?")).toEqual({
      quote: "First line\n\nThird line",
      body: "does this still apply?",
    })
  })

  test("keeps a reply that sends only the quote", () => {
    expect(splitReplyQuote(replyQuote("Only the answer"))).toEqual({ quote: "Only the answer", body: "" })
  })

  test("ignores a prompt that is not a reply", () => {
    expect(splitReplyQuote("> a plain quote\n\nnot a reply")).toBeUndefined()
  })

  test("normalizes windows line endings", () => {
    expect(splitReplyQuote("> Replying to this message:\r\n> quoted\r\n\r\nanswer")).toEqual({
      quote: "quoted",
      body: "answer",
    })
  })
})
