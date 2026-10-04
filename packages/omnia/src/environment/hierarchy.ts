import type { Observation as ProtocolObservation, UIElement as ProtocolUIElement } from "../protocol"
import { isUntrustedContentEnvelope } from "./envelope"
import {
  type CanonicalObservation,
  type Capability,
  type CapabilityState,
  type IndexedElement,
  type NormalizedElement,
  type ObservationInput,
  type ObservationMetadata,
  type RawElement,
  type SemanticObservation,
  type TargetDescriptor,
  type UntrustedContentEnvelope,
} from "./model"
import { normalizeCapabilityStates, normalizeElement, normalizeTarget, toProtocolElement } from "./normalize"

export interface ProtocolObservationInput {
  readonly observation: ProtocolObservation
  readonly target: TargetDescriptor
  readonly id?: string
  readonly capturedAt?: string
  readonly revision?: string
  readonly content?: readonly UntrustedContentEnvelope[]
}

export interface ElementHierarchy {
  readonly elements: readonly IndexedElement[]
  readonly byId: ReadonlyMap<string, IndexedElement>
  readonly children: ReadonlyMap<string, readonly string[]>
  readonly rootIds: readonly string[]
  readonly warnings: readonly string[]
}

interface MutableFrame {
  readonly element: NormalizedElement
  parentId: string | null
  readonly children: MutableFrame[]
}

export function normalizeElements(input: ObservationInput["elements"]): readonly NormalizedElement[] {
  return input.map((element, index) => normalizeElement(element, index))
}

export function buildHierarchy(input: ObservationInput["elements"] | readonly NormalizedElement[]): ElementHierarchy {
  const normalized = input.map((element, index) =>
    isNormalizedElement(element) ? element : normalizeElement(element, index),
  )
  const warnings: string[] = []
  const seen = new Set<string>()
  // Duplicate ids are deduplicated with a warning instead of failing the whole
  // observation: one repeated node must not make the environment unreadable.
  const unique = normalized.filter((element) => {
    if (seen.has(element.id)) {
      warnings.push(`Duplicate element id: ${element.id}; later duplicate ignored`)
      return false
    }
    seen.add(element.id)
    return true
  })
  const frames = new Map<string, MutableFrame>(
    unique.map((element) => [element.id, { element, parentId: element.parentId, children: [] }]),
  )
  const ordered = [...frames.values()].sort(compareFrames)
  ordered.forEach((frame) => {
    if (frame.parentId === null || !frames.has(frame.parentId)) {
      if (frame.parentId !== null)
        warnings.push(`Element ${frame.element.id} references missing parent ${frame.parentId}; attached at root`)
      frame.parentId = null
      return
    }
    frames.get(frame.parentId)?.children.push(frame)
  })
  ordered.forEach((frame) => frame.children.sort(compareFrames))
  const roots = ordered.filter((frame) => frame.parentId === null)
  const elements: IndexedElement[] = []
  roots.forEach((frame) => visit(frame, 0, 0, [], elements))
  if (elements.length !== frames.size) throw new TypeError("Element hierarchy contains a cycle")
  return {
    elements,
    byId: new Map(elements.map((element) => [element.id, element])),
    children: new Map(
      [...frames.values()].map((frame) => [frame.element.id, frame.children.map((child) => child.element.id)]),
    ),
    rootIds: roots.map((frame) => frame.element.id),
    warnings,
  }
}

// Two protocol observations captured in the same millisecond would otherwise
// share `observation-<capturedAt>` and collide; the sequence keeps generated
// ids unique within the process.
let observationSequence = 0

export function fromProtocolObservation(input: ProtocolObservationInput): SemanticObservation {
  const timestamp = input.observation.timestamp ?? input.observation.capturedAt
  const capturedAt = input.capturedAt ?? protocolTimestamp(timestamp)
  const id =
    input.id ??
    input.observation.id ??
    (capturedAt === undefined ? undefined : `observation-${capturedAt}-${++observationSequence}`)
  if (id === undefined) throw new TypeError("Protocol observation requires an id or timestamp")
  if (capturedAt === undefined) throw new TypeError("Protocol observation requires a capture time")
  return observe({
    id,
    target: input.target,
    capturedAt,
    ...(input.revision === undefined ? {} : { revision: input.revision }),
    elements: (input.observation.elements ?? []).map((element, index) => fromProtocolElement(element, index)),
    ...(input.observation.capabilities === undefined ? {} : { capabilities: input.observation.capabilities }),
    ...(input.content === undefined ? {} : { content: input.content }),
  })
}

export function observe(input: ObservationInput): SemanticObservation {
  const hierarchy = buildHierarchy(normalizeElements(input.elements))
  const metadata = normalizeMetadata(input)
  const capabilities = normalizeCapabilityStates(input.capabilities)
  const content = (input.content ?? []).map((value, index) => {
    if (!isUntrustedContentEnvelope(value))
      throw new TypeError(`Content entry ${index} is not an untrusted data envelope`)
    return value
  })
  const contentIds = new Set<string>()
  const duplicateContent = content.find((value) => {
    if (contentIds.has(value.id)) return true
    contentIds.add(value.id)
    return false
  })
  if (duplicateContent) throw new TypeError(`Duplicate content envelope id: ${duplicateContent.id}`)
  const timestamp = Date.parse(metadata.capturedAt)
  const protocol: CanonicalObservation = {
    id: metadata.id,
    ...(Number.isFinite(timestamp) ? { timestamp } : {}),
    source: metadata.target.kind === "web" ? "browser" : "native",
    capabilities,
    elements: hierarchy.elements.map(toProtocolElement),
    warnings: hierarchy.warnings,
  }
  return {
    metadata,
    ...hierarchy,
    capabilities,
    content,
    protocol,
  }
}

function fromProtocolElement(input: ProtocolUIElement, index: number): RawElement {
  if (input.id === undefined) throw new TypeError(`Protocol observation element ${index} has no id`)
  const disabled = stateBoolean(input, "disabled")
  const focused = stateBoolean(input, "focused")
  const selected = stateBoolean(input, "selected")
  const checked =
    input.states?.includes("mixed") || input.state?.mixed === true
      ? "mixed"
      : input.state?.checked === true
        ? true
        : input.state?.checked === false
          ? false
          : undefined
  return {
    id: input.id,
    order: index,
    ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
    ...(input.role === undefined ? {} : { role: input.role }),
    ...(input.name === undefined && input.accessibleName === undefined
      ? {}
      : { name: input.name ?? input.accessibleName }),
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.text === undefined ? {} : { text: input.text }),
    ...(input.value === undefined ? {} : { value: input.value }),
    ...(disabled === undefined ? {} : { enabled: !disabled }),
    ...(focused === undefined ? {} : { focused }),
    ...(selected === undefined ? {} : { selected }),
    ...(checked === undefined ? {} : { checked }),
    ...(input.bounds === undefined ? {} : { bounds: input.bounds }),
    ...(input.states === undefined ? {} : { states: input.states }),
    ...(input.state === undefined ? {} : { state: input.state }),
    ...(input.actions === undefined ? {} : { actions: input.actions }),
    capabilities: protocolCapabilities(input.capabilities),
  }
}

function protocolCapabilities(input: Readonly<Record<string, CapabilityState>> | undefined) {
  const output: Partial<Record<Capability, CapabilityState>> = {}
  const screenRead = input?.screen_read ?? input?.["screen-read"] ?? input?.screenreader
  const accessibility = input?.accessibility ?? input?.["accessibility-tree"] ?? input?.accessibility_tree
  const keyboard = input?.keyboard
  const pointer = input?.pointer ?? input?.mouse
  const direct = input?.direct_ui_control ?? input?.["direct-ui-control"] ?? input?.direct_ui
  if (screenRead !== undefined) output.screen_read = screenRead
  if (accessibility !== undefined) output.accessibility = accessibility
  if (keyboard !== undefined) output.keyboard = keyboard
  if (pointer !== undefined) output.pointer = pointer
  if (direct !== undefined) output.direct_ui_control = direct
  return output
}

function stateBoolean(input: ProtocolUIElement, state: "disabled" | "focused" | "selected") {
  if (input.states?.includes(state)) return true
  const value = input.state?.[state]
  return typeof value === "boolean" ? value : undefined
}

function visit(
  frame: MutableFrame,
  depth: number,
  siblingIndex: number,
  ancestors: readonly string[],
  output: IndexedElement[],
) {
  const path = [...ancestors, frame.element.id]
  output.push({ ...frame.element, index: output.length, depth, siblingIndex, path })
  frame.children.forEach((child, index) => visit(child, depth + 1, index, path, output))
}

function protocolTimestamp(timestamp: number | undefined) {
  if (timestamp === undefined || !Number.isFinite(timestamp)) return undefined
  const value = new Date(timestamp)
  return Number.isNaN(value.getTime()) ? undefined : value.toISOString()
}

function normalizeMetadata(input: ObservationInput): ObservationMetadata {
  return {
    id: requireText(input.id, "observation id"),
    target: normalizeTarget(input.target),
    capturedAt: requireText(input.capturedAt, "observation capture time"),
    ...(input.revision === undefined ? {} : { revision: requireText(input.revision, "observation revision") }),
  }
}

function compareFrames(left: MutableFrame, right: MutableFrame) {
  return left.element.sourceOrder - right.element.sourceOrder || left.element.id.localeCompare(right.element.id)
}

function isNormalizedElement(value: RawElement | NormalizedElement): value is NormalizedElement {
  return value !== null && "sourceOrder" in value && "sourceId" in value && "capabilities" in value
}

function requireText(value: string, kind: string) {
  if (!value.trim()) throw new TypeError(`Expected a non-empty ${kind}`)
  return value
}
