// Native macOS accessibility helper for the Cua engine.
//
// System Events scripting costs one AppleEvent round trip per attribute, which
// makes a desktop walk take minutes. This helper talks to the Accessibility
// API directly and answers JSON on stdout, matching the shapes the darwin
// backend already parses. It is compiled on first use with swiftc.
export const DARWIN_AX_HELPER = `// Native macOS accessibility helper for the Cua engine.
//
// System Events scripting costs one AppleEvent round trip per attribute, which
// makes a desktop walk take minutes. This helper talks to the Accessibility
// API directly and answers JSON on stdout, matching the shapes the darwin
// backend already parses. It is compiled on first use with swiftc.
import AppKit
import ApplicationServices
import Foundation

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

func axChildren(_ element: AXUIElement) -> [AXUIElement] {
    (axAttr(element, kAXChildrenAttribute as String) as? [AXUIElement]) ?? []
}

func axActions(_ element: AXUIElement) -> [String] {
    var names: CFArray?
    let error = AXUIElementCopyActionNames(element, &names)
    guard error == .success, let list = names as? [String] else { return [] }
    return list
}

func axBounds(_ element: AXUIElement) -> [String: Int]? {
    guard let positionRef = axAttr(element, kAXPositionAttribute as String),
          let sizeRef = axAttr(element, kAXSizeAttribute as String)
    else { return nil }
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

let controlRoles: Set<String> = [
    "AXButton", "AXCheckBox", "AXRadioButton", "AXTextField", "AXTextArea", "AXComboBox",
    "AXPopUpButton", "AXMenuButton", "AXMenuItem", "AXMenuBarItem", "AXSlider", "AXTab",
    "AXLink", "AXSearchField", "AXToggle", "AXDisclosureTriangle", "AXIncrementor", "AXRow",
    "AXCell", "AXTreeItem", "AXList", "AXTable", "AXOutline", "AXScrollArea",
]

func axInfo(_ element: AXUIElement) -> [String: Any] {
    let role = axString(axAttr(element, kAXRoleAttribute as String)) ?? ""
    let subrole = axString(axAttr(element, kAXSubroleAttribute as String)) ?? ""
    let name = axString(axAttr(element, kAXTitleAttribute as String)) ?? ""
    let description = axString(axAttr(element, kAXDescriptionAttribute as String)) ?? ""
    let value = axString(axAttr(element, kAXValueAttribute as String))
    let placeholder = axString(axAttr(element, kAXPlaceholderValueAttribute as String))
    let minValue = axNumber(axAttr(element, kAXMinValueAttribute as String))
    let maxValue = axNumber(axAttr(element, kAXMaxValueAttribute as String))
    let stepValue = axNumber(axAttr(element, kAXValueIncrementAttribute as String))
    let enabled = axBool(axAttr(element, kAXEnabledAttribute as String)) ?? true
    let focused = axBool(axAttr(element, kAXFocusedAttribute as String)) ?? false
    let selected = axBool(axAttr(element, kAXSelectedAttribute as String)) ?? false
    let editable = (axBool(axAttr(element, "AXEditable")) ?? false)
        || ["AXTextField", "AXTextArea", "AXSearchField", "AXComboBox"].contains(role)
    var states: [String] = []
    if focused { states.append("focused") }
    if selected { states.append("selected") }
    if !enabled { states.append("disabled") }
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
    if let value { info["value"] = value }
    if let placeholder { info["placeholder"] = placeholder }
    if let minValue { info["minValue"] = minValue }
    if let maxValue { info["maxValue"] = maxValue }
    if let stepValue { info["stepValue"] = stepValue }
    if let bounds = axBounds(element) { info["bounds"] = bounds }
    return info
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
    var node = axInfo(element)
    node["index"] = index
    var childNodes: [[String: Any]] = []
    let children = axChildren(element)
    for (childIndex, child) in children.enumerated() {
        if let childNode = walk(child, index: childIndex, depth: depth + 1, budget: budget) {
            childNodes.append(childNode)
        }
    }
    node["children"] = childNodes
    return node
}

func screenSize() -> [String: Int]? {
    guard let screen = NSScreen.main else { return nil }
    return ["width": Int(screen.frame.width.rounded()), "height": Int(screen.frame.height.rounded())]
}

func applicationList(filter: String?) -> [[String: Any]] {
    var applications: [[String: Any]] = []
    let running = NSWorkspace.shared.runningApplications
    for app in running {
        if app.activationPolicy != .regular && app.activationPolicy != .accessory { continue }
        let name = app.localizedName ?? ""
        if let filter, !filter.isEmpty, !name.lowercased().contains(filter.lowercased()) { continue }
        if app.activationPolicy == .accessory {
            let element = AXUIElementCreateApplication(app.processIdentifier)
            let windows = axAttr(element, kAXWindowsAttribute as String) as? [AXUIElement]
            if (windows ?? []).isEmpty { continue }
        }
        applications.append(["name": name, "pid": Int(app.processIdentifier)])
    }
    return applications
}

func commandSnapshot(_ params: [String: Any]) -> [String: Any] {
    let maxElements = (params["maxElements"] as? NSNumber)?.intValue ?? 400
    let maxDepth = (params["maxDepth"] as? NSNumber)?.intValue ?? 5
    let timeBudgetMs = (params["timeBudgetMs"] as? NSNumber)?.intValue ?? 15000
    let filter = params["app"] as? String
    let budget = Budget(maxElements: maxElements, maxDepth: maxDepth, timeBudgetMs: timeBudgetMs)
    var applications: [[String: Any]] = []
    for entry in applicationList(filter: filter) {
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
    var result: [String: Any] = ["applications": applications, "truncated": budget.truncated]
    if let screen = screenSize() { result["screen"] = screen }
    return result
}

func elementAt(pid: Int, path: [Int]) -> AXUIElement? {
    let app = AXUIElementCreateApplication(pid_t(pid))
    let windows = (axAttr(app, kAXWindowsAttribute as String) as? [AXUIElement]) ?? []
    guard let first = path.first, first < windows.count else { return nil }
    var element = windows[first]
    for index in path.dropFirst() {
        let children = axChildren(element)
        guard index < children.count else { return nil }
        element = children[index]
    }
    return element
}

func commandResolve(_ params: [String: Any]) -> [String: Any] {
    guard let pid = (params["pid"] as? NSNumber)?.intValue,
          let path = params["path"] as? [Int],
          let element = elementAt(pid: pid, path: path)
    else { return ["ok": false, "error": "target_unreachable"] }
    var info = axInfo(element)
    info["ok"] = true
    return info
}

func commandAct(_ params: [String: Any]) -> [String: Any] {
    guard let pid = (params["pid"] as? NSNumber)?.intValue,
          let path = params["path"] as? [Int],
          let action = params["action"] as? String,
          let element = elementAt(pid: pid, path: path)
    else { return ["ok": false, "error": "target_unreachable"] }
    let error = AXUIElementPerformAction(element, action as CFString)
    return error == .success ? ["ok": true, "method": "perform"] : ["ok": false, "error": "the element does not expose \\(action)"]
}

func commandSetValue(_ params: [String: Any]) -> [String: Any] {
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
    case "resolve": result = commandResolve(params)
    case "act": result = commandAct(params)
    case "setvalue": result = commandSetValue(params)
    case "focus": result = commandFocus(params)
    case "apps": result = ["applications": applicationList(filter: params["app"] as? String)]
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
