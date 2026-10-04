import { Effect, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import * as Tool from "../tool"
import DESCRIPTION from "./apps.txt"
import { configFromEnv, computerId, request } from "./client"

export const Parameters = Schema.Struct({})

type AppsResponse = {
  ok: true
  observation: {
    id: string
    elements?: Array<{
      id?: string
      role?: string
      name?: string
      states?: string[]
      metadata?: Record<string, unknown>
    }>
    warnings?: string[]
  }
}

export const ComputerAppsTool = Tool.define<typeof Parameters, Record<string, unknown>, HttpClient.HttpClient>(
  "computer_apps",
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (_params, ctx) =>
        Effect.gen(function* () {
          const config = yield* configFromEnv()
          yield* ctx.ask({
            permission: "computer",
            patterns: ["apps"],
            always: ["apps"],
            metadata: { operation: "apps" },
          })
          const id = yield* computerId(http, config)
          const result = yield* request<AppsResponse>(http, config, "POST", `/v1/computers/${id}/observe`, {})
          const windows = (result.observation.elements ?? []).filter((element) => element.role === "window")
          if (windows.length === 0) {
            const title = "No open applications"
            yield* ctx.metadata({ title, metadata: {} })
            return { title, output: "No open application windows were reported.", metadata: { applications: 0 } }
          }
          const byApplication = new Map<string, Array<{ name: string; focused: boolean }>>()
          for (const window of windows) {
            const app =
              typeof window.metadata?.application === "string" && window.metadata.application.length > 0
                ? window.metadata.application
                : "unknown"
            const entries = byApplication.get(app) ?? []
            entries.push({
              name: window.name ?? window.id ?? "window",
              focused: (window.states ?? []).includes("focused"),
            })
            byApplication.set(app, entries)
          }
          const lines = [...byApplication].flatMap(([app, entries]) => [
            `- ${app}: ${entries.length} window${entries.length === 1 ? "" : "s"}`,
            ...entries.map((entry) => `  - ${entry.name}${entry.focused ? " (focused)" : ""}`),
          ])
          const title = `${byApplication.size} open application${byApplication.size === 1 ? "" : "s"}`
          yield* ctx.metadata({ title, metadata: {} })
          return {
            title,
            output: [...lines, ...(result.observation.warnings ?? []).map((warning) => `warning: ${warning}`)].join(
              "\n",
            ),
            metadata: {
              applications: byApplication.size,
              windows: windows.length,
              observationId: result.observation.id,
            },
          }
        }),
    }
  }),
)
