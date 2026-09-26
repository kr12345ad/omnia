import { isActionResult, isMetadata } from "../protocol"
import type {
  ActionError,
  ActionResult,
  ActionResultStatus,
  Metadata,
  Verification,
} from "../protocol"
import type { StructuredResultInput } from "./types"

export function createActionSuccess(
  actionId?: string,
  options: Omit<StructuredResultInput, "actionId"> = {},
): ActionResult {
  return {
    success: true,
    status: "success",
    ...(actionId === undefined ? {} : { actionId }),
    ...(options.message === undefined ? {} : { message: options.message }),
    ...(options.verification === undefined ? {} : { verification: options.verification }),
    ...(options.limitations === undefined ? {} : { limitations: options.limitations }),
    ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
  }
}

export const successResult = createActionSuccess
export const createResult = createActionSuccess
export const makeActionResult = normalizeActionResult

export function createActionFailure(
  code: string,
  message: string,
  options: StructuredResultInput = {},
): ActionResult {
  const status = statusForCode(code, options.status)
  const error: ActionError = options.error ?? { code, message, retryable: retryableForCode(code) }
  return {
    success: false,
    status,
    ...(options.actionId === undefined ? {} : { actionId: options.actionId }),
    message,
    verification: options.verification ?? {
      status: "failed",
      passed: false,
      verified: false,
      ok: false,
      method: "action",
      message,
    },
    error,
    ...(options.limitations === undefined ? {} : { limitations: options.limitations }),
    ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
  }
}

export const failureResult = createActionFailure
export const rejectedResult = (message: string, options: StructuredResultInput = {}) => createActionFailure("rejected", message, options)
export const unavailableResult = (message: string, options: StructuredResultInput = {}) => createActionFailure("unavailable", message, { ...options, status: "unavailable" })

export function normalizeActionResult(value: unknown, input: StructuredResultInput = {}): ActionResult {
  if (!isActionResult(value)) {
    return createActionFailure("invalid_result", "The action backend returned an invalid ActionResult.", input)
  }
  const status = value.status ?? (value.success ? "success" : "failed")
  const verification = input.verification ?? value.verification
  const metadata = mergeMetadata(value.metadata, input.metadata)
  return {
    ...value,
    status,
    ...(input.actionId === undefined ? {} : { actionId: input.actionId }),
    ...(verification === undefined ? {} : { verification }),
    ...(metadata === undefined ? {} : { metadata }),
  }
}

export const toActionResult = normalizeActionResult
export const structureActionResult = normalizeActionResult

export function applyVerification(
  result: ActionResult,
  verification: Verification,
  required = true,
): ActionResult {
  if (!required || verification.passed === true || verification.status === "passed" || verification.status === "success" || verification.status === "verified") {
    return { ...result, verification }
  }
  return {
    ...result,
    success: false,
    status: "failed",
    verification,
    error: {
      code: "verification_failed",
      message: verification.message ?? "The action result did not pass verification.",
      retryable: true,
    },
  }
}

export function isSuccessfulResult(result: ActionResult): boolean {
  return result.success && result.status !== "failed" && result.status !== "failure" && result.status !== "rejected" && result.status !== "unavailable" && result.status !== "error" && result.status !== "cancelled"
}

export function deterministicActionId(action: unknown): string {
  const input = typeof action === "string" ? action : safeStringify(action)
  let hash = 2166136261
  for (const character of input) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 16777619)
  }
  return `action-${(hash >>> 0).toString(16).padStart(8, "0")}`
}

export function mergeMetadata(...values: readonly (Metadata | undefined)[]): Metadata | undefined {
  const present = values.filter((value): value is Metadata => value !== undefined && isMetadata(value))
  if (present.length === 0) return undefined
  return Object.assign({}, ...present)
}

function statusForCode(code: string, requested: ActionResultStatus | undefined): ActionResultStatus {
  if (requested !== undefined) return requested
  if (code === "unavailable" || code === "driver_unavailable" || code === "operation_unavailable") return "unavailable"
  if (code === "rejected" || code === "target_stale" || code === "ambiguous_target" || code === "permission_required") return "rejected"
  if (code === "cancelled") return "cancelled"
  if (code === "partial") return "partial"
  return "failed"
}

function retryableForCode(code: string): boolean {
  return code === "timeout" || code === "temporary" || code === "verification_failed" || code === "target_stale"
}

function safeStringify(value: unknown, seen = new Set<object>()): string {
  if (value === null || typeof value !== "object") return String(value)
  if (seen.has(value)) return "[Circular]"
  seen.add(value)
  const result = Array.isArray(value)
    ? `[${value.map((item) => safeStringify(item, seen)).join(",")}]`
    : `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${safeStringify((value as Record<string, unknown>)[key], seen)}`).join(",")}}`
  seen.delete(value)
  return result
}
