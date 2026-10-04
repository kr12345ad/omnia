import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { createSocket } from "node:dgram"
import { networkInterfaces } from "node:os"
import { normalizePairingCode } from "./manager"

export const PAIRING_DISCOVERY_PORT = 39576
export const PAIRING_DISCOVERY_TIMEOUT_MS = 1800
const PROBE_PREFIX = "OMNIA_PAIR"

export interface PairingDiscoveryOptions {
  port?: number
  lookup: (codeHash: string) => { code: string; url: string } | undefined
}

export interface PairingDiscoveryHost {
  close(): void
}

// The code itself never travels over the network during discovery. Only its
// hash is broadcast, and the host proves possession of the code by signing the
// answer with it, so a host that cannot read the probe cannot forge a URL.
export function pairingCodeHash(code: string): string {
  return createHash("sha256").update(normalizePairingCode(code)).digest("hex")
}

export function pairingDiscoveryMac(code: string, nonce: string, url: string): string {
  return createHmac("sha256", normalizePairingCode(code)).update(`${nonce}|${url}`).digest("hex")
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

// The pairing code is shown as eight characters only, so a computer that
// wants to join broadcasts the code hash on the local network and the host
// that owns a live offer answers with its LAN URL signed by the code.
function broadcastAddresses(): string[] {
  const targets = new Set<string>(["255.255.255.255"])
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue
      const address = entry.address.split(".").map(Number)
      const mask = entry.netmask.split(".").map(Number)
      if (address.length !== 4 || mask.length !== 4) continue
      const broadcast = address
        .map((value, index) => (value | (~(mask[index] ?? 0) & 255)) & 255)
        .join(".")
      targets.add(broadcast)
    }
  }
  return [...targets]
}

export function startPairingDiscovery(options: PairingDiscoveryOptions): PairingDiscoveryHost {
  const socket = createSocket({ type: "udp4", reuseAddr: true })
  socket.on("error", () => undefined)
  socket.on("message", (message, remote) => {
    const parts = message.toString("utf8").trim().split(/\s+/)
    if (parts[0] !== PROBE_PREFIX) return
    const nonce = parts[1]
    const codeHash = parts[2]?.toLowerCase()
    if (nonce === undefined || nonce.length === 0 || codeHash === undefined || !/^[0-9a-f]{64}$/.test(codeHash)) return
    const found = options.lookup(codeHash)
    if (found === undefined) return
    socket.send(
      JSON.stringify({ url: found.url, nonce, mac: pairingDiscoveryMac(found.code, nonce, found.url) }),
      remote.port,
      remote.address,
      () => undefined,
    )
  })
  try {
    socket.bind(options.port ?? PAIRING_DISCOVERY_PORT)
  } catch {
    // Discovery is best effort; pairing by full address still works.
  }
  return {
    close: () => {
      try {
        socket.close()
      } catch {
        // Already closed.
      }
    },
  }
}

export function discoverPairingHost(
  code: string,
  timeoutMs = PAIRING_DISCOVERY_TIMEOUT_MS,
  port = PAIRING_DISCOVERY_PORT,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const socket = createSocket({ type: "udp4" })
    const wanted = normalizePairingCode(code)
    const nonce = randomBytes(16).toString("hex")
    const hash = pairingCodeHash(wanted)
    let settled = false
    const finish = (url: string | undefined) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket.close()
      } catch {
        // Already closed.
      }
      resolve(url)
    }
    socket.on("error", () => finish(undefined))
    socket.on("message", (message) => {
      try {
        const parsed = JSON.parse(message.toString("utf8")) as { url?: unknown; nonce?: unknown; mac?: unknown }
        if (typeof parsed.url !== "string" || typeof parsed.nonce !== "string" || typeof parsed.mac !== "string") return
        if (parsed.nonce !== nonce) return
        const expected = pairingDiscoveryMac(wanted, nonce, parsed.url)
        if (!constantTimeEqual(parsed.mac, expected)) return
        finish(parsed.url)
      } catch {
        // Ignore unrelated datagrams.
      }
    })
    const timer = setTimeout(() => finish(undefined), timeoutMs)
    try {
      socket.bind(0, () => {
        socket.setBroadcast(true)
        const probe = Buffer.from(`${PROBE_PREFIX} ${nonce} ${hash}`)
        for (const target of broadcastAddresses()) {
          socket.send(probe, port, target, () => undefined)
        }
      })
    } catch {
      finish(undefined)
    }
  })
}
