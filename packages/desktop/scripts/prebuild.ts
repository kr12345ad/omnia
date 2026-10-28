#!/usr/bin/env bun
import { $ } from "bun"

import { resolveChannel, stageLocalCli } from "./utils"

const channel = resolveChannel()
await $`bun ./scripts/copy-icons.ts ${channel}`
await $`bun ./scripts/copy-metainfo.ts ${channel}`

// The CLI build clears packages/opencode/dist, so it runs before build-node,
// which writes the dist/node bundle the renderer chunks expect. Every channel
// ships this binary because the packaged app runs its server through it.
await stageLocalCli()
await $`cd ../opencode && bun script/build-node.ts`
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
