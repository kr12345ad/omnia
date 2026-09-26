export const REDACTED = "[REDACTED]"
const defaultReplacement = REDACTED

export type SecretKind =
  | "authorization"
  | "password"
  | "api_key"
  | "token"
  | "jwt"
  | "private_key"
  | "connection_string"
  | "cookie"
  | "credential"
  | "query_parameter"
  | "url_credentials"

export interface RedactionOptions {
  readonly replacement?: string
  readonly keys?: readonly string[]
  readonly maxDepth?: number
}

export interface SecretFinding {
  readonly kind: SecretKind
  readonly path: string
}

const normalizeKey = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "")
const sensitiveKeys = new Set([
  "authorization",
  "proxyauthorization",
  "password",
  "passwd",
  "pwd",
  "secret",
  "clientsecret",
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "apikey",
  "apisecret",
  "accesskey",
  "accesskeyid",
  "secretaccesskey",
  "privatekey",
  "credentials",
  "credential",
  "cookie",
  "setcookie",
  "sessionkey",
  "connectionstring",
  "databaseurl",
  "dsn",
])
const sensitiveKeyPattern = /(?:password|passwd|secret|token|api.?key|access.?key|private.?key|credential|cookie|authorization)/i

const secretPatterns: readonly { readonly kind: SecretKind; readonly pattern: RegExp }[] = [
  { kind: "private_key", pattern: /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi },
  { kind: "authorization", pattern: /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi },
  { kind: "jwt", pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g },
  { kind: "api_key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { kind: "api_key", pattern: /\bsk-ant-[A-Za-z0-9_-]{12,}\b/g },
  { kind: "api_key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g },
  { kind: "api_key", pattern: /\bAIza[0-9A-Za-z_-]{20,}\b/g },
  { kind: "api_key", pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g },
  { kind: "token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: "token", pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{12,}\b/g },
]

const quotedAssignmentPattern = /(\b(?:password|passwd|pwd|secret|client[_-]?secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key|private[_-]?key|aws[_-]?secret[_-]?access[_-]?key|authorization|cookie|connection[_-]?string|database[_-]?url|dsn)\b\s*[:=]\s*)(["'])([^"']*)(\2)/gi
const assignmentPattern = /(\b(?:password|passwd|pwd|secret|client[_-]?secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key|private[_-]?key|aws[_-]?secret[_-]?access[_-]?key|authorization|cookie|connection[_-]?string|database[_-]?url|dsn)\b\s*[:=]\s*)([^\s,;"']+)/gi
const quotedExportPattern = /(\b(?:export\s+)?[A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|PRIVATE_KEY|CREDENTIAL)[A-Z0-9_]*\s*=\s*)(["'])([^"']*)(\2)/g
const exportPattern = /(\b(?:export\s+)?[A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|PRIVATE_KEY|CREDENTIAL)[A-Z0-9_]*\s*=\s*)([^\s"']+)/g
const queryPattern = /([?&](?:access[_-]?token|api[_-]?key|auth(?:orization)?|credential|key|password|secret|token)=)([^&#\s]*)/gi
const urlCredentialPattern = /(\b[a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi

const replacementFor = (options: RedactionOptions) => options.replacement ?? defaultReplacement
const safeFindingPath = (value: string, options: RedactionOptions) => redactText(value, options)

const isSensitiveKey = (key: string, options: RedactionOptions) => {
  const normalized = normalizeKey(key)
  return (
    sensitiveKeys.has(normalized) ||
    sensitiveKeyPattern.test(key) ||
    options.keys?.some((candidate) => normalizeKey(candidate) === normalized) === true
  )
}

const collectStringFindings = (value: string, path: string, options: RedactionOptions, findings: SecretFinding[]) => {
  if (isSensitiveKey(path.split(".").at(-1) ?? "", options)) findings.push({ kind: "credential", path: safeFindingPath(path, options) })
  for (const item of secretPatterns) {
    item.pattern.lastIndex = 0
    if (item.pattern.test(value)) findings.push({ kind: item.kind, path: safeFindingPath(path, options) })
  }
  if (queryPattern.test(value)) findings.push({ kind: "query_parameter", path: safeFindingPath(path, options) })
  if (urlCredentialPattern.test(value)) findings.push({ kind: "url_credentials", path: safeFindingPath(path, options) })
  if (assignmentPattern.test(value) || quotedAssignmentPattern.test(value)) findings.push({ kind: "credential", path: safeFindingPath(path, options) })
  queryPattern.lastIndex = 0
  urlCredentialPattern.lastIndex = 0
  assignmentPattern.lastIndex = 0
  quotedAssignmentPattern.lastIndex = 0
}

export function redactText(value: string, options: RedactionOptions = {}): string {
  if (typeof value !== "string" || value.length === 0) return value
  const replacement = replacementFor(options)
  let result = value
  for (const item of secretPatterns) {
    item.pattern.lastIndex = 0
    result = result.replace(item.pattern, replacement)
  }
  result = result.replace(quotedAssignmentPattern, (_match, prefix: string, quote: string) => `${prefix}${quote}${replacement}${quote}`)
  result = result.replace(assignmentPattern, (_match, prefix: string) => `${prefix}${replacement}`)
  result = result.replace(quotedExportPattern, (_match, prefix: string, quote: string) => `${prefix}${quote}${replacement}${quote}`)
  result = result.replace(exportPattern, (_match, prefix: string) => `${prefix}${replacement}`)
  result = result.replace(queryPattern, (_match, prefix: string) => `${prefix}${replacement}`)
  result = result.replace(urlCredentialPattern, (_match, prefix: string) => `${prefix}${replacement}:${replacement}@`)
  return result
}

export function redactUrl(value: string, options: RedactionOptions = {}): string {
  if (typeof value !== "string" || value.length === 0) return value
  try {
    const parsed = new URL(value)
    const replacement = replacementFor(options)
    if (parsed.username || parsed.password) {
      parsed.username = replacement
      parsed.password = replacement
    }
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (isSensitiveKey(key, options) || /(?:token|secret|password|key|auth|credential)/i.test(key)) {
        parsed.searchParams.set(key, replacement)
      }
    }
    if (parsed.hash) parsed.hash = redactText(parsed.hash.slice(1), options)
    return parsed
      .toString()
      .replaceAll(encodeURIComponent(replacement), replacement)
      .replaceAll(encodeURIComponent(replacement).replace(/%20/g, "+"), replacement)
  } catch {
    return redactText(value, options)
  }
}

export function redactHeaders(
  headers: Readonly<Record<string, string>> | Headers,
  options: RedactionOptions = {},
): Record<string, string> {
  const entries = headers instanceof Headers ? Array.from(headers.entries()) : Object.entries(headers)
  return Object.fromEntries(
    entries.map(([key, value]) => [key, isSensitiveKey(key, options) ? replacementFor(options) : redactText(value, options)]),
  )
}

const redactValue = (
  value: unknown,
  options: RedactionOptions,
  path: string,
  depth: number,
  seen: WeakSet<object>,
): unknown => {
  if (typeof value === "string") return redactText(value, options)
  if (value === null || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return value
  if (value === undefined) return undefined
  if (typeof value !== "object") return replacementFor(options)
  if (seen.has(value)) return "[Circular]"
  if (depth >= (options.maxDepth ?? 20)) return "[REDACTED_DEPTH]"
  seen.add(value)
  if (value instanceof Date) return new Date(value.getTime())
  if (value instanceof Map) {
    return Object.fromEntries(
      Array.from(value.entries()).map(([key, entry]) => {
        const keyText = String(key)
        return [
          redactText(keyText, options),
          isSensitiveKey(keyText, options)
            ? replacementFor(options)
            : redactValue(entry, options, `${path}.${keyText}`, depth + 1, seen),
        ]
      }),
    )
  }
  if (value instanceof Set) return Array.from(value, (entry) => typeof entry === "string" ? replacementFor(options) : redactValue(entry, options, `${path}[]`, depth + 1, seen))
  if (value instanceof URL) return redactUrl(value.toString(), options)
  if (value instanceof Error) return redactError(value, options)
  if (value instanceof Uint8Array) return replacementFor(options)
  if (Array.isArray(value)) return value.map((entry, index) => redactValue(entry, options, `${path}[${index}]`, depth + 1, seen))
  if (value instanceof Headers) return redactHeaders(value, options)
  const result: Record<string, unknown> = {}
  Object.keys(value).forEach((key) => {
    const childPath = path ? `${path}.${key}` : key
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !("value" in descriptor)) return
    Object.defineProperty(result, key, {
      value: isSensitiveKey(key, options)
        ? replacementFor(options)
        : redactValue(descriptor.value, options, childPath, depth + 1, seen),
      enumerable: true,
      configurable: true,
      writable: true,
    })
  })
  return result
}

export function redactSecrets<T>(value: T, options: RedactionOptions = {}): T {
  return redactValue(value, options, "", 0, new WeakSet<object>()) as T
}

export const redact = redactSecrets

export function redactObject(
  value: Readonly<Record<string, unknown>>,
  options: RedactionOptions = {},
): Record<string, unknown> {
  return redactValue(value, options, "", 0, new WeakSet<object>()) as Record<string, unknown>
}

export function redactError(error: Error, options: RedactionOptions = {}): Record<string, unknown> {
  return {
    name: redactText(error.name, options),
    message: redactText(error.message, options),
    ...(error.stack === undefined ? {} : { stack: redactText(error.stack, options) }),
  }
}

export function secretFindings(value: unknown, options: RedactionOptions = {}): readonly SecretFinding[] {
  const findings: SecretFinding[] = []
  const visit = (entry: unknown, path: string, depth: number, seen: WeakSet<object>) => {
    if (typeof entry === "string") {
      collectStringFindings(entry, path, options, findings)
      return
    }
    if (entry === null || typeof entry !== "object" || depth >= (options.maxDepth ?? 20) || seen.has(entry)) return
    seen.add(entry)
    if (Array.isArray(entry)) {
      entry.forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1, seen))
      return
    }
    if (entry instanceof URL) {
      collectStringFindings(entry.toString(), path, options, findings)
      return
    }
    if (entry instanceof Map) {
      entry.forEach((value, key) => visit(value, `${path}.${String(key)}`, depth + 1, seen))
      return
    }
    if (entry instanceof Set) {
      entry.forEach((value) => visit(value, `${path}[]`, depth + 1, seen))
      return
    }
    if (entry instanceof Error) {
      collectStringFindings(entry.message, path ? `${path}.message` : "message", options, findings)
      return
    }
    Object.keys(entry).forEach((key) => {
      const childPath = path ? `${path}.${key}` : key
      const descriptor = Object.getOwnPropertyDescriptor(entry, key)
      if (!descriptor || !("value" in descriptor)) return
      if (isSensitiveKey(key, options)) findings.push({ kind: "credential", path: safeFindingPath(childPath, options) })
      visit(descriptor.value, childPath, depth + 1, seen)
    })
  }
  visit(value, "", 0, new WeakSet<object>())
  return Object.freeze(findings)
}

export function containsSecret(value: unknown, options: RedactionOptions = {}): boolean {
  return secretFindings(value, options).length > 0
}

export const redactEnvironment = redactObject
export const redactSensitiveData = redactSecrets
export const redactSecretsIn = redactSecrets
export const findSecrets = secretFindings
export const hasSecret = containsSecret

export function redactRequest(
  request: Readonly<Record<string, unknown>>,
  options: RedactionOptions = {},
): Record<string, unknown> {
  return redactSecrets(request, options)
}

export function makeRedactor(options: RedactionOptions = {}) {
  return Object.freeze({
    text: (value: string) => redactText(value, options),
    object: (value: Readonly<Record<string, unknown>>) => redactObject(value, options),
    headers: (value: Readonly<Record<string, string>> | Headers) => redactHeaders(value, options),
    url: (value: string) => redactUrl(value, options),
    error: (value: Error) => redactError(value, options),
  })
}
