import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { timingSafeEqual } from "node:crypto"
import type { PeerLink } from "./link"

// Lets this device's own apps talk to a linked peer's session API as ordinary
// HTTP on loopback. The bearer token is deliberately separate from the peer
// link keys: the link authenticates the remote device, the token authorizes
// local callers to use the bridge this server exposes.
export interface LinkHttpServer {
  readonly url: string
  close(): Promise<void>
}

const MAX_BODY_BYTES = 16 * 1024 * 1024

function bearerToken(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return undefined
  return header.slice("Bearer ".length)
}

function authorized(request: IncomingMessage, token: string): boolean {
  const presented = bearerToken(request)
  if (presented === undefined || presented.length !== token.length) return false
  return timingSafeEqual(Buffer.from(presented), Buffer.from(token))
}

function readBody(request: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error("The request body is too large."))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on("end", () => {
      if (chunks.length === 0) resolve(undefined)
      else resolve(Buffer.concat(chunks).toString("utf8"))
    })
    request.on("error", reject)
  })
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) })
  response.end(body)
}

function forwardParams(request: IncomingMessage, url: URL, body: string | undefined): Record<string, unknown> {
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue
    const lower = name.toLowerCase()
    if (lower === "authorization" || lower === "cookie" || lower === "host" || lower === "connection") continue
    headers[lower] = Array.isArray(value) ? value.join(", ") : value
  }
  return {
    method: request.method ?? "GET",
    path: url.pathname,
    query: url.search,
    headers,
    ...(body === undefined ? {} : { body }),
  }
}

async function serveEventStream(
  link: PeerLink,
  request: IncomingMessage,
  response: ServerResponse,
  params: Record<string, unknown>,
): Promise<void> {
  const opened = await link.request<{ streamId: string }>("http/open-stream", params)
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })
  let closed = false
  request.on("close", () => {
    if (!closed) {
      closed = true
      void link.request("http/close-stream", { streamId: opened.streamId }).catch(() => undefined)
    }
  })
  try {
    for (;;) {
      const page = await link.request<{ chunks: string[]; done: boolean }>("http/stream-next", {
        streamId: opened.streamId,
        timeoutMs: 25000,
      })
      for (const chunk of page.chunks) response.write(Buffer.from(chunk, "base64"))
      if (page.done) break
    }
  } finally {
    if (!closed) {
      closed = true
      await link.request("http/close-stream", { streamId: opened.streamId }).catch(() => undefined)
    }
    response.end()
  }
}

async function serveRequest(link: PeerLink, token: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (!authorized(request, token)) {
    json(response, 401, { error: "The link token is missing or wrong." })
    return
  }
  const url = new URL(request.url ?? "/", "http://127.0.0.1")
  let body: string | undefined
  try {
    body = await readBody(request)
  } catch {
    json(response, 413, { error: "The request body is too large." })
    return
  }
  const params = forwardParams(request, url, body)
  try {
    if (request.headers.accept?.includes("text/event-stream") === true) {
      await serveEventStream(link, request, response, params)
      return
    }
    const result = await link.request<{ status: number; headers: Record<string, string>; body: string }>(
      "http/forward",
      params,
    )
    const headers: Record<string, string> = {}
    if (typeof result.headers?.["content-type"] === "string") headers["content-type"] = result.headers["content-type"]
    headers["content-length"] = String(Buffer.byteLength(result.body ?? "", "utf8"))
    response.writeHead(result.status, headers)
    response.end(result.body ?? "")
  } catch {
    if (!response.headersSent) json(response, 502, { error: "The peer link request failed." })
    else response.end()
  }
}

export async function startLinkHttpServer(link: PeerLink, options: { token: string }): Promise<LinkHttpServer> {
  if (options.token.length === 0) throw new Error("The link HTTP server needs a token.")
  const server: Server = createServer((request, response) => {
    void serveRequest(link, options.token, request, response)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("The link HTTP server did not bind.")
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  }
}
