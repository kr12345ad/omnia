import { createSocket, type Socket } from "node:dgram"
import { networkInterfaces } from "node:os"
import type { LinkEndpoint } from "./link"

// A peer that only knows its own interfaces cannot learn the address the
// internet sees it at. This responder reports the observed source of a ping;
// it carries no identity, no session data, and answers nothing else. Deploy it
// only where unsolicited UDP is acceptable: replies are rate-limited per
// source because any open reflector can be abused for amplification.
export const DISCOVERY_PING = "OMNIA-DISCOVER"

export class TokenBucket {
  private tokens: number
  private lastRefill: number

  constructor(
    private readonly options: { capacity: number; refillPerMs: number },
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = options.capacity
    this.lastRefill = this.now()
  }

  take(): boolean {
    const at = this.now()
    this.tokens = Math.min(this.options.capacity, this.tokens + (at - this.lastRefill) * this.options.refillPerMs)
    this.lastRefill = at
    if (this.tokens < 1) return false
    this.tokens -= 1
    return true
  }
}

export interface DiscoveryResponder {
  readonly port: number
  close(): void
}

export async function startEndpointDiscoveryResponder(
  host: string,
  port: number,
  options: { maxRepliesPerMinute?: number } = {},
): Promise<DiscoveryResponder> {
  const budget = options.maxRepliesPerMinute ?? 60
  const buckets = new Map<string, TokenBucket>()
  const socket = createSocket("udp4")
  socket.on("message", (data, info) => {
    if (data.toString("utf8") !== DISCOVERY_PING) return
    let bucket = buckets.get(info.address)
    if (bucket === undefined) {
      bucket = new TokenBucket({ capacity: budget, refillPerMs: budget / 60000 })
      buckets.set(info.address, bucket)
    }
    if (!bucket.take()) return
    const reply = Buffer.from(JSON.stringify({ address: info.address, port: info.port }))
    socket.send(reply, info.port, info.address, () => undefined)
  })
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
  return {
    port: boundPort,
    close: () => {
      socket.close()
    },
  }
}

export async function discoverEndpoints(
  responderHost: string,
  responderPort: number,
  options: { timeoutMs?: number; localPort?: number } = {},
): Promise<LinkEndpoint[]> {
  const socket = createSocket("udp4")
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject)
      socket.bind(options.localPort ?? 0, () => {
        socket.off("error", reject)
        resolve()
      })
    })
    const local: LinkEndpoint[] = []
    for (const addresses of Object.values(networkInterfaces())) {
      for (const entry of addresses ?? []) {
        if (entry.family !== "IPv4") continue
        local.push({ address: entry.address, port: 0, kind: "local" })
      }
    }
    const observed = await new Promise<LinkEndpoint | undefined>((resolve) => {
      const timer = setTimeout(() => resolve(undefined), options.timeoutMs ?? 2000)
      timer.unref?.()
      socket.on("message", (data) => {
        try {
          const parsed = JSON.parse(data.toString("utf8")) as { address?: unknown; port?: unknown }
          if (typeof parsed.address !== "string" || typeof parsed.port !== "number") return
          clearTimeout(timer)
          resolve({ address: parsed.address, port: parsed.port, kind: "observed" })
        } catch {
          // Not a discovery reply; keep waiting for the real one.
        }
      })
      socket.send(Buffer.from(DISCOVERY_PING), responderPort, responderHost, () => undefined)
    })
    return observed === undefined ? local : [...local, observed]
  } finally {
    socket.close()
  }
}
