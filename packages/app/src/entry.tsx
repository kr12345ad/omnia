// @refresh reload

import * as Sentry from "@sentry/solid"
import { render } from "solid-js/web"
import { AppBaseProviders, AppInterface } from "@/app"
import { loadInitialLocale } from "@/context/language"
import { type Platform, PlatformProvider } from "@/context/platform"
import { createBrowserDraftStore } from "@/utils/draft-store"
import { dict as en } from "@/i18n/en"
import { dict as zh } from "@/i18n/zh"
import { authFromToken } from "@/utils/server"
import pkg from "../package.json"
import { ServerConnection } from "./context/server"

const DEFAULT_SERVER_URL_KEY = "opencode.settings.dat:defaultServerUrl"

const getLocale = () => {
  if (typeof navigator !== "object") return "en" as const
  const languages = navigator.languages?.length ? navigator.languages : [navigator.language]
  for (const language of languages) {
    if (!language) continue
    if (language.toLowerCase().startsWith("zh")) return "zh" as const
  }
  return "en" as const
}

const getRootNotFoundError = () => {
  const key = "error.dev.rootNotFound" as const
  const locale = getLocale()
  return locale === "zh" ? (zh[key] ?? en[key]) : en[key]
}

const getStorage = (key: string) => {
  if (typeof localStorage === "undefined") return null
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const setStorage = (key: string, value: string | null) => {
  if (typeof localStorage === "undefined") return
  try {
    if (value !== null) {
      localStorage.setItem(key, value)
      return
    }
    localStorage.removeItem(key)
  } catch {
    return
  }
}

const readDefaultServerUrl = () => {
  const stored = getStorage(DEFAULT_SERVER_URL_KEY)
  if (!stored) return null
  try {
    const host = new URL(stored).hostname
    const current = location.hostname
    const isLoopback = (h: string) => h === "localhost" || h === "127.0.0.1" || h.startsWith("192.168.") || h.startsWith("10.")
    // A stale localhost backend (from local dev) must not stick to a hosted
    // deployment: fall back to the current origin in that case.
    if (isLoopback(host) && !isLoopback(current)) return null
  } catch {
    return null
  }
  return stored
}
const writeDefaultServerUrl = (url: string | null) => setStorage(DEFAULT_SERVER_URL_KEY, url)

const notify: Platform["notify"] = async (title, description, onClick) => {
  if (!("Notification" in window)) return

  const permission =
    Notification.permission === "default"
      ? await Notification.requestPermission().catch(() => "denied")
      : Notification.permission

  if (permission !== "granted") return

  const inView = document.visibilityState === "visible" && document.hasFocus()
  if (inView) return

  const notification = new Notification(title, {
    body: description ?? "",
    icon: "https://opencode.ai/favicon-96x96-v3.png",
  })

  notification.onclick = () => {
    window.focus()
    onClick?.()
    notification.close()
  }
}

const openExternal: Platform["openExternal"] = (value) => {
  if (!URL.canParse(value)) return
  const url = new URL(value)
  if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "mailto:") return
  window.open(url.href, "_blank", "noopener,noreferrer")
}

const restart: Platform["restart"] = async () => {
  window.location.reload()
}

const root = document.getElementById("root")
if (!(root instanceof HTMLElement) && import.meta.env.DEV) {
  throw new Error(getRootNotFoundError())
}

const getCurrentUrl = () => {
  // Hosted deployments inject the server base URL (e.g. a /test1/api path
  // behind a reverse proxy) because location.origin points at the site root.
  const injected = (globalThis as { __OMNIA_SERVER_URL__?: unknown }).__OMNIA_SERVER_URL__
  if (typeof injected === "string" && injected.length > 0) return injected
  if (location.hostname.includes("opencode.ai")) return "http://localhost:4096"
  if (import.meta.env.DEV)
    return `http://${import.meta.env.VITE_OPENCODE_SERVER_HOST ?? "localhost"}:${import.meta.env.VITE_OPENCODE_SERVER_PORT ?? "4096"}`
  // Hosted web deployment: the public server shares the domain.
  return "https://omnia.openfoodpantry.org"
}

const getDefaultUrl = () => {
  const lsDefault = readDefaultServerUrl()
  if (lsDefault) return lsDefault
  return getCurrentUrl()
}

const clearAuthToken = () => {
  const params = new URLSearchParams(location.search)
  if (!params.has("auth_token")) return
  params.delete("auth_token")
  history.replaceState(null, "", location.pathname + (params.size ? `?${params}` : "") + location.hash)
}

// Same logins as the desktop app. On the hosted domain the control plane sits
// next to the app at /test1/omnia on the same origin; anywhere else (local
// dev) use its absolute address.
const controlPlaneUrl = () => {
  const host = location.hostname
  if (
    host === "openfoodpantry.org" ||
    host.endsWith(".openfoodpantry.org") ||
    host === "localhost" ||
    host === "127.0.0.1" ||
    host.startsWith("192.168.") ||
    host.startsWith("10.")
  )
    return `${location.origin}/test1/omnia`
  return "https://openfoodpantry.org/test1/omnia"
}
const WEB_AUTH_KEY = "omnia.web.auth.v1"

const postJson = async (url: string, body: unknown) => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    // The control plane can take a while to answer when it is under load;
    // a 30s abort shows up as an aborted request in the browser.
    signal: AbortSignal.timeout(120_000),
  })
  const text = await response.text()
  let payload: Record<string, unknown> = {}
  try {
    payload = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  } catch {
    payload = {}
  }
  return { status: response.status, body: payload }
}

type WebAuthSession = {
  clientToken: string
  profile?: { id: number | string; login: string; provider?: "github" | "google"; name?: string; avatarUrl?: string; email?: string; htmlUrl?: string }
  controlPlaneUrl?: string
}

const readWebAuth = (): WebAuthSession | undefined => {
  const raw = getStorage(WEB_AUTH_KEY)
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw) as WebAuthSession
    return typeof parsed.clientToken === "string" && parsed.clientToken.length > 0 ? parsed : undefined
  } catch {
    return undefined
  }
}

const webAuthStatus = () => {
  const session = readWebAuth()
  if (!session) return { authenticated: false, method: "oauth" as const }
  return {
    authenticated: true,
    method: "oauth" as const,
    ...(session.profile ? { profile: session.profile } : {}),
    ...(session.controlPlaneUrl ? { controlPlaneUrl: session.controlPlaneUrl } : {}),
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const webSignIn = async (provider?: "github" | "google") => {
  const name = provider ?? "github"
  const base = controlPlaneUrl()
  // Open the tab synchronously: a window.open after an await is no longer
  // inside the click gesture and browsers block it as a popup. No noopener:
  // Chrome returns null for the handle then and the navigation never runs.
  const popup = window.open("about:blank", "_blank")
  if (!popup) throw new Error("Popup blocked. Allow popups for this site and retry sign-in.")
  let start: Awaited<ReturnType<typeof postJson>>
  try {
    start = await postJson(`${base}/v1/auth/${name}/start`, {})
    if (start.status >= 400 || typeof start.body.authorizeUrl !== "string" || typeof start.body.state !== "string")
      throw new Error(String(start.body.error ?? "Sign-in failed. Please retry."))
  } catch (error) {
    popup.close()
    throw error
  }
  const authorizeUrl = start.body.authorizeUrl
  const state = start.body.state
  if (typeof authorizeUrl !== "string" || typeof state !== "string") {
    popup.close()
    throw new Error("The control plane did not return a sign-in URL.")
  }
  popup.location.assign(authorizeUrl)
  const deadline = Date.now() + 5 * 60 * 1000
  while (Date.now() < deadline) {
    await sleep(1500)
    const poll = await postJson(`${base}/v1/auth/${name}/poll`, { state }).catch(() => undefined)
    if (!poll || poll.status >= 400 || poll.body.authenticated !== true) continue
    const clientToken = poll.body.clientToken
    if (typeof clientToken !== "string" || clientToken.length === 0)
      throw new Error("The control plane completed the sign-in without a client token.")
    const profileRaw = poll.body.profile as WebAuthSession["profile"]
    const session: WebAuthSession = {
      clientToken,
      ...(profileRaw ? { profile: profileRaw } : {}),
      controlPlaneUrl: base,
    }
    setStorage(WEB_AUTH_KEY, JSON.stringify(session))
    try {
      const tokenResponse = await fetch(`${base}/v1/auth/server/token`, {
        headers: { authorization: `Bearer ${clientToken}` },
        signal: AbortSignal.timeout(30_000),
      })
      const tokenBody = (await tokenResponse.json().catch(() => ({}))) as Record<string, unknown>
      const authToken = tokenBody.authToken
      if (typeof authToken === "string" && authToken.length > 0) {
        // Seed the opencode server connection the same way hosted users do:
        // a fresh load carrying auth_token authenticates every API call.
        const params = new URLSearchParams(location.search)
        params.set("auth_token", authToken)
        window.location.replace(`${location.pathname}?${params.toString()}`)
      }
    } catch {
      // No server token is provisioned for this account; login still stands.
    }
    return webAuthStatus()
  }
  throw new Error(`Timed out waiting for ${name === "google" ? "Google" : "GitHub"} sign-in.`)
}

const platform: Platform = {
  platform: "web",
  draftStore: createBrowserDraftStore(),
  version: pkg.version,
  openExternal,
  restart,
  notify,
  auth: {
    status: async () => webAuthStatus(),
    signIn: (provider) => webSignIn(provider),
    signOut: async () => {
      setStorage(WEB_AUTH_KEY, null)
      return webAuthStatus()
    },
  },
  getDefaultServer: async () => {
    const stored = readDefaultServerUrl()
    return stored ? ServerConnection.Key.make(stored) : null
  },
  setDefaultServer: writeDefaultServerUrl,
}

if (import.meta.env.VITE_SENTRY_DSN) {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    environment: import.meta.env.VITE_SENTRY_ENVIRONMENT ?? import.meta.env.MODE,
    release: import.meta.env.VITE_SENTRY_RELEASE ?? `web@${pkg.version}`,
    initialScope: {
      tags: {
        platform: "web",
      },
    },
    integrations: (integrations) => {
      return integrations.filter(
        (i) =>
          i.name !== "Breadcrumbs" && !(import.meta.env.OPENCODE_CHANNEL === "prod" && i.name === "GlobalHandlers"),
      )
    },
  })
}

if (root instanceof HTMLElement) {
  void loadInitialLocale().then((locale) => {
    const auth = authFromToken(new URLSearchParams(location.search).get("auth_token"))
    clearAuthToken()
    const server: ServerConnection.Http = {
      type: "http",
      authToken: !!auth,
      http: {
        url: getCurrentUrl(),
        ...auth,
      },
    }
    render(
      () => (
        <PlatformProvider value={platform}>
          <AppBaseProviders locale={locale}>
            <AppInterface
              defaultServer={ServerConnection.Key.make(getDefaultUrl())}
              canonicalLocalServer={ServerConnection.key(server)}
              servers={[server]}
              disableHealthCheck
            />
          </AppBaseProviders>
        </PlatformProvider>
      ),
      root,
    )
  })
}
