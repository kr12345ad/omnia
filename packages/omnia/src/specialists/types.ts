// The shared contract for the discussion room's specialist roster.
//
// A roster is the set of specialists that sit in a discussion room next to its
// manager. Everyone gets the four defaults; custom rosters are a paid
// capability (`custom_specialists`, Pro and above), enforced where the roster is
// read and written - never by the UI alone.

export interface Specialist {
  /** Stable slug used in assignments (`@role: ...`). Lowercase, unique per roster. */
  readonly role: string
  /** Display name shown to the user and the other participants. */
  readonly name: string
  /** What this specialist is for: its lens, expertise and standards. */
  readonly focus: string
}

export const SPECIALIST_LIMITS = {
  minCount: 2,
  maxCount: 6,
  maxNameLength: 40,
  maxFocusLength: 800,
  roleSlug: /^[a-z][a-z0-9-]{1,23}$/,
  /** `manager` runs the room, so a specialist cannot take its name. */
  reservedRoles: ["manager"] as readonly string[],
} as const

export const DEFAULT_SPECIALISTS: readonly Specialist[] = [
  {
    role: "strategist",
    name: "Strategist",
    focus: "Goals, tradeoffs, sequencing, and success metrics.",
  },
  {
    role: "builder",
    name: "Builder",
    focus: "Feasibility, dependencies, and the simplest working approach.",
  },
  {
    role: "researcher",
    name: "Researcher",
    focus: "Evidence, prior art, and the unknowns that must be verified.",
  },
  {
    role: "critic",
    name: "Critic",
    focus: "Failure modes, risks, and the acceptance criteria that prove the decision right.",
  },
]

/**
 * What `GET /v1/specialists` answers.
 *
 * `specialists` is always the roster a room started now would use. `custom` is
 * true only when that roster is a saved custom one the caller is entitled to,
 * so a lapsed subscription silently degrades to the defaults instead of
 * running a roster the plan no longer covers.
 */
export interface SpecialistRoster {
  readonly entitled: boolean
  readonly custom: boolean
  readonly specialists: readonly Specialist[]
  readonly defaults: readonly Specialist[]
  readonly limits: {
    readonly minCount: number
    readonly maxCount: number
    readonly maxNameLength: number
    readonly maxFocusLength: number
  }
}
