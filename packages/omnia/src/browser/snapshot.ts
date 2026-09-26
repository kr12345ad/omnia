import type { UIElement } from "../protocol"
import type { LocatorReference, Selector } from "./locator"
import type { DocumentId, FrameId, PageModel, Viewport } from "./model"

export type ElementStateValue = boolean | number | string

export type ElementState = Readonly<Record<string, ElementStateValue>>

export interface SemanticNodeBase {
  readonly id: string
  readonly parentId?: string
  readonly frameId?: FrameId
  readonly selectors?: readonly Selector[]
  readonly name?: string
  readonly value?: string
  readonly description?: string
  readonly text?: string
  readonly state?: ElementState
}

export interface DomNodeSnapshot extends SemanticNodeBase {
  readonly tagName?: string
  readonly role?: string
  readonly attributes?: Readonly<Record<string, string>>
}

export interface AccessibilityNodeSnapshot extends SemanticNodeBase {
  readonly domNodeId?: string
  readonly role: string
}

export interface DomDocumentSnapshot {
  readonly rootId: string
  readonly nodes: readonly DomNodeSnapshot[]
}

export interface AccessibilityTreeSnapshot {
  readonly rootId: string
  readonly nodes: readonly AccessibilityNodeSnapshot[]
}

export interface VisualEvidence {
  readonly id: string
  readonly mediaType: "image/png" | "image/jpeg" | "image/webp"
  readonly byteLength: number
  readonly capturedAt: string
}

export interface PageSnapshot {
  readonly documentId: DocumentId
  readonly capturedAt: string
  readonly page: PageModel
  readonly dom?: DomDocumentSnapshot
  readonly accessibility?: AccessibilityTreeSnapshot
  readonly visualEvidence?: readonly VisualEvidence[]
}

export type SemanticSource = "accessibility" | "dom" | "hybrid" | "metadata-only"

export interface SemanticElement extends UIElement {
  readonly id: string
  readonly parentId?: string
  readonly domNodeId?: string
  readonly role: string
  readonly accessibleName?: string
  readonly value?: string
  readonly description?: string
  readonly text?: string
  readonly state: ElementState
  readonly locator: LocatorReference
  readonly evidence: readonly ("accessibility" | "dom")[]
}

export interface SemanticPageState {
  readonly page: PageModel
  readonly documentId: DocumentId
  readonly capturedAt: string
  readonly source: SemanticSource
  readonly viewport?: Viewport
  readonly text: string
  readonly elements: readonly SemanticElement[]
}

export interface SemanticPageOptions {
  readonly maxTextCharacters?: number
}

const inputRoles: Readonly<Record<string, string>> = {
  button: "button",
  textarea: "textbox",
  select: "combobox",
  option: "option",
  form: "form",
  h1: "heading",
  h2: "heading",
  h3: "heading",
  h4: "heading",
  h5: "heading",
  h6: "heading",
  img: "img",
  nav: "navigation",
  main: "main",
  header: "banner",
  footer: "contentinfo",
  aside: "complementary",
  section: "region",
  article: "article",
  table: "table",
  ul: "list",
  ol: "list",
  li: "listitem",
}

const inputTypeRoles: Readonly<Record<string, string>> = {
  button: "button",
  checkbox: "checkbox",
  email: "textbox",
  image: "button",
  number: "spinbutton",
  radio: "radio",
  range: "slider",
  reset: "button",
  search: "searchbox",
  submit: "button",
  tel: "textbox",
  text: "textbox",
  url: "textbox",
}

export function deriveSemanticPageState(snapshot: PageSnapshot, options: SemanticPageOptions = {}): SemanticPageState {
  const domNodes = snapshot.dom?.nodes ?? []
  const accessibilityNodes = snapshot.accessibility?.nodes ?? []
  const domById = new Map(domNodes.map((node) => [node.id, node] as const))
  const domOrder = new Map(domNodes.map((node, index) => [node.id, index] as const))
  const accessibilityByDomId = new Map(
    accessibilityNodes.flatMap((node) => (node.domNodeId ? [[node.domNodeId, node] as const] : [])),
  )
  const accessibilityElements = accessibilityNodes.map((node, index) => {
    const domNode = node.domNodeId ? domById.get(node.domNodeId) : undefined
    const parentId = node.parentId ?? (domNode?.parentId ? accessibilityByDomId.get(domNode.parentId)?.id : undefined)
    return {
      index,
      element: semanticElement(snapshot, node, domNode, parentId),
    }
  })
  const domOnlyElements = domNodes
    .filter((node) => !accessibilityByDomId.has(node.id))
    .map((node, index) => ({
      index: accessibilityNodes.length + index,
      element: semanticElement(
        snapshot,
        node,
        node,
        node.parentId ? accessibilityByDomId.get(node.parentId)?.id : undefined,
      ),
    }))
  const elements = [...accessibilityElements, ...domOnlyElements]
    .sort((left, right) => {
      const leftOrder = left.element.domNodeId ? domOrder.get(left.element.domNodeId) : undefined
      const rightOrder = right.element.domNodeId ? domOrder.get(right.element.domNodeId) : undefined
      if (leftOrder !== undefined && rightOrder !== undefined) return leftOrder - rightOrder
      if (leftOrder !== undefined) return -1
      if (rightOrder !== undefined) return 1
      return left.index - right.index
    })
    .map(({ element }) => element)
  const source = deriveSource(snapshot)
  const text = compactText(
    [
      snapshot.page.title,
      ...elements.map((element) => element.text ?? element.accessibleName),
      ...elements.map((element) => element.value),
    ],
    normalizeLimit(options.maxTextCharacters, 50_000),
  )

  return {
    page: snapshot.page,
    documentId: snapshot.documentId,
    capturedAt: snapshot.capturedAt,
    source,
    viewport: snapshot.page.viewport,
    text,
    elements,
  }
}

function deriveSource(snapshot: PageSnapshot): SemanticSource {
  if (snapshot.dom && snapshot.accessibility) return "hybrid"
  if (snapshot.accessibility) return "accessibility"
  if (snapshot.dom) return "dom"
  return "metadata-only"
}

function semanticElement(
  snapshot: PageSnapshot,
  node: AccessibilityNodeSnapshot | DomNodeSnapshot,
  domNode: DomNodeSnapshot | undefined,
  parentId?: string,
): SemanticElement {
  const dom = "tagName" in node ? node : domNode
  const role = "role" in node ? node.role || domRole(dom) : domRole(dom)
  const domAttributes = dom?.attributes ?? {}
  const accessibleName = node.name ?? dom?.name ?? domAttributes["aria-label"] ?? domAttributes.title
  const evidence = domNode
    ? node === domNode
      ? (["dom"] as const)
      : (["accessibility", "dom"] as const)
    : (["accessibility"] as const)
  const fallbackValue = "domNodeId" in node ? (node.domNodeId ?? node.id) : node.id
  const sensitive = isSensitiveDomNode(dom)

  return {
    id: node.id,
    parentId,
    domNodeId: domNode?.id,
    role,
    accessibleName,
    value: sensitive ? undefined : (node.value ?? dom?.value),
    description: node.description ?? dom?.description,
    text: sensitive ? undefined : (node.text ?? dom?.text),
    state: mergeState(node.state, dom?.state),
    locator: {
      pageId: snapshot.page.id,
      frameId: node.frameId ?? dom?.frameId ?? snapshot.page.frames[0]?.id ?? snapshot.page.id,
      documentId: snapshot.documentId,
      selector: node.selectors?.[0] ?? dom?.selectors?.[0] ?? { kind: "opaque", value: fallbackValue },
      match: "strict",
    },
    evidence,
  }
}

function isSensitiveDomNode(node: DomNodeSnapshot | undefined): boolean {
  if (node?.tagName?.toLowerCase() !== "input") return false
  const type = node.attributes?.type?.toLowerCase()
  const autocomplete = node.attributes?.autocomplete?.toLowerCase()
  return type === "password" || autocomplete === "current-password" || autocomplete === "new-password"
}

function domRole(node: DomNodeSnapshot | undefined): string {
  if (!node) return "generic"
  if (node.role) return node.role
  const tagName = node.tagName?.toLowerCase()
  if (!tagName) return "generic"
  if (tagName === "a") return node.attributes?.href === undefined ? "generic" : "link"
  if (tagName === "input") return inputTypeRoles[node.attributes?.type?.toLowerCase() ?? "text"] ?? "textbox"
  return inputRoles[tagName] ?? tagName
}

function mergeState(accessibility: ElementState | undefined, dom: ElementState | undefined): ElementState {
  if (!accessibility) return dom ?? {}
  if (!dom) return accessibility
  return Object.fromEntries(
    [...new Set([...Object.keys(accessibility), ...Object.keys(dom)])].flatMap((key) => {
      const value = accessibility[key] ?? dom[key]
      return value === undefined ? [] : [[key, value] as const]
    }),
  )
}

function compactText(parts: readonly (string | undefined)[], limit: number): string {
  const values = Array.from(new Set(parts.map((part) => part?.trim()).filter((part): part is string => Boolean(part))))
  return boundText(values.join("\n"), limit)
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
