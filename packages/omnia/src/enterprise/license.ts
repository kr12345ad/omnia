// Offline license verification for self-hosted enterprise deployments.
//
// A license is an Ed25519-signed JSON payload. The vendor signs, the customer
// verifies with a public key the operator supplies at install time. This file
// never holds a private key and never phones home: an air-gapped deployment can
// verify its license with no network access, which is the point.
//
// Format: `omnia_lic_<base64url(payload)>.<base64url(signature)>`
// The payload is signed as raw bytes, exactly as transmitted.

import { createPublicKey, verify } from "node:crypto"
import type { LicenseClaims, LicenseState } from "./types"

export const LICENSE_PREFIX = "omnia_lic_"

// 32 MiB of JSON is far more than a license and keeps a hostile token bounded.
const MAX_LICENSE_BYTES = 32 * 1024

export interface LicenseVerification {
  valid: boolean
  claims?: LicenseClaims
  error?: string
}

export function verifyLicense(token: string, publicKeyPem: string, now: number): LicenseVerification {
  if (typeof token !== "string" || token.length === 0) return { valid: false, error: "A license token is required." }
  if (token.length > MAX_LICENSE_BYTES) return { valid: false, error: "The license token is too large." }
  if (!token.startsWith(LICENSE_PREFIX)) return { valid: false, error: "This is not an Omnia license token." }
  const body = token.slice(LICENSE_PREFIX.length)
  const separator = body.indexOf(".")
  if (separator <= 0 || separator === body.length - 1) return { valid: false, error: "The license is not signed." }
  const payload = Buffer.from(body.slice(0, separator), "base64url")
  const signature = Buffer.from(body.slice(separator + 1), "base64url")
  if (payload.length === 0 || signature.length === 0) return { valid: false, error: "The license is not signed." }

  const key = parsePublicKey(publicKeyPem)
  if (key === undefined) return { valid: false, error: "The configured license public key is not a valid Ed25519 key." }
  const verified = verify(null, payload, key, signature)
  if (!verified) return { valid: false, error: "The license signature does not verify." }

  const claims = parseClaims(payload)
  if (claims === undefined) return { valid: false, error: "The license payload is malformed." }
  if (claims.expiresAt <= now) return { valid: false, claims, error: "The license has expired." }
  if (claims.issuedAt > now + 24 * 60 * 60 * 1000) return { valid: false, claims, error: "The license was issued in the future." }
  return { valid: true, claims }
}

export function licenseState(token: string | undefined, publicKeyPem: string | undefined, now: number): LicenseState {
  if (token === undefined || token.length === 0) return { error: "No license is installed." }
  if (publicKeyPem === undefined || publicKeyPem.trim().length === 0) {
    return { token, error: "No license public key is configured." }
  }
  const result = verifyLicense(token, publicKeyPem, now)
  return {
    token,
    ...(result.claims === undefined ? {} : { claims: result.claims }),
    verifiedAt: now,
    ...(result.valid ? {} : { error: result.error }),
  }
}

function parsePublicKey(pem: string) {
  try {
    return createPublicKey(pem)
  } catch {
    return undefined
  }
}

function parseClaims(payload: Buffer): LicenseClaims | undefined {
  let value: unknown
  try {
    value = JSON.parse(payload.toString("utf8"))
  } catch {
    return undefined
  }
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  if (record.version !== 1) return undefined
  if (typeof record.id !== "string" || record.id.length === 0 || record.id.length > 128) return undefined
  if (typeof record.org !== "string" || record.org.length === 0 || record.org.length > 200) return undefined
  if (record.plan !== "business" && record.plan !== "enterprise") return undefined
  if (!Number.isSafeInteger(record.seats) || (record.seats as number) < 1) return undefined
  if (!Number.isFinite(record.issuedAt) || !Number.isFinite(record.expiresAt)) return undefined
  if ((record.expiresAt as number) <= (record.issuedAt as number)) return undefined
  const features =
    Array.isArray(record.features) && record.features.every((entry) => typeof entry === "string")
      ? (record.features as string[])
      : undefined
  return {
    version: 1,
    id: record.id,
    org: record.org,
    plan: record.plan,
    seats: record.seats as number,
    issuedAt: record.issuedAt as number,
    expiresAt: record.expiresAt as number,
    ...(features === undefined ? {} : { features }),
  }
}

/** The plan the org is allowed to use: a valid license's, otherwise the trial. */
export function licensedPlan(state: LicenseState, now: number, trialEndsAt: number): "business" | "enterprise" | "trial" | "expired" {
  if (state.claims !== undefined && state.error === undefined && state.claims.expiresAt > now) return state.claims.plan
  if (now < trialEndsAt) return "trial"
  return "expired"
}
