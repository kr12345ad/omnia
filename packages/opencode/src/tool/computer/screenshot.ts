import { Effect, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import * as Tool from "../tool"
import DESCRIPTION from "./screenshot.txt"
import { ActionEnvelope, configFromEnv, computerId, request } from "./client"
import { CAPS, renderFailure } from "./output"

const MAX_COORDINATE = 100_000

export const Parameters = Schema.Struct({
  region: Schema.optional(
    Schema.Struct({
      x: Schema.Number.check(
        Schema.isFinite(),
        Schema.isGreaterThanOrEqualTo(0),
        Schema.isLessThanOrEqualTo(MAX_COORDINATE),
      ),
      y: Schema.Number.check(
        Schema.isFinite(),
        Schema.isGreaterThanOrEqualTo(0),
        Schema.isLessThanOrEqualTo(MAX_COORDINATE),
      ),
      width: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(MAX_COORDINATE)),
      height: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(MAX_COORDINATE)),
    }),
  ).annotate({
    description: "Optional screen region {x, y, width, height} in pixels. Captures the whole screen when omitted.",
  }),
})

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
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const config = yield* configFromEnv()
          yield* ctx.ask({
            permission: "computer",
            patterns: ["screenshot"],
            always: ["screenshot"],
            metadata: { operation: "screenshot" },
          })
          const id = yield* computerId(http, config, ctx.sessionID)
          const result = yield* request<ScreenshotResponse>(
            http,
            config,
            "POST",
            `/v1/computers/${id}/actions`,
            {
              action: "screenshot",
              ...(params.region === undefined ? {} : { region: params.region }),
              approve: true,
              approvedBy: `session:${ctx.sessionID}`,
              approvedScopes: ["SCREEN_READ"],
              sessionId: ctx.sessionID,
            },
            { validate: Schema.is(ActionEnvelope) },
          )
          const outcome = result.result
          const path = outcome.metadata?.path
          const title = outcome.success ? `Captured screen${path ? `: ${path}` : ""}` : "Screen capture failed"
          yield* ctx.metadata({ title, metadata: {} })
          const lines = [outcome.message ?? (outcome.success ? "Screen captured." : "Screen capture failed.")]
          if (path) lines.push(`Read ${path} with the read tool to inspect it visually.`)
          if (outcome.error && !outcome.success)
            lines.push(`error: ${renderFailure(outcome.error, "Screen capture failed.")}`)
          const png =
            path === undefined
              ? undefined
              : yield* Effect.tryPromise(() => Bun.file(path).arrayBuffer()).pipe(Effect.orElseSucceed(() => undefined))
          const inline = png !== undefined && png.byteLength <= CAPS.screenshotBytes
          if (path !== undefined && png === undefined) {
            lines.push(
              `The screenshot file is not readable from this machine; it was saved on the connected computer at ${path}.`,
            )
          }
          if (png !== undefined && !inline) {
            lines.push(
              `The screenshot is ${Math.round(png.byteLength / 1024)} KiB, above the ${Math.round(CAPS.screenshotBytes / 1024)} KiB inline limit; read the saved file directly instead.`,
            )
          }
          return {
            title,
            output: lines.join("\n"),
            metadata: {
              success: outcome.success,
              path,
              backend: outcome.metadata?.backend,
              bytes: outcome.metadata?.bytes,
              attachment: inline,
            },
            ...(png === undefined || !inline
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
