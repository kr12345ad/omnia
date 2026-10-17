// Structural copy of packages/omnia/src/chat/platforms.ts and the runtime's
// summary; the app cannot import Omnia runtime code.

export interface ChatPlatformField {
  readonly key: string
  readonly label: string
  readonly secret?: boolean
  readonly required?: boolean
  readonly hint?: string
}

export interface ChatPlatformSpec {
  readonly id: string
  readonly name: string
  readonly description: string
  /** True when the platform runs over long polling and needs no public URL. */
  readonly polling: boolean
  readonly fields: readonly ChatPlatformField[]
  readonly webhookPath: string
  readonly docs: string
}

/**
 * A connected channel, without any credential value.
 *
 * `configured` names the fields that hold a value; the values themselves are
 * never sent to the renderer, so a credential can be written from this UI and
 * cannot be read back out of it.
 */
export interface ChatChannelSummary {
  readonly platform: string
  readonly enabled: boolean
  readonly configured: readonly string[]
  readonly connectedAt?: number
  readonly lastMessageAt?: number
  readonly messageCount?: number
  readonly error?: string
}

export interface ChatChannelInput {
  readonly platform: string
  readonly credentials: Readonly<Record<string, string>>
}

export interface ChatPlatform {
  platforms(): Promise<readonly ChatPlatformSpec[]>
  list(): Promise<readonly ChatChannelSummary[]>
  connect(input: ChatChannelInput): Promise<ChatChannelSummary>
  disconnect(platform: string): Promise<boolean>
  setEnabled(platform: string, enabled: boolean): Promise<ChatChannelSummary | undefined>
}

export function emptyCredentials(spec: ChatPlatformSpec): Record<string, string> {
  return Object.fromEntries(spec.fields.map((field) => [field.key, ""]))
}
