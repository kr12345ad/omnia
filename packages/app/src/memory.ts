export type MemoryScope = "session" | "task" | "workspace" | "user" | "skill" | "application"

export interface MemoryRecord {
  id: string
  scope: MemoryScope
  text: string
  key?: string
  tags?: string[]
  application?: string
  sessionId?: string
  workspace?: string
  source: "agent" | "system" | "user"
  confidence: number
  sensitivity: "public" | "internal" | "private"
  createdAt: number
  updatedAt: number
  expiresAt?: number
}

export interface MemoryPlatform {
  list(input?: { query?: string; scope?: string; application?: string; limit?: number }): Promise<MemoryRecord[]>
  remove(id: string): Promise<boolean>
  forget(input: { query?: string; key?: string; scope?: string; application?: string }): Promise<number>
  stats(): Promise<Record<string, number>>
}
