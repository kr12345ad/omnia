// Datagram transport seam for direct device links. Production uses UDP
// sockets; tests use the in-memory transport below. Frames are opaque bytes;
// encryption and reliability live in link.ts, never here.
export interface DatagramTransport {
  readonly localAddress: string
  send(to: string, data: Uint8Array): void
  onDatagram(listener: (from: string, data: Uint8Array) => void): () => void
  close(): void
}

export interface TransportChaos {
  readonly loss?: number
  readonly duplicate?: number
  readonly reorder?: number
  readonly seed?: number
}

// Deterministic PRNG so chaos tests reproduce.
function mulberry32(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

export class MemoryTransport implements DatagramTransport {
  private static readonly registry = new Map<string, MemoryTransport>()
  private readonly listeners = new Set<(from: string, data: Uint8Array) => void>()
  private readonly pending: Array<{ from: string; data: Uint8Array }> = []
  private readonly random: () => number
  private closed = false

  constructor(
    readonly localAddress: string,
    private readonly chaos: TransportChaos = {},
  ) {
    this.random = mulberry32(chaos.seed ?? 1)
    MemoryTransport.registry.set(localAddress, this)
  }

  static link(a: MemoryTransport, b: MemoryTransport): void {
    // Registration in the constructor already makes both reachable; this
    // exists so tests read symmetrically.
  }

  static clear(): void {
    MemoryTransport.registry.clear()
  }

  send(to: string, data: Uint8Array): void {
    if (this.closed) return
    const target = MemoryTransport.registry.get(to)
    if (target === undefined || target.closed) return
    const { loss = 0, duplicate = 0, reorder = 0 } = this.chaos
    if (this.random() < loss) return
    target.enqueue(this.localAddress, data)
    if (this.random() < duplicate) target.enqueue(this.localAddress, data)
    if (reorder > 0 && target.pending.length > 1 && this.random() < 0.5) {
      // Hold one back so a later datagram can overtake it; the rest go now.
      const held = target.pending.splice(Math.floor(this.random() * target.pending.length), 1)
      target.flush()
      if (held.length > 0) {
        const delay = Math.floor(this.random() * reorder)
        setTimeout(() => target.flush(held[0]!), delay).unref?.()
      }
      return
    }
    target.flush()
  }

  private enqueue(from: string, data: Uint8Array): void {
    this.pending.push({ from, data: data.slice() })
  }

  private flush(specific?: { from: string; data: Uint8Array }): void {
    if (this.closed) return
    const batch = specific !== undefined ? [specific] : this.pending.splice(0)
    queueMicrotask(() => {
      if (this.closed) return
      for (const item of batch) {
        for (const listener of [...this.listeners]) listener(item.from, item.data)
      }
    })
  }

  onDatagram(listener: (from: string, data: Uint8Array) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  close(): void {
    this.closed = true
    this.listeners.clear()
    this.pending.length = 0
    if (MemoryTransport.registry.get(this.localAddress) === this) {
      MemoryTransport.registry.delete(this.localAddress)
    }
  }
}
