export const ATSPI_SCRIPT = `import json
import re
import sys
import time

ARG_LIMITS = {"max-apps": 25, "max-depth": 12, "max-nodes": 2000, "text-limit": 500}

KEYSYMS = {
    "Return": 0xFF0D, "Tab": 0xFF09, "Escape": 0xFF1B, "BackSpace": 0xFF08,
    "Delete": 0xFFFF, "Insert": 0xFF63, "Home": 0xFF50, "End": 0xFF57,
    "Page_Up": 0xFF55, "Page_Down": 0xFF56, "Left": 0xFF51, "Up": 0xFF52,
    "Right": 0xFF53, "Down": 0xFF54, "space": 0x020,
    "F1": 0xFFBE, "F2": 0xFFBF, "F3": 0xFFC0, "F4": 0xFFC1, "F5": 0xFFC2,
    "F6": 0xFFC3, "F7": 0xFFC4, "F8": 0xFFC5, "F9": 0xFFC6, "F10": 0xFFC7,
    "F11": 0xFFC8, "F12": 0xFFC9,
}

STATE_NAMES = {
    "enabled", "focused", "selected", "checked", "expanded", "collapsed",
    "busy", "modal", "pressed", "readonly", "required", "multiselectable",
    "invalid", "active", "armed", "defunct", "editable", "horizontal",
    "opaque", "resizable", "selectable", "sensitive", "showing",
    "singleline", "stale", "transient", "vertical", "visible", "managesdescendants",
}

CANONICAL_STATES = {
    "busy", "checked", "collapsed", "disabled", "editable", "expanded",
    "focused", "hidden", "mixed", "modal", "multiselectable", "offscreen",
    "pressed", "readonly", "required", "selected",
}


def fail(message):
    sys.stdout.write(json.dumps({"ok": False, "error": message}))
    sys.stdout.write("\\n")
    sys.exit(1)


def emit(payload):
    sys.stdout.write(json.dumps(payload))
    sys.stdout.write("\\n")


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


def component_bounds(accessible):
    try:
        rect = accessible.get_extents(0)
        return {"x": int(rect.x), "y": int(rect.y), "width": int(rect.width), "height": int(rect.height)}
    except Exception:
        pass
    try:
        component = accessible.queryComponent()
        rect = component.getExtents(0)
        return {"x": int(rect.x), "y": int(rect.y), "width": int(rect.width), "height": int(rect.height)}
    except Exception:
        return None


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
    return text.replace("-", "_")


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
    # Canonicalize to Omnia's state vocabulary. AT-SPI reports insensitivity
    # instead of a disabled flag, so absence of "sensitive" means disabled.
    canonical = [name for name in names if name in CANONICAL_STATES]
    if names and ("defunct" in names or "disabled" in names or ("sensitive" not in names and "enabled" not in names)):
        if "disabled" not in canonical:
            canonical.append("disabled")
    return canonical


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
    try:
        return safe_str(accessible.queryText().getText(0, -1), limit)
    except Exception:
        pass
    try:
        return safe_str(accessible.queryEditableText().getText(0, -1), limit)
    except Exception:
        pass
    try:
        return safe_str(accessible.get_text(0, -1), limit)
    except Exception:
        return None


def node_value(accessible, limit):
    try:
        return safe_str(accessible.get_current_value(), limit)
    except Exception:
        pass
    try:
        return safe_str(accessible.queryValue().currentValue, limit)
    except Exception:
        return None


def walk(accessible, path, depth, limits, budget):
    if budget["count"] >= limits["max-nodes"] or depth > limits["max-depth"]:
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
        "name": safe_str(getattr(accessible, "name", None), limits["text-limit"]),
        "description": safe_str(getattr(accessible, "description", None), limits["text-limit"]),
        "text": node_text(accessible, limits["text-limit"]),
        "value": node_value(accessible, limits["text-limit"]),
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


def cmd_snapshot():
    import pyatspi
    limits = parse_args(sys.argv[2:])
    registry = pyatspi.Registry()
    desktop = registry.getDesktop(0)
    budget = {"count": 0}
    applications = []
    try:
        total = desktop.get_child_count()
    except Exception:
        total = desktop.childCount
    for index in range(min(total, limits["max-apps"])):
        try:
            app = desktop.get_child_at_index(index)
        except Exception:
            app = desktop.getChildAtIndex(index)
        try:
            name = app.name
        except Exception as error:
            applications.append({"name": None, "error": str(error), "nodes": []})
            continue
        try:
            root = walk(app, [index], 0, limits, budget)
        except Exception as error:
            applications.append({"name": name, "error": str(error), "nodes": []})
            continue
        applications.append({"name": name, "error": None, "nodes": [root] if root else []})
    emit({"ok": True, "applications": applications})


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
            emit({"ok": True, "result": bool(result)})
            return
    fail("action not available: " + action)


def cmd_set_text():
    path = json.loads(opt("--path") or "[]")
    text = opt("--text") or ""
    target = resolve(path)
    try:
        done = target.set_text_contents(0, -1, text)
    except Exception:
        try:
            done = target.set_text_contents(0, 10 ** 9, text)
        except Exception:
            done = target.queryEditableText().setTextContents(0, 10 ** 9, text)
    emit({"ok": True, "result": bool(done)})


def cmd_focus():
    path = json.loads(opt("--path") or "[]")
    target = resolve(path)
    try:
        done = target.grab_focus()
    except Exception:
        done = target.queryComponent().grabFocus()
    emit({"ok": True, "result": bool(done)})


def collect_text(node, out, limit, depth=0):
    if depth > 30 or sum(len(part) for part in out) >= limit:
        return
    text = node_text_full(node, max(0, limit - sum(len(part) for part in out)))
    if text:
        out.append(text)
    try:
        count = node.childCount
    except Exception:
        return
    for index in range(count):
        try:
            child = node.getChildAtIndex(index)
        except Exception:
            continue
        if child is not None:
            collect_text(child, out, limit, depth + 1)


def cmd_read_text():
    import hashlib
    limit = int(opt("--limit") or "200000")
    path_raw = opt("--path")
    if path_raw:
        target = resolve(json.loads(path_raw))
    else:
        target = pyatspi.Registry().getDesktop(0)
        application = opt("--application")
        if application:
            found = None
            for index in range(target.childCount):
                child = target.getChildAtIndex(index)
                try:
                    if child.name and application.lower() in child.name.lower():
                        found = child
                except Exception:
                    pass
            if found is None:
                fail("application not found: " + application)
            target = found
    parts = []
    collect_text(target, parts, limit)
    text = "\\n".join(part for part in parts if part)
    if len(text) > limit:
        text = text[:limit]
    digest = hashlib.sha1(text.encode("utf-8", "replace")).hexdigest()
    emit({"ok": True, "text": text, "length": len(text), "hash": digest[:16]})


def cmd_key():
    import pyatspi
    keys = (opt("--keys") or "").split("+")
    registry = pyatspi.Registry()
    for key in keys:
        if len(key) == 1:
            keysym = ord(key)
        elif key in KEYSYMS:
            keysym = KEYSYMS[key]
        else:
            fail("unknown key: " + key)
        registry.generateKeyboardEvent(0, keysym, 3)
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

if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
    fail("unknown command")
try:
    COMMANDS[sys.argv[1]]()
except SystemExit:
    raise
except Exception as error:
    fail(str(error))
`
