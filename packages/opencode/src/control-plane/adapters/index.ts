import type { ProjectV2 } from "@opencode-ai/core/project"
import type { WorkspaceAdapter, WorkspaceAdapterEntry } from "../types"
import { WorktreeAdapter } from "./worktree"

// A Map (not an object literal) so adapter types coming from user input —
// `constructor`, `toString`, `__proto__`, ... — cannot resolve to inherited
// `Object.prototype` members and be handed back as if they were adapters.
const BUILTIN = new Map<string, WorkspaceAdapter>([["worktree", WorktreeAdapter]])

const state = new Map<ProjectV2.ID, Map<string, WorkspaceAdapter>>()

export function getAdapter(projectID: ProjectV2.ID, type: string): WorkspaceAdapter {
  const custom = state.get(projectID)?.get(type)
  if (custom) return custom

  const builtin = BUILTIN.get(type)
  if (builtin) return builtin

  throw new Error(`Unknown workspace adapter: ${type}`)
}

export function listAdapters(projectID: ProjectV2.ID): WorkspaceAdapterEntry[] {
  return registeredAdapters(projectID).map(([type, adapter]) => ({
    type,
    name: adapter.name,
    description: adapter.description,
  }))
}

export function registeredAdapters(projectID: ProjectV2.ID): [string, WorkspaceAdapter][] {
  const adapters = new Map(BUILTIN)
  for (const [type, adapter] of state.get(projectID)?.entries() ?? []) adapters.set(type, adapter)
  return [...adapters.entries()]
}

// Plugins can be loaded per-project so we need to scope them. If you
// want to install a global one pass `ProjectV2.ID.global`
export function registerAdapter(projectID: ProjectV2.ID, type: string, adapter: WorkspaceAdapter) {
  const adapters = state.get(projectID) ?? new Map<string, WorkspaceAdapter>()
  adapters.set(type, adapter)
  state.set(projectID, adapters)
}
