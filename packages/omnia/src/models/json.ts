import type { JsonObject, JsonValue } from "../protocol"

export type { JsonObject, JsonPrimitive, JsonValue, Metadata } from "../protocol"

export type ModelEndpoint = string | JsonObject

export const isRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function assertJsonValue(value: unknown, path = "$", seen = new Set<object>()): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return
  if (typeof value === "number") {
    if (Number.isFinite(value)) return
    throw new TypeError(`${path} must be JSON serializable`)
  }
  if (typeof value !== "object") throw new TypeError(`${path} must be JSON serializable`)
  if (!isRecord(value) && !Array.isArray(value)) throw new TypeError(`${path} must be JSON serializable`)
  if (seen.has(value)) throw new TypeError(`${path} must not contain cycles`)
  seen.add(value)
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`, seen))
    seen.delete(value)
    return
  }
  Object.entries(value).forEach(([key, item]) => assertJsonValue(item, `${path}.${key}`, seen))
  seen.delete(value)
}

export const isJsonValue = (value: unknown): value is JsonValue => {
  try {
    assertJsonValue(value)
    return true
  } catch {
    return false
  }
}

export const isJsonObject = (value: unknown): value is JsonObject =>
  isRecord(value) && Object.values(value).every((item) => isJsonValue(item))

export const isMetadata = (value: unknown): value is JsonObject => isJsonObject(value)

export const cloneJsonValue = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) return value.map((item) => cloneJsonValue(item))
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneJsonValue(item as JsonValue)]))
  }
  return value
}

export const compact = <T extends object>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined)) as T

const sensitiveKey =
  /^(?:api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|client[-_]?secret|password|private[-_]?key|secret|token)$/i

const containsSensitiveKey = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some((item) => containsSensitiveKey(item))
  if (!isRecord(value)) return false
  return Object.entries(value).some(([key, item]) => sensitiveKey.test(key) || containsSensitiveKey(item))
}

const safeCredentialReference = (value: unknown): value is JsonObject => {
  if (!isRecord(value) || value.kind !== "credential-reference" || typeof value.id !== "string") return false
  return !containsSensitiveKey(value)
}

export const redactSensitive = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item))
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => {
      if (key === "credential" && safeCredentialReference(item)) return [[key, item]]
      if (sensitiveKey.test(key)) return []
      return [[key, redactSensitive(item)]]
    }),
  )
}

export const serialize = (value: JsonValue): string => JSON.stringify(redactSensitive(value)) ?? ""
