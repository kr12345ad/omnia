import { describe, expect, test } from "bun:test"
import { extractTitleCandidates, titleOverlap, titleTokens } from "./title-extract"

describe("extractTitleCandidates", () => {
  test("focus intent yields the full title then its fragments", () => {
    const candidates = extractTitleCandidates("focus kitty OC | Quick hello")
    expect(candidates).toContain("OC | Quick hello")
    expect(candidates).toContain("Quick hello")
    expect(candidates).toContain("OC")
    // Most specific first: the piped title beats the bare fragments.
    expect(candidates.indexOf("OC | Quick hello")).toBeLessThan(candidates.indexOf("Quick hello"))
    expect(candidates.indexOf("Quick hello")).toBeLessThan(candidates.indexOf("OC"))
  })

  test("a plain piped title splits left to right", () => {
    expect(extractTitleCandidates("OC | Quick hello")).toEqual(["OC | Quick hello", "OC", "Quick hello"])
  })

  test("quoted titles come first, in order of appearance", () => {
    expect(extractTitleCandidates('focus the window "Quick hello" now')[0]).toBe("Quick hello")
    expect(extractTitleCandidates("bring 'Kitty Docs' front")[0]).toBe("Kitty Docs")
    expect(extractTitleCandidates("raise \u201cNotes\u201d please")[0]).toBe("Notes")
    const both = extractTitleCandidates('activate "First" then \'Second\'')
    expect(both.indexOf("First")).toBeLessThan(both.indexOf("Second"))
    expect(both).toContain('activate "First" then \'Second\'')
  })

  test("em dash, en dash and spaced hyphen split", () => {
    expect(extractTitleCandidates("OC \u2014 Quick hello")).toEqual(["OC \u2014 Quick hello", "OC", "Quick hello"])
    expect(extractTitleCandidates("OC \u2013 Quick hello")).toEqual(["OC \u2013 Quick hello", "OC", "Quick hello"])
    expect(extractTitleCandidates("Quick hello - OC")).toEqual(["Quick hello - OC", "Quick hello", "OC"])
    // An unspaced hyphen is part of the title, not a separator.
    expect(extractTitleCandidates("vim-notes - OC")).toEqual(["vim-notes - OC", "vim-notes", "OC"])
  })

  test("fragments are trimmed, emptied of noise and deduplicated", () => {
    expect(extractTitleCandidates("OC |   | OC | - | x")).toEqual(["OC |   | OC | - | x", "OC"])
  })

  test("the whole input leads while it is short enough", () => {
    expect(extractTitleCandidates("OC | Quick hello")[0]).toBe("OC | Quick hello")
    const long = `${"a".repeat(130)} | tail`
    const candidates = extractTitleCandidates(long)
    // Fragments lead; the paragraph-long input is only a last resort.
    expect(candidates[0]).toBe("a".repeat(130))
    expect(candidates[candidates.length - 1]).toBe(long)
  })

  test("caps at 8 candidates", () => {
    const candidates = extractTitleCandidates("one \u2014 two \u2014 three \u2014 four \u2014 five \u2014 six \u2014 seven \u2014 eight \u2014 nine \u2014 ten")
    expect(candidates).toHaveLength(8)
    expect(candidates[0]).toBe("one \u2014 two \u2014 three \u2014 four \u2014 five \u2014 six \u2014 seven \u2014 eight \u2014 nine \u2014 ten")
    expect(candidates).toContain("one")
  })

  test("empty and whitespace input yields no candidates", () => {
    expect(extractTitleCandidates("")).toEqual([])
    expect(extractTitleCandidates("   ")).toEqual([])
    expect(extractTitleCandidates("\n\t ")).toEqual([])
  })
})

describe("titleTokens", () => {
  test("lowercases and drops stopwords", () => {
    expect(titleTokens("OC | Quick Hello")).toEqual(["oc", "quick", "hello"])
    expect(titleTokens("Focus the kitty window in the terminal app please")).toEqual(["focus", "kitty"])
  })

  test("keeps alphanumeric tokens and drops punctuation", () => {
    expect(titleTokens("v1.2 — notes: OK?")).toEqual(["v1", "2", "notes", "ok"])
    expect(titleTokens("| - \u2014")).toEqual([])
  })
})

describe("titleOverlap", () => {
  test("related strings share at least one token", () => {
    expect(titleOverlap("quick hello", "OC | Quick hello")).toBeGreaterThan(0)
    expect(titleOverlap("OC | Quick hello", "quick hello")).toBeGreaterThan(0)
    expect(titleOverlap("OC | Quick hello", "OC | Quick hello")).toBe(1)
  })

  test("unrelated strings and stopword-only strings score 0", () => {
    expect(titleOverlap("kitty window", "Quick hello")).toBe(0)
    expect(titleOverlap("the window", "the terminal")).toBe(0)
    expect(titleOverlap("", "Quick hello")).toBe(0)
  })

  test("stays inside 0..1", () => {
    const overlap = titleOverlap("quick", "Quick hello notes extra words")
    expect(overlap).toBeGreaterThan(0)
    expect(overlap).toBeLessThanOrEqual(1)
  })
})
