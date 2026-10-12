/**
 * Splits assistant text into markdown and OpenUI Lang segments.
 *
 * The OpenUI prompt tells the model to wrap UI in a fenced `openui-lang` block,
 * so a message is prose with zero or more blocks. While a response is still
 * streaming the fence may not be closed yet; that trailing block is handed to
 * the renderer as `streaming` so it can show partial structure instead of
 * waiting for the model to finish.
 */

export type OpenUISegment =
  | { kind: "markdown"; text: string }
  | { kind: "openui"; code: string; streaming: boolean }

const OPEN = /^[ \t]*```[ \t]*(openui(?:-lang)?)[ \t]*$/i
const CLOSE = /^[ \t]*```[ \t]*$/

export function splitOpenUISegments(text: string, streaming = false): OpenUISegment[] {
  if (!text) return []
  const lines = text.split("\n")
  const segments: OpenUISegment[] = []
  let markdown: string[] = []
  let code: string[] | undefined

  const flushMarkdown = () => {
    if (markdown.length === 0) return
    segments.push({ kind: "markdown", text: markdown.join("\n") })
    markdown = []
  }
  const flushCode = (open: boolean) => {
    const body = (code ?? []).join("\n")
    code = undefined
    if (open && streaming) {
      segments.push({ kind: "openui", code: body, streaming: true })
      return
    }
    segments.push({ kind: "openui", code: body, streaming: false })
  }

  for (const line of lines) {
    if (code === undefined) {
      if (OPEN.test(line)) {
        flushMarkdown()
        code = []
        continue
      }
      markdown.push(line)
      continue
    }
    if (CLOSE.test(line)) {
      flushCode(false)
      continue
    }
    code.push(line)
  }

  if (code !== undefined) flushCode(true)
  else flushMarkdown()

  return segments.filter((segment) => (segment.kind === "openui" ? true : segment.text.trim().length > 0))
}

/** True when the text contains an OpenUI Lang fence (open or closed). */
export function hasOpenUIBlock(text: string) {
  return splitOpenUISegments(text, true).some((segment) => segment.kind === "openui")
}
