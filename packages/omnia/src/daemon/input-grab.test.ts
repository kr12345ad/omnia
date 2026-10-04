import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { INPUT_ESCAPE_WINDOW_MS, INPUT_GRAB_SCRIPT, parseInputGrabLine } from "./input-grab-script"
import { LinuxHostDriver } from "./linux"
import { XTEST_SCRIPT } from "./xtest-script"

describe("input grab script", () => {
  test("grabs and releases the pointer and keyboard on the root window", () => {
    expect(INPUT_GRAB_SCRIPT).toContain("XGrabPointer(")
    expect(INPUT_GRAB_SCRIPT).toContain("XGrabKeyboard(")
    expect(INPUT_GRAB_SCRIPT).toContain("XUngrabPointer(")
    expect(INPUT_GRAB_SCRIPT).toContain("XUngrabKeyboard(")
    expect(INPUT_GRAB_SCRIPT).toContain("XDefaultRootWindow")
    expect(INPUT_GRAB_SCRIPT).toContain("GRAB_EVENT_MASK = BUTTON_PRESS_MASK | BUTTON_RELEASE_MASK | POINTER_MOTION_MASK")
    expect(INPUT_GRAB_SCRIPT).toContain("XGrabPointer(\n    DISPLAY, ROOT, 0, GRAB_EVENT_MASK, GRAB_MODE_ASYNC, GRAB_MODE_ASYNC, 0, 0, CURRENT_TIME")
    expect(INPUT_GRAB_SCRIPT).toContain("XGrabKeyboard(DISPLAY, ROOT, 0, GRAB_MODE_ASYNC, GRAB_MODE_ASYNC, CURRENT_TIME)")
  })

  test("reports every grab status by name", () => {
    for (const status of ["GrabSuccess", "AlreadyGrabbed", "GrabInvalidTime", "GrabNotViewable", "GrabFrozen"]) {
      expect(INPUT_GRAB_SCRIPT).toContain(status)
    }
  })

  test("detects two Escape presses within the escape window", () => {
    expect(INPUT_ESCAPE_WINDOW_MS).toBe(700)
    expect(INPUT_GRAB_SCRIPT).toContain("ESCAPE_WINDOW_MS = 700")
    expect(INPUT_GRAB_SCRIPT).toContain("XKeysymToKeycode(DISPLAY, 0xFF1B)")
    expect(INPUT_GRAB_SCRIPT).toContain("event.type != KEY_PRESS or event.xkey.keycode != ESCAPE_KEYCODE")
    expect(INPUT_GRAB_SCRIPT).toContain("now - last_escape_time <= ESCAPE_WINDOW_MS")
    expect(INPUT_GRAB_SCRIPT).toContain('release("escape")')
  })

  test("releases on signals and on stdin EOF", () => {
    expect(INPUT_GRAB_SCRIPT).toContain("signal.signal(signal.SIGTERM, on_signal)")
    expect(INPUT_GRAB_SCRIPT).toContain("signal.signal(signal.SIGINT, on_signal)")
    expect(INPUT_GRAB_SCRIPT).toContain("threading.Thread(target=watch_stdin, daemon=True).start()")
    expect(INPUT_GRAB_SCRIPT).toContain("sys.stdin.buffer.read(1)")
    expect(INPUT_GRAB_SCRIPT).toContain('emit({"event": "released", "reason": reason})')
    expect(INPUT_GRAB_SCRIPT).toContain("os._exit(0)")
  })

  test("parses the JSON lines the script emits", () => {
    expect(parseInputGrabLine('{"event":"frozen"}')).toEqual({ event: "frozen" })
    expect(parseInputGrabLine('{"event":"released","reason":"escape"}')).toEqual({
      event: "released",
      reason: "escape",
    })
    expect(parseInputGrabLine('{"event":"error","error":"XGrabPointer failed","status":"AlreadyGrabbed"}')).toEqual({
      event: "error",
      error: "XGrabPointer failed",
      status: "AlreadyGrabbed",
    })
    expect(parseInputGrabLine("not json")).toBeUndefined()
    expect(parseInputGrabLine('{"event":"unknown"}')).toBeUndefined()
  })

  test("compiles as valid Python", () => {
    const check = spawnSync("python3", ["-c", "import ast, sys; ast.parse(sys.argv[1])", INPUT_GRAB_SCRIPT])
    if (check.error !== undefined) return
    expect(check.status).toBe(0)
  })
})

describe("xtest script", () => {
  test("makes synthetic input impervious to server grabs", () => {
    expect(XTEST_SCRIPT).toContain("XTestGrabControl")
    expect(XTEST_SCRIPT).toContain("xtst.XTestGrabControl.argtypes = [ctypes.c_void_p, ctypes.c_int]")
    expect(XTEST_SCRIPT).toContain("xtst.XTestGrabControl(DISPLAY, 1)")
  })

  test("declares ctypes signatures for every X11 and XTEST call", () => {
    const used = new Set<string>()
    for (const match of XTEST_SCRIPT.matchAll(/\b(x11|xtst)\.([A-Za-z_][A-Za-z0-9_]*)\(/g)) {
      used.add(`${match[1]}.${match[2]}`)
    }
    expect(used.size).toBeGreaterThan(5)
    for (const name of used) {
      // Without argtypes ctypes truncates 64-bit pointers (Display, Window)
      // and the helper dies inside libX11.
      expect(XTEST_SCRIPT, `${name} must declare argtypes`).toContain(`${name}.argtypes`)
    }
  })

  test("declares the window move/resize and work area signatures", () => {
    expect(XTEST_SCRIPT).toContain(
      "x11.XMoveResizeWindow.argtypes = [\n    ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_int, ctypes.c_uint, ctypes.c_uint,\n]",
    )
    expect(XTEST_SCRIPT).toContain("x11.XMoveResizeWindow.restype = ctypes.c_int")
    expect(XTEST_SCRIPT).toContain("x11.XGetWindowProperty.restype = ctypes.c_int")
    expect(XTEST_SCRIPT).toContain("x11.XGetWindowProperty.argtypes")
    expect(XTEST_SCRIPT).toContain("x11.XFree.argtypes = [ctypes.c_void_p]")
    expect(XTEST_SCRIPT).toContain("x11.XDisplayWidth.argtypes = [ctypes.c_void_p, ctypes.c_int]")
    expect(XTEST_SCRIPT).toContain("x11.XDisplayHeight.argtypes = [ctypes.c_void_p, ctypes.c_int]")
  })

  test("parses as valid Python", () => {
    const check = spawnSync("python3", ["-c", "import ast, sys; ast.parse(sys.argv[1])", XTEST_SCRIPT])
    if (check.error !== undefined) return
    expect(check.status).toBe(0)
  })
})

describe("linux driver input grab state", () => {
  test("reports unsupported without an X11 display and never spawns a helper", async () => {
    const host = new LinuxHostDriver({ display: "" })
    const state = await host.inputGrabState()
    expect(state.supported).toBe(false)
    expect(state.frozen).toBe(false)
    const grab = await host.grabInput("test")
    expect(grab.success).toBe(false)
    expect(grab.supported).toBe(false)
    const release = await host.releaseInput()
    expect(release.success).toBe(true)
    expect(release.frozen).toBe(false)
  })

  test("reports an available but unfrozen display", async () => {
    const host = new LinuxHostDriver({ display: ":0" })
    const state = await host.inputGrabState()
    expect(state.success).toBe(true)
    expect(state.supported).toBe(process.platform === "linux")
    expect(state.frozen).toBe(false)
  })
})
