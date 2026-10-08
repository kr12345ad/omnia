// The headless execution client. The Omnia control plane is the billing and
// scheduling authority, but sessions live in the paired opencode server; this
// is the only place that speaks to it, over HTTP Basic auth on loopback.
//
// Nothing here decides entitlement or schedules anything: the server gate runs
// before any of these calls, exactly like the billing routes.

export interface OpenCodeRunnerConfig {
  readonly url: string
  readonly username: string
  readonly password: string
}

export function openCodeRunnerFromEnv(): OpenCodeRunnerConfig | undefined {
  const url = process.env.OMNIA_OPENCODE_URL?.trim()
  const password = process.env.OMNIA_OPENCODE_PASSWORD?.trim()
  if (url === undefined || url.length === 0 || password === undefined || password.length === 0) return undefined
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error("OMNIA_OPENCODE_URL must be a valid http(s) URL.")
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("OMNIA_OPENCODE_URL must be an http:// or https:// URL.")
  }
  return {
    url: url.replace(/\/+$/, ""),
    username: process.env.OMNIA_OPENCODE_USERNAME?.trim() || "opencode",
    password,
  }
}

export class OpenCodeError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = "OpenCodeError"
    this.status = status
  }
}

function authHeader(config: OpenCodeRunnerConfig): string {
  return `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`
}

async function call(
  config: OpenCodeRunnerConfig,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  timeoutMs = 30_000,
): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(`${config.url}${path}`, {
      method,
      headers: {
        authorization: authHeader(config),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    throw new OpenCodeError(0, error instanceof Error ? error.message : String(error))
  }
  const text = await response.text().catch(() => "")
  if (response.status === 401 || response.status === 403) {
    throw new OpenCodeError(response.status, "The paired opencode server rejected the runner credentials.")
  }
  if (!response.ok) {
    throw new OpenCodeError(response.status, `The paired opencode server answered HTTP ${response.status} for ${path}.`)
  }
  if (text.length === 0) return undefined
  try {
    return JSON.parse(text)
  } catch {
    throw new OpenCodeError(0, `The paired opencode server returned invalid JSON for ${path}.`)
  }
}

export interface SessionInfo {
  readonly id: string
  readonly title?: string
  readonly status?: { type?: string }
}

export async function createSession(config: OpenCodeRunnerConfig, title: string): Promise<SessionInfo> {
  const result = await call(config, "POST", "/session", { title })
  const info = asSession(result)
  if (info === undefined) throw new OpenCodeError(0, "The paired opencode server did not return the created session.")
  return info
}

export async function promptAsync(
  config: OpenCodeRunnerConfig,
  sessionId: string,
  parts: readonly { readonly type: "text"; readonly text: string }[],
): Promise<void> {
  await call(config, "POST", `/session/${encodeURIComponent(sessionId)}/prompt_async`, { parts })
}

export async function abortSession(config: OpenCodeRunnerConfig, sessionId: string): Promise<void> {
  await call(config, "POST", `/session/${encodeURIComponent(sessionId)}/abort`).catch(() => undefined)
}

export async function sessionStatus(
  config: OpenCodeRunnerConfig,
): Promise<Record<string, { readonly type?: string }>> {
  const result = await call(config, "GET", "/session/status")
  if (typeof result !== "object" || result === null || Array.isArray(result)) return {}
  return result as Record<string, { readonly type?: string }>
}

export async function sessionMessages(config: OpenCodeRunnerConfig, sessionId: string): Promise<unknown[]> {
  const result = await call(config, "GET", `/session/${encodeURIComponent(sessionId)}/message`)
  return Array.isArray(result) ? result : []
}

function asSession(value: unknown): SessionInfo | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const id = (value as { id?: unknown }).id
  if (typeof id !== "string" || id.length === 0) return undefined
  const title = (value as { title?: unknown }).title
  const status = (value as { status?: unknown }).status
  return {
    id,
    ...(typeof title === "string" ? { title } : {}),
    ...(typeof status === "object" && status !== null ? { status: status as { type?: string } } : {}),
  }
}
