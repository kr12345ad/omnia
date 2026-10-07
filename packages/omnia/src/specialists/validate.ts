import { SPECIALIST_LIMITS, type Specialist } from "./types.js"

export type RosterValidation =
  | { readonly ok: true; readonly specialists: Specialist[] }
  | { readonly ok: false; readonly error: string }

// Control characters (other than newline and tab in the focus text) never
// belong in a name or an instruction, and the roster is pasted into prompts.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g

export function slugifyRole(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
    .replace(/-+$/g, "")
  return /^[a-z]/.test(slug) ? slug : `s-${slug}`.slice(0, 24).replace(/-+$/g, "")
}

/**
 * Validates and normalizes untrusted roster input.
 *
 * Never throws and never partially accepts: either the whole roster is valid
 * and returned normalized, or the first problem is reported by name.
 */
export function validateRoster(input: unknown): RosterValidation {
  if (!Array.isArray(input)) return { ok: false, error: "specialists must be an array." }
  if (input.length < SPECIALIST_LIMITS.minCount || input.length > SPECIALIST_LIMITS.maxCount) {
    return {
      ok: false,
      error: `A room needs ${SPECIALIST_LIMITS.minCount} to ${SPECIALIST_LIMITS.maxCount} specialists.`,
    }
  }
  const seen = new Set<string>()
  const specialists: Specialist[] = []
  for (const [index, entry] of input.entries()) {
    const label = `Specialist ${index + 1}`
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { ok: false, error: `${label} must be an object.` }
    }
    const record = entry as Record<string, unknown>
    if (typeof record.name !== "string") return { ok: false, error: `${label} needs a name.` }
    const name = record.name.replace(CONTROL, "").replace(/\s+/g, " ").trim()
    if (name.length === 0) return { ok: false, error: `${label} needs a name.` }
    if (name.length > SPECIALIST_LIMITS.maxNameLength) {
      return { ok: false, error: `${label}'s name is longer than ${SPECIALIST_LIMITS.maxNameLength} characters.` }
    }
    if (typeof record.focus !== "string") return { ok: false, error: `${name} needs a focus.` }
    const focus = record.focus.replace(CONTROL, "").trim()
    if (focus.length === 0) return { ok: false, error: `${name} needs a focus.` }
    if (focus.length > SPECIALIST_LIMITS.maxFocusLength) {
      return { ok: false, error: `${name}'s focus is longer than ${SPECIALIST_LIMITS.maxFocusLength} characters.` }
    }
    const requested = typeof record.role === "string" && record.role.length > 0 ? record.role : slugifyRole(name)
    if (!SPECIALIST_LIMITS.roleSlug.test(requested)) {
      return { ok: false, error: `${name}'s role "${requested}" must be 2-24 lowercase letters, digits or dashes.` }
    }
    if (SPECIALIST_LIMITS.reservedRoles.includes(requested)) {
      return { ok: false, error: `${name}'s role "${requested}" is reserved.` }
    }
    if (seen.has(requested)) return { ok: false, error: `Two specialists share the role "${requested}".` }
    seen.add(requested)
    specialists.push({ role: requested, name, focus })
  }
  return { ok: true, specialists }
}
