// Packaging guard: a cross-built main bundle must reference only the native
// package for the platform it is packaged for. The node-pty platform package
// is externalized at build time from OMNIA_TARGET_PLATFORM/ARCH, so a macOS
// package assembled from a Linux-built out/ carries node-pty-linux-x64 and
// dies at launch with "Failed to load native module: pty.node".
//
// Run after the electron-vite build and before electron-builder.
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"

const platform = process.env.OMNIA_TARGET_PLATFORM ?? process.platform
const arch = process.env.OMNIA_TARGET_ARCH ?? process.arch
const expected = `@lydell/node-pty-${platform}-${arch}`
const main = join(import.meta.dir, "..", "out", "main", "index.js")

if (!existsSync(main)) {
  console.error(`verify-target: ${main} is missing. Run the build first.`)
  process.exit(1)
}

const source = readFileSync(main, "utf8")
const found = new Set(source.match(/@lydell\/node-pty-[a-z0-9]+-[a-z0-9]+/g) ?? [])

if (found.size === 0) {
  console.error(`verify-target: ${main} does not reference any node-pty platform package; the bundle may inline it.`)
  process.exit(1)
}

const wrong = [...found].filter((name) => name !== expected)
if (wrong.length > 0) {
  console.error(
    `verify-target: out/main/index.js targets ${wrong.join(", ")} but this package is ${expected}. ` +
      `Rebuild with OMNIA_TARGET_PLATFORM=${platform} OMNIA_TARGET_ARCH=${arch}.`,
  )
  process.exit(1)
}

console.log(`verify-target: ok (${expected})`)
