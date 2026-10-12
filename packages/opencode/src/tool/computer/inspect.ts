import { Effect, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import { computeAim, isCenterGuess, type Aim } from "@opencode-ai/omnia/computer-use/aim"
import { describeAimRisk } from "@opencode-ai/omnia/computer-use/window-safety"
import * as Tool from "../tool"
import DESCRIPTION from "./inspect.txt"
import { ActionEnvelope, ObservationEnvelope, configFromEnv, computerId, request } from "./client"
import type { OmniaServerConfig } from "./client"
import { CAPS, clipLines, renderFailure } from "./output"

export const Parameters = Schema.Struct({
  target: Schema.optional(Schema.String).annotate({
    description: "Element ID from computer_find or computer_observe.",
  }),
  query: Schema.optional(Schema.String).annotate({
    description: "Control to inspect by meaning, for example 'Export button'.",
  }),
  role: Schema.optional(Schema.String).annotate({ description: "Optional role filter for query." }),
  observationId: Schema.optional(Schema.String).annotate({
    description: "Observation the target came from, for staleness checking.",
  }),
})

type Bounds = { x: number; y: number; width: number; height: number }

type InspectElement = {
  id?: string
  role?: string
  name?: string
  description?: string
  text?: string
  value?: unknown
  states?: string[]
  actions?: string[]
  bounds?: Bounds
  center?: { x: number; y: number }
  application?: string
  source?: string
}

type InspectResponse = {
  ok: boolean
  result: {
    success: boolean
    message?: string
    metadata?: {
      element?: InspectElement
      ancestors?: Array<{ id?: string; role?: string; name?: string }>
      children?: Array<{ id?: string; role?: string; name?: string; states?: string[]; actions?: string[] }>
    }
    error?: { code?: string; message: string }
  }
}

type ObservationElement = {
  id?: string
  ref?: string
  role?: string
  name?: string
  bounds?: Bounds
  parentId?: string
  states?: string[]
  metadata?: Record<string, unknown>
}

type ObservationResponse = {
  ok: true
  observation: { id: string; elements?: ObservationElement[] }
}

/** Where the inspected control lives, so a ref can be acted on in context. */
type Context = {
  parentRef?: string
  window?: { ref?: string; title: string; application?: string; bounds?: Bounds }
}

function elementRef(element: { id?: string; ref?: string }): string | undefined {
  return element.id ?? element.ref
}

// The point the runtime aims at, resolved from the control's own metadata;
// bounds-center means the control offered nothing better than its box.
function aimOf(element: InspectElement): Aim | undefined {
  if (element.bounds === undefined) return undefined
  return computeAim({ bounds: element.bounds, role: element.role })
}

function isWindow(element: ObservationElement): boolean {
  const role = (element.role ?? "").toLowerCase()
  return role === "window" || role === "frame"
}

function areaOf(bounds: Bounds | undefined): number {
  return bounds === undefined ? Number.MAX_SAFE_INTEGER : bounds.width * bounds.height
}

function contains(bounds: Bounds | undefined, point: { x: number; y: number }): boolean {
  if (bounds === undefined) return false
  return point.x >= bounds.x && point.x <= bounds.x + bounds.width && point.y >= bounds.y && point.y <= bounds.y + bounds.height
}

// The window that owns the control: the ref the observation reports first,
// then the smallest window whose bounds contain the control, then the only
// window there is. Unknown stays unknown instead of guessing a window.
function windowOf(
  observed: ObservationElement | undefined,
  element: InspectElement,
  windows: readonly ObservationElement[],
): Context["window"] {
  const windowRef = observed?.metadata?.windowRef
  const byRef =
    typeof windowRef === "string" && windowRef.length > 0
      ? windows.find((window) => elementRef(window) === windowRef)
      : undefined
  const bounds = observed?.bounds ?? element.bounds
  const containing =
    bounds === undefined
      ? []
      : windows
          .filter((window) => contains(window.bounds, { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }))
          .sort((left, right) => areaOf(left.bounds) - areaOf(right.bounds))
  const window = byRef ?? containing[0] ?? (windows.length === 1 ? windows[0] : undefined)
  if (window === undefined) return undefined
  const application = window.metadata?.application
  return {
    ...(elementRef(window) === undefined ? {} : { ref: elementRef(window) }),
    title: window.name ?? "window",
    ...(window.bounds === undefined ? {} : { bounds: window.bounds }),
    ...(typeof application !== "string" ? {} : { application }),
  }
}

// The deep-dive answer names the control but not the window it sits in, so one
// observation is fetched for the window title and bounds and the parent ref.
// A failed observation degrades that context instead of failing the inspect.
function controlContext(
  http: HttpClient.HttpClient,
  config: OmniaServerConfig,
  id: string,
  element: InspectElement,
): Effect.Effect<Context | undefined> {
  const ref = elementRef(element)
  if (ref === undefined) return Effect.succeed(undefined)
  return request<ObservationResponse>(http, config, "POST", `/v1/computers/${id}/observe`).pipe(
    Effect.map((response) => {
      const elements = response.observation.elements ?? []
      const observed = elements.find((entry) => elementRef(entry) === ref)
      const windows = elements.filter(isWindow)
      const window = windowOf(observed, element, windows)
      const parentRef = observed?.parentId
      if (parentRef === undefined && window === undefined) return undefined
      return { ...(parentRef === undefined ? {} : { parentRef }), ...(window === undefined ? {} : { window }) }
    }),
    Effect.catchCause(() => Effect.succeed(undefined)),
  )
}

export const ComputerInspectTool = Tool.define<typeof Parameters, Record<string, unknown>, HttpClient.HttpClient>(
  "computer_inspect",
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const config = yield* configFromEnv()
          if (!params.target && !params.query) throw new Error("Inspect requires target or query.")
          yield* ctx.ask({
            permission: "computer",
            patterns: [`inspect:${params.target ?? params.query ?? "element"}`],
            always: ["inspect:*"],
            metadata: { operation: "inspect", target: params.target, query: params.query },
          })
          const id = yield* computerId(http, config, ctx.sessionID)
          const result = yield* request<InspectResponse>(
            http,
            config,
            "POST",
            `/v1/computers/${id}/actions`,
            {
              action: "inspect",
              ...(params.target === undefined
                ? {}
                : {
                    target: {
                      elementId: params.target,
                      ...(params.observationId === undefined ? {} : { observationId: params.observationId }),
                    },
                  }),
              ...(params.observationId === undefined ? {} : { observationId: params.observationId }),
              ...(params.query === undefined ? {} : { query: params.query }),
              ...(params.role === undefined ? {} : { role: params.role }),
              approve: true,
              approvedBy: `session:${ctx.sessionID}`,
              approvedScopes: ["UI_READ"],
              sessionId: ctx.sessionID,
            },
            { validate: Schema.is(ActionEnvelope) },
          )
          const outcome = result.result
          if (!outcome.success) {
            const title = "Inspect failed"
            yield* ctx.metadata({ title, metadata: {} })
            return {
              title,
              output: renderFailure(outcome.error, outcome.message ?? "The control could not be inspected."),
              metadata: { success: false, error: outcome.error?.code },
            }
          }
          const element = outcome.metadata?.element ?? {}
          const label = element.name ?? element.text ?? element.id ?? "element"
          const title = `${element.role ?? "Element"} "${label}"`
          yield* ctx.metadata({ title, metadata: {} })
          const lines: string[] = [`${element.role ?? "element"} "${label}"`]
          if (element.id !== undefined) lines.push(`id: ${element.id}`)
          if (element.application !== undefined) lines.push(`application: ${element.application}`)
          if (element.description !== undefined) lines.push(`description: ${element.description}`)
          if (element.text !== undefined) lines.push(`text: ${element.text}`)
          if (element.value !== undefined)
            lines.push(`value: ${typeof element.value === "string" ? element.value : JSON.stringify(element.value)}`)
          if (element.states !== undefined && element.states.length > 0)
            lines.push(`states: ${element.states.join(", ")}`)
          if (element.actions !== undefined && element.actions.length > 0)
            lines.push(`actions: ${element.actions.join(", ")}`)
          if (element.bounds !== undefined) {
            lines.push(
              `bounds: x=${element.bounds.x} y=${element.bounds.y} ${element.bounds.width}x${element.bounds.height}${element.center === undefined ? "" : ` center: ${element.center.x},${element.center.y}`}`,
            )
          }
          const aim = aimOf(element)
          if (aim !== undefined) {
            lines.push(
              `aim: ${aim.x},${aim.y} (${aim.strategy})${isCenterGuess(aim) ? " — guess: do not trust this point, re-resolve" : ""}`,
            )
          }
          const context = yield* controlContext(http, config, id, element)
          if (context?.parentRef !== undefined) lines.push(`parent: ${context.parentRef}`)
          if (context?.window !== undefined) {
            const window = context.window
            const bounds =
              window.bounds === undefined
                ? ""
                : ` @${window.bounds.x},${window.bounds.y} ${window.bounds.width}x${window.bounds.height}`
            lines.push(
              `window: "${window.title}"${window.application === undefined ? "" : ` (${window.application})`}${bounds}${window.ref === undefined ? "" : ` ref=${window.ref}`}`,
            )
          }
          if (aim !== undefined) {
            const risk = describeAimRisk(aim)
            if (risk !== undefined) lines.push(`risk: ${risk}`)
          }
          if (element.source !== undefined) lines.push(`source: ${element.source}`)
          const ancestors = outcome.metadata?.ancestors ?? []
          if (ancestors.length > 0) {
            lines.push(
              `ancestors: ${ancestors.map((entry) => `${entry.role ?? "?"} "${entry.name ?? entry.id ?? ""}"`).join(" > ")}`,
            )
          }
          const children = outcome.metadata?.children ?? []
          if (children.length > 0) {
            lines.push(`children (${children.length}):`)
            lines.push(
              ...clipLines(
                children.map((child) => {
                  const childLabel = child.name ?? child.id ?? ""
                  const childActions =
                    child.actions === undefined || child.actions.length === 0
                      ? ""
                      : ` actions=${child.actions.join(",")}`
                  return `- ${child.role ?? "element"} "${childLabel}"${childActions}`
                }),
                CAPS.inspectChildren,
              ),
            )
          }
          return {
            title,
            output: lines.join("\n"),
            metadata: {
              success: true,
              ...outcome.metadata,
              ...(aim === undefined ? {} : { aim }),
              ...(context?.parentRef === undefined ? {} : { parentRef: context.parentRef }),
              ...(context?.window === undefined ? {} : { window: context.window }),
            },
          }
        }),
    }
  }),
)
