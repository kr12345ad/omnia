import { plugin } from "bun"
import { describe, expect, test } from "bun:test"

// server-host.ts imports Electron main-process modules that only exist inside
// a running app. Substitute the narrow surface the factory touches, then import
// the module dynamically (same pattern as browser-view.test.ts).
const fakeElectron = {
  app: { isPackaged: false, getAppPath: () => ".", getPath: () => "." },
  systemPreferences: { isTrustedAccessibilityClient: () => false },
}

plugin({
  name: "server-host-electron",
  setup(build) {
    build.module("electron", () => ({ exports: { ...fakeElectron, default: fakeElectron }, loader: "object" }))
  },
})

const { createPlatformHostDriver } = await import("./server-host")

describe("embedded server removal", () => {
  test("does not start or export the local Omnia server", async () => {
    const module = await import("./server-host")
    expect("startLocalOmniaServer" in module).toBe(false)
    expect("registerModelsWithOmniaServer" in module).toBe(false)
    expect(typeof module.createPlatformHostDriver).toBe("function")
  })
})

describe("platform host driver wiring", () => {
  test("wires the Cua host driver with the Windows legacy fallback on win32", async () => {
    const driver = createPlatformHostDriver("win32")
    expect(driver).toBeDefined()
    if (driver === undefined) return
    try {
      expect(driver.id).toBe("windows-host")
      expect(driver.backend).toBe("windows-uia")
      expect(driver.engine).toBeDefined()
      const info = await driver.getInfo()
      const names = (info.capabilities ?? []).map((capability) => capability.capability)
      expect(names).toContain("cua_snapshot")
      expect(names).toContain("cua_refs")
      // The legacy PowerShell driver stays reachable for the fallback surface.
      expect(names).toContain("shell")
    } finally {
      driver.dispose?.()
    }
  })

  test("keeps the macOS Cua wiring", () => {
    const driver = createPlatformHostDriver("darwin")
    expect(driver).toBeDefined()
    if (driver === undefined) return
    try {
      expect(driver.id).toBe("darwin-host")
      expect(driver.backend).toBe("macos-ax")
      expect(driver.engine).toBeDefined()
    } finally {
      driver.dispose?.()
    }
  })
})
