import { ipcMain } from "electron"
import { CONTROL_PLANE_SIGNED_OUT_MESSAGE, controlPlaneAuth, controlPlaneCall } from "./control-plane"

async function serverCall(path: string, method: "GET" | "POST" | "DELETE", body?: unknown): Promise<Record<string, unknown>> {
  // Superskills are served by the control plane the app is paired with, which is
  // the same one every other settings call uses. Reading OMNIA_SERVER_URL alone
  // only worked under the hosted stack, so the desktop app answered every
  // superskills-* request with "The Omnia Server is not running."
  if (controlPlaneAuth() !== undefined) return controlPlaneCall(path, method, body)
  const url = process.env.OMNIA_SERVER_URL
  const token = process.env.OMNIA_SERVER_TOKEN
  if (url === undefined || token === undefined) throw new Error(CONTROL_PLANE_SIGNED_OUT_MESSAGE)
  const response = await fetch(`${url}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  // A proxy error page, an empty body, or a truncated response is not JSON.
  // Report the HTTP status instead of surfacing an opaque SyntaxError from
  // response.json() that hides why the call failed.
  const parsed = await response.json().catch(() => undefined)
  const json = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined
  if (response.ok !== true || json?.ok !== true) {
    throw new Error(typeof json?.error === "string" ? json.error : `Request failed with HTTP ${response.status}.`)
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
