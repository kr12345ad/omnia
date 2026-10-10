import { describe, expect, test } from "bun:test"
import { MemoryTransport } from "./transport"
import { PeerLink, generateDeviceIdentity } from "./link"
import {
  attachSessionBridge,
  type ForwardedRequest,
  type LocalSessionApi,
} from "./bridge"

function openLinkedPair() {
  const transportA = new MemoryTransport("bridge-a:1")
  const transportB = new MemoryTransport("bridge-b:2")
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
  const offer = linkA.createOffer(identityB.fingerprint, [{ address: "bridge-a", port: 1, kind: "local" }])
  const answer = linkB.acceptOffer(offer, [{ address: "bridge-b", port: 2, kind: "local" }])
  expect(answer).toBeDefined()
  expect(linkA.completeHandshake(answer!)).toBe(true)
  return { linkA, linkB }
}

function fakeApi(calls: ForwardedRequest[] = []): LocalSessionApi & { calls: ForwardedRequest[] } {
  return {
    calls,
    forward: async (request): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> => {
      calls.push(request)
      if (request.path === "/session" && request.method === "GET") {
        return { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from(`{"sessions":[]}`) }
      }
      if (request.path === "/session/ses-1/message") {
        return { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from(`{"messages":[]}`) }
      }
      return { status: 404, headers: {}, body: Buffer.from(`{"error":"nope"}`) }
    },
    openStream: async () => ({ streamId: "stream-1" }),
    streamNext: async () => ({ chunks: [], done: true }),
    closeStream: async () => undefined,
  }
}

describe("session bridge over a peer link", () => {
  test("forwards session reads and writes to the local API", async () => {
    const { linkA, linkB } = openLinkedPair()
    try {
      const api = fakeApi()
      attachSessionBridge(linkB, api)
      const listed = await linkA.request<{ status: number; body: string }>("http/forward", {
        method: "GET",
        path: "/session",
        query: "",
        headers: {},
      })
      expect(listed.status).toBe(200)
      expect(JSON.parse(listed.body)).toEqual({ sessions: [] })
      expect(api.calls).toHaveLength(1)
      expect(api.calls[0]).toMatchObject({ method: "GET", path: "/session" })
    } finally {
      linkA.close()
      linkB.close()
    }
  })

  test("never forwards peer-supplied authorization or cookies to the local API", async () => {
    const { linkA, linkB } = openLinkedPair()
    try {
      const api = fakeApi()
      attachSessionBridge(linkB, api)
      await linkA.request("http/forward", {
        method: "GET",
        path: "/session",
        query: "",
        headers: { authorization: "Bearer stolen", cookie: "sid=abc", "x-custom": "kept" },
      })
      expect(api.calls).toHaveLength(1)
      expect(api.calls[0]!.headers).toEqual({ "x-custom": "kept" })
    } finally {
      linkA.close()
      linkB.close()
    }
  })

  test("rejects oversized bodies before touching the local API", async () => {
    const { linkA, linkB } = openLinkedPair()
    try {
      let touched = false
      attachSessionBridge(linkB, {
        ...fakeApi(),
        forward: async () => {
          touched = true
          return { status: 200, headers: {}, body: Buffer.alloc(0) }
        },
      })
      const result = await linkA.request<{ status: number; body: string }>("http/forward", {
        method: "POST",
        path: "/session",
        query: "",
        headers: { "content-type": "application/json" },
        body: "x".repeat(17 * 1024 * 1024),
      })
      expect(result.status).toBe(413)
      expect(touched).toBe(false)
    } finally {
      linkA.close()
      linkB.close()
    }
  })

  test("streams events through open/next/close without losing chunks", async () => {
    const { linkA, linkB } = openLinkedPair()
    try {
      const closed: string[] = []
      attachSessionBridge(linkB, {
        ...fakeApi(),
        openStream: async () => ({ streamId: "stream-9" }),
        streamNext: async (streamId) => {
          expect(streamId).toBe("stream-9")
          return { chunks: [Buffer.from("data: one\n\n"), Buffer.from("data: two\n\n")], done: false }
        },
        closeStream: async (streamId) => {
          closed.push(streamId)
        },
      })
      const opened = await linkA.request<{ streamId: string }>("http/open-stream", {
        method: "GET",
        path: "/event",
        query: "",
        headers: {},
      })
      expect(opened.streamId).toBe("stream-9")
      const next = await linkA.request<{ chunks: string[]; done: boolean }>("http/stream-next", {
        streamId: "stream-9",
        timeoutMs: 1000,
      })
      expect(next.done).toBe(false)
      expect(next.chunks.map((chunk) => Buffer.from(chunk, "base64").toString("utf8")).join("")).toBe(
        "data: one\n\ndata: two\n\n",
      )
      await linkA.request("http/close-stream", { streamId: "stream-9" })
      expect(closed).toEqual(["stream-9"])
    } finally {
      linkA.close()
      linkB.close()
    }
  })

  test("unknown bridge operations fail closed with a structured error", async () => {
    const { linkA, linkB } = openLinkedPair()
    try {
      attachSessionBridge(linkB, fakeApi())
      await expect(linkA.request("http/delete-everything", {})).rejects.toThrow()
    } finally {
      linkA.close()
      linkB.close()
    }
  })
})
