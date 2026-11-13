import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect, Stream } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { createHash } from "node:crypto"
import { ProxyUtil } from "../proxy-util"

let embeddedUIPromise: Promise<Record<string, string> | null> | undefined

export const UI_UPSTREAM = new URL("https://app.opencode.ai")

export const csp = (hash = "") =>
  `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'${hash ? ` 'sha256-${hash}'` : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: blob:; font-src 'self' data:; media-src 'self' data:; connect-src * data: blob:`
export const DEFAULT_CSP = csp()

export function themePreloadHash(body: string) {
  return body.match(/<script\b(?![^>]*\bsrc\s*=)[^>]*\bid=(['"])oc-theme-preload-script\1[^>]*>([\s\S]*?)<\/script>/i)
}

export function cspForHtml(body: string) {
  const match = themePreloadHash(body)
  return csp(match ? createHash("sha256").update(match[2]).digest("base64") : "")
}

function requestBody(request: HttpServerRequest.HttpServerRequest) {
  if (request.method === "GET" || request.method === "HEAD") return HttpBody.empty
  const len = request.headers["content-length"]
  return HttpBody.stream(request.stream, request.headers["content-type"], len === undefined ? undefined : Number(len))
}

function proxyResponseHeaders(headers: Record<string, string>) {
  const result = new Headers(headers)
  // FetchHttpClient exposes decoded response bodies, so forwarding upstream
  // transfer metadata makes browsers decode already-decoded assets again.
  result.delete("content-encoding")
  result.delete("content-length")
  result.delete("transfer-encoding")
  return result
}

export function upstreamURL(path: string) {
  return new URL(path, UI_UPSTREAM).toString()
}

// The upstream is a public CDN, so it never needs the caller's credentials. Strip
// them: `authorization` carries the server password (Basic auth or `auth_token`) and
// `cookie` carries the browser's cookies for this origin. Auth is already enforced by
// the router middleware before the UI fallback runs.
export function upstreamHeaders(input: HeadersInit) {
  const headers = ProxyUtil.headers(input, { host: UI_UPSTREAM.host })
  headers.delete("authorization")
  headers.delete("cookie")
  return headers
}

export function embeddedUI(disableEmbeddedWebUi: boolean) {
  if (disableEmbeddedWebUi) return Promise.resolve(null)
  return (embeddedUIPromise ??=
    // @ts-expect-error - generated file at build time
    import("opencode-web-ui.gen.ts").then((module) => module.default as Record<string, string>).catch(() => null))
}

function notFound() {
  return HttpServerResponse.jsonUnsafe({ error: "Not Found" }, { status: 404 })
}

function embeddedUIResponse(file: string, body: Uint8Array) {
  const mime = FSUtil.mimeType(file)
  const headers = new Headers({ "content-type": mime })
  if (mime.startsWith("text/html")) {
    headers.set("content-security-policy", cspForHtml(new TextDecoder().decode(body)))
  }
  return HttpServerResponse.raw(body, { headers })
}

export function serveEmbeddedUIEffect(
  requestPath: string,
  fs: FSUtil.Interface,
  embeddedWebUI: Record<string, string>,
  options: { chatOnly?: boolean } = {},
) {
  const key = requestPath.replace(/^\//, "")
  // Own-property lookup only: `constructor`, `toString`, `__proto__`, ... would otherwise
  // resolve to inherited members and be treated as asset entries.
  // The browser chat and mobile surfaces are extra Vite entries. Give them
  // friendly paths (`/chat`, `/mobile`) while keeping every other unknown path
  // on the full app. Without the mobile alias `/mobile` would miss the map and
  // fall back to `index.html`, silently loading the full workspace on a phone.
  // In chat-only mode the root entry is chat too, and an unknown path is a 404:
  // the chat page has no client-side routes, so falling back would load it
  // under a base that its API calls cannot resolve.
  const html =
    options.chatOnly && (key === "" || key === "index.html" || key === "chat.html")
      ? "chat.html"
      : key === "chat" || key === "chat/"
        ? "chat.html"
        : key === "mobile" || key === "mobile/"
          ? "mobile.html"
          : key
  const file =
    (Object.hasOwn(embeddedWebUI, html) ? embeddedWebUI[html] : undefined) ??
    (options.chatOnly ? undefined : embeddedWebUI["index.html"]) ??
    null
  if (!file) return Effect.succeed(notFound())

  return fs.readFile(file).pipe(
    Effect.map((body) => embeddedUIResponse(file, body)),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(notFound())),
  )
}

export function serveUIEffect(
  request: HttpServerRequest.HttpServerRequest,
  services: {
    fs: FSUtil.Interface
    client: HttpClient.HttpClient
    disableEmbeddedWebUi: boolean
    chatOnly?: boolean
  },
) {
  return Effect.gen(function* () {
    const embeddedWebUI = yield* Effect.promise(() => embeddedUI(services.disableEmbeddedWebUi))
    const path = new URL(request.url, "http://localhost").pathname

    if (embeddedWebUI) return yield* serveEmbeddedUIEffect(path, services.fs, embeddedWebUI, services)
    // The remote UI is the full workspace. Serving it here would silently
    // re-enable every agent surface that chat-only exists to leave out, so a
    // build without the embedded bundle refuses the page instead.
    if (services.chatOnly) {
      return HttpServerResponse.text("This build does not include the chat UI.", {
        status: 503,
        headers: { "content-type": "text/plain; charset=utf-8" },
      })
    }

    const response = yield* services.client.execute(
      HttpClientRequest.make(request.method)(upstreamURL(path), {
        headers: upstreamHeaders(request.headers),
        body: requestBody(request),
      }),
    )
    const headers = proxyResponseHeaders(response.headers)

    if (response.headers["content-type"]?.includes("text/html")) {
      const body = yield* response.text
      headers.set("Content-Security-Policy", cspForHtml(body))
      return HttpServerResponse.text(body, { status: response.status, headers })
    }

    headers.set("Content-Security-Policy", csp())
    return HttpServerResponse.stream(response.stream.pipe(Stream.catchCause(() => Stream.empty)), {
      status: response.status,
      headers,
    })
  })
}
