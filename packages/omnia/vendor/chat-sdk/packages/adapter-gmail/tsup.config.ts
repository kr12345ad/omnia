import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    api: "src/api.ts",
    format: "src/format.ts",
    index: "src/index.ts",
    webhook: "src/webhook.ts",
  },
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: false,
});
