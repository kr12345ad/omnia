import { Effect, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import * as Tool from "../tool"
import DESCRIPTION from "./observe.txt"
import { ObservationEnvelope, configFromEnv, computerId, request } from "./client"
import { CAPS } from "./output"
import { applicationOf } from "./policy"

const NO_GEOMETRY = Number.MAX_SAFE_INTEGER
const ROW_TOLERANCE = 10
const LABEL_CHARS = 80
const VALUE_CHARS = 40

// Roles a model can act on directly. An element outside this set still counts
// as actionable when the backend advertises actions for it.
const ACTIONABLE_ROLES = new Set([
  "button",
  "pushbutton",
  "togglebutton",
  "checkbox",
  "radiobutton",
  "combobox",
  "textbox",
  "textfield",
  "entry",
  "searchbox",
  "spinbutton",
  "slider",
  "switch",
  "listbox",
  "listitem",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "menu",
  "menubar",
  "tab",
  "tablist",
  "link",
  "tree",
  "treeitem",
  "option",
  "scrollbar",
  "dateeditor",
  "spinner",
])

// Text-entry controls take their aim from a role-specific inset instead of the
// middle of the box, mirroring the point the runtime itself aims at.
const TEXT_LIKE_ROLES = new Set([
  "textbox",
  "entry",
  "combobox",
  "spinbutton",
  "searchbox",
  "password",
  "text field",
  "text",
  "paragraph",
  "document text",
])

const ACCESSIBILITY_NOTES: Record<string, string> = {
  degraded:
    "the accessibility tree is incomplete, so some controls are invisible in this list; confirm with computer_screenshot.",
  unavailable: "no accessibility tree is available; use computer_screenshot to see the screen.",
}

export const Parameters = Schema.Struct({
  applicationId: Schema.optional(Schema.String).annotate({
    description: "Restrict the observation to one application, for example soffice. Defaults to everything visible.",
  }),
  app: Schema.optional(Schema.String).annotate({
    description: "Alias for applicationId.",
  }),
  window: Schema.optional(Schema.String).annotate({
    description: "Restrict the observation to one window by title or app fragment, for example Default Project.",
  }),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 }))).annotate({
    description: `Maximum controls to include in the text summary, shared across windows with the focused window served first. Defaults to ${CAPS.observeControls}.`,
  }),
  focusFirst: Schema.optional(Schema.Boolean).annotate({
    description: "List only the focused window. Defaults to true; set false to survey every window.",
  }),
})

type Bounds = { x: number; y: number; width: number; height: number }

type Element = {
  id?: string
  ref?: string
  reference?: { elementId?: string; id?: string }
  parentId?: string
  role?: string
  name?: string
  text?: string
  value?: unknown
  description?: string
  states?: string[]
  actions?: string[]
  aim?: { x?: number; y?: number; strategy?: string }
  bounds?: Bounds
  metadata?: Record<string, unknown>
}

type ObservationResponse = {
  ok: true
  observation: {
    id: string
    elements?: Element[]
    text?: string
    warnings?: string[]
    accessibility?: unknown
    capabilities?: Record<string, unknown>
    metadata?: Record<string, unknown>
  }
}

type Group = {
  application: string
  title: string
  focused: boolean
  ref?: string
  bounds?: Bounds
  elements: Element[]
}

function refOf(element: Element): string | undefined {
  return element.id ?? element.ref ?? element.reference?.elementId ?? element.reference?.id
}

function applicationOfElement(element: Element): string | undefined {
  const raw = element.metadata?.application
  if (typeof raw === "string" && raw.length > 0) return raw
  if (typeof raw === "object" && raw !== null) {
    const name = (raw as { name?: unknown }).name
    if (typeof name === "string" && name.length > 0) return name
  }
  return undefined
}

function isFocused(element: Element): boolean {
  return (element.states ?? []).includes("focused")
}

function actionsOf(element: Element): string[] {
  return (element.actions ?? []).filter((action) => typeof action === "string" && action.length > 0)
}

function actionable(element: Element): boolean {
  return actionsOf(element).length > 0 || ACTIONABLE_ROLES.has((element.role ?? "").toLowerCase())
}

function shorten(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

function labelOf(element: Element): string {
  return shorten(element.name ?? element.text ?? refOf(element) ?? "element", LABEL_CHARS)
}

/** The point the runtime aims at, so the model never has to guess the center. */
function aimOf(element: Element): { x: number; y: number; strategy: string } | undefined {
  const explicit = element.aim
  if (explicit !== undefined && typeof explicit.x === "number" && typeof explicit.y === "number") {
    return { x: explicit.x, y: explicit.y, strategy: explicit.strategy ?? "provider-hint" }
  }
  const bounds = element.bounds
  if (bounds === undefined) return undefined
  const textLike = TEXT_LIKE_ROLES.has((element.role ?? "").toLowerCase())
  if (textLike) {
    return {
      x: Math.round(bounds.x + Math.min(28, Math.max(6, bounds.width * 0.08))),
      y: Math.round(bounds.y + bounds.height / 2),
      strategy: "role-inset",
    }
  }
  // A control with actions is aimed at its center; anything else is only a
  // bounding box, which must stay labelled as such rather than look precise.
  const strategy = actionable(element) ? "control-center" : "bounds-center"
  return {
    x: Math.round(bounds.x + bounds.width / 2),
    y: Math.round(bounds.y + bounds.height / 2),
    strategy,
  }
}

function containsPoint(bounds: Bounds | undefined, x: number, y: number): boolean {
  if (bounds === undefined) return false
  return x >= bounds.x && x <= bounds.x + bounds.width && y >= bounds.y && y <= bounds.y + bounds.height
}

function areaOf(bounds: Bounds | undefined): number {
  return bounds === undefined ? NO_GEOMETRY : bounds.width * bounds.height
}

function explicitWindowIndex(element: Element, windows: readonly Element[]): number {
  const windowRef = element.metadata?.windowRef
  if (typeof windowRef === "string" && windowRef.length > 0) {
    const matched = windows.findIndex((window) => refOf(window) === windowRef)
    if (matched >= 0) return matched
  }
  if (typeof element.parentId === "string" && element.parentId.length > 0) {
    const matched = windows.findIndex((window) => refOf(window) === element.parentId)
    if (matched >= 0) return matched
  }
  const id = refOf(element)
  if (id !== undefined) {
    const nested = windows.findIndex((window) => {
      const key = refOf(window)
      return key !== undefined && id.startsWith(`${key}/`)
    })
    if (nested >= 0) return nested
  }
  return -1
}

function containingWindowIndices(
  element: Element,
  windows: readonly Element[],
  candidates: readonly number[],
): number[] {
  const bounds = element.bounds
  if (bounds === undefined) return []
  const x = bounds.x + bounds.width / 2
  const y = bounds.y + bounds.height / 2
  return candidates
    .filter((index) => containsPoint(windows[index].bounds, x, y))
    .sort((a, b) => areaOf(windows[a].bounds) - areaOf(windows[b].bounds))
}

function applicationWindowIndex(element: Element, windows: readonly Element[]): number {
  const application = applicationOfElement(element)
  if (application === undefined) return -1
  const candidates = windows.flatMap((window, index) => (applicationOfElement(window) === application ? [index] : []))
  if (candidates.length === 0) return -1
  if (candidates.length === 1) return candidates[0]
  const contained = containingWindowIndices(element, windows, candidates)[0]
  if (contained !== undefined) return contained
  const focused = candidates.find((index) => isFocused(windows[index]))
  return focused ?? candidates[0]
}

function windowIndexFor(element: Element, windows: readonly Element[]): number {
  const explicit = explicitWindowIndex(element, windows)
  if (explicit >= 0) return explicit
  const byApplication = applicationWindowIndex(element, windows)
  if (byApplication >= 0) return byApplication
  const inside = containingWindowIndices(
    element,
    windows,
    windows.map((_, index) => index),
  )[0]
  if (inside !== undefined) return inside
  // A single reported window owns everything the backend returned.
  return windows.length === 1 ? 0 : -1
}

function sortForReading(elements: readonly Element[]): Element[] {
  const sorted = [...elements].sort(
    (a, b) =>
      (a.bounds?.y ?? NO_GEOMETRY) - (b.bounds?.y ?? NO_GEOMETRY) ||
      (a.bounds?.x ?? NO_GEOMETRY) - (b.bounds?.x ?? NO_GEOMETRY),
  )
  // Baselines differ by a few pixels inside one visual row, so rows are banded
  // before the left-to-right pass instead of compared by y alone.
  const rows: Element[][] = []
  for (const element of sorted) {
    const row = rows.find(
      (candidate) =>
        Math.abs((candidate[0].bounds?.y ?? NO_GEOMETRY) - (element.bounds?.y ?? NO_GEOMETRY)) <= ROW_TOLERANCE,
    )
    if (row === undefined) rows.push([element])
    else row.push(element)
  }
  return rows.flatMap((row) => [...row].sort((a, b) => (a.bounds?.x ?? NO_GEOMETRY) - (b.bounds?.x ?? NO_GEOMETRY)))
}

function orderedForDisplay(elements: readonly Element[]): Element[] {
  const reading = sortForReading(elements)
  return [...reading.filter(actionable), ...reading.filter((element) => !actionable(element))]
}

function windowHeader(index: number, group: Group): string {
  const bounds =
    group.bounds === undefined
      ? ""
      : ` @${group.bounds.x},${group.bounds.y} ${group.bounds.width}x${group.bounds.height}`
  const ref = group.ref === undefined ? "" : ` ref=${group.ref}`
  return `${index}. ${group.application} — "${group.title}"${group.focused ? " [focused]" : ""}${bounds}${ref}`
}

function elementLine(element: Element): string {
  const ref = refOf(element)
  const aim = aimOf(element)
  const states = (element.states ?? []).filter((state) => state.length > 0)
  const value =
    element.value === undefined
      ? undefined
      : typeof element.value === "string"
        ? element.value
        : JSON.stringify(element.value)
  const parts = [`- ${element.role ?? "unknown"} "${labelOf(element)}"`]
  if (ref !== undefined) parts.push(`ref=${ref}`)
  if (aim !== undefined) {
    parts.push(`@${aim.x},${aim.y}${aim.strategy === "bounds-center" ? " (bounds-center)" : ""}`)
  }
  if (states.length > 0) parts.push(`[${states.join(", ")}]`)
  if (value !== undefined && value.length > 0) parts.push(`value="${shorten(value, VALUE_CHARS)}"`)
  const actions = actionsOf(element)
  if (actions.length > 0) parts.push(`actions=${actions.join(",")}`)
  return `  ${parts.join(" ")}`
}

function describeElement(element: Element): string {
  const ref = refOf(element)
  return `${element.role ?? "unknown"} "${labelOf(element)}"${ref === undefined ? "" : ` ref=${ref}`}`
}

function accessibilityOf(observation: ObservationResponse["observation"]): string | undefined {
  const capabilities = observation.capabilities
  const raw =
    capabilities?.accessibility ??
    capabilities?.["accessibility-tree"] ??
    capabilities?.accessibility_tree ??
    observation.metadata?.accessibility ??
    observation.accessibility
  if (typeof raw === "boolean") return raw ? "available" : "unavailable"
  return typeof raw === "string" && raw.length > 0 ? raw.toLowerCase() : undefined
}

function plural(count: number): string {
  return count === 1 ? "" : "s"
}

export const ComputerObserveTool = Tool.define<typeof Parameters, Record<string, unknown>, HttpClient.HttpClient>(
  "computer_observe",
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const config = yield* configFromEnv()
          const app = applicationOf(params)
          const window = params.window?.trim() || undefined
          yield* ctx.ask({
            permission: "computer",
            patterns: [`observe:${app ?? "*"}`],
            always: ["observe", "observe:*"],
            metadata: { operation: "observe", application: app ?? "desktop" },
          })
          const id = yield* computerId(http, config, ctx.sessionID)
          const result = yield* request<ObservationResponse>(
            http,
            config,
            "POST",
            `/v1/computers/${id}/observe`,
            {
              ...(app === undefined ? {} : { applicationId: app }),
              ...(window === undefined ? {} : { window }),
            },
            { validate: Schema.is(ObservationEnvelope) },
          )
          const observation = result.observation
          const elements = observation.elements ?? []
          const windows = elements.filter((element) => element.role === "window")
          const controls = elements.filter((element) => element.role !== "window" && element.role !== "application")
          const accessibility = accessibilityOf(observation)
          const focusFirst = params.focusFirst ?? true
          const focusedWindow = windows.findIndex(isFocused)
          // Focused window first; the rest keep the order the backend reported.
          const listed = (focusFirst && focusedWindow >= 0 ? [windows[focusedWindow]] : windows).sort(
            (a, b) => Number(isFocused(b)) - Number(isFocused(a)),
          )
          const listedWindows = listed.slice(0, CAPS.observeWindows)
          const droppedWindows = listed.length - listedWindows.length

          const owners = controls.map((element) => ({ element, index: windowIndexFor(element, windows) }))
          const elementsOf = (index: number) =>
            orderedForDisplay(owners.flatMap((entry) => (entry.index === index ? [entry.element] : [])))
          const unattributed = orderedForDisplay(owners.flatMap((entry) => (entry.index < 0 ? [entry.element] : [])))

          const groups: Group[] = listedWindows.map((window) => ({
            application: applicationOfElement(window) ?? "unknown",
            title: window.name ?? refOf(window) ?? "window",
            focused: isFocused(window),
            ...(refOf(window) === undefined ? {} : { ref: refOf(window) }),
            ...(window.bounds === undefined ? {} : { bounds: window.bounds }),
            elements: elementsOf(windows.indexOf(window)),
          }))
          if (!focusFirst || focusedWindow < 0) {
            groups.push({
              application: "desktop",
              title: "(no window owner)",
              focused: false,
              elements: orderedForDisplay(unattributed),
            })
          }

          const limit = params.limit ?? CAPS.observeControls
          let remaining = limit
          const rendered = groups.map((group) => {
            const shown = group.elements.slice(0, Math.max(remaining, 0))
            remaining -= shown.length
            return { group, shown, dropped: group.elements.length - shown.length }
          })
          const shownCount = rendered.reduce((total, entry) => total + entry.shown.length, 0)

          const lines: string[] = [
            `observation ${observation.id} · ${windows.length} window${plural(windows.length)} · ${controls.length} control${plural(controls.length)} · ${shownCount} shown`,
          ]
          const note = accessibility === undefined ? undefined : ACCESSIBILITY_NOTES[accessibility]
          if (note !== undefined) lines.push(`accessibility: ${accessibility} — ${note}`)
          if (focusFirst && windows.length > 0 && focusedWindow < 0) {
            lines.push("focus: no window reported focus — listing every window")
          }
          const focusedElement = controls.find(isFocused) ?? windows.find(isFocused)
          if (focusedElement !== undefined) lines.push(`focused: ${describeElement(focusedElement)}`)

          const displayed = rendered.filter((entry) => entry.group.elements.length > 0)
          displayed.forEach((entry, index) => {
            lines.push(windowHeader(index + 1, entry.group))
            for (const element of entry.shown) lines.push(elementLine(element))
            if (entry.dropped > 0) {
              lines.push(
                `  … ${entry.dropped} element${plural(entry.dropped)} omitted in this window — use computer_snapshot with limit/offset or computer_find by name`,
              )
            }
          })

          if (droppedWindows > 0) {
            lines.push(
              `… ${droppedWindows} window${plural(droppedWindows)} omitted — narrow with applicationId or window, or page with computer_snapshot limit/offset`,
            )
          }
          if (focusFirst && focusedWindow >= 0) {
            const elsewhere = controls.length - shownCount
            if (elsewhere > 0) {
              lines.push(
                `… ${elsewhere} control${plural(elsewhere)} outside the focused window not shown — re-run with focusFirst: false, narrow with applicationId or window, or use computer_find`,
              )
            }
          }
          for (const warning of observation.warnings ?? []) lines.push(`warning: ${warning}`)

          const title = `Observed ${app ?? "desktop"} (${shownCount} of ${controls.length} controls)`
          yield* ctx.metadata({ title, metadata: {} })
          return {
            title,
            output: lines.join("\n"),
            metadata: {
              observationId: observation.id,
              application: app ?? "desktop",
              elementCount: elements.length,
              ...(accessibility === undefined ? {} : { accessibility }),
              focused: focusedWindow >= 0,
              truncated: shownCount < controls.length || droppedWindows > 0,
              dropped: controls.length - shownCount + droppedWindows,
              warnings: observation.warnings ?? [],
            },
          }
        }),
    }
  }),
)
