import { Effect, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import * as Tool from "../tool"
import DESCRIPTION from "./screenshot.txt"
import { configFromEnv, computerId, request } from "./client"

export const Parameters = Schema.Struct({})

type ScreenshotResponse = {
  ok: boolean
  result: {
    success: boolean
    message?: string
    metadata?: { path?: string; backend?: string; bytes?: number }
    error?: { code?: string; message: string }
  }
}

export const ComputerScreenshotTool = Tool.define<typeof Parameters, Record<string, unknown>, HttpClient.HttpClient>(
  "computer_screenshot",
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
            patterns: ["screenshot"],
            always: ["*"],
            metadata: { operation: "screenshot" },
          })
          const id = yield* computerId(http, config)
          const result = yield* request<ScreenshotResponse>(http, config, "POST", `/v1/computers/${id}/actions`, {
            action: "screenshot",
            approve: true,
            approvedBy: `session:${ctx.sessionID}`,
            approvedScopes: ["SCREEN_READ"],
            sessionId: ctx.sessionID,
          })
          const outcome = result.result
          const path = outcome.metadata?.path
          const title = outcome.success ? `Captured screen${path ? `: ${path}` : ""}` : "Screen capture failed"
          yield* ctx.metadata({ title, metadata: {} })
          const lines = [outcome.message ?? (outcome.success ? "Screen captured." : "Screen capture failed.")]
          if (path) lines.push(`Read ${path} with the read tool to inspect it visually.`)
          if (outcome.error && !outcome.success) lines.push(`error: ${outcome.error.message}`)
          const png =
            path === undefined
              ? undefined
              : yield* Effect.tryPromise(() => Bun.file(path).arrayBuffer()).pipe(Effect.orElseSucceed(() => undefined))
          return {
            title,
            output: lines.join("\n"),
            metadata: {
              success: outcome.success,
              path,
              backend: outcome.metadata?.backend,
              bytes: outcome.metadata?.bytes,
            },
            ...(png === undefined
              ? {}
              : {
                  attachments: [
                    {
                      type: "file" as const,
                      mime: "image/png",
                      url: `data:image/png;base64,${Buffer.from(png).toString("base64")}`,
                    },
                  ],
                }),
          }
        }),
    }
  }),
)
