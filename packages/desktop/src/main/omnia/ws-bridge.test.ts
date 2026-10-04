import { describe, expect, test } from "bun:test"
import { connect } from "node:net"
import type { Socket } from "node:net"
import { startWebSocketBridge } from "./ws-bridge"

function nextMessage(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve) => {
    socket.addEventListener(
      "message",
      (event) => resolve(JSON.parse(String(event.data))),
      { once: true },
    )
  })
}

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true })
    socket.addEventListener("error", () => reject(new Error("The test socket failed to open.")), { once: true })
  })
}

// Bun's client always masks and never fragments, so the framing rules the bridge
// enforces (client frames must be masked, a continuation must follow a
// fragmented message, accumulated fragments are capped) are driven over a raw
// socket with hand-built frames.
function upgrade(endpoint: string, token: string): Promise<Socket> {
  const { port } = new URL(endpoint)
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port: Number(port) })
    let handshake = ""
    const onData = (chunk: Buffer) => {
      handshake += chunk.toString("latin1")
      const end = handshake.indexOf("\r\n\r\n")
      if (end < 0) return
      socket.off("data", onData)
      if (!handshake.startsWith("HTTP/1.1 101")) {
        socket.destroy()
        reject(new Error("The bridge refused the upgrade."))
        return
      }
      resolve(socket)
    }
    socket.on("data", onData)
    socket.on("error", reject)
    socket.on("connect", () => {
      socket.write(
        [
          `GET /?token=${token} HTTP/1.1`,
          `Host: 127.0.0.1:${port}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Version: 13",
          "",
          "",
        ].join("\r\n"),
      )
    })
  })
}

function frame(opcode: number, payload: Buffer, options: { fin?: boolean; masked?: boolean } = {}): Buffer {
  const fin = options.fin ?? true
  const masked = options.masked ?? true
  const mask = Buffer.from([1, 2, 3, 4])
  const length = payload.length
  const header = Buffer.alloc(masked ? 6 : 2)
  header[0] = (fin ? 0x80 : 0) | opcode
  header[1] = (masked ? 0x80 : 0) | length
  if (!masked) return Buffer.concat([header, payload])
  header.writeUInt32BE(0x01020304, 2)
  const body = Buffer.from(payload)
  for (let index = 0; index < body.length; index += 1) body[index] = body[index]! ^ mask[index % 4]!
  return Buffer.concat([header, body])
}

function ended(socket: Socket): Promise<void> {
  return new Promise((resolve) => {
    if (socket.destroyed) {
      resolve()
      return
    }
    socket.on("close", () => resolve())
    socket.on("end", () => resolve())
  })
}

describe("websocket bridge", () => {
  test("authenticates, routes client messages, and broadcasts events", async () => {
    const received: unknown[] = []
    const bridge = await startWebSocketBridge({
      token: "test-token",
      onMessage: (client, message) => {
        received.push(message)
        client.send({ echo: message })
      },
    })
    const socket = new WebSocket(`${bridge.endpoint}/?token=test-token`)
    const first = nextMessage(socket)
    await opened(socket)
    socket.send(JSON.stringify({ id: 1, method: "Omnia.tabs", params: {} }))

    expect(await first).toEqual({ echo: { id: 1, method: "Omnia.tabs", params: {} } })
    expect(received).toEqual([{ id: 1, method: "Omnia.tabs", params: {} }])

    const broadcast = nextMessage(socket)
    bridge.broadcast({ method: "Page.loadEventFired", params: { timestamp: 1 } })
    expect(await broadcast).toEqual({ method: "Page.loadEventFired", params: { timestamp: 1 } })

    socket.close()
    await bridge.close()
  })

  test("frames large payloads across the 16-bit length path", async () => {
    const bridge = await startWebSocketBridge({
      token: "test-token",
      onMessage: (client, message) => client.send({ size: (message as { payload?: string }).payload?.length ?? 0 }),
    })
    const socket = new WebSocket(`${bridge.endpoint}/?token=test-token`)
    await opened(socket)

    const large = "x".repeat(70_000)
    const reply = nextMessage(socket)
    socket.send(JSON.stringify({ payload: large }))
    expect(await reply).toEqual({ size: 70_000 })

    socket.close()
    await bridge.close()
  })

  test("rejects an invalid token", async () => {
    const bridge = await startWebSocketBridge({ token: "test-token", onMessage: () => undefined })
    const result = await new Promise<string>((resolve) => {
      const socket = new WebSocket(`${bridge.endpoint}/?token=wrong`)
      socket.addEventListener("open", () => resolve("open"), { once: true })
      socket.addEventListener("error", () => resolve("error"), { once: true })
      socket.addEventListener("close", () => resolve("error"), { once: true })
    })
    expect(result).toBe("error")
    await bridge.close()
  })

  test("refuses an unmasked client frame", async () => {
    const received: unknown[] = []
    const bridge = await startWebSocketBridge({
      token: "test-token",
      onMessage: (_client, message) => received.push(message),
    })
    const socket = await upgrade(bridge.endpoint, "test-token")
    const closed = ended(socket)
    socket.write(frame(0x1, Buffer.from(JSON.stringify({ id: 1, method: "Omnia.tabs" })), { masked: false }))
    await closed
    expect(received).toEqual([])
    socket.destroy()
    await bridge.close()
  })

  test("refuses a continuation frame that follows no fragmented message", async () => {
    const received: unknown[] = []
    const bridge = await startWebSocketBridge({
      token: "test-token",
      onMessage: (_client, message) => received.push(message),
    })
    const socket = await upgrade(bridge.endpoint, "test-token")
    const closed = ended(socket)
    socket.write(frame(0x0, Buffer.from(JSON.stringify({ id: 1, method: "Omnia.tabs" }))))
    await closed
    expect(received).toEqual([])
    socket.destroy()
    await bridge.close()
  })

  test("caps the accumulated bytes of one fragmented message", async () => {
    const received: unknown[] = []
    const bridge = await startWebSocketBridge({
      token: "test-token",
      onMessage: (_client, message) => received.push(message),
    })
    const socket = await upgrade(bridge.endpoint, "test-token")
    const closed = ended(socket)
    const chunk = Buffer.alloc(2 * 1024 * 1024, 0x61)
    // Every frame is under the per-frame cap, so only the running total closes
    // the connection: five 2 MiB fragments pass 8 MiB.
    socket.write(frame(0x1, chunk, { fin: false }))
    for (let index = 0; index < 4; index += 1) {
      if (socket.destroyed) break
      socket.write(frame(0x0, chunk, { fin: index === 3 }))
    }
    await closed
    expect(received).toEqual([])
    socket.destroy()
    await bridge.close()
  })

  test("delivers a fragmented message inside the cap", async () => {
    const received: unknown[] = []
    const bridge = await startWebSocketBridge({
      token: "test-token",
      onMessage: (_client, message) => received.push(message),
    })
    const socket = await upgrade(bridge.endpoint, "test-token")
    socket.write(frame(0x1, Buffer.from('{"id":1,'), { fin: false }))
    socket.write(frame(0x0, Buffer.from('"method":"Omnia.tabs"}')))
    await waitUntil(() => received.length === 1)
    expect(received[0]).toEqual({ id: 1, method: "Omnia.tabs" })
    socket.destroy()
    await bridge.close()
  })
})

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("The test condition was not met in time.")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
