import type { PeerLink } from "./link"

// The responder side of a direct device link: translates a small set of
// session HTTP operations into calls against this device's own session API.
// Peer authentication is the link itself (mutual device keys at handshake);
// nothing here invents a second credential scheme. Local credentials never
// leave this device: the bridge holds them, the peer never sees them.
export interface ForwardedRequest {
  readonly method: string
  readonly path: string
  readonly query: string
  readonly headers: Record<string, string>
  readonly body?: string
}

export interface ForwardedResponse {
  readonly status: number
  readonly headers: Record<string, string>
  readonly body: string
}

export interface StreamPage {
  readonly chunks: string[]
  readonly done: boolean
  readonly error?: string
}

// Bytes the local API hands back. The bridge normalizes everything to the
// string wire format before it crosses the link, because the link envelope is
// JSON and a raw Buffer would arrive as { type: "Buffer", data: [...] }.
export interface LocalSessionApi {
  forward(request: ForwardedRequest): Promise<{
    readonly status: number
    readonly headers: Record<string, string>
    readonly body: string | Uint8Array
  }>
  openStream(request: ForwardedRequest): Promise<{ streamId: string }>
  streamNext(
    streamId: string,
    timeoutMs: number,
  ): Promise<{ readonly chunks: readonly (string | Uint8Array)[]; readonly done: boolean; readonly error?: string }>
  closeStream(streamId: string): Promise<void>
}

// Mirrors the control plane body cap so a peer cannot push a larger payload
// through the link than the server would accept directly.
const MAX_FORWARD_BYTES = 16 * 1024 * 1024
const BASE64_CHUNK = /^[A-Za-z0-9+/=]*$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringField(params: Record<string, unknown>, name: string, required: boolean): string | undefined {
  const value = params[name]
  if (value === undefined) {
    if (required) throw new Error(`The link request needs a string ${name}.`)
    return undefined
  }
  if (typeof value !== "string") throw new Error(`The link request field ${name} must be a string.`)
  return value
}

function headersField(params: Record<string, unknown>): Record<string, string> {
  const value = params.headers ?? {}
  if (!isRecord(value)) throw new Error("The link request headers must be an object.")
  const headers: Record<string, string> = {}
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry !== "string") throw new Error(`The link header ${name} must be a string.`)
    headers[name.toLowerCase()] = entry
  }
  return headers
}

function forwardRequest(params: unknown): ForwardedRequest {
  if (!isRecord(params)) throw new Error("The link request must be an object.")
  const method = stringField(params, "method", true)!
  const path = stringField(params, "path", true)!
  if (!path.startsWith("/")) throw new Error("The link request path must be origin-relative.")
  const query = stringField(params, "query", false) ?? ""
  const headers = headersField(params)
  delete headers["authorization"]
  delete headers["cookie"]
  delete headers["host"]
  delete headers["connection"]
  delete headers["content-length"]
  delete headers["transfer-encoding"]
  delete headers["upgrade"]
  const body = stringField(params, "body", false)
  if (body !== undefined && Buffer.byteLength(body, "utf8") > MAX_FORWARD_BYTES) {
    throw new Error("The link request body is too large.")
  }
  return { method, path, query, headers, ...(body === undefined ? {} : { body }) }
}

function bodyToString(body: unknown): string {
  if (typeof body === "string") return body
  if (body instanceof Uint8Array) return Buffer.from(body).toString("utf8")
  if (isRecord(body) && body.type === "Buffer" && Array.isArray(body.data)) {
    return Buffer.from(body.data.filter((entry): entry is number => typeof entry === "number")).toString("utf8")
  }
  throw new Error("The local API returned a malformed body.")
}

function checkResponse(value: unknown): ForwardedResponse {
  if (!isRecord(value)) throw new Error("The local API returned a malformed response.")
  const status = value.status
  if (typeof status !== "number" || !Number.isInteger(status) || status < 200 || status > 599) {
    throw new Error("The local API returned a malformed status.")
  }
  const headers = value.headers
  if (!isRecord(headers)) throw new Error("The local API returned malformed headers.")
  const clean: Record<string, string> = {}
  for (const [name, entry] of Object.entries(headers)) {
    if (typeof entry !== "string") throw new Error("The local API returned a malformed header.")
    clean[name.toLowerCase()] = entry
  }
  return { status, headers: clean, body: bodyToString(value.body) }
}

function checkStreamId(params: unknown): string {
  if (!isRecord(params)) throw new Error("The link request must be an object.")
  const streamId = stringField(params, "streamId", true)!
  if (streamId.length === 0 || streamId.length > 256) throw new Error("The stream id is not valid.")
  return streamId
}

function chunkToBase64(entry: unknown): string {
  if (typeof entry === "string") {
    if (!BASE64_CHUNK.test(entry)) throw new Error("The local API returned malformed stream chunks.")
    return entry
  }
  if (entry instanceof Uint8Array) return Buffer.from(entry).toString("base64")
  if (isRecord(entry) && entry.type === "Buffer" && Array.isArray(entry.data)) {
    return Buffer.from(entry.data.filter((byte): byte is number => typeof byte === "number")).toString("base64")
  }
  throw new Error("The local API returned malformed stream chunks.")
}

function checkPage(value: unknown): StreamPage {
  if (!isRecord(value)) throw new Error("The local API returned a malformed stream page.")
  if (!Array.isArray(value.chunks)) throw new Error("The local API returned malformed stream chunks.")
  if (typeof value.done !== "boolean") throw new Error("The local API returned a malformed stream page.")
  if (value.error !== undefined && typeof value.error !== "string") {
    throw new Error("The local API returned a malformed stream error.")
  }
  return {
    chunks: value.chunks.map(chunkToBase64),
    done: value.done as boolean,
    ...(typeof value.error === "string" ? { error: value.error } : {}),
  }
}

// An oversized peer body never reaches the local API. It comes back as an
// ordinary 413 response so the caller's HTTP mapping stays total.
async function forwardOverLimit(
  params: unknown,
  run: (request: ForwardedRequest) => Promise<ForwardedResponse>,
): Promise<ForwardedResponse> {
  try {
    return await run(forwardRequest(params))
  } catch (error) {
    if (error instanceof Error && error.message === "The link request body is too large.") {
      return { status: 413, headers: {}, body: "The link request body is too large." }
    }
    throw error
  }
}

export function attachSessionBridge(link: PeerLink, api: LocalSessionApi): void {
  link.onRequest(async (method, params) => {
    switch (method) {
      case "http/forward":
        return forwardOverLimit(params, async (request) => checkResponse(await api.forward(request)))
      case "http/open-stream": {
        const streamId = await api.openStream(forwardRequest(params))
        if (!isRecord(streamId) || typeof streamId.streamId !== "string") {
          throw new Error("The local API returned a malformed stream id.")
        }
        return { streamId: streamId.streamId }
      }
      case "http/stream-next": {
        if (!isRecord(params)) throw new Error("The link request must be an object.")
        const timeout = params.timeoutMs ?? 25000
        if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout < 0 || timeout > 60000) {
          throw new Error("The stream timeout is not valid.")
        }
        return checkPage(await api.streamNext(checkStreamId(params), timeout))
      }
      case "http/close-stream":
        await api.closeStream(checkStreamId(params))
        return {}
      default:
        throw new Error(`Unknown link operation: ${method}.`)
    }
  })
}
