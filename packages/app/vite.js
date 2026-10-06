import { readFileSync } from "node:fs"
import solidPlugin from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import { fileURLToPath } from "url"

const theme = fileURLToPath(new URL("./public/oc-theme-preload.js", import.meta.url))

const channel = (() => {
  const raw = process.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  if (process.env.OPENCODE_CHANNEL === "latest") return "prod"
  return "dev"
})()

/**
 * @type {import("vite").PluginOption}
 */
export default [
  {
    name: "opencode-desktop:config",
    config() {
      return {
        resolve: {
          alias: {
            "@": fileURLToPath(new URL("./src", import.meta.url)),
          },
        },
        define: {
          "import.meta.env.VITE_OPENCODE_CHANNEL": JSON.stringify(channel),
        },
        worker: {
          format: "es",
        },
      }
    },
  },
  {
    name: "opencode-desktop:theme-preload",
    transformIndexHtml(html) {
      // The placeholder is written as src="/oc-theme-preload.js" by the web
      // entrypoint and src="./oc-theme-preload.js" by the Electron renderer, so
      // matching the exact string silently no-opped and left a parser-blocking
      // external request in front of the app on every startup. Match the script
      // id instead, whatever the attribute order or src form.
      const inlined = html.replace(
        /<script\b(?=[^>]*\bid=["']oc-theme-preload-script["'])[^>]*>[\s\S]*?<\/script>/i,
        `<script id="oc-theme-preload-script">${readFileSync(theme, "utf8")}</script>`,
      )
      if (inlined === html && /oc-theme-preload/i.test(html)) {
        throw new Error(
          "oc-theme-preload: found a theme preload reference that the inline replacement did not match; refusing to ship a parser-blocking external script",
        )
      }
      return inlined
    },
  },
  tailwindcss(),
  solidPlugin(),
]
