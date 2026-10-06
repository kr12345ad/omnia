#!/usr/bin/env bun
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { $ } from "bun"
import { DARWIN_AX_HELPER } from "../../omnia/src/cua/backends/darwin-ax"

// Ship a prebuilt accessibility helper so installed apps never need Xcode.
if (process.platform !== "darwin") process.exit(0)
if (
  await $`which swiftc`
    .quiet()
    .nothrow()
    .then((result) => result.exitCode !== 0)
) {
  console.warn("swiftc not found; the app will compile the AX helper on first use")
  process.exit(0)
}
const directory = join(import.meta.dir, "..", "resources", "mac")
mkdirSync(directory, { recursive: true })
const source = join(directory, "ax-helper.swift")
const binary = join(directory, "ax-helper")
writeFileSync(source, DARWIN_AX_HELPER)
await $`swiftc -O ${source} -o ${binary}`.quiet()
if (!existsSync(binary)) {
  console.error(`swiftc reported success but ${binary} does not exist`)
  process.exit(1)
}
chmodSync(binary, 0o755)
console.log("built the macOS accessibility helper")
