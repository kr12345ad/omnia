export type ChatModel = {
  id: string
  providerID: string
  name: string
  family?: string
  api?: {
    id?: string
    type: string
    package?: string
    url?: string
  }
}

export type ChatSession = {
  id: string
  title: string
  agent?: string
  time: { created: number; updated: number; archived?: number }
  model?: { id: string; providerID: string; variant?: string }
}

export type ChatEvent = {
  id: string
  type: string
  data?: Record<string, unknown>
}

export type RenderedMessage = {
  id: string
  role: "user" | "assistant"
  text: string
  createdAt: number
  error?: string
}

export class ChatApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

type Fetch = typeof globalThis.fetch

export class ChatApi {
  private readonly fetch: Fetch
  private readonly headers: Record<string, string>
  private readonly baseUrl: string

  constructor(input: { baseUrl: string; headers?: Record<string, string>; fetch?: Fetch }) {
    this.fetch = input.fetch ?? globalThis.fetch
    this.headers = input.headers ?? {}
    // A hosted server can live under a path prefix (for example /test1/omnia),
    // so every request is resolved against that prefix rather than the origin.
    this.baseUrl = input.baseUrl.replace(/\/+$/, "")
  }

  async location() {
    return this.request<{ directory: string }>("GET", "/api/location")
  }

  async models(directory: string) {
    const result = await this.request<{ data: ChatModel[] }>("GET", withQuery("/api/model", { directory }))
    // The v2 session runner executes AI SDK routes only. Native catalog models
    // can still be listed by the server, but selecting one would fail every
    // prompt with "Unsupported API", so keep them out of the chat picker.
    return result.data.filter(chatRunnable)
  }

  async sessions(directory: string) {
    const result = await this.request<{ data: ChatSession[] }>(
      "GET",
      withQuery("/api/session", { directory, limit: "200", order: "desc" }),
    )
    // The chat page shares a server with the full workspace, so its history
    // must never surface a session that another agent can use tools in. Archived
    // chats stay out of the recent list just like they do in the full app.
    return result.data.filter((session) => session.agent === "chat" && !session.time.archived)
  }

  async createSession(input: { directory: string; model: { id: string; providerID: string } }) {
    const result = await this.request<{ data: ChatSession }>("POST", "/api/session", {
      agent: "chat",
      model: input.model,
      location: { directory: input.directory },
    })
    return result.data
  }

  async messages(sessionID: string) {
    // Read the newest page, then restore ascending order for rendering. The
    // endpoint's asc page is the oldest 200 messages, which would hide the
    // recent conversation once a chat grows past that page.
    const result = await this.request<{ data: unknown[] }>(
      "GET",
      withQuery(`/api/session/${encodeURIComponent(sessionID)}/message`, { limit: "200", order: "desc" }),
    )
    return [...result.data].reverse()
  }

  async prompt(sessionID: string, text: string) {
    await this.request("POST", `/api/session/${encodeURIComponent(sessionID)}/prompt`, { prompt: { text } })
  }

  async switchModel(sessionID: string, model: { id: string; providerID: string }) {
    await this.request("POST", `/api/session/${encodeURIComponent(sessionID)}/model`, { model })
  }

  // Titles live on the shared `session` row, and the v2 protocol has no title
  // endpoint yet. The legacy update route is the supported writer for that
  // column; it resolves the same row by id and needs the location header.
  async rename(sessionID: string, title: string, directory: string) {
    await this.request(
      "PATCH",
      `/session/${encodeURIComponent(sessionID)}`,
      { title },
      { "x-opencode-directory": directory },
    )
  }

  async interrupt(sessionID: string) {
    await this.request("POST", `/api/session/${encodeURIComponent(sessionID)}/interrupt`)
  }

  async active() {
    const result = await this.request<{ data: Record<string, { type: string }> }>("GET", "/api/session/active")
    return result.data
  }

  events(signal: AbortSignal) {
    return this.stream("/api/event", signal)
  }

  private async *stream(path: string, signal: AbortSignal) {
    const response = await this.fetch(this.url(path), {
      method: "GET",
      headers: { accept: "text/event-stream", ...this.headers },
      signal,
    })
    if (!response.ok) throw await errorFrom(response)
    yield* readSse(response)
  }

  private async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const response = await this.fetch(this.url(path), {
      method,
      headers: {
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...this.headers,
        ...extraHeaders,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!response.ok) throw await errorFrom(response)
    if (response.status === 204) return undefined as T
    return (await response.json()) as T
  }

  private url(path: string) {
    return new URL(path.replace(/^\/+/, ""), `${this.baseUrl}/`)
  }
}

export async function* readSse(response: Response): AsyncGenerator<ChatEvent> {
  if (!response.body) throw new ChatApiError(response.status, "The event stream is unavailable.")
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  try {
    while (true) {
      const next = await reader.read()
      buffer += decoder.decode(next.value, { stream: !next.done })
      buffer = buffer.replaceAll("\r\n", "\n")
      if (next.done && buffer.length > 0) buffer += "\n\n"

      let boundary = buffer.indexOf("\n\n")
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const data = block
          .split("\n")
          .flatMap((line) => (line.startsWith("data:") ? [line.slice(5).trimStart()] : []))
          .join("\n")
        if (data) {
          const parsed = parseEvent(data)
          if (parsed) yield parsed
        }
        boundary = buffer.indexOf("\n\n")
      }
      if (next.done) return
    }
  } finally {
    try {
      await reader.cancel()
    } catch {}
    reader.releaseLock()
  }
}

export function chatRunnable(model: ChatModel) {
  if (model.api?.type !== "aisdk") return false
  if (model.api.package === "@ai-sdk/openai" || model.api.package === "@ai-sdk/anthropic") return true
  return model.api.package === "@ai-sdk/openai-compatible" && model.api.url !== undefined
}

export function chatTitle(text: string) {
  const line = text
    .trim()
    .split(/\r?\n/, 1)[0]
    ?.replace(/\s+/g, " ")
    .trim()
  if (!line) return
  return line.length > 60 ? `${line.slice(0, 57)}...` : line
}

export function toRenderedMessages(input: unknown[]): RenderedMessage[] {
  return input.flatMap((item): RenderedMessage[] => {
    if (!isRecord(item) || typeof item.id !== "string") return []
    const createdAt = isRecord(item.time) && typeof item.time.created === "number" ? item.time.created : 0

    if (item.type === "user" && typeof item.text === "string") {
      return item.text.trim() ? [{ id: item.id, role: "user", text: item.text, createdAt }] : []
    }

    if (item.type !== "assistant") return []
    const content = Array.isArray(item.content) ? item.content : []
    const text = content
      .flatMap((part) => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []))
      .join("")
    const error =
      isRecord(item.error) && typeof item.error.message === "string" ? item.error.message : undefined
    if (!text.trim() && !error) return []
    return [{ id: item.id, role: "assistant", text, createdAt, error }]
  })
}

/**
 * Deltas arrive before the durable message list catches up. Keep the longer
 * copy for each assistant message and append a bubble for a live message that
 * has not been listed yet.
 */
export function mergeLive(messages: RenderedMessage[], live: Record<string, string>): RenderedMessage[] {
  const ids = new Set(messages.map((message) => message.id))
  const merged = messages.map((message) => {
    const text = live[message.id]
    if (!text || message.role !== "assistant") return message
    // A refresh can land between two deltas. The live map then holds only the
    // suffix that arrived after the durable copy, so append it instead of
    // comparing lengths. When the live stream already contains the durable
    // prefix (the normal case), it is the complete copy.
    if (text.startsWith(message.text) || text.endsWith(message.text)) return { ...message, text }
    if (message.text.startsWith(text) || message.text.endsWith(text)) return message
    return { ...message, text: message.text + text }
  })
  const pending = Object.entries(live)
    .filter(([id, text]) => !ids.has(id) && text.length > 0)
    .map(([id, text]) => ({ id, role: "assistant" as const, text, createdAt: 0 }))
  return [...merged, ...pending]
}

function parseEvent(data: string): ChatEvent | undefined {
  try {
    const value = JSON.parse(data)
    if (!isRecord(value) || typeof value.type !== "string") return
    return {
      id: typeof value.id === "string" ? value.id : "",
      type: value.type,
      data: isRecord(value.data) ? value.data : undefined,
    }
  } catch {
    return
  }
}

async function errorFrom(response: Response) {
  const text = await response.text().catch(() => "")
  const parsed = (() => {
    try {
      return JSON.parse(text) as unknown
    } catch {
      return undefined
    }
  })()
  const message =
    (isRecord(parsed) && typeof parsed.message === "string" && parsed.message) ||
    (isRecord(parsed) && typeof parsed.error === "string" && parsed.error) ||
    (isRecord(parsed) && typeof parsed._tag === "string" && parsed._tag) ||
    (response.status === 401 ? "This chat server requires an auth token." : "") ||
    response.statusText ||
    "The chat server rejected the request."
  return new ChatApiError(response.status, message)
}

function withQuery(path: string, query: Record<string, string | undefined>) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, value)
  }
  if (query.directory !== undefined && path === "/api/model") {
    params.delete("directory")
    params.set("location[directory]", query.directory)
  }
  return params.size ? `${path}?${params}` : path
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
