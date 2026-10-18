import { createHash, randomBytes, randomUUID } from "node:crypto"
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import type { EventBus } from "../server/events"
import {
  GOOGLE_CALLBACK_PATH,
  GOOGLE_OAUTH_TOKEN,
  GOOGLE_OAUTH_USERINFO,
  googleAuthorizeUrl,
  googleProfileFromUserInfo,
} from "./google"

export const GITHUB_OAUTH_AUTHORIZE = "https://github.com/login/oauth/authorize"
export const GITHUB_OAUTH_TOKEN = "https://github.com/login/oauth/access_token"
export const GITHUB_API_USER = "https://api.github.com/user"
export const GITHUB_API_EMAILS = "https://api.github.com/user/emails"
export const GITHUB_SCOPES = "read:user user:email"
// Retained for callers that re-export it; Omnia no longer signs in through the
// GitHub CLI.
export const GITHUB_CLI_CLIENT_ID = "178c6fc778ccc68e1d6a"
export const GITHUB_CALLBACK_PATH = "/v1/auth/github/callback"
export const GITHUB_AUTH_TIMEOUT_MS = 300000
export const GITHUB_CLIENT_TOKEN_BYTES = 32

export type AuthProvider = "github" | "google"

const PROVIDER_LABELS: Readonly<Record<AuthProvider, string>> = { github: "GitHub", google: "Google" }

export function isAuthProvider(value: unknown): value is AuthProvider {
  return value === "github" || value === "google"
}

export interface GitHubProfile {
  // GitHub's numeric id, or Google's `sub`, a decimal string wider than a safe
  // integer. Both are opaque keys; only the control plane compares them.
  readonly id: number | string
  readonly login: string
  // Absent on sessions stored before Google sign-in existed; those are GitHub.
  readonly provider?: AuthProvider
  readonly name?: string
  readonly avatarUrl?: string
  readonly email?: string
  readonly htmlUrl?: string
}

export interface GitHubAuthStatus {
  readonly authenticated: boolean
  readonly profile?: GitHubProfile
  readonly signedInAt?: number
  // GitHub OAuth client presence, kept for callers written before `providers`.
  readonly oauthClientConfigured: boolean
  // Which sign-in buttons the deployment can actually complete.
  readonly providers?: Readonly<Record<AuthProvider, boolean>>
}

export interface GitHubStartResult {
  readonly authorizeUrl: string
  readonly state: string
  readonly redirectUri: string
  readonly status: GitHubAuthStatus
}

export interface GitHubPollResult {
  readonly authenticated: boolean
  readonly profile?: GitHubProfile
  readonly clientToken?: string
  // Set when the callback was refused after the provider answered, so the app
  // stops waiting and shows the same reason the browser tab shows.
  readonly failure?: string
}

export type GitHubCallbackResult =
  | { readonly ok: true; readonly profile: GitHubProfile; readonly clientToken: string }
  | { readonly ok: false; readonly status: number; readonly title: string; readonly message: string }

export interface GitHubAuthOptions {
  readonly file?: string
  readonly clientsFile?: string
  readonly events?: EventBus
  readonly now?: () => number
  readonly fetchImpl?: typeof fetch
  readonly clientId?: string
  readonly clientSecret?: string
  readonly redirectUri?: string
  readonly googleClientId?: string
  readonly googleClientSecret?: string
  readonly googleRedirectUri?: string
  readonly publicUrl?: string
  readonly timeoutMs?: number
  readonly randomClientToken?: () => string
}

interface PendingFlow {
  readonly provider: AuthProvider
  readonly state: string
  readonly verifier: string
  readonly redirectUri: string
  readonly createdAt: number
  readonly expiresAt: number
  profile?: GitHubProfile
  clientToken?: string
  failure?: string
  delivered: boolean
}

// An email address belongs to exactly one provider account. The ledger keeps
// that decision across sign-outs, so the same person cannot come back with the
// other provider and end up on a second profile id - with none of the plan,
// usage or runs they paid for.
interface StoredIdentity {
  readonly email: string
  readonly provider: AuthProvider
  readonly id: number | string
  readonly login: string
}

const MAX_PENDING_FLOWS = 16
const MAX_CLIENT_TOKENS = 100

// Which credential a client token belongs to.
//
// "desktop" is minted by the human GitHub sign-in flow, so it is the signed-in
// person's own machine driving its own UI: it may read its credentials, memories
// and files, but it is still never an operator for global scope changes.
// "agent" is provisioned by an operator for automation and stays least
// privilege: every scoped action is gated and needs an explicit approval.
export type ClientTokenKind = "desktop" | "agent"

export class GitHubAuth {
  private readonly options: GitHubAuthOptions
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private storedOAuth?: { clientId: string; clientSecret?: string }
  private storedAuth?: StoredAuth
  private statusValue: GitHubAuthStatus
  private readonly pending = new Map<string, PendingFlow>()
  private readonly clientTokens = new Map<string, { profile: GitHubProfile; createdAt: number; kind: ClientTokenKind }>()
  private readonly identities = new Map<string, StoredIdentity>()
  private readonly clientsFile: string | undefined

  constructor(options: GitHubAuthOptions = {}) {
    this.options = options
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? Date.now
    // Client tokens are durable: a control-plane restart must not sign every
    // paired app out. They live beside the auth file unless overridden.
    this.clientsFile = options.clientsFile ?? (options.file === undefined ? undefined : `${options.file}.clients.json`)
    for (const entry of readStoredClientTokens(this.clientsFile)) this.clientTokens.set(entry.token, entry)
    const stored = readStoredAuth(options.file)
    for (const identity of readStoredIdentities(options.file)) this.identities.set(identity.email, identity)
    // A session written before the ledger existed is the record of which
    // provider owns its email, so seed from it on load.
    if (stored !== undefined) this.rememberIdentity(stored.profile)
    this.storedAuth = stored
    this.storedOAuth = stored?.oauth
    this.statusValue = {
      authenticated: stored !== undefined,
      ...(stored === undefined ? {} : { profile: stored.profile, signedInAt: stored.signedInAt }),
      oauthClientConfigured: this.hasOAuthClient(),
    }
  }

  status(): GitHubAuthStatus {
    return { ...this.statusValue, oauthClientConfigured: this.hasOAuthClient(), providers: this.providers() }
  }

  async start(method: string = "browser", provider: AuthProvider = "github"): Promise<GitHubStartResult> {
    const label = PROVIDER_LABELS[provider]
    if (method !== "browser") {
      throw new Error(`${label} sign-in method "${method}" is not supported; use the public browser callback.`)
    }
    const redirectUri = this.redirectUri(provider)
    if (redirectUri === undefined) {
      throw new Error(
        `${label} sign-in requires a public callback URL; set ${
          provider === "google" ? "OMNIA_GOOGLE_REDIRECT_URI" : "OMNIA_GITHUB_REDIRECT_URI"
        } or OMNIA_PUBLIC_URL.`,
      )
    }
    if (!this.hasOAuthClient(provider)) {
      throw new Error(
        provider === "google"
          ? "Google OAuth is not configured; set OMNIA_GOOGLE_CLIENT_ID and OMNIA_GOOGLE_CLIENT_SECRET."
          : "GitHub OAuth is not configured; set OMNIA_GITHUB_CLIENT_ID and OMNIA_GITHUB_CLIENT_SECRET.",
      )
    }
    const state = randomBytes(24).toString("hex")
    const verifier = base64url(randomBytes(48))
    const challenge = base64url(createHash("sha256").update(verifier).digest())
    this.trackPending({
      provider,
      state,
      verifier,
      redirectUri,
      createdAt: this.now(),
      expiresAt: this.now() + (this.options.timeoutMs ?? GITHUB_AUTH_TIMEOUT_MS),
      delivered: false,
    })
    return {
      authorizeUrl: this.authorizeUrl(provider, redirectUri, state, challenge),
      state,
      redirectUri,
      status: this.status(),
    }
  }

  async completeCallback(state: string, code: string): Promise<GitHubCallbackResult> {
    const flow = this.pendingFlow(state)
    if (flow === undefined) {
      return {
        ok: false,
        status: 400,
        title: "Sign-in expired",
        message: "This sign-in request is unknown or has expired. Start again from Omnia.",
      }
    }
    if (flow.profile !== undefined && flow.clientToken !== undefined) {
      return { ok: true, profile: flow.profile, clientToken: flow.clientToken }
    }
    const exchanged = await this.exchange(flow.provider, code, flow.verifier, flow.redirectUri)
    if ("message" in exchanged) {
      return { ok: false, status: 500, title: "Sign-in failed", message: exchanged.message }
    }
    const profile = await this.profileFromToken(flow.provider, exchanged.token).catch(() => undefined)
    if (profile === undefined) {
      return {
        ok: false,
        status: 500,
        title: "Sign-in failed",
        message: `${PROVIDER_LABELS[flow.provider]} did not return a usable profile. Close this tab and try again from Omnia.`,
      }
    }
    const conflict = this.identityConflict(profile)
    if (conflict !== undefined) {
      // The address is already somebody's account here: refuse instead of
      // replacing that session, and tell the app why it stopped waiting.
      flow.failure = conflict.message
      return { ok: false, status: 409, title: conflict.title, message: conflict.message }
    }
    this.complete(profile, exchanged.token)
    const clientToken = this.issueClientToken(profile, "desktop")
    flow.profile = profile
    flow.clientToken = clientToken
    return { ok: true, profile, clientToken }
  }

  poll(state: string): GitHubPollResult | undefined {
    const flow = this.pendingFlow(state)
    if (flow === undefined) return undefined
    if (flow.failure !== undefined) return { authenticated: false, failure: flow.failure }
    if (flow.profile === undefined || flow.clientToken === undefined) return { authenticated: false }
    const clientToken = flow.delivered ? undefined : flow.clientToken
    flow.delivered = true
    return {
      authenticated: true,
      profile: flow.profile,
      ...(clientToken === undefined ? {} : { clientToken }),
    }
  }

  isClientToken(token: string): boolean {
    return this.clientTokens.has(token)
  }

  // How the presented bearer must be treated downstream. undefined means the
  // token is not a client token at all.
  clientTokenKind(token: string): ClientTokenKind | undefined {
    return this.clientTokens.get(token)?.kind
  }

  /**
   * The profile a client token was minted for, if it is one.
   *
   * Billing attribution reads this rather than the server's own session: the
   * server can be signed in as one person while serving a desktop signed in as
   * another, and charging the server's profile for the desktop's purchase bills
   * the wrong human. The token is the most specific identity available.
   */
  clientTokenProfile(token: string): GitHubProfile | undefined {
    return this.clientTokens.get(token)?.profile
  }

  // The credential the signed-in person's own desktop runs on. Minted by the
  // GitHub sign-in flow; exposed so the flow and its tests share one path.
  mintDesktopToken(profile: GitHubProfile): string | undefined {
    return this.issueClientToken(profile, "desktop")
  }

  // Operator-gated provisioning: mint a durable client token for the signed-in
  // profile (or an explicitly provided one). These stay least privilege.
  mintClientToken(profile?: GitHubProfile): string | undefined {
    const target = profile ?? this.storedAuth?.profile
    if (target === undefined) return undefined
    return this.issueClientToken(target, "agent")
  }

  async logout(): Promise<void> {
    const stored = this.storedAuth
    this.pending.clear()
    this.clientTokens.clear()
    this.persistClientTokens()
    this.statusValue = { authenticated: false, oauthClientConfigured: this.hasOAuthClient() }
    this.storedAuth = undefined
    // The email ledger outlives the session on purpose: signing out must not
    // reopen the address to the other provider.
    this.persist()
    this.options.events?.emit("auth.signed_out", { data: { provider: stored?.profile.provider ?? "github" } })
  }

  redirectUri(provider: AuthProvider = "github"): string | undefined {
    const configured =
      provider === "google"
        ? this.options.googleRedirectUri ?? process.env.OMNIA_GOOGLE_REDIRECT_URI
        : this.options.redirectUri ?? process.env.OMNIA_GITHUB_REDIRECT_URI
    if (configured !== undefined && configured.trim().length > 0) return configured.trim()
    const publicUrl = this.options.publicUrl ?? process.env.OMNIA_PUBLIC_URL
    if (publicUrl === undefined || publicUrl.trim().length === 0) return undefined
    const path = provider === "google" ? GOOGLE_CALLBACK_PATH : GITHUB_CALLBACK_PATH
    return `${publicUrl.trim().replace(/\/+$/, "")}${path}`
  }

  saveOAuthClient(clientId: string, clientSecret?: string): GitHubAuthStatus {
    const trimmed = clientId.trim()
    if (trimmed.length === 0) throw new Error("A client ID is required.")
    this.storedOAuth = {
      clientId: trimmed,
      ...(clientSecret === undefined || clientSecret.trim().length === 0 ? {} : { clientSecret: clientSecret.trim() }),
    }
    this.persist()
    this.options.events?.emit("auth.oauth_client_saved", { data: { provider: "github" } })
    return this.status()
  }

  private authorizeUrl(provider: AuthProvider, redirectUri: string, state: string, challenge: string): string {
    if (provider === "google") {
      return googleAuthorizeUrl({ clientId: this.clientId("google"), redirectUri, state, challenge })
    }
    const params = new URLSearchParams({
      client_id: this.clientId("github"),
      redirect_uri: redirectUri,
      scope: GITHUB_SCOPES,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      allow_signup: "true",
    })
    return `${GITHUB_OAUTH_AUTHORIZE}?${params.toString()}`
  }

  private clientId(provider: AuthProvider = "github"): string {
    if (provider === "google") return this.options.googleClientId ?? process.env.OMNIA_GOOGLE_CLIENT_ID ?? ""
    return this.options.clientId ?? process.env.OMNIA_GITHUB_CLIENT_ID ?? this.storedOAuth?.clientId ?? ""
  }

  private clientSecret(provider: AuthProvider = "github"): string | undefined {
    if (provider === "google") return this.options.googleClientSecret ?? process.env.OMNIA_GOOGLE_CLIENT_SECRET
    return this.options.clientSecret ?? process.env.OMNIA_GITHUB_CLIENT_SECRET ?? this.storedOAuth?.clientSecret
  }

  private hasOAuthClient(provider: AuthProvider = "github"): boolean {
    return this.clientId(provider).length > 0
  }

  private providers(): Record<AuthProvider, boolean> {
    return { github: this.hasOAuthClient("github"), google: this.hasOAuthClient("google") }
  }

  private trackPending(flow: PendingFlow): void {
    if (this.pending.size >= MAX_PENDING_FLOWS) {
      const oldest = this.pending.keys().next().value
      if (oldest !== undefined) this.pending.delete(oldest)
    }
    this.pending.set(flow.state, flow)
  }

  private pendingFlow(state: string): PendingFlow | undefined {
    const flow = this.pending.get(state)
    if (flow === undefined) return undefined
    if (flow.expiresAt <= this.now()) {
      this.pending.delete(state)
      return undefined
    }
    return flow
  }

  private issueClientToken(profile: GitHubProfile, kind: ClientTokenKind): string {
    const token = this.options.randomClientToken?.() ?? randomBytes(GITHUB_CLIENT_TOKEN_BYTES).toString("hex")
    if (this.clientTokens.size >= MAX_CLIENT_TOKENS) {
      const oldest = this.clientTokens.keys().next().value
      if (oldest !== undefined) this.clientTokens.delete(oldest)
    }
    this.clientTokens.set(token, { profile, createdAt: this.now(), kind })
    this.persistClientTokens()
    return token
  }

  private persistClientTokens(): void {
    const file = this.clientsFile
    if (file === undefined) return
    try {
      if (this.clientTokens.size === 0) {
        rmSync(file, { force: true })
        return
      }
      const entries = [...this.clientTokens.entries()].map(([token, value]) => ({
        token,
        kind: value.kind,
        profile: value.profile,
        createdAt: value.createdAt,
      }))
      writeSecretFile(file, JSON.stringify(entries))
    } catch (error) {
      // A failed persist must never break sign-in; the tokens stay in memory.
      // It is logged because the usual cause is a hostile target (a symlink the
      // write refused) rather than a transient disk error.
      console.warn("Omnia could not persist the GitHub client tokens:", error)
    }
  }

  private async exchange(
    provider: AuthProvider,
    code: string,
    verifier: string,
    redirectUri: string,
  ): Promise<{ token: string } | { message: string }> {
    const body =
      provider === "google"
        ? new URLSearchParams({
            grant_type: "authorization_code",
            client_id: this.clientId("google"),
            code,
            redirect_uri: redirectUri,
            code_verifier: verifier,
          })
        : new URLSearchParams({
            client_id: this.clientId("github"),
            code,
            redirect_uri: redirectUri,
            code_verifier: verifier,
          })
    const secret = this.clientSecret(provider)
    if (secret !== undefined && secret.length > 0) body.set("client_secret", secret)
    const response = await this.fetchImpl(provider === "google" ? GOOGLE_OAUTH_TOKEN : GITHUB_OAUTH_TOKEN, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    })
    const payload = (await response.json()) as { access_token?: string; error?: string; error_description?: string }
    if (payload.access_token === undefined) {
      return {
        message:
          payload.error_description ?? payload.error ?? `${PROVIDER_LABELS[provider]} did not return an access token.`,
      }
    }
    return { token: payload.access_token }
  }

  private async profileFromToken(provider: AuthProvider, token: string): Promise<GitHubProfile> {
    if (provider === "google") {
      const response = await this.fetchImpl(GOOGLE_OAUTH_USERINFO, {
        headers: { accept: "application/json", authorization: `Bearer ${token}` },
      })
      if (!response.ok) throw new Error(`Google rejected the access token (HTTP ${response.status}).`)
      const profile = googleProfileFromUserInfo(await response.json())
      if (profile === undefined) throw new Error("Google returned an unexpected profile.")
      return profile
    }
    const headers = {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "omnia-desktop",
      "x-github-api-version": "2022-11-28",
    }
    const response = await this.fetchImpl(GITHUB_API_USER, { headers })
    if (!response.ok) throw new Error(`GitHub rejected the access token (HTTP ${response.status}).`)
    const user = (await response.json()) as {
      id?: number
      login?: string
      name?: string
      avatar_url?: string
      email?: string
      html_url?: string
    }
    if (typeof user.id !== "number" || typeof user.login !== "string") {
      throw new Error("GitHub returned an unexpected profile.")
    }
    const email = user.email ?? (await this.primaryEmail(headers))
    return {
      id: user.id,
      login: user.login,
      provider: "github",
      ...(user.name === undefined || user.name === null ? {} : { name: user.name }),
      ...(user.avatar_url === undefined ? {} : { avatarUrl: user.avatar_url }),
      ...(user.html_url === undefined ? {} : { htmlUrl: user.html_url }),
      ...(email === undefined ? {} : { email }),
    }
  }

  private async primaryEmail(headers: Record<string, string>): Promise<string | undefined> {
    const response = await this.fetchImpl(GITHUB_API_EMAILS, { headers }).catch(() => undefined)
    if (response === undefined || !response.ok) return undefined
    const emails = (await response.json().catch(() => [])) as Array<{ email?: string; primary?: boolean; verified?: boolean }>
    const primary = emails.find((entry) => entry.primary === true && entry.verified === true) ?? emails.find((entry) => entry.verified === true)
    return primary?.email
  }

  private identityConflict(profile: GitHubProfile): { title: string; message: string } | undefined {
    const email = emailKey(profile)
    if (email === undefined) return undefined
    const existing = this.identities.get(email)
    const provider = profile.provider ?? "github"
    if (existing === undefined || existing.provider === provider) return undefined
    const owner = PROVIDER_LABELS[existing.provider]
    return {
      title: "Email already in use",
      message: `This email address is already connected to a ${owner} account on Omnia. Continue with ${owner}, or use a different ${PROVIDER_LABELS[provider]} account.`,
    }
  }

  private rememberIdentity(profile: GitHubProfile): void {
    const email = emailKey(profile)
    if (email === undefined) return
    this.identities.set(email, { email, provider: profile.provider ?? "github", id: profile.id, login: profile.login })
  }

  private complete(profile: GitHubProfile, token: string): void {
    const signedInAt = this.now()
    this.rememberIdentity(profile)
    this.statusValue = { authenticated: true, profile, signedInAt, oauthClientConfigured: this.hasOAuthClient() }
    this.persist({ profile, token, signedInAt })
    this.options.events?.emit("auth.signed_in", {
      data: { provider: profile.provider ?? "github", login: profile.login, method: "oauth" },
    })
  }

  private persist(auth?: StoredAuth): void {
    if (auth !== undefined) this.storedAuth = auth
    if (this.options.file === undefined) return
    const identities = [...this.identities.values()]
    // Nothing left to remember: a signed-out deployment with no ledger has no
    // reason to keep an owner-only file of past credentials on disk.
    if (this.storedAuth === undefined && this.storedOAuth === undefined && identities.length === 0) {
      rmSync(this.options.file, { force: true })
      return
    }
    writeSecretFile(
      this.options.file,
      JSON.stringify({
        ...(this.storedAuth ?? {}),
        ...(this.storedOAuth === undefined ? {} : { oauth: this.storedOAuth }),
        ...(identities.length === 0 ? {} : { identities }),
      }),
    )
  }
}

// The auth and client-token files hold live OAuth credentials, so a target that
// is a symlink is refused instead of followed, and the bytes land in a fresh
// owner-only file that is renamed into place: a crash leaves the previous
// credentials or the new ones, never a world-readable half-write.
function writeSecretFile(file: string, contents: string): void {
  if (lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error(`Refusing to write ${file} through a symlink.`)
  }
  const directory = dirname(file)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporary = join(directory, `.${basename(file)}.${randomUUID()}.tmp`)
  try {
    // `wx` never follows an attacker-planted symlink, and 0600 never exposes the
    // credentials even for the instant the file exists.
    const handle = openSync(temporary, "wx", 0o600)
    try {
      writeFileSync(handle, contents)
      fsyncSync(handle)
    } finally {
      closeSync(handle)
    }
    // rename(2) inside one directory is atomic, so a crash or a full disk leaves
    // either the previous credentials or these, never a torn mix.
    renameSync(temporary, file)
  } catch (error) {
    // A temp file left behind is dead weight holding credentials; never keep one.
    try {
      unlinkSync(temporary)
    } catch {
      // Already gone, or the directory is gone with it.
    }
    throw error
  }
  // Rename keeps the temp file's mode, but an existing file may predate this
  // call with looser permissions.
  chmodSync(file, 0o600)
}

function base64url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

export function renderGitHubCallbackPage(title: string, message: string): string {
  const safeTitle = escapeHtml(title)
  const safeMessage = escapeHtml(message)
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${safeTitle}</title><style>
    :root { color-scheme: dark light; }
    body { font-family: system-ui, sans-serif; display: grid; place-items: center; min-height: 100vh; margin: 0; background: #0b0b0d; color: #f2f2f2; }
    main { max-width: 26rem; padding: 2rem; text-align: center; }
    h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
    p { color: #a0a0a8; margin: 0; }
  </style></head><body><main><h1>${safeTitle}</h1><p>${safeMessage}</p></main></body></html>`
}

export function defaultGitHubAuthFile(): string {
  return join(homedir(), ".local", "share", "omnia", "auth.json")
}

interface StoredAuth {
  profile: GitHubProfile
  token: string
  signedInAt: number
  oauth?: { clientId: string; clientSecret?: string }
}

function readStoredClientTokens(
  file?: string,
): Array<{ token: string; profile: GitHubProfile; createdAt: number; kind: ClientTokenKind }> {
  if (file === undefined || !existsSync(file)) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const entries: Array<{ token: string; profile: GitHubProfile; createdAt: number; kind: ClientTokenKind }> = []
  for (const value of parsed) {
    if (!isRecord(value) || typeof value.token !== "string") continue
    const profile = isRecord(value.profile) ? readProfile(value.profile) : undefined
    if (profile === undefined) continue
    entries.push({
      token: value.token,
      // Legacy rows predate token kinds. Every one of them was minted by the
      // GitHub sign-in flow (automation used the server token), so they are
      // desktop credentials and stay that way across restarts.
      kind: value.kind === "agent" ? "agent" : "desktop",
      createdAt: typeof value.createdAt === "number" ? value.createdAt : 0,
      profile,
    })
  }
  return entries
}

function readStoredAuth(file?: string): StoredAuth | undefined {
  if (file === undefined || !existsSync(file)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"))
  } catch {
    // A corrupt auth file must never take the server down; sign-in state
    // simply starts empty and the next write replaces the file.
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null) return undefined
  const record = parsed as Record<string, unknown>
  const profile = readProfile(record.profile)
  if (profile === undefined) return undefined
  return {
    profile,
    token: typeof record.token === "string" ? record.token : "",
    signedInAt: typeof record.signedInAt === "number" ? record.signedInAt : 0,
    ...(isRecord(record.oauth) && typeof record.oauth.clientId === "string"
      ? {
          oauth: {
            clientId: record.oauth.clientId,
            ...(typeof record.oauth.clientSecret === "string" ? { clientSecret: record.oauth.clientSecret } : {}),
          },
        }
      : {}),
  }
}

function emailKey(profile: GitHubProfile): string | undefined {
  const email = profile.email?.trim().toLowerCase()
  return email === undefined || email.length === 0 ? undefined : email
}

function readStoredIdentities(file?: string): StoredIdentity[] {
  if (file === undefined || !existsSync(file)) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return []
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.identities)) return []
  const identities: StoredIdentity[] = []
  for (const value of parsed.identities) {
    if (!isRecord(value)) continue
    if (typeof value.email !== "string") continue
    const email = value.email.trim().toLowerCase()
    const provider = readProvider(value.provider)
    const id = readProfileId(value.id)
    if (email.length === 0 || email.length > 320 || provider === undefined || id === undefined) continue
    identities.push({ email, provider, id, login: typeof value.login === "string" ? value.login : "" })
  }
  return identities
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

// GitHub ids are numbers and Google subjects are decimal strings; both are
// opaque keys, so either shape is accepted and kept verbatim.
function readProfileId(value: unknown): number | string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value
  if (typeof value === "string" && value.trim().length > 0 && value.length <= 128) return value.trim()
  return undefined
}

function readProvider(value: unknown): AuthProvider | undefined {
  return isAuthProvider(value) ? value : undefined
}

function readProfile(value: unknown): GitHubProfile | undefined {
  if (!isRecord(value)) return undefined
  const id = readProfileId(value.id)
  if (id === undefined || typeof value.login !== "string" || value.login.length === 0) return undefined
  const provider = readProvider(value.provider)
  return {
    id,
    login: value.login,
    ...(provider === undefined ? {} : { provider }),
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    ...(typeof value.avatarUrl === "string" ? { avatarUrl: value.avatarUrl } : {}),
    ...(typeof value.email === "string" ? { email: value.email } : {}),
    ...(typeof value.htmlUrl === "string" ? { htmlUrl: value.htmlUrl } : {}),
  }
}
