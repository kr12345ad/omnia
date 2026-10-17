// Catalog of chat platforms Omnia can connect to through the Vercel Chat SDK
// (vendored under packages/omnia/vendor/chat-sdk). Each entry describes the
// credentials the platform needs and whether it can run without a public URL.

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
  readonly polling: boolean
  readonly fields: readonly ChatPlatformField[]
  readonly webhookPath: string
  readonly docs: string
}

export const CHAT_PLATFORMS: readonly ChatPlatformSpec[] = [
  {
    id: "slack",
    name: "Slack",
    description: "Mentions and subscribed threads in Slack channels and DMs.",
    polling: false,
    fields: [
      { key: "botToken", label: "Bot token", secret: true, required: true, hint: "xoxb-..." },
      { key: "signingSecret", label: "Signing secret", secret: true, required: true },
      { key: "appId", label: "App ID", required: false },
    ],
    webhookPath: "/v1/chat/slack/webhook",
    docs: "https://chat-sdk.dev/docs/adapters/slack",
  },
  {
    id: "telegram",
    name: "Telegram",
    description: "Private chats and groups via long polling (no public URL needed).",
    polling: true,
    fields: [
      { key: "botToken", label: "Bot token", secret: true, required: true, hint: "From @BotFather" },
      { key: "webhookSecret", label: "Webhook secret", secret: true, required: false },
    ],
    webhookPath: "/v1/chat/telegram/webhook",
    docs: "https://chat-sdk.dev/docs/adapters/telegram",
  },
  {
    id: "teams",
    name: "Microsoft Teams",
    description: "Mentions and subscribed threads in Teams channels.",
    polling: false,
    fields: [
      { key: "appId", label: "App ID", required: true },
      { key: "appPassword", label: "App password", secret: true, required: true },
      { key: "tenantId", label: "Tenant ID", required: false },
    ],
    webhookPath: "/v1/chat/teams/webhook",
    docs: "https://chat-sdk.dev/docs/adapters/teams",
  },
  {
    id: "gchat",
    name: "Google Chat",
    description: "Mentions and subscribed spaces in Google Chat.",
    polling: false,
    fields: [
      { key: "credentials", label: "Service account JSON", secret: true, required: true },
      {
        key: "audience",
        label: "Webhook audience",
        required: true,
        hint: "The Chat app's authentication audience: its endpoint URL or project number",
      },
      { key: "projectId", label: "Project ID", required: false },
    ],
    webhookPath: "/v1/chat/gchat/webhook",
    docs: "https://chat-sdk.dev/docs/adapters/gchat",
  },
  {
    id: "discord",
    name: "Discord",
    description: "Mentions and subscribed threads (long polling via gateway).",
    polling: true,
    fields: [
      { key: "botToken", label: "Bot token", secret: true, required: true },
      { key: "publicKey", label: "Public key", required: false },
      { key: "applicationId", label: "Application ID", required: false },
    ],
    webhookPath: "/v1/chat/discord/webhook",
    docs: "https://chat-sdk.dev/docs/adapters/discord",
  },
  {
    id: "github",
    name: "GitHub",
    description: "Issue and PR comment mentions.",
    polling: false,
    fields: [
      { key: "token", label: "Personal access token", secret: true, required: true },
      { key: "webhookSecret", label: "Webhook secret", secret: true, required: false },
    ],
    webhookPath: "/v1/chat/github/webhook",
    docs: "https://chat-sdk.dev/docs/adapters/github",
  },
  {
    id: "linear",
    name: "Linear",
    description: "Issue comment mentions.",
    polling: false,
    fields: [
      { key: "apiKey", label: "API key", secret: true, required: true },
      { key: "webhookSecret", label: "Webhook secret", secret: true, required: false },
    ],
    webhookPath: "/v1/chat/linear/webhook",
    docs: "https://chat-sdk.dev/docs/adapters/linear",
  },
  {
    id: "whatsapp",
    name: "WhatsApp",
    description: "Direct messages via the WhatsApp Business API.",
    polling: false,
    fields: [
      { key: "accessToken", label: "Access token", secret: true, required: true },
      { key: "phoneNumberId", label: "Phone number ID", required: true },
      { key: "verifyToken", label: "Verify token", secret: true, required: true },
    ],
    webhookPath: "/v1/chat/whatsapp/webhook",
    docs: "https://chat-sdk.dev/docs/adapters/whatsapp",
  },
]

export function chatPlatformSpec(id: string): ChatPlatformSpec | undefined {
  return CHAT_PLATFORMS.find((platform) => platform.id === id)
}
