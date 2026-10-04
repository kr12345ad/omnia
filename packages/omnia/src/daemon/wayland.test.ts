import { describe, expect, test } from "bun:test"
import { LinuxHostDriver, type RunResult } from "./linux"
import {
  detectSessionType,
  ydotoolButtonCodes,
  ydotoolKeySequence,
  ydotoolMoveArgs,
  ydotoolReleaseArgs,
} from "./wayland"

describe("session detection", () => {
  test("prefers XDG_SESSION_TYPE, then Wayland and X11 variables", () => {
    expect(detectSessionType({ XDG_SESSION_TYPE: "wayland", DISPLAY: ":0" })).toBe("wayland")
    expect(detectSessionType({ XDG_SESSION_TYPE: "x11", WAYLAND_DISPLAY: "wayland-0" })).toBe("x11")
    expect(detectSessionType({ WAYLAND_DISPLAY: "wayland-0" })).toBe("wayland")
    expect(detectSessionType({ DISPLAY: ":0" })).toBe("x11")
    expect(detectSessionType({})).toBe("unknown")
  })
})

describe("ydotool argument builders", () => {
  test("builds modifier and key sequences", () => {
    expect(ydotoolKeySequence("ctrl+shift+t")).toEqual([
      ["key", "29:1"],
      ["key", "42:1"],
      ["key", "20:1"],
      ["key", "20:0"],
      ["key", "42:0"],
      ["key", "29:0"],
    ])
    expect(ydotoolKeySequence("Return")).toEqual([
      ["key", "28:1"],
      ["key", "28:0"],
    ])
    expect(ydotoolKeySequence("ctrl")).toEqual([["key", "29:1"], ["key", "29:0"]])
    expect(ydotoolKeySequence("F5")).toEqual([
      ["key", "63:1"],
      ["key", "63:0"],
    ])
    expect(ydotoolKeySequence("not-a-key")).toBeUndefined()
  })

  test("maps mouse buttons and pointer helpers", () => {
    expect(ydotoolButtonCodes(1)).toEqual({ down: 0x40, up: 0x80 })
    expect(ydotoolButtonCodes(2)).toEqual({ down: 0x42, up: 0x82 })
    expect(ydotoolButtonCodes(3)).toEqual({ down: 0x41, up: 0x81 })
    expect(ydotoolMoveArgs(12.4, 30.6)).toEqual(["mousemove", "--absolute", "-x", "12", "-y", "31"])
    expect(ydotoolReleaseArgs()[0]).toBe("key")
    expect(ydotoolReleaseArgs()).toContain("29:0")
  })
})

function createWaylandRunner(): { runner: (file: string, args: readonly string[]) => Promise<RunResult>; calls: string[][] } {
  const calls: string[][] = []
  return {
    calls,
    runner: async (file, args) => {
      calls.push([file, ...args])
      if (file === "which") return { stdout: "/usr/bin/ydotool\n", stderr: "" }
      return { stdout: "", stderr: "" }
    },
  }
}

describe("linux driver on Wayland", () => {
  test("routes input through ydotool and reports unsupported pointer queries", async () => {
    const harness = createWaylandRunner()
    const driver = new LinuxHostDriver({ runner: harness.runner, display: ":0", session: "wayland" })

    const moved = await driver.movePointer(100, 200)
    expect(moved.success).toBe(true)
    expect(harness.calls.some((call) => call[0] === "ydotool" && call[1] === "mousemove")).toBe(true)

    const typed = await driver.typeText("hello")
    expect(typed.success).toBe(true)
    expect(harness.calls.some((call) => call[0] === "ydotool" && call[1] === "type" && call[2] === "hello")).toBe(true)

    const keyed = await driver.sendGlobalKey("ctrl+c")
    expect(keyed.success).toBe(true)

    const scrolled = await driver.scrollPointer("down", 3)
    expect(scrolled.success).toBe(false)
    const scrollError = scrolled.error
    expect(typeof scrollError === "object" && scrollError !== null ? scrollError.code : undefined).toBe(
      "operation_unavailable",
    )

    const position = await driver.pointerPosition()
    expect(position.success).toBe(false)

    const capabilities = driver.capabilities()
    const keyboard = capabilities.find((capability) => capability.capability === "keyboard")
    expect(keyboard?.status).toBe("available")
    const windows = capabilities.find((capability) => capability.capability === "window_management")
    expect(windows?.status).toBe("degraded")
  })

  test("degrades honestly when ydotool is missing", async () => {
    const calls: string[][] = []
    const driver = new LinuxHostDriver({
      display: ":0",
      session: "wayland",
      runner: async (file, args) => {
        calls.push([file, ...args])
        if (file === "which") throw new Error("not found")
        return { stdout: "", stderr: "" }
      },
    })
    const clicked = await driver.clickAt(10, 10)
    expect(clicked.success).toBe(false)
    expect(calls.every((call) => call[0] !== "ydotool")).toBe(true)
    const capabilities = driver.capabilities()
    expect(capabilities.find((capability) => capability.capability === "pointer")?.status).toBe("degraded")
  })
})
