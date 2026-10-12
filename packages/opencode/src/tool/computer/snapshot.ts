import { Effect, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import { computeAim, isCenterGuess } from "@opencode-ai/omnia/computer-use/aim"
import {
  computerDiffFallsBack,
  diffComputerElements,
  type ComputerElementDiffEntry,
} from "@opencode-ai/omnia/environment/snapshot-diff"
import * as Tool from "../tool"
import DESCRIPTION from "./snapshot.txt"
import {
  ObservationEnvelope,
  configFromEnv,
  computerId,
  latestObservation,
  observationFor,
  rememberObservation,
  request,
} from "./client"
import { CAPS } from "./output"
import { applicationOf } from "./policy"

export const Parameters = Schema.Struct({
  applicationId: Schema.optional(Schema.String).annotate({
    description: "Restrict the snapshot to one application, for example soffice. Defaults to everything visible.",
  }),
  app: Schema.optional(Schema.String).annotate({
    description: "Alias for applicationId.",
  }),
  window: Schema.optional(Schema.String).annotate({
    description: "Restrict the snapshot to one window by title or app fragment, for example Default Project.",
  }),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 }))).annotate({
    description: `Maximum controls to include. Defaults to ${CAPS.snapshotElements}.`,
  }),
  offset: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))).annotate({
    description: "Skip the first N controls. Use offset plus the previous limit to page through a truncated snapshot.",
  }),
  mode: Schema.optional(Schema.Literals(["full", "diff"])).annotate({
    description:
      "full (default) returns every visible control. diff returns only the controls that changed since sinceGeneration, plus unchangedCount, which keeps multi-step loops small.",
  }),
  sinceGeneration: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))).annotate({
    description:
      "Generation of a snapshot you already hold, reported earlier as generation. mode diff uses it as the baseline; mode full re-reads that generation from this session instead of observing again.",
  }),
})

type Element = {
  id?: string
  ref?: string
  reference?: { elementId?: string; id?: string }
  role?: string
  name?: string
  accessibleName?: string
  label?: string
  text?: string
  value?: unknown
  description?: string
  states?: string[]
  actions?: string[]
  bounds?: { x: number; y: number; width: number; height: number }
  /** Provider-reported focus point for this element, when it knows one. */
  focusPoint?: unknown
  /** Provider-reported preferred click point for this element. */
  aimHint?: unknown
  metadata?: Record<string, unknown>
}

type Warning = string | { elementRef: string; reason: string }

type ObservationResponse = {
  ok: true
  observation: {
    id: string
    elements?: Element[]
    warnings?: string[]
  }
}

type SnapshotMode = "full" | "diff"

type ProjectedElement = { element: Record<string, unknown>; warnings: Warning[] }

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

const WARNINGS_MAX = 20

function projectionWarning(entries: Warning[]): { warnings: Warning[]; truncated: boolean } {
  if (entries.length <= WARNINGS_MAX) return { warnings: entries, truncated: false }
  return { warnings: entries.slice(0, WARNINGS_MAX), truncated: true }
}

function pointOf(raw: unknown): { x: number; y: number } | undefined {
  if (typeof raw !== "object" || raw === null) return undefined
  const x = (raw as { x?: unknown }).x
  const y = (raw as { y?: unknown }).y
  if (typeof x !== "number" || !Number.isFinite(x) || typeof y !== "number" || !Number.isFinite(y)) return undefined
  return { x, y }
}

function hintPointOf(element: Element): { x: number; y: number } | undefined {
  return pointOf(element.aimHint) ?? pointOf(element.metadata?.aimHint)
}

function focusPointOf(element: Element): { x: number; y: number } | undefined {
  return pointOf(element.focusPoint) ?? pointOf(element.metadata?.focusPoint)
}

function refLabel(element: Element): string {
  const ref = refOf(element)
  if (ref !== undefined) return ref
  const role = element.role ?? "element"
  const name = element.name ?? element.accessibleName ?? element.label ?? element.text
  return name === undefined ? role : `${role} ${name}`
}

function valueOf(element: Element): string | undefined {
  if (element.value === undefined) return undefined
  return typeof element.value === "string" ? element.value : JSON.stringify(element.value)
}

// The window controls reach the snapshot as a generic "button" named after the
// control, so the name is the only metadata that identifies the title-bar role
// (aim.ts owns what that role means). Minimize can sit 9px from Close inside one
// group, so a named window control is never aimed at the middle of its box.
const WINDOW_CONTROL = /\b(closebutton|close|minimizebutton|minimize|maximizebutton|maximize|restorebutton|restore)\b/

function windowControlRole(element: Element): string | undefined {
  const name = (element.name ?? element.accessibleName ?? element.label ?? "").toLowerCase()
  return name.match(WINDOW_CONTROL)?.[1]
}

/**
 * Aim point for one actionable element. A provider hint and a focus point
 * always win, a named window control is aimed at the edge of its box that faces
 * the window content, and a bounds-center result is a recorded guess that
 * always raises a warning, so nothing silently center-clicks
 * (docs/computer-use-reliability.md rule 2).
 */
function aimOf(element: Element): { aim?: Record<string, unknown>; warnings: Warning[] } {
  const bounds = element.bounds
  if (bounds === undefined) {
    return { warnings: [{ elementRef: refLabel(element), reason: "no-bounds" }] }
  }
  const control = windowControlRole(element)
  const aim = computeAim({
    bounds,
    role: control ?? element.role,
    focusPoint: focusPointOf(element),
    aimHint: hintPointOf(element),
  })
  // computeAim insets a window control inside its own box, which says nothing
  // about the title-bar group it shares with the frame and its neighbours. The
  // control name is what carries that, so the point becomes the box edge facing
  // the window content, while the strategy and the vertical centre stay the
  // ones computeAim resolved: role-inset means the role, not the name, decided
  // the point, and a hint or a focus point keeps the point it already gave.
  const x = control === undefined || aim.strategy !== "role-inset" ? aim.x : bounds.x
  return {
    aim: { x, y: aim.y, strategy: aim.strategy },
    warnings: isCenterGuess(aim) ? [{ elementRef: refLabel(element), reason: "center-guess" }] : [],
  }
}

function projectElement(element: Element): ProjectedElement {
  const value = valueOf(element)
  const actions = element.actions ?? []
  const aimed = actions.length > 0 ? aimOf(element) : { warnings: [] as Warning[] }
  return {
    element: {
      ...(refOf(element) === undefined ? {} : { ref: refOf(element) }),
      ...(element.role === undefined ? {} : { role: element.role }),
      ...(element.name === undefined ? {} : { name: element.name }),
      ...(element.accessibleName === undefined ? {} : { accessibleName: element.accessibleName }),
      ...(element.label === undefined ? {} : { label: element.label }),
      ...(element.text === undefined ? {} : { text: element.text }),
      ...(value === undefined ? {} : { value }),
      ...(element.description === undefined ? {} : { description: element.description }),
      ...(element.states === undefined || element.states.length === 0 ? {} : { states: element.states }),
      ...(actions.length === 0 ? {} : { actions }),
      ...(element.bounds === undefined
        ? {}
        : {
            bounds: {
              x: element.bounds.x,
              y: element.bounds.y,
              width: element.bounds.width,
              height: element.bounds.height,
            },
          }),
      ...(applicationOfElement(element) === undefined ? {} : { application: applicationOfElement(element) }),
      ...(aimed.aim === undefined ? {} : { aim: aimed.aim }),
    },
    warnings: aimed.warnings,
  }
}

function projectWindow(element: Element): Record<string, unknown> {
  return {
    ...(refOf(element) === undefined ? {} : { ref: refOf(element) }),
    ...(element.name === undefined ? {} : { name: element.name }),
    ...(applicationOfElement(element) === undefined ? {} : { application: applicationOfElement(element) }),
    focused: (element.states ?? []).includes("focused"),
    ...(element.bounds === undefined
      ? {}
      : {
          bounds: {
            x: element.bounds.x,
            y: element.bounds.y,
            width: element.bounds.width,
            height: element.bounds.height,
          },
        }),
    ...(element.states === undefined || element.states.length === 0 ? {} : { states: element.states }),
  }
}

function isControl(element: Element): boolean {
  return element.role !== "window" && element.role !== "application"
}

function scopeOf(app: string | undefined, window: string | undefined): string {
  return `${app ?? "*"}\n${window ?? "*"}`
}

function projectChange(entry: ComputerElementDiffEntry<Element>): ProjectedElement {
  const projected = projectElement(entry.element)
  return { element: { change: entry.change, ...projected.element }, warnings: projected.warnings }
}

function projectWindowChange(entry: ComputerElementDiffEntry<Element>): Record<string, unknown> {
  return { change: entry.change, role: "window", ...projectWindow(entry.element) }
}

type Rendered = { text: string; truncated: boolean; returned: number; warnings: Warning[] }

type RenderInput = {
  observationId: string
  application: string
  offset: number
  limit: number
  total: number
  focusedRef: string | undefined
  controls: readonly ProjectedElement[]
  windows: readonly Record<string, unknown>[]
  listed: readonly Warning[]
  more: boolean
  shrunk: boolean
  generation: number
  mode: SnapshotMode
  source: "observation" | "cache"
  sinceGeneration?: number
  unchangedCount?: number
}

function renderSnapshot(input: RenderInput): Rendered {
  const capped = projectionWarning([...input.listed, ...input.controls.flatMap((entry) => entry.warnings)])
  const truncated = capped.truncated || input.more || input.shrunk
  return {
    truncated,
    returned: input.controls.length,
    warnings: capped.warnings,
    text: JSON.stringify({
      observationId: input.observationId,
      application: input.application,
      generation: input.generation,
      mode: input.mode,
      source: input.source,
      ...(input.sinceGeneration === undefined ? {} : { sinceGeneration: input.sinceGeneration }),
      ...(input.unchangedCount === undefined ? {} : { unchangedCount: input.unchangedCount }),
      totalElements: input.total,
      returnedElements: input.controls.length,
      offset: input.offset,
      limit: input.limit,
      truncated,
      focusedRef: input.focusedRef,
      windows: input.windows,
      elements: input.controls.map((entry) => entry.element),
      warnings: capped.warnings,
    }),
  }
}

/** The payload caps are hard: a snapshot that would exceed them is trimmed. */
function renderWithinCap(input: RenderInput): Rendered {
  let controls = input.controls
  let shrunk = false
  let rendered = renderSnapshot({ ...input, controls, shrunk })
  while (rendered.text.length > CAPS.snapshotChars && controls.length > 0) {
    controls = controls.slice(0, Math.floor(controls.length / 2))
    shrunk = true
    rendered = renderSnapshot({ ...input, controls, shrunk })
  }
  return rendered
}

function controlsOf(elements: readonly Element[]): Element[] {
  return elements.filter(isControl)
}

function windowsOf(elements: readonly Element[]): Element[] {
  return elements.filter((element) => element.role === "window")
}

function focusedRefOf(elements: readonly Element[]): string | undefined {
  return refOf(elements.find((element) => (element.states ?? []).includes("focused")) ?? {})
}

function fullRenderInput(input: {
  observationId: string
  generation: number
  source: "observation" | "cache"
  application: string
  offset: number
  limit: number
  sinceGeneration?: number
  elements: readonly Element[]
  listed: readonly Warning[]
}): RenderInput {
  const controls = controlsOf(input.elements)
  const page = controls.slice(input.offset, input.offset + input.limit)
  return {
    observationId: input.observationId,
    application: input.application,
    offset: input.offset,
    limit: input.limit,
    total: controls.length,
    focusedRef: focusedRefOf(input.elements),
    controls: page.map(projectElement),
    windows: windowsOf(input.elements).map(projectWindow),
    listed: input.listed,
    more: controls.length > input.offset + page.length,
    shrunk: false,
    generation: input.generation,
    mode: "full",
    source: input.source,
    ...(input.sinceGeneration === undefined ? {} : { sinceGeneration: input.sinceGeneration }),
  }
}

export const ComputerSnapshotTool = Tool.define<typeof Parameters, Record<string, unknown>, HttpClient.HttpClient>(
  "computer_snapshot",
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
          const limit = params.limit ?? CAPS.snapshotElements
          const offset = params.offset ?? 0
          const requested: SnapshotMode = params.mode ?? "full"
          yield* ctx.ask({
            permission: "computer",
            patterns: [`snapshot:${app ?? "*"}`],
            always: ["snapshot", "snapshot:*"],
            metadata: { operation: "snapshot", application: app ?? "desktop" },
          })
          const computer = yield* computerId(http, config, ctx.sessionID)
          const scope = scopeOf(app, window)
          const notes: string[] = []
          const held =
            params.sinceGeneration === undefined ? undefined : observationFor(computer, params.sinceGeneration)
          if (held !== undefined && held.scope !== scope) {
            notes.push(
              `generation ${held.generation} was observed for a different scope, so it is not a baseline for this snapshot.`,
            )
          }
          // A diff baseline is the generation the caller named, or the newest
          // generation this session holds when it named none. A baseline the
          // session no longer holds is never silently rebound to another tree.
          const baseline =
            requested === "diff"
              ? held?.scope === scope
                ? held
                : params.sinceGeneration === undefined
                  ? latestObservation(computer, scope)
                  : undefined
              : undefined
          if (requested === "diff" && baseline === undefined) {
            notes.push(
              params.sinceGeneration === undefined
                ? "diff mode found no earlier generation for this scope in this session, so a full snapshot was returned."
                : `generation ${params.sinceGeneration} is not held for this scope any more, so a full snapshot was returned.`,
            )
          }
          const deliver = (input: { title: string; text: string; metadata: Record<string, unknown> }) =>
            Effect.gen(function* () {
              yield* ctx.metadata({ title: input.title, metadata: {} })
              return { title: input.title, output: input.text, metadata: input.metadata }
            })
          const fullResult = (input: {
            observationId: string
            generation: number
            source: "observation" | "cache"
            sinceGeneration?: number
            elements: readonly Element[]
            listed: readonly Warning[]
          }) => {
            const rendered = renderWithinCap(
              fullRenderInput({
                observationId: input.observationId,
                generation: input.generation,
                source: input.source,
                application: app ?? "desktop",
                offset,
                limit,
                ...(input.sinceGeneration === undefined ? {} : { sinceGeneration: input.sinceGeneration }),
                elements: input.elements,
                listed: input.listed,
              }),
            )
            const controls = controlsOf(input.elements)
            const title = `Snapshot ${app ?? "desktop"} (${rendered.returned}/${controls.length} controls)`
            const note = rendered.truncated
              ? `\n… snapshot truncated: re-run with offset=${offset + rendered.returned} or narrow with app/window for the rest.`
              : ""
            return {
              title,
              text: `${rendered.text}${note}`,
              metadata: {
                observationId: input.observationId,
                application: app ?? "desktop",
                generation: input.generation,
                mode: "full",
                source: input.source,
                ...(input.sinceGeneration === undefined ? {} : { sinceGeneration: input.sinceGeneration }),
                elementCount: controls.length,
                returned: rendered.returned,
                truncated: rendered.truncated,
                warnings: rendered.warnings,
              },
            }
          }
          // A full read of a generation the session already holds is served from
          // the cache: paging must not mix two trees, and a re-read of a held
          // generation must not cost another observation.
          if (requested === "full" && held !== undefined && held.scope === scope) {
            return yield* deliver(
              fullResult({
                observationId: held.observationId,
                generation: held.generation,
                source: "cache",
                sinceGeneration: held.generation,
                elements: held.elements as Element[],
                // The cached tree is the untyped JSON the server sent, already
                // validated by ObservationEnvelope on its way in.
                listed: [...held.warnings, ...notes],
              }),
            )
          }
          const result = yield* request<ObservationResponse>(
            http,
            config,
            "POST",
            `/v1/computers/${computer}/observe`,
            {
              ...(app === undefined ? {} : { applicationId: app }),
              ...(window === undefined ? {} : { window }),
            },
            { validate: Schema.is(ObservationEnvelope) },
          )
          const observation = result.observation
          const elements = observation.elements ?? []
          const record = rememberObservation(computer, scope, observation.id, observation.warnings ?? [], elements)
          const controls = controlsOf(elements)
          // A note about the read itself leads, so the warning cap cannot hide it.
          const listed: Warning[] = [...notes, ...(observation.warnings ?? [])]
          const shared = {
            observationId: observation.id,
            application: app ?? "desktop",
            offset,
            limit,
            total: controls.length,
            focusedRef: focusedRefOf(elements),
            listed,
          }
          if (baseline === undefined) {
            return yield* deliver(
              fullResult({
                observationId: observation.id,
                generation: record.generation,
                source: "observation",
                ...(params.sinceGeneration === undefined ? {} : { sinceGeneration: params.sinceGeneration }),
                elements,
                listed,
              }),
            )
          }
          const before = baseline.elements as Element[]
          // The baseline is the untyped JSON the server sent, already validated
          // by ObservationEnvelope on its way in. The projection itself is owned
          // by omnia, where the observations are produced and tested.
          const diff = diffComputerElements(before, elements)
          const changed = diff.controls.map(projectChange)
          const pageLength = Math.max(0, Math.min(limit, changed.length - offset))
          const diffInput: RenderInput = {
            ...shared,
            controls: changed.slice(offset, offset + limit),
            windows: diff.windows.map(projectWindowChange),
            more: changed.length > offset + pageLength,
            shrunk: false,
            generation: record.generation,
            mode: "diff",
            source: "observation",
            unchangedCount: diff.unchangedCount,
            sinceGeneration: baseline.generation,
          }
          const rawDiff = renderSnapshot(diffInput)
          const rawFull = renderSnapshot(
            fullRenderInput({
              observationId: observation.id,
              generation: record.generation,
              source: "observation",
              application: app ?? "desktop",
              offset,
              limit,
              sinceGeneration: baseline.generation,
              elements,
              listed,
            }),
          )
          // A diff only pays when it is smaller than reading the whole tree, and
          // it never gets to be larger than the char cap either. The warning
          // leads so the warning cap cannot hide it.
          if (
            computerDiffFallsBack({
              diffChars: rawDiff.text.length,
              fullChars: rawFull.text.length,
              cap: CAPS.snapshotChars,
            })
          ) {
            return yield* deliver(
              fullResult({
                observationId: observation.id,
                generation: record.generation,
                source: "observation",
                sinceGeneration: baseline.generation,
                elements,
                listed: ["the diff was larger than a full snapshot, so a full snapshot was returned.", ...listed],
              }),
            )
          }
          const rendered = renderWithinCap(diffInput)
          const title = `Snapshot ${app ?? "desktop"} (diff since ${baseline.generation}: ${changed.length} changed, ${diff.unchangedCount} unchanged)`
          const note = rendered.truncated
            ? `\n… diff truncated: re-run with offset=${offset + rendered.returned} or ask for a full snapshot with mode="full" for the rest.`
            : ""
          return yield* deliver({
            title,
            text: `${rendered.text}${note}`,
            metadata: {
              observationId: observation.id,
              application: app ?? "desktop",
              generation: record.generation,
              mode: "diff",
              source: "observation",
              sinceGeneration: baseline.generation,
              unchangedCount: diff.unchangedCount,
              elementCount: controls.length,
              returned: rendered.returned,
              truncated: rendered.truncated,
              warnings: rendered.warnings,
            },
          })
        }),
    }
  }),
)
