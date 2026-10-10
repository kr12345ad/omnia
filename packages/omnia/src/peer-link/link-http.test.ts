import { describe, expect, test } from "bun:test"
import { MemoryTransport } from "./transport"
import { PeerLink, generateDeviceIdentity } from "./link"
import { attachSessionBridge, type LocalSessionApi } from "./bridge"
import { startLinkHttpServer } from "./link-http"

function openLinkedPair() {
  const transportA = new MemoryTransport("http-a:1")
  const transportB = new MemoryTransport("http-b:2")
  MemoryTransport.link(transportA, transportB)
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
  const offer = linkA.createOffer(identityB.fingerprint, [{ address: "http-a", port: 1, kind: "local" }])
  const answer = linkB.acceptOffer(offer, [{ address: "http-b", port: 2, kind: "local" }])
  expect(answer).toBeDefined()
  expect(linkA.completeHandshake(answer!)).toBe(true)
  return { linkA, linkB }
}

const fakeApi = (): LocalSessionApi => ({
  forward: async (request): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> => {
    if (request.path === "/session" && request.method === "GET") {
      return { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from(`{"sessions":[]}`) }
    }
    return { status: 404, headers: {}, body: Buffer.from(`{}`) }
  },
  openStream: async () => ({ streamId: "stream-1" }),
  streamNext: async () => ({
    chunks: [Buffer.from("data: hello\n\n").toString("base64")],
    done: true,
  }),
  closeStream: async () => undefined,
})

describe("link-local session HTTP server", () => {
  test("serves the bridged API to a bearer holder as ordinary HTTP", async () => {
    const { linkA, linkB } = openLinkedPair()
    try {
      attachSessionBridge(linkB, fakeApi())
      const server = await startLinkHttpServer(linkA, { token: "link-token-1" })
      try {
        const response = await fetch(`${server.url}/session`, {
          headers: { authorization: "Bearer link-token-1" },
        })
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ sessions: [] })
      } finally {
        await server.close()
      }
    } finally {
      linkA.close()
      linkB.close()
    }
  })

  test("rejects requests without the link token and never forwards them", async () => {
    const { linkA, linkB } = openLinkedPair()
    try {
      let forwarded = 0
      const api = fakeApi()
      attachSessionBridge(linkB, {
        ...api,
        forward: async (request) => {
          forwarded += 1
          return api.forward(request)
        },
      })
      const server = await startLinkHttpServer(linkA, { token: "link-token-2" })
      try {
        expect((await fetch(`${server.url}/session`)).status).toBe(401)
        expect(
          (await fetch(`${server.url}/session`, { headers: { authorization: "Bearer wrong" } })).status,
        ).toBe(401)
        expect(forwarded).toBe(0)
      } finally {
        await server.close()
      }
    } finally {
      linkA.close()
      linkB.close()
    }
  })

  test("streams server events to an event-stream client and closes cleanly", async () => {
    const { linkA, linkB } = openLinkedPair()
    try {
      attachSessionBridge(linkB, fakeApi())
      const server = await startLinkHttpServer(linkA, { token: "link-token-3" })
      try {
        const response = await fetch(`${server.url}/event`, {
          headers: { authorization: "Bearer link-token-3", accept: "text/event-stream" },
        })
        expect(response.status).toBe(200)
        expect(await response.text()).toBe("data: hello\n\n")
      } finally {
        await server.close()
      }
    } finally {
      linkA.close()
      linkB.close()
    }
  })
})
