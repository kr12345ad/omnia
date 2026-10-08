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

export type ControlPlaneRequestInit = {
  readonly body?: unknown
  readonly headers?: Record<string, string>
  /**
   * Statuses that carry an answer instead of a failure. `/v1/billing/check`
   * answers a refusal with 402, so the default "any non-2xx throws" rule would
   * turn a metered refusal into an exception.
   */
  readonly accept?: (status: number, ok: boolean) => boolean
}

/**
 * A failure the control plane reported, with the status that carried it.
 *
 * `name` stays `Error` so nothing a caller renders changes; the status is what
 * lets a caller tell "the server said no" apart from a dropped connection.
 */
export class ControlPlaneRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

export async function controlPlaneRequest(
  path: string,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  init: ControlPlaneRequestInit = {},
): Promise<{ readonly status: number; readonly json: Record<string, unknown> }> {
  const response = await fetchControlPlane(path, {
    method,
    headers: { ...(init.body === undefined ? {} : { "content-type": "application/json" }), ...init.headers },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
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
  const ok = response.ok && json.ok === true
  // The predicate is told whether the response was already ok, so an override
  // can widen what is accepted (a 402 refusal is a decision) instead of
  // silently replacing the ok-check and rejecting every successful response.
  const accept = init.accept ?? (() => ok)
  if (!accept(response.status, ok))
    throw new ControlPlaneRequestError(errorMessage(json, text, response.status), response.status)
  return { status: response.status, json }
}

export async function controlPlaneCall(
  path: string,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  body?: unknown,
): Promise<Record<string, unknown>> {
  return (await controlPlaneRequest(path, method, { body })).json
}

function errorMessage(json: Record<string, unknown>, text: string, status: number): string {
  if (typeof json.error === "string") return json.error
  if (isRecord(json.error) && typeof json.error.message === "string") return json.error.message
  const result = isRecord(json.result) ? json.result : undefined
  const resultError = result?.error
  if (typeof resultError === "string") return resultError
  if (isRecord(resultError) && typeof resultError.message === "string") return resultError.message
  if (typeof result?.message === "string") return result.message
  return text.length > 0 ? text.slice(0, 300) : `Request failed with HTTP ${status}.`
}
