import {
  createHash,
  createHmac,
  createCipheriv,
  createDecipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from "node:crypto"

export type { KeyObject }

// Long-term device identity (Ed25519). Fingerprints travel over the already
// authenticated pairing channel; the link handshake proves possession.
export interface DeviceIdentity {
  readonly publicKey: KeyObject
  readonly privateKey: KeyObject
  readonly fingerprint: string
}

export function generateDeviceIdentity(): DeviceIdentity {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  return { publicKey, privateKey, fingerprint: fingerprintOf(publicKey) }
}

export function exportPublicKey(publicKey: KeyObject): string {
  return publicKey.export({ format: "der", type: "spki" }).toString("base64")
}

export function importPublicKey(raw: string): KeyObject {
  return createPublicKey({ key: Buffer.from(raw, "base64"), format: "der", type: "spki" })
}

export function fingerprintOf(publicKey: KeyObject): string {
  return createHash("sha256").update(publicKey.export({ format: "der", type: "spki" })).digest("hex")
}

export function generateEphemeralKey(): { publicKey: KeyObject; privateKey: KeyObject } {
  return generateKeyPairSync("x25519")
}

// HKDF-Extract + first Expand block, all standard HMAC-SHA256.
export function deriveLinkKey(ownEphemeralPrivate: KeyObject, peerEphemeralPublic: KeyObject, salt: Buffer): Buffer {
  const shared = diffieHellman({ privateKey: ownEphemeralPrivate, publicKey: peerEphemeralPublic })
  const prk = createHmac("sha256", salt).update(shared).digest()
  return createHmac("sha256", prk).update(Buffer.concat([Buffer.from("omnia-peer-link-v1"), Buffer.from([1])])).digest()
}

const NONCE_BYTES = 12
const TAG_BYTES = 16

export function seal(key: Buffer, plaintext: Uint8Array): Buffer {
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv("aes-256-gcm", key, nonce)
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([nonce, body, cipher.getAuthTag()])
}

export function open(key: Buffer, sealed: Uint8Array): Uint8Array | undefined {
  if (sealed.length < NONCE_BYTES + TAG_BYTES) return undefined
  try {
    const nonce = sealed.subarray(0, NONCE_BYTES)
    const tag = sealed.subarray(sealed.length - TAG_BYTES)
    const body = sealed.subarray(NONCE_BYTES, sealed.length - TAG_BYTES)
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce))
    decipher.setAuthTag(Buffer.from(tag))
    return Buffer.concat([decipher.update(Buffer.from(body)), decipher.final()])
  } catch {
    return undefined
  }
}

export function signBytes(privateKey: KeyObject, data: Uint8Array): Buffer {
  return sign(null, Buffer.from(data), privateKey)
}

export function verifyBytes(publicKey: KeyObject, data: Uint8Array, signature: Uint8Array): boolean {
  try {
    return verify(null, Buffer.from(data), publicKey, Buffer.from(signature))
  } catch {
    return false
  }
}

// Canonical JSON: sorted keys, no whitespace. Both sides must sign and verify
// byte-identical payloads.
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`
}
