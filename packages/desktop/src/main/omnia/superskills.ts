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

export function registerSuperskillIpcHandlers(): void {
  ipcMain.handle("superskills-list", async () => (await serverCall("/v1/superskills", "GET")).superskills ?? [])
  ipcMain.handle("superskills-get", async (_event, id: string) => {
    const json = await serverCall(`/v1/superskills/${encodeURIComponent(id)}`, "GET")
    return json.superskill
  })
  ipcMain.handle("superskills-save", async (_event, skill: unknown) => {
    const json = await serverCall("/v1/superskills", "POST", skill)
    return json.superskill
  })
  ipcMain.handle("superskills-remove", async (_event, id: string) => {
    const json = await serverCall(`/v1/superskills/${encodeURIComponent(id)}`, "DELETE")
    return json.removed === true
  })
  ipcMain.handle("superskills-call", async (_event, id: string, method: string, params: unknown) => {
    const json = await serverCall(`/v1/superskills/${encodeURIComponent(id)}/call`, "POST", {
      method,
      params,
      approve: true,
      approvedBy: "desktop",
    })
    return json.result
  })
}
