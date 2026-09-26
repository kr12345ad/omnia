import { requiredScopesForAction, type OmniaScope } from "./permissions"

export interface ActionCatalogEntry {
  readonly action: string
  readonly description: string
  readonly parameters: readonly string[]
  readonly requires: readonly OmniaScope[]
}

// The canonical model-facing action surface. Any AI client connected to the
// Omnia Server can discover exactly what the computer interface supports
// through GET /v1/actions instead of assuming a toolkit.
export const OMNIA_ACTION_CATALOG: readonly ActionCatalogEntry[] = [
  { action: "observe", description: "Capture the current semantic state of the computer.", parameters: ["applicationId"], requires: requiredScopesForAction("observe") },
  { action: "read_text", description: "Read the text content of a control or application and return it with length and hash.", parameters: ["target", "query", "application", "limit"], requires: requiredScopesForAction("read_text") },
  { action: "get_context", description: "Report exactly where the agent is: active window, focused element, pointer position, open windows, and browser status.", parameters: [], requires: requiredScopesForAction("get_context") },
  { action: "get_cursor", description: "Report where the real pointer is and whether a button is held.", parameters: [], requires: requiredScopesForAction("get_cursor") },
  { action: "hover", description: "Glide the pointer to a control and hold it there, like resting a hand on the mouse.", parameters: ["target", "query", "amount"], requires: requiredScopesForAction("hover") },
  { action: "mouse_down", description: "Press and hold a mouse button at the current position.", parameters: ["button"], requires: requiredScopesForAction("mouse_down") },
  { action: "mouse_up", description: "Release a held mouse button.", parameters: ["button"], requires: requiredScopesForAction("mouse_up") },
  { action: "middle_click", description: "Middle-click a control.", parameters: ["target", "query"], requires: requiredScopesForAction("middle_click") },
  { action: "get_focus", description: "Report which element currently has keyboard focus.", parameters: [], requires: requiredScopesForAction("get_focus") },
  { action: "inspect", description: "Full detail for one control: role, name, value, states, actions, exact pixel center, ancestors, and children.", parameters: ["target", "query", "role"], requires: requiredScopesForAction("inspect") },
  { action: "find", description: "Locate controls by meaning and return ranked candidates.", parameters: ["query", "role"], requires: requiredScopesForAction("find") },
  { action: "click", description: "Click a control resolved by element id or query.", parameters: ["target", "query", "role"], requires: requiredScopesForAction("click") },
  { action: "double_click", description: "Double-click a control.", parameters: ["target", "query", "role"], requires: requiredScopesForAction("double_click") },
  { action: "right_click", description: "Right-click a control.", parameters: ["target", "query", "role"], requires: requiredScopesForAction("right_click") },
  { action: "type", description: "Type text into a control, or into the focused window when no target is given. start/stop markers bound exactly what is typed and endKey presses a key afterwards.", parameters: ["target", "query", "text", "window", "start", "stop", "endKey"], requires: requiredScopesForAction("type") },
  { action: "set_value", description: "Set the value of a control.", parameters: ["target", "query", "text"], requires: requiredScopesForAction("setvalue") },
  { action: "key", description: "Send one key such as Return, Tab, or Escape.", parameters: ["key", "window"], requires: requiredScopesForAction("key") },
  { action: "hotkey", description: "Send a key combination such as ctrl+shift+s.", parameters: ["keys", "window"], requires: requiredScopesForAction("hotkey") },
  { action: "focus", description: "Move focus to a control.", parameters: ["target", "query", "role"], requires: requiredScopesForAction("focus") },
  { action: "focus_window", description: "Raise and focus a window by title fragment or element id, even when it is not focused.", parameters: ["window", "target"], requires: requiredScopesForAction("focus_window") },
  { action: "scroll", description: "Scroll up, down, left, or right, optionally at a target.", parameters: ["direction", "amount", "target", "query"], requires: requiredScopesForAction("scroll") },
  { action: "move", description: "Move the pointer to a target.", parameters: ["target", "query"], requires: requiredScopesForAction("move") },
  { action: "drag", description: "Drag from one endpoint to another, for example an image resize handle.", parameters: ["from", "to"], requires: requiredScopesForAction("drag") },
  { action: "copy", description: "Copy the current selection or a targeted control.", parameters: ["target", "query"], requires: requiredScopesForAction("copy") },
  { action: "paste", description: "Paste the clipboard or given text into the focused control.", parameters: ["target", "query", "text"], requires: requiredScopesForAction("paste") },
  { action: "launch_app", description: "Start an application with accessibility enabled.", parameters: ["app"], requires: requiredScopesForAction("launch_app") },
  { action: "activate_app", description: "Focus an open application's window.", parameters: ["app"], requires: requiredScopesForAction("activate_app") },
  { action: "close_app", description: "Ask an application's window to close.", parameters: ["app"], requires: requiredScopesForAction("close_app") },
  { action: "open_file", description: "Open a path with the default application.", parameters: ["path"], requires: requiredScopesForAction("open_file") },
  { action: "open_url", description: "Open a URL in the default browser.", parameters: ["url"], requires: requiredScopesForAction("open_url") },
  { action: "screenshot", description: "Capture the screen to a file for visual inspection.", parameters: [], requires: requiredScopesForAction("screenshot") },
  { action: "wait", description: "Wait briefly for an application to settle.", parameters: ["amount"], requires: requiredScopesForAction("wait") },
  { action: "read_clipboard", description: "Read the clipboard text and return it with length and hash.", parameters: [], requires: requiredScopesForAction("read_clipboard") },
  { action: "write_clipboard", description: "Put text on the clipboard so it can be pasted anywhere.", parameters: ["text"], requires: requiredScopesForAction("write_clipboard") },
  { action: "paste_table", description: "Bulk-fill a spreadsheet or form by writing TSV to the clipboard and pasting it, optionally clicking a start cell first.", parameters: ["text", "rows", "target"], requires: requiredScopesForAction("paste_table") },
  { action: "dismiss", description: "Dismiss the current transient surface, for example a toolbar or popup, by pressing Escape.", parameters: [], requires: requiredScopesForAction("dismiss") },
  { action: "release_keys", description: "Release any keys the runtime may still be holding, to recover from interrupted input.", parameters: [], requires: requiredScopesForAction("release_keys") },
  { action: "browser_status", description: "Report whether the controlled browser is running and how many tabs it has.", parameters: [], requires: requiredScopesForAction("browser_status") },
  { action: "browser_open", description: "Open the controlled browser or a new tab at a URL.", parameters: ["url"], requires: requiredScopesForAction("browser_open") },
  { action: "browser_navigate", description: "Navigate the browser to a URL and wait for the page.", parameters: ["url", "tab"], requires: requiredScopesForAction("browser_navigate") },
  { action: "browser_read", description: "Read the current page's title, URL, and text content with length and hash.", parameters: ["tab"], requires: requiredScopesForAction("browser_read") },
  { action: "browser_find", description: "Find page elements by meaning and return stable page element ids.", parameters: ["query", "role", "tab", "limit"], requires: requiredScopesForAction("browser_find") },
  { action: "browser_click", description: "Click a page element with a real pointer action, or click coordinates.", parameters: ["target", "x", "y", "tab"], requires: requiredScopesForAction("browser_click") },
  { action: "browser_type", description: "Type into a page field and verify the value.", parameters: ["target", "text", "tab"], requires: requiredScopesForAction("browser_type") },
  { action: "browser_key", description: "Press a key such as Enter or Tab in the page.", parameters: ["key", "tab"], requires: requiredScopesForAction("browser_key") },
  { action: "browser_tabs", description: "List open browser tabs.", parameters: [], requires: requiredScopesForAction("browser_tabs") },
  { action: "browser_activate_tab", description: "Focus a browser tab.", parameters: ["tab"], requires: requiredScopesForAction("browser_activate_tab") },
  { action: "browser_close_tab", description: "Close a browser tab.", parameters: ["tab"], requires: requiredScopesForAction("browser_close_tab") },
  { action: "browser_back", description: "Go back in the browser history.", parameters: ["tab"], requires: requiredScopesForAction("browser_back") },
  { action: "browser_forward", description: "Go forward in the browser history.", parameters: ["tab"], requires: requiredScopesForAction("browser_forward") },
  { action: "browser_reload", description: "Reload the current page.", parameters: ["tab"], requires: requiredScopesForAction("browser_reload") },
  { action: "menu", description: "Select a menu path by name, for example 'Sheet > Rename Sheet' or 'Insert > Chart'.", parameters: ["query"], requires: requiredScopesForAction("menu") },
  { action: "do", description: "Execute an ordered batch of steps with per-step resolution and verification.", parameters: ["steps"], requires: [] },
]
