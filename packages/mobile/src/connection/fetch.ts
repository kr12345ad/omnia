/**
 * Connection primitives for Omnia Mobile.
 *
 * The chat surface already provides most of what mobile needs: ChatApi takes a
 * base URL and headers and preserves a deployment path prefix
 * (packages/app/src/chat/api.ts:52-58), and it throws ChatApiError carrying the
 * HTTP status (api.ts:36-43). Two things it cannot do are install a deadline on
 * its unary requests and tell a dead host from a browser CORS rejection, so both
 * live here instead of forking the API.
 */

export const DEFAULT_TIMEOUT_MS = 15_000
export const PROBE_TIMEOUT_MS = 5_000

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/** Every state the mobile connection layer can name. */
export const FAILURE_CODES = [
  "invalid_url",
  "unreachable",
  "timeout",
  "tls_error",
  "unauthorized",
  "forbidden",
  "cors_blocked",
  "not_omnia",
  "incompatible",
  "server_error",
  "host_offline",
  "session_not_found",
  "stream_lost",
  "no_models",
  "mixed_content",
  "cancelled",
] as const

export type FailureCode = (typeof FAILURE_CODES)[number]

/** What the failing request was doing, where that changes the diagnosis. */
export type Operation =
  | "health"
  | "location"
  | "models"
  | "sessions"
  | "messages"
  | "prompt"
  | "interrupt"
  | "rename"
  | "events"
  | "other"

export type RetryPolicy = "none" | "backoff" | "user"

export type ConnectionFailure = {
  code: FailureCode
  title: string
  detail: string
  action: string
  retry: RetryPolicy
  status?: number
}

type FailureCopy = Omit<ConnectionFailure, "code">

const FAILURE_COPY: Record<FailureCode, FailureCopy> = {
  invalid_url: {
    title: "That server address is not usable",
    detail: "Enter an address like http://192.168.1.20:4096, or the https tunnel address.",
    action: "Fix the address and try again.",
    retry: "user",
  },
  unreachable: {
    title: "Can't reach that computer",
    detail: "The phone could not open a connection to that address.",
    action: "Confirm Omnia is running, the port is right, and the phone is on the same network, VPN, or tunnel.",
    retry: "backoff",
  },
  host_offline: {
    title: "Your computer is offline",
    detail: "This device is already paired and the last session list is kept; the host stopped answering.",
    action: "Nothing to re-enter. Retrying continues while this screen is open.",
    retry: "backoff",
  },
  timeout: {
    title: "The computer took too long",
    detail: "The host did not answer within the time allowed.",
    action: "Try again; if it repeats, check the host's load or the tunnel.",
    retry: "backoff",
  },
  tls_error: {
    title: "Secure connection failed",
    detail: "The host's certificate was not accepted by this device.",
    action: "Use the https tunnel address, or install the host's certificate. Do not fall back to plain http remotely.",
    retry: "user",
  },
  unauthorized: {
    title: "Password rejected",
    detail: "The host answered and refused this credential (HTTP 401).",
    action: "Re-enter the server password. If it was rotated on the host, every paired device must update.",
    retry: "user",
  },
  forbidden: {
    title: "The host refused this request",
    detail: "HTTP 403 came back from the host or a proxy in front of it.",
    action: "Check the host's access policy or reverse proxy; this is not a wrong password.",
    retry: "user",
  },
  cors_blocked: {
    title: "This page can't talk to that host",
    detail:
      "The host answered, but the browser hid the response because this page's origin is not allowed. This is not a wrong password.",
    action:
      "Open Omnia's own mobile page from the host or tunnel, or start the server with --cors for this origin.",
    retry: "user",
  },
  not_omnia: {
    title: "That address isn't an Omnia server",
    detail: "Something answered, but /api/location or /api/health was missing or not Omnia's JSON.",
    action: "Check the host, port, and deployment path prefix.",
    retry: "user",
  },
  incompatible: {
    title: "This Omnia version is not supported",
    detail: "The host answered, but its chat endpoints are missing or shaped differently.",
    action: "Update the Omnia host, or point this app at a compatible server.",
    retry: "user",
  },
  server_error: {
    title: "The host reported an error",
    detail: "The host answered with an error status.",
    action: "Retry, then check the host's log if it keeps happening.",
    retry: "backoff",
  },
  session_not_found: {
    title: "That session is gone",
    detail: "The session was archived or deleted on the host.",
    action: "Go back to the session list and pick another.",
    retry: "user",
  },
  stream_lost: {
    title: "Live updates stopped",
    detail: "The host is reachable, but the event stream closed.",
    action: "Reconnecting happens automatically; sending a prompt still works.",
    retry: "backoff",
  },
  no_models: {
    title: "No chat model on the host",
    detail: "The host lists no chat-runnable model.",
    action: "Add an AI SDK model on the host, then reopen this screen.",
    retry: "user",
  },
  mixed_content: {
    title: "The browser blocked this address",
    detail: "An https page cannot call an http host.",
    action: "Use the https tunnel address for this host.",
    retry: "user",
  },
  cancelled: {
    title: "Cancelled",
    detail: "The request was cancelled before it finished.",
    action: "Nothing to do.",
    retry: "none",
  },
}

/** Copy for a code, optionally replacing the detail line with live context. */
export function describeFailure(code: FailureCode, detail?: string): ConnectionFailure {
  const copy = FAILURE_COPY[code]
  return { code, ...copy, detail: detail ?? copy.detail }
}

// ---------------------------------------------------------------------------
// Server URL normalization
// ---------------------------------------------------------------------------

export type ServerWarning = "insecure_transport"

export type NormalizedServer =
  | { ok: true; url: string; authToken?: string; warnings: ServerWarning[] }
  | { ok: false; failure: ConnectionFailure }

// Mirrors chatPageBase (packages/app/src/chat/server.ts:28-34): a URL copied
// from the address bar ends at an entry page, and the deployment prefix must
// survive while the entry name is removed.
const ENTRY_PAGE = /\/(?:chat(?:\.html)?|mobile(?:\.html)?|index\.html)\/?$/
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i

/**
 * Normalize what a person typed or pasted into the Pair screen.
 *
 * A bare host gets http:// (the LAN default). The entry page and its
 * ?auth_token are stripped, because ChatApi resolves every request against the
 * deployment base (api.ts:52-58) and entry.tsx already knows that query token
 * (entry.tsx:10-16, utils/server.ts:4-18). Credentials, unknown query strings,
 * and non-http schemes are rejected rather than guessed at.
 */
export function normalizeServerUrl(input: string): NormalizedServer {
  const raw = input.trim()
  if (!raw) return invalid("Enter the address the host showed you.")
  const value = SCHEME.test(raw) ? raw : `http://${raw}`

  let url: URL
  try {
    url = new URL(value)
  } catch {
    return invalid("That is not a URL. Enter host and port, for example 192.168.1.20:4096.")
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return invalid("Only http:// and https:// addresses are supported.")
  }
  if (!url.hostname) return invalid("The address has no host.")
  if (url.username || url.password) {
    return invalid("Remove the username and password from the address; enter the password separately.")
  }

  const token = url.searchParams.get("auth_token") ?? undefined
  if (token) url.searchParams.delete("auth_token")
  if (url.search) return invalid("Remove the query string from the address.")
  url.hash = ""

  url.pathname = url.pathname.replace(ENTRY_PAGE, "").replace(/\/+$/, "") || "/"
  const normalized = url.toString().replace(/\/+$/, "")

  const warnings: ServerWarning[] = []
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) warnings.push("insecure_transport")
  return { ok: true, url: normalized, authToken: token, warnings }

  function invalid(detail: string): NormalizedServer {
    return { ok: false, failure: describeFailure("invalid_url", detail) }
  }
}

function isLoopbackHost(hostname: string) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase()
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost")
}

/**
 * Chromium refuses an http request from an https page unless the target is
 * loopback. Detect it before probing: both the request and the probe would
 * otherwise reject and be misreported as unreachable.
 */
export function isMixedContent(pageUrl?: string, targetUrl?: string) {
  if (!pageUrl || !targetUrl) return false
  try {
    const page = new URL(pageUrl)
    const target = new URL(targetUrl)
    return page.protocol === "https:" && target.protocol === "http:" && !isLoopbackHost(target.hostname)
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Deadlines
// ---------------------------------------------------------------------------

export class FetchTimeoutError extends Error {
  readonly code = "timeout"
  readonly timeoutMs: number

  constructor(timeoutMs: number, cause?: unknown) {
    super(`Request timed out after ${timeoutMs}ms`, { cause })
    this.name = "TimeoutError"
    this.timeoutMs = timeoutMs
  }
}

export type TimeoutFetchOptions = {
  /** Milliseconds before the request is abandoned. 0 disables the deadline. */
  timeoutMs?: number
  fetch?: FetchLike
}

/**
 * Wrap fetch so unary ChatApi requests get a deadline without touching the API.
 * ChatApi takes the implementation in its constructor (api.ts:52-58).
 *
 * Event streams (ChatApi.events, api.ts:132-144) are exempt: they are
 * long-lived by design and already carry the caller's AbortSignal. An SSE
 * request here would otherwise be killed and silently reconnected every
 * DEFAULT_TIMEOUT_MS.
 */
export function createTimeoutFetch(options: TimeoutFetchOptions = {}): FetchLike {
  const base: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return async (input, init = {}) => {
    if (timeoutMs <= 0 || isEventStream(init.headers)) return base(input, init)

    const deadline = installDeadline(init.signal, timeoutMs)
    try {
      return await base(input, { ...init, signal: deadline.signal })
    } catch (error) {
      if (deadline.timedOut()) throw new FetchTimeoutError(timeoutMs, error)
      throw error
    } finally {
      deadline.cleanup()
    }
  }
}

function installDeadline(signal: AbortSignal | null | undefined, timeoutMs: number) {
  const controller = new AbortController()
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const forward = () => controller.abort(signal?.reason)
  if (signal?.aborted) forward()
  else signal?.addEventListener("abort", forward, { once: true })

  timer = setTimeout(() => {
    timedOut = true
    controller.abort(new FetchTimeoutError(timeoutMs))
  }, timeoutMs)

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup() {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener("abort", forward)
    },
  }
}

function isEventStream(headers: HeadersInit | undefined) {
  if (!headers) return false
  return (new Headers(headers).get("accept") ?? "").toLowerCase().includes("text/event-stream")
}

// ---------------------------------------------------------------------------
// Reachability probe
// ---------------------------------------------------------------------------

export type ProbeOutcome = "reachable" | "unreachable" | "skipped"

/**
 * An opaque no-cors GET answers one question: did the network reach the origin?
 *
 * A resolved response means yes, whatever the status — 401 and 500 are opaque
 * too. A rejection means DNS, connection, TLS, mixed-content, or the local
 * runtime refusing no-cors; it never means "the password is wrong". This is the
 * only browser-side way to separate a dead host from a CORS rejection, because
 * a normal fetch reports both as TypeError.
 *
 * Fails closed: if the runtime does not implement no-cors, the outcome is
 * unreachable and the classifier must never claim cors_blocked.
 */
export async function probeReachability(input: {
  baseUrl: string
  fetch?: FetchLike
  timeoutMs?: number
}): Promise<ProbeOutcome> {
  const fetcher: FetchLike = input.fetch ?? ((url, init) => globalThis.fetch(url, init))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? PROBE_TIMEOUT_MS)
  try {
    await fetcher(`${input.baseUrl.replace(/\/+$/, "")}/api/health`, {
      method: "GET",
      mode: "no-cors",
      credentials: "omit",
      cache: "no-store",
      redirect: "follow",
      signal: controller.signal,
    })
    return "reachable"
  } catch {
    return "unreachable"
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

export type FailureInput = {
  /** Override when the caller already knows the state (for example stream_lost). */
  code?: FailureCode
  detail?: string
  error?: unknown
  operation?: Operation
  probe?: ProbeOutcome
  /** True when this device paired successfully before; changes unreachable to host_offline. */
  remembered?: boolean
  pageUrl?: string
  targetUrl?: string
  health?: "ok" | "not_omnia" | "unknown"
  modelCount?: number
}

/**
 * Name a failure from the signals the chat surface already produces.
 *
 * Order matters: a CORS-blocked request and a dead host both reject with
 * TypeError, so the probe decides between them; an HTTP status always wins over
 * the probe because it is direct evidence. Timeouts are recognised before
 * aborts so the wrapper's deadline is not reported as a user cancel.
 */
export function classifyFailure(input: FailureInput = {}): ConnectionFailure {
  if (input.code) return describeFailure(input.code, input.detail)
  if (isMixedContent(input.pageUrl, input.targetUrl)) return describeFailure("mixed_content")

  const error = input.error
  if (error === undefined) {
    if (input.health === "not_omnia") return describeFailure("not_omnia")
    if (input.modelCount === 0) return describeFailure("no_models")
    return describeFailure("server_error", "No failure signal was captured.")
  }

  const status = httpStatus(error)
  if (status !== undefined) return fromStatus(status, input.operation)

  if (isTimeoutError(error)) {
    const ms = timeoutMsOf(error)
    return describeFailure("timeout", ms === undefined ? undefined : `No response within ${formatDuration(ms)}.`)
  }
  if (isAbortError(error)) return describeFailure("cancelled")

  const certificate = certificateCode(error)
  if (certificate) return describeFailure("tls_error", `The host's certificate failed validation (${certificate}).`)

  // A 2xx that is not JSON: proxy page, captive portal, or a different service.
  if (error instanceof SyntaxError) return describeFailure("not_omnia", "The host answered, but not with JSON.")

  if (isNetworkError(error)) {
    // The host answered the probe, so the origin is up; the stream itself died.
    if (input.operation === "events" && input.probe === "reachable") return describeFailure("stream_lost")
    if (input.probe === "reachable") return describeFailure("cors_blocked")
    return describeFailure(input.remembered ? "host_offline" : "unreachable")
  }

  return describeFailure("server_error", errorMessage(error))
}

function fromStatus(status: number, operation: Operation = "other"): ConnectionFailure {
  if (status === 401) return describeFailure("unauthorized")
  if (status === 403) return describeFailure("forbidden")
  if (status === 404) {
    return describeFailure(isSessionOperation(operation) ? "session_not_found" : "not_omnia")
  }
  if (status === 400 || status === 405 || status === 409 || status === 415 || status === 422 || status === 501) {
    return { ...describeFailure("incompatible", `HTTP ${status}.`), status }
  }
  return { ...describeFailure("server_error", `HTTP ${status}.`), status }
}

function isSessionOperation(operation: Operation | undefined) {
  return (
    operation === "messages" || operation === "prompt" || operation === "interrupt" || operation === "rename"
  )
}

function httpStatus(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined
  const status = error.status
  if (typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599) return undefined
  return status
}

function isTimeoutError(error: unknown) {
  if (error instanceof FetchTimeoutError) return true
  return isRecord(error) && error.name === "TimeoutError"
}

function isAbortError(error: unknown) {
  return isRecord(error) && error.name === "AbortError"
}

function isNetworkError(error: unknown) {
  return error instanceof TypeError || (isRecord(error) && error.name === "TypeError")
}

function timeoutMsOf(error: unknown) {
  return isRecord(error) && typeof error.timeoutMs === "number" ? error.timeoutMs : undefined
}

const CERTIFICATE = /(CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS|ALTNAME)/i

/** Node and Electron wrap the real socket error in `cause`; browsers hide it. */
function certificateCode(error: unknown, depth = 0): string | undefined {
  if (!isRecord(error) || depth > 4) return undefined
  if (typeof error.code === "string" && CERTIFICATE.test(error.code)) return error.code
  const cause = certificateCode(error.cause, depth + 1)
  if (cause) return cause
  if (Array.isArray(error.errors)) {
    for (const inner of error.errors) {
      const found = certificateCode(inner, depth + 1)
      if (found) return found
    }
  }
  return undefined
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message.slice(0, 200)
  if (isRecord(error) && typeof error.message === "string" && error.message) return error.message.slice(0, 200)
  return "The request failed for an unnamed reason."
}

function formatDuration(ms: number) {
  return ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms)}ms`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
