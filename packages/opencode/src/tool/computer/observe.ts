import { Effect, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import * as Tool from "../tool"
import DESCRIPTION from "./observe.txt"
import { configFromEnv, computerId, request } from "./client"

export const Parameters = Schema.Struct({
  applicationId: Schema.optional(Schema.String).annotate({
    description: "Restrict the observation to one application, for example soffice. Defaults to everything visible.",
  }),
  maxElements: Schema.optional(Schema.Number).annotate({
    description: "Maximum controls to include in the text summary. Defaults to 120.",
  }),
})

type Element = {
  id?: string
  role?: string
  name?: string
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
    text?: string
    warnings?: string[]
    metadata?: Record<string, unknown>
  }
}

function center(element: Element): string {
  const bounds = element.bounds
  if (bounds === undefined) return ""
  return ` at ${Math.round(bounds.x + bounds.width / 2)},${Math.round(bounds.y + bounds.height / 2)}`
}

function summarize(element: Element): string {
  const label = element.name ?? element.text ?? element.id ?? "element"
  const parts: string[] = []
  const value = element.value === undefined ? undefined : typeof element.value === "string" ? element.value : JSON.stringify(element.value)
  if (value !== undefined && value.length > 0) parts.push(`value="${value.slice(0, 40)}"`)
  if (element.states !== undefined && element.states.length > 0) parts.push(`[${element.states.join(", ")}]`)
  if (element.actions !== undefined && element.actions.length > 0) parts.push(`actions=${element.actions.join(",")}`)
  return `- ${element.role ?? "unknown"} "${label}"${center(element)}${parts.length === 0 ? "" : ` ${parts.join(" ")}`}`
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
          const app = params.applicationId?.trim() || undefined
          yield* ctx.ask({
            permission: "computer",
            patterns: [`observe${app ? `:${app}` : ""}`],
            always: ["*"],
            metadata: { operation: "observe", application: app ?? "desktop" },
          })
          const id = yield* computerId(http, config)
          const result = yield* request<ObservationResponse>(
            http,
            config,
            "POST",
            `/v1/computers/${id}/observe`,
            app === undefined ? {} : { applicationId: app },
          )
          const observation = result.observation
          const elements = observation.elements ?? []
          const windows = elements.filter((element) => element.role === "window")
          const focused = elements.find((element) => (element.states ?? []).includes("focused"))
          const controls = elements.filter((element) => element.role !== "window" && element.role !== "application")
          const shown = controls.slice(0, params.maxElements ?? 120)
          const applications = [
            ...new Set(
              elements
                .map((element) => element.metadata?.application)
                .filter((value): value is string => typeof value === "string" && value.length > 0),
            ),
          ]
          const lines: string[] = [`observation ${observation.id} · ${elements.length} elements`]
          if (applications.length > 0) lines.push(`applications: ${applications.join(", ")}`)
          if (windows.length > 0) {
            lines.push("windows:")
            for (const window of windows.slice(0, 12)) {
              const name = window.name ?? window.id ?? "window"
              lines.push(`- "${name}" (${String(window.metadata?.application ?? "?")})${center(window)}`)
            }
          }
          if (focused !== undefined) {
            lines.push(`focused: ${summarize(focused).slice(2)}`)
          }
          if (shown.length > 0) {
            lines.push("controls:")
            for (const element of shown) lines.push(summarize(element))
          }
          if (controls.length > shown.length) {
            lines.push(`… ${controls.length - shown.length} more controls (use computer_find to narrow)`)
          }
          for (const warning of observation.warnings ?? []) lines.push(`warning: ${warning}`)
          const title = `Observed ${app ?? "desktop"}`
          yield* ctx.metadata({ title, metadata: {} })
          return {
            title,
            output: lines.join("\n"),
            metadata: {
              observationId: observation.id,
              application: app ?? "desktop",
              elementCount: elements.length,
              warnings: observation.warnings ?? [],
            },
          }
        }),
    }
  }),
)
