import { randomBytes as nodeRandomBytes } from "node:crypto"
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

export const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
export const PAIRING_CODE_LENGTH = 8
export const PAIRING_TTL_MS = 10 * 60 * 1000

export interface PairingOffer {
  readonly code: string
  readonly name?: string
  // The signed-in profile that created the offer. A claimed computer inherits
  // this owner instead of becoming globally addressable by every desktop.
  readonly owner?: string
  readonly createdAt: number
  readonly expiresAt: number
}

export interface PairingClaim {
  readonly code: string
  readonly name: string
  readonly platform: string
  readonly architecture?: string
}

export interface PairingManagerOptions {
  readonly file?: string
  readonly now?: () => number
  readonly ttlMs?: number
  readonly randomBytes?: (size: number) => Buffer
}

function formatCode(bytes: Buffer): string {
  const chars = [...bytes].map((byte) => PAIRING_CODE_ALPHABET[byte % PAIRING_CODE_ALPHABET.length])
  return `${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}`
}

export function normalizePairingCode(code: string): string {
  const cleaned = code.toUpperCase().replace(/[^A-Z0-9]/g, "")
  if (cleaned.length !== PAIRING_CODE_LENGTH) return ""
  return `${cleaned.slice(0, 4)}-${cleaned.slice(4)}`
}

export function formatPairingCode(address: string, code: string): string {
  const trimmed = address.replace(/\/+$/, "")
  // Keep https for hosted control planes; LAN addresses stay schemeless and
  // are parsed back as http.
  const rendered = trimmed.startsWith("https://") ? trimmed : trimmed.replace(/^http:\/\//, "")
  return `${rendered}#${code}`
}

export function parsePairingCode(value: string): { serverUrl: string; code: string } | undefined {
  const trimmed = value.trim()
  const separator = trimmed.lastIndexOf("#")
  if (separator <= 0) return undefined
  const address = trimmed.slice(0, separator).trim()
  const code = normalizePairingCode(trimmed.slice(separator + 1))
  if (address.length === 0 || code.length === 0) return undefined
  const serverUrl = (/^https?:\/\//.test(address) ? address : `http://${address}`).replace(/\/+$/, "")
  try {
    new URL(serverUrl)
  } catch {
    return undefined
  }
  return { serverUrl, code }
}

export class PairingManager {
  private readonly offers = new Map<string, PairingOffer>()
  private readonly file: string | undefined
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly randomBytes: (size: number) => Buffer

  constructor(options: PairingManagerOptions = {}) {
    this.file = options.file
    this.now = options.now ?? Date.now
    this.ttlMs = options.ttlMs ?? PAIRING_TTL_MS
    this.randomBytes = options.randomBytes ?? nodeRandomBytes
    this.load()
  }

  private load(): void {
    if (this.file === undefined) return
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.file, "utf8"))
    } catch {
      return
    }
    if (!Array.isArray(parsed)) return
    for (const record of parsed) {
      if (typeof record !== "object" || record === null) continue
      const entry = record as Record<string, unknown>
      const code = typeof entry.code === "string" ? normalizePairingCode(entry.code) : ""
      if (code.length === 0 || typeof entry.createdAt !== "number" || typeof entry.expiresAt !== "number") continue
      const name = typeof entry.name === "string" && entry.name.length > 0 ? entry.name : undefined
      const owner = typeof entry.owner === "string" && entry.owner.length > 0 ? entry.owner : undefined
      this.offers.set(code, {
        code,
        ...(name === undefined ? {} : { name }),
        ...(owner === undefined ? {} : { owner }),
        createdAt: entry.createdAt,
        expiresAt: entry.expiresAt,
      })
    }
    // Keep expired offers so a recently expired code still answers "expired"
    // instead of "unknown" after a restart; the next create/claim/list prunes
    // them and persists the cleaned file.
  }

  private save(): void {
    if (this.file === undefined) return
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify([...this.offers.values()], null, 2), { mode: 0o600 })
    try {
      chmodSync(this.file, 0o600)
    } catch {
      // Best effort: the write itself succeeded.
    }
  }

  create(input: { name?: string; owner?: string } = {}): PairingOffer {
    this.prune()
    let code = formatCode(this.randomBytes(PAIRING_CODE_LENGTH))
    while (this.offers.has(code)) code = formatCode(this.randomBytes(PAIRING_CODE_LENGTH))
    const createdAt = this.now()
    const offer: PairingOffer = {
      code,
      ...(input.name === undefined || input.name.length === 0 ? {} : { name: input.name }),
      ...(input.owner === undefined || input.owner.length === 0 ? {} : { owner: input.owner }),
      createdAt,
      expiresAt: createdAt + this.ttlMs,
    }
    this.offers.set(code, offer)
    this.save()
    return offer
  }

  status(code: string): "valid" | "expired" | "unknown" {
    const offer = this.offers.get(normalizePairingCode(code))
    if (offer === undefined) return "unknown"
    return offer.expiresAt <= this.now() ? "expired" : "valid"
  }

  list(): PairingOffer[] {
    this.prune()
    return [...this.offers.values()]
  }

  get(code: string): PairingOffer | undefined {
    this.prune()
    return this.offers.get(normalizePairingCode(code))
  }

  cancel(code: string): boolean {
    const removed = this.offers.delete(normalizePairingCode(code))
    if (removed) this.save()
    return removed
  }

  claim(code: string): PairingOffer | undefined {
    this.prune()
    const normalized = normalizePairingCode(code)
    const offer = this.offers.get(normalized)
    if (offer === undefined) return undefined
    this.offers.delete(normalized)
    this.save()
    return offer
  }

  private prune(): boolean {
    const now = this.now()
    let removed = false
    for (const [code, offer] of this.offers) {
      if (offer.expiresAt <= now) {
        this.offers.delete(code)
        removed = true
      }
    }
    return removed
  }
}
