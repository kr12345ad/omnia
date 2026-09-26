export const MEMORY_SCOPES = ["session", "task", "workspace", "user", "skill", "application"] as const
export type MemoryScope = (typeof MEMORY_SCOPES)[number]

export const MEMORY_SENSITIVITIES = ["public", "internal", "private"] as const
export type MemorySensitivity = (typeof MEMORY_SENSITIVITIES)[number]

export const MEMORY_SOURCES = ["agent", "system", "user"] as const
export type MemorySource = (typeof MEMORY_SOURCES)[number]

export interface MemoryRecord {
  readonly id: string
  readonly scope: MemoryScope
  readonly text: string
  readonly key?: string
  readonly tags?: readonly string[]
  readonly application?: string
  readonly sessionId?: string
  readonly workspace?: string
  readonly source: MemorySource
  readonly confidence: number
  readonly sensitivity: MemorySensitivity
  readonly createdAt: number
  readonly updatedAt: number
  readonly expiresAt?: number
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface MemoryWriteInput {
  readonly scope: MemoryScope
  readonly text: string
  readonly key?: string
  readonly tags?: readonly string[]
  readonly application?: string
  readonly sessionId?: string
  readonly workspace?: string
  readonly source?: MemorySource
  readonly confidence?: number
  readonly sensitivity?: MemorySensitivity
  readonly expiresInDays?: number
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface MemoryQuery {
  readonly query?: string
  readonly scope?: MemoryScope
  readonly application?: string
  readonly key?: string
  readonly tags?: readonly string[]
  readonly limit?: number
  readonly includeExpired?: boolean
}

export interface MemoryStats {
  readonly total: number
  readonly byScope: Readonly<Record<string, number>>
  readonly expiringSoon: number
}
