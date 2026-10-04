export * as ConfigCommand from "./command"

import path from "path"
import { Cause, Exit, Schema } from "effect"
import { Glob } from "@opencode-ai/core/util/glob"
import { ConfigCommandV1 } from "@opencode-ai/core/v1/config/command"
import { configEntryNameFromPath } from "./entry-name"
import { InvalidError } from "@opencode-ai/core/v1/config/error"
import * as ConfigMarkdown from "./markdown"

const decodeInfo = Schema.decodeUnknownExit(ConfigCommandV1.Info)

export async function load(dir: string) {
  const result: Record<string, ConfigCommandV1.Info> = {}
  for (const item of await Glob.scan("{command,commands}/**/*.md", {
    cwd: dir,
    absolute: true,
    dot: true,
    symlink: true,
  })) {
    const md = await ConfigMarkdown.parse(item).catch(() => undefined)
    if (!md) continue

    const name = configEntryNameFromPath(path.relative(dir, item), ["command/", "commands/"])

    const config = {
      name,
      ...md.data,
      template: md.content.trim(),
    }
    const parsed = decodeInfo(config, { errors: "all", propertyOrder: "original" })
    if (Exit.isSuccess(parsed)) {
      // Entry names come from file paths, so `command/__proto__.md` yields the key `__proto__`. Plain assignment
      // would invoke the inherited setter and pollute the registry's prototype instead of registering the command.
      Object.defineProperty(result, config.name, {
        value: parsed.value,
        enumerable: true,
        configurable: true,
        writable: true,
      })
      continue
    }
    throw new InvalidError({ path: item, message: Cause.pretty(parsed.cause) }, { cause: Cause.squash(parsed.cause) })
  }
  return result
}
