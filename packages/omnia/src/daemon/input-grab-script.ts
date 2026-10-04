export const INPUT_ESCAPE_WINDOW_MS = 700

export type InputGrabReleasedBy = "escape" | "signal" | "request"

export interface InputGrabMessage {
  readonly event: "frozen" | "released" | "error"
  readonly reason?: string
  readonly error?: string
  readonly status?: string
}

// This helper freezes physical mouse and keyboard input by grabbing the
// pointer and keyboard on the X root window. Omnia's own XTest input keeps
// working because that helper calls XTestGrabControl(display, 1), which makes
// its synthetic events bypass server grabs. The only escape hatch is pressing
// Escape twice within INPUT_ESCAPE_WINDOW_MS, which releases both grabs at
// once. The parent runtime keeps this process's stdin pipe open; EOF means the
// runtime went away, so the grab must not outlive it. stdout carries JSON
// lines only.
export const INPUT_GRAB_SCRIPT = `import ctypes
import json
import os
import signal
import sys
import threading
import time

ESCAPE_WINDOW_MS = 700
BUTTON_PRESS_MASK = 1 << 2
BUTTON_RELEASE_MASK = 1 << 3
POINTER_MOTION_MASK = 1 << 6
GRAB_EVENT_MASK = BUTTON_PRESS_MASK | BUTTON_RELEASE_MASK | POINTER_MOTION_MASK
GRAB_MODE_ASYNC = 1
CURRENT_TIME = 0
KEY_PRESS = 2

GRAB_STATUS = {
    0: "GrabSuccess",
    1: "AlreadyGrabbed",
    2: "GrabInvalidTime",
    3: "GrabNotViewable",
    4: "GrabFrozen",
}

x11 = ctypes.CDLL("libX11.so.6")

x11.XOpenDisplay.restype = ctypes.c_void_p
x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
x11.XDefaultRootWindow.restype = ctypes.c_ulong
x11.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
x11.XKeysymToKeycode.restype = ctypes.c_ubyte
x11.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
x11.XGrabPointer.restype = ctypes.c_int
x11.XGrabPointer.argtypes = [
    ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_uint,
    ctypes.c_int, ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong,
]
x11.XGrabKeyboard.restype = ctypes.c_int
x11.XGrabKeyboard.argtypes = [
    ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int,
    ctypes.c_int, ctypes.c_int, ctypes.c_ulong,
]
x11.XUngrabPointer.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
x11.XUngrabKeyboard.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
x11.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
x11.XPending.restype = ctypes.c_int
x11.XPending.argtypes = [ctypes.c_void_p]
x11.XNextEvent.argtypes = [ctypes.c_void_p, ctypes.c_void_p]


class XKeyEvent(ctypes.Structure):
    _fields_ = [
        ("type", ctypes.c_int),
        ("serial", ctypes.c_ulong),
        ("send_event", ctypes.c_int),
        ("display", ctypes.c_void_p),
        ("window", ctypes.c_ulong),
        ("root", ctypes.c_ulong),
        ("subwindow", ctypes.c_ulong),
        ("time", ctypes.c_ulong),
        ("x", ctypes.c_int),
        ("y", ctypes.c_int),
        ("x_root", ctypes.c_int),
        ("y_root", ctypes.c_int),
        ("state", ctypes.c_uint),
        ("keycode", ctypes.c_uint),
        ("same_screen", ctypes.c_int),
    ]


class XEvent(ctypes.Union):
    _fields_ = [
        ("type", ctypes.c_int),
        ("xkey", XKeyEvent),
        ("pad", ctypes.c_long * 24),
    ]


def emit(payload):
    sys.stdout.write(json.dumps(payload))
    sys.stdout.write("\\n")
    sys.stdout.flush()


def fail(message, status=None):
    payload = {"event": "error", "error": message}
    if status is not None:
        payload["status"] = status
    emit(payload)
    os._exit(1)


DISPLAY = x11.XOpenDisplay(None)
if not DISPLAY:
    fail("cannot open the X display")
ROOT = x11.XDefaultRootWindow(DISPLAY)
ESCAPE_KEYCODE = x11.XKeysymToKeycode(DISPLAY, 0xFF1B)
if ESCAPE_KEYCODE == 0:
    fail("no Escape keycode on this display")

release_lock = threading.Lock()
released = False


def release(reason):
    global released
    with release_lock:
        if released:
            return
        released = True
        try:
            x11.XUngrabPointer(DISPLAY, CURRENT_TIME)
            x11.XUngrabKeyboard(DISPLAY, CURRENT_TIME)
            x11.XSync(DISPLAY, 0)
        except Exception:
            pass
    emit({"event": "released", "reason": reason})
    os._exit(0)


def on_signal(_signum, _frame):
    release("signal")


signal.signal(signal.SIGTERM, on_signal)
signal.signal(signal.SIGINT, on_signal)


def watch_stdin():
    try:
        sys.stdin.buffer.read(1)
    except Exception:
        pass
    release("signal")


threading.Thread(target=watch_stdin, daemon=True).start()

pointer_status = x11.XGrabPointer(
    DISPLAY, ROOT, 0, GRAB_EVENT_MASK, GRAB_MODE_ASYNC, GRAB_MODE_ASYNC, 0, 0, CURRENT_TIME
)
if pointer_status != 0:
    fail("XGrabPointer failed", GRAB_STATUS.get(pointer_status, "GrabStatus" + str(pointer_status)))
keyboard_status = x11.XGrabKeyboard(DISPLAY, ROOT, 0, GRAB_MODE_ASYNC, GRAB_MODE_ASYNC, CURRENT_TIME)
if keyboard_status != 0:
    x11.XUngrabPointer(DISPLAY, CURRENT_TIME)
    x11.XSync(DISPLAY, 0)
    fail("XGrabKeyboard failed", GRAB_STATUS.get(keyboard_status, "GrabStatus" + str(keyboard_status)))
x11.XSync(DISPLAY, 0)
emit({
    "event": "frozen",
    "pointer": GRAB_STATUS.get(pointer_status, "GrabStatus" + str(pointer_status)),
    "keyboard": GRAB_STATUS.get(keyboard_status, "GrabStatus" + str(keyboard_status)),
})

last_escape_time = None
while True:
    while x11.XPending(DISPLAY) > 0:
        event = XEvent()
        x11.XNextEvent(DISPLAY, ctypes.byref(event))
        if event.type != KEY_PRESS or event.xkey.keycode != ESCAPE_KEYCODE:
            continue
        now = int(event.xkey.time)
        if last_escape_time is not None and 0 <= now - last_escape_time <= ESCAPE_WINDOW_MS:
            release("escape")
        last_escape_time = now
    time.sleep(0.02)
`

export function parseInputGrabLine(line: string): InputGrabMessage | undefined {
  try {
    const parsed: unknown = JSON.parse(line)
    if (typeof parsed !== "object" || parsed === null) return undefined
    const record = parsed as Record<string, unknown>
    if (record.event === "frozen") return { event: "frozen" }
    if (record.event === "released") {
      return { event: "released", ...(typeof record.reason === "string" ? { reason: record.reason } : {}) }
    }
    if (record.event === "error") {
      return {
        event: "error",
        ...(typeof record.error === "string" ? { error: record.error } : {}),
        ...(typeof record.status === "string" ? { status: record.status } : {}),
      }
    }
    return undefined
  } catch {
    return undefined
  }
}
