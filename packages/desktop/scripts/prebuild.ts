#!/usr/bin/env bun
import { $ } from "bun"

import { downloadCliToResources, resolveChannel } from "./utils"

const channel = resolveChannel()
await $`bun ./scripts/copy-icons.ts ${channel}`
await $`bun ./scripts/copy-metainfo.ts ${channel}`

await $`cd ../opencode && bun script/build-node.ts`
if (channel === "dev") await downloadCliToResources()
if (process.platform === "darwin") {
  // The app falls back to compiling the helper at runtime when it is missing,
  // which needs a Swift toolchain on the user's machine, so this is a warning
  // rather than a hard failure: the darwin release runners do have swiftc.
  const built = await $`bun ./scripts/build-ax-helper.ts`
    .quiet()
    .nothrow()
    .catch(() => undefined)
  if (built?.exitCode !== 0) {
    console.warn("could not prebuild the macOS accessibility helper; the app will compile it on first use")
  }
}
