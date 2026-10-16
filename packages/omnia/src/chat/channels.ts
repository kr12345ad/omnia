import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { CHAT_PLATFORMS, type ChatPlatformSpec } from "./platforms"

export interface ChatChannelConfig {
  readonly platform: string
  readonly enabled: boolean
  readonly credentials: Readonly<Record<string, string>>
  readonly webhookSecret?: string
  readonly connectedAt?: number
  readonly lastMessageAt?: number
  readonly messageCount?: number
  readonly error?: string
}

export interface ChatChannelsStore {
  readonly channels: readonly ChatChannelConfig[]
}

const FILE = join(homedir(), ".local/share/omnia/chat-channels.json")

function defaultStore(): ChatChannelsStore {
  return { channels: [] }
}

function load(): ChatChannelsStore {
  try {
    const raw = readFileSync(FILE, "utf8")
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
        },
      ]
    })
    return { channels: valid }
  } catch {
    return defaultStore()
  }
}

function save(store: ChatChannelsStore): void {
  mkdirSync(dirname(FILE), { recursive: true })
  writeFileSync(FILE, JSON.stringify(store, null, 2), { mode: 0o600 })
}

export class ChatChannelsService {
  private store: ChatChannelsStore = load()

  list(): readonly ChatChannelConfig[] {
    return this.store.channels
  }

  get(platform: string): ChatChannelConfig | undefined {
    return this.store.channels.find((channel) => channel.platform === platform)
  }

  spec(platform: string): ChatPlatformSpec | undefined {
    return CHAT_PLATFORMS.find((item) => item.id === platform)
  }

  connect(platform: string, credentials: Record<string, string>, webhookSecret?: string): ChatChannelConfig {
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
    }
    const channels = this.store.channels.filter((channel) => channel.platform !== platform)
    this.store = { channels: [...channels, next] }
    save(this.store)
    return next
  }

  disconnect(platform: string): boolean {
    const channels = this.store.channels.filter((channel) => channel.platform !== platform)
    if (channels.length === this.store.channels.length) return false
    this.store = { channels }
    save(this.store)
    return true
  }

  setEnabled(platform: string, enabled: boolean): ChatChannelConfig | undefined {
    const channel = this.get(platform)
    if (channel === undefined) return undefined
    const next = { ...channel, enabled }
    const channels = this.store.channels.map((item) => (item.platform === platform ? next : item))
    this.store = { channels }
    save(this.store)
    return next
  }

  recordMessage(platform: string): void {
    const channel = this.get(platform)
    if (channel === undefined) return
    const next = { ...channel, lastMessageAt: Date.now(), messageCount: (channel.messageCount ?? 0) + 1 }
    const channels = this.store.channels.map((item) => (item.platform === platform ? next : item))
    this.store = { channels }
    save(this.store)
  }

  setError(platform: string, error: string): void {
    const channel = this.get(platform)
    if (channel === undefined) return
    const next = { ...channel, error }
    const channels = this.store.channels.map((item) => (item.platform === platform ? next : item))
    this.store = { channels }
    save(this.store)
  }

  clearError(platform: string): void {
    const channel = this.get(platform)
    if (channel === undefined) return
    const { error: _error, ...rest } = channel
    const channels = this.store.channels.map((item) => (item.platform === platform ? rest : item))
    this.store = { channels }
    save(this.store)
  }
}
