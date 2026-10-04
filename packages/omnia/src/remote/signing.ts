import { KeyObject, createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto"
import type { JsonWebKey } from "node:crypto"

export const REMOTE_REPLAY_WINDOW_MS = 60_000
export const REMOTE_KEY_ID_HEADER = "x-omnia-key-id"
export const REMOTE_TIMESTAMP_HEADER = "x-omnia-timestamp"
export const REMOTE_SIGNATURE_HEADER = "x-omnia-signature"

export type RemoteSigningKey = JsonWebKey | KeyObject

export interface RemoteSignatureInput {
  readonly method: string
  readonly path: string
  readonly timestampMs: number
  readonly body?: string | Uint8Array
}

export interface RemoteSignatureProof extends RemoteSignatureInput {
  readonly signature: string
}

export function hashRemoteBody(body?: string | Uint8Array): string {
  return createHash("sha256").update(body ?? "").digest("hex")
}

// The canonical form both sides sign is one field per line: uppercase method,
// request path including query, unix time in milliseconds, then the body
// SHA-256 hex. It is fixed here so client and server cannot drift.
export function remoteRequestDigest(input: RemoteSignatureInput): string {
  return [input.method.toUpperCase(), input.path, String(input.timestampMs), hashRemoteBody(input.body)].join("\n")
}

export function remoteRequestPath(url: string, baseUrl?: string): string {
  const parsed = new URL(url)
  const path = `${parsed.pathname}${parsed.search}`
  if (baseUrl === undefined || baseUrl.length === 0) return path
  // Hosted control planes live under a path prefix (e.g. /test1/omnia) that a
  // reverse proxy strips before the server verifies the signature, so the
  // signed path must be relative to the configured base URL.
  try {
    const basePath = new URL(baseUrl).pathname.replace(/\/+$/, "")
    if (basePath.length > 0 && path.startsWith(basePath)) return path.slice(basePath.length) || "/"
  } catch {
    // A malformed base falls back to signing the full path.
  }
  return path
}

export function signRemoteRequest(key: RemoteSigningKey, input: RemoteSignatureInput): string {
  const signature = sign(null, Buffer.from(remoteRequestDigest(input), "utf8"), privateKeyObject(key))
  return signature.toString("base64")
}

export function verifyRemoteSignature(key: RemoteSigningKey, proof: RemoteSignatureProof): boolean {
  const signature = Buffer.from(proof.signature, "base64")
  if (signature.length !== 64) return false
  try {
    return verify(null, Buffer.from(remoteRequestDigest(proof), "utf8"), publicKeyObject(key), signature)
  } catch {
    return false
  }
}

export function remoteAuthHeaders(input: {
  readonly token: string
  readonly computerId: string
  readonly method: string
  readonly url: string
  readonly timestampMs: number
  readonly keys: RemoteSigningKey
  readonly body?: string
  readonly baseUrl?: string
}): Record<string, string> {
  return {
    authorization: `Bearer ${input.token}`,
    [REMOTE_KEY_ID_HEADER]: input.computerId,
    [REMOTE_TIMESTAMP_HEADER]: String(input.timestampMs),
    [REMOTE_SIGNATURE_HEADER]: signRemoteRequest(input.keys, {
      method: input.method,
      path: remoteRequestPath(input.url, input.baseUrl),
      timestampMs: input.timestampMs,
      ...(input.body === undefined ? {} : { body: input.body }),
    }),
  }
}

function privateKeyObject(key: RemoteSigningKey): KeyObject {
  if (key instanceof KeyObject) return key
  return createPrivateKey({ key, format: "jwk" })
}

function publicKeyObject(key: RemoteSigningKey): KeyObject {
  if (key instanceof KeyObject) return key
  return createPublicKey({ key, format: "jwk" })
}
