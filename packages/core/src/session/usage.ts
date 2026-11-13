// Context-window accounting shared by every client surface.
//
// `tokens.input` is the NON-cached prompt. Cache reads and writes are reported
// separately, so reading `input` alone under-reports a cached conversation by
// almost the whole window. Reasoning tokens are billed but never fed back to
// the model, so they do not occupy the next turn's window. The desktop app, the
// TUI, and `opencode run` all used to spell this out themselves, and drifted:
// some counted reasoning, some omitted the cache, and some rendered percentages
// above 100. Keep the definitions here so a meter cannot disagree with another.
export type Tokens = {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cache: {
    readonly read: number
    readonly write: number
  }
}

/** The prompt the next turn has to fit: uncached input plus all cached tokens. */
export function promptTokens(tokens: Tokens): number {
  return tokens.input + tokens.cache.read + tokens.cache.write
}

/**
 * What the conversation occupies after a turn: its prompt plus the visible
 * output. Reasoning is deliberately excluded; see the file comment.
 */
export function contextWindowTokens(tokens: Tokens): number {
  return promptTokens(tokens) + tokens.output
}

/**
 * Share of the model's context window in use, clamped to 0..100.
 *
 * `undefined` means there is no usable ceiling to divide by. It is never 0: a
 * missing limit is unknown, not an empty window.
 */
export function contextWindowPercent(tokens: Tokens, limit: number | undefined): number | undefined {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return undefined
  const percent = Math.round((contextWindowTokens(tokens) / limit) * 100)
  return Math.min(100, Math.max(0, percent))
}
