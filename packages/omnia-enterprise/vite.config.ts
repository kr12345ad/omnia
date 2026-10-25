import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "vite"
import solid from "vite-plugin-solid"

export default defineConfig({
  // Relative, not "/admin/": the console is served from the mount it is given,
  // which is `/admin/` on the console's own origin and `/test1/ent/admin/`
  // behind the hosted edge. An absolute base made every asset a request for
  // `/admin/assets/...` on the public domain, which is not where they live.
  base: "./",
  plugins: [solid(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: 5174,
    proxy: {
      "/v1": {
        target: process.env.OMNIA_SERVER_URL ?? "http://127.0.0.1:8799",
        changeOrigin: false,
      },
    },
  },
  build: {
    target: "esnext",
    sourcemap: process.env.OMNIA_SOURCEMAPS === "1",
  },
})
