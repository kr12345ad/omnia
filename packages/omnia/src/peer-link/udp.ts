import { createSocket, type Socket } from "node:dgram"
import type { DatagramTransport } from "./transport"

// UDP datagram transport for direct device links. Delivery is unordered and
// lossy by nature; encryption and reliability live in link.ts.
export class UdpTransport implements DatagramTransport {
  private constructor(
    private readonly socket: Socket,
    private readonly host: string,
    private readonly port: number,
  ) {}

  static async bind(host: string, port: number): Promise<UdpTransport> {
    const socket = createSocket("udp4")
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject)
      socket.bind(port, host, () => {
        socket.off("error", reject)
        resolve()
      })
    })
    socket.unref?.()
    const bound = socket.address()
    const boundPort = typeof bound === "object" && bound !== null ? bound.port : port
    return new UdpTransport(socket, host, boundPort)
  }

  get localAddress(): string {
    return `${this.host}:${this.port}`
  }

  send(to: string, data: Uint8Array): void {
    const separator = to.lastIndexOf(":")
    if (separator <= 0) return
    const host = to.slice(0, separator)
    const port = Number(to.slice(separator + 1))
    if (host.length === 0 || !Number.isFinite(port) || port <= 0 || port > 65535) return
    this.socket.send(data, port, host, () => undefined)
  }

  onDatagram(listener: (from: string, data: Uint8Array) => void): () => void {
    const handler = (data: Buffer, info: { address: string; port: number }) => {
      listener(`${info.address}:${info.port}`, new Uint8Array(data))
    }
    this.socket.on("message", handler)
    return () => {
      this.socket.off("message", handler)
    }
  }

  close(): void {
    this.socket.close()
  }
}
