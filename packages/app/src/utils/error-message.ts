import { createSignal } from "solid-js"
import type { dict } from "@/i18n/en"

type CopyKey = keyof typeof dict
type Translator = (key: CopyKey, params?: Record<string, string | number | boolean>) => string

/**
 * Failure text for the renderer. Electron wraps every rejected ipcMain.handle
 * promise as `Error invoking remote method 'channel': <text>` and transport
 * problems surface as bare runtime codes, so components map their errors here
 * instead of printing `error.message`: a known failure class resolves to
 * designed copy, copy the main process wrote for users is shown cleaned up,
 * and the untouched text is kept for the "copy details" affordance.
 */

const ELECTRON_INVOKE = /^Error invoking remote method '[^']*':\s*/

// Electron serializes a rejection as `Error: <message>`; the constructor name
// is not part of what the main process wrote for the user.
const ERROR_NAME = /^(?:[A-Za-z]*Error|Exception):\s+/

// A runtime fault ("TypeError: fetch failed", a stack frame) is never copy
// anyone wrote for a user, so it falls back to designed text instead.
const RUNTIME_FAULT =
  /^[A-Za-z]*(?:Error|Exception)\b|^(?:[A-Z][A-Z0-9_]{2,}):\s|(?:^|\s)at\s[\w.$<>[\]]+\s\(|node:internal|^(?:unexpected token|unexpected end|cannot read|cannot access|undefined is not|is not iterable|is not a function)\b/i

// Ordered: the first class that matches wins, so the specific wording of a
// main-process failure is never reclassified as a generic transport problem.
const FRIENDLY_FAILURES: readonly { readonly test: RegExp; readonly key: CopyKey }[] = [
  {
    test: /unexpected token '?<'?|unexpected end of json input|is not valid json/i,
    key: "error.common.unexpectedResponse",
  },
  {
    test: /sign in to omnia|sign in with git ?hub again|session expired|token expired|\bunauthorized\b|\b401\b/i,
    key: "error.common.unauthorized",
  },
  { test: /\bforbidden\b|\b403\b/i, key: "error.common.forbidden" },
  { test: /too many requests|rate limit|\b429\b/i, key: "error.common.rateLimited" },
  { test: /\b5\d\d\b|bad gateway|service unavailable|internal server error/i, key: "error.common.serviceUnavailable" },
  { test: /could not be found|is not found|\b404\b/i, key: "error.common.notFound" },
  { test: /pairing (?:code|failed)|no computer on this network/i, key: "error.common.pairingFailed" },
  { test: /did not start|restart the app to resume/i, key: "error.common.restartRequired" },
  { test: /clipboard|writetext/i, key: "error.common.clipboard" },
  { test: /no handler (?:registered )?for|not configured in this build/i, key: "error.common.unavailable" },
  {
    test: /fetch failed|failed to fetch|network ?(?:error|request)|socket hang up|net::ERR_|ENOTFOUND|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|getaddrinfo|unknown host|self signed|certificate/i,
    key: "error.common.offline",
  },
  { test: /timed out|timeout|ETIMEDOUT/i, key: "error.common.timeout" },
]

function messageOf(error: unknown): string {
  if (typeof error === "string") return error
  if (error instanceof Error) return error.message
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
    return error.message
  }
  return ""
}

function cleaned(error: unknown): string {
  let text = messageOf(error).trim()
  while (ELECTRON_INVOKE.test(text)) text = text.replace(ELECTRON_INVOKE, "").trim()
  return text.replace(ERROR_NAME, "").trim()
}

export function friendlyErrorMessage(error: unknown, translate: Translator, fallbackKey: CopyKey): string {
  const text = cleaned(error)
  const failure = FRIENDLY_FAILURES.find((candidate) => candidate.test.test(text))
  if (failure !== undefined) return translate(failure.key)
  // Anything left that reads as a sentence was written for the user; a bare
  // token is a code nobody can act on and gets the fallback copy.
  if (text.includes(" ") && !RUNTIME_FAULT.test(text)) return text
  return translate(fallbackKey)
}

// The untouched failure, stack included, for a bug report: the Electron channel
// name and the runtime class are the first thing support asks for.
export function rawErrorDetails(error: unknown): string {
  const text = messageOf(error).trim()
  if (error instanceof Error && typeof error.stack === "string" && error.stack.length > text.length) {
    return error.stack
  }
  return text
}

export function createErrorDetailsCopy() {
  const [copied, setCopied] = createSignal(false)

  const copy = async (error: unknown) => {
    const details = rawErrorDetails(error)
    if (details.length === 0) return
    try {
      await navigator.clipboard.writeText(details)
    } catch {
      return
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return { copied, copy }
}
