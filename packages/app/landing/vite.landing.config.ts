// Builds the landing-page demo bundle from the app's real session UI.
//
// Run from packages/app:
//   bunx vite build -c landing/vite.landing.config.ts
//
// Output is a self-contained ES module plus one stylesheet, dropped straight
// into the marketing site's assets so the page can mount the real timeline.
// Point OMNIA_LANDING_OUT at the site's asset directory to emit somewhere else.
import { defineConfig } from "vite"
import solid from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const app = path.resolve(here, "..")
const ui = path.resolve(here, "../../ui")
const sessionUi = path.resolve(here, "../../session-ui")
// The same context substitutions the storybook uses: these app-level contexts
// need an engine/DOM environment the marketing page does not have.
const mocks = path.resolve(here, "../../storybook/.storybook/mocks")

const OUT = process.env.OMNIA_LANDING_OUT ?? path.resolve(here, "dist")

export default defineConfig({
  // The bundle is dropped into a site that may live under any prefix, so every
  // URL it emits has to be relative. Without this Vite resolves CSS `url()`
  // references against "/" and the fonts 404.
  base: "./",
  plugins: [solid(), tailwindcss()],
  resolve: {
    dedupe: ["solid-js", "solid-js/web", "@solidjs/meta"],
    alias: [
      { find: "@solidjs/router", replacement: path.resolve(mocks, "solid-router.tsx") },
      { find: /^@\/context\/local$/, replacement: path.resolve(mocks, "app/context/local.ts") },
      { find: /^@\/context\/file$/, replacement: path.resolve(mocks, "app/context/file.ts") },
      { find: /^@\/context\/prompt$/, replacement: path.resolve(mocks, "app/context/prompt.ts") },
      { find: /^@\/context\/layout$/, replacement: path.resolve(mocks, "app/context/layout.ts") },
      { find: /^@\/context\/sdk$/, replacement: path.resolve(mocks, "app/context/sdk.ts") },
      { find: /^@\/context\/sync$/, replacement: path.resolve(mocks, "app/context/sync.ts") },
      { find: /^@\/context\/comments$/, replacement: path.resolve(mocks, "app/context/comments.ts") },
      { find: /^@\/context\/command$/, replacement: path.resolve(mocks, "app/context/command.ts") },
      { find: /^@\/context\/permission$/, replacement: path.resolve(mocks, "app/context/permission.ts") },
      { find: /^@\/context\/language$/, replacement: path.resolve(mocks, "app/context/language.ts") },
      { find: /^@\/context\/platform$/, replacement: path.resolve(mocks, "app/context/platform.ts") },
      { find: /^@\/context\/global-sync$/, replacement: path.resolve(mocks, "app/context/global-sync.ts") },
      { find: /^@\/context\/server-sync$/, replacement: path.resolve(mocks, "app/context/server-sync.ts") },
      { find: /^@\/context\/server-sdk$/, replacement: path.resolve(mocks, "app/context/server-sdk.ts") },
      { find: /^@\/hooks\/use-providers$/, replacement: path.resolve(mocks, "app/hooks/use-providers.ts") },
      { find: /^@\/components\/dialog-select-model$/, replacement: path.resolve(mocks, "app/components/dialog-select-model.tsx") },
      { find: /^@\/components\/dialog-select-model-unpaid$/, replacement: path.resolve(mocks, "app/components/dialog-select-model-unpaid.tsx") },
      { find: "@", replacement: app },
    ],
  },
  worker: { format: "es" },
  build: {
    outDir: OUT,
    emptyOutDir: true,
    target: "es2022",
    cssCodeSplit: false,
    reportCompressedSize: false,
    sourcemap: false,
    minify: "esbuild",
    cssMinify: "esbuild",
    // The UI ships ~60 woff2/woff/ttf faces. Vite's default inline limit turns
    // every one of them into a data URI inside the stylesheet, which is over a
    // megabyte of CSS the marketing page has to download before it can paint.
    //
    // This only takes effect outside `build.lib`: library mode ignores the
    // option and inlines assets unconditionally, which is why the entry is
    // declared through rollupOptions below rather than as a library.
    assetsInlineLimit: 0,
    rollupOptions: {
      input: path.resolve(here, "demo.tsx"),
      output: {
        format: "es",
        entryFileNames: "demo.js",
        chunkFileNames: "demo-[name]-[hash].js",
        assetFileNames: (asset) =>
          asset.names?.[0]?.endsWith(".css") ? "demo.css" : "demo/[name]-[hash][extname]",
        // Heavy optional renderers (mermaid diagrams, extra syntax grammars,
        // the diff viewer) must stay code-split so the marketing page only
        // fetches what a scene actually renders.
        inlineDynamicImports: false,
      },
    },
  },
  // The storybook aliases resolve into sibling packages; keep the resolver
  // inside the workspace rather than the marketing directory.
  server: { fs: { allow: [ui, sessionUi, app, mocks] } },
})
