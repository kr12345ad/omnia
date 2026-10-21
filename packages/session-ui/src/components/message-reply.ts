// A quoted message is context for the question, not the question: past this the
// answer would be about the quote rather than about what the user asks.
const QUOTE_LIMIT = 2_000
const MARKER = "Replying to this message:"

/**
 * The context a reply attaches to the message it sends. The draft itself stays
 * clean -- the composer shows the reply card instead -- so this is built when
 * the prompt is submitted rather than written into the input.
 */
export function replyQuote(text: string, limit = QUOTE_LIMIT): string {
  const trimmed = text.trim()
  if (trimmed.length === 0) return ""
  const excerpt = trimmed.length > limit ? `${trimmed.slice(0, limit).trimEnd()}…` : trimmed
  const lines = excerpt.split(/\r?\n/).map((line) => (line.length === 0 ? ">" : `> ${line}`))
  return [`> ${MARKER}`, ...lines, "", ""].join("\n")
}

/**
 * Reads the reply block back out of a sent prompt so the timeline can show the
 * answered message as a card above the answer. The quote keeps its ">" markers
 * on the wire for the model; they are stripped here and never rendered.
 */
export function splitReplyQuote(text: string): { quote: string; body: string } | undefined {
  const prompt = text.replace(/\r\n?/g, "\n")
  const head = `> ${MARKER}\n`
  if (!prompt.startsWith(head)) return undefined

  // A blank line inside the quote is written as a bare ">", so the first empty
  // line is the separator the sender wrote between the quote and the answer.
  const rest = prompt.slice(head.length)
  const end = rest.indexOf("\n\n")
  const quoted = end === -1 ? rest : rest.slice(0, end)
  const quote = quoted
    .split("\n")
    .map((line) => (line === ">" ? "" : line.startsWith("> ") ? line.slice(2) : line))
    .join("\n")
  return { quote: quote.trimEnd(), body: end === -1 ? "" : rest.slice(end + 2) }
}
