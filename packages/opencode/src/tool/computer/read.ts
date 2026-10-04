import { Effect, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import * as Tool from "../tool"
import DESCRIPTION from "./read.txt"
import { ActionEnvelope, configFromEnv, computerId, request } from "./client"
import { CAPS, clip, renderFailure } from "./output"
import { applicationOf } from "./policy"

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
  applicationId: Schema.optional(Schema.String).annotate({ description: "Alias for app." }),
  observationId: Schema.optional(Schema.String).annotate({
    description: "Observation the target came from, for staleness checking.",
  }),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: CAPS.readText }))).annotate({
    description: `Maximum characters in this window. Defaults to ${CAPS.readText}.`,
  }),
  offset: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: CAPS.readText }))).annotate({
    description: "Starting character offset. Use the offset a truncated read reports to continue.",
  }),
})

type ReadResponse = {
  ok: boolean
  result: {
    success: boolean
    message?: string
    text?: string
    length?: number
    hash?: string
    metadata?: { preview?: string; length?: number; hash?: string; truncated?: boolean }
    error?: { code?: string; message: string }
  }
}

type ReadParams = Schema.Schema.Type<typeof Parameters>

// The server can only return a prefix: it takes `limit` and ignores `offset`.
// A window at `offset` is fetched by asking for every character up to the end
// of that window and cutting the window out of the prefix afterwards.
function requestedLimit(params: ReadParams): number {
  return Math.min((params.offset ?? 0) + (params.limit ?? CAPS.readText), CAPS.readText)
}

// The limit that continues from `offset`: it keeps the next request inside the
// cap the server can actually return, so paging never silently stalls.
function continuingLimit(offset: number, max: number): number {
  return Math.max(1, Math.min(max, CAPS.readText - offset))
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
          const app = applicationOf(params)
          const hasSelector = [params.target, params.query, params.window, app].some(
            (value) => value !== undefined && value.trim().length > 0,
          )
          if (!hasSelector) throw new Error("Reading text requires a target, query, window, or app.")
          yield* ctx.ask({
            permission: "computer",
            patterns: [`read:${params.target ?? params.query ?? params.window ?? app ?? "desktop"}`],
            always: ["read:*"],
            metadata: { operation: "read_text", query: params.query, target: params.target },
          })
          const id = yield* computerId(http, config)
          const result = yield* request<ReadResponse>(
            http,
            config,
            "POST",
            `/v1/computers/${id}/actions`,
            {
              action: "read_text",
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
              ...(params.window === undefined ? {} : { window: params.window }),
              ...(app === undefined ? {} : { app }),
              limit: requestedLimit(params),
              approve: true,
              approvedBy: `session:${ctx.sessionID}`,
              approvedScopes: ["UI_READ"],
              sessionId: ctx.sessionID,
            },
            { validate: Schema.is(ActionEnvelope) },
          )
          const outcome = result.result
          if (!outcome.success) {
            const title = "Text read failed"
            yield* ctx.metadata({ title, metadata: {} })
            return {
              title,
              output: renderFailure(outcome.error, outcome.message ?? "The surface did not expose text."),
              metadata: { success: false, error: outcome.error?.code },
            }
          }
          const offset = params.offset ?? 0
          const max = params.limit ?? CAPS.readText
          const requested = requestedLimit(params)
          const full = outcome.text
          const preview = outcome.metadata?.preview
          const source = full ?? preview ?? ""
          const totalLength = outcome.length ?? outcome.metadata?.length ?? source.length
          const text = source.slice(offset, offset + max)
          const nextOffset = offset + text.length
          // The server honours `limit` but ignores `offset`: it returns the first
          // `limit` characters of the surface. A window that starts at `offset`
          // therefore has to be cut out of that prefix here, exactly once. It
          // reports no truncation flag of its own, so truncation is read off the
          // response instead: a source that filled the requested limit, a source
          // longer than the window, or a reported length past the payload.
          const truncated =
            outcome.metadata?.truncated === true ||
            nextOffset < source.length ||
            source.length >= requested ||
            totalLength > source.length
          const hash = outcome.hash ?? outcome.metadata?.hash
          const title = `Read ${totalLength} characters${hash ? ` (hash ${hash})` : ""}`
          yield* ctx.metadata({ title, metadata: {} })
          const marker = `[length=${totalLength} offset=${offset} returned=${text.length}${hash ? ` hash=${hash}` : ""}${truncated ? " truncated=true" : " truncated=false"}]`
          const output = [`${clip(text, CAPS.readText)}\n\n${marker}`]
          if (truncated) {
            output.push(
              `more characters follow; read again with offset: ${nextOffset} and limit: ${continuingLimit(nextOffset, max)}.`,
            )
          }
          if (full === undefined && preview !== undefined && totalLength > preview.length) {
            output.push(
              `only the first ${preview.length} characters were returned; read again with target or query narrowed to the section you need.`,
            )
          }
          return {
            title,
            output: output.join("\n"),
            metadata: { success: true, length: totalLength, offset, returned: text.length, truncated, hash },
          }
        }),
    }
  }),
)
