import { type ActionType, type JsonValue, type ProtocolElementState, type UIElement } from "../protocol"
import {
  type Bounds,
  type CapabilityState,
  type CapabilityStates,
  type CheckedState,
  type ElementLocator,
  type NormalizedElement,
  type RawElement,
  type TargetDescriptor,
} from "./model"

const roleAliases: Readonly<Record<string, string>> = {
  axbutton: "button",
  pushbutton: "button",
  hyperlink: "link",
  textfield: "textbox",
  edit: "textbox",
  textbox: "textbox",
  searchbox: "searchbox",
  checkbutton: "checkbox",
  check: "checkbox",
  radiobutton: "radio",
  combobox: "combobox",
  dropdown: "combobox",
  popupmenu: "menu",
  menuitem: "menuitem",
  listitem: "listitem",
  header: "heading",
  img: "img",
  image: "img",
  statictext: "text",
  plaintext: "text",
  document: "document",
  webarea: "document",
  window: "window",
  dialog: "dialog",
  alertdialog: "alertdialog",
  tab: "tab",
  tabpanel: "tabpanel",
  treeitem: "treeitem",
  row: "row",
  cell: "cell",
  columnheader: "columnheader",
  rowheader: "rowheader",
  separator: "separator",
  scrollbar: "scrollbar",
  slider: "slider",
  spinbutton: "spinbutton",
  progressbar: "progressbar",
  toolbar: "toolbar",
  navigation: "navigation",
  main: "main",
  banner: "banner",
  contentinfo: "contentinfo",
  form: "form",
  group: "group",
  region: "region",
  article: "article",
}

const keyboardActions: readonly ActionType[] = ["key", "keypress", "press", "press_keys", "type"]
const pointerActions: readonly ActionType[] = [
  "click",
  "doubleclick",
  "rightclick",
  "longpress",
  "move",
  "drag",
  "toggle",
  "select",
]

export function normalizeCapabilityState(value: unknown): CapabilityState {
  if (typeof value === "boolean") return value ? "available" : "unavailable"
  if (typeof value !== "string") return "unknown"
  const normalized = value
    .trim()
    .toLowerCase()
    .replaceAll(/[\s_-]+/g, "")
  if (["available", "supported", "ready", "enabled", "yes", "true", "full"].includes(normalized)) return "available"
  if (["degraded", "partial", "limited", "reduced"].includes(normalized)) return "degraded"
  if (["unavailable", "unsupported", "disabled", "no", "false", "none", "missing"].includes(normalized))
    return "unavailable"
  return "unknown"
}

export function normalizeCapabilityStates(value: unknown, fallback: CapabilityState = "unknown"): CapabilityStates {
  const input = Array.isArray(value)
    ? Object.fromEntries(
        value.flatMap((entry) => {
          if (!isRecord(entry)) return []
          const capability = typeof entry.capability === "string" ? entry.capability : entry.name
          if (typeof capability !== "string") return []
          const state = entry.status ?? entry.state
          return [[capability, state] as const]
        }),
      )
    : isRecord(value)
      ? value
      : {}
  return {
    screen_read: capabilityFromRecord(
      input,
      ["screen_read", "screen-read", "screenreading", "screen-reader"],
      fallback,
    ),
    accessibility: capabilityFromRecord(input, ["accessibility", "accessibility-tree", "accessibility_tree"], fallback),
    keyboard: capabilityFromRecord(input, ["keyboard"], fallback),
    pointer: capabilityFromRecord(input, ["pointer", "mouse"], fallback),
    direct_ui_control: capabilityFromRecord(
      input,
      ["direct_ui_control", "direct-ui-control", "direct-ui", "direct_ui"],
      fallback,
    ),
  }
}

export function normalizeElement(input: RawElement, fallbackOrder = 0): NormalizedElement {
  const sourceId = requireText(input.id, "element id")
  const bounds = normalizeBounds(input.bounds)
  const checked = normalizeInputChecked(input)
  const actions = input.actions ?? []
  return {
    id: sourceId,
    sourceId,
    parentId: input.parentId === undefined || input.parentId === null ? null : requireText(input.parentId, "parent id"),
    sourceOrder: finiteNumber(input.order) ?? fallbackOrder,
    role: normalizeRole(input.role),
    ...optionalText("name", input.name ?? input.accessibleName ?? input.label ?? input.title ?? input.text),
    ...optionalText("description", input.description),
    ...optionalText("value", formatValue(input.value)),
    enabled: input.enabled ?? input.disabled ?? !hasState(input, "disabled"),
    focused: input.focused ?? hasState(input, "focused"),
    selected: input.selected ?? hasState(input, "selected"),
    ...(checked === undefined ? {} : { checked }),
    ...(bounds === undefined ? {} : { bounds }),
    ...(input.locator === undefined ? {} : { locator: normalizeLocator(input.locator) }),
    capabilities: {
      screen_read: elementCapability(input.capabilities?.screen_read, input.screenReadable, actions, []),
      accessibility: elementCapability(input.capabilities?.accessibility, input.accessible, actions, []),
      keyboard: elementCapability(
        input.capabilities?.keyboard,
        input.keyboardFocusable ?? input.focusable,
        actions,
        keyboardActions,
      ),
      pointer: elementCapability(
        input.capabilities?.pointer,
        input.clickable ?? input.pointerInteractive,
        actions,
        pointerActions,
      ),
      direct_ui_control: elementCapability(
        input.capabilities?.direct_ui_control,
        input.directUiControl ?? input.invokable,
        actions,
        [...keyboardActions, ...pointerActions],
      ),
    },
  }
}

export function toProtocolElement(input: NormalizedElement): UIElement {
  const states: ProtocolElementState[] = [
    ...(input.enabled ? [] : (["disabled"] as const)),
    ...(input.focused ? (["focused"] as const) : []),
    ...(input.selected ? (["selected"] as const) : []),
    ...(input.checked === true ? (["checked"] as const) : []),
    ...(input.checked === "mixed" ? (["mixed"] as const) : []),
  ]
  return {
    id: input.id,
    role: input.role,
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.value === undefined ? {} : { value: input.value }),
    ...(input.parentId === null ? {} : { parentId: input.parentId }),
    ...(input.bounds === undefined ? {} : { bounds: input.bounds }),
    ...(states.length === 0 ? {} : { states }),
    capabilities: input.capabilities,
  }
}

export function normalizeTarget(input: TargetDescriptor): TargetDescriptor {
  if (!["application", "web", "file"].includes(input.kind))
    throw new TypeError(`Unsupported environment target kind: ${input.kind}`)
  return {
    kind: input.kind,
    id: requireText(input.id, "target id"),
    ...optionalText("title", input.title),
    ...optionalText("url", input.url),
    ...optionalText("path", input.path),
  }
}

export function normalizeRole(input: unknown): string {
  const value = typeof input === "string" ? input.trim().toLowerCase() : "generic"
  const key = value.replace(/^(?:ax|aria|ui)[-_:.\s]*/, "").replaceAll(/[^a-z0-9]/g, "")
  return (roleAliases[key] ?? key) || "generic"
}

function capabilityFromRecord(
  input: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  fallback: CapabilityState,
) {
  const key = keys.find((candidate) => Object.hasOwn(input, candidate))
  return key === undefined ? fallback : normalizeCapabilityState(input[key])
}

function elementCapability(
  explicit: unknown,
  value: boolean | undefined,
  actions: readonly ActionType[],
  supportedActions: readonly ActionType[],
) {
  if (value !== undefined) return value ? "available" : "unavailable"
  const normalized = normalizeCapabilityState(explicit)
  if (normalized !== "unknown") return normalized
  if (actions.some((action) => supportedActions.includes(action))) return "available"
  return normalized
}

function normalizeInputChecked(input: RawElement): CheckedState | undefined {
  if (input.checked !== undefined) return input.checked
  if (hasState(input, "mixed")) return "mixed"
  if (hasState(input, "checked") || input.state?.checked === true) return true
  if (input.state?.checked === false) return false
  return undefined
}

function hasState(input: RawElement, state: ProtocolElementState) {
  return input.states?.includes(state) === true || input.state?.[state] === true
}

function normalizeBounds(input: Bounds | undefined) {
  if (input === undefined) return undefined
  if (![input.x, input.y, input.width, input.height].every((value) => Number.isFinite(value))) return undefined
  if (input.width < 0 || input.height < 0) return undefined
  return { x: input.x, y: input.y, width: input.width, height: input.height }
}

function normalizeLocator(input: ElementLocator): ElementLocator {
  return {
    ...optionalText("automationId", input.automationId),
    ...optionalText("css", input.css),
    ...optionalText("xpath", input.xpath),
    ...optionalText("testId", input.testId),
    ...(input.path === undefined ? {} : { path: input.path.map((value) => finiteNumber(value) ?? 0) }),
  }
}

function optionalText<Key extends string>(key: Key, value: string | undefined) {
  if (value === undefined) return {}
  const normalized = value.replaceAll(/\s+/g, " ").trim()
  if (!normalized) return {}
  return { [key]: normalized }
}

function formatValue(value: JsonValue | undefined) {
  if (value === undefined) return undefined
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value)
  return JSON.stringify(value)
}

function finiteNumber(value: number | undefined) {
  return value !== undefined && Number.isFinite(value) ? value : undefined
}

function requireText(value: string, kind: string) {
  if (!value.trim()) throw new TypeError(`Expected a non-empty ${kind}`)
  return value.trim()
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
