import { describe, expect, test } from "bun:test"
import {
  FOCUS_CENTER_TOLERANCE_PX,
  FOCUS_OFF_CENTER_DISTANCE_PX,
  focusedWindowName,
  isKWinWindowId,
  isScreenCenterClick,
  isWrongTargetCenterClick,
  matchesWindowTitle,
  parseKWinMinimized,
  screenCenterFor,
  targetCenterOf,
  verifyFocusTrial,
  verifyFocusedWindow,
  verifyWindowClosed,
  verifyWindowFocused,
  verifyWindowMinimized,
  verifyWindowState,
  windowElementIdFromObservation,
  windowPresentInObservation,
  type KWinShellResult,
} from "./kwin-verify"

describe("focus harness: screen-center + wrong-target guard (critic 20/20)", () => {
  test("locked tolerances are +/-25px center and >150px off-center", () => {
    expect(FOCUS_CENTER_TOLERANCE_PX).toBe(25)
    expect(FOCUS_OFF_CENTER_DISTANCE_PX).toBe(150)
  })

  test("screen center for 1920x1080 is (960,540)", () => {
    expect(screenCenterFor(1920, 1080)).toEqual({ x: 960, y: 540 })
    expect(targetCenterOf({ x: 0, y: 0, width: 100, height: 60 })).toEqual({ x: 50, y: 30 })
  })

  test("observed (960,539) counts as screen-center; Close-X does not", () => {
    expect(isScreenCenterClick({ x: 960, y: 539 }, { width: 1920, height: 1080 })).toBe(true)
    expect(isScreenCenterClick({ x: 960, y: 540 }, { width: 1920, height: 1080 })).toBe(true)
    expect(isScreenCenterClick({ x: 1843, y: 45 }, { width: 1920, height: 1080 })).toBe(false)
    expect(isScreenCenterClick({ x: 100, y: 100 }, { width: 1920, height: 1080 })).toBe(false)
  })

  test("tolerance edge: 25px inside, 26px outside", () => {
    expect(isScreenCenterClick({ x: 960 + 25, y: 540 }, { width: 1920, height: 1080 })).toBe(true)
    expect(isScreenCenterClick({ x: 960 + 26, y: 540 }, { width: 1920, height: 1080 })).toBe(false)
  })

  test("wrong-target guard fires on center-click for off-center Kitty window", () => {
    // Kitty "OC | Quick hello" body off-center (e.g. left half), click landed at screen center.
    const offCenterKitty = { x: 40, y: 120, width: 760, height: 800 }
    expect(
      isWrongTargetCenterClick({
        point: { x: 960, y: 539 },
        targetBounds: offCenterKitty,
        screen: { width: 1920, height: 1080 },
      }),
    ).toBe(true)
  })

  test("wrong-target guard passes for on-center target and for off-center clicks", () => {
    const centered = { x: 860, y: 440, width: 200, height: 200 } // center (960,540)
    expect(
      isWrongTargetCenterClick({
        point: { x: 960, y: 539 },
        targetBounds: centered,
        screen: { width: 1920, height: 1080 },
      }),
    ).toBe(false)
    const offCenter = { x: 40, y: 120, width: 760, height: 800 }
    expect(
      isWrongTargetCenterClick({
        point: { x: 420, y: 520 },
        targetBounds: offCenter,
        screen: { width: 1920, height: 1080 },
      }),
    ).toBe(false)
    expect(isWrongTargetCenterClick({ point: { x: 960, y: 539 } })).toBe(false)
  })

  test("matchesWindowTitle preserves pipe and is case-insensitive substring", () => {
    expect(matchesWindowTitle("OC | Quick hello", "OC | Quick hello")).toBe(true)
    expect(matchesWindowTitle("oc | quick hello — kitty", "OC | Quick hello")).toBe(true)
    expect(matchesWindowTitle("OC | Quick hello", "kitty")).toBe(false)
    expect(matchesWindowTitle("Kitty — OC | Quick hello", "kitty")).toBe(true)
    expect(matchesWindowTitle("Kitty — OC | Quick hello", "OC | Quick hello")).toBe(true)
    expect(matchesWindowTitle("Some Other App", "OC | Quick hello")).toBe(false)
    expect(matchesWindowTitle(undefined, "OC | Quick hello")).toBe(false)
    expect(matchesWindowTitle("OC | Quick hello", "")).toBe(false)
    expect(matchesWindowTitle("  OC | Quick Hello  ", "oc | quick hello")).toBe(true)
  })

  test("verifyWindowFocused requires activeWindow==target (no coordinate verifies)", () => {
    expect(verifyWindowFocused({ expectedTitle: "OC | Quick hello", afterTitle: "OC | Quick hello" }).status).toBe("verified")
    expect(verifyWindowFocused({ expectedTitle: "OC | Quick hello", afterTitle: "Some Other App" }).status).toBe("unverified")
    expect(verifyWindowFocused({ expectedTitle: "OC | Quick hello", afterTitle: undefined }).status).toBe("unverified")
  })

  test("reproduces live failure: center-click + unfocused Kitty = unverified with wrong-target evidence", () => {
    const verdict = verifyFocusTrial({
      expectedTitle: "OC | Quick hello",
      afterTitle: "Some Other App",
      clickedPoint: { x: 960, y: 539 },
      targetBounds: { x: 40, y: 120, width: 760, height: 800 },
      screen: { width: 1920, height: 1080 },
    })
    expect(verdict.status).toBe("unverified")
    expect(verdict.message ?? "").toMatch(/Wrong-target/i)
    expect(verdict.evidence?.some((e) => e.kind === "wrong-target")).toBe(true)
  })

  test("fixed path: focus_window by title with matching activeWindow = verified, no wrong-target", () => {
    const verdict = verifyFocusTrial({
      expectedTitle: "OC | Quick hello",
      afterTitle: "OC | Quick hello",
      // No clicked point on the focus_window path (no semantic click at all).
    })
    expect(verdict.status).toBe("verified")
    expect(verdict.evidence?.some((e) => e.kind === "window-focused")).toBe(true)
  })

  test("focus trial still fails closed when title mismatches without any click", () => {
    const verdict = verifyFocusTrial({ expectedTitle: "OC | Quick hello", afterTitle: "Terminal — bash" })
    expect(verdict.status).toBe("unverified")
  })

  test("focusedWindowName prefers focused element name, falls back to metadata", () => {
    const obs1 = {
      elements: [{ id: "w1", role: "window", name: "OC | Quick hello", states: ["focused"] }],
      metadata: {},
    } as unknown as Parameters<typeof focusedWindowName>[0]
    expect(focusedWindowName(obs1)).toBe("OC | Quick hello")
    const obs2 = { elements: [], metadata: { windowTitle: "OC | Quick hello" } } as unknown as Parameters<
      typeof focusedWindowName
    >[0]
    expect(focusedWindowName(obs2)).toBe("OC | Quick hello")
    expect(focusedWindowName(undefined)).toBeUndefined()
  })
})

describe("focus-gain verification", () => {
  test("verifies the same element id and fails closed on a different focused window", () => {
    const already = verifyFocusedWindow({
      expectedWindowId: "w1",
      after: { elements: [{ id: "w1", role: "window", name: "Editor", states: ["focused"] }] },
    })
    expect(already.status).toBe("verified")

    const moved = verifyFocusedWindow({
      expectedWindowId: "w1",
      expectedTitle: "Editor",
      after: { elements: [{ id: "w2", role: "window", name: "Other", states: ["focused"] }] },
    })
    expect(moved.status).toBe("unverified")
    expect(moved.message).toContain("not focused")
    expect(moved.message).toContain("Other")
  })

  test("verifies through matching X11 ids carried by the target's own metadata", () => {
    const verdict = verifyFocusedWindow({
      expectedWindowId: "cua:window/editor",
      after: {
        elements: [
          { id: "cua:window/editor", role: "window", name: "Editor", metadata: { x11WindowId: "0x1" } },
          { id: "cua:window/other", role: "window", name: "Other", states: ["focused"], metadata: { x11WindowId: "0x1" } },
        ],
      },
    })
    expect(verdict.status).toBe("verified")
    expect(windowElementIdFromObservation(
      { elements: [{ id: "cua:window/editor", metadata: { x11WindowId: "0x1" } }] },
      "cua:window/editor",
    )).toBe("0x1")
  })

  test("verifies a focused title match when the id changed and fails closed with no active window", () => {
    const byTitle = verifyFocusedWindow({
      expectedWindowId: "cua:window/editor",
      expectedTitle: "Vendor_Master.ods - LibreOffice Calc",
      after: { elements: [{ id: "w9", role: "window", name: "Vendor_Master.ods - LibreOffice Calc", states: ["focused"] }] },
    })
    expect(byTitle.status).toBe("verified")

    const none = verifyFocusedWindow({
      expectedWindowId: "w1",
      after: { elements: [{ id: "w1", role: "window", name: "Editor" }] },
    })
    expect(none.status).toBe("unverified")
    expect(none.message).toContain("no active window")
  })

  test("verifyWindowState expectFocused verifies an already-focused target from the observation", async () => {
    const verdict = await verifyWindowState({
      settleMs: 0,
      expectFocused: true,
      expectedWindowId: "w1",
      after: { elements: [{ id: "w1", role: "window", name: "Editor", states: ["focused"] }] },
    })
    expect(verdict.status).toBe("verified")
    expect(verdict.method).toBe("atspi-focus")
  })

  test("verifyWindowState expectFocused accepts a positive KWin id match", async () => {
    const runner = async (command: string): Promise<KWinShellResult | undefined> => {
      if (command.includes("activeWindow")) return { stdout: "0x1", exitCode: 0 }
      return undefined
    }
    const verdict = await verifyWindowState({
      runShell: runner,
      settleMs: 0,
      expectFocused: true,
      expectedWindowId: "0x1",
      after: { elements: [{ id: "0x1", role: "window", name: "Editor", states: ["focused"] }] },
    })
    expect(verdict.status).toBe("verified")
    expect(verdict.method).toBe("kwin-dbus")
  })

  test("verifyWindowState minimize still fails closed without minimized=true", async () => {
    const runner = async (command: string): Promise<KWinShellResult | undefined> => {
      if (command.includes("activeWindow")) return { stdout: "0x1", exitCode: 0 }
      if (command.includes("getWindowInfo")) return { stdout: "minimized: false", exitCode: 0 }
      return undefined
    }
    const verdict = await verifyWindowState({
      runShell: runner,
      settleMs: 0,
      expectedWindowId: "0x1",
      expectMinimized: true,
      after: { elements: [{ id: "0x1", role: "window", name: "Editor", states: ["focused"] }] },
    })
    expect(verdict.status).toBe("unverified")
    expect(verdict.message).toContain("not minimized")
  })
})

describe("window state verification direction and parsing", () => {
  test("parseKWinMinimized anchors the key and ignores minimizable", () => {
    expect(parseKWinMinimized("minimized: true")).toBe(true)
    expect(parseKWinMinimized("minimize: false")).toBe(false)
    expect(parseKWinMinimized("minimizable: true")).toBeUndefined()
    expect(parseKWinMinimized("UnknownMethod")).toBeUndefined()
  })

  test("verifyWindowMinimized rejects a minimized window for restore/maximize", () => {
    const minimized = verifyWindowMinimized({ minimized: true, expectMinimized: true, method: "kwin-dbus" })
    expect(minimized.status).toBe("verified")
    const restore = verifyWindowMinimized({ minimized: true, expectMinimized: false, method: "kwin-dbus" })
    expect(restore.status).toBe("unverified")
    const maximize = verifyWindowMinimized({ minimized: false, expectMinimized: false, expectedWindowPresent: true, method: "kwin-dbus" })
    expect(maximize.status).toBe("verified")
    const stillMinimized = verifyWindowMinimized({ minimized: false, expectMinimized: true, method: "kwin-dbus" })
    expect(stillMinimized.status).toBe("unverified")
  })

  test("verifyWindowState honors the action direction against a fake KWin runner", async () => {
    const runner = async (command: string): Promise<KWinShellResult | undefined> => {
      if (command.includes("activeWindow")) return { stdout: "0x1", exitCode: 0 }
      if (command.includes("getWindowInfo")) return { stdout: "minimized: true", exitCode: 0 }
      return undefined
    }
    const minimize = await verifyWindowState({
      runShell: runner,
      settleMs: 0,
      expectedWindowId: "0x1",
      expectMinimized: true,
    })
    expect(minimize.status).toBe("verified")
    const restore = await verifyWindowState({
      runShell: runner,
      settleMs: 0,
      expectedWindowId: "0x1",
      expectMinimized: false,
    })
    expect(restore.status).toBe("unverified")
  })

  test("verifyWindowState resolves AT-SPI ids through metadata X11 ids", async () => {
    const runner = async (command: string): Promise<KWinShellResult | undefined> => {
      if (command.includes("activeWindow")) return { stdout: "0x1", exitCode: 0 }
      if (command.includes("getWindowInfo")) {
        expect(command).toContain("0x1")
        return { stdout: "minimized: false", exitCode: 0 }
      }
      return undefined
    }
    const verdict = await verifyWindowState({
      runShell: runner,
      settleMs: 0,
      expectedWindowId: "cua:window/editor",
      expectMinimized: false,
      after: {
        elements: [
          {
            id: "cua:window/editor",
            role: "window",
            name: "Editor",
            states: [],
            metadata: { x11WindowId: "0x1" },
          },
        ],
      },
    })
    expect(verdict.status).toBe("verified")
    expect(isKWinWindowId("0x1")).toBe(true)
    expect(isKWinWindowId("cua:window/editor")).toBe(false)
    expect(windowPresentInObservation({ elements: [{ id: "cua:window/editor", metadata: { x11WindowId: "0x1" } }] }, "0x1")).toBe(true)
  })

  test("verifyWindowClosed fails on a truncated observation and verifies absence", () => {
    const truncated = verifyWindowClosed({
      expectedWindowId: "0x1",
      after: { elements: [], metadata: { truncated: true } },
    })
    expect(truncated.status).toBe("unverified")
    const absent = verifyWindowClosed({ expectedWindowId: "0x1", after: { elements: [] } })
    expect(absent.status).toBe("verified")
    const present = verifyWindowClosed({
      expectedWindowId: "0x1",
      after: { elements: [{ id: "0x1", role: "window" }] },
    })
    expect(present.status).toBe("unverified")
  })
})
