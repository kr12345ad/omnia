import { existsSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { app, ipcMain, shell } from "electron"
import { osEncryptionAvailable, encryptString, readSecret, writeSecretFile } from "./secret-storage"
import { readControlPlaneUrl } from "./remote-agent"

// The hosted control plane this deployment signs in against when neither
// remote-agent-control-plane.json nor OMNIA_CONTROL_PLANE_URL provides one.
const DEFAULT_CONTROL_PLANE_URL = "https://openfoodpantry.org/test1/omnia"
const SIGN_IN_POLL_INTERVAL_MS = 1500
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000
const REQUEST_TIMEOUT_MS = 30 * 1000

export interface GitHubProfile {
  id: number
  login: string
  name?: string
  avatarUrl?: string
  email?: string
  htmlUrl?: string
}

export interface GitHubAuthSession {
  url: string
  clientToken: string
  profile?: GitHubProfile
}

export interface GitHubAuthStatus {
  authenticated: boolean
  profile?: GitHubProfile
  controlPlaneUrl?: string
  // Set when the stored credential could not be read or was stored in the clear,
  // so the UI can tell "signed out" apart from "signed in but unreadable".
  issue?: AuthStorageIssue
}

// `code` is the stable value for localized copy; `message` is the main-process
// fallback for surfaces that have no translation for it yet.
export interface AuthStorageIssue {
  code: "plaintext_storage" | "keychain_unavailable" | "session_unreadable"
  message: string
}

export interface StartSignInOptions {
  intervalMs?: number
  timeoutMs?: number
}

class ControlPlaneError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = "ControlPlaneError"
  }
}

let signInInFlight: Promise<GitHubAuthStatus> | undefined

function sessionFile(): string {
  return join(app.getPath("userData"), "auth-session.json")
}

function controlPlaneUrl(): string {
  return readControlPlaneUrl() ?? DEFAULT_CONTROL_PLANE_URL
}

function readProfile(value: unknown): GitHubProfile | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const profile = value as Partial<GitHubProfile>
  if (typeof profile.id !== "number" || typeof profile.login !== "string") return undefined
  return {
    id: profile.id,
    login: profile.login,
    ...(typeof profile.name === "string" ? { name: profile.name } : {}),
    ...(typeof profile.avatarUrl === "string" ? { avatarUrl: profile.avatarUrl } : {}),
    ...(typeof profile.email === "string" ? { email: profile.email } : {}),
    ...(typeof profile.htmlUrl === "string" ? { htmlUrl: profile.htmlUrl } : {}),
  }
}

function readSession(value: unknown): GitHubAuthSession | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const session = value as Partial<GitHubAuthSession>
  if (typeof session.url !== "string" || typeof session.clientToken !== "string") return undefined
  const profile = readProfile(session.profile)
  return {
    url: session.url,
    clientToken: session.clientToken,
    ...(profile === undefined ? {} : { profile }),
  }
}

export function loadAuthSession(): GitHubAuthSession | undefined {
  return readStoredSession().session
}

function readStoredSession(): { session?: GitHubAuthSession; issue?: AuthStorageIssue } {
  const file = sessionFile()
  if (!existsSync(file)) return {}
  let parsed: { encrypted?: unknown; payload?: unknown }
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as { encrypted?: unknown; payload?: unknown }
  } catch {
    return {}
  }
  if (parsed.encrypted !== true || typeof parsed.payload !== "string") {
    const session = readSession(parsed)
    if (session === undefined) return {}
    // A plaintext session (written before the keychain was available) is
    // upgraded to encrypted storage as soon as encryption is available; without
    // a keychain it can only be reported, never fixed.
    if (!osEncryptionAvailable()) {
      return {
        session,
        issue: {
          code: "plaintext_storage",
          message: "No system keychain is available, so this sign-in is stored unencrypted in an owner-only file.",
        },
      }
    }
    try {
      persistAuthSession(session)
    } catch {
      // Best effort: the plaintext session still works.
    }
    return { session }
  }
  const secret = readSecret(parsed.payload)
  if ("failure" in secret) {
    return {
      issue:
        secret.failure === "unavailable"
          ? {
              code: "keychain_unavailable",
              message: "No system keychain is available, so the stored sign-in cannot be read.",
            }
          : {
              code: "session_unreadable",
              message: "The stored sign-in can no longer be decrypted. Sign in again to restore it.",
            },
    }
  }
  try {
    const session = readSession(JSON.parse(secret.value))
    return session === undefined ? {} : { session }
  } catch {
    return {}
  }
}

export function persistAuthSession(session: GitHubAuthSession | undefined): void {
  const file = sessionFile()
  if (session === undefined) {
    rmSync(file, { force: true })
    return
  }
  const payload = encryptString(JSON.stringify(session))
  if (payload === undefined) {
    // Owner-only, but still plaintext on disk: never let that pass silently.
    console.warn("Omnia is storing the sign-in unencrypted because no system keychain is available.")
    writeSecretFile(file, JSON.stringify(session))
    return
  }
  writeSecretFile(file, JSON.stringify({ encrypted: true, payload }))
}

export function authStatus(): GitHubAuthStatus {
  const stored = readStoredSession()
  const session = stored.session
  if (session === undefined) {
    return {
      authenticated: false,
      controlPlaneUrl: controlPlaneUrl(),
      ...(stored.issue === undefined ? {} : { issue: stored.issue }),
    }
  }
  return {
    authenticated: true,
    ...(session.profile === undefined ? {} : { profile: session.profile }),
    controlPlaneUrl: session.url,
    ...(stored.issue === undefined ? {} : { issue: stored.issue }),
  }
}

export function startSignIn(options: StartSignInOptions = {}): Promise<GitHubAuthStatus> {
  if (signInInFlight !== undefined) return signInInFlight
  signInInFlight = runSignIn(options).finally(() => {
    signInInFlight = undefined
  })
  return signInInFlight
}

export function signOut(): GitHubAuthStatus {
  persistAuthSession(undefined)
  return authStatus()
}

async function runSignIn(options: StartSignInOptions): Promise<GitHubAuthStatus> {
  const url = controlPlaneUrl()
  const start = await postJson(`${url}/v1/auth/github/start`, {})
  if (start.status >= 400) throw new ControlPlaneError(responseMessage(start.body, start.status), start.status)
  const authorizeUrl = field(start.body, "authorizeUrl")
  const state = field(start.body, "state")
  if (typeof authorizeUrl !== "string" || typeof state !== "string") {
    throw new Error("The control plane did not return a GitHub sign-in URL.")
  }
  if (!isHttpUrl(authorizeUrl)) throw new Error("The control plane returned an invalid GitHub sign-in URL.")
  await shell.openExternal(authorizeUrl)

  const interval = options.intervalMs ?? SIGN_IN_POLL_INTERVAL_MS
  const deadline = Date.now() + (options.timeoutMs ?? SIGN_IN_TIMEOUT_MS)
  while (Date.now() < deadline) {
    await sleep(interval)
    const poll = await postJson(`${url}/v1/auth/github/poll`, { state }).catch(() => undefined)
    if (poll === undefined) continue
    if (poll.status >= 400) {
      if (isFatalPollStatus(poll.status))
        throw new ControlPlaneError(responseMessage(poll.body, poll.status), poll.status)
      continue
    }
    if (poll.body.authenticated !== true) continue
    return completeSignIn(url, poll.body)
  }
  throw new Error("Timed out waiting for GitHub sign-in.")
}

function completeSignIn(url: string, poll: Record<string, unknown>): GitHubAuthStatus {
  const clientToken = field(poll, "clientToken")
  if (typeof clientToken !== "string" || clientToken.length === 0) {
    throw new Error("The control plane completed the sign-in without a client token.")
  }
  const profile = readProfile(field(poll, "profile"))
  const session: GitHubAuthSession = { url, clientToken, ...(profile === undefined ? {} : { profile }) }
  persistAuthSession(session)
  return {
    authenticated: true,
    ...(profile === undefined ? {} : { profile }),
    controlPlaneUrl: url,
  }
}

async function postJson(url: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  return { status: response.status, body: parseJson(await response.text()) }
}

function parseJson(text: string): Record<string, unknown> {
  if (text.length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

// The control plane may return fields at the top level or wrapped in a result
// object, so accept either shape.
function field(body: Record<string, unknown>, key: string): unknown {
  if (body[key] !== undefined) return body[key]
  const result = body.result
  if (typeof result === "object" && result !== null && !Array.isArray(result)) {
    return (result as Record<string, unknown>)[key]
  }
  return undefined
}

function responseMessage(body: Record<string, unknown>, status: number): string {
  return typeof body.error === "string" ? body.error : `Request failed with HTTP ${status}.`
}

function isFatalPollStatus(status: number): boolean {
  if (status < 400 || status >= 500) return false
  return status !== 408 && status !== 429
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "https:" || url.protocol === "http:"
  } catch {
    return false
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function registerGitHubAuthIpcHandlers(): void {
  ipcMain.handle("omnia-auth-status", () => authStatus())
  ipcMain.handle("omnia-auth-sign-in", () => startSignIn())
  ipcMain.handle("omnia-auth-sign-out", () => signOut())
}
