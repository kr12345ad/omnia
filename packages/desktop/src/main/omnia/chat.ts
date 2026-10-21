import { ipcMain } from "electron"
import { serverCall } from "./server-call"
import { enterpriseGuard } from "./enterprise"

function channelPath(platform: string): string {
  return `/v1/chat/channels/${encodeURIComponent(platform)}`
}

// The platform credentials never travel back: every handler answers with what
// the server's own summary carries, which names the fields a channel has set
// and none of their values.
export function registerChatIpcHandlers(): void {
  const guarded = (channel: string, listener: Parameters<typeof ipcMain.handle>[1]) =>
    ipcMain.handle(channel, enterpriseGuard("chatChannels", "Chat channels", listener))
  guarded("chat-platforms", async () => (await serverCall("/v1/chat/platforms", "GET")).platforms ?? [])
  guarded("chat-channels", async () => (await serverCall("/v1/chat/channels", "GET")).channels ?? [])
  guarded("chat-connect", async (_event, input: { platform: string; credentials: Record<string, string> }) => {
    const json = await serverCall("/v1/chat/channels", "POST", input)
    return json.channel
  })
  guarded("chat-disconnect", async (_event, platform: string) => {
    const json = await serverCall(channelPath(platform), "DELETE")
    return json.removed === true
  })
  guarded("chat-set-enabled", async (_event, platform: string, enabled: boolean) => {
    const json = await serverCall(channelPath(platform), "PATCH", { enabled })
    return json.channel
  })
}
