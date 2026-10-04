import { Effect, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import * as Tool from "../tool"
import DESCRIPTION from "./do.txt"
import { BatchEnvelope, configFromEnv, computerId, request } from "./client"
import { PLAN_ACTIONS } from "./actions"
import { TILE_POSITIONS, alwaysPatternsForSteps, batchScopes, stepPermissionPatterns, validateAction } from "./policy"
import { CAPS, clipLines, renderDetails } from "./output"

const Endpoint = Schema.Struct({
  elementId: Schema.optional(Schema.String),
  x: Schema.optional(Schema.Int),
  y: Schema.optional(Schema.Int),
}).annotate({ description: "A drag endpoint: either an element ID or explicit x,y coordinates." })

export const Step = Schema.Struct({
  action: Schema.Literals(PLAN_ACTIONS).annotate({ description: "The intent to perform in this step." }),
  query: Schema.optional(Schema.String).annotate({
    description: "Control to act on, by meaning, for example 'Export button'. Resolved by the runtime; ambiguous matches are rejected.",
  }),
  role: Schema.optional(Schema.String).annotate({ description: "Optional role filter for query, for example button." }),
  window: Schema.optional(Schema.String).annotate({
    description: "Window title fragment; focus_window selects it, other input actions focus it first.",
  }),
  target: Schema.optional(Schema.String).annotate({ description: "Exact element ID when already known." }),
  observationId: Schema.optional(Schema.String).annotate({ description: "Observation the target came from." }),
  text: Schema.optional(Schema.String).annotate({ description: "Text for type and set_value." }),
  value: Schema.optional(Schema.String).annotate({ description: "Option value for browser_select." }),
  files: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Absolute file paths for browser_upload.",
  }),
  start: Schema.optional(Schema.String).annotate({
    description: "Type marker: skip everything before it; absent marker types nothing.",
  }),
  stop: Schema.optional(Schema.String).annotate({
    description: "Type marker: stop immediately after it; absent marker types nothing.",
  }),
  endKey: Schema.optional(Schema.String).annotate({ description: "Key pressed after typing, for example Return." }),
  key: Schema.optional(Schema.String).annotate({ description: "Key for key." }),
  keys: Schema.optional(Schema.Array(Schema.String)).annotate({ description: "Key combination for hotkey." }),
  app: Schema.optional(Schema.String).annotate({ description: "Application for launch_app, activate_app, close_app." }),
  url: Schema.optional(Schema.String).annotate({ description: "http:// or https:// URL for open_url." }),
  path: Schema.optional(Schema.String).annotate({ description: "Path for open_file." }),
  direction: Schema.optional(Schema.Literals(["up", "down", "left", "right"])).annotate({
    description: "Scroll direction.",
  }),
  amount: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))).annotate({
    description: "Scroll steps, wait/hover milliseconds, or pointer travel milliseconds.",
  }),
  button: Schema.optional(Schema.Literals(["left", "middle", "right"])).annotate({
    description: "Mouse button for mouse_down and mouse_up.",
  }),
  rows: Schema.optional(
    Schema.Array(Schema.Array(Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null]))),
  ).annotate({
    description: "2D array for paste_table.",
  }),
  x: Schema.optional(Schema.Int).annotate({
    description: "X coordinate: screen pixels for desktop pointer actions, viewport pixels for browser_* steps.",
  }),
  y: Schema.optional(Schema.Int).annotate({
    description: "Y coordinate: screen pixels for desktop pointer actions, viewport pixels for browser_* steps.",
  }),
  position: Schema.optional(Schema.Literals(TILE_POSITIONS)).annotate({
    description: "Window position for window_tile.",
  }),
  point: Schema.optional(Schema.String).annotate({ description: "Calibration point id for calibration_measure." }),
  tab: Schema.optional(Schema.String).annotate({ description: "Browser tab id for browser_* steps." }),
  dialog: Schema.optional(Schema.Literals(["accept", "dismiss"])).annotate({
    description: 'Answer for a browser_dialog step: "accept" (OK) or "dismiss" (Cancel).',
  }),
  promptText: Schema.optional(Schema.String).annotate({
    description: "Text to enter when accepting a prompt dialog in a browser_dialog step.",
  }),
  expectedType: Schema.optional(Schema.String).annotate({
    description: "Expected pending dialog type for a browser_dialog step.",
  }),
  expectedMessage: Schema.optional(Schema.String).annotate({
    description: "Expected pending dialog message for a browser_dialog step.",
  }),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))).annotate({
    description: "Maximum candidates for browser_find.",
  }),
  from: Schema.optional(Endpoint).annotate({ description: "Start of a drag action." }),
  to: Schema.optional(Endpoint).annotate({ description: "End of a drag action." }),
  command: Schema.optional(Schema.String).annotate({ description: "Shell command for run_command." }),
  cwd: Schema.optional(Schema.String).annotate({ description: "Working directory for run_command." }),
  timeoutMs: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 600000 }))).annotate({
    description: "Timeout in milliseconds for run_command.",
  }),
  credential: Schema.optional(Schema.String).annotate({
    description: 'Credential for run_command: "auto", "none", or a stored credential id/name.',
  }),
  field: Schema.optional(Schema.Literals(["username", "secret"])).annotate({
    description:
      'Which part of the stored credential to type: "secret" (default) or "username". Only used when credential is set. Without it a credential types its secret, so a username field would receive the secret.',
  }),
  expect: Schema.optional(
    Schema.Struct({
      text: Schema.optional(Schema.String).annotate({ description: "Text that should be visible after the step." }),
      window: Schema.optional(Schema.String).annotate({ description: "Window title fragment that should be open." }),
      file: Schema.optional(Schema.String).annotate({ description: "File path that should exist." }),
    }),
  ).annotate({ description: "Optional expected outcome checked after the step." }),
  allowUnverified: Schema.optional(Schema.Boolean).annotate({
    description:
      "Allow this step to pass without verification. Defaults to false; steps whose effect is not verified fail the plan unless this is true.",
  }),
})

type PlanStep = Schema.Schema.Type<typeof Step>

export const Parameters = Schema.Struct({
  plan: Schema.optional(Schema.String).annotate({
    description: "One short sentence describing the goal of this plan.",
  }),
  steps: Schema.Array(Step)
    .check(Schema.isMaxLength(CAPS.doSteps))
    .annotate({ description: `Ordered steps to execute, at most ${CAPS.doSteps}.` }),
  stopOnError: Schema.optional(Schema.Boolean).annotate({
    description: "Stop at the first failed step. Defaults to true.",
  }),
  resumeFrom: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))).annotate({
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

function expectedTextMatch(step: BatchStepResult, expect: PlanStep["expect"]): string | undefined {
  if (expect === undefined || expect.window !== undefined || expect.file !== undefined) return undefined
  if (expect.text === undefined || expect.text.length === 0) return undefined
  const needle = expect.text.toLowerCase()
  // The server's unmet message repeats the expectation text, so a message equal
  // to the step error must never satisfy it; only the observed output can.
  const outputs = [step.message, step.verification?.message, step.stateDelta?.summary].filter(
    (value): value is string => typeof value === "string" && value.length > 0 && value !== step.error?.message,
  )
  return outputs.some((value) => value.toLowerCase().includes(needle)) ? expect.text : undefined
}

function matchExpectedText(steps: BatchStepResult[], expected: readonly PlanStep[]): BatchStepResult[] {
  return steps.map((step) => {
    if (step.success || step.error?.code !== "expectation_unmet") return step
    const matched = expectedTextMatch(step, expected[step.index]?.expect)
    if (matched === undefined) return step
    return {
      ...step,
      success: true,
      error: undefined,
      verification: { status: "verified", message: `The expected text "${matched}" appears in the step output.` },
    }
  })
}

// FAIL-CLOSED verification: a step that reports success without verified status
// must not be treated as passed. Only verification.status === "verified" counts,
// unless the plan step explicitly opts out with allowUnverified:true (default false).
// The server agent carries the matching contract; this layer enforces the
// agent-facing truth so unverified effects never read as complete.
function applyFailClosed(steps: BatchStepResult[], expected: readonly PlanStep[]): BatchStepResult[] {
  return steps.map((step) => {
    if (!step.success) return step
    if (step.verification?.status === "verified") return step
    if (expected[step.index]?.allowUnverified === true) return step
    const evidence = step.verification?.message ?? step.message ?? "The step completed but its effect was not verified."
    return {
      ...step,
      success: false,
      verification: { status: "unverified", message: evidence },
      error: {
        code: "unverified",
        message: `Unverified step: ${evidence} Re-observe and retry, or set allowUnverified:true if verification is not required.`,
      },
    }
  })
}

function formatStep(step: BatchStepResult): string {
  const label = `${step.index + 1}. ${step.action}`
  if (step.success) {
    const status = step.verification?.status ?? "completed"
    const parts = [
      step.message,
      step.stateDelta?.summary === undefined ? undefined : `observed: ${step.stateDelta.summary}`,
      step.resolvedBy === undefined
        ? undefined
        : `resolved by ${step.resolvedBy}${step.confidence === undefined ? "" : ` (${step.confidence.toFixed(2)})`}`,
    ].filter((part): part is string => typeof part === "string" && part.length > 0)
    return `${label} — ${status}${parts.length === 0 ? "" : `; ${parts.join("; ")}`}`
  }
  const code = step.error?.code ?? "failed"
  const details = renderDetails(step.error?.details, CAPS.errorDetails)
  return `${label} — ${code}: ${step.error?.message ?? step.message ?? "failed"}${details === undefined ? "" : ` (${details})`}`
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
          if (params.steps.length === 0) throw new Error("The plan requires at least one step.")
          for (const step of params.steps) validateAction(step)
          const config = yield* configFromEnv()
          yield* ctx.ask({
            permission: "computer",
            patterns: stepPermissionPatterns(params.steps),
            always: alwaysPatternsForSteps(params.steps),
            metadata: {
              operation: "do",
              plan: params.plan ?? "",
              actions: params.steps.map((step) => step.action).join(","),
            },
          })
          const id = yield* computerId(http, config)
          const response = yield* request<BatchResponse>(
            http,
            config,
            "POST",
            `/v1/computers/${id}/do`,
            {
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
                ...(step.observationId === undefined ? {} : { observationId: step.observationId }),
                ...(step.text === undefined && step.position === undefined && step.point === undefined
                  ? {}
                  : { text: step.text ?? step.position ?? step.point }),
                ...(step.value === undefined ? {} : { value: step.value }),
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
                ...(step.dialog === undefined ? {} : { dialog: step.dialog }),
                ...(step.promptText === undefined ? {} : { promptText: step.promptText }),
                ...(step.expectedType === undefined ? {} : { expectedType: step.expectedType }),
                ...(step.expectedMessage === undefined ? {} : { expectedMessage: step.expectedMessage }),
                ...(step.limit === undefined ? {} : { limit: step.limit }),
                ...(step.from === undefined ? {} : { from: step.from }),
                ...(step.to === undefined ? {} : { to: step.to }),
                ...(step.command === undefined ? {} : { command: step.command }),
                ...(step.cwd === undefined ? {} : { cwd: step.cwd }),
                ...(step.timeoutMs === undefined ? {} : { timeoutMs: step.timeoutMs }),
                ...(step.credential === undefined ? {} : { credential: step.credential }),
                ...(step.field === undefined ? {} : { field: step.field }),
                ...(step.expect === undefined ? {} : { expect: step.expect }),
                ...(step.allowUnverified === undefined ? {} : { allowUnverified: step.allowUnverified }),
              })),
              approve: true,
              approvedBy: `session:${ctx.sessionID}`,
              approvedScopes: batchScopes(params.steps),
              sessionId: ctx.sessionID,
            },
            { validate: Schema.is(BatchEnvelope) },
          )
          const result = response.result
          const afterExpect = matchExpectedText(result.steps, params.steps)
          const steps = applyFailClosed(afterExpect, params.steps)
          const rechecked = steps.some((step, index) => step !== result.steps[index])
          const failedSteps = steps.filter((step) => !step.success)
          const stopOnError = params.stopOnError !== false
          const lastExecuted = steps.length === 0 ? -1 : steps[steps.length - 1].index
          const ranToEnd = lastExecuted >= result.total - 1
          const completed = rechecked ? steps.filter((step) => step.success).length : result.completed
          const success = rechecked ? failedSteps.length === 0 && ranToEnd : result.success
          const failedAt = failedSteps[0]?.index ?? result.failedAt
          const failedLabel = `${failedSteps.length} failed step${failedSteps.length === 1 ? "" : "s"}`
          const unverifiedFailed = failedSteps.some((step) => step.error?.code === "unverified")
          const title = success
            ? `Plan complete (${completed}/${result.total})`
            : failedSteps.length > 0 && !stopOnError
              ? `Plan completed with ${failedLabel} (${completed} of ${result.total})`
              : `Plan stopped at step ${(failedAt ?? lastExecuted + 1) + 1}/${result.total}`
          yield* ctx.metadata({ title, metadata: {} })
          const lines = [
            result.message,
            ...clipLines(
              steps.map((step) => formatStep(step)),
              CAPS.doSteps,
            ),
          ]
          if (failedSteps.length > 0) {
            if (unverifiedFailed) {
              lines.push(
                "Unverified steps fail closed: only verification: verified counts as passed. Re-observe and retry, or set allowUnverified:true on steps where verification is not required.",
              )
            }
            if (stopOnError) {
              lines.push(
                "The plan stopped. Observe the current interface, choose a corrected step, and send a new plan; do not repeat the failed step unchanged.",
              )
            } else {
              lines.push(`The plan completed with ${failedLabel} (${completed} of ${result.total}).`)
              lines.push(
                "Observe the current interface, choose corrected steps, and send a new plan; do not repeat failed steps unchanged.",
              )
            }
          } else if (rechecked && !success) {
            lines.push(
              `The expectation matched the step output, but the plan did not finish. Continue from step ${lastExecuted + 2} with resumeFrom: ${lastExecuted + 1}.`,
            )
          }
          return {
            title,
            output: lines.join("\n"),
            metadata: {
              success,
              completed,
              total: result.total,
              failedAt,
              steps: steps.map((step) => `${step.action}:${step.success ? "ok" : "failed"}`),
            },
          }
        }),
    }
  }),
)
