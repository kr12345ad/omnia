import { describe, expect, test } from "bun:test"
import { CARD_PROGRAM_HEAD, CARD_PROGRAM_TAIL, cardSyntaxError } from "./program"

describe("js card program", () => {
  test("code that compiles as the card's program is accepted", () => {
    expect(cardSyntaxError("root.replaceChildren()")).toBeUndefined()
    expect(cardSyntaxError("const box = canvas().fit()\nsetHeight(box.height)")).toBeUndefined()
    // The wrapper is a function body, which is what makes these two work: a card
    // is handed its runtime and may await a network import for the library it
    // draws with.
    expect(cardSyntaxError("return 1")).toBeUndefined()
    expect(
      cardSyntaxError('const three = await import("https://esm.sh/three")\nroot.append(three.canvas)'),
    ).toBeUndefined()
    // A trailing comment is common in generated code, and the body it closes has
    // to survive it.
    expect(cardSyntaxError("root.replaceChildren()\n// rebuild from the data")).toBeUndefined()
  })

  test("code the engine cannot compile is refused in its own words", () => {
    // The shape that reached the reader as "The card's script failed: Unexpected
    // identifier 'cv'": a token where the expression cannot continue.
    const message = cardSyntaxError("const at = 1 cv")
    expect(message).toBeString()
    expect(message).toContain("cv")
    expect(cardSyntaxError("root.replaceChildren(")).toBeString()
    expect(cardSyntaxError('const at = canvas().fit()"')).toBeString()
  })

  test("the wrapper checked is the wrapper the frame builds", () => {
    expect(CARD_PROGRAM_HEAD).toContain("use strict")
    expect(CARD_PROGRAM_HEAD).toContain("(async () => {")
    expect(CARD_PROGRAM_HEAD.endsWith("\n")).toBe(true)
    expect(CARD_PROGRAM_TAIL).toBe("\n})();")
  })
})
