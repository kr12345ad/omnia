// Minimal RFC6455 WebSocket server for the embedded browser CDP bridge. The
// bridge binds loopback only and authenticates every upgrade with a shared
// token, so the framing support intentionally stops at text messages, control
// frames, and continuation frames.

import { createHash, timingSafeEqual } from "node:crypto"
import { createServer } from "node:http"
import type { IncomingMessage } from "node:http"
import type { Duplex } from "node:stream"

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024

export interface WebSocketBridgeClient {
  send(message: unknown): void
  close(): void
}

export interface WebSocketBridgeOptions {
  readonly token: string
  readonly onMessage: (client: WebSocketBridgeClient, message: unknown) => void
  readonly onClose?: (client: WebSocketBridgeClient) => void
}

export interface WebSocketBridge {
  readonly endpoint: string
  readonly clients: number
  broadcast(message: unknown): void
  close: () => Promise<void>
}

interface WebSocketFrame {
  readonly fin: boolean
  readonly opcode: number
  readonly payload: Buffer
  readonly size: number
}

export async function startWebSocketBridge(options: WebSocketBridgeOptions): Promise<WebSocketBridge> {
  const open = new Set<BridgeConnection>()
  const server = createServer((_request, response) => {
    response.writeHead(426, { "content-type": "text/plain" })
    response.end("WebSocket upgrade required.")
  })
  server.on("upgrade", (request, socket) => {
    if (!authorized(request, options.token)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n")
      socket.destroy()
      return
    }
    const key = request.headers["sec-websocket-key"]
    if (typeof key !== "string" || request.headers.upgrade?.toLowerCase() !== "websocket") {
      socket.destroy()
      return
    }
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${createHash("sha1").update(key + WEBSOCKET_GUID).digest("base64")}`,
        "",
        "",
      ].join("\r\n"),
    )
    const connection = new BridgeConnection(socket, options, () => open.delete(connection))
    open.add(connection)
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("The browser bridge did not bind a port.")
  return {
    endpoint: `ws://127.0.0.1:${address.port}`,
    get clients() {
      return open.size
    },
    broadcast(message: unknown) {
      const payload = JSON.stringify(message)
      for (const connection of open) connection.sendRaw(payload)
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const connection of open) connection.close()
        server.close(() => resolve())
      }),
  }
}

class BridgeConnection implements WebSocketBridgeClient {
  private buffer: Buffer = Buffer.alloc(0)
  private fragments: Buffer[] = []
  private fragmentOpcode: number | undefined
  // Running total of the buffered fragment bytes. The per-frame cap in
  // decodeFrame cannot stop a peer from streaming continuation frames forever,
  // so the accumulated message is bounded too.
  private fragmentBytes = 0
  private closed = false

  constructor(
    private readonly socket: Duplex,
    private readonly options: WebSocketBridgeOptions,
    private readonly onGone: () => void,
  ) {
    socket.on("data", (chunk: Buffer | string) => this.receive(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    socket.on("error", () => this.terminate())
    socket.on("close", () => this.terminate())
  }

  send(message: unknown): void {
    this.sendRaw(JSON.stringify(message))
  }

  sendRaw(payload: string): void {
    if (this.closed) return
    try {
      this.socket.write(encodeFrame(Buffer.from(payload, "utf8"), 0x1))
    } catch {
      this.terminate()
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.socket.end(encodeFrame(Buffer.alloc(0), 0x8))
    } catch {
      this.socket.destroy()
    }
    this.onGone()
  }

  private terminate(): void {
    if (this.closed) return
    this.closed = true
    this.socket.destroy()
    this.onGone()
  }

  private receive(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    while (!this.closed) {
      let frame: WebSocketFrame | undefined
      try {
        frame = decodeFrame(this.buffer)
      } catch {
        this.close()
        return
      }
      if (frame === undefined) return
      this.buffer = this.buffer.subarray(frame.size)
      this.handleFrame(frame)
    }
  }

  private handleFrame(frame: WebSocketFrame): void {
    if (frame.opcode === 0x8) {
      this.close()
      return
    }
    if (frame.opcode === 0x9) {
      if (!this.closed) this.socket.write(encodeFrame(frame.payload, 0xa))
      return
    }
    if (frame.opcode === 0xa) return
    // A continuation frame only ever follows a fragmented text or binary
    // message; a bare 0x0 would otherwise be concatenated and delivered as a
    // message of its own.
    if (frame.opcode === 0x0) {
      if (this.fragmentOpcode === undefined) {
        this.close()
        return
      }
      this.fragmentBytes += frame.payload.length
      if (this.fragmentBytes > MAX_PAYLOAD_BYTES) {
        this.close()
        return
      }
      this.fragments.push(frame.payload)
      if (!frame.fin) return
      const opcode = this.fragmentOpcode
      const payload = Buffer.concat(this.fragments)
      this.fragments = []
      this.fragmentOpcode = undefined
      this.fragmentBytes = 0
      if (opcode === 0x1) this.deliver(payload)
      return
    }
    if (frame.opcode === 0x1 || frame.opcode === 0x2) {
      // A new message interrupts an unfinished one: the old fragments are
      // dropped instead of being glued onto a different message.
      if (this.fragmentOpcode !== undefined) {
        this.fragments = []
        this.fragmentOpcode = undefined
        this.fragmentBytes = 0
      }
      if (!frame.fin) {
        this.fragmentOpcode = frame.opcode
        this.fragments = [frame.payload]
        this.fragmentBytes = frame.payload.length
        return
      }
      if (frame.opcode === 0x1) this.deliver(frame.payload)
    }
  }

  private deliver(payload: Buffer): void {
    let message: unknown
    try {
      message = JSON.parse(payload.toString("utf8"))
    } catch {
      return
    }
    this.options.onMessage(this, message)
  }
}

function encodeFrame(payload: Buffer, opcode: number): Buffer {
  const length = payload.length
  const header = length < 126 ? Buffer.alloc(2) : length < 65536 ? Buffer.alloc(4) : Buffer.alloc(10)
  header[0] = 0x80 | opcode
  if (length < 126) {
    header[1] = length
  } else if (length < 65536) {
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  return Buffer.concat([header, payload])
}

function decodeFrame(buffer: Buffer): WebSocketFrame | undefined {
  if (buffer.length < 2) return undefined
  const first = buffer[0]!
  const second = buffer[1]!
  const fin = (first & 0x80) !== 0
  const opcode = first & 0x0f
  const masked = (second & 0x80) !== 0
  // RFC6455 requires every client-to-server frame to be masked. The bridge only
  // ever speaks to browser clients, so an unmasked frame is a protocol
  // violation and is refused rather than accepted as a raw payload.
  if (!masked) throw new Error("unmasked_client_frame")
  let length = second & 0x7f
  let offset = 2
  if (length === 126) {
    if (buffer.length < 4) return undefined
    length = buffer.readUInt16BE(2)
    offset = 4
  } else if (length === 127) {
    if (buffer.length < 10) return undefined
    const big = buffer.readBigUInt64BE(2)
    if (big > BigInt(MAX_PAYLOAD_BYTES)) throw new Error("payload_too_large")
    length = Number(big)
    offset = 10
  }
  if (length > MAX_PAYLOAD_BYTES) throw new Error("payload_too_large")
  if (buffer.length < offset + 4) return undefined
  const maskKey = buffer.subarray(offset, offset + 4)
  offset += 4
  if (buffer.length < offset + length) return undefined
  const payload = Buffer.from(buffer.subarray(offset, offset + length))
  for (let index = 0; index < payload.length; index += 1) {
    payload[index] = payload[index]! ^ maskKey[index % 4]!
  }
  return { fin, opcode, payload, size: offset + length }
}

function authorized(request: IncomingMessage, token: string): boolean {
  if (token.length === 0) return false
  const url = new URL(request.url ?? "/", "http://127.0.0.1")
  const supplied = url.searchParams.get("token")
  if (supplied === null) return false
  const expected = Buffer.from(token, "utf8")
  const received = Buffer.from(supplied, "utf8")
  if (expected.length !== received.length) return false
  return timingSafeEqual(expected, received)
}
