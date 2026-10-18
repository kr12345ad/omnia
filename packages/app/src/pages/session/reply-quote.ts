import type { Prompt } from "@/context/prompt"

// A quoted message is context for the question, not the question: past this the
// answer would be about the quote rather than about what the user asks.
const QUOTE_LIMIT = 2_000

/**
 * The draft a reply starts from: the answered message quoted above whatever the
 * user already typed, so the next question is asked about that message instead
 * of about the session as a whole.
 */
export function replyQuote(text: string, limit = QUOTE_LIMIT): string {
  const trimmed = text.trim()
  if (trimmed.length === 0) return ""
  const excerpt = trimmed.length > limit ? `${trimmed.slice(0, limit).trimEnd()}…` : trimmed
  const lines = excerpt.split(/\r?\n/).map((line) => (line.length === 0 ? ">" : `> ${line}`))
  return ["> Replying to this message:", ...lines, "", ""].join("\n")
}

/** Puts the quote at the top of the draft and leaves the cursor below it. */
export function prependQuote(prompt: Prompt, quote: string): { prompt: Prompt; cursor: number } {
  const first = prompt.findIndex((part) => part.type === "text")
  const parts: Prompt =
    first < 0
      ? [{ type: "text", content: quote, start: 0, end: 0 }, ...prompt]
      : prompt.map((part, index) =>
          part.type === "text" && index === first ? { ...part, content: quote + part.content } : part,
        )
  // A draft may open with a mention, so the quote is not always at offset 0.
  const prefix = parts
    .slice(0, first < 0 ? 1 : first)
    .reduce((length, part) => length + ("content" in part ? part.content.length : 0), 0)
  // Offsets are relative to the whole draft, so every part after the quote
  // moves by its length; a mention that is not re-offset stops rendering.
  let offset = 0
  const next = parts.map((part) => {
    if (part.type === "image") return part
    const value = { ...part, start: offset, end: offset + part.content.length }
    offset = value.end
    return value
  })
  return { prompt: next, cursor: prefix + quote.length }
}
