import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { app } from "electron"
import { decryptString } from "./secret-storage"
import { isEnterpriseSessionUrl } from "./enterprise"

export interface ControlPlaneAuth {
  readonly url: string
  readonly clientToken: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// auth.ts stores { url, clientToken, profile } in auth-session.json and may
// encrypt the whole document behind a `payload` field or just the client token.
function decodeSession(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined
  if (value.encrypted !== true) return value
  if (typeof value.payload === "string") {
    const decrypted = decrypt(value.payload)
    return decodeSession(decrypted)
  }
  if (typeof value.clientToken === "string") {
    const decrypted = decrypt(value.clientToken)
    if (decrypted === undefined) return undefined
    return { ...value, clientToken: decrypted }
  }
  return value
}

function decrypt(value: string): unknown {
  const text = decryptString(value)
  if (text === undefined) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim()
}

export function readAuthSession(): ControlPlaneAuth | undefined {
  const session = readSession()
  if (session === undefined) return undefined
  const url = firstString(session.controlPlaneUrl, session.url)
  const clientToken = firstString(session.clientToken, session.token)
  if (url === undefined || clientToken === undefined) return undefined
  const normalized = url.replace(/\/+$/, "")
  // A tenant client must not act on a credential minted by another server.
  if (!isEnterpriseSessionUrl(normalized)) return undefined
  return { url: normalized, clientToken }
}

/**
 * The signed-in profile id, which is what per-profile entitlements are keyed by.
 *
 * The control plane does not derive it from the client token, so a caller that
 * needs "whose plan is this" has to present it. GitHub ids are numeric and
 * Google subjects are decimal strings, so either accepted shape is returned as
 * text; the server treats the id as an opaque key.
 */
export function readSessionProfileId(): string | undefined {
  const session = readSession()
  if (session === undefined) return undefined
  const url = firstString(session.controlPlaneUrl, session.url)
  if (url === undefined || !isEnterpriseSessionUrl(url.replace(/\/+$/, ""))) return undefined
  const profile = session.profile
  if (typeof profile !== "object" || profile === null || Array.isArray(profile)) return undefined
  const id = (profile as { id?: unknown }).id
  if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) return String(id)
  return typeof id === "string" && id.trim().length > 0 ? id.trim() : undefined
}

function readSession(): Record<string, unknown> | undefined {
  const file = join(app.getPath("userData"), "auth-session.json")
  if (!existsSync(file)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return undefined
  }
  return decodeSession(parsed)
}
