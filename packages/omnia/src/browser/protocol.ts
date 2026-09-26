import type { ElementReference, JsonObject, Observation, Source, UIElement } from "../protocol"
import type { LocatorReference, Selector } from "./locator"
import type { DocumentId, NavigationState, PageId, TabId } from "./model"
import type { SemanticElement, SemanticPageState } from "./snapshot"

export interface BrowserNavigationMetadata {
  readonly phase: NavigationState["phase"]
  readonly kind: NavigationState["kind"]
  readonly url: string
  readonly fromUrl?: string
  readonly targetUrl?: string
  readonly startedAt?: string
  readonly error?: string
  readonly errorCode?: string
  readonly canGoBack: boolean
  readonly canGoForward: boolean
}

export interface BrowserObservationMetadata {
  readonly source: "browser"
  readonly tabId: TabId
  readonly pageId: PageId
  readonly documentId: DocumentId
  readonly navigation: BrowserNavigationMetadata
  readonly trust: "untrusted-web-content"
}

export interface BrowserObservation extends Observation {
  readonly id: string
  readonly source: Source
  readonly backend: "browser"
  readonly elements: readonly UIElement[]
  readonly text: string
  readonly browser: BrowserObservationMetadata
}

export interface ProtocolObservationOptions {
  readonly observationId?: string
}

export function toObservation(state: SemanticPageState, options: ProtocolObservationOptions = {}): BrowserObservation {
  const observationId =
    options.observationId ?? `browser-observation:${state.page.tabId}:${state.page.id}:${state.documentId}`
  const capturedAt = Date.parse(state.capturedAt)
  const timestamp = Number.isFinite(capturedAt) && capturedAt >= 0 ? capturedAt : undefined
  const navigation = navigationMetadata(state.page.navigation)
  const metadata: JsonObject = {
    adapter: "browser",
    tabId: state.page.tabId,
    pageId: state.page.id,
    documentId: state.documentId,
    navigationPhase: state.page.navigation.phase,
    canGoBack: state.page.navigation.canGoBack,
    canGoForward: state.page.navigation.canGoForward,
  }

  return {
    id: observationId,
    ...(timestamp === undefined ? {} : { capturedAt: timestamp, timestamp }),
    source: state.source === "metadata-only" ? "browser" : state.source,
    backend: "browser",
    elements: state.elements.map((element) => toUIElement(element, observationId)),
    text: state.text,
    provenance: {
      source: "webpage",
      trust: "untrusted",
      authority: "none",
      origin: state.page.url,
      ...(timestamp === undefined ? {} : { capturedAt: timestamp }),
    },
    metadata,
    browser: {
      source: "browser",
      tabId: state.page.tabId,
      pageId: state.page.id,
      documentId: state.documentId,
      navigation,
      trust: "untrusted-web-content",
    },
  }
}

export function toUIElement(element: SemanticElement, observationId?: string): UIElement {
  const reference: ElementReference = {
    ...(observationId === undefined ? {} : { observationId }),
    elementId: element.id,
    source: "browser",
    backend: "browser",
    role: element.role,
    locator: locatorJson(element.locator),
    metadata: {
      pageId: element.locator.pageId,
      frameId: element.locator.frameId,
      documentId: element.locator.documentId,
    },
  }
  const source =
    element.evidence.length === 2 ? "hybrid" : element.evidence.includes("accessibility") ? "accessibility" : "dom"

  return {
    id: element.id,
    role: element.role,
    ...(element.accessibleName === undefined
      ? {}
      : { name: element.accessibleName, accessibleName: element.accessibleName }),
    ...(element.description === undefined ? {} : { description: element.description }),
    ...(element.text === undefined ? {} : { text: element.text }),
    ...(element.value === undefined ? {} : { value: element.value }),
    state: element.state,
    ...(element.parentId === undefined ? {} : { parentId: element.parentId }),
    source,
    backend: "browser",
    reference,
    provenance: {
      source: "webpage",
      trust: "untrusted",
      authority: "none",
      backend: "browser",
    },
    metadata: {
      ...(element.domNodeId === undefined ? {} : { domNodeId: element.domNodeId }),
      evidence: element.evidence.join(","),
    },
  }
}

function navigationMetadata(navigation: NavigationState): BrowserNavigationMetadata {
  return {
    phase: navigation.phase,
    kind: navigation.kind,
    url: navigation.url,
    ...(navigation.fromUrl === undefined ? {} : { fromUrl: navigation.fromUrl }),
    ...(navigation.targetUrl === undefined ? {} : { targetUrl: navigation.targetUrl }),
    ...(navigation.startedAt === undefined ? {} : { startedAt: navigation.startedAt }),
    ...(navigation.error === undefined ? {} : { error: navigation.error.message }),
    ...(navigation.error?.code === undefined ? {} : { errorCode: navigation.error.code }),
    canGoBack: navigation.canGoBack,
    canGoForward: navigation.canGoForward,
  }
}

function locatorJson(locator: LocatorReference): JsonObject {
  return {
    pageId: locator.pageId,
    frameId: locator.frameId,
    documentId: locator.documentId,
    selector: selectorJson(locator.selector),
    match: locator.match,
    ...(locator.ordinal === undefined ? {} : { ordinal: locator.ordinal }),
  }
}

function selectorJson(selector: Selector): JsonObject {
  if (selector.kind === "role") {
    return {
      kind: selector.kind,
      role: selector.role,
      ...(selector.name === undefined ? {} : { name: selector.name }),
      ...(selector.exact === undefined ? {} : { exact: selector.exact }),
    }
  }
  if (selector.kind === "text" || selector.kind === "label") {
    return {
      kind: selector.kind,
      value: selector.value,
      ...(selector.exact === undefined ? {} : { exact: selector.exact }),
    }
  }
  return { kind: selector.kind, value: selector.value }
}
