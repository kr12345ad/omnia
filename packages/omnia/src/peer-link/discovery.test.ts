import { describe, expect, test } from "bun:test"
import { createSocket } from "node:dgram"
import {
  TokenBucket,
  discoverEndpoints,
  startEndpointDiscoveryResponder,
} from "./discovery"
import { MemoryTransport } from "./transport"
import { PeerLink, generateDeviceIdentity } from "./link"

describe("endpoint discovery", () => {
  test("the responder reports the observed source address and port", async () => {
    const responder = await startEndpointDiscoveryResponder("127.0.0.1", 0)
    try {
      const client = createSocket("udp4")
      try {
        const observed = await new Promise<{ address: string; port: number }>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("no discovery reply")), 2000)
          client.on("message", (data) => {
            clearTimeout(timer)
            resolve(JSON.parse(data.toString("utf8")))
          })
          client.send(Buffer.from("OMNIA-DISCOVER"), responder.port, "127.0.0.1")
        })
        expect(observed.address).toBe("127.0.0.1")
        expect(observed.port).toBeGreaterThan(0)
      } finally {
        client.close()
      }
    } finally {
      responder.close()
    }
  })

  test("discoverEndpoints returns local and observed records", async () => {
    const responder = await startEndpointDiscoveryResponder("127.0.0.1", 0)
    try {
      const endpoints = await discoverEndpoints("127.0.0.1", responder.port, { timeoutMs: 2000 })
      expect(endpoints.some((entry) => entry.kind === "local")).toBe(true)
      const observed = endpoints.find((entry) => entry.kind === "observed")
      expect(observed?.address).toBe("127.0.0.1")
      expect(observed?.port).toBeGreaterThan(0)
    } finally {
      responder.close()
    }
  })

  test("ignores malformed discovery pings", async () => {
    const responder = await startEndpointDiscoveryResponder("127.0.0.1", 0)
    try {
      const replies: unknown[] = []
      const client = createSocket("udp4")
      try {
        client.on("message", (data) => replies.push(data.toString("utf8")))
        for (const payload of ["", "HELLO", "OMNIA-DISCOVER-EXTRA-JUNK-THAT-IS-STILL-SHORT"]) {
          client.send(Buffer.from(payload), responder.port, "127.0.0.1")
        }
        await new Promise((resolve) => setTimeout(resolve, 200))
        // Only the exact ping is answered; junk is ignored.
        expect(replies.length).toBeLessThanOrEqual(1)
      } finally {
        client.close()
      }
    } finally {
      responder.close()
    }
  })
})

describe("discovery rate limiting", () => {
  test("a token bucket bounds bursts deterministically", () => {
    const bucket = new TokenBucket({ capacity: 3, refillPerMs: 0 })
    expect(bucket.take()).toBe(true)
    expect(bucket.take()).toBe(true)
    expect(bucket.take()).toBe(true)
    expect(bucket.take()).toBe(false)
  })

  test("the responder sheds load past its per-source budget", async () => {
    const responder = await startEndpointDiscoveryResponder("127.0.0.1", 0, { maxRepliesPerMinute: 5 })
    try {
      let replies = 0
      const client = createSocket("udp4")
      try {
        client.on("message", () => {
          replies += 1
        })
        for (let index = 0; index < 30; index += 1) {
          client.send(Buffer.from("OMNIA-DISCOVER"), responder.port, "127.0.0.1")
        }
        await new Promise((resolve) => setTimeout(resolve, 300))
        expect(replies).toBeLessThanOrEqual(6)
        expect(replies).toBeGreaterThan(0)
      } finally {
        client.close()
      }
    } finally {
      responder.close()
    }
  })
})

describe("peer link over loopback UDP", () => {
  test("two links handshake and exchange a request over real sockets", async () => {
    const { UdpTransport } = await import("./udp")
    const transportA = await UdpTransport.bind("127.0.0.1", 0)
    const transportB = await UdpTransport.bind("127.0.0.1", 0)
    const portOf = (address: string) => Number(address.split(":").at(-1))
    try {
      const identityA = generateDeviceIdentity()
      const identityB = generateDeviceIdentity()
      const linkA = new PeerLink({
        identity: identityA,
        knownPeers: new Map([[identityB.fingerprint, identityB.publicKey]]),
        transport: transportA,
        retransmitMs: 10,
      })
      const linkB = new PeerLink({
        identity: identityB,
        knownPeers: new Map([[identityA.fingerprint, identityA.publicKey]]),
        transport: transportB,
        retransmitMs: 10,
      })
      try {
        const offer = linkA.createOffer(identityB.fingerprint, [
          { address: "127.0.0.1", port: portOf(transportA.localAddress), kind: "local" },
        ])
        const answer = linkB.acceptOffer(offer, [
          { address: "127.0.0.1", port: portOf(transportB.localAddress), kind: "local" },
        ])
        expect(answer).toBeDefined()
        expect(linkA.completeHandshake(answer!)).toBe(true)
        linkB.onRequest(async (method) => {
          if (method === "sessions/list") return [{ id: "ses-remote" }]
          throw new Error("unknown")
        })
        await expect(linkA.request("sessions/list", undefined, 5000)).resolves.toEqual([{ id: "ses-remote" }])
      } finally {
        linkA.close()
        linkB.close()
      }
    } finally {
      transportA.close()
      transportB.close()
      MemoryTransport.clear()
    }
  }, 15000)
})
