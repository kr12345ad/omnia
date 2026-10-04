// Native macOS accessibility helper for the Cua engine.
//
// System Events scripting costs one AppleEvent round trip per attribute, which
// makes a desktop walk take minutes. This helper talks to the Accessibility
// API directly, batches each element's attribute fetch into one call, answers
// JSON on stdout, and reports a missing Accessibility grant explicitly instead
// of walking a permission-starved tree that silently comes back empty.
export const DARWIN_AX_HELPER = `import AppKit
import ApplicationServices
import Foundation

let permissionMessage = "macOS Accessibility permission is not granted for this app; enable it in System Settings > Privacy & Security > Accessibility and relaunch Omnia."

func permissionFailure() -> [String: Any] {
    return [
        "ok": false,
        "error": "permission",
        "code": "kAXErrorAPIDisabled",
        "message": permissionMessage,
    ]
}

func axTrusted() -> Bool {
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: false] as CFDictionary
    return AXIsProcessTrustedWithOptions(options)
}

func axAttr(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    let error = AXUIElementCopyAttributeValue(element, name as CFString, &value)
    return error == .success ? value : nil
}

func axString(_ value: CFTypeRef?) -> String? {
    guard let value else { return nil }
    if let text = value as? String { return text }
    if let number = value as? NSNumber { return number.stringValue }
    return nil
}

func axNumber(_ value: CFTypeRef?) -> Double? {
    guard let value else { return nil }
    if let number = value as? NSNumber { return number.doubleValue }
    if let text = value as? String { return Double(text) }
    return nil
}

func axBool(_ value: CFTypeRef?) -> Bool? {
    guard let value else { return nil }
    if let number = value as? NSNumber { return number.boolValue }
    return nil
}

func axActions(_ element: AXUIElement) -> [String] {
    var names: CFArray?
    let error = AXUIElementCopyActionNames(element, &names)
    guard error == .success, let list = names as? [String] else { return [] }
    return list
}

let infoAttributes: [String] = [
    kAXRoleAttribute as String,
    kAXSubroleAttribute as String,
    kAXTitleAttribute as String,
    kAXDescriptionAttribute as String,
    kAXValueAttribute as String,
    kAXPlaceholderValueAttribute as String,
    kAXMinValueAttribute as String,
    kAXMaxValueAttribute as String,
    kAXValueIncrementAttribute as String,
    kAXEnabledAttribute as String,
    kAXFocusedAttribute as String,
    kAXSelectedAttribute as String,
    "AXEditable",
    kAXHiddenAttribute as String,
    kAXPositionAttribute as String,
    kAXSizeAttribute as String,
    kAXMinimizedAttribute as String,
    kAXChildrenAttribute as String,
]

let ROLE = 0
let SUBROLE = 1
let NAME = 2
let DESCRIPTION = 3
let VALUE = 4
let PLACEHOLDER = 5
let MIN_VALUE = 6
let MAX_VALUE = 7
let STEP_VALUE = 8
let ENABLED = 9
let FOCUSED = 10
let SELECTED = 11
let EDITABLE = 12
let HIDDEN = 13
let POSITION = 14
let SIZE = 15
let MINIMIZED = 16
let CHILDREN = 17

// One accessibility round trip per element instead of one per attribute;
// attributes the element does not support come back as NSNull and stay nil.
// If the batched call fails outright, fall back to single-attribute reads so a
// failed batch never silently drops children or state.
func axBatch(_ element: AXUIElement, _ attributes: [String]) -> [CFTypeRef?] {
    var raw: CFArray?
    let options = AXCopyMultipleAttributeOptions(rawValue: 0)
    let error = AXUIElementCopyMultipleAttributeValues(element, attributes as CFArray, options, &raw)
    guard error == .success, let values = raw as? [Any], values.count == attributes.count else {
        return attributes.map { axAttr(element, $0) }
    }
    return values.map { (item: Any) -> CFTypeRef? in
        if item is NSNull { return nil }
        return item as AnyObject
    }
}

func axBounds(_ positionRef: CFTypeRef?, _ sizeRef: CFTypeRef?) -> [String: Int]? {
    guard let positionRef, let sizeRef else { return nil }
    var position = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetValue(unsafeBitCast(positionRef, to: AXValue.self), .cgPoint, &position),
          AXValueGetValue(unsafeBitCast(sizeRef, to: AXValue.self), .cgSize, &size)
    else { return nil }
    return [
        "x": Int(position.x.rounded()),
        "y": Int(position.y.rounded()),
        "width": Int(size.width.rounded()),
        "height": Int(size.height.rounded()),
    ]
}

func axInfo(_ element: AXUIElement, _ values: [CFTypeRef?]) -> [String: Any] {
    let role = axString(values[ROLE]) ?? ""
    let subrole = axString(values[SUBROLE]) ?? ""
    let name = axString(values[NAME]) ?? ""
    let description = axString(values[DESCRIPTION]) ?? ""
    let value = axString(values[VALUE])
    let placeholder = axString(values[PLACEHOLDER])
    let minValue = axNumber(values[MIN_VALUE])
    let maxValue = axNumber(values[MAX_VALUE])
    let stepValue = axNumber(values[STEP_VALUE])
    let enabled = axBool(values[ENABLED]) ?? true
    let focused = axBool(values[FOCUSED]) ?? false
    let selected = axBool(values[SELECTED]) ?? false
    let editable = (axBool(values[EDITABLE]) ?? false)
        || ["AXTextField", "AXTextArea", "AXSearchField", "AXComboBox"].contains(role)
    let hidden = axBool(values[HIDDEN]) ?? false
    let minimized = axBool(values[MINIMIZED]) ?? false
    var states: [String] = []
    if focused { states.append("focused") }
    if selected { states.append("selected") }
    if !enabled { states.append("disabled") }
    if minimized { states.append("minimized") }
    var info: [String: Any] = [
        "role": role,
        "subrole": subrole,
        "name": name,
        "description": description,
        "editable": editable,
        "valuePresent": value != nil || minValue != nil || maxValue != nil,
        "states": states,
        "actions": axActions(element),
    ]
    if hidden { info["hidden"] = true }
    if let value { info["value"] = value }
    if let placeholder { info["placeholder"] = placeholder }
    if let minValue { info["minValue"] = minValue }
    if let maxValue { info["maxValue"] = maxValue }
    if let stepValue { info["stepValue"] = stepValue }
    if let bounds = axBounds(values[POSITION], values[SIZE]) { info["bounds"] = bounds }
    return info
}

func axChildren(_ values: [CFTypeRef?]) -> [AXUIElement] {
    return (values[CHILDREN] as? [AXUIElement]) ?? []
}

func screenRect(_ bounds: [String: Int]) -> CGRect? {
    guard let x = bounds["x"], let y = bounds["y"],
          let width = bounds["width"], let height = bounds["height"]
    else { return nil }
    guard let primary = NSScreen.screens.first else { return nil }
    // AX coordinates are top-left based; NSScreen frames are bottom-left based.
    return CGRect(
        x: CGFloat(x),
        y: primary.frame.height - CGFloat(y + height),
        width: CGFloat(width),
        height: CGFloat(height)
    )
}

func offscreen(_ bounds: [String: Int]?) -> Bool {
    guard let bounds, let rect = screenRect(bounds) else { return false }
    if rect.width <= 1 || rect.height <= 1 { return true }
    return !NSScreen.screens.contains { $0.frame.intersects(rect) }
}

// Leaf controls that are hidden or outside every screen can never be acted on
// by pointer input; skipping them early keeps walks cheap without dropping
// window or menu containers whose geometry is intentionally transient.
func unavailableLeaf(_ info: [String: Any], children: [AXUIElement]) -> Bool {
    if !children.isEmpty { return false }
    let role = info["role"] as? String ?? ""
    let exempt = [
        "AXWindow", "AXSheet", "AXMenu", "AXMenuBar", "AXMenuBarItem", "AXPopUpButton",
        "AXComboBox", "AXHelp", "AXScrollArea",
    ]
    if exempt.contains(role) { return false }
    return offscreen(info["bounds"] as? [String: Int])
}

final class Budget {
    var count = 0
    let maxElements: Int
    let maxDepth: Int
    let deadline: Date
    var truncated = false

    init(maxElements: Int, maxDepth: Int, timeBudgetMs: Int) {
        self.maxElements = maxElements
        self.maxDepth = maxDepth
        self.deadline = Date().addingTimeInterval(Double(timeBudgetMs) / 1000)
    }

    var expired: Bool { Date() > deadline }
}

func walk(_ element: AXUIElement, index: Int, depth: Int, budget: Budget) -> [String: Any]? {
    if budget.count >= budget.maxElements || depth > budget.maxDepth || budget.expired {
        budget.truncated = true
        return nil
    }
    budget.count += 1
    let values = axBatch(element, infoAttributes)
    var node = axInfo(element, values)
    if node["hidden"] as? Bool == true { return nil }
    let rawChildren = axChildren(values)
    if unavailableLeaf(node, children: rawChildren) { return nil }
    var childNodes: [[String: Any]] = []
    for (childIndex, child) in rawChildren.enumerated() {
        if let childNode = walk(child, index: childIndex, depth: depth + 1, budget: budget) {
            childNodes.append(childNode)
        }
    }
    node["index"] = index
    node["children"] = childNodes
    return node
}

func screenSize() -> [String: Int]? {
    guard let screen = NSScreen.main else { return nil }
    return ["width": Int(screen.frame.width.rounded()), "height": Int(screen.frame.height.rounded())]
}

func requestedFilter(_ params: [String: Any]) -> String? {
    guard let filter = params["app"] as? String, !filter.isEmpty else { return nil }
    return filter
}

// Default observation walks only the frontmost application. Enumerating every
// running app costs an AX round trip per app and routinely exceeds the budget
// before the app the user is actually looking at is reached; other apps are
// still available through an explicit app filter.
func applicationEntries(filter: String?) -> [[String: Any]] {
    let running = NSWorkspace.shared.runningApplications
    if let filter {
        var applications: [[String: Any]] = []
        for app in running {
            if app.activationPolicy != .regular && app.activationPolicy != .accessory { continue }
            let name = app.localizedName ?? ""
            if !name.lowercased().contains(filter.lowercased()) { continue }
            if app.activationPolicy == .accessory {
                let element = AXUIElementCreateApplication(app.processIdentifier)
                let windows = (axAttr(element, kAXWindowsAttribute as String) as? [AXUIElement]) ?? []
                if windows.isEmpty { continue }
            }
            applications.append(["name": name, "pid": Int(app.processIdentifier)])
        }
        return applications
    }
    guard let app = NSWorkspace.shared.frontmostApplication else { return [] }
    return [["name": app.localizedName ?? "", "pid": Int(app.processIdentifier)]]
}

func commandSnapshot(_ params: [String: Any]) -> [String: Any] {
    guard axTrusted() else { return permissionFailure() }
    let maxElements = (params["maxElements"] as? NSNumber)?.intValue ?? 400
    let maxDepth = (params["maxDepth"] as? NSNumber)?.intValue ?? 5
    let timeBudgetMs = (params["timeBudgetMs"] as? NSNumber)?.intValue ?? 15000
    let budget = Budget(maxElements: maxElements, maxDepth: maxDepth, timeBudgetMs: timeBudgetMs)
    var applications: [[String: Any]] = []
    for entry in applicationEntries(filter: requestedFilter(params)) {
        if budget.count >= budget.maxElements || budget.expired {
            budget.truncated = true
            break
        }
        guard let pid = entry["pid"] as? Int else { continue }
        let element = AXUIElementCreateApplication(pid_t(pid))
        let windows = (axAttr(element, kAXWindowsAttribute as String) as? [AXUIElement]) ?? []
        var nodes: [[String: Any]] = []
        for (windowIndex, window) in windows.enumerated() {
            if let node = walk(window, index: windowIndex, depth: 0, budget: budget) {
                nodes.append(node)
            }
        }
        applications.append(["name": entry["name"] ?? "", "pid": pid, "nodes": nodes])
    }
    var result: [String: Any] = ["ok": true, "applications": applications, "truncated": budget.truncated]
    if let screen = screenSize() { result["screen"] = screen }
    return result
}

// Cheap window-generation check for the backend's tree cache: window count,
// titles, minimize and focus flags change for every event the cache must
// invalidate on. It touches only top-level windows, so it stays fast even on
// apps with thousands of elements.
func commandGeneration(_ params: [String: Any]) -> [String: Any] {
    guard axTrusted() else { return permissionFailure() }
    var applications: [[String: Any]] = []
    var parts: [String] = []
    for entry in applicationEntries(filter: requestedFilter(params)) {
        guard let pid = entry["pid"] as? Int else { continue }
        let app = AXUIElementCreateApplication(pid_t(pid))
        let windows = (axAttr(app, kAXWindowsAttribute as String) as? [AXUIElement]) ?? []
        var windowParts: [String] = []
        for window in windows {
            let values = axBatch(window, [kAXTitleAttribute as String, kAXMinimizedAttribute as String, kAXFocusedAttribute as String])
            let title = axString(values[0]) ?? ""
            let minimized = axBool(values[1]) ?? false
            let focused = axBool(values[2]) ?? false
            windowParts.append(title + "|" + String(minimized) + "|" + String(focused))
        }
        applications.append(["name": entry["name"] ?? "", "pid": pid, "windows": windows.count])
        parts.append(String(pid) + ":" + windowParts.joined(separator: ","))
    }
    return ["ok": true, "applications": applications, "signature": parts.joined(separator: ";")]
}

func elementAt(pid: Int, path: [Int]) -> AXUIElement? {
    let app = AXUIElementCreateApplication(pid_t(pid))
    let windows = (axAttr(app, kAXWindowsAttribute as String) as? [AXUIElement]) ?? []
    guard let first = path.first, first < windows.count else { return nil }
    var element = windows[first]
    for index in path.dropFirst() {
        let values = axBatch(element, [kAXChildrenAttribute as String])
        let children = axChildren(values)
        guard index < children.count else { return nil }
        element = children[index]
    }
    return element
}

func commandResolve(_ params: [String: Any]) -> [String: Any] {
    guard axTrusted() else { return permissionFailure() }
    guard let pid = (params["pid"] as? NSNumber)?.intValue,
          let path = params["path"] as? [Int],
          let element = elementAt(pid: pid, path: path)
    else { return ["ok": false, "error": "target_unreachable"] }
    var info = axInfo(element, axBatch(element, infoAttributes))
    info["ok"] = true
    return info
}

// Targeted subtree walk for one window. Callers that already hold a cached
// tree patch this node back in instead of re-walking every open window.
func commandWindow(_ params: [String: Any]) -> [String: Any] {
    guard axTrusted() else { return permissionFailure() }
    guard let pid = (params["pid"] as? NSNumber)?.intValue,
          let index = (params["index"] as? NSNumber)?.intValue
    else { return ["ok": false, "error": "target_unreachable"] }
    let app = AXUIElementCreateApplication(pid_t(pid))
    let windows = (axAttr(app, kAXWindowsAttribute as String) as? [AXUIElement]) ?? []
    guard index >= 0, index < windows.count else { return ["ok": false, "error": "target_unreachable"] }
    let maxElements = (params["maxElements"] as? NSNumber)?.intValue ?? 1000
    let maxDepth = (params["maxDepth"] as? NSNumber)?.intValue ?? 12
    let timeBudgetMs = (params["timeBudgetMs"] as? NSNumber)?.intValue ?? 5000
    let budget = Budget(maxElements: maxElements, maxDepth: maxDepth, timeBudgetMs: timeBudgetMs)
    guard let node = walk(windows[index], index: index, depth: 0, budget: budget) else {
        return ["ok": false, "error": "target_unreachable"]
    }
    // A budget-limited subtree is partial; the caller must be able to tell so a
    // partial node never gets patched into a cached tree as a complete one.
    return ["ok": true, "node": node, "truncated": budget.truncated]
}

func commandAct(_ params: [String: Any]) -> [String: Any] {
    guard axTrusted() else { return permissionFailure() }
    guard let pid = (params["pid"] as? NSNumber)?.intValue,
          let path = params["path"] as? [Int],
          let action = params["action"] as? String,
          let element = elementAt(pid: pid, path: path)
    else { return ["ok": false, "error": "target_unreachable"] }
    let error = AXUIElementPerformAction(element, action as CFString)
    return error == .success ? ["ok": true, "method": "perform"] : ["ok": false, "error": "the element does not expose " + action]
}

func commandSetValue(_ params: [String: Any]) -> [String: Any] {
    guard axTrusted() else { return permissionFailure() }
    guard let pid = (params["pid"] as? NSNumber)?.intValue,
          let path = params["path"] as? [Int],
          let value = params["value"] as? String,
          let element = elementAt(pid: pid, path: path)
    else { return ["ok": false, "error": "target_unreachable"] }
    var error = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, value as CFString)
    if error != .success {
        let range = axNumber(axAttr(element, kAXMinValueAttribute as String))
        let maximum = axNumber(axAttr(element, kAXMaxValueAttribute as String))
        if range != nil || maximum != nil, let number = Double(value) {
            error = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, NSNumber(value: number))
        }
    }
    return error == .success ? ["ok": true, "value": value] : ["ok": false, "error": "the element rejected the value"]
}

func commandFocus(_ params: [String: Any]) -> [String: Any] {
    guard axTrusted() else { return permissionFailure() }
    guard let pid = (params["pid"] as? NSNumber)?.intValue,
          let path = params["path"] as? [Int],
          let element = elementAt(pid: pid, path: path)
    else { return ["ok": false, "error": "target_unreachable"] }
    let error = AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    return error == .success ? ["ok": true] : ["ok": false, "error": "the element cannot take focus"]
}

func main() {
    let arguments = CommandLine.arguments
    guard arguments.count >= 3 else {
        print("{\\"ok\\":false,\\"error\\":\\"usage: ax-helper <command> <json>\\"}")
        return
    }
    guard let data = arguments[2].data(using: .utf8),
          let params = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    else {
        print("{\\"ok\\":false,\\"error\\":\\"invalid parameters\\"}")
        return
    }
    let result: [String: Any]
    switch arguments[1] {
    case "snapshot": result = commandSnapshot(params)
    case "generation": result = commandGeneration(params)
    case "window": result = commandWindow(params)
    case "resolve": result = commandResolve(params)
    case "act": result = commandAct(params)
    case "setvalue": result = commandSetValue(params)
    case "focus": result = commandFocus(params)
    case "apps": result = axTrusted() ? ["ok": true, "applications": applicationEntries(filter: requestedFilter(params))] : permissionFailure()
    default: result = ["ok": false, "error": "unknown command"]
    }
    guard let output = try? JSONSerialization.data(withJSONObject: result),
          let text = String(data: output, encoding: .utf8)
    else {
        print("{\\"ok\\":false,\\"error\\":\\"could not encode result\\"}")
        return
    }
    print(text)
}

main()
`
