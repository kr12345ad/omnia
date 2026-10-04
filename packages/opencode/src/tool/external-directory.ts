import path from "path"
import { realpathSync } from "node:fs"
import { Effect } from "effect"
import { InstanceState } from "@/effect/instance-state"
import type * as Tool from "./tool"
import { containsPath } from "../project/instance-context"
import { FSUtil } from "@opencode-ai/core/fs-util"

type Kind = "file" | "directory"

type Options = {
  bypass?: boolean
  kind?: Kind
}

// Resolve the longest existing prefix of `target` and re-attach the missing
// tail. `containsPath` resolves symlinks but keeps the literal spelling when the
// leaf does not exist yet, so `<project>/link/new.txt` with `link` pointing out
// of the project still looks contained while the write lands outside it.
function resolveTarget(target: string) {
  const tail: string[] = []
  let current = target
  for (;;) {
    try {
      const resolved = realpathSync(current)
      return tail.length === 0 ? resolved : path.join(resolved, ...tail)
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return target
      tail.unshift(path.basename(current))
      current = parent
    }
  }
}

export const assertExternalDirectoryEffect = Effect.fn("Tool.assertExternalDirectory")(function* (
  ctx: Tool.Context,
  target?: string,
  options?: Options,
) {
  if (!target) return false

  if (options?.bypass) return false

  const ins = yield* InstanceState.context
  const full = process.platform === "win32" ? FSUtil.normalizePath(target) : target
  // containsPath resolves symlinks on both sides, so containment is decided on
  // the file the I/O will actually reach: a symlink the model creates inside the
  // project can no longer reach outside it without this ask.
  if (containsPath(resolveTarget(full), ins)) return false

  const kind = options?.kind ?? "file"
  const dir = kind === "directory" ? full : path.dirname(full)
  const glob =
    process.platform === "win32"
      ? FSUtil.normalizePathPattern(path.join(dir, "*"))
      : path.join(dir, "*").replaceAll("\\", "/")

  yield* ctx.ask({
    permission: "external_directory",
    patterns: [glob],
    always: [glob],
    metadata: {
      filepath: full,
      parentDir: dir,
    },
  })
  return true
})

export async function assertExternalDirectory(ctx: Tool.Context, target?: string, options?: Options) {
  return Effect.runPromise(assertExternalDirectoryEffect(ctx, target, options))
}
