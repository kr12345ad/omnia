import { describe, expect, test } from "bun:test"
import { hasOpenUIBlock, splitOpenUISegments } from "./fence"

describe("openui fences", () => {
  test("plain prose is one markdown segment", () => {
    expect(splitOpenUISegments("Just an answer.")).toEqual([{ kind: "markdown", text: "Just an answer." }])
    expect(hasOpenUIBlock("Just an answer.")).toBe(false)
  })

  test("splits prose, a closed block and more prose in order", () => {
    const text = ["Here is the dashboard:", "```openui-lang", 'root = Stack([])', "```", "Ask me anything."].join("\n")
    expect(splitOpenUISegments(text)).toEqual([
      { kind: "markdown", text: "Here is the dashboard:" },
      { kind: "openui", code: "root = Stack([])", streaming: false },
      { kind: "markdown", text: "Ask me anything." },
    ])
  })

  test("accepts the short fence spelling and case-insensitive names", () => {
    expect(splitOpenUISegments("```openui\nroot = Stack([])\n```")).toEqual([
      { kind: "openui", code: "root = Stack([])", streaming: false },
    ])
    expect(splitOpenUISegments("```OpenUI-Lang\nroot = Stack([])\n```")).toEqual([
      { kind: "openui", code: "root = Stack([])", streaming: false },
    ])
  })

  test("an unterminated fence is a streaming block, not lost text", () => {
    const text = "Building it:\n```openui-lang\nroot = Stack([chart])\nchart = BarChart(labels, series)"
    expect(splitOpenUISegments(text, true)).toEqual([
      { kind: "markdown", text: "Building it:" },
      { kind: "openui", code: "root = Stack([chart])\nchart = BarChart(labels, series)", streaming: true },
    ])
  })

  test("a settled message never claims to still be streaming", () => {
    const text = "```openui-lang\nroot = Stack([])"
    expect(splitOpenUISegments(text, false)).toEqual([{ kind: "openui", code: "root = Stack([])", streaming: false }])
  })

  test("markdown around and between blocks keeps its blank lines", () => {
    const text = ["a", "```openui-lang", "b", "```", "", "c"].join("\n")
    expect(splitOpenUISegments(text)).toEqual([
      { kind: "markdown", text: "a" },
      { kind: "openui", code: "b", streaming: false },
      { kind: "markdown", text: "\nc" },
    ])
  })

  test("a language fence that is not openui is left to the markdown renderer", () => {
    const text = "```ts\nconst x = 1\n```"
    expect(splitOpenUISegments(text)).toEqual([{ kind: "markdown", text }])
  })
})
