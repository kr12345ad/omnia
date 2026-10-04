import { ApplyPatchTool } from "./apply_patch"
import { EditTool } from "./edit"
import { WriteTool } from "./write"
import { ComputerActTool } from "./computer/act"
import { ComputerAppsTool } from "./computer/apps"
import { ComputerBrowserTool } from "./computer/browser"
import { ComputerCapabilitiesTool } from "./computer/capabilities"
import { ComputerContextTool } from "./computer/context"
import { ComputerDoTool } from "./computer/do"
import { ComputerFindTool } from "./computer/find"
import { ComputerInspectTool } from "./computer/inspect"
import { ComputerSnapshotTool } from "./computer/snapshot"
import { ComputerObserveTool } from "./computer/observe"
import { ComputerReadTool } from "./computer/read"
import { ComputerScreenshotTool } from "./computer/screenshot"
import { ComputerVisualTool } from "./computer/visual"
import { MemoryTool } from "./computer/memory"
import { SuperskillTool } from "./computer/superskill"

export type SessionMode = "work" | "code"

// Session mode is persisted as `session.metadata.mode`. Keep this key in sync
// with packages/app/src/utils/session-mode.ts, which stamps it at creation.
export const SESSION_MODE_METADATA_KEY = "mode"

export const COMPUTER_TOOL_IDS: ReadonlySet<string> = new Set([
  ComputerObserveTool.id,
  ComputerFindTool.id,
  ComputerActTool.id,
  ComputerAppsTool.id,
  ComputerCapabilitiesTool.id,
  ComputerScreenshotTool.id,
  ComputerDoTool.id,
  ComputerReadTool.id,
  ComputerBrowserTool.id,
  ComputerContextTool.id,
  ComputerInspectTool.id,
  ComputerSnapshotTool.id,
  ComputerVisualTool.id,
  SuperskillTool.id,
  MemoryTool.id,
])

const CODING_EDIT_TOOL_IDS: ReadonlySet<string> = new Set([EditTool.id, WriteTool.id, ApplyPatchTool.id])

// The discussion room is an Agent-mode surface only. The id is spelled out
// here so this module stays free of a circular import with the tool itself.
export const AGENT_ONLY_TOOL_IDS: ReadonlySet<string> = new Set(["discussion_room"])

export function sessionModeFromMetadata(metadata: Record<string, unknown> | undefined): SessionMode | undefined {
  const value = metadata?.[SESSION_MODE_METADATA_KEY]
  return value === "work" || value === "code" ? value : undefined
}

export function sessionModeMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, string> | undefined {
  const mode = sessionModeFromMetadata(metadata)
  return mode ? { [SESSION_MODE_METADATA_KEY]: mode } : undefined
}

// Unknown modes keep the legacy, unfiltered tool surface so sessions created by
// other clients (CLI, TUI, older app versions) keep working unchanged.
export function toolEnabledInMode(mode: SessionMode | undefined, toolID: string) {
  if (AGENT_ONLY_TOOL_IDS.has(toolID)) return mode !== "code"
  if (mode === "code") return !COMPUTER_TOOL_IDS.has(toolID)
  if (mode === "work") return !CODING_EDIT_TOOL_IDS.has(toolID)
  return true
}

