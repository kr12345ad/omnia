import { createHash, randomBytes, type KeyObject } from "node:crypto"
import {
  canonicalJson,
  deriveLinkKey,
  exportPublicKey,
  fingerprintOf,
  generateDeviceIdentity,
  generateEphemeralKey,
  importPublicKey,
  open,
  seal,
  signBytes,
  verifyBytes,
} from "./crypto"
import type { DatagramTransport } from "./transport"

export { generateDeviceIdentity }
export type { DeviceIdentity } from "./crypto"

export interface LinkEndpoint {
  readonly address: string
  readonly port: number
  readonly kind: "local" | "observed"
}

export interface LinkOfferMessage {
  readonly v: 1
  readonly kind: "offer"
  readonly linkId: string
  readonly identity: string
  readonly ephemeral: string
  readonly endpoints: LinkEndpoint[]
  readonly nonce: string
  readonly signature: string
}

export interface LinkAnswerMessage {
  readonly v: 1
  readonly kind: "answer"
  readonly linkId: string
  readonly identity: string
  readonly ephemeral: string
  readonly endpoints: LinkEndpoint[]
  readonly signature: string
}

export interface LinkOptions {
  readonly identity: { readonly publicKey: KeyObject; readonly privateKey: KeyObject }
  readonly knownPeers: Map<string, KeyObject>
  readonly transport: DatagramTransport
  readonly retransmitMs?: number
  readonly onRequest?: (method: string, params: unknown) => Promise<unknown> | unknown
}

type PendingCall = {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

type Unacked = {
  readonly to: string
  readonly bytes: Uint8Array
  lastSent: number
  attempts: number
}

const MAX_UNACKED_ATTEMPTS = 200
const MAX_SEEN_SEQS = 2048

function endpointKey(endpoint: LinkEndpoint): string {
  return `${endpoint.address}:${endpoint.port}`
}

export class PeerLink {
  private linkId: string | undefined
  private linkKey: Buffer | undefined
  private peerEndpoints: string[] = []
  private peerFingerprintValue: string | undefined
  private closed = false
  private nextSeq = 0
  private readonly unacked = new Map<number, Unacked>()
  private readonly seenSeqs = new Set<number>()
  private contiguousAck = -1
  private readonly pending = new Map<string, PendingCall>()
  private readonly seenLinkIds = new Set<string>()
  private pendingOffer: { linkId: string; remoteFingerprint: string } | undefined
  private handler: ((method: string, params: unknown) => Promise<unknown> | unknown) | undefined
  private readonly retransmitMs: number
  private readonly retransmitTimer: ReturnType<typeof setInterval>
  private readonly unsubscribe: () => void

  constructor(private readonly options: LinkOptions) {
    this.retransmitMs = options.retransmitMs ?? 100
    if (options.onRequest !== undefined) this.handler = options.onRequest
    this.unsubscribe = options.transport.onDatagram((from, data) => this.receive(from, data))
    this.retransmitTimer = setInterval(() => this.retransmit(), this.retransmitMs)
    this.retransmitTimer.unref?.()
  }

  get state(): "idle" | "open" | "closed" {
    if (this.closed) return "closed"
    return this.linkKey === undefined ? "idle" : "open"
  }

  get peerFingerprint(): string | undefined {
    return this.peerFingerprintValue
  }

  onRequest(handler: (method: string, params: unknown) => Promise<unknown> | unknown): void {
    this.handler = handler
  }

  createOffer(remoteFingerprint: string, endpoints: LinkEndpoint[]): LinkOfferMessage {
    if (this.closed) throw new Error("The link is closed.")
    const ephemeral = generateEphemeralKey()
    const linkId = randomBytes(16).toString("hex")
    const nonce = randomBytes(16).toString("hex")
    const unsigned = {
      v: 1 as const,
      kind: "offer" as const,
      linkId,
      identity: fingerprintOf(this.options.identity.publicKey),
      ephemeral: exportPublicKey(ephemeral.publicKey),
      endpoints,
      nonce,
    }
    const signature = signBytes(this.options.identity.privateKey, Buffer.from(canonicalJson(unsigned))).toString("base64")
    this.pendingOffer = { linkId, remoteFingerprint }
    this.pendingEphemeral.set(linkId, ephemeral.privateKey)
    return { ...unsigned, signature }
  }

  private readonly pendingEphemeral = new Map<string, KeyObject>()

  acceptOffer(offer: LinkOfferMessage, endpoints: LinkEndpoint[]): LinkAnswerMessage | undefined {
    if (this.closed || this.linkKey !== undefined) return undefined
    if (offer.v !== 1 || offer.kind !== "offer") return undefined
    if (this.seenLinkIds.has(offer.linkId)) return undefined
    const identityKey = this.options.knownPeers.get(offer.identity)
    if (identityKey === undefined) return undefined
    const { signature, ...unsigned } = offer
    if (!verifyBytes(identityKey, Buffer.from(canonicalJson(unsigned)), Buffer.from(signature, "base64"))) {
      return undefined
    }
    let peerEphemeral: KeyObject
    try {
      peerEphemeral = importPublicKey(offer.ephemeral)
    } catch {
      return undefined
    }
    const ephemeral = generateEphemeralKey()
    const salt = createHash("sha256").update(`omnia-peer-link-v1:${offer.linkId}`).digest()
    this.linkKey = deriveLinkKey(ephemeral.privateKey, peerEphemeral, salt)
    this.linkId = offer.linkId
    this.peerFingerprintValue = offer.identity
    this.peerEndpoints = offer.endpoints.map(endpointKey)
    this.seenLinkIds.add(offer.linkId)
    const answerUnsigned = {
      v: 1 as const,
      kind: "answer" as const,
      linkId: offer.linkId,
      identity: fingerprintOf(this.options.identity.publicKey),
      ephemeral: exportPublicKey(ephemeral.publicKey),
      endpoints,
    }
    const answerSignature = signBytes(this.options.identity.privateKey, Buffer.from(canonicalJson(answerUnsigned))).toString(
      "base64",
    )
    return { ...answerUnsigned, signature: answerSignature }
  }

  completeHandshake(answer: LinkAnswerMessage): boolean {
    if (this.closed || this.linkKey !== undefined) return false
    const pending = this.pendingOffer
    if (pending === undefined) return false
    if (answer.v !== 1 || answer.kind !== "answer" || answer.linkId !== pending.linkId) return false
    if (answer.identity !== pending.remoteFingerprint) return false
    const identityKey = this.options.knownPeers.get(answer.identity)
    if (identityKey === undefined) return false
    const { signature, ...unsigned } = answer
    if (!verifyBytes(identityKey, Buffer.from(canonicalJson(unsigned)), Buffer.from(signature, "base64"))) {
      return false
    }
    const ownEphemeral = this.pendingEphemeral.get(pending.linkId)
    if (ownEphemeral === undefined) return false
    let peerEphemeral: KeyObject
    try {
      peerEphemeral = importPublicKey(answer.ephemeral)
    } catch {
      return false
    }
    const salt = createHash("sha256").update(`omnia-peer-link-v1:${pending.linkId}`).digest()
    this.linkKey = deriveLinkKey(ownEphemeral, peerEphemeral, salt)
    this.linkId = pending.linkId
    this.peerFingerprintValue = answer.identity
    this.peerEndpoints = answer.endpoints.map(endpointKey)
    this.pendingEphemeral.delete(pending.linkId)
    this.pendingOffer = undefined
    return true
  }

  setPeerEndpoints(endpoints: LinkEndpoint[]): void {
    this.peerEndpoints = endpoints.map(endpointKey)
  }

  request<T>(method: string, params?: unknown, timeoutMs = 5000): Promise<T> {
    if (this.closed) return Promise.reject(new Error("The link is closed."))
    if (this.linkKey === undefined) return Promise.reject(new Error("The link is not open."))
    const callId = randomBytes(8).toString("hex")
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(callId)
        reject(new Error(`The ${method} request timed out.`))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(callId, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      })
      this.sendEnvelope({ call: { id: callId, method, ...(params === undefined ? {} : { params }) } })
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    clearInterval(this.retransmitTimer)
    this.unsubscribe()
    for (const [, call] of this.pending) {
      clearTimeout(call.timer)
      call.reject(new Error("The link is closed."))
    }
    this.pending.clear()
    this.unacked.clear()
  }

  private sendEnvelope(envelope: Record<string, unknown>): void {
    const key = this.linkKey
    const linkId = this.linkId
    if (key === undefined || linkId === undefined || this.closed) return
    const seq = this.nextSeq++
    const frame = {
      v: 1,
      kind: "data",
      linkId,
      seq,
      ack: this.contiguousAck,
      payload: seal(key, Buffer.from(JSON.stringify(envelope))).toString("base64"),
    }
    const bytes = Buffer.from(JSON.stringify(frame))
    for (const to of this.peerEndpoints) {
      this.unacked.set(seq, { to, bytes, lastSent: Date.now(), attempts: 1 })
      this.options.transport.send(to, bytes)
    }
  }

  private sendAck(): void {
    const key = this.linkKey
    const linkId = this.linkId
    if (key === undefined || linkId === undefined || this.closed) return
    const frame = {
      v: 1,
      kind: "ack",
      linkId,
      payload: seal(key, Buffer.from(JSON.stringify({ ack: this.contiguousAck }))).toString("base64"),
    }
    const bytes = Buffer.from(JSON.stringify(frame))
    for (const to of this.peerEndpoints) this.options.transport.send(to, bytes)
  }

  private retransmit(): void {
    if (this.closed) return
    const at = Date.now()
    for (const [seq, pending] of [...this.unacked]) {
      if (at - pending.lastSent < this.retransmitMs) continue
      if (pending.attempts >= MAX_UNACKED_ATTEMPTS) {
        this.unacked.delete(seq)
        continue
      }
      pending.attempts += 1
      pending.lastSent = at
      this.options.transport.send(pending.to, pending.bytes)
    }
  }

  private receive(from: string, data: Uint8Array): void {
    if (this.closed) return
    let frame: Record<string, unknown>
    try {
      frame = JSON.parse(Buffer.from(data).toString("utf8")) as Record<string, unknown>
    } catch {
      return
    }
    if (frame.v !== 1 || frame.linkId !== this.linkId || this.linkKey === undefined) return
    const payload = typeof frame.payload === "string" ? open(this.linkKey, Buffer.from(frame.payload, "base64")) : undefined
    if (payload === undefined) return
    let envelope: Record<string, unknown>
    try {
      envelope = JSON.parse(Buffer.from(payload).toString("utf8")) as Record<string, unknown>
    } catch {
      return
    }
    if (frame.kind === "ack") {
      const ack = typeof envelope.ack === "number" ? envelope.ack : -1
      for (const [seq] of [...this.unacked]) {
        if (seq <= ack) this.unacked.delete(seq)
      }
      return
    }
    if (frame.kind !== "data" || typeof frame.seq !== "number") return
    for (const [seq] of [...this.unacked]) {
      if (seq <= (typeof frame.ack === "number" ? frame.ack : -1)) this.unacked.delete(seq)
    }
    if (!this.seenSeqs.has(frame.seq)) {
      this.seenSeqs.add(frame.seq)
      if (this.seenSeqs.size > MAX_SEEN_SEQS) {
        const oldest = this.seenSeqs.values().next().value
        if (oldest !== undefined) this.seenSeqs.delete(oldest)
      }
      let next = this.contiguousAck + 1
      while (this.seenSeqs.has(next)) next += 1
      this.contiguousAck = next - 1
      void this.deliver(envelope)
    }
    this.sendAck()
  }

  private async deliver(envelope: Record<string, unknown>): Promise<void> {
    const call = envelope.call as { id?: unknown; method?: unknown; params?: unknown } | undefined
    const response = envelope.response as { id?: unknown; ok?: unknown; result?: unknown; error?: unknown } | undefined
    if (response !== undefined && typeof response.id === "string") {
      const pending = this.pending.get(response.id)
      if (pending === undefined) return
      this.pending.delete(response.id)
      clearTimeout(pending.timer)
      if (response.ok === true) pending.resolve(response.result)
      else pending.reject(new Error(typeof response.error === "string" ? response.error : "The peer request failed."))
      return
    }
    if (call !== undefined && typeof call.id === "string" && typeof call.method === "string") {
      if (this.handler === undefined) {
        this.sendEnvelope({ response: { id: call.id, ok: false, error: "No request handler." } })
        return
      }
      try {
        const result = await this.handler(call.method, call.params)
        this.sendEnvelope({ response: { id: call.id, ok: true, ...(result === undefined ? {} : { result }) } })
      } catch (error) {
        this.sendEnvelope({
          response: { id: call.id, ok: false, error: error instanceof Error ? error.message : String(error) },
        })
      }
    }
  }
}
