import type { Sensitivity } from "./contracts"
import { deepFreeze, freezeClone } from "./events"

export const MEMORY_SCOPES = ["run", "session", "workspace", "global"] as const
export type MemoryScope = (typeof MEMORY_SCOPES)[number]

export const MEMORY_SENSITIVITIES = ["public", "internal", "sensitive", "secret"] as const
export type MemorySensitivity = Sensitivity

export interface MemoryPolicy {
  readonly scopes: readonly MemoryScope[]
  readonly minConfidence: number
  readonly maxItems: number
  readonly maxAgeMs?: number
  readonly allowSensitive: boolean
  readonly allowSecrets: boolean
  readonly maxSensitivity: MemorySensitivity
}

export const DEFAULT_MEMORY_POLICY: MemoryPolicy = deepFreeze({
  scopes: [...MEMORY_SCOPES],
  minConfidence: 0,
  maxItems: 1000,
  allowSensitive: false,
  allowSecrets: false,
  maxSensitivity: "internal",
})

export interface MemoryRecord {
  readonly id: string
  readonly key: string
  readonly value: unknown
  readonly scope: MemoryScope
  readonly sensitivity: MemorySensitivity
  readonly confidence: number
  readonly createdAt: number
  readonly expiresAt?: number
  readonly updatedAt: number
  readonly sourceRunID?: string
  readonly tags: readonly string[]
}

export interface MemoryWrite {
  readonly id?: string
  readonly key: string
  readonly value: unknown
  readonly scope: MemoryScope
  readonly sensitivity: MemorySensitivity
  readonly confidence: number
  readonly createdAt?: number
  readonly expiresAt?: number
  readonly sourceRunID?: string
  readonly tags?: readonly string[]
}

export interface MemoryReadOptions {
  readonly now?: number
  readonly minConfidence?: number
  readonly limit?: number
}

export class MemoryPolicyError extends Error {
  readonly code: "scope" | "sensitivity" | "confidence" | "expiration" | "limit" | "invalid"

  constructor(code: MemoryPolicyError["code"], message: string) {
    super(message)
    this.name = "MemoryPolicyError"
    this.code = code
  }
}

export class MemoryStore {
  readonly policy: MemoryPolicy
  private readonly records = new Map<string, MemoryRecord>()
  private readonly now: () => number

  constructor(policy: MemoryPolicy = DEFAULT_MEMORY_POLICY, now: () => number = Date.now) {
    this.policy = deepFreeze({ ...policy, scopes: [...policy.scopes] })
    this.now = now
    if (policy.minConfidence < 0 || policy.minConfidence > 1) {
      throw new RangeError("minConfidence must be between zero and one")
    }
    if (!Number.isInteger(policy.maxItems) || policy.maxItems < 0) {
      throw new RangeError("maxItems must be a non-negative integer")
    }
  }

  write(input: MemoryWrite): MemoryRecord {
    const now = this.now()
    const createdAt = input.createdAt ?? now
    this.validateWrite(input, now, createdAt)
    const existing = [...this.records.values()].find(
      (record) => record.scope === input.scope && record.key === input.key,
    )
    if (!existing && this.records.size >= this.policy.maxItems) this.removeExpired(now)
    if (!existing && this.records.size >= this.policy.maxItems) {
      throw new MemoryPolicyError("limit", "memory item limit reached")
    }
    const record = deepFreeze({
      id: input.id ?? existing?.id ?? `memory_${this.records.size + 1}`,
      key: input.key,
      value: freezeClone(input.value),
      scope: input.scope,
      sensitivity: input.sensitivity,
      confidence: input.confidence,
      createdAt: existing?.createdAt ?? createdAt,
      expiresAt: input.expiresAt,
      updatedAt: now,
      sourceRunID: input.sourceRunID,
      tags: input.tags ? [...input.tags].toSorted() : [],
    })
    if (existing) this.records.delete(`${existing.scope}:${existing.key}`)
    this.records.set(`${record.scope}:${record.key}`, record)
    return record
  }

  get(scope: MemoryScope, key: string, now = this.now()): MemoryRecord | undefined {
    const record = this.records.get(`${scope}:${key}`)
    if (!record || !isVisible(record, this.policy, now)) return undefined
    return record
  }

  list(scope: MemoryScope, options: MemoryReadOptions = {}): readonly MemoryRecord[] {
    const now = options.now ?? this.now()
    const minimum = Math.max(this.policy.minConfidence, options.minConfidence ?? 0)
    const limit = options.limit === undefined ? undefined : Math.max(0, Math.floor(options.limit))
    if (limit === 0) return Object.freeze([])
    return Object.freeze(
      [...this.records.values()]
        .filter(
          (record) => record.scope === scope && record.confidence >= minimum && isVisible(record, this.policy, now),
        )
        .toSorted((left, right) => right.updatedAt - left.updatedAt || left.key.localeCompare(right.key))
        .slice(0, limit),
    )
  }

  delete(scope: MemoryScope, key: string): boolean {
    return this.records.delete(`${scope}:${key}`)
  }

  clear(scope?: MemoryScope): void {
    if (scope === undefined) {
      this.records.clear()
      return
    }
    for (const [id, record] of this.records) if (record.scope === scope) this.records.delete(id)
  }

  snapshot(now = this.now()): readonly MemoryRecord[] {
    return Object.freeze(
      [...this.records.values()]
        .filter((record) => isVisible(record, this.policy, now))
        .toSorted((left, right) => left.scope.localeCompare(right.scope) || left.key.localeCompare(right.key)),
    )
  }

  private validateWrite(input: MemoryWrite, now: number, createdAt: number): void {
    if (!this.policy.scopes.includes(input.scope)) {
      throw new MemoryPolicyError("scope", `memory scope ${input.scope} is not allowed`)
    }
    if (input.key.trim().length === 0) throw new MemoryPolicyError("invalid", "memory key must not be empty")
    if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
      throw new MemoryPolicyError("confidence", "memory confidence must be between zero and one")
    }
    if (input.confidence < this.policy.minConfidence) {
      throw new MemoryPolicyError("confidence", "memory confidence is below the policy threshold")
    }
    if (!Number.isFinite(createdAt) || createdAt < 0) {
      throw new MemoryPolicyError("expiration", "memory creation time must be a non-negative finite number")
    }
    if (input.expiresAt !== undefined && (!Number.isFinite(input.expiresAt) || input.expiresAt <= now)) {
      throw new MemoryPolicyError("expiration", "memory expiration must be in the future")
    }
    if (this.policy.maxAgeMs !== undefined && now - createdAt > this.policy.maxAgeMs) {
      throw new MemoryPolicyError("expiration", "memory item is older than the policy allows")
    }
    if (!isSensitivityAllowed(this.policy, input.sensitivity)) {
      throw new MemoryPolicyError("sensitivity", `memory sensitivity ${input.sensitivity} is not allowed`)
    }
  }

  private removeExpired(now: number): void {
    for (const [id, record] of this.records) {
      if (!isVisible(record, this.policy, now)) this.records.delete(id)
    }
  }
}

export function isScopeAllowed(policy: MemoryPolicy, scope: MemoryScope): boolean {
  return policy.scopes.includes(scope)
}

export function isSensitivityAllowed(policy: MemoryPolicy, sensitivity: MemorySensitivity): boolean {
  if (sensitivity === "secret") return policy.allowSecrets
  if (sensitivity === "sensitive") return policy.allowSensitive
  return sensitivityRank(sensitivity) <= sensitivityRank(policy.maxSensitivity)
}

export function isVisible(record: MemoryRecord, policy: MemoryPolicy, now: number): boolean {
  return (
    isScopeAllowed(policy, record.scope) &&
    isSensitivityAllowed(policy, record.sensitivity) &&
    record.confidence >= policy.minConfidence &&
    (record.expiresAt === undefined || record.expiresAt > now) &&
    (policy.maxAgeMs === undefined || now - record.createdAt <= policy.maxAgeMs)
  )
}

export function redactMemoryValue(value: unknown, sensitivity: MemorySensitivity = "internal"): unknown {
  if (sensitivity === "secret") return "[secret omitted]"
  if (sensitivity === "sensitive") return "[sensitive omitted]"
  if (Array.isArray(value)) return value.map((item) => redactMemoryValue(item, "internal"))
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      /TOKEN|SECRET|PASSWORD|PRIVATE|CREDENTIAL|KEY|AUTH/i.test(key)
        ? "[redacted]"
        : redactMemoryValue(item, "internal"),
    ]),
  )
}

function sensitivityRank(sensitivity: MemorySensitivity): number {
  return MEMORY_SENSITIVITIES.indexOf(sensitivity)
}
