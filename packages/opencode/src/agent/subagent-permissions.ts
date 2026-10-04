import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type { Agent } from "./agent"

/**
 * Build the `permission` ruleset for a subagent's session when it's spawned
 * via the task tool. Combines:
 *
 * 1. The parent session's deny rules, its external_directory rules, and its
 *    rules for the two gated permissions. Parent agent restrictions only govern
 *    that agent; the subagent's own permissions determine its capabilities.
 * 2. Default `todowrite` and `task` denies unless the subagent's own ruleset or
 *    the parent's session rules already permit them.
 */
export function deriveSubagentSessionPermission(input: {
  parentSessionPermission: PermissionV1.Ruleset
  subagent: Agent.Info
}): PermissionV1.Ruleset {
  const permitted = (permission: string) =>
    input.subagent.permission.some((rule) => rule.permission === permission) ||
    input.parentSessionPermission.some((rule) => rule.permission === permission && rule.action === "allow")
  return [
    // Parent denies survive so a subagent cannot widen them, and the parent's
    // external_directory rules survive whole because they carry the globs that
    // session already approved. Rules for the two gated permissions survive
    // whatever they are: dropping a parent's explicit allow would let the
    // default deny below silently override that grant, and keeping them in
    // place preserves their original order against the parent denies.
    ...input.parentSessionPermission.filter(
      (rule) =>
        rule.permission === "external_directory" ||
        rule.action === "deny" ||
        rule.permission === "todowrite" ||
        rule.permission === "task",
    ),
    ...(permitted("todowrite")
      ? []
      : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
    ...(permitted("task") ? [] : [{ permission: "task" as const, pattern: "*" as const, action: "deny" as const }]),
  ]
}
