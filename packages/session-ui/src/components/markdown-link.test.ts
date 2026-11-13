import { describe, expect, test } from "bun:test"
import { linkChipLabel } from "./markdown-link"

describe("link chip labels", () => {
  test("a descriptive label is kept as the title", () => {
    expect(linkChipLabel("Read the docs", "https://example.com/guides/start")).toBe("Read the docs")
  })

  test("a bare URL label becomes its host instead of a trailing link", () => {
    expect(linkChipLabel("https://www.example.com/guides/start?ref=chat", "https://example.com/guides/start")).toBe(
      "example.com",
    )
  })

  test("a URL-shaped label with no valid href is still shortened when possible", () => {
    expect(linkChipLabel("https://docs.example.com/a/b", "https://docs.example.com/a/b")).toBe("docs.example.com")
  })

  test("a non-http href keeps whatever label it has", () => {
    expect(linkChipLabel("mailto:hello@example.com", "mailto:hello@example.com")).toBe("mailto:hello@example.com")
  })

  test("an empty label falls back to the host", () => {
    expect(linkChipLabel("  ", "https://example.com/path")).toBe("example.com")
  })
})
