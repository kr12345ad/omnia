// Stable browser failure codes and their transport-facing HTTP status. The
// server maps controller errors through this instead of returning 500 for
// everything.

import { CdpError } from "./cdp"
import { ImageFileError } from "./image-file"
import { BrowserUrlError } from "./url-policy"

export interface BrowserFailure {
  readonly code: string
  readonly message: string
  readonly httpStatus: number
  readonly retryable: boolean
}

export function browserFailure(error: unknown): BrowserFailure {
  const code = browserFailureCode(error)
  return {
    code,
    message: error instanceof Error ? error.message : "The browser action failed.",
    httpStatus: browserFailureStatus(code),
    retryable: isRetryable(code),
  }
}

export function browserFailureCode(error: unknown): string {
  if (error instanceof CdpError || error instanceof ImageFileError || error instanceof BrowserUrlError) {
    return error.code
  }
  // Remote runtimes report typed codes as a plain property because class
  // identity does not survive the channel; only known codes are trusted so a
  // spoofed code cannot surface an arbitrary message.
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code
    if (typeof code === "string" && KNOWN_BROWSER_CODES.has(code)) return code
  }
  return "browser_error"
}

const KNOWN_BROWSER_CODES = new Set([
  "already_connected",
  "activate_failed",
  "auth_required",
  // Billing refusals. 402 is "upgrade to get this", 503 is "the counter could
  // not be read, retry" - they are different failures and a caller recovers
  // from them differently.
  "billing_required",
  "billing_unavailable",
  "busy",
  "cdp_error",
  "connection_closed",
  "connection_failed",
  "dialog_mismatch",
  "dialog_not_open",
  "dialog_open",
  "download_failed",
  "download_timeout",
  "evaluate_failed",
  "file_chooser_open",
  "no_file_chooser",
  "upload_failed",
  "image_ambiguous",
  "image_not_found",
  "image_verify_failed",
  "invalid_action",
  "invalid_key",
  "invalid_params",
  "invalid_target",
  "launch_failed",
  "launch_timeout",
  "load_timeout",
  "marker_not_found",
  "no_auth_challenge",
  "auth_host_mismatch",
  "no_history",
  "no_tabs",
  "not_available",
  "not_connected",
  "not_running",
  "open_failed",
  "open_timeout",
  "path_blocked",
  "stale_element_reference",
  "stale_image_reference",
  "tab_limit",
  "tab_not_found",
  "timeout",
  "url_blocked",
])

export function browserFailureStatus(code: string): number {
  switch (code) {
    case "url_blocked":
    case "path_blocked":
    case "invalid_target":
    case "invalid_key":
    case "invalid_action":
    case "invalid_params":
    case "marker_not_found":
      return 400
    case "billing_required":
      return 402
    case "element_not_found":
    case "image_not_found":
    case "stale_element_reference":
    case "stale_image_reference":
    case "tab_not_found":
      return 404
    case "no_history":
    case "image_ambiguous":
    case "tab_limit":
    case "file_chooser_open":
    case "no_file_chooser":
    case "dialog_open":
    case "dialog_not_open":
    case "dialog_mismatch":
    case "no_auth_challenge":
    case "auth_host_mismatch":
    case "auth_required":
      return 409
    case "download_failed":
    case "upload_failed":
      return 502
    case "not_running":
    case "not_connected":
    case "not_available":
    case "connection_closed":
    case "connection_failed":
    case "open_failed":
    case "busy":
    case "activate_failed":
      return 503
    // A hard allowance that could not be checked is refused, not granted. It is
    // a 503 rather than a 402 because nothing is wrong with the caller's plan:
    // the store was unreadable, so retrying later is the correct response.
    case "billing_unavailable":
      return 503
    case "timeout":
    case "load_timeout":
    case "launch_timeout":
    case "launch_failed":
    case "open_timeout":
    case "download_timeout":
      return 504
    default:
      return 500
  }
}

function isRetryable(code: string): boolean {
  const status = browserFailureStatus(code)
  return status === 503 || status === 504
}
