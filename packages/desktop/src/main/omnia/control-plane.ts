import { readControlPlaneUrl } from "./remote-agent"
import { readAuthSession, type ControlPlaneAuth } from "./auth-session"

export { readAuthSession }
export type { ControlPlaneAuth }

export const CONTROL_PLANE_SIGNED_OUT_MESSAGE =
  "Sign in to Omnia and configure the control plane before using computer control."

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function controlPlaneAuth(): ControlPlaneAuth | undefined {
  const session = readAuthSession()
  if (session === undefined) return undefined
  const url = readControlPlaneUrl() ?? session.url
  return { url: url.replace(/\/+$/, ""), clientToken: session.clientToken }
}

export function isReady(): boolean {
  return controlPlaneAuth() !== undefined
}

export async function fetchControlPlane(path: string, init: RequestInit = {}): Promise<Response> {
  const auth = controlPlaneAuth()
  if (auth === undefined) throw new Error(CONTROL_PLANE_SIGNED_OUT_MESSAGE)
  const headers = new Headers(init.headers)
  headers.set("authorization", `Bearer ${auth.clientToken}`)
  return fetch(`${auth.url}${path.startsWith("/") ? path : `/${path}`}`, { ...init, headers })
}

export async function controlPlaneCall(
  path: string,
  method: "GET" | "POST" | "DELETE",
  body?: unknown,
): Promise<Record<string, unknown>> {
  const response = await fetchControlPlane(path, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(300000),
  })
  const text = await response.text()
  let json: Record<string, unknown> = {}
  try {
    const parsed: unknown = text.length === 0 ? {} : JSON.parse(text)
    if (isRecord(parsed)) json = parsed
  } catch {
    json = {}
  }
  if (!response.ok || json.ok !== true) throw new Error(errorMessage(json, text, response.status))
  return json
}

function errorMessage(json: Record<string, unknown>, text: string, status: number): string {
  if (typeof json.error === "string") return json.error
  const result = isRecord(json.result) ? json.result : undefined
  const resultError = result?.error
  if (typeof resultError === "string") return resultError
  if (isRecord(resultError) && typeof resultError.message === "string") return resultError.message
  if (typeof result?.message === "string") return result.message
  return text.length > 0 ? text.slice(0, 300) : `Request failed with HTTP ${status}.`
}
