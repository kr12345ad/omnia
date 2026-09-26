import { Effect, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import * as Tool from "../tool"
import DESCRIPTION from "./do.txt"
import { configFromEnv, computerId, request } from "./client"

const Endpoint = Schema.Struct({
  elementId: Schema.optional(Schema.String),
  x: Schema.optional(Schema.Number),
  y: Schema.optional(Schema.Number),
}).annotate({ description: "A drag endpoint: either an element ID or explicit x,y coordinates." })

export const Step = Schema.Struct({
  action: Schema.Literals([
    "click",
    "double_click",
    "right_click",
    "middle_click",
    "hover",
    "mouse_down",
    "mouse_up",
    "type",
    "key",
    "hotkey",
    "focus",
    "focus_window",
    "scroll",
    "move",
    "drag",
    "copy",
    "paste",
    "paste_table",
    "launch_app",
    "activate_app",
    "close_app",
    "open_file",
    "open_url",
    "observe",
    "wait",
    "release_keys",
    "read_text",
    "get_focus",
    "get_cursor",
    "read_clipboard",
    "write_clipboard",
    "dismiss",
    "menu",
    "browser_open",
    "browser_navigate",
    "browser_read",
    "browser_find",
    "browser_click",
    "browser_type",
    "browser_key",
    "browser_tabs",
    "browser_activate_tab",
    "browser_close_tab",
    "browser_back",
    "browser_forward",
    "browser_reload",
  ]).annotate({ description: "The intent to perform in this step." }),
  query: Schema.optional(Schema.String).annotate({
    description: "Control to act on, by meaning, for example 'Export button'. Resolved and verified by the runtime.",
  }),
  role: Schema.optional(Schema.String).annotate({ description: "Optional role filter for query, for example button." }),
  window: Schema.optional(Schema.String).annotate({
    description: "Window title fragment; focus_window selects it, other input actions focus it first.",
  }),
  target: Schema.optional(Schema.String).annotate({ description: "Exact element ID when already known." }),
  observationId: Schema.optional(Schema.String).annotate({ description: "Observation the target came from." }),
  text: Schema.optional(Schema.String).annotate({ description: "Text for type." }),
  start: Schema.optional(Schema.String).annotate({ description: "Type marker: skip everything before it; absent marker types nothing." }),
  stop: Schema.optional(Schema.String).annotate({ description: "Type marker: stop immediately after it; absent marker types nothing." }),
  endKey: Schema.optional(Schema.String).annotate({ description: "Key pressed after typing, for example Return." }),
  key: Schema.optional(Schema.String).annotate({ description: "Key for key." }),
  keys: Schema.optional(Schema.Array(Schema.String)).annotate({ description: "Key combination for hotkey." }),
  app: Schema.optional(Schema.String).annotate({ description: "Application for launch_app, activate_app, close_app." }),
  url: Schema.optional(Schema.String).annotate({ description: "URL for open_url." }),
  path: Schema.optional(Schema.String).annotate({ description: "Path for open_file." }),
  direction: Schema.optional(Schema.Literals(["up", "down", "left", "right"])).annotate({
    description: "Scroll direction.",
  }),
  amount: Schema.optional(Schema.Number).annotate({
    description: "Scroll steps, wait/hover milliseconds, or pointer travel milliseconds.",
  }),
  button: Schema.optional(Schema.Literals(["left", "middle", "right"])).annotate({
    description: "Mouse button for mouse_down and mouse_up.",
  }),
  rows: Schema.optional(Schema.Array(Schema.Array(Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null])))).annotate({
    description: "2D array for paste_table.",
  }),
  x: Schema.optional(Schema.Number).annotate({ description: "Screen x coordinate for pointer actions." }),
  y: Schema.optional(Schema.Number).annotate({ description: "Screen y coordinate for pointer actions." }),
  tab: Schema.optional(Schema.String).annotate({ description: "Browser tab id for browser_* steps." }),
  limit: Schema.optional(Schema.Number).annotate({ description: "Maximum candidates for browser_find." }),
  from: Schema.optional(Endpoint).annotate({ description: "Start of a drag action." }),
  to: Schema.optional(Endpoint).annotate({ description: "End of a drag action." }),
  expect: Schema.optional(
    Schema.Struct({
      text: Schema.optional(Schema.String).annotate({ description: "Text that should be visible after the step." }),
      window: Schema.optional(Schema.String).annotate({ description: "Window title fragment that should be open." }),
      file: Schema.optional(Schema.String).annotate({ description: "File path that should exist." }),
    }),
  ).annotate({ description: "Optional expected outcome checked after the step." }),
})

export const Parameters = Schema.Struct({
  plan: Schema.optional(Schema.String).annotate({ description: "One short sentence describing the goal of this plan." }),
  steps: Schema.Array(Step).annotate({ description: "Ordered steps to execute." }),
  stopOnError: Schema.optional(Schema.Boolean).annotate({
    description: "Stop at the first failed step. Defaults to true.",
  }),
  resumeFrom: Schema.optional(Schema.Number).annotate({
    description: "Start executing at this step index; earlier steps are skipped.",
  }),
})

type BatchStepResult = {
  index: number
  action: string
  success: boolean
  message?: string
  resolvedBy?: string
  confidence?: number
  verification?: { status?: string; message?: string }
  stateDelta?: { summary?: string }
  error?: { code?: string; message: string; details?: unknown }
}

type BatchResponse = {
  ok: boolean
  result: {
    success: boolean
    completed: number
    total: number
    failedAt?: number
    steps: BatchStepResult[]
    message: string
  }
}

function formatStep(step: BatchStepResult): string {
  const label = `${step.index + 1}. ${step.action}`
  if (step.success) {
    const verified = step.verification?.status === "verified"
    const parts = [
      step.message,
      step.stateDelta?.summary === undefined ? undefined : `observed: ${step.stateDelta.summary}`,
      step.resolvedBy === undefined ? undefined : `resolved by ${step.resolvedBy}${step.confidence === undefined ? "" : ` (${step.confidence.toFixed(2)})`}`,
    ].filter((part): part is string => typeof part === "string" && part.length > 0)
    return `${label} — ${verified ? "verified" : "completed"}${parts.length === 0 ? "" : `; ${parts.join("; ")}`}`
  }
  const code = step.error?.code ?? "failed"
  const details =
    step.error?.details === undefined ? "" : ` details=${JSON.stringify(step.error.details).slice(0, 400)}`
  return `${label} — ${code}: ${step.error?.message ?? step.message ?? "failed"}${details}`
}

export const ComputerDoTool = Tool.define<typeof Parameters, Record<string, unknown>, HttpClient.HttpClient>(
  "computer_do",
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          const config = yield* configFromEnv()
          if (params.steps.length === 0) throw new Error("The plan requires at least one step.")
          yield* ctx.ask({
            permission: "computer",
            patterns: [`do:${params.steps.length}-steps`],
            always: ["*"],
            metadata: {
              operation: "do",
              plan: params.plan ?? "",
              actions: params.steps.map((step) => step.action).join(","),
            },
          })
          const id = yield* computerId(http, config)
          const response = yield* request<BatchResponse>(http, config, "POST", `/v1/computers/${id}/do`, {
            ...(params.plan === undefined ? {} : { plan: params.plan }),
            ...(params.stopOnError === undefined ? {} : { stopOnError: params.stopOnError }),
            ...(params.resumeFrom === undefined ? {} : { resumeFrom: params.resumeFrom }),
            steps: params.steps.map((step) => ({
              action: step.action,
              ...(step.query === undefined ? {} : { query: step.query }),
              ...(step.role === undefined ? {} : { role: step.role }),
              ...(step.window === undefined ? {} : { window: step.window }),
              ...(step.target === undefined
                ? {}
                : {
                    target: {
                      elementId: step.target,
                      ...(step.observationId === undefined ? {} : { observationId: step.observationId }),
                    },
                  }),
              ...(step.text === undefined ? {} : { text: step.text }),
              ...(step.start === undefined ? {} : { start: step.start }),
              ...(step.stop === undefined ? {} : { stop: step.stop }),
              ...(step.endKey === undefined ? {} : { endKey: step.endKey }),
              ...(step.key === undefined ? {} : { key: step.key }),
              ...(step.keys === undefined ? {} : { keys: [...step.keys] }),
              ...(step.app === undefined ? {} : { app: step.app }),
              ...(step.url === undefined ? {} : { url: step.url }),
              ...(step.path === undefined ? {} : { path: step.path }),
              ...(step.direction === undefined ? {} : { direction: step.direction }),
              ...(step.amount === undefined ? {} : { amount: step.amount }),
              ...(step.button === undefined ? {} : { button: step.button }),
              ...(step.rows === undefined ? {} : { rows: step.rows }),
              ...(step.x === undefined ? {} : { x: step.x }),
              ...(step.y === undefined ? {} : { y: step.y }),
              ...(step.tab === undefined ? {} : { tab: step.tab }),
              ...(step.limit === undefined ? {} : { limit: step.limit }),
              ...(step.from === undefined ? {} : { from: step.from }),
              ...(step.to === undefined ? {} : { to: step.to }),
              ...(step.expect === undefined ? {} : { expect: step.expect }),
            })),
            approve: true,
            approvedBy: `session:${ctx.sessionID}`,
            approvedScopes: [
              "UI_READ",
              "UI_CONTROL",
              "KEYBOARD",
              "POINTER",
              "CLIPBOARD_READ",
              "CLIPBOARD_WRITE",
              "PROCESS_EXECUTE",
              "SCREEN_READ",
              "FILES_READ",
            ],
            sessionId: ctx.sessionID,
          })
          const result = response.result
          const title = result.success
            ? `Plan complete (${result.completed}/${result.total})`
            : `Plan stopped at step ${(result.failedAt ?? 0) + 1}/${result.total}`
          yield* ctx.metadata({ title, metadata: {} })
          const lines = [result.message, ...result.steps.map(formatStep)]
          const failed = result.steps.find((step) => !step.success)
          if (failed) {
            lines.push(
              "The plan stopped. Observe the current interface, choose a corrected step, and send a new plan; do not repeat the failed step unchanged.",
            )
          }
          return {
            title,
            output: lines.join("\n"),
            metadata: {
              success: result.success,
              completed: result.completed,
              total: result.total,
              failedAt: result.failedAt,
              steps: result.steps.map((step) => `${step.action}:${step.success ? "ok" : "failed"}`),
            },
          }
        }),
    }
  }),
)
