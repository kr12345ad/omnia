import type { GitHubProfile } from "./github"

export const GOOGLE_OAUTH_AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth"
export const GOOGLE_OAUTH_TOKEN = "https://oauth2.googleapis.com/token"
export const GOOGLE_OAUTH_USERINFO = "https://openidconnect.googleapis.com/v1/userinfo"
export const GOOGLE_SCOPES = "openid email profile"
export const GOOGLE_CALLBACK_PATH = "/v1/auth/google/callback"

/**
 * The Google authorize URL. PKCE, state and an explicit account picker are part
 * of the flow rather than optional: the state is what binds the callback to the
 * desktop that started it, and `select_account` keeps a shared browser from
 * silently reusing whichever Google account was last signed in.
 */
export function googleAuthorizeUrl(input: {
  readonly clientId: string
  readonly redirectUri: string
  readonly state: string
  readonly challenge: string
}): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES,
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
    access_type: "online",
    prompt: "select_account",
  })
  return `${GOOGLE_OAUTH_AUTHORIZE}?${params.toString()}`
}

/**
 * Maps Google's OpenID Connect userinfo response onto the profile the control
 * plane stores.
 *
 * `sub` is the stable account id and is a decimal string wider than
 * Number.MAX_SAFE_INTEGER, so it stays text. The login is the local part of the
 * verified email address, which is what the account menu shows; an address
 * Google has not verified is dropped rather than displayed, leaving the
 * subject as the only name.
 */
export function googleProfileFromUserInfo(value: unknown): GitHubProfile | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const user = value as {
    sub?: unknown
    email?: unknown
    email_verified?: unknown
    name?: unknown
    picture?: unknown
  }
  if (typeof user.sub !== "string" || user.sub.trim().length === 0) return undefined
  const id = user.sub.trim()
  const verified = user.email_verified === true || user.email_verified === "true"
  const email = verified && typeof user.email === "string" && user.email.length > 0 ? user.email : undefined
  return {
    id,
    login: (email === undefined ? "" : email.split("@")[0]) || id,
    provider: "google",
    ...(typeof user.name === "string" && user.name.length > 0 ? { name: user.name } : {}),
    ...(typeof user.picture === "string" && user.picture.length > 0 ? { avatarUrl: user.picture } : {}),
    ...(email === undefined ? {} : { email }),
  }
}
