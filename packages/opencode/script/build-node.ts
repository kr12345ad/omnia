#!/usr/bin/env bun

import { Script } from "@opencode-ai/script"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

const generated = await import("./generate.ts")

const pkg = (await Bun.file(path.join(dir, "package.json")).json()) as { version?: string }

// Development builds normally carry a 0.0.0-<branch>-<timestamp> preview
// version. Providers such as the Console free tier reject clients older than
// 1.18.0, so a local bundle reports the workspace package version in the
// request headers while the UI keeps its seasonal version. When the workspace
// moves to the 2.x line (26.10 scaffold), bump packages/opencode/package.json
// and rebuild; the UI version lives in packages/desktop/package.json.
const version =
  Script.version.startsWith("0.0.0-") && typeof pkg.version === "string" && pkg.version.length > 0
    ? pkg.version
    : Script.version

await Bun.build({
  target: "node",
  entrypoints: ["./src/node.ts"],
  outdir: "./dist/node",
  format: "esm",
  sourcemap: "linked",
  external: ["jsonc-parser", "@lydell/node-pty"],
  define: {
    OPENCODE_MODELS_DEV: generated.modelsData,
    OPENCODE_VERSION: `'${version}'`,
    OPENCODE_CHANNEL: `'${Script.channel}'`,
  },
  files: {
    "opencode-web-ui.gen.ts": "",
  },
})

console.log("Build complete")
