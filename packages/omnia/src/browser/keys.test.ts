import { describe, expect, test } from "bun:test"
import { cdpModifierMask, parseKeyChord } from "./keys"

describe("key chord parsing", () => {
  test("parses a single key with no modifiers", () => {
    expect(parseKeyChord("Enter")).toMatchObject({
      modifiers: [],
      definition: { key: "Enter", code: "Enter", keyCode: 13, text: "\r", unmodifiedText: "\r" },
    })
  })

  test("parses modifier chords", () => {
    const chord = parseKeyChord("Control+a")
    expect(chord.modifiers).toEqual(["Control"])
    expect(chord.definition).toMatchObject({ key: "a", code: "KeyA", text: "a", unmodifiedText: "a" })
    expect(cdpModifierMask(chord.modifiers)).toBe(2)
  })

  test("keeps the unmodified text for shifted letters", () => {
    const chord = parseKeyChord("Shift+a")
    expect(chord.modifiers).toEqual(["Shift"])
    expect(chord.definition).toMatchObject({ key: "a", code: "KeyA", text: "A", unmodifiedText: "a" })
    expect(cdpModifierMask(chord.modifiers)).toBe(8)
  })

  test("expresses a literal plus key", () => {
    for (const input of ["+", "plus", "PLUS"]) {
      const chord = parseKeyChord(input)
      expect(chord.modifiers, input).toEqual([])
      expect(chord.definition, input).toMatchObject({
        key: "+",
        code: "NumpadAdd",
        keyCode: 107,
        text: "+",
        unmodifiedText: "+",
      })
    }

    const modified = parseKeyChord("Control++")
    expect(modified.modifiers).toEqual(["Control"])
    expect(modified.definition).toMatchObject({ key: "+", text: "+", unmodifiedText: "+" })
  })

  test("rejects malformed chords", () => {
    expect(() => parseKeyChord("Control+")).toThrow("A key is required.")
    expect(() => parseKeyChord("Banana+b")).toThrow('Unknown key modifier "Banana".')
  })
})
