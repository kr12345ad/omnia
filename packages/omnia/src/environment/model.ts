import {
  CAPABILITY_STATES as PROTOCOL_CAPABILITY_STATES,
  type ActionType,
  type Bounds as ProtocolBounds,
  type CapabilityState as ProtocolCapabilityState,
  type ElementState as ProtocolElementState,
  type JsonValue,
  type Observation as ProtocolObservation,
  type Provenance as ProtocolProvenance,
  type Role,
  type UIElement as ProtocolUIElement,
} from "../protocol"
import type { ContentEnvelope } from "../security/types"

export const CAPABILITY_STATES = PROTOCOL_CAPABILITY_STATES

export const CAPABILITIES = ["screen_read", "accessibility", "keyboard", "pointer", "direct_ui_control"] as const

export type Capability = (typeof CAPABILITIES)[number]
export type CapabilityState = ProtocolCapabilityState
export type CapabilityStates = Readonly<Record<Capability, CapabilityState>>
export type CheckedState = boolean | "mixed"

export interface TargetDescriptor {
  readonly kind: "application" | "web" | "file"
  readonly id: string
  readonly title?: string
  readonly url?: string
  readonly path?: string
}

export type Bounds = ProtocolBounds
export type SemanticRole = Role

export interface ElementLocator {
  readonly automationId?: string
  readonly css?: string
  readonly xpath?: string
  readonly testId?: string
  readonly path?: readonly number[]
}

export interface RawElement {
  readonly id: string
  readonly parentId?: string | null
  readonly order?: number
  readonly role?: SemanticRole
  readonly name?: string
  readonly label?: string
  readonly accessibleName?: string
  readonly title?: string
  readonly description?: string
  readonly text?: string
  readonly value?: JsonValue
  readonly states?: readonly ProtocolElementState[]
  readonly state?: Readonly<Record<string, JsonValue | undefined>>
  readonly actions?: readonly ActionType[]
  readonly enabled?: boolean
  readonly disabled?: boolean
  readonly focused?: boolean
  readonly selected?: boolean
  readonly checked?: CheckedState
  readonly bounds?: Bounds
  readonly locator?: ElementLocator
  readonly capabilities?: Partial<Record<Capability, unknown>>
  readonly screenReadable?: boolean
  readonly accessible?: boolean
  readonly keyboardFocusable?: boolean
  readonly focusable?: boolean
  readonly clickable?: boolean
  readonly pointerInteractive?: boolean
  readonly directUiControl?: boolean
  readonly invokable?: boolean
}

export interface NormalizedElement {
  readonly id: string
  readonly sourceId: string
  readonly parentId: string | null
  readonly sourceOrder: number
  readonly role: SemanticRole
  readonly name?: string
  readonly description?: string
  readonly value?: string
  readonly enabled: boolean
  readonly focused: boolean
  readonly selected: boolean
  readonly checked?: CheckedState
  readonly bounds?: Bounds
  readonly locator?: ElementLocator
  readonly capabilities: CapabilityStates
}

export interface IndexedElement extends NormalizedElement {
  readonly index: number
  readonly depth: number
  readonly siblingIndex: number
  readonly path: readonly string[]
}

export type CanonicalUIElement = ProtocolUIElement
export type CanonicalObservation = ProtocolObservation

export interface ObservationMetadata {
  readonly id: string
  readonly target: TargetDescriptor
  readonly capturedAt: string
  readonly revision?: string
}

export interface ObservationInput {
  readonly id: string
  readonly target: TargetDescriptor
  readonly capturedAt: string
  readonly revision?: string
  readonly elements: readonly RawElement[]
  readonly capabilities?: unknown
  readonly content?: readonly UntrustedContentEnvelope[]
}

export interface SemanticObservation {
  readonly metadata: ObservationMetadata
  readonly elements: readonly IndexedElement[]
  readonly byId: ReadonlyMap<string, IndexedElement>
  readonly children: ReadonlyMap<string, readonly string[]>
  readonly rootIds: readonly string[]
  readonly capabilities: CapabilityStates
  readonly content: readonly UntrustedContentEnvelope[]
  readonly warnings: readonly string[]
  readonly protocol: CanonicalObservation
}

export type ApplicationContentSource = {
  readonly kind: "application"
  readonly id: string
  readonly windowId?: string
  readonly title?: string
}

export type WebContentSource = {
  readonly kind: "web"
  readonly url: string
  readonly frameUrl?: string
  readonly title?: string
}

export type FileContentSource = {
  readonly kind: "file"
  readonly path: string
  readonly name?: string
}

export type ContentSource = ApplicationContentSource | WebContentSource | FileContentSource

export interface ContentProvenance {
  readonly observationId: string
  readonly capturedAt: string
  readonly capturedBy: string
  readonly source: ContentSource
  readonly revision?: string
  readonly elementId?: string
  readonly locator?: ElementLocator
  readonly parentEnvelopeId?: string
}

export type UntrustedContentKind = "application_content" | "file_content" | "web_content"

export type UntrustedProvenance = ProtocolProvenance & {
  readonly source: "application" | "environment" | "file" | "webpage"
  readonly trust: "untrusted"
  readonly authority: "none"
}

export type UntrustedContentMetadata = {
  readonly observationId: string
  readonly capturedAt: string
  readonly capturedBy: string
  readonly source: ContentSource
  readonly revision?: string
  readonly elementId?: string
  readonly locator?: ElementLocator
  readonly parentEnvelopeId?: string
} & Readonly<Record<string, unknown>>

export interface UntrustedContentEnvelope extends ContentEnvelope {
  readonly _tag: "UntrustedContent"
  readonly kind: UntrustedContentKind
  readonly channel: "tool"
  readonly instruction: false
  readonly authority: "untrusted_data"
  readonly trust: "untrusted"
  readonly mediaType: string
  readonly provenance: UntrustedProvenance
  readonly metadata: UntrustedContentMetadata
}

export interface ContentEnvelopeInput {
  readonly id: string
  readonly mediaType: string
  readonly content: string
  readonly provenance: ContentProvenance
}

export interface DerivedContentEnvelopeInput {
  readonly id: string
  readonly mediaType?: string
  readonly content: string
  readonly capturedAt: string
  readonly capturedBy: string
  readonly revision?: string
}
