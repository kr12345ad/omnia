import { existsSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { app, ipcMain, shell } from "electron"
import { osEncryptionAvailable, encryptString, readSecret, writeSecretFile } from "./secret-storage"
import { readControlPlaneUrl } from "./remote-agent"
import {
  enterpriseManifest,
  enterprisePolicy,
  enterpriseProfile,
  enterpriseServerUrl,
  isEnterpriseSessionUrl,
  type EnterpriseProfile,
} from "./enterprise"

// The hosted control plane this deployment signs in against when neither
// remote-agent-control-plane.json nor OMNIA_CONTROL_PLANE_URL provides one.
const DEFAULT_CONTROL_PLANE_URL = "https://openfoodpantry.org/test1/omnia"
const SIGN_IN_POLL_INTERVAL_MS = 1500
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000
const REQUEST_TIMEOUT_MS = 30 * 1000

export type AuthProvider = "github" | "google"

function isAuthProvider(value: unknown): value is AuthProvider {
  return value === "github" || value === "google"
}

const PROVIDER_LABELS: Readonly<Record<AuthProvider, string>> = { github: "GitHub", google: "Google" }

export interface GitHubProfile {
  // GitHub's numeric id, or Google's `sub`, a decimal string wider than a safe
  // integer. Both are opaque keys to the control plane.
  id: number | string
  login: string
  provider?: AuthProvider
  name?: string
  avatarUrl?: string
  email?: string
  htmlUrl?: string
}

/** How the credential was minted, so the account menu can name it honestly. */
export type AuthMethod = "oauth" | "gh" | "enterprise"

export interface GitHubAuthSession {
  url: string
  clientToken: string
  method?: AuthMethod
  profile?: GitHubProfile
}

export interface GitHubAuthStatus {
  authenticated: boolean
  profile?: GitHubProfile
  method?: AuthMethod
  controlPlaneUrl?: string
  /** True when this build is bound to an organization's control plane. */
  enterprise?: boolean
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
  provider?: AuthProvider
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

let signInInFlight: { provider: AuthProvider; promise: Promise<GitHubAuthStatus> } | undefined

function sessionFile(): string {
  return join(app.getPath("userData"), "auth-session.json")
}

function controlPlaneUrl(): string {
  const tenant = enterpriseServerUrl()
  if (tenant !== undefined) return tenant
  return readControlPlaneUrl() ?? DEFAULT_CONTROL_PLANE_URL
}

function readProfile(value: unknown): GitHubProfile | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const profile = value as Partial<GitHubProfile>
  const id = readProfileId(profile.id)
  if (id === undefined || typeof profile.login !== "string" || profile.login.length === 0) return undefined
  const provider = isAuthProvider(profile.provider) ? profile.provider : undefined
  return {
    id,
    login: profile.login,
    ...(provider === undefined ? {} : { provider }),
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
  // Sign-ins from another control plane are not this client's credentials.
  if (!isEnterpriseSessionUrl(session.url)) return undefined
  const profile = readProfile(session.profile)
  return {
    url: session.url,
    clientToken: session.clientToken,
    ...(isAuthMethod(session.method) ? { method: session.method } : {}),
    ...(profile === undefined ? {} : { profile }),
  }
}

function isAuthMethod(value: unknown): value is AuthMethod {
  return value === "oauth" || value === "gh" || value === "enterprise"
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
      ...(enterpriseProfile() === undefined ? {} : { enterprise: true }),
      ...(stored.issue === undefined ? {} : { issue: stored.issue }),
    }
  }
  return {
    authenticated: true,
    ...(session.profile === undefined ? {} : { profile: session.profile }),
    // Sessions written before the method was recorded are work-account sessions
    // in a tenant build and OAuth sessions everywhere else.
    method: session.method ?? (enterpriseProfile() === undefined ? "oauth" : "enterprise"),
    controlPlaneUrl: session.url,
    ...(enterpriseProfile() === undefined ? {} : { enterprise: true }),
    ...(stored.issue === undefined ? {} : { issue: stored.issue }),
  }
}

export function startSignIn(options: StartSignInOptions = {}): Promise<GitHubAuthStatus> {
  if (enterpriseProfile() !== undefined) {
    return Promise.reject(new Error("This client signs in with your work account, not GitHub or Google."))
  }
  const provider = isAuthProvider(options.provider) ? options.provider : "github"
  if (signInInFlight !== undefined) {
    // One browser flow at a time: the desktop polls a single control-plane
    // state, so a second provider clicked mid-flow would wait on the first.
    if (signInInFlight.provider === provider) return signInInFlight.promise
    throw new Error(`A ${PROVIDER_LABELS[signInInFlight.provider]} sign-in is already in progress.`)
  }
  const promise = runSignIn({ ...options, provider }).finally(() => {
    signInInFlight = undefined
  })
  signInInFlight = { provider, promise }
  return promise
}

export function signOut(): GitHubAuthStatus {
  persistAuthSession(undefined)
  return authStatus()
}

async function runSignIn(options: StartSignInOptions): Promise<GitHubAuthStatus> {
  const provider = isAuthProvider(options.provider) ? options.provider : "github"
  const label = PROVIDER_LABELS[provider]
  const url = controlPlaneUrl()
  const start = await postJson(`${url}/v1/auth/${provider}/start`, {})
  if (start.status >= 400) throw new ControlPlaneError(responseMessage(start.body, start.status), start.status)
  const authorizeUrl = field(start.body, "authorizeUrl")
  const state = field(start.body, "state")
  if (typeof authorizeUrl !== "string" || typeof state !== "string") {
    throw new Error(`The control plane did not return a ${label} sign-in URL.`)
  }
  if (!isHttpUrl(authorizeUrl)) throw new Error(`The control plane returned an invalid ${label} sign-in URL.`)
  await shell.openExternal(authorizeUrl)

  const interval = options.intervalMs ?? SIGN_IN_POLL_INTERVAL_MS
  const deadline = Date.now() + (options.timeoutMs ?? SIGN_IN_TIMEOUT_MS)
  while (Date.now() < deadline) {
    await sleep(interval)
    const poll = await postJson(`${url}/v1/auth/${provider}/poll`, { state }).catch(() => undefined)
    if (poll === undefined) continue
    if (poll.status >= 400) {
      if (isFatalPollStatus(poll.status))
        throw new ControlPlaneError(responseMessage(poll.body, poll.status), poll.status)
      continue
    }
    if (poll.body.authenticated !== true) continue
    return completeSignIn(url, poll.body)
  }
  throw new Error(`Timed out waiting for ${label} sign-in.`)
}

function completeSignIn(url: string, poll: Record<string, unknown>): GitHubAuthStatus {
  const clientToken = field(poll, "clientToken")
  if (typeof clientToken !== "string" || clientToken.length === 0) {
    throw new Error("The control plane completed the sign-in without a client token.")
  }
  const profile = readProfile(field(poll, "profile"))
  const session: GitHubAuthSession = {
    url,
    clientToken,
    method: "oauth",
    ...(profile === undefined ? {} : { profile }),
  }
  persistAuthSession(session)
  return {
    authenticated: true,
    ...(profile === undefined ? {} : { profile }),
    method: "oauth",
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

/**
 * Sign in with the work account the tenant server issued. The password never
 * touches the renderer's storage: only the client token returned here is kept.
 */
export async function enterpriseSignIn(identifier: string, password: string): Promise<GitHubAuthStatus> {
  const profile = requireEnterpriseProfile()
  if (profile.loginUrl.length === 0) {
    throw new Error("This installer is not bound to a server address. Install it from the enrollment file your administrator sent.")
  }
  if (identifier.trim().length === 0 || password.length === 0) {
    throw new Error("Enter your work email address or employee ID and your password.")
  }
  const response = await postJson(profile.loginUrl, { identifier: identifier.trim(), password })
  if (response.status >= 400 || response.body.ok !== true) {
    throw new ControlPlaneError(responseMessage(response.body, response.status), response.status)
  }
  const token = field(response.body, "token")
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("The server completed the sign-in without a client token.")
  }
  const user = field(response.body, "user")
  const record = typeof user === "object" && user !== null && !Array.isArray(user) ? (user as Record<string, unknown>) : {}
  const email = typeof record.email === "string" ? record.email : identifier.trim()
  const profileId = readProfileId(record.id) ?? email
  const name = typeof record.name === "string" && record.name.length > 0 ? record.name : email
  persistAuthSession({
    url: profile.server,
    clientToken: token,
    method: "enterprise",
    profile: { id: profileId, login: email, name, email },
  })
  // Pull the live rules now that this device is enrolled; the baked profile is
  // the fallback when the server is unreachable.
  void enterpriseManifest()
  return authStatus()
}

function requireEnterpriseProfile(): EnterpriseProfile {
  const profile = enterpriseProfile()
  if (profile === undefined) throw new Error("This build is not bound to an organization.")
  return profile
}

export function registerGitHubAuthIpcHandlers(): void {
  ipcMain.handle("omnia-auth-status", () => authStatus())
  ipcMain.handle("omnia-auth-sign-in", (_event, provider: unknown) =>
    startSignIn(isAuthProvider(provider) ? { provider } : {}),
  )
  ipcMain.handle("omnia-auth-sign-out", () => signOut())
  ipcMain.handle("omnia-enterprise-profile", () => enterpriseProfile())
  ipcMain.handle("omnia-enterprise-manifest", () => enterpriseManifest())
  ipcMain.handle("omnia-enterprise-policy", () => enterprisePolicy())
  ipcMain.handle("omnia-enterprise-sign-in", (_event, identifier: unknown, password: unknown) => {
    if (typeof identifier !== "string" || typeof password !== "string") {
      throw new Error("An email address or employee ID and a password are required.")
    }
    return enterpriseSignIn(identifier, password)
  })
}

function readProfileId(value: unknown): number | string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value
  if (typeof value === "string" && value.trim().length > 0 && value.length <= 128) return value.trim()
  return undefined
}
