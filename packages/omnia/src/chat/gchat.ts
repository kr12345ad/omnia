// The Google Chat transport: Google delivers each interaction to the public
// webhook route, so there is no connection to keep open -- what this adds over
// the route is the other half of the conversation: authenticated replies
// through the Chat API, a live trace message, and answers longer than one
// message.
//
// Chat apps default to the legacy Chat markup, where `**bold**` renders as
// literal asterisks. Every request here asks for MARKUP_SYNTAX_MARKDOWN so the
// agent's own Markdown renders, and toGChatMarkdown rewrites the constructs
// Markdown mode still does not draw (headings, tables, task lists).

import { createSign } from "node:crypto"
import { fetchAttachment, mimeFromName } from "./attachments"
import type { ChatAttachment, ChatMessage, ChatReply, ChatTrace, ChatTransport } from "./service"
import { splitMarkdown } from "./text"

const CHAT_API = "https://chat.googleapis.com/v1"
const TOKEN_URL = "https://oauth2.googleapis.com/token"
const CHAT_SCOPE = "https://www.googleapis.com/auth/chat.bot"
// Google Chat rejects a text message longer than 4096 characters, so answers
// leave room for the ellipsis and markup the splitter adds.
const MESSAGE_LIMIT = 4_000
const REPLY_LIMIT = 16_384
const TRUNCATION_NOTICE = `_(omitted: this answer is longer than ${REPLY_LIMIT.toLocaleString("en-US")} characters)_`
const TRACE_LIMIT = 4_000
const TRACE_MIN_INTERVAL_MS = 1_200
const RATE_LIMIT_RETRIES = 3
const MAX_RETRY_WAIT_MS = 15_000
// Google retries a delivery it could not answer; an agent turn must not run
// twice for the same message.
const SEEN_LIMIT = 200

export interface GChatTransportOptions {
  /** The service-account JSON, exactly as Google Cloud exports it. */
  readonly credentials: string
  readonly apiUrl?: string
  readonly tokenUrl?: string
  readonly onMessage: (message: ChatMessage) => void
  readonly onError?: (error: string) => void
  readonly log?: (line: string) => void
  readonly now?: () => number
}

interface ServiceAccount {
  readonly client_email: string
  readonly private_key: string
}

interface ChatAttachmentRef {
  /** The attachment resource, `spaces/…/messages/…/attachments/…`. */
  readonly name?: string
  readonly contentName?: string
  readonly contentType?: string
  /** Uploaded files only: Google's signed download URL, readable with the bot's token. */
  readonly downloadUri?: string
  readonly attachmentDataRef?: { readonly resourceName?: string }
}

interface ChatEventMessage {
  readonly name?: string
  readonly text?: string
  readonly argumentText?: string
  readonly sender?: { readonly name?: string; readonly displayName?: string; readonly type?: string }
  readonly thread?: { readonly name?: string }
  readonly attachment?: readonly ChatAttachmentRef[]
}

interface ChatEvent {
  readonly type?: string
  readonly space?: { readonly name?: string; readonly type?: string }
  readonly message?: ChatEventMessage
  readonly user?: { readonly name?: string; readonly displayName?: string }
  // Newer Chat event objects wrap the interaction in a payload.
  readonly chat?: {
    readonly space?: { readonly name?: string }
    readonly user?: { readonly name?: string; readonly displayName?: string }
    readonly messagePayload?: {
      readonly space?: { readonly name?: string }
      readonly message?: ChatEventMessage
    }
  }
}

export function createGChatTransport(options: GChatTransportOptions): ChatTransport | undefined {
  const account = readServiceAccount(options.credentials)
  if (account === undefined) {
    options.onError?.("Google Chat credentials are not a service-account JSON object with client_email and private_key.")
    return undefined
  }
  return new GChatTransport(options, account)
}

export interface GChatAppCheck {
  /** The service-account JSON, exactly as Google Cloud exports it. */
  readonly credentials: string
  readonly apiUrl?: string
  readonly tokenUrl?: string
  readonly now?: () => number
}

const APP_NOT_CONFIGURED =
  "Google has no Chat app configured for this project, so it will never deliver a message here. In the Google Cloud console open APIs & Services > Google Chat API > Configuration, point the HTTP endpoint URL and the authentication audience at this webhook and save. Google only allows that from a Google Workspace account."

/**
 * Why Google will not deliver anything yet, or undefined when the app is live.
 * Connecting a channel only stores credentials: an app that was never
 * configured in the console accepts every reply-less call with "Chat app not
 * found" and stays silent forever, which looks exactly like a healthy channel.
 * Listing spaces is the cheapest call a configured app answers.
 */
export async function checkGChatApp(options: GChatAppCheck): Promise<string | undefined> {
  const account = readServiceAccount(options.credentials)
  if (account === undefined) {
    return "Google Chat credentials are not a service-account JSON object with client_email and private_key."
  }
  const granted = await serviceAccountToken(account, options.tokenUrl ?? TOKEN_URL, options.now?.() ?? Date.now()).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, reason: error instanceof Error ? error.message : String(error) }),
  )
  if (!granted.ok) return `Google Chat rejected the service-account key: ${granted.reason}`
  const response = await fetch(`${options.apiUrl ?? CHAT_API}/spaces?pageSize=1`, {
    headers: { authorization: `Bearer ${granted.value.value}` },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined)
  if (response === undefined) return "Google Chat could not be reached from here."
  if (response.ok) return undefined
  const detail = (await response.text().catch(() => "")).slice(0, 200)
  if (response.status === 404 && detail.includes("Chat app not found")) return APP_NOT_CONFIGURED
  return `Google Chat answered ${response.status}${detail.length === 0 ? "" : `: ${detail}`}`
}

class GChatTransport implements ChatTransport {
  private readonly apiUrl: string
  private readonly tokenUrl: string
  private readonly account: ServiceAccount
  private readonly onMessage: (message: ChatMessage) => void
  private readonly onError: (error: string) => void
  private readonly log: (line: string) => void
  private readonly now: () => number
  private token: { value: string; expiresAt: number } | undefined
  private readonly seen = new Set<string>()

  constructor(options: GChatTransportOptions, account: ServiceAccount) {
    this.apiUrl = options.apiUrl ?? CHAT_API
    this.tokenUrl = options.tokenUrl ?? TOKEN_URL
    this.account = account
    this.onMessage = options.onMessage
    this.onError = options.onError ?? (() => {})
    this.log = options.log ?? (() => {})
    this.now = options.now ?? Date.now
  }

  // Google calls in; nothing to dial out to. Kept for the transport contract.
  start(): void {}

  stop(): void {}

  /** One event from Google, or undefined for anything that is not a question. */
  receive(body: string): ChatMessage | undefined {
    const event = parseJson<ChatEvent>(body)
    if (event === undefined) return undefined
    const message = event.chat?.messagePayload?.message ?? event.message
    const space = event.chat?.messagePayload?.space ?? event.chat?.space ?? event.space
    const spaceName = space?.name
    if (message === undefined || spaceName === undefined || spaceName.length === 0) return undefined
    // A message from another app is not a prompt, and answering it would ping-pong.
    if (message.sender?.type === "BOT") return undefined
    const user = event.chat?.user ?? event.user ?? message.sender
    if (message.name !== undefined) {
      if (this.seen.has(message.name)) return undefined
      this.remember(message.name)
    }
    const text = requireText(message)
    // A photo dropped into the space with no caption is still a question; the
    // attachment is the whole message.
    const attachments = gchatAttachments(message.attachment, (ref) => this.downloadAttachment(ref))
    if (text.length === 0 && attachments.length === 0) return undefined
    const displayName = user?.displayName ?? message.sender?.displayName
    return {
      platform: "gchat",
      channelId: spaceName,
      userId: user?.name ?? message.sender?.name ?? "unknown",
      ...(displayName === undefined ? {} : { userName: displayName }),
      text,
      ...(message.thread?.name === undefined ? {} : { threadId: message.thread.name }),
      ...(attachments.length === 0 ? {} : { attachments }),
      receivedAt: this.now(),
    }
  }

  /**
   * Google hands over either a signed download URL or a media resource name;
   * both need the bot's own token, never the sender's. A failed read is not a
   * failed answer: the runner names the file it could not open.
   */
  private async downloadAttachment(ref: ChatAttachmentRef): Promise<string | undefined> {
    const token = await this.accessToken()
    const headers = { authorization: `Bearer ${token}` }
    const resource = ref.attachmentDataRef?.resourceName?.trim()
    const media =
      resource === undefined || resource.length === 0 ? undefined : `${this.apiUrl}/media/${resource}?alt=media`
    const direct = ref.downloadUri?.trim()
    if (direct !== undefined && direct.length > 0) {
      const read = await fetchAttachment(direct, { headers })
      if (read !== undefined || media === undefined) return read
    }
    return media === undefined ? undefined : fetchAttachment(media, { headers })
  }

  send(message: ChatMessage, reply: ChatReply): void {
    const text = reply.text.trim()
    if (text.length === 0) return
    void this.deliver(message, text).catch((error: unknown) => this.fail(error))
  }

  /** One answer may exceed a Chat message, so it goes out as consecutive messages. */
  private async deliver(message: ChatMessage, text: string): Promise<void> {
    for (const chunk of splitMarkdown(toGChatMarkdown(text), {
      limit: MESSAGE_LIMIT,
      total: REPLY_LIMIT,
      notice: TRUNCATION_NOTICE,
    })) {
      await this.post(message.channelId, chunk, message.threadId)
    }
  }

  /**
   * One message edited while the run works and deleted when it ends, so the
   * space sees progress and then only the answer.
   */
  trace(message: ChatMessage): ChatTrace {
    let name: string | undefined
    let lastSent = ""
    let pending: string | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let closed = false
    let chain: Promise<void> = Promise.resolve()

    const publish = (text: string) => {
      chain = chain
        .then(async () => {
          if (name === undefined) {
            name = await this.create(message.channelId, text, message.threadId)
            return
          }
          await this.patch(name, text)
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
        // Chat edits are rate-limited per message; coalescing keeps the trace
        // steady instead of a burst the API refuses.
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
            const target = name
            name = undefined
            if (target === undefined) return
            await this.request("DELETE", `/${target}`)
          })
          .catch(() => {})
      },
    }
  }

  private remember(name: string): void {
    this.seen.add(name)
    if (this.seen.size <= SEEN_LIMIT) return
    const oldest = this.seen.values().next()
    if (!oldest.done) this.seen.delete(oldest.value)
  }

  private async create(space: string, text: string, threadId?: string): Promise<string | undefined> {
    // The reply option belongs in the query string: it tells Chat to keep the
    // answer in the user's thread, or start a new one when that thread is gone.
    const query = threadId === undefined ? "" : "?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD"
    const created = await this.request("POST", `/${space}/messages${query}`, {
      text,
      markupSyntax: "MARKUP_SYNTAX_MARKDOWN",
      ...(threadId === undefined ? {} : { thread: { name: threadId } }),
    })
    const name = created?.name
    return typeof name === "string" ? name : undefined
  }

  private async post(space: string, text: string, threadId?: string): Promise<void> {
    await this.create(space, text, threadId)
  }

  private async patch(name: string, text: string): Promise<void> {
    await this.request("PATCH", `/${name}?updateMask=text`, {
      text,
      markupSyntax: "MARKUP_SYNTAX_MARKDOWN",
    })
  }

  /** A service-account JWT exchanged for an access token, cached until it expires. */
  private async accessToken(): Promise<string> {
    const token = this.token
    if (token !== undefined && token.expiresAt > this.now()) return token.value
    this.token = await serviceAccountToken(this.account, this.tokenUrl, this.now())
    return this.token.value
  }

  private async request(
    method: "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<Record<string, unknown> | undefined> {
    for (let attempt = 0; ; attempt += 1) {
      const token = await this.accessToken()
      const response = await fetch(`${this.apiUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15_000),
      })
      // Chat enforces a per-space message quota; waiting the delay it names is
      // what lets a multi-message answer finish instead of dying halfway.
      if ((response.status === 429 || response.status === 503) && attempt < RATE_LIMIT_RETRIES) {
        const wait = retryDelay(response, this.now())
        this.log(`rate-limited on ${path}; retrying in ${Math.ceil(wait)}ms`)
        await new Promise((resolve) => setTimeout(resolve, wait))
        continue
      }
      if (!response.ok) {
        const detail = (await response.text().catch(() => "")).slice(0, 200)
        throw new Error(`Google Chat ${path} answered ${response.status}${detail.length === 0 ? "" : `: ${detail}`}`)
      }
      if (method === "DELETE" || response.status === 204) return undefined
      const parsed = (await response.json().catch(() => undefined)) as unknown
      return isRecord(parsed) ? parsed : undefined
    }
  }

  private fail(error: unknown): void {
    const text = error instanceof Error ? error.message : String(error)
    this.onError(text)
    this.log(text)
  }
}

/**
 * Rewrites what Markdown mode does not draw. Everything inside a code fence is
 * left alone, because there it is content, not formatting.
 */
export function toGChatMarkdown(markdown: string): string {
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
      output.push(`*${heading[2] ?? ""}*`)
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
    output.push(line)
  }
  return output.join("\n")
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

function gchatAttachments(
  refs: readonly ChatAttachmentRef[] | undefined,
  load: (ref: ChatAttachmentRef) => Promise<string | undefined>,
): ChatAttachment[] {
  return (refs ?? []).flatMap((ref) => {
    const name = (ref.contentName ?? "").trim() || "attachment"
    return [{ name, mime: (ref.contentType ?? "").trim() || mimeFromName(name), load: () => load(ref) }]
  })
}

function requireText(message: ChatEventMessage): string {
  // argumentText is the message with the app's own mention removed, which is
  // exactly the prompt. text still carries "<users/…>" in some clients.
  const raw = (message.argumentText ?? message.text ?? "").replace(/<users\/[^>]+>/g, " ")
  return raw.trim()
}

function retryDelay(response: Response, now: number): number {
  const header = response.headers.get("retry-after")
  if (header !== null) {
    const seconds = Number(header)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, MAX_RETRY_WAIT_MS)
    const date = Date.parse(header)
    if (Number.isFinite(date)) return Math.min(Math.max(0, date - now), MAX_RETRY_WAIT_MS)
  }
  return 1_000
}

/**
 * A service-account JWT exchanged for a Chat API access token. It is refreshed
 * early: a token that expires mid-answer would fail the last piece of a reply.
 */
async function serviceAccountToken(
  account: ServiceAccount,
  tokenUrl: string,
  now: number,
): Promise<{ value: string; expiresAt: number }> {
  const issuedAt = Math.floor(now / 1_000)
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))
  const claims = base64url(
    JSON.stringify({
      iss: account.client_email,
      scope: CHAT_SCOPE,
      aud: tokenUrl,
      iat: issuedAt,
      exp: issuedAt + 3_600,
    }),
  )
  const signature = base64url(createSign("RSA-SHA256").update(`${header}.${claims}`).sign(account.private_key))
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${header}.${claims}.${signature}`,
    }),
    signal: AbortSignal.timeout(10_000),
  })
  const granted = (await response.json().catch(() => undefined)) as unknown
  const value = isRecord(granted) ? granted.access_token : undefined
  if (!response.ok || typeof value !== "string") {
    const reason = isRecord(granted) ? granted.error_description ?? granted.error : undefined
    throw new Error(`Google Chat token request answered ${response.status}${typeof reason === "string" ? `: ${reason}` : ""}`)
  }
  const lifetime = isRecord(granted) && typeof granted.expires_in === "number" ? granted.expires_in : 3_600
  return { value, expiresAt: now + Math.max(60, lifetime - 60) * 1_000 }
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function readServiceAccount(credentials: string): ServiceAccount | undefined {
  const parsed = parseJson<Record<string, unknown>>(credentials)
  if (parsed === undefined) return undefined
  const email = parsed.client_email
  const key = parsed.private_key
  if (typeof email !== "string" || typeof key !== "string" || email.length === 0 || key.length === 0) return undefined
  return { client_email: email, private_key: key }
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
