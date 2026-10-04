import type { CuaElement, CuaSnapshot, CuaSnapshotOptions } from "../types"

// Every in-tree backend caps a default snapshot at 1000 elements; the engine
// uses this when a backend does not declare its own defaultMaxElements.
export const DEFAULT_SNAPSHOT_MAX_ELEMENTS = 1000

// Roles an agent is most likely to act on. Keeping these ahead of menu chrome
// and passive text is what makes the default observe budget useful: a focused
// app with a huge menu tree can no longer starve the sidebar listitems and
// fields that title-based focus and find need.
const INTERACTIVE_ROLES = new Set([
  "button",
  "cell",
  "checkbox",
  "combobox",
  "link",
  "listitem",
  "menuitemcheckbox",
  "menuitemradio",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
  "treeitem",
])

// Menu chrome is actionable but explodes into hundreds of records, so it is
// only selected after everything interactive and passive.
const NOISY_ROLES = new Set(["generic", "menu", "menubar", "menuitem", "separator"])

function priorityOf(element: CuaElement, focusedWindow: string | undefined): number {
  if (element.focused) return 0
  const inFocusedWindow = focusedWindow !== undefined && element.windowRef === focusedWindow
  if (INTERACTIVE_ROLES.has(element.role)) return inFocusedWindow ? 1 : 2
  if (NOISY_ROLES.has(element.role)) return 5
  return inFocusedWindow ? 3 : 4
}

// Priority-tiered fair selection: focused elements first, then interactive
// controls (focused window before background windows), then passive content,
// and menu noise last. Within a tier elements are filled round-robin across
// windows (focused window first) so one huge window cannot starve every other
// window out of the budget.
// Whether a snapshot produced with `produced` options can satisfy a request
// made with `requested` options. Checked before a walk is awaited or skipped;
// the actual truncated flag is re-checked by snapshotForOptions.
export function snapshotOptionsSupersetOf(
  produced: CuaSnapshotOptions,
  requested: CuaSnapshotOptions,
  defaultMaxElements: number = DEFAULT_SNAPSHOT_MAX_ELEMENTS,
): boolean {
  if ((produced.app ?? undefined) !== (requested.app ?? undefined)) return false
  if (requested.includeScreenshot === true && produced.includeScreenshot !== true) return false
  if (requested.maxElements === undefined) return true
  return (produced.maxElements ?? defaultMaxElements) >= requested.maxElements
}

export function snapshotForOptions(
  snapshot: CuaSnapshot,
  produced: CuaSnapshotOptions,
  requested: CuaSnapshotOptions,
  defaultMaxElements: number = DEFAULT_SNAPSHOT_MAX_ELEMENTS,
  focusedWindowBackendRef?: string,
): CuaSnapshot | undefined {
  if (!snapshotOptionsSupersetOf(produced, requested, defaultMaxElements)) return undefined
  const producedBudget = produced.maxElements ?? defaultMaxElements
  const requestedBudget = requested.maxElements ?? defaultMaxElements
  // A truncated walk can only be reused while it covers the requested budget:
  // re-walking for a bigger budget is the only honest way to fill it. A repeat
  // of the exact budget that produced the snapshot is covered even when the
  // walk truncated below that budget (helper ceiling).
  if (snapshot.truncated && requestedBudget > producedBudget) return undefined
  if (snapshot.truncated && requestedBudget < producedBudget && snapshot.elements.length < requestedBudget) {
    return undefined
  }
  if (requestedBudget >= snapshot.elements.length) return snapshot
  // A re-cap keeps the focused window's controls even when the smaller budget
  // would have dropped them.
  return limitSnapshot(snapshot, requestedBudget, focusedWindowBackendRef, true)
}

// `retainFocusedInteractive` selects every INTERACTIVE_ROLES element of the
// focused window before the budget is applied, so a toolbar control can no
// longer be crowded out by menu or passive noise. The cap is exceeded rather
// than losing an actionable control; `truncated` remains truthful because it
// still reports whether any element was dropped.
export function limitSnapshot(
  snapshot: CuaSnapshot,
  maxElements: number,
  focusedWindowBackendRef?: string,
  retainFocusedInteractive = false,
): CuaSnapshot {
  const limit = Math.max(0, maxElements)
  const focusedWindow =
    (focusedWindowBackendRef === undefined
      ? undefined
      : snapshot.windows.find((window) => window.backendRef === focusedWindowBackendRef)?.ref) ??
    snapshot.elements.find((element) => element.focused)?.windowRef ??
    snapshot.windows.find((window) => window.focused)?.ref
  const windowOrder = snapshot.windows.map((window) => window.ref).filter((ref) => ref !== focusedWindow)
  if (focusedWindow !== undefined) windowOrder.unshift(focusedWindow)

  const byPriority = new Map<number, Map<string, CuaElement[]>>()
  for (const element of snapshot.elements) {
    const priority = priorityOf(element, focusedWindow)
    const byWindow = byPriority.get(priority) ?? new Map<string, CuaElement[]>()
    byPriority.set(priority, byWindow)
    const key = element.windowRef ?? ""
    const list = byWindow.get(key)
    if (list === undefined) byWindow.set(key, [element])
    else list.push(element)
  }

  const selected: CuaElement[] = []
  const selectedRefs = new Set<string>()
  const select = (element: CuaElement): void => {
    if (selectedRefs.has(element.ref)) return
    selectedRefs.add(element.ref)
    selected.push(element)
  }
  if (retainFocusedInteractive && focusedWindow !== undefined) {
    for (const element of snapshot.elements) {
      if (element.windowRef === focusedWindow && INTERACTIVE_ROLES.has(element.role)) select(element)
    }
  }
  for (const priority of [...byPriority.keys()].sort((a, b) => a - b)) {
    const byWindow = byPriority.get(priority)!
    const keys = [...windowOrder, ...[...byWindow.keys()].filter((key) => !windowOrder.includes(key))]
    for (let depth = 0; selected.length < limit; depth += 1) {
      let added = false
      for (const key of keys) {
        const element = byWindow.get(key)?.[depth]
        if (element === undefined) continue
        select(element)
        added = true
        if (selected.length >= limit) break
      }
      if (!added) break
    }
    if (selected.length >= limit) break
  }

  const dropped = snapshot.elements.length > selected.length
  const truncated = snapshot.truncated || dropped
  const warnings = [...snapshot.warnings]
  if (dropped && !warnings.some((warning) => warning.includes("truncated to"))) {
    warnings.push(`The snapshot was truncated to ${selected.length} of ${snapshot.elements.length} elements.`)
  }
  if (snapshot.truncated && !warnings.some((warning) => warning.includes("accessibility tree was truncated"))) {
    warnings.push(
      "The accessibility tree was truncated before the element budget was applied; some elements are missing.",
    )
  }
  // A focused window whose own node is no longer an element (the CuaWindow is
  // the canonical record) still has to report a focused ref, otherwise focus
  // verification would lose the window it just focused.
  const focusedRef =
    selected.find((element) => element.focused)?.ref ?? snapshot.windows.find((window) => window.focused)?.ref
  return {
    id: snapshot.id,
    generation: snapshot.generation,
    takenAt: snapshot.takenAt,
    platform: snapshot.platform,
    windows: snapshot.windows,
    elements: selected,
    ...(focusedRef === undefined ? {} : { focusedRef }),
    ...(snapshot.screen === undefined ? {} : { screen: snapshot.screen }),
    truncated,
    warnings,
    ...(snapshot.accessibility === undefined ? {} : { accessibility: snapshot.accessibility }),
  }
}
