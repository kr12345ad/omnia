import { describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  DARWIN_KEY_CODES,
  DarwinHostDriver,
  darwinKeyScript,
  mapDarwinActions,
  mapDarwinRole,
  parseDarwinObservation,
  toDarwinElement,
} from "./darwin"
import {
  WINDOWS_VK,
  mapWindowsActions,
  mapWindowsRole,
  parseWindowsObservation,
  toWindowsElement,
  windowsKeySpec,
} from "./windows"

describe("macOS driver helpers", () => {
  test("builds key and hotkey scripts", () => {
    expect(darwinKeyScript("return")).toBe("se.keyCode(36)")
    expect(darwinKeyScript("cmd+c")).toBe('se.keystroke("c", { using: ["command down"] })')
    expect(darwinKeyScript("ctrl+shift+t")).toBe('se.keystroke("t", { using: ["control down", "shift down"] })')
    expect(darwinKeyScript("alt+left")).toBe("se.keyCode(123, { using: [\"option down\"] })")
    expect(darwinKeyScript("cmd")).toBeUndefined()
    expect(DARWIN_KEY_CODES.f5).toBe(96)
  })

  test("maps AX roles and actions to the universal schema", () => {
    expect(mapDarwinRole("AXButton")).toBe("button")
    expect(mapDarwinRole("AXTextField")).toBe("textbox")
    expect(mapDarwinRole("AXWindow")).toBe("window")
    expect(mapDarwinRole("AXSheet")).toBe("dialog")
    expect(mapDarwinActions(["AXPress", "AXIncrement", "AXUnknown"])).toEqual(["click", "increment"])
  })

  test("maps a raw element into a universal UIElement", () => {
    const element = toDarwinElement({
      id: "mac:42:0.1",
      parentId: "mac:42:0",
      role: "AXButton",
      name: "Save",
      description: "Save the document",
      value: "enabled",
      enabled: true,
      focused: true,
      bounds: { x: 10, y: 20, width: 80, height: 24 },
      actions: ["AXPress"],
      app: "TextEdit",
      pid: 42,
    })
    expect(element?.role).toBe("button")
    expect(element?.name).toBe("Save")
    expect(element?.states).toEqual(["focused"])
    expect(element?.bounds).toEqual({ x: 10, y: 20, width: 80, height: 24 })
    expect(element?.actions).toEqual(["click"])
    expect(element?.metadata?.application).toBe("TextEdit")
    expect(element?.metadata?.pid).toBe(42)
    expect(toDarwinElement({})).toBeUndefined()
  })

  test("parses observations and surfaces permission errors", () => {
    const parsed = parseDarwinObservation(
      JSON.stringify([
        { id: "mac:1:0", role: "AXWindow", name: "Window", enabled: true },
        { id: "mac:1:0.0", role: "AXButton", name: "OK", enabled: false },
        { id: "" },
      ]),
    )
    expect(parsed.error).toBeUndefined()
    expect(parsed.elements).toHaveLength(2)
    expect(parsed.elements[1]?.states).toEqual(["disabled"])

    const denied = parseDarwinObservation(
      JSON.stringify({ error: "permission", message: "grant accessibility" }),
    )
    expect(denied.elements).toHaveLength(0)
    expect(denied.error).toBe("grant accessibility")

    expect(parseDarwinObservation("not json").error).toBeDefined()
  })
})

describe("macOS Secure Input gate", () => {
  function fakeExecutable(directory: string, name: string, body: string): string {
    const path = join(directory, name)
    writeFileSync(path, body)
    chmodSync(path, 0o755)
    return path
  }

  test("refuses keyboard actions while Secure Input is active", async () => {
    const directory = mkdtempSync(join(tmpdir(), "omnia-secure-input-"))
    try {
      const driver = new DarwinHostDriver({
        ioreg: fakeExecutable(directory, "ioreg", '#!/bin/sh\necho \'"kCGSSessionSecureInputPID" = 4242\'\n'),
        osascript: fakeExecutable(directory, "osascript", '#!/bin/sh\necho \'{"ok":true}\'\n'),
      })
      const typed = await driver.execute({ type: "type", text: "secret" })
      expect(typed.success).toBe(false)
      expect(typeof typed.error === "object" ? typed.error.code : undefined).toBe("secure_input")
      const keyed = await driver.execute({ type: "key", key: "cmd+c" })
      expect(keyed.success).toBe(false)
      expect(typeof keyed.error === "object" ? keyed.error.code : undefined).toBe("secure_input")
      // Pointer input is not blocked by Secure Input and must still deliver.
      const clicked = await driver.execute({ type: "click", target: { kind: "point", x: 5, y: 5 } })
      expect(clicked.success).toBe(true)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("keyboard actions proceed when Secure Input is off", async () => {
    const directory = mkdtempSync(join(tmpdir(), "omnia-secure-input-"))
    try {
      const driver = new DarwinHostDriver({
        ioreg: fakeExecutable(directory, "ioreg", "#!/bin/sh\nexit 0\n"),
        osascript: fakeExecutable(directory, "osascript", '#!/bin/sh\necho \'{"ok":true}\'\n'),
      })
      const typed = await driver.execute({ type: "type", text: "hello" })
      expect(typed.success).toBe(true)
      expect(typed.error).toBeUndefined()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("element typing refuses instead of falling through to the frontmost window", async () => {
    const directory = mkdtempSync(join(tmpdir(), "omnia-darwin-type-"))
    try {
      const log = join(directory, "calls.log")
      const driver = new DarwinHostDriver({
        osascript: fakeExecutable(directory, "osascript", `#!/bin/sh\necho "$@" >> "${log}"\necho '{}'\n`),
        ioreg: fakeExecutable(directory, "ioreg", "#!/bin/sh\nexit 0\n"),
      })
      const result = await driver.execute({
        type: "type",
        text: "hello",
        target: { kind: "element", elementId: "mac:1:0.0" },
      })
      expect(result.success).toBe(false)
      expect(typeof result.error === "object" ? result.error.code : undefined).toBe("target_stale")
      // The keystroke script must never run when the target cannot be located.
      expect(readFileSync(log, "utf8")).not.toContain("se.keystroke")
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe("Windows driver helpers", () => {
  test("builds key specs", () => {
    expect(windowsKeySpec("return")).toEqual({ modifiers: [], key: 0x0d })
    expect(windowsKeySpec("ctrl+shift+s")).toEqual({ modifiers: [0x11, 0x10], key: 0x53 })
    expect(windowsKeySpec("alt+f4")).toEqual({ modifiers: [0x12], key: 0x73 })
    expect(windowsKeySpec("ctrl")).toBeUndefined()
    expect(WINDOWS_VK.pageup).toBe(0x21)
  })

  test("maps UIA roles and actions to the universal schema", () => {
    expect(mapWindowsRole("ControlType.Button")).toBe("button")
    expect(mapWindowsRole("ControlType.Edit")).toBe("textbox")
    expect(mapWindowsRole("ControlType.Window")).toBe("window")
    expect(mapWindowsRole("ControlType.DataGrid")).toBe("table")
    expect(mapWindowsActions(["invoke", "setvalue", "unknown"])).toEqual(["click", "setvalue"])
  })

  test("maps a raw element into a universal UIElement", () => {
    const element = toWindowsElement({
      id: "win:42.1.0",
      parentId: "win:42.1",
      role: "ControlType.Button",
      name: "Save",
      description: "Save the document",
      value: "go",
      enabled: true,
      focused: false,
      selected: true,
      offscreen: false,
      bounds: { x: 0, y: 0, width: 90, height: 30 },
      actions: ["invoke"],
      pid: 1234,
    })
    expect(element?.role).toBe("button")
    expect(element?.states).toEqual(["selected"])
    expect(element?.actions).toEqual(["click"])
    expect(element?.metadata?.backend).toBe("windows-uia")
    expect(toWindowsElement({ id: "" })).toBeUndefined()
  })

  test("parses observations including single-object and BOM output", () => {
    const single = parseWindowsObservation(
      `\uFEFF${JSON.stringify({ id: "win:1.0", role: "ControlType.Window", name: "Notepad", enabled: true })}`,
    )
    expect(single.elements).toHaveLength(1)
    expect(single.elements[0]?.role).toBe("window")

    const list = parseWindowsObservation(
      JSON.stringify([
        { id: "win:1.0", role: "ControlType.Window", name: "Notepad", actions: "close" },
        { id: "win:1.0.0", role: "ControlType.Edit", name: "Text", enabled: false },
      ]),
    )
    expect(list.elements).toHaveLength(2)
    expect(list.elements[0]?.actions).toEqual(["close"])
    expect(list.elements[1]?.states).toEqual(["disabled"])

    expect(parseWindowsObservation("").error).toBeDefined()
    expect(parseWindowsObservation("nonsense").error).toBeDefined()
  })
})
