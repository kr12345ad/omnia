import type { ObservationDiff } from "./diff"
import {
  CAPABILITIES,
  type Capability,
  type CapabilityState,
  type IndexedElement,
  type ObservationMetadata,
  type SemanticObservation,
  type UntrustedContentEnvelope,
} from "./model"

export interface TaskContextOptions {
  readonly mode?: "relevant" | "full"
  readonly maxElements?: number
  readonly maxContent?: number
  readonly maxTextLength?: number
  readonly diff?: ObservationDiff
}

export interface SerializedElement {
  readonly id: string
  readonly role: string
  readonly parentId?: string
  readonly depth: number
  readonly name?: string
  readonly description?: string
  readonly value?: string
  readonly state?: Readonly<Record<string, boolean | "mixed">>
  readonly capabilities: Readonly<Partial<Record<Capability, CapabilityState>>>
  readonly change?: "added" | ElementChangeProjection | "moved"
}

export type SerializedContent = Omit<UntrustedContentEnvelope, "content"> & {
  readonly content: string
  readonly truncated?: true
  readonly originalLength?: number
}

export interface TaskContext {
  readonly version: 1
  readonly task: {
    readonly authority: "instruction"
    readonly text: string
  }
  readonly environment: {
    readonly authority: "untrusted_data"
    readonly trust: "untrusted"
    readonly instruction: false
    readonly observation: ObservationMetadata
    readonly capabilities: Readonly<Record<Capability, CapabilityState>>
    readonly selection: {
      readonly strategy: "task_relevant" | "full"
      readonly totalElements: number
      readonly includedElements: number
      readonly omittedElements: number
      readonly totalContent: number
      readonly includedContent: number
    }
    readonly elements: readonly SerializedElement[]
    readonly content: readonly SerializedContent[]
    readonly changes?: CompactObservationDiff
  }
}

interface ElementChangeProjection {
  readonly fields: readonly string[]
}

export interface CompactObservationDiff {
  readonly summary: string
  readonly targetChanged: boolean
  readonly added: readonly string[]
  readonly removed: readonly string[]
  readonly changed: readonly {
    readonly id: string
    readonly fields: readonly string[]
  }[]
  readonly moved: readonly string[]
  readonly capabilities: readonly {
    readonly capability: Capability
    readonly from: CapabilityState
    readonly to: CapabilityState
  }[]
  readonly content: {
    readonly added: readonly string[]
    readonly removed: readonly string[]
    readonly changed: readonly string[]
  }
}

export function buildTaskContext(
  observation: SemanticObservation,
  task: string,
  options: TaskContextOptions = {},
): TaskContext {
  const mode = options.mode ?? "relevant"
  const maxElements = limit(options.maxElements, mode === "full" ? observation.elements.length : 20, "maxElements")
  const maxContent = limit(options.maxContent, mode === "full" ? observation.content.length : 4, "maxContent")
  const maxTextLength = limit(options.maxTextLength, 240, "maxTextLength")
  const changed = changeIndex(options.diff)
  const selected = selectElements(observation, task, maxElements, mode, changed)
  const content = selectContent(observation.content, task, maxContent, mode)
  return {
    version: 1,
    task: { authority: "instruction", text: task },
    environment: {
      authority: "untrusted_data",
      trust: "untrusted",
      instruction: false,
      observation: observation.metadata,
      capabilities: observation.capabilities,
      selection: {
        strategy: mode === "full" ? "full" : "task_relevant",
        totalElements: observation.elements.length,
        includedElements: selected.length,
        omittedElements: observation.elements.length - selected.length,
        totalContent: observation.content.length,
        includedContent: content.length,
      },
      elements: selected.map((element) => projectElement(element, maxTextLength, changed.get(element.id))),
      content: content.map((envelope) => projectContent(envelope, maxTextLength)),
      ...(options.diff?.hasChanges ? { changes: projectDiff(options.diff) } : {}),
    },
  }
}

export function serializeTaskContext(
  observation: SemanticObservation,
  task: string,
  options: TaskContextOptions = {},
): string {
  return JSON.stringify(buildTaskContext(observation, task, options))
}

function selectElements(
  observation: SemanticObservation,
  task: string,
  maximum: number,
  mode: "relevant" | "full",
  changed: ReadonlyMap<string, "added" | readonly string[] | "moved">,
) {
  if (mode === "full") return observation.elements.slice(0, maximum)
  const tokens = tokenize(`${task} ${observation.metadata.target.title ?? ""}`)
  return observation.elements
    .map((element, index) => ({ element, index, score: relevance(element, tokens, changed.has(element.id)) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, maximum)
    .map(({ element }) => element)
}

function selectContent(
  content: readonly UntrustedContentEnvelope[],
  task: string,
  maximum: number,
  mode: "relevant" | "full",
) {
  if (mode === "full") return content.slice(0, maximum)
  const tokens = tokenize(task)
  return content
    .map((envelope, index) => ({
      envelope,
      index,
      score: tokenScore(`${envelope.id} ${JSON.stringify(envelope.metadata.source)} ${envelope.content}`, tokens),
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, maximum)
    .map(({ envelope }) => envelope)
}

function projectElement(
  element: IndexedElement,
  maxTextLength: number,
  change: "added" | readonly string[] | "moved" | undefined,
): SerializedElement {
  const state = {
    ...(element.enabled ? {} : { enabled: false }),
    ...(element.focused ? { focused: true } : {}),
    ...(element.selected ? { selected: true } : {}),
    ...(element.checked === undefined || element.checked === false ? {} : { checked: element.checked }),
  }
  return {
    id: element.id,
    role: element.role,
    ...(element.parentId === null ? {} : { parentId: element.parentId }),
    depth: element.depth,
    ...projectText("name", element.name, maxTextLength),
    ...projectText("description", element.description, maxTextLength),
    ...projectText("value", element.value, maxTextLength),
    ...(Object.keys(state).length === 0 ? {} : { state }),
    capabilities: Object.fromEntries(
      CAPABILITIES.flatMap((capability) =>
        element.capabilities[capability] === "unknown" ? [] : [[capability, element.capabilities[capability]]],
      ),
    ),
    ...(change === undefined ? {} : { change: typeof change === "string" ? change : { fields: change } }),
  }
}

function projectContent(envelope: UntrustedContentEnvelope, maxTextLength: number): SerializedContent {
  const truncated = envelope.content.length > maxTextLength
  return {
    _tag: envelope._tag,
    id: envelope.id,
    kind: envelope.kind,
    channel: envelope.channel,
    instruction: envelope.instruction,
    authority: envelope.authority,
    trust: envelope.trust,
    mediaType: envelope.mediaType,
    content: truncated ? envelope.content.slice(0, maxTextLength) : envelope.content,
    provenance: envelope.provenance,
    metadata: envelope.metadata,
    ...(truncated ? { truncated: true as const, originalLength: envelope.content.length } : {}),
  }
}

function projectDiff(diff: ObservationDiff): CompactObservationDiff {
  return {
    summary: diff.summary,
    targetChanged: diff.targetChanged,
    added: diff.added.map((element) => element.id),
    removed: diff.removed.map((element) => element.id),
    changed: diff.changed.map((change) => ({ id: change.after.id, fields: change.fields })),
    moved: diff.moved.map((move) => move.element.id),
    capabilities: diff.capabilities.map((change) => ({
      capability: change.capability,
      from: change.before,
      to: change.after,
    })),
    content: {
      added: diff.content.added.map((envelope) => envelope.id),
      removed: diff.content.removed.map((envelope) => envelope.id),
      changed: diff.content.changed.map((change) => change.after.id),
    },
  }
}

function changeIndex(diff: ObservationDiff | undefined) {
  const output = new Map<string, "added" | readonly string[] | "moved">()
  diff?.added.forEach((element) => output.set(element.id, "added"))
  diff?.changed.forEach((change) => output.set(change.after.id, change.fields))
  diff?.moved.forEach((move) => {
    if (!output.has(move.element.id)) output.set(move.element.id, "moved")
  })
  return output
}

function relevance(element: IndexedElement, tokens: readonly string[], changed: boolean) {
  const text =
    `${element.role} ${element.name ?? ""} ${element.description ?? ""} ${element.value ?? ""} ${JSON.stringify(element.locator ?? {})}`.toLowerCase()
  const interactive = CAPABILITIES.filter(
    (capability) => capability !== "screen_read" && element.capabilities[capability] === "available",
  ).length
  return (
    tokenScore(text, tokens) +
    (element.focused ? 100 : 0) +
    (changed ? 80 : 0) +
    (element.selected ? 20 : 0) +
    interactive * 3 -
    Math.min(element.depth, 10)
  )
}

function tokenScore(text: string, tokens: readonly string[]) {
  const normalized = text.toLowerCase()
  return tokens.reduce((score, token) => score + (normalized.includes(token) ? 1 : 0), 0)
}

function tokenize(input: string) {
  return [...new Set(input.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].filter(
    (token) => token.length > 1 && !["the", "and", "for", "with", "from", "into"].includes(token),
  )
}

function projectText<Key extends "name" | "description" | "value">(
  key: Key,
  value: string | undefined,
  maximum: number,
) {
  if (value === undefined || value.length === 0) return {}
  return { [key]: value.slice(0, maximum) }
}

function limit(value: number | undefined, fallback: number, name: string) {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < 0) throw new TypeError(`${name} must be a non-negative safe integer`)
  return result
}
