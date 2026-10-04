import type { ElementReference, Metadata, Observation, UIElement } from "../protocol"
import type { IndexedRetrievalElement, RetrievalContext, RetrievalHierarchy, RetrievalInput } from "./types"
import { compareText, isRecord, normalizeRole, normalizeText } from "./match"

export function buildRetrievalHierarchy(input: RetrievalInput, context: RetrievalContext = {}): RetrievalHierarchy {
  const source = readInput(input)
  const rawEntries: MutableEntry[] = []
  const warnings: string[] = []
  const seen = new Set<string>()
  source.elements.forEach((element, index) => visit(element, undefined, index, rawEntries, seen, warnings))
  const rawById = new Map(rawEntries.map((entry) => [entry.id, entry]))
  const effectiveParent = new Map<string, string | undefined>()
  rawEntries.forEach((entry) => resolveParent(entry.id, rawById, effectiveParent, new Set(), warnings))
  const children = new Map<string, string[]>(rawEntries.map((entry) => [entry.id, []]))
  const roots: string[] = []
  rawEntries.forEach((entry) => {
    const parentId = effectiveParent.get(entry.id)
    if (parentId === undefined) {
      roots.push(entry.id)
      return
    }
    children.get(parentId)?.push(entry.id)
  })
  const ordered: MutableEntry[] = []
  const emitted = new Set<string>()
  const emit = (id: string, depth: number, path: readonly string[]) => {
    if (emitted.has(id)) return
    const entry = rawById.get(id)
    if (entry === undefined) return
    emitted.add(id)
    const parentId = effectiveParent.get(id)
    const siblings = parentId === undefined ? roots : children.get(parentId) ?? []
    ordered.push({
      ...entry,
      index: ordered.length,
      depth,
      siblingIndex: siblings.indexOf(id),
      parentId,
      path: [...path, id],
    })
    children.get(id)?.forEach((childId) => emit(childId, depth + 1, [...path, id]))
  }
  roots.forEach((id) => emit(id, 0, []))
  rawEntries.forEach((entry) => emit(entry.id, 0, []))
  // Reuse the parent->children index instead of scanning all entries per
  // element (the old toIndexed was O(n^2): 5k elements ~= 25M comparisons).
  const normalized = ordered.map((entry) => toIndexed(entry, children))
  const activeWindowId = resolveActiveWindowId(normalized, children, context, source.observation)
  const activeElementId = resolveActiveElementId(normalized, context, source.observation, activeWindowId)
  return {
    elements: normalized,
    byId: new Map(normalized.map((entry) => [entry.id, entry])),
    children: new Map([...children].map(([id, values]) => [id, values.slice()])),
    roots,
    ...(activeWindowId === undefined ? {} : { activeWindowId }),
    ...(activeElementId === undefined ? {} : { activeElementId }),
    warnings: [...new Set(warnings)].sort(compareText),
  }
}

export const buildHierarchy = buildRetrievalHierarchy
export const indexElements = buildRetrievalHierarchy

export function flattenElements(input: RetrievalInput): readonly UIElement[] {
  return buildRetrievalHierarchy(input).elements.map((entry) =>
    entry.parentId !== undefined && entry.element.parentId === undefined ? { ...entry.element, parentId: entry.parentId } : entry.element,
  )
}

export function elementReference(element: UIElement, observationId?: string): ElementReference | undefined {
  if (element.reference !== undefined) return element.reference
  const id = element.id
  if (id === undefined) return undefined
  return {
    kind: "element",
    elementId: id,
    ...(observationId === undefined ? {} : { observationId }),
    ...(element.source === undefined ? {} : { source: element.source }),
    ...(element.backend === undefined ? {} : { backend: element.backend }),
    ...(element.role === undefined ? {} : { role: element.role }),
  }
}

export function isWithinWindow(entry: IndexedRetrievalElement, activeWindowId: string | undefined): boolean {
  if (activeWindowId === undefined) return false
  return entry.id === activeWindowId || entry.path.includes(activeWindowId)
}

export function hierarchyDistance(entry: IndexedRetrievalElement, targetId: string | undefined): number {
  if (targetId === undefined) return Number.POSITIVE_INFINITY
  const targetIndex = entry.path.lastIndexOf(targetId)
  if (targetIndex < 0) return Number.POSITIVE_INFINITY
  return entry.path.length - targetIndex - 1
}

export function contextTargetId(value: RetrievalContext["activeWindow"] | RetrievalContext["activeElement"]): string | undefined {
  if (typeof value === "string") return value
  return value?.id ?? value?.elementId
}

export function contextScore(
  entry: IndexedRetrievalElement,
  context: RetrievalContext,
  activeWindowId: string | undefined,
  activeElementId: string | undefined,
): number {
  const explicitElement = context.activeElementId ?? context.focusedId ?? contextTargetId(context.activeElement)
  const explicitWindow = context.activeWindowId ?? context.windowId ?? contextTargetId(context.activeWindow)
  const windowId = explicitWindow ?? activeWindowId
  const elementId = explicitElement ?? activeElementId
  if (elementId !== undefined && entry.id === elementId) return 1
  if (windowId !== undefined && isWithinWindow(entry, windowId)) {
    const distance = hierarchyDistance(entry, windowId)
    return Math.max(0.25, 0.7 - Math.min(distance, 8) * 0.05)
  }
  if (elementId !== undefined && entry.path.includes(elementId)) return 0.22
  if (entry.depth === 0) return 0.08
  return 0
}

function visit(
  element: UIElement,
  inferredParent: string | undefined,
  index: number,
  output: MutableEntry[],
  seen: Set<string>,
  warnings: string[],
): void {
  const id = element.id ?? element.reference?.elementId ?? element.reference?.id
  if (id === undefined || id.trim().length === 0) {
    warnings.push(`Element at index ${index} has no id`)
    return
  }
  if (seen.has(id)) {
    warnings.push(`Duplicate element id: ${id}`)
    return
  }
  seen.add(id)
  output.push({
    element,
    id,
    index: output.length,
    sourceIndex: index,
    depth: 0,
    siblingIndex: 0,
    parentId: element.parentId ?? inferredParent,
    path: [id],
  })
  const children = element.children ?? []
  children.forEach((child, childIndex) => visit(child, id, childIndex, output, seen, warnings))
}

function resolveParent(
  id: string,
  rawById: ReadonlyMap<string, MutableEntry>,
  effectiveParent: Map<string, string | undefined>,
  stack: Set<string>,
  warnings: string[],
): void {
  if (effectiveParent.has(id)) return
  const entry = rawById.get(id)
  if (entry === undefined) return
  if (entry.parentId === undefined) {
    effectiveParent.set(id, undefined)
    return
  }
  if (!rawById.has(entry.parentId)) {
    warnings.push(`Element ${entry.id} references missing parent ${entry.parentId}; attached at root`)
    effectiveParent.set(id, undefined)
    return
  }
  if (stack.has(entry.parentId)) {
    warnings.push(`Element hierarchy contains a cycle at ${entry.id}; attached at root`)
    effectiveParent.set(id, undefined)
    return
  }
  stack.add(id)
  resolveParent(entry.parentId, rawById, effectiveParent, stack, warnings)
  stack.delete(id)
  effectiveParent.set(id, entry.parentId)
}

function toIndexed(entry: MutableEntry, childrenById: ReadonlyMap<string, readonly string[]>): IndexedRetrievalElement {
  return {
    element: entry.element,
    id: entry.id,
    index: entry.index,
    depth: entry.depth,
    siblingIndex: entry.siblingIndex,
    path: entry.path,
    ...(entry.parentId === undefined ? {} : { parentId: entry.parentId }),
    children: [...(childrenById.get(entry.id) ?? [])],
  }
}

function readInput(input: RetrievalInput): { readonly elements: readonly UIElement[]; readonly observation?: Observation } {
  if (isElementArray(input)) return { elements: input }
  if ("observation" in input && input.observation !== undefined) {
    return { elements: input.elements ?? input.observation.elements ?? [], observation: input.observation }
  }
  return { elements: input.elements ?? [], observation: input }
}

function isElementArray(value: RetrievalInput): value is readonly UIElement[] {
  return Array.isArray(value)
}

function resolveActiveWindowId(
  entries: readonly IndexedRetrievalElement[],
  children: ReadonlyMap<string, readonly string[]>,
  context: RetrievalContext,
  observation: Observation | undefined,
): string | undefined {
  const explicit = context.activeWindowId ?? context.windowId ?? contextTargetId(context.activeWindow)
  if (explicit !== undefined && entries.some((entry) => entry.id === explicit)) return explicit
  const metadataId = metadataString(observation?.metadata, ["activeWindowId", "windowId", "activeWindow"])
  if (metadataId !== undefined && entries.some((entry) => entry.id === metadataId)) return metadataId
  const observationId = observationField(observation, "activeWindowId") ?? observationField(observation, "windowId")
  if (observationId !== undefined && entries.some((entry) => entry.id === observationId)) return observationId
  const activeElement = context.activeElementId ?? context.focusedId ?? contextTargetId(context.activeElement)
  if (activeElement !== undefined) {
    const activeEntry = entries.find((entry) => entry.id === activeElement)
    const window = activeEntry?.path.slice().reverse().find((id) => isWindowRole(entries.find((entry) => entry.id === id)?.element.role))
    if (window !== undefined) return window
  }
  const elementWindow = entries
    .map((entry) => metadataString(entry.element.metadata, ["activeWindowId", "windowId", "activeWindow"]))
    .find((id): id is string => id !== undefined && entries.some((entry) => entry.id === id))
  if (elementWindow !== undefined) return elementWindow
  const candidates = entries.filter((entry) => isActiveWindow(entry.element, children.get(entry.id) ?? []))
  const focused = candidates.find((entry) => entry.element.states?.includes("focused") === true || entry.element.states?.includes("selected") === true || entry.element.state?.focused === true || entry.element.state?.selected === true)
  return focused?.id ?? candidates[0]?.id
}

function resolveActiveElementId(
  entries: readonly IndexedRetrievalElement[],
  context: RetrievalContext,
  observation: Observation | undefined,
  activeWindowId: string | undefined,
): string | undefined {
  const explicit = context.activeElementId ?? context.focusedId ?? contextTargetId(context.activeElement)
  if (explicit !== undefined && entries.some((entry) => entry.id === explicit)) return explicit
  const metadataId = metadataString(observation?.metadata, ["activeElementId", "focusedId", "activeElement"])
  if (metadataId !== undefined && entries.some((entry) => entry.id === metadataId)) return metadataId
  const observationId = observationField(observation, "activeElementId") ?? observationField(observation, "focusedId")
  if (observationId !== undefined && entries.some((entry) => entry.id === observationId)) return observationId
  const focused = entries.find((entry) => entry.element.states?.includes("focused") === true || entry.element.states?.includes("selected") === true || entry.element.state?.focused === true || entry.element.state?.selected === true)
  if (focused !== undefined && (activeWindowId === undefined || isWithinWindow(focused, activeWindowId))) return focused.id
  // Never promote the first child of the active window: that silently boosts
  // an unrelated element when no element is actually focused.
  return undefined
}

function isWindowRole(role: string | undefined): boolean {
  const normalized = normalizeRole(role)
  return normalized === "window" || normalized === "dialog" || normalized === "alertdialog" || normalized === "application"
}

function isActiveWindow(element: UIElement, childIds: readonly string[]): boolean {
  if (!isWindowRole(element.role)) return false
  if (element.states?.includes("focused") === true || element.states?.includes("selected") === true || element.state?.focused === true || element.state?.selected === true) return true
  if (element.metadata?.active === true || element.metadata?.focused === true || element.metadata?.activeWindow === true) return true
  return childIds.length === 0 && normalizeText(element.name ?? element.text).length > 0
}

function observationField(observation: Observation | undefined, key: string): string | undefined {
  if (observation === undefined || !isRecord(observation)) return undefined
  const value = observation[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function metadataString(metadata: Metadata | undefined, keys: readonly string[]): string | undefined {
  if (metadata === undefined) return undefined
  for (const key of keys) {
    const value = metadata[key]
    if (typeof value === "string" && value.length > 0) return value
    if (isRecord(value)) {
      const nested = value.id ?? value.elementId
      if (typeof nested === "string" && nested.length > 0) return nested
    }
  }
  return undefined
}

interface MutableEntry {
  readonly element: UIElement
  readonly id: string
  readonly index: number
  readonly sourceIndex: number
  readonly depth: number
  readonly siblingIndex: number
  readonly parentId?: string
  readonly path: readonly string[]
}
