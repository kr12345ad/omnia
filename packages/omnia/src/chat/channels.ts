import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { CHAT_PLATFORMS, type ChatPlatformSpec } from "./platforms"

// The account a channel answers as. A channel is set up by one person, and it
// stays that person's channel: signing in as somebody else must not hand the
// bot, its plan or its history to the new account.
export interface ChatChannelOwner {
  readonly provider: "github" | "google"
  readonly id: string
  readonly login: string
  readonly boundAt: number
}

export interface ChatChannelConfig {
  readonly platform: string
  readonly enabled: boolean
  readonly credentials: Readonly<Record<string, string>>
  readonly webhookSecret?: string
  readonly connectedAt?: number
  readonly lastMessageAt?: number
  readonly messageCount?: number
  readonly error?: string
  readonly owner?: ChatChannelOwner
  // HMAC of the owner binding, keyed by the control plane's own token, so an
  // edited channel file cannot point a channel at another account.
  readonly ownerBinding?: string
}

export interface ChatChannelsStore {
  readonly channels: readonly ChatChannelConfig[]
}

const DEFAULT_FILE = join(homedir(), ".local/share/omnia/chat-channels.json")

function defaultStore(): ChatChannelsStore {
  return { channels: [] }
}

function load(file: string): ChatChannelsStore {
  try {
    const raw = readFileSync(file, "utf8")
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== "object" || parsed === null) return defaultStore()
    const channels = (parsed as { channels?: unknown }).channels
    if (!Array.isArray(channels)) return defaultStore()
    const valid = channels.flatMap((entry): ChatChannelConfig[] => {
      if (typeof entry !== "object" || entry === null) return []
      const record = entry as Record<string, unknown>
      if (typeof record.platform !== "string") return []
      const spec = CHAT_PLATFORMS.find((item) => item.id === record.platform)
      if (spec === undefined) return []
      const credentials =
        typeof record.credentials === "object" && record.credentials !== null && !Array.isArray(record.credentials)
          ? (record.credentials as Record<string, string>)
          : {}
      const owner = readOwner(record.owner)
      return [
        {
          platform: record.platform,
          enabled: record.enabled !== false,
          credentials,
          ...(typeof record.webhookSecret === "string" ? { webhookSecret: record.webhookSecret } : {}),
          ...(typeof record.connectedAt === "number" ? { connectedAt: record.connectedAt } : {}),
          ...(typeof record.lastMessageAt === "number" ? { lastMessageAt: record.lastMessageAt } : {}),
          ...(typeof record.messageCount === "number" ? { messageCount: record.messageCount } : {}),
          ...(typeof record.error === "string" ? { error: record.error } : {}),
          ...(owner === undefined ? {} : { owner }),
          ...(typeof record.ownerBinding === "string" ? { ownerBinding: record.ownerBinding } : {}),
        },
      ]
    })
    return { channels: valid }
  } catch {
    return defaultStore()
  }
}

function save(file: string, store: ChatChannelsStore): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(store, null, 2), { mode: 0o600 })
}

function readOwner(value: unknown): ChatChannelOwner | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  const provider = record.provider === "google" ? "google" : record.provider === "github" ? "github" : undefined
  const id =
    typeof record.id === "string" ? record.id.trim() : typeof record.id === "number" ? String(record.id) : undefined
  if (provider === undefined || id === undefined || id.length === 0 || id.length > 128) return undefined
  if (typeof record.login !== "string" || record.login.length === 0) return undefined
  return {
    provider,
    id,
    login: record.login,
    boundAt: typeof record.boundAt === "number" ? record.boundAt : 0,
  }
}

export class ChatChannelsService {
  private readonly file: string

  constructor(options: { file?: string } = {}) {
    this.file = options.file ?? DEFAULT_FILE
  }

  // Every read and write goes to the file, never to a copy held since boot.
  // More than one Omnia process can share this file (the hosted control plane
  // and a desktop instance), and a process that answers from memory it loaded
  // hours ago overwrites every channel another one connected since -- silently
  // deleting them on the next recorded message.
  private channels(): readonly ChatChannelConfig[] {
    return load(this.file).channels
  }

  private save(channels: readonly ChatChannelConfig[]): void {
    save(this.file, { channels })
  }

  list(): readonly ChatChannelConfig[] {
    return this.channels()
  }

  get(platform: string): ChatChannelConfig | undefined {
    return this.channels().find((channel) => channel.platform === platform)
  }

  spec(platform: string): ChatPlatformSpec | undefined {
    return CHAT_PLATFORMS.find((item) => item.id === platform)
  }

  connect(
    platform: string,
    credentials: Record<string, string>,
    webhookSecret?: string,
    owner?: ChatChannelOwner,
    ownerBinding?: string,
  ): ChatChannelConfig {
    const spec = this.spec(platform)
    if (spec === undefined) throw new Error(`Unknown chat platform ${platform}.`)
    const now = Date.now()
    const next: ChatChannelConfig = {
      platform,
      enabled: true,
      credentials,
      ...(webhookSecret === undefined ? {} : { webhookSecret }),
      connectedAt: now,
      messageCount: 0,
      ...(owner === undefined ? {} : { owner }),
      ...(ownerBinding === undefined ? {} : { ownerBinding }),
    }
    const others = this.channels().filter((channel) => channel.platform !== platform)
    this.save([...others, next])
    return next
  }

  disconnect(platform: string): boolean {
    const current = this.channels()
    const channels = current.filter((channel) => channel.platform !== platform)
    if (channels.length === current.length) return false
    this.save(channels)
    return true
  }

  setEnabled(platform: string, enabled: boolean): ChatChannelConfig | undefined {
    const channel = this.get(platform)
    if (channel === undefined) return undefined
    const next = { ...channel, enabled }
    this.save(this.channels().map((item) => (item.platform === platform ? next : item)))
    return next
  }

  recordMessage(platform: string): void {
    const channel = this.get(platform)
    if (channel === undefined) return
    const next = { ...channel, lastMessageAt: Date.now(), messageCount: (channel.messageCount ?? 0) + 1 }
    this.save(this.channels().map((item) => (item.platform === platform ? next : item)))
  }

  setError(platform: string, error: string): void {
    const channel = this.get(platform)
    if (channel === undefined) return
    const next = { ...channel, error }
    this.save(this.channels().map((item) => (item.platform === platform ? next : item)))
  }

  clearError(platform: string): void {
    const channel = this.get(platform)
    if (channel === undefined) return
    const { error: _error, ...rest } = channel
    this.save(this.channels().map((item) => (item.platform === platform ? rest : item)))
  }
}
