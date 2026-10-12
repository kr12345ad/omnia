import { describe, expect, test } from "bun:test"
import {
  AGENT_ONLY_TOOL_IDS,
  COMPUTER_TOOL_IDS,
  SESSION_MODE_METADATA_KEY,
  sessionModeFromMetadata,
  sessionModeMetadata,
  toolEnabledInMode,
} from "@/tool/session-mode"
import { ApplyPatchTool } from "@/tool/apply_patch"
import { EditTool } from "@/tool/edit"
import { WriteTool } from "@/tool/write"

const computerToolIds = [
  "computer_observe",
  "computer_find",
  "computer_act",
  "computer_apps",
  "switch_computer",
  "computer_capabilities",
  "computer_screenshot",
  "computer_do",
  "computer_read",
  "computer_browser",
  "computer_context",
  "computer_inspect",
  "computer_snapshot",
  "computer_visual",
  "superskill",
  "memory",
]

const codingEditToolIds = [EditTool.id, WriteTool.id, ApplyPatchTool.id]

describe("tool.session-mode", () => {
  test("reads only valid modes from session metadata", () => {
    expect(sessionModeFromMetadata({ [SESSION_MODE_METADATA_KEY]: "work" })).toBe("work")
    expect(sessionModeFromMetadata({ [SESSION_MODE_METADATA_KEY]: "chat" })).toBe("chat")
    expect(sessionModeFromMetadata({ [SESSION_MODE_METADATA_KEY]: "other" })).toBeUndefined()
    expect(sessionModeFromMetadata({})).toBeUndefined()
    expect(sessionModeFromMetadata(undefined)).toBeUndefined()
  })

  test("reads the retired code mode as chat so old sessions keep their tool surface", () => {
    expect(sessionModeFromMetadata({ [SESSION_MODE_METADATA_KEY]: "code" })).toBe("chat")
    expect(sessionModeMetadata({ [SESSION_MODE_METADATA_KEY]: "code" })).toEqual({ mode: "chat" })
    for (const id of computerToolIds) {
      expect(toolEnabledInMode(sessionModeFromMetadata({ mode: "code" }), id)).toBe(false)
    }
  })

  test("stamps mode metadata only for known modes", () => {
    expect(sessionModeMetadata({ [SESSION_MODE_METADATA_KEY]: "chat" })).toEqual({ mode: "chat" })
    expect(sessionModeMetadata({ unrelated: true })).toBeUndefined()
    expect(sessionModeMetadata(undefined)).toBeUndefined()
  })

  test("keeps the legacy unfiltered surface when no mode is known", () => {
    for (const id of [...computerToolIds, ...codingEditToolIds, "read", "shell"]) {
      expect(toolEnabledInMode(undefined, id)).toBe(true)
    }
  })

  test("excludes computer tools from Chat sessions", () => {
    expect([...COMPUTER_TOOL_IDS].sort()).toEqual([...computerToolIds].sort())
    for (const id of computerToolIds) {
      expect(toolEnabledInMode("chat", id)).toBe(false)
    }
    for (const id of [...codingEditToolIds, "read", "glob", "grep", "shell", "task", "todowrite", "skill"]) {
      expect(toolEnabledInMode("chat", id)).toBe(true)
    }
  })

  test("excludes coding edit tools from Work sessions", () => {
    for (const id of codingEditToolIds) {
      expect(toolEnabledInMode("work", id)).toBe(false)
    }
    for (const id of [...computerToolIds, "read", "glob", "grep", "shell", "task", "todowrite", "skill"]) {
      expect(toolEnabledInMode("work", id)).toBe(true)
    }
  })

  test("keeps Agent-only tools out of Chat sessions", () => {
    expect([...AGENT_ONLY_TOOL_IDS]).toEqual(["discussion_room"])
    expect(toolEnabledInMode("work", "discussion_room")).toBe(true)
    expect(toolEnabledInMode(undefined, "discussion_room")).toBe(true)
    expect(toolEnabledInMode("chat", "discussion_room")).toBe(false)
  })
})
