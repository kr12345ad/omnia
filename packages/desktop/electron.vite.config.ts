import { sentryVitePlugin } from "@sentry/vite-plugin"
import { defineConfig } from "electron-vite"
import appPlugin from "@opencode-ai/app/vite"
import * as fs from "node:fs/promises"

const OPENCODE_SERVER_DIST = "../opencode/dist/node"

export type Channel = "dev" | "beta" | "prod"

// "latest" and "production" are how the release workflows and the update feed
// name the production channel. Every resolver must agree on this table: a value
// that silently falls through to dev is how "Omnia Dev" AppImages shipped under
// a release name.
const CHANNEL_ALIASES = new Map<string, Channel>([
  ["dev", "dev"],
  ["beta", "beta"],
  ["prod", "prod"],
  ["production", "prod"],
  ["latest", "prod"],
])

/** Undefined when the value is unset or unknown, so callers choose the policy. */
export function parseChannel(raw: string | undefined): Channel | undefined {
  const value = raw?.trim().toLowerCase()
  if (!value) return undefined
  return CHANNEL_ALIASES.get(value)
}

// electron-vite also builds for local development, where no channel is exported.
const channel = parseChannel(process.env.OPENCODE_CHANNEL) ?? "dev"

// Cross-building (for example a macOS artifact on Linux) must not bake the
// host platform into the bundle: OMNIA_TARGET_PLATFORM/OMNIA_TARGET_ARCH
// override the native package that is externalized and required at runtime.
const targetPlatform = process.env.OMNIA_TARGET_PLATFORM ?? process.platform
const targetArch = process.env.OMNIA_TARGET_ARCH ?? process.arch
const nodePtyPkg = `@lydell/node-pty-${targetPlatform}-${targetArch}`

const sentry =
  process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT
    ? sentryVitePlugin({
        authToken: process.env.SENTRY_AUTH_TOKEN,
        org: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT,
        telemetry: false,
        release: {
          name: process.env.SENTRY_RELEASE ?? process.env.VITE_SENTRY_RELEASE,
        },
        sourcemaps: {
          assets: "./out/renderer/**",
          filesToDeleteAfterUpload: "./out/renderer/**/*.map",
        },
      })
    : false

// Source maps are only useful when Sentry uploads them or when explicitly
// requested; keeping them out of local builds cuts tens of MB and build time.
const sourcemaps = Boolean(sentry) || process.env.OMNIA_SOURCEMAPS === "1"

export default defineConfig({
  main: {
    define: {
      "import.meta.env.OPENCODE_CHANNEL": JSON.stringify(channel),
      "import.meta.env.OMNIA_DISABLE_UPDATES": JSON.stringify(process.env.OMNIA_DISABLE_UPDATES === "1"),
    },
    esbuild: {
      drop: ["console", "debugger"],
      pure: ["console.log", "console.debug", "console.info", "console.warn", "console.error"],
    },
    build: {
      // Trim parse/load time for the main bundle; no source maps in production.
      minify: "esbuild",
      sourcemap: false,
      reportCompressedSize: false,
      rollupOptions: {
        input: { index: "src/main/index.ts", sidecar: "src/main/sidecar.ts" },
        // electron-vite 6 injects the Node 20.11+ CommonJS shim itself. Do not
        // add a banner with the same declarations: the chunk would declare
        // __filename/__dirname/require twice and fail to load.
      },
      externalizeDeps: { include: [nodePtyPkg], exclude: ["@opencode-ai/omnia"] },
    },
    plugins: [
      {
        name: "opencode:node-pty-narrower",
        enforce: "pre",
        resolveId(s) {
          if (s === "@lydell/node-pty") return nodePtyPkg
        },
      },
      {
        name: "opencode:virtual-server-module",
        enforce: "pre",
        resolveId(id) {
          if (id === "virtual:opencode-server") return this.resolve(`${OPENCODE_SERVER_DIST}/node.js`)
        },
      },
      {
        name: "opencode:copy-server-assets",
        async writeBundle() {
          for (const l of await fs.readdir(OPENCODE_SERVER_DIST)) {
            if (!l.endsWith(".wasm")) continue
            await fs.writeFile(`./out/main/chunks/${l}`, await fs.readFile(`${OPENCODE_SERVER_DIST}/${l}`))
          }
        },
      },
    ],
  },
  preload: {
    esbuild: {
      drop: ["console", "debugger"],
    },
    build: {
      minify: "esbuild",
      sourcemap: false,
      reportCompressedSize: false,
      rollupOptions: {
        input: { index: "src/preload/index.ts" },
        output: {
          format: "cjs",
          entryFileNames: "[name].js",
        },
      },
    },
  },
  renderer: {
    plugins: [appPlugin, sentry],
    publicDir: "../../../app/public",
    root: "src/renderer",
    esbuild: {
      // Demo builds ship without console chatter or debugger traps.
      drop: ["console", "debugger"],
    },
    build: {
      sourcemap: sourcemaps,
      target: "esnext",
      minify: "esbuild",
      cssMinify: "esbuild",
      reportCompressedSize: false,
      assetsInlineLimit: 8192,
      chunkSizeWarningLimit: 8192,
      // Electron ships native modulepreload; the polyfill is dead weight.
      modulePreload: { polyfill: false },
      rollupOptions: {
        input: {
          main: "src/renderer/index.html",
          overlay: "src/renderer/overlay.html",
        },
      },
    },
  },
})
