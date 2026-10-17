import { describe, expect, test } from "bun:test"
import { splitMarkdown } from "./text"

const fences = (chunk: string) =>
  chunk
    .split("\n")
    .filter((line) => /^\s*(```+|~~~+)/.test(line)).length

describe("splitting chat text", () => {
  test("keeps every message inside the limit", () => {
    const chunks = splitMarkdown("x".repeat(9_000), { limit: 2_000, total: 100_000 })
    expect(chunks.every((chunk) => chunk.length <= 2_000)).toBe(true)
    expect(chunks.join("")).toBe("x".repeat(9_000))
  })

  test("closes and reopens a code block that crosses a message boundary", () => {
    const code = Array.from({ length: 200 }, (_, index) => `const value${index} = ${index}`).join("\n")
    const text = `Before\n\n\`\`\`ts\n${code}\n\`\`\`\nAfter`
    const chunks = splitMarkdown(text, { limit: 500, total: 100_000 })
    expect(chunks.length).toBeGreaterThan(2)
    expect(chunks.every((chunk) => chunk.length <= 500)).toBe(true)
    // Every message is self-contained markdown: an odd number of fence lines
    // would leave the reader inside an unterminated block.
    expect(chunks.every((chunk) => fences(chunk) % 2 === 0)).toBe(true)
    expect(chunks.some((chunk) => chunk.startsWith("```ts"))).toBe(true)
  })

  test("ends a reply that is over the cap with a notice instead of a cut", () => {
    const chunks = splitMarkdown("word ".repeat(6_000), {
      limit: 2_000,
      total: 8_000,
      notice: "_(omitted)_",
    })
    expect(chunks.at(-1)).toBe("_(omitted)_")
    expect(chunks.every((chunk) => chunk.length <= 2_000)).toBe(true)
  })
})
