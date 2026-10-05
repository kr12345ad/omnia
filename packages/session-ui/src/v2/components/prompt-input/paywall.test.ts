import { describe, expect, test } from "bun:test"
import { promptInputV2ShellAsked, promptInputV2VisionOwed } from "./paywall"
import type { PromptInputV2Attachment } from "./types"

function attachment(mime: string): PromptInputV2Attachment {
  return { type: "image", id: mime, filename: `file.${mime}`, mime, blob: { id: mime, url: `blob:${mime}` } }
}

describe("prompt input v2 paywall", () => {
  test("only an image costs vision", () => {
    expect(promptInputV2VisionOwed([attachment("image/png")])).toBe(true)
    expect(promptInputV2VisionOwed([attachment("image/webp"), attachment("application/pdf")])).toBe(true)
  })

  test("a non-image attachment never earns a notice", () => {
    expect(promptInputV2VisionOwed([])).toBe(false)
    expect(promptInputV2VisionOwed([attachment("text/plain")])).toBe(false)
    expect(promptInputV2VisionOwed([attachment("application/pdf"), attachment("text/plain")])).toBe(false)
  })

  test("the shell notice waits until the shell is asked for", () => {
    expect(promptInputV2ShellAsked(false, false)).toBe(false)
    expect(promptInputV2ShellAsked(false, true)).toBe(true)
  })

  test("the shell notice latches once the shell has been opened", () => {
    expect(promptInputV2ShellAsked(true, true)).toBe(true)
    // Shell mode closes itself again; the refusal it explains outlives it.
    expect(promptInputV2ShellAsked(true, false)).toBe(true)
  })
})