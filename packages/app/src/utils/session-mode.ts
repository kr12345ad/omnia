export type SessionMode = "work" | "chat"

export const DEFAULT_SESSION_MODE: SessionMode = "work"

// Session mode is persisted as `session.metadata.mode`. Keep this key in sync
// with packages/opencode/src/tool/session-mode.ts, which reads it to filter the
// agent tool surface.
export const SESSION_MODE_METADATA_KEY = "mode"

// Chat replaced an earlier "code" mode. Sessions, drafts and the persisted mode
// map written by older builds still carry that id, so it reads back as chat
// rather than falling through to the default mode.
const LEGACY_SESSION_MODE = "code"

export function knownSessionMode(value: unknown): SessionMode | undefined {
  if (value === "work" || value === "chat") return value
  if (value === LEGACY_SESSION_MODE) return "chat"
  return undefined
}

export function sessionModeFromMetadata(metadata: Record<string, unknown> | undefined | null): SessionMode | undefined {
  return knownSessionMode(metadata?.[SESSION_MODE_METADATA_KEY])
}

export function sessionModeMetadata(mode: SessionMode): Record<string, SessionMode> {
  return { [SESSION_MODE_METADATA_KEY]: mode }
}

// A session's mode is fixed at creation. The recorded mode wins over any
// fallback so a later UI selection can never rewrite an existing session.
export function resolveSessionMode(input: {
  stored?: SessionMode
  metadata?: Record<string, unknown> | undefined | null
  fallback?: SessionMode
}): SessionMode {
  return sessionModeFromMetadata(input.metadata) ?? input.stored ?? input.fallback ?? DEFAULT_SESSION_MODE
}

export function sessionModeControl(input: {
  session?: SessionMode
  selected: SessionMode
}): { mode: SessionMode; fixed: boolean } {
  if (input.session !== undefined) return { mode: input.session, fixed: true }
  return { mode: input.selected, fixed: false }
}
