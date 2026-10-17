// Splitting a long answer for a chat platform.
//
// Every platform caps a single message, so a long answer has to arrive as
// several. The split prefers a line break, then a space, so a sentence is never
// cut mid-word, and it balances fenced code blocks: a block that continues into
// the next message is closed at the end of one and reopened at the start of the
// next, or the reader sees an unterminated fence.

interface Fence {
  readonly marker: string
  readonly info: string
}

export interface SplitOptions {
  readonly limit: number
  readonly total: number
  /** Shown when the answer is longer than `total`. Omitted means truncate silently. */
  readonly notice?: string
}

// Room for the closing marker a chunk needs when it ends inside a code block.
const FENCE_RESERVE = 8

/** Cut a chunk without landing inside a word: line break first, then a space. */
function chooseCut(window: string): number {
  const newline = window.lastIndexOf("\n")
  if (newline > window.length / 2) return newline + 1
  const space = window.lastIndexOf(" ")
  if (space > window.length / 2) return space + 1
  return window.length
}

function fenceAfter(lines: readonly string[], before: Fence | undefined): Fence | undefined {
  return lines.reduce<Fence | undefined>((fence, line) => {
    const match = /^\s*(```+|~~~+)(.*)$/.exec(line)
    if (match === null) return fence
    const marker = match[1] ?? ""
    const info = (match[2] ?? "").trim()
    if (fence === undefined) return { marker, info }
    // A closing fence carries no info string; anything else is content.
    return marker.startsWith(fence.marker) && info.length === 0 ? undefined : fence
  }, before)
}

export function splitMarkdown(text: string, options: SplitOptions): string[] {
  const { limit, total } = options
  const chunks: string[] = []
  let rest = text.slice(0, total)
  let open: Fence | undefined

  while (rest.length > limit) {
    // Always leave room for a closing marker: a chunk can end inside a block
    // even when it did not start in one.
    const window = rest.slice(0, Math.max(1, limit - FENCE_RESERVE))
    const cut = chooseCut(window)
    const piece = rest.slice(0, cut)
    const fence = fenceAfter(piece.split("\n"), open)
    // A block that runs past this message is closed here and reopened below.
    const suffix = fence === undefined ? "" : `\n${fence.marker}`
    chunks.push(`${piece.trimEnd()}${suffix}`)
    rest = `${fence === undefined ? "" : `${fence.marker}${fence.info}\n`}${rest.slice(cut)}`
    open = fence
  }

  // The last piece may close the block the previous message left open, or end
  // still inside one; only the latter needs a marker of its own.
  const tail = rest.trimEnd()
  const tailFence = fenceAfter(tail.split("\n"), open)
  chunks.push(tailFence === undefined ? tail : `${tail}\n${tailFence.marker}`)
  const delivered = chunks.filter((chunk) => chunk.length > 0)
  return options.notice === undefined || text.length <= total ? delivered : [...delivered, options.notice]
}
