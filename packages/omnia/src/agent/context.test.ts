import { describe, expect, test } from "bun:test"
import { buildEnvironmentContext, compactContext, estimateTokens } from "./context"
import type { ContextEntry, Environment } from "./contracts"

const environment: Environment = {
  cwd: "/workspace/project",
  platform: "linux",
  shell: "bash",
  ci: true,
  tools: ["read", "shell"],
  variables: { CI: "true", SERVICE: "omnia", API_TOKEN: "redact-me" },
}

function entry(input: Partial<ContextEntry> & Pick<ContextEntry, "id" | "text">): ContextEntry {
  return {
    role: "assistant",
    tokens: estimateTokens(input.text),
    importance: 0.5,
    createdAt: 1,
    sensitivity: "internal",
    ...input,
  }
}

describe("environment-aware context compaction", () => {
  test("includes environment facts and stays within the token budget", () => {
    const entries = Array.from({ length: 20 }, (_, index) =>
      entry({ id: `entry-${index}`, text: "x".repeat(400), createdAt: index }),
    )
    const result = compactContext(entries, { maxTokens: 120, environment, now: 30, keepRecent: 2 })
    expect(result.estimatedTokens).toBeLessThanOrEqual(120)
    expect(result.environment?.text).toContain("cwd=/workspace/project")
    expect(result.environment?.text).toContain("ci=true")
    expect(result.environment?.text).not.toContain("redact-me")
    expect(result.entries.some((item) => item.id === "summary")).toBe(true)
    expect(result.compacted).toBeGreaterThan(0)
  })

  test("redacts sensitive and secret entries by default", () => {
    const result = compactContext(
      [
        entry({ id: "secret", text: "do not expose", sensitivity: "secret", importance: 1 }),
        entry({ id: "sensitive", text: "private details", sensitivity: "sensitive", importance: 1 }),
      ],
      { maxTokens: 100, keepRecent: 2 },
    )
    expect(result.entries.map((item) => item.text).join(" ")).not.toContain("do not expose")
    expect(result.entries.map((item) => item.text).join(" ")).not.toContain("private details")
  })

  test("builds a deterministic environment context", () => {
    const first = buildEnvironmentContext(environment, 10)
    const second = buildEnvironmentContext(environment, 10)
    expect(first).toEqual(second)
    expect(Object.isFrozen(first)).toBe(true)
    expect(first.text).toContain("tools=read,shell")
  })
})
