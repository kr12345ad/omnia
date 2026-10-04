// Shared pyatspi state normalization used by both the daemon's one-shot
// AT-SPI script and the persistent CUA helper script. Keeping the vocabulary
// and parser in one place prevents the two helpers from drifting.
export const ATSPI_STATE_PY = `
STATE_NAMES = {
    "enabled", "focused", "selected", "checked", "expanded", "collapsed",
    "busy", "modal", "pressed", "readonly", "required", "multiselectable",
    "invalid", "active", "armed", "defunct", "editable", "horizontal",
    "opaque", "resizable", "selectable", "sensitive", "showing",
    "singleline", "stale", "transient", "vertical", "visible", "managesdescendants",
    "iconified", "minimized", "offscreen",
}

CANONICAL_STATES = {
    "busy", "checked", "collapsed", "disabled", "editable", "expanded",
    "focused", "hidden", "mixed", "modal", "multiselectable", "offscreen",
    "pressed", "readonly", "required", "selected", "iconified",
}


def state_name(raw):
    text = str(raw).strip().lower()
    # pyatspi str() looks like "<enum ATSPI_STATE_ENABLED of type Atspi.StateType>".
    match = re.search(r"state[_-]([a-z][a-z_]+)", text)
    if match:
        return match.group(1).replace("-", "_")
    for prefix in ("atspi_state_", "atspi-state-", "state_", "state-"):
        if text.startswith(prefix):
            text = text[len(prefix):]
            break
    result = []
    for char in text:
        if char.isalpha() or char == "_":
            result.append(char)
        elif result:
            break
    return "".join(result).replace("-", "_")


def node_states(accessible):
    try:
        states = accessible.getState()
    except Exception:
        try:
            states = accessible.get_state_set()
        except Exception:
            return []
    try:
        items = states.getStates() if hasattr(states, "getStates") else list(states)
    except Exception:
        return []
    names = []
    for item in items or []:
        name = state_name(item)
        if name in STATE_NAMES and name not in names:
            names.append(name)
    # Only an explicit defunct/disabled state marks a node disabled; absence of
    # SENSITIVE/ENABLED is common across whole trees and must not mark
    # everything disabled.
    canonical = [name for name in names if name in CANONICAL_STATES]
    if names and ("defunct" in names or "disabled" in names):
        if "disabled" not in canonical:
            canonical.append("disabled")
    if ("iconified" in names or "minimized" in names) and "hidden" not in canonical:
        canonical.append("hidden")
    return canonical
`

// Shared AT-SPI keyboard synthesis. AT-SPI only emits single keysym events, so
// a hotkey is expressed as named modifier presses around the key instead of
// one combined event, and shifted symbols are sent as Shift plus the base
// keysym.
export const ATSPI_KEY_PY = `
KEYSYMS = {
    "Return": 0xFF0D, "Tab": 0xFF09, "Escape": 0xFF1B, "BackSpace": 0xFF08,
    "Delete": 0xFFFF, "Insert": 0xFF63, "Home": 0xFF50, "End": 0xFF57,
    "Page_Up": 0xFF55, "Page_Down": 0xFF56, "Left": 0xFF51, "Up": 0xFF52,
    "Right": 0xFF53, "Down": 0xFF54, "space": 0x020,
    "F1": 0xFFBE, "F2": 0xFFBF, "F3": 0xFFC0, "F4": 0xFFC1, "F5": 0xFFC2,
    "F6": 0xFFC3, "F7": 0xFFC4, "F8": 0xFFC5, "F9": 0xFFC6, "F10": 0xFFC7,
    "F11": 0xFFC8, "F12": 0xFFC9,
}

SHIFT = 0xFFE1

MODIFIER_KEYSYMS = {
    "ctrl": 0xFFE3, "control": 0xFFE3, "alt": 0xFFE9, "option": 0xFFE9,
    "shift": 0xFFE1, "super": 0xFFEB, "meta": 0xFFEB, "cmd": 0xFFEB, "win": 0xFFEB,
}

SHIFTED_KEYS = {
    "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7",
    "*": "8", "(": "9", ")": "0", "_": "minus", "+": "equal", "{": "bracketleft",
    "}": "bracketright", "|": "backslash", ":": "semicolon", '"': "apostrophe",
    "<": "comma", ">": "period", "?": "slash", "~": "grave",
}

LATIN_KEYSYMS = {
    "minus": 0x2D, "equal": 0x3D, "bracketleft": 0x5B, "bracketright": 0x5D,
    "backslash": 0x5C, "semicolon": 0x3B, "apostrophe": 0x27, "comma": 0x2C,
    "period": 0x2E, "slash": 0x2F, "grave": 0x60,
}


def key_plan(raw):
    # Returns (held_modifiers, taps) where held_modifiers are keysyms to hold
    # for the whole sequence and taps are (keysym, needs_shift) key presses.
    keys = [part.strip() for part in str(raw or "").split("+")]
    keys = [key for key in keys if key]
    if not keys:
        raise RuntimeError("no keys requested")
    held = []
    taps = []
    for key in keys:
        lower = key.lower()
        if lower in MODIFIER_KEYSYMS:
            held.append((MODIFIER_KEYSYMS[lower], lower))
            continue
        if len(key) == 1:
            if key == " ":
                taps.append((0x20, False))
                continue
            if key in SHIFTED_KEYS:
                base = SHIFTED_KEYS[key]
                taps.append((LATIN_KEYSYMS[base] if base in LATIN_KEYSYMS else ord(base), True))
                continue
            if key.isalpha():
                taps.append((ord(key.lower()), key.isupper()))
                continue
            if key.isdigit():
                taps.append((ord(key), False))
                continue
            taps.append((ord(key), False))
            continue
        if key in KEYSYMS:
            taps.append((KEYSYMS[key], False))
            continue
        if key in LATIN_KEYSYMS:
            taps.append((LATIN_KEYSYMS[key], False))
            continue
        raise RuntimeError("unknown key: " + key)
    if not taps and held:
        # A lone modifier is a tap, not a held key.
        taps = [(sym, False) for sym, _ in held]
        held = []
    return held, taps


def generate_key_plan(registry, raw):
    # pyatspi maps the first argument to Atspi's keyval (int keysym) and the
    # second to keystring (must be a string or None). Putting the keysym in
    # the second slot is a TypeError, which is why the old path never typed.
    held, taps = key_plan(raw)
    held_syms = [sym for sym, _ in held]
    explicit_shift = SHIFT in held_syms
    for sym, _ in held:
        registry.generateKeyboardEvent(sym, None, 0)
    for sym, shift in taps:
        if shift and not explicit_shift:
            registry.generateKeyboardEvent(SHIFT, None, 0)
        registry.generateKeyboardEvent(sym, None, 3)
        if shift and not explicit_shift:
            registry.generateKeyboardEvent(SHIFT, None, 1)
    for sym, _ in reversed(held):
        registry.generateKeyboardEvent(sym, None, 1)
    return [name for _, name in held], len(taps)
`

export const ATSPI_SCRIPT = `import json
import re
import sys
import time

${ATSPI_STATE_PY}

${ATSPI_KEY_PY}

# Keys are underscored because parse_args() and persistent_snapshot() both
# normalize "--max-depth" to "max_depth"; dash-keyed defaults would leave the
# caller's limits as dead keys and silently walk with the hardcoded defaults.
ARG_LIMITS = {"max_apps": 25, "max_depth": 12, "max_nodes": 2000, "text_limit": 500}


def fail(message):
    sys.stdout.write(json.dumps({"ok": False, "error": message}))
    sys.stdout.write("\\n")
    sys.exit(1)


def emit(payload):
    sys.stdout.write(json.dumps(payload))
    sys.stdout.write("\\n")
    # Persistent mode depends on every response reaching the parent
    # immediately; without the flush they sit in python's block buffer.
    sys.stdout.flush()


def parse_args(argv):
    out = dict(ARG_LIMITS)
    i = 0
    while i < len(argv):
        if argv[i].startswith("--") and i + 1 < len(argv):
            key = argv[i][2:].replace("-", "_")
            try:
                out[key] = int(argv[i + 1])
            except ValueError:
                fail("invalid numeric argument: " + argv[i])
            i += 2
        else:
            i += 1
    return out


def opt(name):
    if name in sys.argv:
        return sys.argv[sys.argv.index(name) + 1]
    return None


def safe_str(value, limit):
    if value is None:
        return None
    try:
        text = str(value)
    except Exception:
        return None
    return text if len(text) <= limit else text[:limit]


def sane_bounds(rect):
    # Unmapped or virtualized elements report INT32_MIN / huge sentinels; treat
    # those as no bounds instead of producing unclickable coordinates.
    if rect is None:
        return None
    try:
        x = int(rect.x)
        y = int(rect.y)
        width = int(rect.width)
        height = int(rect.height)
    except Exception:
        return None
    if x <= -2000000000 or y <= -2000000000 or width <= 0 or height <= 0:
        return None
    if abs(x) > 100000 or abs(y) > 100000:
        return None
    return {"x": x, "y": y, "width": width, "height": height}


def component_bounds(accessible):
    try:
        return sane_bounds(accessible.get_extents(0))
    except Exception:
        pass
    try:
        component = accessible.queryComponent()
        return sane_bounds(component.getExtents(0))
    except Exception:
        return None


def node_actions(accessible):
    try:
        count = accessible.get_n_actions()
    except Exception:
        try:
            count = accessible.queryAction().nActions
        except Exception:
            return []
    names = []
    for i in range(count):
        try:
            name = accessible.get_action_name(i)
        except Exception:
            try:
                name = accessible.queryAction().getName(i)
            except Exception:
                continue
        if name and name not in names:
            names.append(name)
    return names


def node_text(accessible, limit):
    try:
        return safe_str(accessible.queryText().getText(0, limit), limit)
    except Exception:
        pass
    try:
        return safe_str(accessible.queryEditableText().getText(0, limit), limit)
    except Exception:
        pass
    try:
        return safe_str(accessible.get_text(0, limit), limit)
    except Exception:
        return None


def node_text_full(accessible, limit):
    # Bound the request at the AT-SPI layer: getText(0, -1) materializes the
    # whole document before any truncation happens.
    if limit <= 0:
        return None
    try:
        return safe_str(accessible.queryText().getText(0, limit), limit)
    except Exception:
        pass
    try:
        return safe_str(accessible.queryEditableText().getText(0, limit), limit)
    except Exception:
        pass
    try:
        return safe_str(accessible.get_text(0, limit), limit)
    except Exception:
        return None


def sane_value(raw):
    # AT-SPI Value on non-value roles (list items, cells) often returns an
    # uninitialized double such as 4.65e-310. Never surface those as text.
    if raw is None:
        return None
    if isinstance(raw, float):
        if raw != raw or raw in (float("inf"), float("-inf")):
            return None
        if raw != 0 and (abs(raw) < 1e-100 or abs(raw) > 1e100):
            return None
    if isinstance(raw, bool):
        return None
    text = safe_str(raw, 500)
    if text is None:
        return None
    try:
        number = float(text)
    except Exception:
        return text
    if number != 0 and (abs(number) < 1e-100 or abs(number) > 1e100):
        return None
    return text


def node_value(accessible, limit):
    try:
        return sane_value(accessible.get_current_value())
    except Exception:
        pass
    try:
        return sane_value(accessible.queryValue().currentValue)
    except Exception:
        return None


def walk(accessible, path, depth, limits, budget):
    if budget["count"] >= limits["max_nodes"] or depth > limits["max_depth"]:
        # A tree cut by the node or depth budget is a truncated tree: say so,
        # or the caller reports a complete observation it never collected.
        budget["truncated"] = True
        return None
    budget["count"] += 1
    try:
        role = str(accessible.get_role_name()).lower().replace(" ", "")
    except Exception:
        try:
            role = str(accessible.getRoleName()).lower().replace(" ", "")
        except Exception:
            role = "unknown"
    node = {
        "path": list(path),
        "role": role or "unknown",
        "name": safe_str(getattr(accessible, "name", None), limits["text_limit"]),
        "description": safe_str(getattr(accessible, "description", None), limits["text_limit"]),
        "text": node_text(accessible, limits["text_limit"]),
        "value": node_value(accessible, limits["text_limit"]),
        "states": node_states(accessible),
        "actions": node_actions(accessible),
        "bounds": component_bounds(accessible),
        "children": [],
    }
    try:
        count = accessible.get_child_count()
    except Exception:
        try:
            count = accessible.childCount
        except Exception:
            return node
    if count > 200:
        budget["truncated"] = True
    for index in range(min(count, 200)):
        try:
            child = accessible.get_child_at_index(index)
        except Exception:
            try:
                child = accessible.getChildAtIndex(index)
            except Exception:
                continue
        if child is None:
            continue
        walked = walk(child, path + [index], depth + 1, limits, budget)
        if walked is not None:
            node["children"].append(walked)
    return node


def snapshot_payload(limits, application=None):
    import pyatspi
    registry = pyatspi.Registry()
    desktop = registry.getDesktop(0)
    budget = {"count": 0, "truncated": False}
    applications = []
    try:
        total = desktop.get_child_count()
    except Exception:
        total = desktop.childCount
    if total > limits["max_apps"]:
        budget["truncated"] = True
    for index in range(min(total, limits["max_apps"])):
        try:
            app = desktop.get_child_at_index(index)
        except Exception:
            app = desktop.getChildAtIndex(index)
        try:
            name = app.name
        except Exception as error:
            applications.append({"name": None, "error": str(error), "nodes": []})
            continue
        if application is not None and (not name or str(application).lower() not in str(name).lower()):
            continue
        try:
            root = walk(app, [index], 0, limits, budget)
        except Exception as error:
            applications.append({"name": name, "error": str(error), "nodes": []})
            continue
        applications.append({"name": name, "error": None, "nodes": [root] if root else []})
    return {"applications": applications, "truncated": budget["truncated"]}


def cmd_snapshot():
    emit({"ok": True, **snapshot_payload(parse_args(sys.argv[2:]))})


def resolve(path):
    import pyatspi
    node = pyatspi.Registry().getDesktop(0)
    for index in path:
        try:
            node = node.get_child_at_index(index)
        except Exception:
            node = node.getChildAtIndex(index)
    return node


def cmd_act():
    path = json.loads(opt("--path") or "[]")
    action = opt("--action") or ""
    target = resolve(path)
    try:
        count = target.get_n_actions()
    except Exception:
        count = target.queryAction().nActions
    for i in range(count):
        try:
            name = target.get_action_name(i)
        except Exception:
            name = target.queryAction().getName(i)
        if name == action:
            try:
                result = target.do_action(i)
            except Exception:
                result = target.queryAction().doAction(i)
            # pyatspi returns None on success; only an explicit False is a failure.
            emit({"ok": True, "result": result is not False})
            return
    fail("action not available: " + action)


def stdin_text():
    try:
        return sys.stdin.read()
    except Exception:
        return ""


def cmd_set_text():
    path = json.loads(opt("--path") or "[]")
    text = stdin_text() if "--stdin" in sys.argv else (opt("--text") or "")
    target = resolve(path)
    try:
        done = target.set_text_contents(0, -1, text)
    except Exception:
        try:
            done = target.set_text_contents(0, 10 ** 9, text)
        except Exception:
            done = target.queryEditableText().setTextContents(0, 10 ** 9, text)
    emit({"ok": True, "result": done is not False})


def cmd_focus():
    path = json.loads(opt("--path") or "[]")
    target = resolve(path)
    try:
        done = target.grab_focus()
    except Exception:
        done = target.queryComponent().grabFocus()
    emit({"ok": True, "result": done is not False})


MAX_TEXT_NODES = 20000
TEXT_DEADLINE_SECONDS = 8


def collect_text(node, out, limit, state, depth=0):
    if (
        depth > 30
        or state["nodes"] >= MAX_TEXT_NODES
        or time.time() > state["deadline"]
        or sum(len(part) for part in out) >= limit
    ):
        state["truncated"] = True
        return
    state["nodes"] += 1
    text = node_text_full(node, max(0, limit - sum(len(part) for part in out)))
    if text:
        out.append(text)
    try:
        count = node.childCount
    except Exception:
        return
    if count > 200:
        state["truncated"] = True
    for index in range(min(count, 200)):
        try:
            child = node.getChildAtIndex(index)
        except Exception:
            continue
        if child is not None:
            collect_text(child, out, limit, state, depth + 1)


def cmd_read_text():
    import hashlib
    limit = max(0, min(int(opt("--limit") or "200000"), 200000))
    path_raw = opt("--path")
    if path_raw:
        target = resolve(json.loads(path_raw))
    else:
        import pyatspi
        target = pyatspi.Registry().getDesktop(0)
        application = opt("--application")
        if application:
            # Prefer an exact application name over a substring match, and
            # otherwise use the first match instead of the last.
            query = application.lower()
            found = None
            for index in range(target.childCount):
                child = target.getChildAtIndex(index)
                try:
                    name = child.name
                except Exception:
                    name = None
                if not name:
                    continue
                if name.lower() == query:
                    found = child
                    break
                if found is None and query in name.lower():
                    found = child
            if found is None:
                fail("application not found: " + application)
            target = found
    parts = []
    state = {"nodes": 0, "deadline": time.time() + TEXT_DEADLINE_SECONDS, "truncated": False}
    collect_text(target, parts, limit, state)
    text = "\\n".join(part for part in parts if part)
    if len(text) > limit:
        text = text[:limit]
        state["truncated"] = True
    digest = hashlib.sha1(text.encode("utf-8", "replace")).hexdigest()
    emit({"ok": True, "text": text, "length": len(text), "hash": digest[:16], "truncated": state["truncated"]})


def cmd_key():
    import pyatspi
    # Modifier press/release ordering and shifted symbols live in the shared
    # AT-SPI_KEY_PY snippet so the persistent helper cannot drift from it.
    generate_key_plan(pyatspi.Registry(), opt("--keys") or "")
    emit({"ok": True})


def cmd_mouse():
    import pyatspi
    x = int(opt("--x") or "0")
    y = int(opt("--y") or "0")
    registry = pyatspi.Registry()
    registry.generateMouseEvent(x, y, "b1p")
    time.sleep(0.05)
    registry.generateMouseEvent(x, y, "b1r")
    emit({"ok": True})


COMMANDS = {
    "snapshot": cmd_snapshot, "act": cmd_act, "set-text": cmd_set_text,
    "focus": cmd_focus, "key": cmd_key, "mouse": cmd_mouse, "read-text": cmd_read_text,
}


def persistent_snapshot(params):
    limits = dict(ARG_LIMITS)
    for key in ("max_apps", "max_depth", "max_nodes", "text_limit"):
        if params.get(key) is not None:
            limits[key] = int(params[key])
    return snapshot_payload(limits, params.get("app"))


def persistent_dispatch(command, params):
    if command == "snapshot":
        return persistent_snapshot(params)
    if command == "key":
        import pyatspi
        generate_key_plan(pyatspi.Registry(), params.get("keys") or "")
        return {"result": True}
    raise RuntimeError("unknown command: " + str(command))


def persistent_main():
    # Long-lived mode: one python/pyatspi process serves every observation and
    # action, so the registry startup cost is paid once instead of per call.
    emit({"ready": True, "ok": True})
    for line in sys.stdin:
        line = line.strip()
        if line == "":
            continue
        request_id = None
        try:
            message = json.loads(line)
            if not isinstance(message, dict):
                raise RuntimeError("invalid request")
            request_id = message.get("id")
            if message.get("command") == "quit":
                emit({"id": request_id, "ok": True})
                return
            payload = persistent_dispatch(message.get("command"), message.get("params") or {})
            payload["id"] = request_id
            payload["ok"] = True
            emit(payload)
        except Exception as error:
            emit({"id": request_id, "ok": False, "error": str(error)})


if len(sys.argv) < 2 or sys.argv[1].startswith("-"):
    persistent_main()
elif sys.argv[1] not in COMMANDS:
    fail("unknown command")
else:
    try:
        COMMANDS[sys.argv[1]]()
    except SystemExit:
        raise
    except Exception as error:
        fail(str(error))
`
