import type { LocatorReference, Selector } from "./locator"
import type { ElementState, SemanticElement, SemanticPageState } from "./snapshot"
import type { NavigationPhase, PageLifecycle, Viewport } from "./model"

export interface CompactElement {
  readonly ref: string
  readonly role: string
  readonly name?: string
  readonly value?: string
  readonly description?: string
  readonly state: ElementState
  readonly locator?: LocatorReference
}

export interface CompactPageRetrieval {
  readonly kind: "browser-page"
  readonly version: 1
  readonly page: {
    readonly id: string
    readonly tabId: string
    readonly documentId: string
    readonly url: string
    readonly title: string
    readonly lifecycle: PageLifecycle
    readonly navigation: {
      readonly phase: NavigationPhase
      readonly canGoBack: boolean
      readonly canGoForward: boolean
    }
  }
  readonly semanticSource: SemanticPageState["source"]
  readonly viewport?: Viewport
  readonly text: string
  readonly elements: readonly CompactElement[]
  readonly omitted: {
    readonly elements: number
    readonly locators: number
    readonly textTruncated: boolean
  }
}

export interface CompactPageOptions {
  readonly maxElements?: number
  readonly maxTextCharacters?: number
  readonly maxNameCharacters?: number
  readonly maxValueCharacters?: number
  readonly maxDescriptionCharacters?: number
  readonly maxSelectorCharacters?: number
  readonly maxUrlCharacters?: number
  readonly includeValues?: boolean
  readonly includeDescriptions?: boolean
}

const compactStateKeys = [
  "checked",
  "current",
  "disabled",
  "expanded",
  "focused",
  "level",
  "multiselectable",
  "pressed",
  "readonly",
  "required",
  "selected",
] as const

export function compactPage(state: SemanticPageState, options: CompactPageOptions = {}): CompactPageRetrieval {
  const maxElements = normalizeLimit(options.maxElements, 80)
  const maxTextCharacters = normalizeLimit(options.maxTextCharacters, 12_000)
  const maxNameCharacters = normalizeLimit(options.maxNameCharacters, 500)
  const maxValueCharacters = normalizeLimit(options.maxValueCharacters, 1_000)
  const maxDescriptionCharacters = normalizeLimit(options.maxDescriptionCharacters, 500)
  const maxSelectorCharacters = normalizeLimit(options.maxSelectorCharacters, 1_000)
  const maxUrlCharacters = normalizeLimit(options.maxUrlCharacters, 2_048)
  const selected = rankElements(state.elements)
    .slice(0, maxElements)
    .sort((left, right) => left.order - right.order)
  const projectedElements = selected.map(({ element, order }) => ({
    ref: `element-${order + 1}`,
    role: element.role,
    name: optionalBound(element.accessibleName, maxNameCharacters),
    value: options.includeValues === false ? undefined : optionalBound(element.value, maxValueCharacters),
    description:
      options.includeDescriptions === false ? undefined : optionalBound(element.description, maxDescriptionCharacters),
    state: compactState(element.state),
    locator: compactLocator(element.locator, maxSelectorCharacters),
  }))
  const text = boundText(state.text, maxTextCharacters)

  return {
    kind: "browser-page",
    version: 1,
    page: {
      id: state.page.id,
      tabId: state.page.tabId,
      documentId: state.documentId,
      url: boundText(state.page.url, maxUrlCharacters),
      title: boundText(state.page.title, maxNameCharacters),
      lifecycle: state.page.lifecycle,
      navigation: {
        phase: state.page.navigation.phase,
        canGoBack: state.page.navigation.canGoBack,
        canGoForward: state.page.navigation.canGoForward,
      },
    },
    semanticSource: state.source,
    viewport: state.viewport,
    text,
    elements: projectedElements,
    omitted: {
      elements: Math.max(0, state.elements.length - selected.length),
      locators: projectedElements.filter((element) => element.locator === undefined).length,
      textTruncated: Array.from(state.text).length > maxTextCharacters,
    },
  }
}

function rankElements(elements: readonly SemanticElement[]) {
  const interactiveRoles = new Set([
    "button",
    "checkbox",
    "combobox",
    "link",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "option",
    "radio",
    "searchbox",
    "slider",
    "spinbutton",
    "switch",
    "tab",
    "textbox",
  ])
  return elements
    .map((element, order) => ({
      element,
      order,
      score: interactiveRoles.has(element.role) ? 1 : 0,
    }))
    .sort((left, right) => right.score - left.score || left.order - right.order)
}

function compactState(state: SemanticElement["state"]): ElementState {
  return Object.fromEntries(
    compactStateKeys.flatMap((key) => {
      const value = state[key]
      return value === undefined ? [] : [[key, value] as const]
    }),
  )
}

function compactLocator(locator: LocatorReference, limit: number): LocatorReference | undefined {
  return selectorCharacters(locator.selector) <= limit ? locator : undefined
}

function selectorCharacters(selector: Selector): number {
  if (selector.kind === "role") {
    return Array.from(selector.kind + selector.role + (selector.name ?? "")).length
  }
  return Array.from(selector.kind + selector.value).length
}

function optionalBound(value: string | undefined, limit: number): string | undefined {
  return value === undefined ? undefined : boundText(value, limit)
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.max(0, Math.trunc(value))
}

function boundText(value: string, limit: number): string {
  const characters = Array.from(value)
  if (characters.length <= limit) return value
  const marker = "…[truncated]"
  if (limit <= marker.length) return characters.slice(0, limit).join("")
  return `${characters.slice(0, Math.ceil((limit - marker.length) / 2)).join("")}${marker}${characters
    .slice(characters.length - Math.floor((limit - marker.length) / 2))
    .join("")}`
}
