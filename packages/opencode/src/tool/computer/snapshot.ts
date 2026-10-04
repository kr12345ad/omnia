import { Effect, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import * as Tool from "../tool"
import DESCRIPTION from "./snapshot.txt"
import { ObservationEnvelope, configFromEnv, computerId, request } from "./client"
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
  metadata?: Record<string, unknown>
}

type ObservationResponse = {
  ok: true
  observation: {
    id: string
    elements?: Element[]
    warnings?: string[]
  }
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

function projectElement(element: Element): Record<string, unknown> {
  const value =
    element.value === undefined
      ? undefined
      : typeof element.value === "string"
        ? element.value
        : JSON.stringify(element.value)
  return {
    ...(refOf(element) === undefined ? {} : { ref: refOf(element) }),
    ...(element.role === undefined ? {} : { role: element.role }),
    ...(element.name === undefined ? {} : { name: element.name }),
    ...(element.accessibleName === undefined ? {} : { accessibleName: element.accessibleName }),
    ...(element.label === undefined ? {} : { label: element.label }),
    ...(element.text === undefined ? {} : { text: element.text }),
    ...(value === undefined ? {} : { value }),
    ...(element.description === undefined ? {} : { description: element.description }),
    ...(element.states === undefined || element.states.length === 0 ? {} : { states: element.states }),
    ...(element.actions === undefined || element.actions.length === 0 ? {} : { actions: element.actions }),
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
          yield* ctx.ask({
            permission: "computer",
            patterns: [`snapshot:${app ?? "*"}`],
            always: ["snapshot", "snapshot:*"],
            metadata: { operation: "snapshot", application: app ?? "desktop" },
          })
          const id = yield* computerId(http, config)
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
          const focused = elements.find((element) => (element.states ?? []).includes("focused"))
          const controls = elements.filter((element) => element.role !== "window" && element.role !== "application")
          const page = controls.slice(offset, offset + limit)
          const fit = (entries: ReturnType<typeof projectElement>[]) => {
            let shown = entries
            let text = JSON.stringify({
              observationId: observation.id,
              application: app ?? "desktop",
              totalElements: controls.length,
              returnedElements: shown.length,
              offset,
              limit,
              truncated: true,
              focusedRef: focused === undefined ? undefined : refOf(focused),
              windows: windows.map(projectWindow),
              elements: shown,
              warnings: observation.warnings ?? [],
            })
            while (text.length > CAPS.snapshotChars && shown.length > 0) {
              shown = shown.slice(0, Math.floor(shown.length / 2))
              text = JSON.stringify({
                observationId: observation.id,
                application: app ?? "desktop",
                totalElements: controls.length,
                returnedElements: shown.length,
                offset,
                limit,
                truncated: true,
                focusedRef: focused === undefined ? undefined : refOf(focused),
                windows: windows.map(projectWindow),
                elements: shown,
                warnings: observation.warnings ?? [],
              })
            }
            return { text, shown: shown.length }
          }
          const snapshot = {
            observationId: observation.id,
            application: app ?? "desktop",
            totalElements: controls.length,
            returnedElements: page.length,
            offset,
            limit,
            truncated: controls.length > offset + page.length,
            focusedRef: focused === undefined ? undefined : refOf(focused),
            windows: windows.map(projectWindow),
            elements: page.map(projectElement),
            warnings: observation.warnings ?? [],
          }
          let text = JSON.stringify(snapshot)
          let returned = page.length
          let truncated = snapshot.truncated
          if (text.length > CAPS.snapshotChars) {
            const fitted = fit(page.map(projectElement))
            text = fitted.text
            returned = fitted.shown
            truncated = true
          }
          const title = `Snapshot ${app ?? "desktop"} (${returned}/${controls.length} controls)`
          yield* ctx.metadata({ title, metadata: {} })
          const paged = controls.length > offset + page.length
          const note =
            truncated || paged
              ? `\n… snapshot truncated: re-run with offset=${offset + returned} or narrow with app/window for the rest.`
              : ""
          return {
            title,
            output: `${text}${note}`,
            metadata: {
              observationId: observation.id,
              application: app ?? "desktop",
              elementCount: controls.length,
              returned,
              truncated: truncated || controls.length > offset + page.length,
              warnings: observation.warnings ?? [],
            },
          }
        }),
    }
  }),
)
