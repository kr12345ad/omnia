// Single source of truth for semantic element matching, shared by the router
// and the semantic provider so a score the provider returns is always a score
// the router accepts. The old `query.includes(name)` 0.4 clause over-matched
// any short element name ("window", "terminal") inside a long focus query and
// produced the (960,539) screen-center click: the name must now contain the
// whole query (0.6 floor) and anything below MATCH_THRESHOLD is no match.

export const MATCH_THRESHOLD = 0.6

export function normalizeQuery(s: string): string {
  return s.trim().toLowerCase()
}

export function scoreMatch(query: string, candidate: { name?: string; role?: string; text?: string }): number {
  const q = normalizeQuery(query)
  if (q.length === 0) return 0
  const name = (candidate.name ?? "").toLowerCase()
  const text = (candidate.text ?? "").toLowerCase()
  const role = (candidate.role ?? "").toLowerCase()
  const exact = name === q || text === q
  const score = Math.min(
    1,
    (name.length > 0 && name.includes(q) ? 0.6 : 0) +
      (text.length > 0 && text.includes(q) ? 0.3 : 0) +
      (role.length > 0 && role.includes(q) ? 0.2 : 0) +
      (exact ? 0.25 : 0),
  )
  return score >= MATCH_THRESHOLD ? score : 0
}
