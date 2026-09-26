import { Effect, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import * as Tool from "../tool"
import DESCRIPTION from "./read.txt"
import { configFromEnv, computerId, request } from "./client"

export const Parameters = Schema.Struct({
  target: Schema.optional(Schema.String).annotate({ description: "Element ID to read, for example atspi:1.1.0.0.0." }),
  query: Schema.optional(Schema.String).annotate({
    description: "Surface to read by meaning, for example 'document text' or 'Find field'.",
  }),
  role: Schema.optional(Schema.String).annotate({ description: "Optional role filter for query." }),
  window: Schema.optional(Schema.String).annotate({
    description: "Window title fragment; reads the application that owns that window.",
  }),
  app: Schema.optional(Schema.String).annotate({ description: "Application name to read, for example soffice." }),
  limit: Schema.optional(Schema.Number).annotate({ description: "Maximum characters to return. Defaults to 200000." }),
})

type ReadResponse = {
  ok: boolean
  result: {
    success: boolean
    message?: string
    text?: string
    length?: number
    hash?: string
    metadata?: { preview?: string; length?: number; hash?: string }
    error?: { code?: string; message: string }
  }
}

export const ComputerReadTool = Tool.define<typeof Parameters, Record<string, unknown>, HttpClient.HttpClient>(
  "computer_read",
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const config = yield* configFromEnv()
          if (!params.target && !params.query && !params.window && !params.app) {
            throw new Error("Reading text requires a target, query, window, or app.")
          }
          yield* ctx.ask({
            permission: "computer",
            patterns: [`read:${params.target ?? params.query ?? params.window ?? params.app ?? "desktop"}`],
            always: ["*"],
            metadata: { operation: "read_text", query: params.query, target: params.target },
          })
          const id = yield* computerId(http, config)
          const result = yield* request<ReadResponse>(http, config, "POST", `/v1/computers/${id}/actions`, {
            action: "read_text",
            ...(params.target === undefined
              ? {}
              : { target: { elementId: params.target } }),
            ...(params.query === undefined ? {} : { query: params.query }),
            ...(params.role === undefined ? {} : { role: params.role }),
            ...(params.window === undefined ? {} : { window: params.window }),
            ...(params.app === undefined ? {} : { app: params.app }),
            ...(params.limit === undefined ? {} : { limit: params.limit }),
            approve: true,
            approvedBy: `session:${ctx.sessionID}`,
            approvedScopes: ["UI_READ"],
            sessionId: ctx.sessionID,
          })
          const outcome = result.result
          if (!outcome.success) {
            const title = "Text read failed"
            yield* ctx.metadata({ title, metadata: {} })
            return {
              title,
              output: outcome.error?.message ?? outcome.message ?? "The surface did not expose text.",
              metadata: { success: false, error: outcome.error?.code },
            }
          }
          const text = outcome.text ?? outcome.metadata?.preview ?? ""
          const length = outcome.length ?? outcome.metadata?.length ?? text.length
          const hash = outcome.hash ?? outcome.metadata?.hash
          const title = `Read ${length} characters${hash ? ` (hash ${hash})` : ""}`
          yield* ctx.metadata({ title, metadata: {} })
          return {
            title,
            output: `${text}\n\n[length=${length}${hash ? ` hash=${hash}` : ""}]`,
            metadata: { success: true, length, hash },
          }
        }),
    }
  }),
)
