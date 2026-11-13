import { sentryVitePlugin } from "@sentry/vite-plugin"
import { defineConfig } from "vite"
import desktopPlugin from "./vite"

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
          assets: "./dist/**",
          filesToDeleteAfterUpload: "./dist/**/*.map",
        },
      })
    : false

const sourcemaps = Boolean(sentry) || process.env.OMNIA_SOURCEMAPS === "1"

export default defineConfig({
  // Hosted deployments serve the pages under a path prefix (e.g., /test1/);
  // desktop renderer builds leave this unset and keep the default base.
  base: process.env.OMNIA_WEB_BASE ?? undefined,
  plugins: [desktopPlugin, sentry] as any,
  server: {
    host: "0.0.0.0",
    allowedHosts: true,
    port: 3000,
  },
  esbuild: {
    // Demo builds ship without console chatter or debugger traps.
    drop: ["console", "debugger"],
  },
  build: {
    target: "esnext",
    // Three surfaces share this app: the full workspace at index.html, the
    // tool-free browser chat at chat.html, and the mobile chat shell at
    // mobile.html. The server embeds every file under dist, so no extra build
    // step is needed for the mobile entry.
    rollupOptions: {
      input: {
        main: "index.html",
        chat: "chat.html",
        mobile: "mobile.html",
      },
    },
    sourcemap: sourcemaps,
    minify: "esbuild",
    cssMinify: "esbuild",
    reportCompressedSize: false,
    assetsInlineLimit: 8192,
    chunkSizeWarningLimit: 8192,
    modulePreload: { polyfill: false },
  },
})
