import { Effect, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import * as Tool from "../tool"
import DESCRIPTION from "./find.txt"
import { configFromEnv, computerId, request } from "./client"

export const Parameters = Schema.Struct({
  query: Schema.String.annotate({ description: "What to look for, for example Export button." }),
  role: Schema.optional(Schema.String).annotate({
    description: "Control kind filter: button, textbox, menuitem, link, checkbox, window, dialog.",
  }),
  window: Schema.optional(Schema.String).annotate({
    description: "Window title or application fragment; restricts matches to that window.",
  }),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))).annotate({
    description: "Maximum candidates to return. Defaults to 5.",
  }),
})

type Element = {
  id?: string
  role?: string
  name?: string
  text?: string
  description?: string
  value?: unknown
  states?: string[]
  actions?: string[]
  bounds?: { x: number; y: number; width: number; height: number }
  metadata?: Record<string, unknown>
}

type Candidate = {
  element: Element
  reference?: { elementId?: string; observationId?: string }
  score: number
  reason?: string
}

type FindResponse = {
  ok: true
  result: {
    query?: string
    matches?: Candidate[]
    results?: Candidate[]
    observation?: { id?: string }
    truncated?: boolean
  }
}

function elementRef(candidate: Candidate): string {
  return candidate.reference?.elementId ?? candidate.element.id ?? "?"
}

function describe(candidate: Candidate): string {
  const element = candidate.element
  const label = element.name ?? element.text ?? element.id ?? "element"
  const bounds = element.bounds
  const at =
    bounds === undefined
      ? ""
      : ` at ${Math.round(bounds.x + bounds.width / 2)},${Math.round(bounds.y + bounds.height / 2)}`
  const value =
    element.value === undefined
      ? ""
      : ` value="${(typeof element.value === "string" ? element.value : JSON.stringify(element.value)).slice(0, 40)}"`
  const states = element.states === undefined || element.states.length === 0 ? "" : ` [${element.states.join(", ")}]`
  const actions =
    element.actions === undefined || element.actions.length === 0 ? "" : ` actions=${element.actions.join(",")}`
  const description = element.description === undefined ? "" : ` — ${element.description.slice(0, 80)}`
  const observation =
    candidate.reference?.observationId === undefined ? "" : ` observation=${candidate.reference.observationId}`
  return `${element.role ?? "unknown"} "${label}" id=${elementRef(candidate)}${at}${value}${states}${actions} confidence=${candidate.score.toFixed(2)}${observation}${description}`
}

export const ComputerFindTool = Tool.define<typeof Parameters, Record<string, unknown>, HttpClient.HttpClient>(
  "computer_find",
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const config = yield* configFromEnv()
          yield* ctx.ask({
            permission: "computer",
            patterns: [`find:${params.query}`],
            always: ["find:*"],
            metadata: { operation: "find", query: params.query, role: params.role ?? "any" },
          })
          const id = yield* computerId(http, config)
          const result = yield* request<FindResponse>(http, config, "POST", `/v1/computers/${id}/find`, {
            query: params.query,
            ...(params.role === undefined ? {} : { role: params.role }),
            ...(params.window === undefined ? {} : { window: params.window }),
            limit: params.limit ?? 5,
          })
          const matches = result.result.matches ?? result.result.results ?? []
          const observationId = result.result.observation?.id
          if (matches.length === 0) {
            const title = `No match for ${params.query}`
            yield* ctx.metadata({ title, metadata: {} })
            return {
              title,
              output: `No interface control matched "${params.query}". Observe again with computer_observe; the interface may have changed.`,
              metadata: { query: params.query, matches: 0, ...(observationId === undefined ? {} : { observationId }) },
            }
          }
          const lines = matches.map((match, index) => `${index + 1}. ${describe(match)}`)
          if (result.result.truncated) lines.push("… more candidates omitted; narrow the query or role.")
          if (observationId !== undefined) {
            lines.push(`observation ${observationId}: pass it as observationId with the target to detect staleness.`)
          }
          const best = matches[0]
          const bestLabel = best.element.name ?? best.element.text ?? best.element.id ?? "element"
          const title = `Found ${bestLabel}`
          yield* ctx.metadata({ title, metadata: {} })
          return {
            title,
            output: lines.join("\n"),
            metadata: {
              query: params.query,
              matches: matches.length,
              ...(observationId === undefined ? {} : { observationId }),
              best: {
                id: elementRef(best),
                role: best.element.role,
                name: bestLabel,
                score: best.score,
                ...(best.reference?.observationId === undefined ? {} : { observationId: best.reference.observationId }),
              },
            },
          }
        }),
    }
  }),
)
