import { authFromToken, authTokenFromCredentials } from "@/utils/server"

/**
 * The chat page accepts an explicit `?server=` URL, then a host-injected
 * `__OMNIA_SERVER_URL__` (the same hook the full web app uses), then the dev
 * server default, and finally the origin it was served from.
 */
export function resolveChatServer(input: {
  param?: string | null
  injected?: unknown
  origin: string
  dev?: { host?: string; port?: string }
}) {
  return (
    httpUrl(input.param, input.origin) ??
    httpUrl(input.injected, input.origin) ??
    (input.dev ? httpUrl(`http://${input.dev.host ?? "localhost"}:${input.dev.port ?? "4096"}`) : undefined) ??
    httpUrl(input.origin) ??
    input.origin
  )
}

/**
 * The server base behind the chat page. A hosted deployment can mount the
 * server under a path prefix (for example /test1/omnia), where location.origin
 * drops the prefix. Remove only the page's own route so the prefix survives.
 */
export function chatPageBase(input: { origin: string; pathname: string }) {
  // A chat-only deployment may serve the same page at the root, /index.html,
  // /chat, or (for the mobile shell) /mobile; strip whichever entry name the
  // browser used so API calls keep the deployment prefix.
  const path = input.pathname.replace(/\/(?:chat(?:\.html)?|mobile(?:\.html)?|index\.html)?\/?$/, "/")
  return new URL(path, input.origin).toString().replace(/\/+$/, "")
}

export function chatAuthHeaders(token: string | null) {
  const auth = authFromToken(token)
  if (!auth) return
  return { Authorization: `Basic ${authTokenFromCredentials(auth)}` }
}

/**
 * Keeps the credential out of the address bar and out of shared links after the
 * first read. The caller has already captured it for this tab.
 */
export function clearChatAuthToken() {
  const params = new URLSearchParams(location.search)
  if (!params.has("auth_token")) return
  params.delete("auth_token")
  history.replaceState(null, "", location.pathname + (params.size ? `?${params}` : "") + location.hash)
}

function httpUrl(value: unknown, base?: string) {
  if (typeof value !== "string") return
  const trimmed = value.trim()
  if (!trimmed) return
  try {
    const url = new URL(trimmed, base)
    if (url.protocol !== "http:" && url.protocol !== "https:") return
    return url.toString().replace(/\/+$/, "")
  } catch {
    return
  }
}
