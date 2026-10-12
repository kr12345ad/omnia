// The diff projection `computer_snapshot` ships: which controls changed since a
// baseline tree, and whether the change set is worth sending at all.
//
// The tool renders the payload, but the projection cannot live in the tool: the
// dependency runs opencode → omnia, so a tool-side projection could never be
// measured or tested against the observations this package produces. It lives
// here instead, as a pure function over the wire elements, and the tool renders
// what it returns.

/** The change label one element carries in a diff payload. */
export type ComputerElementChange = "added" | "removed" | "moved" | "state-changed"

/**
 * The wire element this projection reads. Providers report different subsets, so
 * every field is optional: the protocol `UIElement` and the extras the tools pass
 * through both satisfy it.
 */
export interface ComputerDiffElement {
  readonly id?: string
  readonly ref?: string
  readonly reference?: { readonly elementId?: string; readonly id?: string }
  readonly role?: string
  readonly name?: string
  readonly accessibleName?: string
  readonly label?: string
  readonly text?: string
  readonly value?: unknown
  readonly description?: string
  readonly states?: readonly string[]
  readonly actions?: readonly string[]
  readonly bounds?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface ComputerElementDiffEntry<T extends ComputerDiffElement = ComputerDiffElement> {
  readonly change: ComputerElementChange
  readonly element: T
}

export interface ComputerElementDiff<T extends ComputerDiffElement = ComputerDiffElement> {
  /** Changed controls: current order first, controls only the baseline held last. */
  readonly controls: readonly ComputerElementDiffEntry<T>[]
  readonly windows: readonly ComputerElementDiffEntry<T>[]
  /** Controls identical to the baseline across the whole tree, not the page. */
  readonly unchangedCount: number
}

/** The two payloads a diff is judged against, measured on what the caller rendered. */
export interface ComputerDiffPayload {
  readonly diffChars: number
  readonly fullChars: number
  readonly cap: number
}

/**
 * Diff one observed tree against the next, splitting controls from windows the
 * way the snapshot payload reports them.
 */
export function diffComputerElements<T extends ComputerDiffElement>(
  baseline: readonly T[],
  current: readonly T[],
): ComputerElementDiff<T> {
  const controls = diffEntries(controlsOf(baseline), controlsOf(current))
  const windows = diffEntries(windowsOf(baseline), windowsOf(current))
  return { controls: controls.changes, windows: windows.changes, unchangedCount: controls.unchangedCount }
}

/**
 * A diff only pays when it is smaller than reading the whole tree, and it never
 * gets to be larger than the payload cap either. Both payloads are measured on
 * what the caller rendered, so the decision stays a pure comparison.
 */
export function computerDiffFallsBack(payload: ComputerDiffPayload): boolean {
  return payload.diffChars > payload.fullChars || payload.diffChars > payload.cap
}

function controlsOf<T extends ComputerDiffElement>(elements: readonly T[]): readonly T[] {
  return elements.filter((element) => element.role !== "window" && element.role !== "application")
}

function windowsOf<T extends ComputerDiffElement>(elements: readonly T[]): readonly T[] {
  return elements.filter((element) => element.role === "window")
}

function diffEntries<T extends ComputerDiffElement>(baseline: readonly T[], current: readonly T[]) {
  const before = indexByKey(baseline)
  const after = indexByKey(current)
  const changes: ComputerElementDiffEntry<T>[] = []
  let unchangedCount = 0
  for (const [key, element] of after) {
    const previous = before.get(key)
    if (previous === undefined) {
      changes.push({ change: "added", element })
      continue
    }
    const change = changeBetween(previous, element)
    if (change === undefined) {
      unchangedCount += 1
      continue
    }
    changes.push({ change, element })
  }
  for (const [key, element] of before) {
    if (after.has(key)) continue
    changes.push({ change: "removed", element })
  }
  return { changes, unchangedCount }
}

/** Diff keys are refs; an element with no ref falls back to its role occurrence. */
function indexByKey<T extends ComputerDiffElement>(elements: readonly T[]): Map<string, T> {
  const indexed = new Map<string, T>()
  const anonymous = new Map<string, number>()
  elements.forEach((element) => {
    const ref = refOf(element)
    if (ref !== undefined) {
      indexed.set(ref, element)
      return
    }
    const role = element.role ?? "element"
    const occurrence = (anonymous.get(role) ?? 0) + 1
    anonymous.set(role, occurrence)
    indexed.set(`${role}#${occurrence}`, element)
  })
  return indexed
}

function refOf(element: ComputerDiffElement): string | undefined {
  return element.id ?? element.ref ?? element.reference?.elementId ?? element.reference?.id
}

function applicationOf(element: ComputerDiffElement): string | undefined {
  const raw = element.metadata?.application
  if (typeof raw === "string" && raw.length > 0) return raw
  if (typeof raw === "object" && raw !== null) {
    const name = (raw as { name?: unknown }).name
    if (typeof name === "string" && name.length > 0) return name
  }
  return undefined
}

function valueOf(element: ComputerDiffElement): string | undefined {
  if (element.value === undefined) return undefined
  return typeof element.value === "string" ? element.value : JSON.stringify(element.value)
}

/** Everything an element carries except its geometry, which drives "moved". */
function signatureOf(element: ComputerDiffElement): string {
  return JSON.stringify([
    element.role ?? null,
    element.name ?? element.accessibleName ?? element.label ?? null,
    element.text ?? null,
    valueOf(element) ?? null,
    element.description ?? null,
    [...(element.states ?? [])].sort(),
    [...(element.actions ?? [])].sort(),
    applicationOf(element) ?? null,
  ])
}

function sameBounds(previous: ComputerDiffElement, next: ComputerDiffElement): boolean {
  if (previous.bounds === undefined || next.bounds === undefined) return previous.bounds === next.bounds
  const a = previous.bounds
  const b = next.bounds
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

function changeBetween(previous: ComputerDiffElement, next: ComputerDiffElement): ComputerElementChange | undefined {
  if (!sameBounds(previous, next)) return "moved"
  if (signatureOf(previous) !== signatureOf(next)) return "state-changed"
  return undefined
}
