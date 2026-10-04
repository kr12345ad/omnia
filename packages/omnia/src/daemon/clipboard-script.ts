export const CLIPBOARD_SCRIPT = `import hashlib
import json
import os
import sys

import gi
gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
gi.require_version("GdkPixbuf", "2.0")
from gi.repository import Gdk, GdkPixbuf, GLib, Gtk


def emit(payload):
    sys.stdout.write(json.dumps(payload))
    sys.stdout.write("\\n")
    sys.stdout.flush()


def fail(message):
    sys.stdout.write(json.dumps({"ok": False, "error": message}))
    sys.stdout.write("\\n")
    sys.stdout.flush()
    sys.exit(1)


def opt(name):
    if name in sys.argv:
        return sys.argv[sys.argv.index(name) + 1]
    return None


def stdin_text():
    try:
        return sys.stdin.read()
    except Exception:
        return ""


def text_arg():
    # Long clipboard content is passed over stdin to stay under the argv limit.
    if "--stdin" in sys.argv:
        return stdin_text()
    return opt("--text") or ""


def clipboard():
    # Gtk.init must run before any clipboard use, otherwise GDK never serves
    # selection requests and reads time out with empty text.
    Gtk.init([])
    return Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)


def digest(text):
    return hashlib.sha1(text.encode("utf-8", "replace")).hexdigest()[:16]


def cmd_get():
    # Gtk.main dispatches the GDK selection events a bare GLib loop misses.
    # A timeout bounds the wait so an unresponsive owner cannot hang the runtime.
    state = {"text": None, "done": False}

    def on_text(_clipboard, text):
        state["text"] = text
        state["done"] = True
        Gtk.main_quit()

    clipboard().request_text(on_text)
    GLib.timeout_add_seconds(3, Gtk.main_quit)
    Gtk.main()
    text = state["text"] or ""
    emit({"ok": True, "text": text, "length": len(text), "hash": digest(text), "complete": state["done"]})


def cmd_set():
    text = text_arg()
    selection = clipboard()
    selection.set_text(text, -1)
    while Gtk.events_pending():
        Gtk.main_iteration()
    try:
        selection.store()
    except Exception:
        pass
    hold = float(opt("--hold") or "0")
    if hold > 0:
        # Serve selection requests so a paste works even when no desktop
        # clipboard manager persists the content.
        GLib.timeout_add_seconds(int(hold), Gtk.main_quit)
        Gtk.main()
    emit({"ok": True, "length": len(text), "hash": digest(text)})


def cmd_set_image():
    path = opt("--path")
    if not path:
        fail("missing --path")
    try:
        pixbuf = GdkPixbuf.Pixbuf.new_from_file(path)
    except Exception as error:
        fail("could not load image: %s" % error)
    selection = clipboard()
    selection.set_image(pixbuf)
    while Gtk.events_pending():
        Gtk.main_iteration()
    try:
        selection.store()
    except Exception:
        pass
    hold = float(opt("--hold") or "0")
    if hold > 0:
        # Serve selection requests so a paste works even when no clipboard
        # manager persists the image.
        GLib.timeout_add_seconds(int(hold), Gtk.main_quit)
        Gtk.main()
    emit({"ok": True, "path": path, "width": pixbuf.get_width(), "height": pixbuf.get_height()})


COMMANDS = {"get": cmd_get, "set": cmd_set, "set_image": cmd_set_image}

if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
    fail("unknown command")
COMMANDS[sys.argv[1]]()
`
