export const XTEST_SCRIPT = `import ctypes
import json
import random
import signal
import sys
import time

# XTest gives global keyboard and pointer control on X11 even when an
# application exposes no accessibility tree at all.

x11 = ctypes.CDLL("libX11.so.6")
xtst = ctypes.CDLL("libXtst.so.6")

x11.XOpenDisplay.restype = ctypes.c_void_p
x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
x11.XStringToKeysym.restype = ctypes.c_ulong
x11.XStringToKeysym.argtypes = [ctypes.c_char_p]
x11.XKeysymToKeycode.restype = ctypes.c_ubyte
x11.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
x11.XFlush.argtypes = [ctypes.c_void_p]
x11.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
x11.XDefaultRootWindow.restype = ctypes.c_ulong
x11.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
x11.XInternAtom.restype = ctypes.c_ulong
x11.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
x11.XRaiseWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
x11.XMapRaised.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
x11.XIconifyWindow.restype = ctypes.c_int
x11.XIconifyWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int]
x11.XDefaultScreen.restype = ctypes.c_int
x11.XDefaultScreen.argtypes = [ctypes.c_void_p]
x11.XSetInputFocus.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
x11.XSendEvent.restype = ctypes.c_int
x11.XSendEvent.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_long, ctypes.c_void_p]
x11.XQueryPointer.restype = ctypes.c_int
x11.XQueryPointer.argtypes = [
    ctypes.c_void_p, ctypes.c_ulong,
    ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_ulong),
    ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int),
    ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int),
    ctypes.POINTER(ctypes.c_uint),
]
xtst.XTestFakeKeyEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
xtst.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
xtst.XTestFakeMotionEvent.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong]

SHIFT = "Shift_L"
MODIFIERS = {
    "ctrl": "Control_L", "control": "Control_L",
    "shift": "Shift_L",
    "alt": "Alt_L", "option": "Alt_L",
    "super": "Super_L", "meta": "Super_L", "cmd": "Super_L", "win": "Super_L",
}
NAMED_KEYS = {
    "return": "Return", "enter": "Return", "tab": "Tab", "escape": "Escape", "esc": "Escape",
    "backspace": "BackSpace", "delete": "Delete", "insert": "Insert", "home": "Home", "end": "End",
    "pageup": "Page_Up", "page_up": "Page_Up", "pagedown": "Page_Down", "page_down": "Page_Down",
    "left": "Left", "up": "Up", "right": "Right", "down": "Down", "space": "space",
    "f1": "F1", "f2": "F2", "f3": "F3", "f4": "F4", "f5": "F5", "f6": "F6",
    "f7": "F7", "f8": "F8", "f9": "F9", "f10": "F10", "f11": "F11", "f12": "F12",
}
CHAR_KEYS = {
    " ": ("space", False),
    "!": ("1", True), "@": ("2", True), "#": ("3", True), "$": ("4", True), "%": ("5", True),
    "^": ("6", True), "&": ("7", True), "*": ("8", True), "(": ("9", True), ")": ("0", True),
    "-": ("minus", False), "_": ("minus", True), "=": ("equal", False), "+": ("equal", True),
    "[": ("bracketleft", False), "{": ("bracketleft", True), "]": ("bracketright", False),
    "}": ("bracketright", True), "\\\\": ("backslash", False), "|": ("backslash", True),
    ";": ("semicolon", False), ":": ("semicolon", True), "'": ("apostrophe", False),
    '"': ("apostrophe", True), ",": ("comma", False), "<": ("comma", True),
    ".": ("period", False), ">": ("period", True), "/": ("slash", False), "?": ("slash", True),
    "\`": ("grave", False), "~": ("grave", True),
}


def fail(message):
    sys.stdout.write(json.dumps({"ok": False, "error": message}))
    sys.stdout.write("\\n")
    sys.exit(1)


def emit(payload):
    sys.stdout.write(json.dumps(payload))
    sys.stdout.write("\\n")


def opt(name):
    if name in sys.argv:
        return sys.argv[sys.argv.index(name) + 1]
    return None


DISPLAY = x11.XOpenDisplay(None)
if not DISPLAY:
    fail("cannot open the X display")


def release_all():
    # Releasing an unpressed key is a no-op, so this is safe and also clears
    # any key left held by an earlier interrupted helper process.
    for code in range(8, 256):
        xtst.XTestFakeKeyEvent(DISPLAY, code, 0, 0)
    xtst.XTestFakeButtonEvent(DISPLAY, 1, 0, 0)
    xtst.XTestFakeButtonEvent(DISPLAY, 2, 0, 0)
    xtst.XTestFakeButtonEvent(DISPLAY, 3, 0, 0)
    x11.XFlush(DISPLAY)
    x11.XSync(DISPLAY, 0)


def release_on_signal(_signum, _frame):
    try:
        release_all()
    except Exception:
        pass
    sys.exit(1)


signal.signal(signal.SIGTERM, release_on_signal)
signal.signal(signal.SIGINT, release_on_signal)


def keysym(name):
    value = x11.XStringToKeysym(name.encode("utf-8"))
    if value == 0:
        fail("unknown key: " + name)
    return value


def keycode(name):
    code = x11.XKeysymToKeycode(DISPLAY, keysym(name))
    if code == 0:
        fail("no keycode for key: " + name)
    return code


def tap(name, shift=False, pace=25):
    if shift:
        code = keycode(SHIFT)
        xtst.XTestFakeKeyEvent(DISPLAY, code, 1, 0)
    code = keycode(name)
    # XTest treats the delay argument as milliseconds to wait after the event.
    # Events are queued here and only flushed once per command; the release
    # delay paces the queue without a round trip per key.
    xtst.XTestFakeKeyEvent(DISPLAY, code, 1, 0)
    xtst.XTestFakeKeyEvent(DISPLAY, code, 0, pace)
    if shift:
        code = keycode(SHIFT)
        xtst.XTestFakeKeyEvent(DISPLAY, code, 0, 0)


def resolve_key(token, skipped):
    if token == " ":
        return "space", False
    key = token.strip()
    if key == "":
        return None, False
    lower = key.lower()
    if lower in MODIFIERS:
        return MODIFIERS[lower], False
    if lower in NAMED_KEYS:
        return NAMED_KEYS[lower], False
    if len(key) == 1:
        if key in CHAR_KEYS:
            name, shift = CHAR_KEYS[key]
            return name, shift
        if key.isalpha():
            return (key.lower(), key.isupper())
        if key.isdigit():
            return (key, False)
        skipped.append(key)
        return None, False
    return key, False


def cmd_key():
    keys = opt("--keys") or ""
    parts = [part for part in keys.split("+") if part.strip() != ""]
    if len(parts) == 0:
        fail("no keys requested")
    modifiers = []
    skipped = []
    taps = []
    for part in parts:
        name, shift = resolve_key(part, skipped)
        if name is None:
            continue
        if name in MODIFIERS.values() and len(parts) > 1 and part == parts[-1]:
            continue
        if name in MODIFIERS.values() and len(parts) > 1:
            modifiers.append(name)
            continue
        taps.append((name, shift))
    if len(taps) == 0:
        fail("no actionable keys in: " + keys)
    held = []
    for name in modifiers:
        held.append(keycode(name))
    for code in held:
        xtst.XTestFakeKeyEvent(DISPLAY, code, 1, 0)
    for name, shift in taps:
        tap(name, shift)
    for code in reversed(held):
        xtst.XTestFakeKeyEvent(DISPLAY, code, 0, 0)
    x11.XFlush(DISPLAY)
    x11.XSync(DISPLAY, 0)
    emit({"ok": True, "modifiers": modifiers, "keys": [name for name, _ in taps], "skipped": skipped})


def cmd_type():
    text = opt("--text") or ""
    skipped = []
    pace = int(opt("--pace") or "12")
    for char in text:
        if char == "\\n":
            tap("Return", pace=pace)
            continue
        if char == "\\t":
            tap("Tab", pace=pace)
            continue
        name, shift = resolve_key(char, skipped)
        if name is None:
            continue
        tap(name, shift, pace=pace)
    x11.XFlush(DISPLAY)
    x11.XSync(DISPLAY, 0)
    emit({"ok": True, "typed": len(text) - len(skipped), "skipped": skipped})


def cmd_release():
    release_all()
    emit({"ok": True})


def current_position():
    root = x11.XDefaultRootWindow(DISPLAY)
    root_return = ctypes.c_ulong()
    child_return = ctypes.c_ulong()
    root_x = ctypes.c_int()
    root_y = ctypes.c_int()
    win_x = ctypes.c_int()
    win_y = ctypes.c_int()
    mask = ctypes.c_uint()
    ok = x11.XQueryPointer(
        DISPLAY, root,
        ctypes.byref(root_return), ctypes.byref(child_return),
        ctypes.byref(root_x), ctypes.byref(root_y),
        ctypes.byref(win_x), ctypes.byref(win_y),
        ctypes.byref(mask),
    )
    if not ok:
        return None
    return (root_x.value, root_y.value, mask.value, child_return.value)


def button_held(mask):
    return bool(mask & ((1 << 8) | (1 << 9) | (1 << 10)))


def ease(value):
    # Smoothstep gives slow-in, fast-middle, slow-out motion.
    return value * value * (3 - 2 * value)


def queue_motion(x, y, delay=0):
    xtst.XTestFakeMotionEvent(DISPLAY, -1, int(x), int(y), delay)


def glide_to(x, y, duration_ms=220, jitter=1):
    # Queue an eased path with the X server pacing it, so the pointer moves
    # visibly like a hand rather than teleporting.
    start = current_position()
    if start is None or duration_ms <= 0:
        queue_motion(x, y)
        return
    x1, y1, _mask, _child = start
    if int(x) == x1 and int(y) == y1:
        queue_motion(x, y)
        return
    steps = max(2, min(90, int(duration_ms / 8)))
    delay = max(1, int(duration_ms / steps))
    for index in range(1, steps + 1):
        progress = ease(index / steps)
        offset_x = random.randint(-jitter, jitter) if jitter and index < steps else 0
        offset_y = random.randint(-jitter, jitter) if jitter and index < steps else 0
        px = x1 + (int(x) - x1) * progress + offset_x
        py = y1 + (int(y) - y1) * progress + offset_y
        queue_motion(px, py, delay if index < steps else 0)


def move(x, y):
    queue_motion(x, y)
    x11.XFlush(DISPLAY)
    time.sleep(0.01)


def cmd_position():
    position = current_position()
    if position is None:
        fail("cannot query the pointer")
    x, y, mask, _child = position
    emit({"ok": True, "x": x, "y": y, "buttons": mask, "held": button_held(mask)})


def cmd_pointer_window():
    position = current_position()
    if position is None:
        fail("cannot query the pointer window")
    x, y, _mask, child = position
    emit({"ok": True, "window": hex(child), "x": x, "y": y})


def cmd_move():
    x = int(opt("--x") or "0")
    y = int(opt("--y") or "0")
    duration = int(opt("--duration") or "220")
    glide_to(x, y, duration)
    x11.XFlush(DISPLAY)
    x11.XSync(DISPLAY, 0)
    emit({"ok": True, "x": x, "y": y, "duration": duration})


def cmd_click():
    x = opt("--x")
    y = opt("--y")
    duration = int(opt("--duration") or "220")
    if x is not None and y is not None:
        glide_to(int(x), int(y), duration)
    button = int(opt("--button") or "1")
    count = int(opt("--count") or "1")
    interval = int(opt("--interval") or "120")
    for _ in range(max(1, count)):
        xtst.XTestFakeButtonEvent(DISPLAY, button, 1, 0)
        xtst.XTestFakeButtonEvent(DISPLAY, button, 0, interval)
    x11.XFlush(DISPLAY)
    x11.XSync(DISPLAY, 0)
    emit({"ok": True, "button": button, "count": count, "duration": duration})


def cmd_down():
    button = int(opt("--button") or "1")
    xtst.XTestFakeButtonEvent(DISPLAY, button, 1, 0)
    x11.XFlush(DISPLAY)
    x11.XSync(DISPLAY, 0)
    emit({"ok": True, "button": button})


def cmd_up():
    button = int(opt("--button") or "1")
    xtst.XTestFakeButtonEvent(DISPLAY, button, 0, 0)
    x11.XFlush(DISPLAY)
    x11.XSync(DISPLAY, 0)
    emit({"ok": True, "button": button})


def cmd_scroll():
    direction = (opt("--direction") or "down").lower()
    amount = int(opt("--amount") or "3")
    x = opt("--x")
    y = opt("--y")
    if x is not None and y is not None:
        glide_to(int(x), int(y), int(opt("--duration") or "180"))
    button = {"up": 4, "down": 5, "left": 6, "right": 7}.get(direction)
    if button is None:
        fail("unknown scroll direction: " + direction)
    for _ in range(max(1, amount)):
        xtst.XTestFakeButtonEvent(DISPLAY, button, 1, 0)
        xtst.XTestFakeButtonEvent(DISPLAY, button, 0, 30)
    x11.XFlush(DISPLAY)
    x11.XSync(DISPLAY, 0)
    emit({"ok": True, "direction": direction, "amount": amount})


class XClientMessageEvent(ctypes.Structure):
    _fields_ = [
        ("type", ctypes.c_int),
        ("serial", ctypes.c_ulong),
        ("send_event", ctypes.c_int),
        ("display", ctypes.c_void_p),
        ("window", ctypes.c_ulong),
        ("message_type", ctypes.c_ulong),
        ("format", ctypes.c_int),
        ("data", ctypes.c_long * 5),
    ]


class XEvent(ctypes.Union):
    _fields_ = [
        ("type", ctypes.c_int),
        ("xclient", XClientMessageEvent),
        ("pad", ctypes.c_long * 24),
    ]


def activate_window(window):
    root = x11.XDefaultRootWindow(DISPLAY)
    atom = x11.XInternAtom(DISPLAY, b"_NET_ACTIVE_WINDOW", 0)
    event = XEvent()
    event.xclient.type = 33
    event.xclient.serial = 0
    event.xclient.send_event = 1
    event.xclient.display = DISPLAY
    event.xclient.window = window
    event.xclient.message_type = atom
    event.xclient.format = 32
    event.xclient.data[0] = 2
    event.xclient.data[1] = 0
    mask = (1 << 20) | (1 << 19)
    sent = x11.XSendEvent(DISPLAY, root, 0, mask, ctypes.byref(event))
    x11.XRaiseWindow(DISPLAY, window)
    x11.XSetInputFocus(DISPLAY, window, 1, 0)
    return sent


def cmd_activate():
    raw = opt("--window")
    if not raw:
        fail("no window requested")
    sent = activate_window(int(raw, 0))
    x11.XSync(DISPLAY, 0)
    emit({"ok": True, "sent": bool(sent)})


def cmd_minimize():
    raw = opt("--window")
    if not raw:
        fail("no window requested")
    window = int(raw, 0)
    screen = x11.XDefaultScreen(DISPLAY)
    sent = x11.XIconifyWindow(DISPLAY, window, screen)
    x11.XSync(DISPLAY, 0)
    emit({"ok": True, "sent": bool(sent)})


def cmd_restore():
    raw = opt("--window")
    if not raw:
        fail("no window requested")
    window = int(raw, 0)
    x11.XMapRaised(DISPLAY, window)
    sent = activate_window(window)
    x11.XSync(DISPLAY, 0)
    emit({"ok": True, "sent": bool(sent)})


def cmd_close():
    raw = opt("--window")
    if not raw:
        fail("no window requested")
    window = int(raw, 0)
    protocols = x11.XInternAtom(DISPLAY, b"WM_PROTOCOLS", 0)
    delete = x11.XInternAtom(DISPLAY, b"WM_DELETE_WINDOW", 0)
    event = XEvent()
    event.xclient.type = 33
    event.xclient.serial = 0
    event.xclient.send_event = 1
    event.xclient.display = DISPLAY
    event.xclient.window = window
    event.xclient.message_type = protocols
    event.xclient.format = 32
    event.xclient.data[0] = delete
    event.xclient.data[1] = 0
    x11.XSendEvent(DISPLAY, window, 0, 0, ctypes.byref(event))
    x11.XSync(DISPLAY, 0)
    emit({"ok": True})


def cmd_drag():
    x1 = int(opt("--from-x") or "0")
    y1 = int(opt("--from-y") or "0")
    x2 = int(opt("--to-x") or "0")
    y2 = int(opt("--to-y") or "0")
    button = int(opt("--button") or "1")
    duration = int(opt("--duration") or "600")
    glide_to(x1, y1, int(opt("--approach") or "180"))
    x11.XFlush(DISPLAY)
    x11.XSync(DISPLAY, 0)
    time.sleep(0.05)
    xtst.XTestFakeButtonEvent(DISPLAY, button, 1, 0)
    x11.XFlush(DISPLAY)
    time.sleep(0.05)
    steps = max(4, min(120, int(duration / 10)))
    delay = max(1, int(duration / steps))
    for index in range(1, steps + 1):
        progress = ease(index / steps)
        px = x1 + (x2 - x1) * progress + (random.randint(-1, 1) if index < steps else 0)
        py = y1 + (y2 - y1) * progress + (random.randint(-1, 1) if index < steps else 0)
        queue_motion(px, py, delay)
    xtst.XTestFakeButtonEvent(DISPLAY, button, 0, 0)
    x11.XFlush(DISPLAY)
    x11.XSync(DISPLAY, 0)
    emit({"ok": True, "duration": duration})


COMMANDS = {"key": cmd_key, "type": cmd_type, "move": cmd_move, "click": cmd_click, "scroll": cmd_scroll, "activate": cmd_activate, "close": cmd_close, "drag": cmd_drag, "release": cmd_release, "position": cmd_position, "pointer-window": cmd_pointer_window, "minimize-window": cmd_minimize, "restore-window": cmd_restore, "down": cmd_down, "up": cmd_up}

if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
    fail("unknown command")
COMMANDS[sys.argv[1]]()
`
