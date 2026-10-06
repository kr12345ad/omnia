import { defineConfig } from "@playwright/test"

// Electron UI tests for the desktop app. They launch the packaged binary with
// an isolated XDG_CONFIG_HOME so they never touch the user's real data.
export default defineConfig({
  testDir: ".",
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["line"]],
  outputDir: "./artifacts",
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
})
