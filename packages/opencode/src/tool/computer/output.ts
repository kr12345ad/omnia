export const CAPS = {
  actText: 8000,
  actContextEntries: 12,
  credentialEntries: 20,
  capabilities: 200,
  doSteps: 200,
  errorDetails: 400,
  inspectChildren: 50,
  memoryText: 1000,
  observeControls: 120,
  observeWindows: 12,
  readText: 200000,
  screenshotBytes: 5 * 1024 * 1024,
  snapshotElements: 200,
  snapshotChars: 120000,
  superskillInstructions: 8000,
  superskillResult: 12000,
  visualText: 4000,
} as const

export function clip(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n… [truncated: ${text.length - max} of ${text.length} characters omitted]`
}

export function clipLines(lines: readonly string[], max: number): string[] {
  if (lines.length <= max) return [...lines]
  return [...lines.slice(0, max), `… [truncated: ${lines.length - max} of ${lines.length} lines omitted]`]
}

export interface FailureError {
  code?: string
  message?: string
  details?: Record<string, unknown> & { missing?: readonly string[] }
}

export function renderFailure(error: FailureError | undefined, fallback: string): string {
  if (error === undefined) return fallback
  const parts = [error.message ?? fallback]
  if (error.code !== undefined && error.code.length > 0) parts.push(`[${error.code}]`)
  const missing = error.details?.missing
  if (Array.isArray(missing) && missing.length > 0) {
    parts.push(`missing scopes: ${missing.join(", ")}; ask the user to approve them.`)
  }
  return parts.join(" ")
}

export function renderDetails(details: unknown, max: number): string | undefined {
  if (details === undefined || details === null) return undefined
  if (typeof details !== "object") return clip(String(details), max)
  const parts = Object.entries(details as Record<string, unknown>).flatMap(([key, value]) => {
    if (value === undefined) return []
    if (Array.isArray(value)) return [`${key}=[${value.map(formatDetailValue).join(", ")}]`]
    return [`${key}=${formatDetailValue(value)}`]
  })
  return parts.length === 0 ? undefined : clip(parts.join("; "), max)
}

function formatDetailValue(value: unknown): string {
  if (value === null) return "null"
  if (typeof value === "object") return JSON.stringify(value) ?? "null"
  return String(value)
}
