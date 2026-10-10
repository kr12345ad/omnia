import { describe, expect, test } from "bun:test"
import { MemoryTransport } from "./transport"
import { PeerLink, generateDeviceIdentity, type LinkEndpoint } from "./link"

const endpoints = (address: string, port: number): LinkEndpoint[] => [{ address, port, kind: "local" }]
const endpointsA = () => endpoints("device-a", 5001)
const endpointsB = () => endpoints("device-b", 5002)

function linkedPair(chaos?: { loss?: number; duplicate?: number; reorder?: number }) {
  const a = new MemoryTransport("device-a:5001", chaos)
  const b = new MemoryTransport("device-b:5002", chaos)
  MemoryTransport.link(a, b)
  return { a, b }
}

function openPair(chaos?: { loss?: number; duplicate?: number; reorder?: number }) {
  const { a: transportA, b: transportB } = linkedPair(chaos)
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
  const offer = linkA.createOffer(identityB.fingerprint, endpointsA())
  const answer = linkB.acceptOffer(offer, endpointsB())
  expect(answer).toBeDefined()
  expect(linkA.completeHandshake(answer!)).toBe(true)
  return { linkA, linkB, identityA, identityB }
}

describe("peer link handshake", () => {
  test("completes and reports the peer fingerprint on both ends", () => {
    const { linkA, linkB, identityA, identityB } = openPair()
    try {
      expect(linkA.state).toBe("open")
      expect(linkB.state).toBe("open")
      expect(linkA.peerFingerprint).toBe(identityB.fingerprint)
      expect(linkB.peerFingerprint).toBe(identityA.fingerprint)
    } finally {
      linkA.close()
      linkB.close()
    }
  })

  test("rejects an offer signed by an unknown identity", () => {
    const { a: transportA, b: transportB } = linkedPair()
    const identityA = generateDeviceIdentity()
    const identityB = generateDeviceIdentity()
    const stranger = generateDeviceIdentity()
    const linkA = new PeerLink({
      identity: stranger,
      knownPeers: new Map(),
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
      const offer = linkA.createOffer(identityB.fingerprint, endpointsA())
      expect(linkB.acceptOffer(offer, endpointsB())).toBeUndefined()
      expect(linkB.state).toBe("idle")
    } finally {
      linkA.close()
      linkB.close()
    }
  })

  test("an open link ignores subsequent offers, including replays", () => {
    const { linkA, linkB, identityA, identityB } = openPair()
    try {
      const replay = linkA.createOffer(identityB.fingerprint, endpointsA())
      expect(linkB.acceptOffer(replay, endpointsB())).toBeUndefined()
      expect(linkB.acceptOffer(replay, endpointsB())).toBeUndefined()
      // The original link is undisturbed: same peer, still open.
      expect(linkB.state).toBe("open")
      expect(linkB.peerFingerprint).toBe(identityA.fingerprint)
    } finally {
      linkA.close()
      linkB.close()
    }
  })

  test("rejects an answer that does not match the offer", () => {
    const { a: transportA, b: transportB } = linkedPair()
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
      linkA.createOffer(identityB.fingerprint, endpointsA())
      const forged = linkB.acceptOffer(
        linkA.createOffer(identityB.fingerprint, endpointsA()),
        endpointsB(),
      )
      expect(forged).toBeDefined()
      // Tamper with the answer payload: completion must fail closed.
      const tampered = { ...forged!, linkId: "other-link" }
      expect(linkA.completeHandshake(tampered)).toBe(false)
      expect(linkA.state).toBe("idle")
    } finally {
      linkA.close()
      linkB.close()
    }
  })
})

describe("peer link messaging", () => {
  test("delivers requests and responses over an unreliable channel", async () => {
    const { linkA, linkB } = openPair({ loss: 0.2, duplicate: 0.2, reorder: 8 })
    try {
      linkB.onRequest(async (method, params) => {
        if (method === "sessions/list") return [{ id: "ses-1", title: "hello" }]
        if (method === "echo") return params
        throw new Error(`unknown method ${method}`)
      })
      const listed = await linkA.request<Array<{ id: string; title: string }>>("sessions/list", undefined, 5000)
      expect(listed).toEqual([{ id: "ses-1", title: "hello" }])
      const echoed = await linkA.request("echo", { n: 42 }, 5000)
      expect(echoed).toEqual({ n: 42 })
    } finally {
      linkA.close()
      linkB.close()
    }
  }, 15000)

  test("times out a request the peer never answers", async () => {
    const { linkA, linkB } = openPair()
    try {
      linkB.onRequest(async () => {
        await new Promise(() => undefined)
        return undefined
      })
      await expect(linkA.request("sessions/list", undefined, 50)).rejects.toThrow("timed out")
    } finally {
      linkA.close()
      linkB.close()
    }
  })

  test("surfaces a peer-side handler failure instead of hanging", async () => {
    const { linkA, linkB } = openPair()
    try {
      linkB.onRequest(async () => {
        throw new Error("disk is gone")
      })
      await expect(linkA.request("sessions/list", undefined, 2000)).rejects.toThrow("disk is gone")
    } finally {
      linkA.close()
      linkB.close()
    }
  })
})
