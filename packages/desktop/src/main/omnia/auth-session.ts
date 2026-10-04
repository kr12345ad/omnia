import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { app } from "electron"
import { decryptString } from "./secret-storage"

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
  const file = join(app.getPath("userData"), "auth-session.json")
  if (!existsSync(file)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return undefined
  }
  const session = decodeSession(parsed)
  if (session === undefined) return undefined
  const url = firstString(session.controlPlaneUrl, session.url)
  const clientToken = firstString(session.clientToken, session.token)
  if (url === undefined || clientToken === undefined) return undefined
  return { url: url.replace(/\/+$/, ""), clientToken }
}
