const GENERIC_DISCUSSION_AGENT = "discussion-specialist"

export function readDiscussionSpecialists(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (typeof item !== "object" || item === null) return []
    const entry = item as Record<string, unknown>
    if (typeof entry.sessionId !== "string" || entry.sessionId.length === 0) return []
    return [
      {
        sessionId: entry.sessionId,
        role: typeof entry.role === "string" ? entry.role : undefined,
        name: typeof entry.name === "string" ? entry.name : undefined,
      },
    ]
  })
}

export function discussionParticipantLabel(input: {
  agent?: string
  title?: string
  specialist?: { role?: string; name?: string }
}) {
  const agent = input.agent ?? "specialist"
  const derived = agent.startsWith("discussion-") ? agent.slice("discussion-".length) : agent
  const fallback = derived.length > 0 ? derived[0]!.toUpperCase() + derived.slice(1) : agent
  if (agent !== GENERIC_DISCUSSION_AGENT) return fallback
  const name = input.specialist?.name?.trim()
  if (name) return name
  const role = input.specialist?.role?.trim() || input.title?.match(/\(@([^()\s]+)\)\s*$/)?.[1]
  return role || fallback
}
