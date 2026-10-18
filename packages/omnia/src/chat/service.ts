import { createHmac } from "node:crypto"
import type { GitHubProfile } from "../auth/github"
import { ChatChannelsService as Store, type ChatChannelOwner } from "./channels"
import { CHAT_PLATFORMS, type ChatPlatformSpec } from "./platforms"
import { slackChallenge } from "./slack"
import { verifyGChat, verifyWebhook, type WebhookVerificationResult } from "./verify"

/**
 * A file that arrived with a chat message. The bytes are read lazily: a platform
 * reference (Discord's CDN, Slack's private file URL) needs that platform's auth,
 * which only the transport has, and a message that is never answered should not
 * download anything.
 */
export interface ChatAttachment {
  readonly name: string
  readonly mime: string
  /** A data: URL for the bytes, or undefined when they cannot be read. */
  load(): Promise<string | undefined>
}

// The message a reply points at, when the platform sends one. A reply is often
// a question about that message, so the agent has to see it: the channel's
// session may be old, reset, or answer a dozen people at once.
export interface ChatQuote {
  readonly author?: string
  readonly text: string
}

export interface ChatMessage {
  readonly platform: string
  readonly channelId: string
  readonly userId: string
  readonly userName?: string
  readonly text: string
  readonly threadId?: string
  readonly replyTo?: ChatQuote
  readonly attachments?: readonly ChatAttachment[]
  readonly receivedAt: number
}

export interface ChatReply {
  readonly text: string
  readonly threadId?: string
}

/**
 * A live trace of a run: one message that is edited while the agent works and
 * removed once the answer is ready. The run decides what it says; the platform
 * decides how to show it.
 */
export interface ChatTrace {
  update(text: string): void
  remove(): void
}

export type AgentRunner = (message: ChatMessage, trace?: ChatTrace) => Promise<string>

/**
 * A live connection to one platform. Webhooks arrive at the server by
 * themselves; a platform that has to be connected out to (Discord's gateway)
 * is a transport that starts and stops with its channel.
 */
export interface ChatTransport {
  start(): void
  stop(): void
  send(message: ChatMessage, reply: ChatReply): void
  trace?(message: ChatMessage): ChatTrace | undefined
  /**
   * A platform that speaks webhooks parses its own delivery. Undefined means
   * the event is not a question (a bot echo, a membership change) and the
   * platform is answered with an empty 200 so it does not retry.
   */
  receive?(body: string): ChatMessage | undefined
}

export type ChatTransportFactory = (input: {
  readonly platform: string
  readonly credentials: Readonly<Record<string, string>>
  readonly onMessage: (message: ChatMessage) => void
  readonly onError: (error: string) => void
  /** True once this channel is a conversation Omnia already answers in. */
  readonly isConversation: (channelId: string) => boolean
}) => ChatTransport | undefined

/**
 * What a caller may know about a channel: which credentials are configured and
 * how the channel has been behaving, never a credential value. Connect answers
 * with this too, so a credential typed into the UI is never echoed back to it.
 */
export interface ChatChannelSummary {
  readonly platform: string
  readonly enabled: boolean
  readonly configured: readonly string[]
  readonly connectedAt?: number
  readonly lastMessageAt?: number
  readonly messageCount?: number
  readonly error?: string
  readonly owner?: { readonly provider: "github" | "google"; readonly id: string; readonly login: string }
}

// A channel answers as the account that connected it. These are the ways that
// account can stop being the one in use, and what the channel says instead of
// answering while it is paused.
const PAUSED_SIGNED_OUT =
  "Paused: no Omnia account is signed in. Sign in as the account that connected this channel to resume."
const PAUSED_UNBOUND =
  "Paused: this channel is not bound to an account yet. Reconnect it from Settings to bind it to the signed-in account."

/**
 * Whether a platform can actually reach this Omnia: returns why it cannot, or
 * undefined when it can. Only platforms that can answer the question have one.
 */
export type ChatChannelCheck = (
  platform: string,
  credentials: Readonly<Record<string, string>>,
) => Promise<string | undefined>

export type ChatWebhookVerifier = (
  platform: string,
  headers: Headers,
  body: string,
  credentials: Readonly<Record<string, string>>,
) => Promise<WebhookVerificationResult>

export class ChatChannelsRuntime {
  private readonly store: Store
  private readonly verifier: ChatWebhookVerifier | undefined
  private agentRunner: AgentRunner | undefined
  private transportFactory: ChatTransportFactory | undefined
  private conversationCheck: ((platform: string, channelId: string) => boolean) | undefined
  private channelCheck: ChatChannelCheck | undefined
  private currentProfile: (() => GitHubProfile | undefined) | undefined
  private readonly secret: string | undefined
  private readonly transports = new Map<string, ChatTransport>()
  private readonly messageLog: ChatMessage[] = []

  constructor(options: { file?: string; verify?: ChatWebhookVerifier; secret?: string } = {}) {
    this.store = new Store(options.file === undefined ? {} : { file: options.file })
    this.verifier = options.verify
    this.secret = options.secret
  }

  /**
   * Who the control plane is signed in as right now. Channels are bound to the
   * account that connected them, so this is what every inbound message is
   * checked against before any agent work happens.
   */
  setIdentity(read: (() => GitHubProfile | undefined) | undefined): void {
    this.currentProfile = read
  }

  /** The credential fields each channel has set, and none of their values. */
  describe(): readonly ChatChannelSummary[] {
    return this.store.list().map((channel) => ({
      platform: channel.platform,
      enabled: channel.enabled,
      configured: (this.store.spec(channel.platform)?.fields ?? [])
        .map((field) => field.key)
        .filter((key) => (channel.credentials[key] ?? "").length > 0),
      ...(channel.connectedAt === undefined ? {} : { connectedAt: channel.connectedAt }),
      ...(channel.lastMessageAt === undefined ? {} : { lastMessageAt: channel.lastMessageAt }),
      ...(channel.messageCount === undefined ? {} : { messageCount: channel.messageCount }),
      ...(channel.error === undefined ? {} : { error: channel.error }),
      ...(channel.owner === undefined
        ? {}
        : { owner: { provider: channel.owner.provider, id: channel.owner.id, login: channel.owner.login } }),
    }))
  }

  describeOne(platform: string): ChatChannelSummary | undefined {
    return this.describe().find((channel) => channel.platform === platform)
  }

  setAgentRunner(runner: AgentRunner | undefined): void {
    this.agentRunner = runner
  }

  /**
   * Reconcile live transports with the channel table: a connected and enabled
   * channel has one, a removed or disabled one has none. Called at boot and
   * after every channel change, so the connection follows the store rather
   * than a separate lifecycle the UI would have to drive.
   */
  /**
   * Whether a channel is already a conversation. A platform uses it to decide
   * whether an unaddressed message belongs to Omnia.
   */
  setConversationCheck(check: ((platform: string, channelId: string) => boolean) | undefined): void {
    this.conversationCheck = check
  }

  setChannelCheck(check: ChatChannelCheck | undefined): void {
    this.channelCheck = check
  }

  /**
   * Ask the platform whether it will actually reach us, and record the answer on
   * the channel. Storing credentials proves nothing: an app that was never
   * configured keeps them, never receives a message and looks connected, so the
   * reason belongs where the settings panel can show it.
   */
  async verify(platform: string): Promise<string | undefined> {
    const channel = this.store.get(platform)
    const check = this.channelCheck
    if (channel === undefined || check === undefined) return undefined
    const problem = await check(platform, channel.credentials).catch((error: unknown) =>
      error instanceof Error ? error.message : String(error),
    )
    if (problem === undefined) this.store.clearError(platform)
    else this.store.setError(platform, problem)
    return problem
  }

  setTransportFactory(factory: ChatTransportFactory | undefined): void {
    for (const transport of this.transports.values()) transport.stop()
    this.transports.clear()
    this.transportFactory = factory
    this.sync()
  }

  sync(): void {
    for (const [platform, transport] of [...this.transports]) {
      const channel = this.store.get(platform)
      if (channel !== undefined && channel.enabled) continue
      transport.stop()
      this.transports.delete(platform)
    }
    if (this.transportFactory === undefined) return
    this.store
      .list()
      .filter((channel) => channel.enabled && !this.transports.has(channel.platform))
      .forEach((channel) => {
        const transport = this.transportFactory?.({
          platform: channel.platform,
          credentials: channel.credentials,
          onMessage: (message) => this.deliver(message),
          onError: (error) => this.store.setError(channel.platform, error),
          isConversation: (channelId) => this.conversationCheck?.(channel.platform, channelId) === true,
        })
        if (transport === undefined) return
        this.transports.set(channel.platform, transport)
        transport.start()
      })
  }

  stop(): void {
    for (const transport of this.transports.values()) transport.stop()
    this.transports.clear()
  }

  list() {
    return this.store.list()
  }

  connect(platform: string, credentials: Record<string, string>): ChatChannelSummary {
    this.requireOwner(platform)
    const existing = this.store.get(platform)
    const profile = this.currentProfile?.()
    // The first account to connect a channel owns it; reconnecting the same
    // account keeps the original binding instead of minting a new one.
    const owner = existing?.owner ?? (profile === undefined ? undefined : this.ownerFor(profile))
    const binding = existing?.ownerBinding ?? (owner === undefined ? undefined : this.sign(platform, owner))
    const channel = this.store.connect(platform, credentials, undefined, owner, binding)
    return (
      this.describeOne(platform) ?? {
        platform: channel.platform,
        enabled: channel.enabled,
        configured: [],
      }
    )
  }

  disconnect(platform: string): boolean {
    // Removing a channel would otherwise be the way around its binding: delete
    // it, reconnect it as the account you signed in with.
    this.requireOwner(platform)
    return this.store.disconnect(platform)
  }

  setEnabled(platform: string, enabled: boolean): ChatChannelSummary | undefined {
    this.store.setEnabled(platform, enabled)
    return this.describeOne(platform)
  }

  spec(platform: string): ChatPlatformSpec | undefined {
    return this.store.spec(platform)
  }

  platforms() {
    return CHAT_PLATFORMS
  }

  async handleWebhook(
    platform: string,
    headers: Headers,
    body: string,
  ): Promise<{ ok: boolean; status: number; reply?: string; challenge?: string }> {
    const channel = this.store.get(platform)
    if (channel === undefined || !channel.enabled) {
      return { ok: false, status: 404 }
    }
    // A webhook or signing secret outranks a bot token: Slack signs with the
    // signing secret and WhatsApp verifies with the verify token, so preferring
    // the bot token would verify every delivery against the wrong secret.
    const secret =
      channel.webhookSecret ??
      channel.credentials.webhookSecret ??
      channel.credentials.signingSecret ??
      channel.credentials.verifyToken ??
      channel.credentials.botToken ??
      ""
    const verification = await this.checkDelivery(platform, headers, body, channel.credentials, secret)
    if (!verification.ok) {
      this.store.setError(platform, verification.reason ?? "invalid webhook")
      return { ok: false, status: 401 }
    }
    this.store.clearError(platform)
    // Slack saves a Request URL only when the challenge it posts comes back in
    // the response body, so this is answered before anything reads the event.
    if (platform === "slack") {
      const challenge = slackChallenge(body)
      if (challenge !== undefined) return { ok: true, status: 200, challenge }
    }
    // A live transport knows its platform's event shape. Hand it the delivery
    // and answer at once: an agent turn can outlast the platform's timeout, so
    // the reply goes out over the transport instead of back down this request.
    const live = this.transports.get(platform)
    if (live?.receive !== undefined) {
      const message = live.receive(body)
      if (message !== undefined) this.deliver(message)
      return { ok: true, status: 200 }
    }
    // Google Chat only makes sense through its transport: without one there is
    // no event parser and no way to answer, so a turn on the raw JSON would be
    // nonsense. Ask Google to retry instead.
    if (platform === "gchat") {
      this.store.setError(platform, "Google Chat is not answering: check the service-account credentials.")
      return { ok: false, status: 503 }
    }
    let parsed: { text?: string; userId?: string; userName?: string; channelId?: string; threadId?: string }
    try {
      parsed = JSON.parse(body) as typeof parsed
    } catch {
      parsed = { text: body }
    }
    const message: ChatMessage = {
      platform,
      channelId: parsed.channelId ?? "default",
      userId: parsed.userId ?? "unknown",
      ...(parsed.userName === undefined ? {} : { userName: parsed.userName }),
      text: parsed.text ?? body,
      ...(parsed.threadId === undefined ? {} : { threadId: parsed.threadId }),
      receivedAt: Date.now(),
    }
    const answered = await this.answer(message)
    return { ok: answered.ok, status: answered.ok ? 200 : 500, reply: answered.reply }
  }

  private async checkDelivery(
    platform: string,
    headers: Headers,
    body: string,
    credentials: Readonly<Record<string, string>>,
    secret: string,
  ): Promise<WebhookVerificationResult> {
    const verifier = this.verifier
    if (verifier !== undefined) return verifier(platform, headers, body, credentials)
    // Google signs with its own keys and names the app's configured audience,
    // so this check is not a shared secret and has to fetch the key set.
    if (platform === "gchat") return verifyGChat(headers, { audience: credentials.audience ?? "" })
    return verifyWebhook(platform, headers, body, secret)
  }

  /**
   * One inbound message, one agent turn, one reply. Both the webhook receiver
   * and a live transport go through here so metering, the error column and the
   * transcript read the same regardless of how the message arrived.
   */
  async answer(message: ChatMessage, trace?: ChatTrace): Promise<{ ok: boolean; reply?: string }> {
    const paused = this.paused(message.platform)
    if (paused !== undefined) {
      // Refused, not answered: no agent turn and the reason recorded where the
      // settings panel can show it. The notice is posted back to the channel so
      // a paused bot is visibly paused instead of silently broken.
      this.store.setError(message.platform, paused)
      return { ok: true, reply: paused }
    }
    this.messageLog.push(message)
    this.store.recordMessage(message.platform)
    if (this.agentRunner === undefined) {
      return { ok: true, reply: "Omnia is connected. Agent wiring is pending." }
    }
    try {
      const reply = await this.agentRunner(message, trace)
      this.store.clearError(message.platform)
      return { ok: true, reply }
    } catch (error) {
      this.store.setError(message.platform, error instanceof Error ? error.message : String(error))
      return { ok: false, reply: "Omnia could not answer right now." }
    } finally {
      // The trace is scaffolding: it goes away before the answer is visible, and
      // a platform that cannot remove it must not swallow the answer.
      try {
        trace?.remove()
      } catch {
        // ignored on purpose
      }
    }
  }

  // A transport hands the reply back over its own connection. The answer is
  // already persisted by answer(), so a delivered reply that fails in the
  // platform only records an error against the channel.
  private deliver(message: ChatMessage): void {
    const transport = this.transports.get(message.platform)
    if (transport === undefined) return
    void this.answer(message, this.openTrace(transport, message)).then(
      (answered) => {
        if (answered.reply === undefined || answered.reply.length === 0) return
        this.post(transport, message, answered.reply)
      },
      (error) => {
        // answer() records its own failures; this is the last resort so a
        // rejected run still reaches the channel instead of going quiet.
        this.post(transport, message, `Omnia could not answer that one right now: ${describe(error)}`.slice(0, 300))
      },
    )
  }

  private openTrace(transport: ChatTransport, message: ChatMessage): ChatTrace | undefined {
    try {
      return transport.trace?.(message)
    } catch (error) {
      this.store.setError(message.platform, describe(error))
      return undefined
    }
  }

  /** A throwing send would otherwise vanish into a rejected promise. */
  private post(transport: ChatTransport, message: ChatMessage, text: string): void {
    try {
      transport.send(message, { text })
    } catch (error) {
      this.store.setError(message.platform, describe(error))
    }
  }

  recentMessages(limit = 50): readonly ChatMessage[] {
    return this.messageLog.slice(-limit)
  }

  // The refusal reason for this channel, or undefined when it may answer. The
  // check is the gate in front of every agent turn: a webhook, a Discord
  // gateway event and a Slack mention all reach answer(), so none of them can
  // spend a model call while the account in use is not the bound one.
  private paused(platform: string): string | undefined {
    const profile = this.currentProfile?.()
    const channel = this.store.get(platform)
    if (channel === undefined) return undefined
    // The binding is made when a channel is connected, never inferred from
    // whoever happens to be running: two Omnia processes share this file, so an
    // inferred owner could be the other process's account.
    if (channel.owner === undefined) return PAUSED_UNBOUND
    const owner = channel.owner
    if (profile === undefined) return PAUSED_SIGNED_OUT
    if (!this.isOwner(owner, profile)) {
      return `Paused: this channel is bound to @${owner.login}. Sign in as that account to resume.`
    }
    if (this.secret !== undefined && channel.ownerBinding !== this.sign(platform, owner)) {
      return "Paused: this channel's account binding was altered. Reconnect the channel from Settings to resume."
    }
    return undefined
  }

  private requireOwner(platform: string): void {
    const owner = this.store.get(platform)?.owner
    if (owner === undefined) return
    const profile = this.currentProfile?.()
    if (profile === undefined || !this.isOwner(owner, profile)) {
      throw new Error(`This channel is bound to @${owner.login}. Sign back in as that account to manage it.`)
    }
  }

  private isOwner(owner: ChatChannelOwner, profile: GitHubProfile): boolean {
    return owner.provider === (profile.provider ?? "github") && owner.id === String(profile.id)
  }

  private ownerFor(profile: GitHubProfile): ChatChannelOwner {
    return { provider: profile.provider ?? "github", id: String(profile.id), login: profile.login, boundAt: Date.now() }
  }

  private sign(platform: string, owner: ChatChannelOwner): string | undefined {
    if (this.secret === undefined) return undefined
    return createHmac("sha256", this.secret).update(`${platform}\n${owner.provider}\n${owner.id}`).digest("hex")
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
