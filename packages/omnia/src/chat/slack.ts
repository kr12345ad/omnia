// The Slack transport: Slack posts each mention and DM to the public webhook
// route, so what this adds over the route is the reply half -- chat.postMessage
// on the channel and thread the message arrived on, a live trace message, and
// answers longer than one message.
//
// Slack renders mrkdwn, not Markdown: `**bold**` arrives as literal asterisks and
// `[a](b)` as brackets, so toSlackMarkdown rewrites what Slack does not draw.

import type { ChatMessage, ChatReply, ChatTrace, ChatTransport } from "./service"
import { splitMarkdown } from "./text"

const SLACK_API = "https://slack.com/api"
// Slack rejects chat.postMessage text longer than 4,000 characters; the rest of
// the room is for the markup a chunk of a split answer carries.
const MESSAGE_LIMIT = 3_800
const REPLY_LIMIT = 16_384
const TRUNCATION_NOTICE = `_(omitted: this answer is longer than ${REPLY_LIMIT.toLocaleString("en-US")} characters)_`
const TRACE_LIMIT = 3_800
const TRACE_MIN_INTERVAL_MS = 1_200
const RATE_LIMIT_RETRIES = 3
const MAX_RETRY_WAIT_MS = 15_000
// Slack retries an event it did not see acknowledged within three seconds; an
// agent turn must not run twice for the same message.
const SEEN_LIMIT = 200

export interface SlackTransportOptions {
  /** The bot token, `xoxb-...`. */
  readonly token: string
  readonly apiUrl?: string
  readonly onMessage: (message: ChatMessage) => void
  readonly onError?: (error: string) => void
  readonly log?: (line: string) => void
  readonly now?: () => number
}

interface SlackEvent {
  readonly type?: string
  readonly subtype?: string
  readonly channel?: string
  readonly channel_type?: string
  readonly user?: string
  readonly bot_id?: string
  readonly text?: string
  readonly ts?: string
  readonly thread_ts?: string
}

interface SlackEnvelope {
  readonly type?: string
  readonly challenge?: string
  readonly event_id?: string
  readonly event?: SlackEvent
}

export function createSlackTransport(options: SlackTransportOptions): ChatTransport | undefined {
  if (options.token.trim().length === 0) {
    options.onError?.("Slack needs the bot token (xoxb-...) for a connected workspace.")
    return undefined
  }
  return new SlackTransport(options)
}

/**
 * Slack proves a Request URL by posting a challenge and expecting it back in the
 * response body. Without the echo the app cannot be saved, so a verified
 * delivery is checked before it is treated as a message.
 */
export function slackChallenge(body: string): string | undefined {
  const envelope = parseJson<SlackEnvelope>(body)
  if (envelope?.type !== "url_verification") return undefined
  return typeof envelope.challenge === "string" && envelope.challenge.length > 0 ? envelope.challenge : undefined
}

class SlackTransport implements ChatTransport {
  private readonly apiUrl: string
  private readonly token: string
  private readonly onMessage: (message: ChatMessage) => void
  private readonly onError: (error: string) => void
  private readonly log: (line: string) => void
  private readonly now: () => number
  private readonly seen = new Set<string>()

  constructor(options: SlackTransportOptions) {
    this.apiUrl = options.apiUrl ?? SLACK_API
    this.token = options.token
    this.onMessage = options.onMessage
    this.onError = options.onError ?? (() => {})
    this.log = options.log ?? (() => {})
    this.now = options.now ?? Date.now
  }

  // Slack calls in; nothing to dial out to. Kept for the transport contract.
  start(): void {}

  stop(): void {}

  /** One event from Slack, or undefined for anything that is not a question. */
  receive(body: string): ChatMessage | undefined {
    const envelope = parseJson<SlackEnvelope>(body)
    const event = envelope?.event
    if (event === undefined) return undefined
    if (event.type !== "message" && event.type !== "app_mention") return undefined
    // Edits, joins and the app's own posts are events too, and none is a prompt.
    if (event.subtype !== undefined || event.bot_id !== undefined) return undefined
    if (event.user === undefined || event.channel === undefined) return undefined
    const text = slackText(event.text ?? "")
    if (text.length === 0) return undefined
    const id = envelope?.event_id
    if (id !== undefined) {
      if (this.seen.has(id)) return undefined
      this.remember(id)
    }
    return {
      platform: "slack",
      channelId: event.channel,
      userId: event.user,
      text,
      // Answer in the thread the question was asked in, or start one on the
      // question itself so an answer never scatters down a busy channel.
      ...(event.thread_ts !== undefined ? { threadId: event.thread_ts } : event.ts !== undefined ? { threadId: event.ts } : {}),
      receivedAt: this.now(),
    }
  }

  send(message: ChatMessage, reply: ChatReply): void {
    const text = reply.text.trim()
    if (text.length === 0) return
    void this.deliver(message, text).catch((error: unknown) => this.fail(error))
  }

  /** One answer can exceed a Slack message, so it goes out as consecutive ones. */
  private async deliver(message: ChatMessage, text: string): Promise<void> {
    for (const chunk of splitMarkdown(toSlackMarkdown(text), {
      limit: MESSAGE_LIMIT,
      total: REPLY_LIMIT,
      notice: TRUNCATION_NOTICE,
    })) {
      await this.request("chat.postMessage", {
        channel: message.channelId,
        text: chunk,
        ...(message.threadId === undefined ? {} : { thread_ts: message.threadId }),
      })
    }
  }

  /**
   * One message edited while the run works and deleted when it ends, so the
   * channel sees progress and then only the answer.
   */
  trace(message: ChatMessage): ChatTrace {
    let posted: { channel: string; ts: string } | undefined
    let lastSent = ""
    let pending: string | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let closed = false
    let chain: Promise<void> = Promise.resolve()

    const publish = (text: string) => {
      chain = chain
        .then(async () => {
          if (posted === undefined) {
            const created = await this.request("chat.postMessage", {
              channel: message.channelId,
              text,
              ...(message.threadId === undefined ? {} : { thread_ts: message.threadId }),
            })
            const ts = created?.ts
            posted = typeof ts === "string" ? { channel: message.channelId, ts } : undefined
            return
          }
          await this.request("chat.update", { channel: posted.channel, ts: posted.ts, text })
        })
        .catch((error: unknown) => this.fail(error))
    }

    return {
      update: (text) => {
        if (closed) return
        const next = text.slice(0, TRACE_LIMIT)
        if (next === lastSent) return
        pending = next
        if (timer !== undefined) return
        // Slack rate-limits edits per message; coalescing keeps the trace steady
        // instead of a burst the API refuses.
        timer = setTimeout(() => {
          timer = undefined
          const flushed = pending
          pending = undefined
          if (flushed === undefined || flushed === lastSent) return
          lastSent = flushed
          publish(flushed)
        }, TRACE_MIN_INTERVAL_MS)
      },
      remove: () => {
        closed = true
        if (timer !== undefined) {
          clearTimeout(timer)
          timer = undefined
        }
        pending = undefined
        chain = chain
          .then(async () => {
            const target = posted
            posted = undefined
            if (target === undefined) return
            await this.request("chat.delete", { channel: target.channel, ts: target.ts })
          })
          .catch(() => {})
      },
    }
  }

  private remember(id: string): void {
    this.seen.add(id)
    if (this.seen.size <= SEEN_LIMIT) return
    const oldest = this.seen.values().next()
    if (!oldest.done) this.seen.delete(oldest.value)
  }

  /**
   * One Slack Web API call. Slack answers 200 even when it refuses, so `ok` in
   * the body is the real status and its `error` names the reason.
   */
  private async request(method: string, body: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetch(`${this.apiUrl}/${method}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      })
      // Slack counts calls per method per channel; waiting the delay it names is
      // what lets a multi-message answer finish instead of dying halfway.
      if (response.status === 429 && attempt < RATE_LIMIT_RETRIES) {
        const wait = Math.min(Number(response.headers.get("retry-after") ?? "1") * 1_000, MAX_RETRY_WAIT_MS)
        this.log(`rate-limited on ${method}; retrying in ${Math.ceil(wait)}ms`)
        await new Promise((resolve) => setTimeout(resolve, Number.isFinite(wait) ? wait : 1_000))
        continue
      }
      const parsed = (await response.json().catch(() => undefined)) as unknown
      const record = isRecord(parsed) ? parsed : undefined
      if (!response.ok || record?.ok !== true) {
        const reason = typeof record?.error === "string" ? record.error : `HTTP ${response.status}`
        throw new Error(`Slack ${method} refused: ${reason}`)
      }
      return record
    }
  }

  private fail(error: unknown): void {
    const text = error instanceof Error ? error.message : String(error)
    this.onError(text)
    this.log(text)
  }
}

/**
 * Rewrites what mrkdwn does not draw. Everything inside a code fence is left
 * alone, because there it is content, not formatting.
 */
export function toSlackMarkdown(markdown: string): string {
  const lines = markdown.split("\n")
  const output: string[] = []
  let fence: string | undefined
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ""
    const fenceMatch = /^\s*(```+|~~~+)/.exec(line)
    if (fenceMatch !== null) {
      const marker = fenceMatch[1] ?? "```"
      fence = fence === undefined ? marker : undefined
      output.push(line)
      continue
    }
    if (fence !== undefined) {
      output.push(line)
      continue
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (heading !== null) {
      output.push(`*${inlineSlack(heading[2] ?? "")}*`)
      continue
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      output.push("──────────")
      continue
    }
    const task = /^(\s*[-*])\s+\[( |x|X)\]\s+(.*)$/.exec(line)
    if (task !== null) {
      output.push(`${task[1] ?? "-"} ${task[2] === " " ? "☐" : "☑"} ${task[3] ?? ""}`)
      continue
    }
    if (line.trimStart().startsWith("|") && isTableSeparator(lines[index + 1])) {
      const rows: string[][] = []
      while (index < lines.length && (lines[index] ?? "").trimStart().startsWith("|")) {
        const row = (lines[index] ?? "").trim()
        if (!isTableSeparator(row)) rows.push(splitRow(row))
        index += 1
      }
      index -= 1
      output.push(renderTable(rows))
      continue
    }
    output.push(inlineSlack(line))
  }
  return output.join("\n")
}

/** Bold, italics and links, which mrkdwn spells differently from Markdown. */
function inlineSlack(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/~~(.+?)~~/g, "~$1~")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "<$2|$1>")
}

function isTableSeparator(line: string | undefined): boolean {
  return line !== undefined && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes("-")
}

function splitRow(row: string): string[] {
  return row
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim())
}

function renderTable(rows: readonly string[][]): string {
  const width = rows.reduce((widest, row) => Math.max(widest, row.length), 0)
  if (width === 0) return ""
  const cells = rows.map((row) => Array.from({ length: width }, (_, column) => row[column] ?? ""))
  const widths = Array.from({ length: width }, (_, column) =>
    Math.max(1, ...cells.map((row) => (row[column] ?? "").length)),
  )
  const line = (row: readonly string[]) =>
    `| ${row.map((cell, column) => cell.padEnd(widths[column] ?? 1)).join(" | ")} |`
  const [header, ...body] = cells
  return [
    "```",
    line(header ?? []),
    widths.map((size) => "-".repeat(size)).join("-+-"),
    ...body.map(line),
    "```",
  ].join("\n")
}

/**
 * The prompt inside a Slack message: the app mention removed, and Slack's
 * `<https://url|label>` links turned back into something readable.
 */
function slackText(raw: string): string {
  return raw
    .replace(/<@[^>]+>/g, " ")
    .replace(/<([^|>]+)\|([^>]+)>/g, "$2 ($1)")
    .replace(/<([^|>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim()
}

function parseJson<T>(raw: string): T | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown
    return isRecord(parsed) ? (parsed as T) : undefined
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
