import type { Bounds } from "../../protocol"
import { ATSPI_KEY_PY, ATSPI_STATE_PY } from "../../daemon/atspi-script"

// The Linux CUA helper is a single long-lived python3 process that speaks
// newline-delimited JSON over stdin/stdout. Keeping one process alive avoids
// paying pyatspi registry startup for every snapshot and action, and lets
// element paths stay meaningful across commands. stdout carries protocol
// lines only; stderr is captured by the parent for diagnostics.
//
// The state vocabulary and keyboard synthesis come from daemon/atspi-script.ts
// so this helper and the daemon's one-shot AT-SPI helper cannot drift.
export const LINUX_CUA_SCRIPT = `import hashlib
import json
import re
import sys
import time

LIMITS = {"max_apps": 40, "max_depth": 16, "max_nodes": 4000, "text_limit": 500}

${ATSPI_STATE_PY}

${ATSPI_KEY_PY}

WINDOW_ACTIONS = {
    "activate": ["activate", "focus", "raise"],
    "focus": ["activate", "focus", "raise"],
    "minimize": ["minimize", "iconify"],
    "restore": ["restore", "deiconify", "unminimize", "activate"],
    "close": ["close"],
}

SCROLL_BUTTONS = {"up": 4, "down": 5, "left": 6, "right": 7}

try:
    import pyatspi
except Exception:
    pyatspi = None

ctypes = None
try:
    import ctypes
except Exception:
    ctypes = None

x11 = None
xtst = None
if ctypes is not None:
    try:
        x11 = ctypes.CDLL("libX11.so.6")
        xtst = ctypes.CDLL("libXtst.so.6")
        x11.XOpenDisplay.restype = ctypes.c_void_p
        x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
        x11.XFlush.argtypes = [ctypes.c_void_p]
        x11.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
        x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
        xtst.XTestFakeMotionEvent.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong]
        xtst.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
    except Exception:
        x11 = None
        xtst = None

DISPLAY_HANDLE = None


def emit(payload):
    sys.stdout.write(json.dumps(payload))
    sys.stdout.write("\\n")
    sys.stdout.flush()


def require_pyatspi():
    if pyatspi is None:
        raise RuntimeError("pyatspi is not available")


def open_display():
    global DISPLAY_HANDLE
    if x11 is None or xtst is None:
        raise RuntimeError("X11 input libraries are not available")
    if DISPLAY_HANDLE is None:
        DISPLAY_HANDLE = x11.XOpenDisplay(None)
        if not DISPLAY_HANDLE:
            raise RuntimeError("cannot open the X display")
    return DISPLAY_HANDLE


def safe_str(value, limit):
    if value is None:
        return None
    try:
        text = str(value)
    except Exception:
        return None
    return text if len(text) <= limit else text[:limit]


def raw_role(accessible):
    try:
        return str(accessible.get_role_name()).lower().replace(" ", "")
    except Exception:
        try:
            return str(accessible.getRoleName()).lower().replace(" ", "")
        except Exception:
            return "unknown"


def node_actions(accessible):
    try:
        count = accessible.get_n_actions()
    except Exception:
        try:
            count = accessible.queryAction().nActions
        except Exception:
            return []
    names = []
    for index in range(count):
        try:
            name = accessible.get_action_name(index)
        except Exception:
            try:
                name = accessible.queryAction().getName(index)
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
    # Bound the request at the AT-SPI layer; getText(0, -1) materializes the
    # entire document before any truncation happens.
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
    # AT-SPI Value on non-value roles (list items, table cells) frequently
    # returns an uninitialized double such as 4.65e-310. Never surface those
    # as text; they are not real values.
    if raw is None:
        return None
    if isinstance(raw, bool):
        return None
    if isinstance(raw, float):
        if raw != raw or raw in (float("inf"), float("-inf")):
            return None
        if raw != 0 and (abs(raw) < 1e-100 or abs(raw) > 1e100):
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


def sane_bounds(rect):
    # Unmapped or virtualized elements report INT32_MIN sentinels; treat those
    # as no bounds instead of producing unclickable coordinates.
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
        return sane_bounds(accessible.queryComponent().getExtents(0))
    except Exception:
        return None


def interface_flags(accessible):
    flags = {"component": False, "action": False, "editable": False, "value": False}
    try:
        accessible.queryComponent()
        flags["component"] = True
    except Exception:
        pass
    try:
        accessible.queryAction()
        flags["action"] = True
    except Exception:
        pass
    try:
        accessible.queryEditableText()
        flags["editable"] = True
    except Exception:
        pass
    try:
        accessible.queryValue()
        flags["value"] = True
    except Exception:
        pass
    return flags


def node_attributes(accessible):
    out = {}
    try:
        raw = accessible.get_attributes()
    except Exception:
        raw = None
    items = []
    if isinstance(raw, dict):
        items = list(raw.items())
    elif raw:
        for item in raw:
            try:
                if isinstance(item, dict):
                    items.append((item.get("name"), item.get("value")))
                else:
                    items.append((item.name, item.value))
            except Exception:
                continue
    for key, value in items:
        if key is None:
            continue
        out[str(key)] = "" if value is None else str(value)
        if len(out) >= 30:
            break
    try:
        value_interface = accessible.queryValue()
        out["minimum"] = str(value_interface.minimumValue)
        out["maximum"] = str(value_interface.maximumValue)
        step = getattr(value_interface, "minimumIncrement", None)
        if step is not None:
            out["step"] = str(step)
    except Exception:
        pass
    return out


def child_at(accessible, index):
    try:
        return accessible.get_child_at_index(index)
    except Exception:
        return accessible.getChildAtIndex(index)

def make_node(accessible, path, index, limits):
    return {
        "index": index,
        "path": list(path),
        "role": raw_role(accessible) or "unknown",
        "name": safe_str(getattr(accessible, "name", None), limits["text_limit"]),
        "description": safe_str(getattr(accessible, "description", None), limits["text_limit"]),
        "text": node_text(accessible, limits["text_limit"]),
        "value": node_value(accessible, limits["text_limit"]),
        "states": node_states(accessible),
        "actions": node_actions(accessible),
        "bounds": component_bounds(accessible),
        "attributes": node_attributes(accessible),
        "interfaces": interface_flags(accessible),
        "children": [],
    }


def desktop_extents():
    if pyatspi is None:
        return None
    try:
        desktop = pyatspi.Registry().getDesktop(0)
        rect = desktop.get_extents(0)
        if rect.width > 0 and rect.height > 0:
            # x/y are the virtual-screen origin and can be negative when a
            # monitor is placed left of or above the primary monitor.
            return {"x": int(rect.x), "y": int(rect.y), "width": int(rect.width), "height": int(rect.height)}
    except Exception:
        pass
    return None


def resolve_path(path):
    require_pyatspi()
    if not isinstance(path, list) or len(path) == 0:
        raise RuntimeError("a non-empty child index path is required")
    node = pyatspi.Registry().getDesktop(0)
    for index in path:
        node = child_at(node, int(index))
        if node is None:
            raise RuntimeError("element not found at path " + json.dumps(path))
    return node


def action_names(target):
    return node_actions(target)


def perform_action(target, name):
    names = action_names(target)
    match = None
    for candidate in names:
        if candidate == name:
            match = candidate
            break
    if match is None:
        for candidate in names:
            if candidate.lower() == name.lower():
                match = candidate
                break
    if match is None:
        raise RuntimeError("action not available: " + name)
    index = names.index(match)
    try:
        return target.do_action(index)
    except Exception:
        return target.queryAction().doAction(index)


def perform_first(target, names):
    last_error = None
    for name in names:
        try:
            # pyatspi returns None on success; only an explicit False fails.
            outcome = perform_action(target, name)
            return {"result": outcome is not False, "method": "action:" + name}
        except Exception as error:
            last_error = error
    raise RuntimeError("no supported action: " + str(last_error))


def cmd_snapshot(params):
    require_pyatspi()
    limits = dict(LIMITS)
    for key in ("max_apps", "max_depth", "max_nodes", "text_limit"):
        if params.get(key) is not None:
            limits[key] = int(params.get(key))
    app_filter = params.get("app")
    desktop = pyatspi.Registry().getDesktop(0)
    try:
        total = desktop.get_child_count()
    except Exception:
        total = desktop.childCount
    budget = {"count": 0, "truncated": False}
    applications = []
    # (node dict, accessible, path, depth) flattened across every matching
    # application. Interleaving apps in one queue walks the whole desktop
    # breadth-first, so a single huge tree (a browser or a deep menu) cannot
    # consume the node budget before shallow controls in other applications
    # are collected. Depth-first walking starved exactly those controls.
    pending = []
    for index in range(min(total, limits["max_apps"])):
        app = child_at(desktop, index)
        if app is None:
            continue
        try:
            name = app.name
        except Exception as error:
            applications.append({"name": None, "error": str(error), "nodes": []})
            continue
        if app_filter is not None and (not name or str(app_filter).lower() not in str(name).lower()):
            continue
        try:
            root = make_node(app, [index], index, limits)
        except Exception as error:
            applications.append({"name": name, "error": str(error), "nodes": []})
            continue
        budget["count"] += 1
        applications.append({"name": name, "error": None, "nodes": [root]})
        pending.append((root, app, [index], 0))
    head = 0
    while head < len(pending):
        node, target, node_path, depth = pending[head]
        head += 1
        if budget["count"] >= limits["max_nodes"]:
            budget["truncated"] = True
            break
        try:
            total_children = target.get_child_count()
        except Exception:
            try:
                total_children = target.childCount
            except Exception:
                continue
        if total_children > 200:
            budget["truncated"] = True
        for child_index in range(min(total_children, 200)):
            if budget["count"] >= limits["max_nodes"] or depth + 1 > limits["max_depth"]:
                budget["truncated"] = True
                break
            child = child_at(target, child_index)
            if child is None:
                continue
            budget["count"] += 1
            child_node = make_node(child, node_path + [child_index], child_index, limits)
            node["children"].append(child_node)
            pending.append((child_node, child, node_path + [child_index], depth + 1))
    return {"applications": applications, "screen": desktop_extents(), "truncated": budget["truncated"]}


def cmd_resolve(params):
    target = resolve_path(params.get("path") or [])
    return {
        "role": raw_role(target),
        "name": safe_str(getattr(target, "name", None), LIMITS["text_limit"]),
        "description": safe_str(getattr(target, "description", None), LIMITS["text_limit"]),
        "text": node_text(target, LIMITS["text_limit"]),
        "value": node_value(target, LIMITS["text_limit"]),
        "states": node_states(target),
        "actions": node_actions(target),
        "bounds": component_bounds(target),
        "attributes": node_attributes(target),
        "interfaces": interface_flags(target),
    }


def cmd_act(params):
    target = resolve_path(params.get("path") or [])
    action = str(params.get("action") or "")
    if action == "":
        raise RuntimeError("an action name is required")
    outcome = perform_action(target, action)
    return {"result": outcome is not False, "action": action}


def cmd_set_text(params):
    target = resolve_path(params.get("path") or [])
    text = "" if params.get("text") is None else str(params.get("text"))
    # AT-SPI2 defines SetTextContents(contents) while older pyatspi bindings
    # exposed (start, end, contents) and a legacy set_text_contents helper.
    for call in (
        lambda: target.queryEditableText().setTextContents(text),
        lambda: target.queryEditableText().setTextContents(0, 10 ** 9, text),
        lambda: target.set_text_contents(text),
        lambda: target.set_text_contents(0, 10 ** 9, text),
    ):
        try:
            done = call()
        except Exception:
            continue
        if done is None or done:
            return {"result": True, "interface": "editable"}
        return {"result": False, "interface": "editable"}
    number = None
    try:
        number = float(text)
    except Exception:
        number = None
    if number is None:
        raise RuntimeError("element does not support background set-text")
    try:
        target.set_current_value(number)
        return {"result": True, "interface": "value"}
    except Exception:
        pass
    try:
        target.queryValue().currentValue = number
        return {"result": True, "interface": "value"}
    except Exception:
        raise RuntimeError("element does not support background set-text")


def cmd_focus(params):
    target = resolve_path(params.get("path") or [])
    try:
        done = target.grab_focus()
        return {"result": bool(done), "method": "grab_focus"}
    except Exception:
        done = target.queryComponent().grabFocus()
        return {"result": bool(done), "method": "queryComponent"}


def cmd_scroll_into_view(params):
    target = resolve_path(params.get("path") or [])
    try:
        component = target.queryComponent()
    except Exception as error:
        raise RuntimeError("element has no component interface: " + str(error))
    last_error = None
    for where in (getattr(pyatspi, "SCROLL_ANYWHERE", 6), 0):
        try:
            component.scrollTo(where)
            return {"result": True, "method": "scrollTo"}
        except Exception as error:
            last_error = error
    try:
        rect = component.getExtents(0)
    except Exception as error:
        raise RuntimeError("scroll into view failed: " + str(last_error or error))
    for coord in (0, 1):
        try:
            component.scrollToPoint(rect.x, rect.y, coord)
            return {"result": True, "method": "scrollToPoint"}
        except Exception as error:
            last_error = error
    raise RuntimeError("scroll into view failed: " + str(last_error))


def cmd_select(params):
    target = resolve_path(params.get("path") or [])
    try:
        return perform_first(target, ["select", "select item"])
    except Exception:
        pass
    try:
        index = target.getIndexInParent()
        parent = target.parent
        parent.querySelection().selectChild(index)
        return {"result": True, "method": "selection"}
    except Exception as error:
        raise RuntimeError("select failed: " + str(error))

def cmd_expand(params):
    target = resolve_path(params.get("path") or [])
    if "expanded" in node_states(target):
        return {"result": True, "method": "already"}
    return perform_first(target, ["expand", "expand or contract"])


def cmd_collapse(params):
    target = resolve_path(params.get("path") or [])
    if "collapsed" in node_states(target):
        return {"result": True, "method": "already"}
    return perform_first(target, ["collapse", "expand or contract"])


def cmd_toggle(params):
    target = resolve_path(params.get("path") or [])
    return perform_first(target, ["toggle", "check", "uncheck", "expand or contract"])


def change_value(target, delta, step):
    try:
        value = target.queryValue()
    except Exception:
        value = None
    if value is not None:
        amount = step
        if amount is None:
            amount = getattr(value, "minimumIncrement", None)
        if amount is None or amount <= 0:
            amount = 1
        try:
            next_value = float(value.currentValue) + (amount if delta > 0 else -amount)
            next_value = min(max(next_value, float(value.minimumValue)), float(value.maximumValue))
            try:
                value.currentValue = next_value
                return {"result": True, "method": "value"}
            except Exception:
                pass
            target.set_current_value(next_value)
            return {"result": True, "method": "value"}
        except Exception:
            pass
    names = ["increase", "increment"] if delta > 0 else ["decrease", "decrement"]
    return perform_first(target, names)


def cmd_increment(params):
    target = resolve_path(params.get("path") or [])
    step = params.get("step")
    return change_value(target, 1, None if step is None else abs(float(step)))


def cmd_decrement(params):
    target = resolve_path(params.get("path") or [])
    step = params.get("step")
    return change_value(target, -1, None if step is None else abs(float(step)))


def cmd_show_menu(params):
    target = resolve_path(params.get("path") or [])
    return perform_first(target, ["show menu", "menu", "popup", "pop up", "context menu"])


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
        total = node.childCount
    except Exception:
        return
    if total > 200:
        state["truncated"] = True
    for index in range(min(total, 200)):
        child = child_at(node, index)
        if child is not None:
            collect_text(child, out, limit, state, depth + 1)


def cmd_read_text(params):
    require_pyatspi()
    limit = max(0, min(int(params.get("limit") or 200000), 200000))
    path = params.get("path")
    if path:
        target = resolve_path(path)
    else:
        target = pyatspi.Registry().getDesktop(0)
        application = params.get("application")
        if application:
            # Prefer an exact application name, then the first substring match;
            # selecting the last match is nondeterministic.
            query = str(application).lower()
            found = None
            for index in range(target.childCount):
                child = child_at(target, index)
                try:
                    name = child.name if child is not None else None
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
                raise RuntimeError("application not found: " + str(application))
            target = found
    parts = []
    state = {"nodes": 0, "deadline": time.time() + TEXT_DEADLINE_SECONDS, "truncated": False}
    collect_text(target, parts, limit, state)
    text = "\\n".join(part for part in parts if part)
    if len(text) > limit:
        text = text[:limit]
        state["truncated"] = True
    digest = hashlib.sha1(text.encode("utf-8", "replace")).hexdigest()
    return {"text": text, "length": len(text), "hash": digest[:16], "truncated": state["truncated"]}


def cmd_key(params):
    require_pyatspi()
    # Modifier press/release ordering and shifted symbols come from the shared
    # AT-SPI_KEY_PY snippet so hotkeys work without XTest or ydotool.
    held, _taps = generate_key_plan(pyatspi.Registry(), str(params.get("keys") or ""))
    return {"result": True, "modifiers": held}


def cmd_window(params):
    target = resolve_path(params.get("path") or [])
    action = str(params.get("action") or "activate")
    aliases = WINDOW_ACTIONS.get(action)
    if aliases is None:
        raise RuntimeError("unknown window action: " + action)
    names = [name.lower() for name in action_names(target)]
    for alias in aliases:
        if alias in names:
            return perform_first(target, [alias])
    if action in ("activate", "focus", "restore"):
        try:
            target.grab_focus()
            return {"result": True, "method": "grab_focus"}
        except Exception as error:
            raise RuntimeError("window action not available: " + action + " (" + str(error) + ")")
    raise RuntimeError("window action not available: " + action)


def cmd_click(params):
    display = open_display()
    x = int(params.get("x") or 0)
    y = int(params.get("y") or 0)
    button = int(params.get("button") or 1)
    count = max(1, int(params.get("count") or 1))
    xtst.XTestFakeMotionEvent(display, -1, x, y, 0)
    x11.XFlush(display)
    for _ in range(count):
        xtst.XTestFakeButtonEvent(display, button, 1, 0)
        xtst.XTestFakeButtonEvent(display, button, 0, 60)
    x11.XFlush(display)
    x11.XSync(display, 0)
    return {"result": True, "x": x, "y": y, "button": button, "count": count}


def cmd_scroll(params):
    display = open_display()
    direction = str(params.get("direction") or "down").lower()
    amount = max(1, int(params.get("amount") or 3))
    button = SCROLL_BUTTONS.get(direction)
    if button is None:
        raise RuntimeError("unknown scroll direction: " + direction)
    x = params.get("x")
    y = params.get("y")
    if x is not None and y is not None:
        xtst.XTestFakeMotionEvent(display, -1, int(x), int(y), 0)
        x11.XFlush(display)
    for _ in range(amount):
        xtst.XTestFakeButtonEvent(display, button, 1, 0)
        xtst.XTestFakeButtonEvent(display, button, 0, 30)
    x11.XFlush(display)
    x11.XSync(display, 0)
    return {"result": True, "direction": direction, "amount": amount}


def cmd_drag(params):
    display = open_display()
    x1 = int(params.get("from_x") or 0)
    y1 = int(params.get("from_y") or 0)
    x2 = int(params.get("to_x") or 0)
    y2 = int(params.get("to_y") or 0)
    button = int(params.get("button") or 1)
    duration = int(params.get("duration") or 600)
    xtst.XTestFakeMotionEvent(display, -1, x1, y1, 0)
    x11.XFlush(display)
    x11.XSync(display, 0)
    time.sleep(0.05)
    xtst.XTestFakeButtonEvent(display, button, 1, 0)
    x11.XFlush(display)
    time.sleep(0.05)
    steps = max(4, min(120, int(duration / 10)))
    delay = max(1, int(duration / steps))
    for index in range(1, steps + 1):
        progress = index / steps
        px = int(x1 + (x2 - x1) * progress)
        py = int(y1 + (y2 - y1) * progress)
        xtst.XTestFakeMotionEvent(display, -1, px, py, delay)
    xtst.XTestFakeButtonEvent(display, button, 0, 0)
    x11.XFlush(display)
    x11.XSync(display, 0)
    return {"result": True, "from_x": x1, "from_y": y1, "to_x": x2, "to_y": y2}


COMMANDS = {
    "snapshot": cmd_snapshot,
    "resolve": cmd_resolve,
    "act": cmd_act,
    "set-text": cmd_set_text,
    "focus": cmd_focus,
    "scroll-into-view": cmd_scroll_into_view,
    "select": cmd_select,
    "expand": cmd_expand,
    "collapse": cmd_collapse,
    "toggle": cmd_toggle,
    "increment": cmd_increment,
    "decrement": cmd_decrement,
    "show-menu": cmd_show_menu,
    "read-text": cmd_read_text,
    "key": cmd_key,
    "window": cmd_window,
    "click": cmd_click,
    "scroll": cmd_scroll,
    "drag": cmd_drag,
}


def dispatch(message):
    command = message.get("command")
    handler = COMMANDS.get(command)
    if handler is None:
        raise RuntimeError("unknown command: " + str(command))
    return handler(message.get("params") or {})


def main():
    emit({
        "ready": True,
        "ok": pyatspi is not None,
        "pyatspi": pyatspi is not None,
        "x11": x11 is not None and xtst is not None,
        "error": None if pyatspi is not None else "pyatspi is not available",
    })
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
                emit({"id": request_id, "ok": True, "command": "quit"})
                return
            payload = dispatch(message)
            payload["id"] = request_id
            payload["ok"] = True
            emit(payload)
        except Exception as error:
            emit({"id": request_id, "ok": False, "error": str(error)})


main()
`

export interface AtspiInterfaces {
  component: boolean
  action: boolean
  editable: boolean
  value: boolean
}

export interface AtspiNodeSnapshot {
  index: number
  role: string
  name?: string
  description?: string
  text?: string
  value?: string
  states: string[]
  actions: string[]
  bounds?: Bounds
  attributes: Record<string, string>
  interfaces: AtspiInterfaces
  children: AtspiNodeSnapshot[]
}

export interface AtspiApplicationSnapshot {
  name?: string
  pid?: number
  error?: string
  nodes: AtspiNodeSnapshot[]
}

export interface AtspiSnapshotPayload {
  applications: AtspiApplicationSnapshot[]
  screen?: { x?: number; y?: number; width: number; height: number }
  truncated: boolean
}

export interface ResolvedElementPayload {
  role: string
  name?: string
  description?: string
  text?: string
  value?: string
  states: string[]
  actions: string[]
  bounds?: Bounds
  attributes: Record<string, string>
  interfaces: AtspiInterfaces
}

export interface HelperReady {
  ok: boolean
  pyatspi: boolean
  x11: boolean
  error?: string
}

export interface HelperLine {
  id?: string
  ready?: boolean
  pyatspi?: boolean
  x11?: boolean
  ok: boolean
  error?: string
  payload: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string")
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]): Array<[string, string]> => {
      if (typeof entry === "string") return [[key, entry]]
      if (typeof entry === "number" || typeof entry === "boolean") return [[key, String(entry)]]
      return []
    }),
  )
}

function parseInterfaces(value: unknown): AtspiInterfaces {
  const record = isRecord(value) ? value : {}
  return {
    component: record.component === true,
    action: record.action === true,
    editable: record.editable === true,
    value: record.value === true,
  }
}

export function parseBounds(value: unknown): Bounds | undefined {
  if (!isRecord(value)) return undefined
  const x = finiteNumber(value.x)
  const y = finiteNumber(value.y)
  const width = finiteNumber(value.width)
  const height = finiteNumber(value.height)
  if (x === undefined || y === undefined || width === undefined || height === undefined) return undefined
  return { x, y, width, height }
}

export function parseNode(value: unknown): AtspiNodeSnapshot | undefined {
  if (!isRecord(value)) return undefined
  const bounds = parseBounds(value.bounds)
  return {
    index: Math.trunc(finiteNumber(value.index) ?? 0),
    role: typeof value.role === "string" && value.role.length > 0 ? value.role : "unknown",
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    ...(typeof value.text === "string" ? { text: value.text } : {}),
    ...(typeof value.value === "string" ? { value: value.value } : {}),
    states: stringArray(value.states),
    actions: stringArray(value.actions),
    ...(bounds === undefined ? {} : { bounds }),
    attributes: stringRecord(value.attributes),
    interfaces: parseInterfaces(value.interfaces),
    children: Array.isArray(value.children)
      ? value.children.flatMap((child): AtspiNodeSnapshot[] => {
          const parsed = parseNode(child)
          return parsed === undefined ? [] : [parsed]
        })
      : [],
  }
}

export function parseHelperLine(line: string): HelperLine | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  return {
    ...(typeof parsed.id === "string" ? { id: parsed.id } : {}),
    ...(typeof parsed.ready === "boolean" ? { ready: parsed.ready } : {}),
    ...(typeof parsed.pyatspi === "boolean" ? { pyatspi: parsed.pyatspi } : {}),
    ...(typeof parsed.x11 === "boolean" ? { x11: parsed.x11 } : {}),
    ok: parsed.ok === true,
    ...(typeof parsed.error === "string" ? { error: parsed.error } : {}),
    payload: parsed,
  }
}

export function parseSnapshotPayload(value: unknown): AtspiSnapshotPayload | undefined {
  if (!isRecord(value)) return undefined
  const rawApplications = value.applications
  if (!Array.isArray(rawApplications)) return undefined
  const applications = rawApplications.flatMap((application): AtspiApplicationSnapshot[] => {
    if (!isRecord(application)) return []
    const pid = finiteNumber(application.pid)
    return [
      {
        ...(typeof application.name === "string" ? { name: application.name } : {}),
        ...(pid === undefined ? {} : { pid }),
        ...(typeof application.error === "string" ? { error: application.error } : {}),
        nodes: Array.isArray(application.nodes)
          ? application.nodes.flatMap((node): AtspiNodeSnapshot[] => {
              const parsed = parseNode(node)
              return parsed === undefined ? [] : [parsed]
            })
          : [],
      },
    ]
  })
  const rawScreen = value.screen
  const screenWidth = isRecord(rawScreen) ? finiteNumber(rawScreen.width) : undefined
  const screenHeight = isRecord(rawScreen) ? finiteNumber(rawScreen.height) : undefined
  const screenX = isRecord(rawScreen) ? finiteNumber(rawScreen.x) : undefined
  const screenY = isRecord(rawScreen) ? finiteNumber(rawScreen.y) : undefined
  const screen =
    screenWidth !== undefined && screenHeight !== undefined
      ? {
          width: screenWidth,
          height: screenHeight,
          ...(screenX === undefined ? {} : { x: screenX }),
          ...(screenY === undefined ? {} : { y: screenY }),
        }
      : undefined
  return {
    applications,
    ...(screen === undefined ? {} : { screen }),
    truncated: value.truncated === true,
  }
}

export function parseResolvedPayload(value: unknown): ResolvedElementPayload | undefined {
  if (!isRecord(value) || typeof value.role !== "string" || value.role.length === 0) return undefined
  const bounds = parseBounds(value.bounds)
  return {
    role: value.role,
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    ...(typeof value.text === "string" ? { text: value.text } : {}),
    ...(typeof value.value === "string" ? { value: value.value } : {}),
    states: stringArray(value.states),
    actions: stringArray(value.actions),
    ...(bounds === undefined ? {} : { bounds }),
    attributes: stringRecord(value.attributes),
    interfaces: parseInterfaces(value.interfaces),
  }
}
