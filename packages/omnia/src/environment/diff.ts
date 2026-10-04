import {
  CAPABILITIES,
  type Bounds,
  type Capability,
  type CapabilityStates,
  type ElementLocator,
  type IndexedElement,
  type ObservationMetadata,
  type SemanticObservation,
  type UntrustedContentEnvelope,
} from "./model"
import { stableJson } from "../retrieval/match"

export type ElementChangeField =
  | "role"
  | "name"
  | "description"
  | "value"
  | "enabled"
  | "focused"
  | "selected"
  | "checked"
  | "bounds"
  | "locator"
  | "capabilities"

export interface ElementChange {
  readonly before: IndexedElement
  readonly after: IndexedElement
  readonly fields: readonly ElementChangeField[]
}

export interface ElementMove {
  readonly element: IndexedElement
  readonly fromIndex: number
  readonly toIndex: number
  readonly fromParentId: string | null
  readonly toParentId: string | null
  readonly fromPath: readonly string[]
  readonly toPath: readonly string[]
}

export interface CapabilityChange {
  readonly capability: Capability
  readonly before: CapabilityStates[Capability]
  readonly after: CapabilityStates[Capability]
}

export interface ContentChange {
  readonly before: UntrustedContentEnvelope
  readonly after: UntrustedContentEnvelope
  readonly fields: readonly ("content" | "mediaType" | "metadata" | "provenance")[]
}

export interface ObservationDiff {
  readonly from?: ObservationMetadata
  readonly to: ObservationMetadata
  readonly targetChanged: boolean
  readonly added: readonly IndexedElement[]
  readonly removed: readonly IndexedElement[]
  readonly changed: readonly ElementChange[]
  readonly moved: readonly ElementMove[]
  readonly capabilities: readonly CapabilityChange[]
  readonly content: {
    readonly added: readonly UntrustedContentEnvelope[]
    readonly removed: readonly UntrustedContentEnvelope[]
    readonly changed: readonly ContentChange[]
  }
  readonly unchanged: number
  readonly hasChanges: boolean
  readonly summary: string
}

export function diffObservations(
  previous: SemanticObservation | undefined,
  current: SemanticObservation,
): ObservationDiff {
  const sameTarget =
    previous !== undefined &&
    previous.metadata.target.id === current.metadata.target.id &&
    previous.metadata.target.kind === current.metadata.target.kind
  const comparable = previous === undefined || sameTarget
  const previousElements = previous?.elements ?? []
  const currentElements = current.elements
  const previousById = new Map(previousElements.map((element) => [element.id, element]))
  const currentById = new Map(currentElements.map((element) => [element.id, element]))
  const added = comparable ? currentElements.filter((element) => !previousById.has(element.id)) : currentElements
  const removed = comparable ? previousElements.filter((element) => !currentById.has(element.id)) : previousElements
  const paired = sameTarget
    ? currentElements.flatMap((element) => {
        const before = previousById.get(element.id)
        return before === undefined ? [] : [{ before, after: element }]
      })
    : []
  const changed = paired.flatMap(({ before, after }) => {
    const fields = changedFields(before, after)
    return fields.length === 0 ? [] : [{ before, after, fields }]
  })
  const commonIds = new Set(paired.map(({ before }) => before.id))
  const moved = paired.flatMap(({ before, after }) => {
    if (
      before.parentId === after.parentId &&
      sameOrder(siblingOrder(previous, before, commonIds), siblingOrder(current, after, commonIds))
    )
      return []
    return [
      {
        element: after,
        fromIndex: before.index,
        toIndex: after.index,
        fromParentId: before.parentId,
        toParentId: after.parentId,
        fromPath: before.path,
        toPath: after.path,
      },
    ]
  })
  const capabilities =
    previous === undefined || !sameTarget ? [] : capabilityChanges(previous.capabilities, current.capabilities)
  const content = diffContent(comparable ? (previous?.content ?? []) : [], comparable ? current.content : [])
  const targetChanged = previous !== undefined && !sameMetadata(previous.metadata.target, current.metadata.target)
  const changedIds = new Set(changed.map((change) => change.after.id))
  const movedIds = new Set(moved.map((move) => move.element.id))
  const unchanged = paired.length - new Set([...changedIds, ...movedIds]).size
  const hasChanges =
    targetChanged ||
    added.length > 0 ||
    removed.length > 0 ||
    changed.length > 0 ||
    moved.length > 0 ||
    capabilities.length > 0 ||
    content.added.length > 0 ||
    content.removed.length > 0 ||
    content.changed.length > 0
  return {
    ...(previous === undefined ? {} : { from: previous.metadata }),
    to: current.metadata,
    targetChanged,
    added,
    removed,
    changed,
    moved,
    capabilities,
    content,
    unchanged,
    hasChanges,
    summary: summarize({ added, removed, changed, moved, capabilities, content, targetChanged }),
  }
}

function changedFields(before: IndexedElement, after: IndexedElement): readonly ElementChangeField[] {
  const fields: ElementChangeField[] = []
  if (before.role !== after.role) fields.push("role")
  if (before.name !== after.name) fields.push("name")
  if (before.description !== after.description) fields.push("description")
  if (before.value !== after.value) fields.push("value")
  if (before.enabled !== after.enabled) fields.push("enabled")
  if (before.focused !== after.focused) fields.push("focused")
  if (before.selected !== after.selected) fields.push("selected")
  if (before.checked !== after.checked) fields.push("checked")
  if (!sameBounds(before.bounds, after.bounds)) fields.push("bounds")
  if (!sameLocator(before.locator, after.locator)) fields.push("locator")
  if (!sameCapabilities(before.capabilities, after.capabilities)) fields.push("capabilities")
  return fields
}

function capabilityChanges(before: CapabilityStates, after: CapabilityStates): readonly CapabilityChange[] {
  return CAPABILITIES.flatMap((capability) =>
    before[capability] === after[capability]
      ? []
      : [{ capability, before: before[capability], after: after[capability] }],
  )
}

function diffContent(before: readonly UntrustedContentEnvelope[], after: readonly UntrustedContentEnvelope[]) {
  const beforeById = uniqueContent(before, "previous")
  const afterById = uniqueContent(after, "current")
  const changed = [...afterById.values()].flatMap((envelope) => {
    const previous = beforeById.get(envelope.id)
    if (previous === undefined) return []
    const fields: ("content" | "mediaType" | "metadata" | "provenance")[] = []
    if (previous.content !== envelope.content) fields.push("content")
    if (previous.mediaType !== envelope.mediaType) fields.push("mediaType")
    // Key-order-insensitive comparison: JSON.stringify treats reordered keys
    // as a change, producing false "metadata changed" diffs.
    if (stableJson(previous.metadata) !== stableJson(envelope.metadata)) fields.push("metadata")
    if (stableJson(previous.provenance) !== stableJson(envelope.provenance)) fields.push("provenance")
    return fields.length === 0 ? [] : [{ before: previous, after: envelope, fields }]
  })
  return {
    added: after.filter((envelope) => !beforeById.has(envelope.id)),
    removed: before.filter((envelope) => !afterById.has(envelope.id)),
    changed,
  }
}

function uniqueContent(input: readonly UntrustedContentEnvelope[], label: string) {
  const output = new Map<string, UntrustedContentEnvelope>()
  input.forEach((envelope) => {
    if (output.has(envelope.id)) throw new TypeError(`Duplicate ${label} content envelope id: ${envelope.id}`)
    output.set(envelope.id, envelope)
  })
  return output
}

function summarize(input: {
  readonly added: readonly unknown[]
  readonly removed: readonly unknown[]
  readonly changed: readonly unknown[]
  readonly moved: readonly unknown[]
  readonly capabilities: readonly CapabilityChange[]
  readonly content: {
    readonly added: readonly unknown[]
    readonly removed: readonly unknown[]
    readonly changed: readonly unknown[]
  }
  readonly targetChanged: boolean
}) {
  const parts = [
    count("+", input.added),
    count("-", input.removed),
    count("~", input.changed),
    count("^", input.moved),
  ].filter((value) => value.length > 0)
  if (input.targetChanged) parts.push("target")
  if (input.capabilities.length > 0) parts.push(`capabilities:${input.capabilities.length}`)
  const content = input.content.added.length + input.content.removed.length + input.content.changed.length
  if (content > 0) parts.push(`content:${content}`)
  return parts.length === 0 ? "unchanged" : parts.join(" ")
}

function count(prefix: string, values: readonly unknown[]) {
  return values.length === 0 ? "" : `${prefix}${values.length}`
}

function siblingOrder(
  observation: SemanticObservation | undefined,
  element: IndexedElement,
  commonIds: ReadonlySet<string>,
) {
  if (!observation) return []
  const siblings = element.parentId === null ? observation.rootIds : (observation.children.get(element.parentId) ?? [])
  return siblings.filter((id) => commonIds.has(id))
}

function sameOrder(before: readonly string[], after: readonly string[]) {
  return before.length === after.length && before.every((id, index) => id === after[index])
}

function sameMetadata(before: ObservationMetadata["target"], after: ObservationMetadata["target"]) {
  return (
    before.id === after.id &&
    before.kind === after.kind &&
    before.title === after.title &&
    before.url === after.url &&
    before.path === after.path
  )
}

function sameBounds(before: Bounds | undefined, after: Bounds | undefined) {
  if (before === undefined || after === undefined) return before === after
  return before.x === after.x && before.y === after.y && before.width === after.width && before.height === after.height
}

function sameLocator(before: ElementLocator | undefined, after: ElementLocator | undefined) {
  if (before === undefined || after === undefined) return before === after
  return stableJson(before) === stableJson(after)
}

function sameCapabilities(before: CapabilityStates, after: CapabilityStates) {
  return CAPABILITIES.every((capability) => before[capability] === after[capability])
}
