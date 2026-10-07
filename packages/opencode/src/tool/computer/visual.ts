import { Effect, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import * as Tool from "../tool"
import DESCRIPTION from "./visual.txt"
import { configFromEnv, computerId, request } from "./client"
import { scopesForVisual } from "./policy"
import { CAPS, clip } from "./output"

export const OPERATIONS = ["ground", "click", "type", "scroll", "drag", "resize", "inspect", "general"] as const

export const Parameters = Schema.Struct({
  operation: Schema.Literals(OPERATIONS).annotate({
    description:
      "What to do: ground (point at something), click, type, scroll, drag, resize, inspect (describe), or general.",
  }),
  target: Schema.String.annotate({
    description:
      "The control or region in plain language, for example 'the blue Export button' or 'the layer thumbnail in the left panel'.",
  }),
  text: Schema.optional(Schema.String).annotate({
    description: "Text for a type operation, or other content the visual action needs.",
  }),
  question: Schema.optional(Schema.String).annotate({
    description:
      "Ask the visual model a question about the screen, for example 'what error is shown?' or 'which row is selected?'. When the answer is a location the model also returns coordinates.",
  }),
  task: Schema.optional(Schema.String).annotate({
    description: "The user-level task this action serves, for example 'export the document to PDF'.",
  }),
  execute: Schema.optional(Schema.Boolean).annotate({
    description: "Set false to get a proposal without acting. Defaults to true: the action is performed and verified.",
  }),
})

type VisualDecision = {
  provider: string
  local: boolean
  reason?: string[]
  semanticCoverage?: number
  requiresApproval?: boolean
  blockedByPolicy?: boolean
}

type VisualResult = {
  success: boolean
  action?: {
    type: string
    target?: { x?: number; y?: number; label?: string }
    text?: string
    key?: string
    direction?: string
    path?: Array<{ x: number; y: number }>
  }
  confidence: number
  reasoning?: string
}

type VisualExecution = {
  outcome: {
    result: {
      success: boolean
      message?: string
      verification?: { verified?: boolean; status?: string }
      error?: { code?: string; message: string }
    }
  }
  verified: boolean
}

type VisualResponse = {
  ok: boolean
  // Server returns { analysis: { decision, result, fallbacks }, execution }.
  // Top-level decision/result are also accepted (flattened shape).
  analysis?: {
    decision?: VisualDecision
    result?: VisualResult
    fallbacks?: number
    errorCode?: string
  }
  decision?: VisualDecision
  result?: VisualResult
  fallbacks?: number
  errorCode?: string
  error?: string
  execution?: VisualExecution
}

function describeAction(action: NonNullable<VisualResponse["result"]>["action"]): string {
  if (action === undefined) return "no action"
  const point = action.target === undefined ? undefined : `(${action.target.x ?? "?"}, ${action.target.y ?? "?"})`
  switch (action.type) {
    case "click":
    case "double_click":
    case "right_click":
      return `${action.type} at ${point}`
    case "type":
      return `type "${(action.text ?? "").slice(0, 60)}"`
    case "key":
      return `key ${action.key ?? ""}`
    case "scroll":
      return `scroll ${action.direction ?? "down"}${point === undefined ? "" : ` at ${point}`}`
    case "drag":
      return `drag${point === undefined ? "" : ` from ${point}`}${action.path?.[1] === undefined ? "" : ` to (${action.path[1].x}, ${action.path[1].y})`}`
    default:
      return action.type
  }
}

export const ComputerVisualTool = Tool.define<typeof Parameters, Record<string, unknown>, HttpClient.HttpClient>(
  "computer_visual",
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
            patterns: [`visual:${params.operation}`],
            always: [`visual:${params.operation}`],
            metadata: { operation: params.operation, target: params.target },
          })
          const id = yield* computerId(http, config, ctx.sessionID)
          const response = yield* request<VisualResponse>(http, config, "POST", "/v1/computer-use/analyze", {
            computerId: id,
            requestedOperation: params.operation,
            targetDescription: params.target,
            ...(params.task === undefined ? {} : { taskContext: params.task }),
            ...(params.question === undefined ? {} : { question: params.question }),
            ...(params.text === undefined ? {} : { text: params.text }),
            execute: params.execute !== false,
            sessionId: ctx.sessionID,
            approve: true,
            approvedBy: `session:${ctx.sessionID}`,
            approvedScopes: scopesForVisual(params.operation),
          })
          const result = response.result ?? response.analysis?.result
          const decision = response.decision ?? response.analysis?.decision
          const fallbacks = response.fallbacks ?? response.analysis?.fallbacks
          const errorCode = response.errorCode ?? response.analysis?.errorCode
          const lines: string[] = []
          const title =
            result?.success === true
              ? result.action === undefined
                ? `Visual ${params.operation}: ${(result.reasoning ?? "answered").slice(0, 60)}`
                : `Visual ${params.operation}: ${describeAction(result.action)}`
              : "Visual grounding unavailable"
          if (errorCode === "visual_provider_blocked_by_policy") {
            lines.push("Remote visual processing is disabled by policy, so the screenshot was not sent.")
            lines.push("Enable remote screen data in computer-use settings or install a local visual model.")
          } else if (result?.success !== true) {
            lines.push(
              clip(result?.reasoning ?? response.error ?? "No visual provider produced an action.", CAPS.visualText),
            )
            if (decision?.reason !== undefined && decision.reason.length > 0)
              lines.push(`routing: ${decision.reason.join("; ")}`)
          } else {
            const path =
              decision?.provider === "semantic"
                ? "semantic data"
                : decision?.local === true
                  ? "a local visual model"
                  : "a hosted visual provider"
            lines.push(`Grounding path: ${path}. Confidence ${(result.confidence * 100).toFixed(0)}%.`)
            if (result.action === undefined) {
              lines.push(`Answer: ${clip(result.reasoning ?? "the model returned no answer.", CAPS.visualText)}`)
            } else {
              lines.push(`Proposed action: ${describeAction(result.action)}.`)
            }
            const execution = result.action === undefined ? undefined : response.execution
            if (execution !== undefined) {
              const outcome = execution.outcome.result
              lines.push(
                outcome.success
                  ? `Executed: ${clip(outcome.message ?? "done", CAPS.visualText)}.`
                  : `Execution failed: ${clip(outcome.error?.message ?? outcome.message ?? "unknown error", CAPS.visualText)}.`,
              )
              const status = outcome.verification?.status ?? (execution.verified ? "verified" : "unverified")
              lines.push(
                status === "verified"
                  ? "Verified by observation: the interface changed as expected."
                  : `Not verified (${status}): confirm the result with computer_observe before continuing.`,
              )
            } else if (params.execute === false) {
              lines.push("Proposal only. Call computer_act with these coordinates, or retry with execute enabled.")
            }
          }
          if (fallbacks !== undefined && fallbacks > 0) lines.push(`Fallback providers tried: ${fallbacks}.`)
          if (decision?.blockedByPolicy === true) lines.push("Remote visual processing is blocked by policy.")
          if (decision?.requiresApproval === true)
            lines.push("Computer-use mode is set to ask; the user may need to confirm.")
          yield* ctx.metadata({
            title,
            metadata: {
              operation: params.operation,
              provider: decision?.provider,
              verified: response.execution?.verified,
            },
          })
          return {
            title,
            output: lines.join("\n"),
            metadata: {
              success: result?.success === true,
              operation: params.operation,
              action: result?.action,
              confidence: result?.confidence,
              verified: response.execution?.verified,
              fallbacks: fallbacks ?? 0,
            },
          }
        }),
    }
  }),
)
