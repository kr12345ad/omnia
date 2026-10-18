// The Discord transport: one resident gateway connection per connected channel,
// so a Discord message reaches Omnia without a public URL and without an
// interactions endpoint. Replies go back over Discord's REST API on the same
// channel the message arrived on.
//
// Discord only sends message text to a bot with the MESSAGE_CONTENT privileged
// intent; without it the gateway closes with 4014. That is reported once and
// not retried, because a reconnect loop would hide the real cause.

import { fetchAttachment, mimeFromName } from "./attachments"
import type { ChatAttachment, ChatMessage, ChatQuote, ChatReply, ChatTrace, ChatTransport } from "./service"
import { splitMarkdown } from "./text"

const DISCORD_API = "https://discord.com/api/v10"
const DISCORD_GATEWAY = "wss://gateway.discord.gg/?v=10&encoding=json"
// GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT
const INTENTS = 1 | 512 | 4096 | 32768
// Discord rejects message content longer than this, so a longer answer is
// delivered as several messages instead of being cut off mid-sentence.
const CONTENT_LIMIT = 2000
// Longest answer Omnia delivers. Past this the reply ends with a notice rather
// than a silent cut.
const REPLY_LIMIT = 16_384
const TRUNCATION_NOTICE = `_(omitted: this answer is longer than ${REPLY_LIMIT.toLocaleString("en-US")} characters)_`
// Discord counts message creates per channel and answers 429 when the bucket is
// empty; a long answer needs more than one bucket.
const RATE_LIMIT_RETRIES = 3
const DISALLOWED_INTENTS = 4014
const HEARTBEAT_FALLBACK_MS = 41_250
// A zero-width space marks a trace: invisible in Discord, so a run that died
// mid-flight leaves something the next run can find and delete.
const TRACE_MARK = "\u200b"
const TRACE_SWEEP_LIMIT = 25
const TRACE_MIN_AGE_MS = 5_000
// Enough of the answered message to know what the reply is about; the rest is
// in the channel and the session, and a quote is not the question.
const QUOTE_LIMIT = 1_500

export interface DiscordTransportOptions {
  readonly token: string
  readonly apiUrl?: string
  readonly gatewayUrl?: string
  readonly onMessage: (message: ChatMessage) => void
  readonly onError?: (error: string) => void
  readonly onReady?: (bot: { id: string; username: string }) => void
  /** True once this channel is a conversation Omnia already answers in. */
  readonly isConversation?: (channelId: string) => boolean
  readonly log?: (line: string) => void
}

function discordAttachments(files: readonly DiscordAttachment[] | undefined): ChatAttachment[] {
  return (files ?? []).flatMap((file) => {
    const url = file.url
    if (typeof url !== "string" || url.length === 0) return []
    const name = file.filename?.trim() || "attachment"
    return [
      {
        name,
        mime: (file.content_type ?? "").trim() || mimeFromName(name),
        load: () => fetchAttachment(url),
      },
    ]
  })
}

interface GatewayPayload {
  readonly op: number
  readonly t?: string
  readonly s?: number
  readonly d?: unknown
}

interface DiscordAuthor {
  readonly id?: string
  readonly username?: string
  readonly bot?: boolean
}

interface DiscordAttachment {
  readonly filename?: string
  readonly content_type?: string
  /** A signed CDN link: readable without the bot token, but short lived. */
  readonly url?: string
}

interface DiscordMessage {
  readonly channel_id?: string
  readonly guild_id?: string
  readonly content?: string
  readonly author?: DiscordAuthor
  readonly referenced_message?: {
    readonly author?: DiscordAuthor
    readonly content?: string
  }
  readonly attachments?: readonly DiscordAttachment[]
}

/** The message this one replies to, as much of it as is worth putting in a prompt. */
function discordQuote(referenced: DiscordMessage["referenced_message"]): ChatQuote | undefined {
  const text = (referenced?.content ?? "").trim()
  if (text.length === 0) return undefined
  const author = referenced?.author?.username
  return {
    ...(author === undefined || author.length === 0 ? {} : { author }),
    text: text.length > QUOTE_LIMIT ? `${text.slice(0, QUOTE_LIMIT).trimEnd()}…` : text,
  }
}

export function createDiscordTransport(options: DiscordTransportOptions): ChatTransport {
  return new DiscordGateway(options)
}

class DiscordGateway implements ChatTransport {
  private readonly token: string
  private readonly apiUrl: string
  private readonly gatewayUrl: string
  private readonly onMessage: (message: ChatMessage) => void
  private readonly onError: (error: string) => void
  private readonly onReady: (bot: { id: string; username: string }) => void
  private readonly isConversation: (channelId: string) => boolean
  private readonly log: (line: string) => void
  private socket: WebSocket | undefined
  private heartbeat: ReturnType<typeof setInterval> | undefined
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private botId: string | undefined
  // Roles the bot itself wears, per guild: mentioning @AI means the bot when
  // the bot holds that role, and mentioning somebody else's role does not.
  private readonly roleIds = new Map<string, Set<string>>()
  private sequence: number | undefined
  private awaitingAck = false
  private attempts = 0
  private stopped = true

  constructor(options: DiscordTransportOptions) {
    this.token = options.token
    this.apiUrl = options.apiUrl ?? DISCORD_API
    this.gatewayUrl = options.gatewayUrl ?? DISCORD_GATEWAY
    this.onMessage = options.onMessage
    this.onError = options.onError ?? (() => {})
    this.onReady = options.onReady ?? (() => {})
    this.isConversation = options.isConversation ?? (() => false)
    this.log = options.log ?? (() => {})
  }

  start(): void {
    if (this.socket !== undefined || this.reconnectTimer !== undefined) return
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    this.stopHeartbeat()
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    const socket = this.socket
    this.socket = undefined
    socket?.close()
  }

  send(message: ChatMessage, reply: ChatReply): void {
    const text = reply.text.trim()
    if (text.length === 0) return
    void this.deliver(message.channelId, text).catch((error: unknown) => this.fail(error))
  }

  /** One answer can exceed a Discord message, so it goes out as consecutive messages. */
  private async deliver(channelId: string, text: string): Promise<void> {
    for (const chunk of splitReply(text)) {
      await this.request("POST", `/channels/${channelId}/messages`, {
        content: chunk,
        // The reply is a machine's answer, not a broadcast: never ping @everyone.
        allowed_mentions: { parse: [] },
      })
    }
  }

  /**
   * One message that is edited while the run works and deleted when it ends, so
   * the channel sees live progress and then only the answer.
   */
  trace(message: ChatMessage): ChatTrace {
    const channelId = message.channelId
    let messageId: string | undefined
    let pending: string | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let lastSent = ""
    let closed = false
    let chain: Promise<void> = Promise.resolve()

    const publish = (text: string) => {
      chain = chain
        .then(async () => {
          if (messageId === undefined) {
            // A previous run may have been killed before removing its trace.
            // Sweep those or the channel keeps showing stale reasoning.
            await this.sweepTraces(channelId)
            const created = await this.request("POST", `/channels/${channelId}/messages`, {
              content: text,
              allowed_mentions: { parse: [] },
            })
            const id = created?.id
            messageId = typeof id === "string" ? id : undefined
            return
          }
          await this.request("PATCH", `/channels/${channelId}/messages/${messageId}`, {
            content: text,
            allowed_mentions: { parse: [] },
          })
        })
        .catch((error: unknown) => this.fail(error))
    }

    return {
      update: (text) => {
        if (closed) return
        // The mark trails the text: a leading zero-width space would stop
        // Discord from reading "-#" as subtext.
        const next = `${text}${TRACE_MARK}`.slice(0, CONTENT_LIMIT)
        if (next === lastSent) return
        pending = next
        if (timer !== undefined) return
        // Discord rate-limits edits per message; one per 1.2s coalesces the
        // two-second polling into a steady trace instead of a burst.
        timer = setTimeout(() => {
          timer = undefined
          const flushed = pending
          pending = undefined
          if (flushed === undefined || flushed === lastSent) return
          lastSent = flushed
          publish(flushed)
        }, 1_200)
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
            const id = messageId
            messageId = undefined
            if (id === undefined) return
            await this.request("DELETE", `/channels/${channelId}/messages/${id}`)
          })
          .catch(() => {})
      },
    }
  }

  private connect(): void {
    const socket = new WebSocket(this.gatewayUrl)
    this.socket = socket
    socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") this.handle(event.data)
    })
    socket.addEventListener("close", (event) => {
      this.socket = undefined
      this.stopHeartbeat()
      this.awaitingAck = false
      if (this.stopped) return
      if (event.code === DISALLOWED_INTENTS) {
        this.fail(
          new Error(
            "Discord closed the gateway because the bot's privileged intents are disabled: enable Message Content Intent in the Discord developer portal.",
          ),
        )
        return
      }
      if (this.reconnectTimer !== undefined) return
      this.reconnect()
    })
  }

  private reconnect(): void {
    this.attempts += 1
    const delay = Math.min(1_000 * this.attempts, 60_000)
    this.log(`gateway closed, reconnecting in ${delay}ms (attempt ${this.attempts})`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      if (!this.stopped) this.connect()
    }, delay)
  }

  private handle(raw: string): void {
    const payload = parsePayload(raw)
    if (payload === undefined) return
    if (payload.op === 1) {
      this.sendPayload({ op: 1, d: this.sequence ?? null })
      return
    }
    if (payload.op === 11) {
      this.awaitingAck = false
      return
    }
    // 7 asks for a reconnect, 9 says the session is gone. Ignoring them leaves
    // the socket open and silently stops delivering messages.
    if (payload.op === 7 || payload.op === 9) {
      this.drop(`Discord asked for a reconnect (op ${payload.op})`)
      return
    }
    if (payload.op === 10) {
      const hello = payload.d as { heartbeat_interval?: number } | undefined
      this.startHeartbeat(hello?.heartbeat_interval ?? HEARTBEAT_FALLBACK_MS)
      this.sendPayload({
        op: 2,
        d: {
          token: this.token,
          intents: INTENTS,
          properties: { os: process.platform, browser: "omnia", device: "omnia" },
        },
      })
      return
    }
    if (payload.op !== 0) return
    if (payload.s !== undefined) this.sequence = payload.s
    if (payload.t === "READY") {
      const ready = payload.d as { user?: DiscordAuthor } | undefined
      this.attempts = 0
      this.botId = ready?.user?.id
      this.onReady({ id: this.botId ?? "", username: ready?.user?.username ?? "" })
      this.log(`connected as ${ready?.user?.username ?? "unknown"}`)
      void this.loadRoles()
      return
    }
    if (payload.t === "GUILD_CREATE") {
      const guild = payload.d as { id?: string } | undefined
      if (guild?.id !== undefined) void this.loadGuildRoles(guild.id)
      return
    }
    if (payload.t === "MESSAGE_CREATE") this.handleMessage(payload.d)
  }

  private handleMessage(raw: unknown): void {
    if (typeof raw !== "object" || raw === null) return
    const message = raw as DiscordMessage
    const author = message.author
    // The bot's own replies arrive as messages too; answering them would loop.
    if (author?.bot === true) return
    if (author?.id === undefined || author.username === undefined) return
    if (message.channel_id === undefined) return
    const content = message.content ?? ""
    const mention = this.botId === undefined ? undefined : new RegExp(`<@!?${this.botId}>`)
    const roleMention = this.botRoleMention(message.guild_id, content)
    const mentioned = (mention !== undefined && mention.test(content)) || roleMention
    const direct = message.guild_id === undefined
    const replied = this.botId !== undefined && message.referenced_message?.author?.id === this.botId
    // Answering only the first message of a conversation is useless: once a
    // channel has a conversation, plain messages there are for Omnia. A channel
    // with no conversation yet still needs a mention, so the bot never answers
    // unrelated chatter it happens to see.
    const ongoing = this.isConversation(message.channel_id)
    if (!direct && !mentioned && !replied && !ongoing) {
      this.log(`ignored a message in ${message.channel_id}: no mention and no conversation there yet`)
      return
    }
    const stripped = mention === undefined ? content : content.replace(new RegExp(mention.source, "g"), " ")
    const text = stripped.replace(/<@&\d+>/g, " ").trim()
    const attachments = discordAttachments(message.attachments)
    // "<@bot>" with a screenshot and no words is a real prompt.
    if (text.length === 0 && attachments.length === 0) return
    void this.request("POST", `/channels/${message.channel_id}/typing`).catch(() => {})
    const replyTo = discordQuote(message.referenced_message)
    this.onMessage({
      platform: "discord",
      channelId: message.channel_id,
      userId: author.id,
      userName: author.username,
      text,
      ...(replyTo === undefined ? {} : { replyTo }),
      ...(attachments.length === 0 ? {} : { attachments }),
      receivedAt: Date.now(),
    })
  }

  private botRoleMention(guildId: string | undefined, content: string): boolean {
    if (guildId === undefined) return false
    const roles = this.roleIds.get(guildId)
    if (roles === undefined) return false
    return [...content.matchAll(/<@&(\d+)>/g)].some((match) => match[1] !== undefined && roles.has(match[1]))
  }

  private async loadRoles(): Promise<void> {
    const response = await fetch(`${this.apiUrl}/users/@me/guilds`, {
      headers: { authorization: `Bot ${this.token}` },
    }).catch(() => undefined)
    if (response === undefined || !response.ok) return
    const guilds = (await response.json().catch(() => undefined)) as unknown
    if (!Array.isArray(guilds)) return
    for (const guild of guilds) {
      const id = typeof guild === "object" && guild !== null ? (guild as { id?: unknown }).id : undefined
      if (typeof id === "string" && id.length > 0) await this.loadGuildRoles(id)
    }
  }

  private async loadGuildRoles(guildId: string): Promise<void> {
    if (this.botId === undefined) return
    const response = await fetch(`${this.apiUrl}/guilds/${guildId}/members/${this.botId}`, {
      headers: { authorization: `Bot ${this.token}` },
    }).catch(() => undefined)
    if (response === undefined || !response.ok) return
    const member = (await response.json().catch(() => undefined)) as { roles?: unknown } | undefined
    if (!Array.isArray(member?.roles)) return
    const roles = member.roles.filter((role): role is string => typeof role === "string")
    this.roleIds.set(guildId, new Set(roles))
    this.log(`holds ${roles.length} role(s) in ${guildId}`)
  }

  private startHeartbeat(intervalMs: number): void {
    this.stopHeartbeat()
    this.awaitingAck = false
    this.heartbeat = setInterval(
      () => {
        // A socket can stall without ever emitting close. If the last heartbeat
        // was never acknowledged, the connection is dead and must be replaced.
        if (this.awaitingAck) {
          this.drop("the heartbeat was not acknowledged")
          return
        }
        this.awaitingAck = true
        this.sendPayload({ op: 1, d: this.sequence ?? null })
      },
      Math.max(intervalMs, 1_000),
    )
  }

  private drop(reason: string): void {
    this.log(reason)
    const socket = this.socket
    this.socket = undefined
    this.stopHeartbeat()
    this.awaitingAck = false
    if (socket === undefined) {
      if (!this.stopped && this.reconnectTimer === undefined) this.reconnect()
      return
    }
    socket.close()
  }

  private stopHeartbeat(): void {
    if (this.heartbeat === undefined) return
    clearInterval(this.heartbeat)
    this.heartbeat = undefined
  }

  private sendPayload(payload: unknown): void {
    this.socket?.send(JSON.stringify(payload))
  }

  private async sweepTraces(channelId: string): Promise<void> {
    const messages = await this.fetchJson(`/channels/${channelId}/messages?limit=${TRACE_SWEEP_LIMIT}`).catch(
      () => undefined,
    )
    if (!Array.isArray(messages)) return
    for (const entry of messages) {
      if (typeof entry !== "object" || entry === null) continue
      const record = entry as Record<string, unknown>
      const author = record.author
      if (typeof author !== "object" || author === null || (author as { id?: unknown }).id !== this.botId) continue
      const content = record.content
      const id = record.id
      const timestamp = record.timestamp
      if (typeof content !== "string" || !content.endsWith(TRACE_MARK) || typeof id !== "string") continue
      // Leave a trace that another run opened moments ago alone.
      if (typeof timestamp === "string" && Date.now() - Date.parse(timestamp) < TRACE_MIN_AGE_MS) continue
      await this.request("DELETE", `/channels/${channelId}/messages/${id}`).catch(() => undefined)
    }
  }

  private async fetchJson(path: string): Promise<unknown> {
    const response = await fetch(`${this.apiUrl}${path}`, {
      headers: { authorization: `Bot ${this.token}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) return undefined
    return (await response.json().catch(() => undefined)) as unknown
  }

  private async request(
    method: "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<Record<string, unknown> | undefined> {
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetch(`${this.apiUrl}${path}`, {
        method,
        headers: {
          authorization: `Bot ${this.token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        // A stalled request must not wedge the trace's edit queue: every caller
        // chains its next request behind this one.
        signal: AbortSignal.timeout(10_000),
      })
      // Wait the retry_after Discord names instead of failing the answer halfway
      // through: the rate limit applies to message creates per channel.
      if (response.status === 429 && attempt < RATE_LIMIT_RETRIES) {
        const limit = (await response.json().catch(() => undefined)) as { retry_after?: unknown } | undefined
        const wait = typeof limit?.retry_after === "number" ? Math.min(limit.retry_after * 1_000, 15_000) : 1_000
        this.log(`rate-limited on ${path}; retrying in ${Math.ceil(wait)}ms`)
        await new Promise((resolve) => setTimeout(resolve, wait))
        continue
      }
      if (!response.ok) {
        const detail = (await response.text().catch(() => "")).slice(0, 200)
        throw new Error(`Discord ${path} answered ${response.status}${detail.length === 0 ? "" : `: ${detail}`}`)
      }
      if (method === "DELETE" || response.status === 204) return undefined
      const parsed = (await response.json().catch(() => undefined)) as unknown
      return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined
    }
  }

  private fail(error: unknown): void {
    const text = error instanceof Error ? error.message : String(error)
    this.onError(text)
    this.log(text)
  }
}

/**
 * Cuts an answer into messages Discord accepts, preferring line breaks and
 * spaces over a cut mid-word. Past REPLY_LIMIT the reply says so explicitly
 * instead of ending without a trace.
 */
export function splitReply(text: string, limit = CONTENT_LIMIT, total = REPLY_LIMIT): string[] {
  return splitMarkdown(text, { limit, total, notice: TRUNCATION_NOTICE })
}

function parsePayload(raw: string): GatewayPayload | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== "object" || parsed === null) return undefined
    const op = (parsed as { op?: unknown }).op
    if (typeof op !== "number") return undefined
    return parsed as GatewayPayload
  } catch {
    return undefined
  }
}
