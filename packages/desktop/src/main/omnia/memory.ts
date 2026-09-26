import { ipcMain } from "electron"

async function serverCall(path: string, method: "GET" | "POST" | "DELETE", body?: unknown): Promise<Record<string, unknown>> {
  const url = process.env.OMNIA_SERVER_URL
  const token = process.env.OMNIA_SERVER_TOKEN
  if (url === undefined || token === undefined) throw new Error("The Omnia Server is not running.")
  const response = await fetch(`${url}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const json = (await response.json()) as Record<string, unknown>
  if (response.ok !== true || json.ok !== true) {
    throw new Error(typeof json.error === "string" ? json.error : `Request failed with HTTP ${response.status}.`)
  }
  return json
}

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
  ipcMain.handle("memories-list", async (_event, input?: MemoryListInput) => {
    const json = await serverCall(`/v1/memories${memoryQuery(input)}`, "GET")
    return json.memories ?? []
  })
  ipcMain.handle("memories-remove", async (_event, id: string) => {
    const json = await serverCall(`/v1/memories/${encodeURIComponent(id)}`, "DELETE")
    return json.removed === true
  })
  ipcMain.handle("memories-forget", async (_event, input: MemoryForgetInput) => {
    const json = await serverCall("/v1/memories/forget", "POST", input)
    return typeof json.removed === "number" ? json.removed : 0
  })
  ipcMain.handle("memories-stats", async () => (await serverCall("/v1/memories/stats", "GET")).stats ?? {})
}
