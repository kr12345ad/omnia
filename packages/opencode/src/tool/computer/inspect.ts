import { Effect, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import * as Tool from "../tool"
import DESCRIPTION from "./inspect.txt"
import { ActionEnvelope, configFromEnv, computerId, request } from "./client"
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

type InspectResponse = {
  ok: boolean
  result: {
    success: boolean
    message?: string
    metadata?: {
      element?: {
        id?: string
        role?: string
        name?: string
        description?: string
        text?: string
        value?: unknown
        states?: string[]
        actions?: string[]
        bounds?: { x: number; y: number; width: number; height: number }
        center?: { x: number; y: number }
        application?: string
        source?: string
      }
      ancestors?: Array<{ id?: string; role?: string; name?: string }>
      children?: Array<{ id?: string; role?: string; name?: string; states?: string[]; actions?: string[] }>
    }
    error?: { code?: string; message: string }
  }
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
          return { title, output: lines.join("\n"), metadata: { success: true, ...outcome.metadata } }
        }),
    }
  }),
)
