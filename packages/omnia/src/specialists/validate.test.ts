import { describe, expect, test } from "bun:test"
import { DEFAULT_SPECIALISTS, SPECIALIST_LIMITS } from "./types.js"
import { slugifyRole, validateRoster } from "./validate.js"

const pair = [
  { name: "Designer", focus: "Layout and typography." },
  { name: "Lawyer", focus: "Contracts and liability." },
]

function error(input: unknown) {
  const result = validateRoster(input)
  if (result.ok) throw new Error("expected the roster to be rejected")
  return result.error
}

function specialists(input: unknown) {
  const result = validateRoster(input)
  if (!result.ok) throw new Error(result.error)
  return result.specialists
}

describe("validateRoster", () => {
  test("accepts the shipped defaults unchanged", () => {
    expect(specialists(DEFAULT_SPECIALISTS)).toEqual([...DEFAULT_SPECIALISTS])
  })

  test("derives the role from the name and keeps an explicit role", () => {
    const result = specialists([{ name: "Data Scientist", focus: "Models." }, { role: "ops", name: "Operator", focus: "Run it." }])
    expect(result.map((item) => item.role)).toEqual(["data-scientist", "ops"])
  })

  test("rejects anything but an array", () => {
    for (const input of [undefined, null, "x", 3, {}, { specialists: pair }]) {
      expect(error(input)).toBe("specialists must be an array.")
    }
  })

  test("enforces the count limits at both edges", () => {
    const many = (count: number) => Array.from({ length: count }, (_, index) => ({ name: `Role ${index}`, focus: "Focus." }))
    expect(error([])).toContain("2 to 6")
    expect(error(many(SPECIALIST_LIMITS.minCount - 1))).toContain("2 to 6")
    expect(specialists(many(SPECIALIST_LIMITS.minCount))).toHaveLength(2)
    expect(specialists(many(SPECIALIST_LIMITS.maxCount))).toHaveLength(6)
    expect(error(many(SPECIALIST_LIMITS.maxCount + 1))).toContain("2 to 6")
  })

  test("rejects entries that are not objects", () => {
    for (const entry of [null, undefined, "x", 1, ["a"]]) {
      expect(error([pair[0], entry])).toBe("Specialist 2 must be an object.")
    }
  })

  test("requires a non-empty name and focus", () => {
    expect(error([{ focus: "f" }, pair[1]])).toBe("Specialist 1 needs a name.")
    expect(error([{ name: 4, focus: "f" }, pair[1]])).toBe("Specialist 1 needs a name.")
    expect(error([{ name: " \t\n ", focus: "f" }, pair[1]])).toBe("Specialist 1 needs a name.")
    expect(error([{ name: "\u0000\u0007", focus: "f" }, pair[1]])).toBe("Specialist 1 needs a name.")
    expect(error([{ name: "Ada" }, pair[1]])).toBe("Ada needs a focus.")
    expect(error([{ name: "Ada", focus: 4 }, pair[1]])).toBe("Ada needs a focus.")
    expect(error([{ name: "Ada", focus: "  \n " }, pair[1]])).toBe("Ada needs a focus.")
    expect(error([{ name: "Ada", focus: "\u0000\u001b" }, pair[1]])).toBe("Ada needs a focus.")
  })

  test("enforces the name and focus length limits at the edge", () => {
    const name = "a".repeat(SPECIALIST_LIMITS.maxNameLength)
    const focus = "f".repeat(SPECIALIST_LIMITS.maxFocusLength)
    expect(specialists([{ name, focus }, pair[1]])[0]).toMatchObject({ name, focus })
    expect(error([{ name: name + "a", focus: "f" }, pair[1]])).toContain("40 characters")
    expect(error([{ name: "Ada", focus: focus + "f" }, pair[1]])).toContain("800 characters")
  })

  test("measures length after normalization, not before", () => {
    const padded = `  ${"a".repeat(SPECIALIST_LIMITS.maxNameLength)}  `
    const noisy = "f".repeat(SPECIALIST_LIMITS.maxFocusLength) + "\u0000\u0000"
    expect(specialists([{ name: padded, focus: noisy }, pair[1]])[0]?.name).toHaveLength(SPECIALIST_LIMITS.maxNameLength)
    expect(specialists([{ name: padded, focus: noisy }, pair[1]])[0]?.focus).toHaveLength(SPECIALIST_LIMITS.maxFocusLength)
  })

  test("strips control characters and collapses name whitespace", () => {
    const [first] = specialists([
      { name: "  Data\u0000   \nScientist\u007f ", focus: "Line one\nLine\ttwo\u0000\u001b[31m\r\n" },
      pair[1],
    ])
    expect(first?.name).toBe("Data Scientist")
    expect(first?.focus).toBe("Line one\nLine\ttwo[31m")
    expect(first?.focus).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/)
  })

  test("rejects duplicate roles, derived or explicit", () => {
    expect(error([{ name: "Ada", focus: "f" }, { name: "ADA", focus: "g" }])).toBe('Two specialists share the role "ada".')
    expect(error([{ name: "Ada", focus: "f" }, { role: "ada", name: "Other", focus: "g" }])).toContain('"ada"')
    expect(error([{ name: "Strategist", focus: "f" }, { name: "Other", role: "strategist", focus: "g" }])).toContain("share")
  })

  test("rejects the reserved manager role", () => {
    expect(error([{ name: "Manager", focus: "f" }, pair[1]])).toBe(`Manager's role "manager" is reserved.`)
    expect(error([{ role: "manager", name: "Boss", focus: "f" }, pair[1]])).toContain("reserved")
  })

  test("rejects malformed explicit roles", () => {
    for (const role of ["A", "Upper", "x", "1abc", "has space", "under_score", "-lead", "a".repeat(25), "é"]) {
      expect(error([{ role, name: "Ada", focus: "f" }, pair[1]])).toContain("must be 2-24")
    }
    expect(specialists([{ role: "a".repeat(24), name: "Ada", focus: "f" }, pair[1]])[0]?.role).toBe("a".repeat(24))
  })

  test("reports a name that cannot become a role", () => {
    expect(error([{ name: "分析师", focus: "f" }, pair[1]])).toContain("must be 2-24")
    expect(error([{ name: "!!", focus: "f" }, pair[1]])).toContain("must be 2-24")
  })

  test("never partially accepts and never mutates its input", () => {
    const input = [{ name: " Ada ", focus: " f " }, { name: "Bob" }]
    const copy = structuredClone(input)
    expect(validateRoster(input).ok).toBe(false)
    expect(input).toEqual(copy)
  })

  test("ignores unknown fields on entries", () => {
    expect(specialists([{ name: "Ada", focus: "f", admin: true }, pair[1]])[0]).toEqual({ role: "ada", name: "Ada", focus: "f" })
  })
})

describe("slugifyRole", () => {
  test("lowercases and joins words with dashes", () => {
    expect(slugifyRole("Data Scientist")).toBe("data-scientist")
    expect(slugifyRole("  Growth / Marketing!! ")).toBe("growth-marketing")
    expect(slugifyRole("QA")).toBe("qa")
  })

  test("transliterates accents without splitting the word", () => {
    expect(slugifyRole("Café")).toBe("cafe")
    expect(slugifyRole("Crème Brûlée")).toBe("creme-brulee")
  })

  test("prefixes names that start with a digit or have no latin letters", () => {
    expect(slugifyRole("3D Artist")).toBe("s-3d-artist")
    expect(slugifyRole("分析师")).toBe("s")
  })

  test("truncates to 24 characters without a trailing dash", () => {
    const slug = slugifyRole("The Extraordinarily Long Specialist Name")
    expect(slug.length).toBeLessThanOrEqual(24)
    expect(slug.endsWith("-")).toBe(false)
    expect(slug).toBe("the-extraordinarily-long")
    expect(slugifyRole("a".repeat(23) + " b")).toBe("a".repeat(23))
    expect(slugifyRole("1".repeat(40)).length).toBeLessThanOrEqual(24)
  })

  test("every slug of a printable latin name passes the role pattern", () => {
    for (const name of ["Data Scientist", "3D Artist", "Ünïcode Ñame", "a b", "Dr. No"]) {
      expect(slugifyRole(name)).toMatch(SPECIALIST_LIMITS.roleSlug)
    }
  })
})
