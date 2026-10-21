import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "vite"
import solid from "vite-plugin-solid"

export default defineConfig({
  base: "/admin/",
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
