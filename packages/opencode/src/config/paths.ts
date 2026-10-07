export * as ConfigPaths from "./paths"

import path from "path"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import { unique } from "remeda"
import * as Effect from "effect/Effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import fs from "node:fs/promises"
import { randomUUID } from "node:crypto"

export function omniaConfigFile() {
  const file = process.env.OMNIA_CONFIG_FILE
  if (!file) return undefined
  if (!path.isAbsolute(file)) throw new Error("OMNIA_CONFIG_FILE must be absolute")
  return file
}

// Match desktop's writeSecretFile boundary: exclusive owner-only temporary,
// fsync, atomic rename, and refusal to write through a planted symlink.
export async function writeOmniaConfig(file: string, contents: string) {
  const existing = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (existing?.isSymbolicLink()) throw new Error(`Refusing to write ${file} through a symlink`)
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`)
  try {
    const handle = await fs.open(temporary, "wx", 0o600)
    try {
      await handle.writeFile(contents)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.rename(temporary, file)
  } finally {
    await fs.rm(temporary, { force: true })
  }
}

export const files = Effect.fn("ConfigPaths.projectFiles")(function* (
  name: string,
  directory: string,
  worktree?: string,
) {
  const afs = yield* FSUtil.Service
  const compatible = (yield* afs.up({
    targets: [`${name}.jsonc`, `${name}.json`],
    start: directory,
    stop: worktree,
  })).toReversed()
  if (name !== "opencode" || !omniaConfigFile()) return compatible
  return [...compatible, ...(yield* afs.up({ targets: ["OMNIA.json"], start: directory, stop: worktree })).toReversed()]
})

export const directories = Effect.fn("ConfigPaths.directories")(function* (directory: string, worktree?: string) {
  const afs = yield* FSUtil.Service
  return unique([
    omniaConfigFile() ? path.dirname(omniaConfigFile()!) : Global.Path.config,
    ...(!Flag.OPENCODE_DISABLE_PROJECT_CONFIG
      ? yield* afs.up({
          targets: [".opencode"],
          start: directory,
          stop: worktree,
        })
      : []),
    ...(!omniaConfigFile()
      ? yield* afs.up({
          targets: [".opencode"],
          start: Global.Path.home,
          stop: Global.Path.home,
        })
      : []),
    ...(Flag.OPENCODE_CONFIG_DIR ? [Flag.OPENCODE_CONFIG_DIR] : []),
  ])
})

export function fileInDirectory(dir: string, name: string) {
  return [path.join(dir, `${name}.json`), path.join(dir, `${name}.jsonc`)]
}
