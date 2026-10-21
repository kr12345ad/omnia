import { ipcMain } from "electron"
import { serverCall } from "./server-call"
import { enterpriseGuard } from "./enterprise"

type MemoryListInput = { query?: string; scope?: string; application?: string; limit?: number }
type MemoryForgetInput = { query?: string; key?: string; scope?: string; application?: string }

function memoryQuery(input: MemoryListInput | undefined): string {
  const params = new URLSearchParams()
  if (input?.query) params.set("query", input.query)
  if (input?.scope) params.set("scope", input.scope)
  if (input?.application) params.set("application", input.application)
  if (input?.limit !== undefined) params.set("limit", String(input.limit))
  const query = params.toString()
  return query.length > 0 ? `?${query}` : ""
}

export function registerMemoryIpcHandlers(): void {
  const guarded = (channel: string, listener: Parameters<typeof ipcMain.handle>[1]) =>
    ipcMain.handle(channel, enterpriseGuard("memory", "Memory", listener))
  guarded("memories-list", async (_event, input?: MemoryListInput) => {
    const json = await serverCall(`/v1/memories${memoryQuery(input)}`, "GET")
    return json.memories ?? []
  })
  guarded("memories-remove", async (_event, id: string) => {
    const json = await serverCall(`/v1/memories/${encodeURIComponent(id)}`, "DELETE")
    return json.removed === true
  })
  guarded("memories-forget", async (_event, input: MemoryForgetInput) => {
    const json = await serverCall("/v1/memories/forget", "POST", input)
    return typeof json.removed === "number" ? json.removed : 0
  })
  guarded("memories-stats", async () => (await serverCall("/v1/memories/stats", "GET")).stats ?? {})
}
