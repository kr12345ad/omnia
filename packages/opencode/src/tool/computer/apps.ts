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
    elements?: Array<{ id?: string; role?: string; name?: string; states?: string[]; metadata?: Record<string, unknown> }>
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
            always: ["*"],
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
          const lines = windows.map((window) => {
            const app =
              typeof window.metadata?.application === "string" && window.metadata.application.length > 0
                ? window.metadata.application
                : "unknown"
            const focused = (window.states ?? []).includes("focused") ? " (focused)" : ""
            return `- ${app}: ${window.name ?? window.id ?? "window"}${focused}`
          })
          const title = `${windows.length} open application${windows.length === 1 ? "" : "s"}`
          yield* ctx.metadata({ title, metadata: {} })
          return {
            title,
            output: lines.join("\n"),
            metadata: { applications: windows.length, observationId: result.observation.id },
          }
        }),
    }
  }),
)
