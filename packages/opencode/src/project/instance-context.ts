import { LocalContext } from "@/util/local-context"
import { FSUtil } from "@opencode-ai/core/fs-util"
import type * as Project from "./project"

export interface InstanceContext {
  directory: string
  worktree: string
  project: Project.Info
}

export const context = LocalContext.create<InstanceContext>("instance")

/**
 * Resolve every symlink in a path so containment is decided on the target the
 * I/O will actually reach, not on the spelling the caller used. A symlink that
 * points at an unreadable path keeps its literal form, which leaves the lexical
 * comparison as the floor rather than silently claiming containment.
 */
function realpath(target: string): string {
  try {
    return FSUtil.resolve(target)
  } catch {
    return target
  }
}

/**
 * Check if a path is within the project boundary.
 * Returns true if path is inside ctx.directory OR ctx.worktree.
 * Paths within the worktree but outside the working directory should not trigger external_directory permission.
 */
export function containsPath(filepath: string, ctx: InstanceContext): boolean {
  const resolved = realpath(filepath)
  if (FSUtil.contains(realpath(ctx.directory), resolved)) return true
  // Non-git projects set worktree to "/" which would match ANY absolute path.
  // Skip worktree check in this case to preserve external_directory permissions.
  if (ctx.worktree === "/") return false
  return FSUtil.contains(realpath(ctx.worktree), resolved)
}
