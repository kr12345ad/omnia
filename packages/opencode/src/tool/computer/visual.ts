import { Effect, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import { titleBarThresholds } from "@opencode-ai/omnia/computer-use/window-safety"
import type { ComputerUsePlatform } from "@opencode-ai/omnia/computer-use/types"
import * as Tool from "../tool"
import DESCRIPTION from "./visual.txt"
import { configFromEnv, computerId, request } from "./client"
import type { OmniaServerConfig } from "./client"
import { scopesForVisual } from "./policy"
import { CAPS, clip } from "./output"
import type { SessionID } from "@/session/schema"

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
    description:
      "Set false to get a proposal without acting. Defaults to true: the action is performed and reported, still unverified until a post-action observation confirms the effect.",
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

type VisualPoint = { x?: number; y?: number; label?: string }

type VisualAction = {
  type: string
  target?: VisualPoint
  text?: string
  key?: string
  direction?: string
  path?: Array<{ x: number; y: number }>
}

// The server's post-action verdict. Only a confirmation whose method read the
// interface back ("active-window" or "element-state-change") is an observation;
// "execution-verification" is the execution record's own claim about a point it
// delivered, which is not a read of the screen.
type VisualConfirmation = {
  status?: string
  method?: string
  reason?: string
  expected?: { title?: string; ref?: string; windowId?: string; states?: readonly string[] }
  observed?: { title?: string; ref?: string; windowId?: string; states?: readonly string[]; value?: string }
}

type VisualResult = {
  success: boolean
  action?: VisualAction
  confidence: number
  reasoning?: string
  evidence?: readonly string[]
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
  confirmation?: VisualConfirmation
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
    context?: {
      platform?: string
      image?: { width?: number; height?: number; region?: { x: number; y: number; width: number; height: number } }
    }
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

// ---------------------------------------------------------------------------
// Coordinate honesty
//
// parse.ts resolves every bundled vision model in normalized-1000 space
// (absolute is an explicit opt-in), so a result that does not name its space is
// read through that contract. The point the runtime hands back is already in
// logical screen pixels; reporting both spaces and the scale between them keeps
// the caller from mistaking a normalized model coordinate for a pixel.
// ---------------------------------------------------------------------------

const MODEL_COORDINATE_SPACE = "normalized-1000"
const MODEL_COORDINATE_SCALE = 1000

type CoordinateReport = {
  space: "absolute"
  modelSpace: typeof MODEL_COORDINATE_SPACE
  scale: number
  screenshot?: { width: number; height: number }
  logical?: { width: number; height: number }
  calibrated: boolean
}

function screenSize(image: { width?: number; height?: number } | undefined): { width: number; height: number } | undefined {
  if (image === undefined) return undefined
  const width = image.width
  const height = image.height
  if (typeof width !== "number" || typeof height !== "number" || width <= 0 || height <= 0) return undefined
  if (!Number.isFinite(width) || !Number.isFinite(height)) return undefined
  return { width, height }
}

/** The logical screen the server converted to, parsed from its own evidence. */
function logicalScreenSize(result: VisualResult): { width: number; height: number } | undefined {
  for (const entry of result.evidence ?? []) {
    const match = entry.match(/^retina: screenshot (\d+)x(\d+) to logical (\d+)x(\d+)$/)
    if (match !== null) return { width: Number(match[3]), height: Number(match[4]) }
  }
  return undefined
}

function coordinateReport(response: VisualResponse, result: VisualResult): CoordinateReport {
  const screenshot = screenSize(response.analysis?.context?.image)
  const logical = logicalScreenSize(result) ?? screenshot
  return {
    space: "absolute",
    modelSpace: MODEL_COORDINATE_SPACE,
    scale: MODEL_COORDINATE_SCALE,
    ...(screenshot === undefined ? {} : { screenshot }),
    ...(logical === undefined ? {} : { logical }),
    calibrated: (result.evidence ?? []).some((entry) => entry.startsWith("calibration:")),
  }
}

function coordinateLine(report: CoordinateReport): string {
  if (report.screenshot === undefined)
    return "coordinates: absolute logical screen pixels — the response carried no screenshot dimensions, so the model space and scale could not be checked against them."
  const converted =
    report.logical === undefined || report.logical === report.screenshot
      ? ""
      : `, retina-converted to logical ${report.logical.width}x${report.logical.height}`
  const calibrated = report.calibrated ? ", and routed through the display's calibration profile" : ""
  return (
    `coordinates: absolute logical screen pixels — the vision model grounds in ${report.modelSpace} ` +
    `(scale ${report.scale}) against the ${report.screenshot.width}x${report.screenshot.height} screenshot it was shown` +
    `${converted}${calibrated}.`
  )
}

// ---------------------------------------------------------------------------
// Verification honesty
//
// A vision point has no ref to read back, so it verifies only through a
// post-action observation. The model's confidence and the execution record's
// own claim are not observations and can never turn a result verified.
// ---------------------------------------------------------------------------

type VerificationVerdict = {
  verified: boolean
  method: string
  reason?: string
}

function verificationVerdict(execution: VisualExecution | undefined): VerificationVerdict {
  if (execution === undefined) return { verified: false, method: "not_executed" }
  const confirmation = execution.confirmation
  if (confirmation === undefined)
    return { verified: false, method: execution.verified === true ? "execution-verification" : "no_post_observation" }
  return {
    verified: confirmation.status === "verified" && confirmation.method !== "execution-verification",
    method: confirmation.method ?? "no_post_observation",
    ...(confirmation.reason === undefined ? {} : { reason: confirmation.reason }),
  }
}

function describeConfirmation(confirmation: VisualConfirmation | undefined): string {
  const observed = confirmation?.observed
  if (observed === undefined) return "the interface changed as the action expected"
  const parts = [
    observed.title === undefined ? undefined : `active window "${observed.title}"`,
    observed.ref === undefined ? undefined : `ref ${observed.ref}`,
    observed.states === undefined || observed.states.length === 0 ? undefined : `states [${observed.states.join(", ")}]`,
    observed.value === undefined ? undefined : `value "${observed.value}"`,
  ]
  const described = parts.filter((part): part is string => part !== undefined).join(", ")
  return described.length === 0 ? "the interface changed as the action expected" : described
}

// ---------------------------------------------------------------------------
// Title-bar ban
//
// The P0 ban in window-safety.ts keeps vision clicks off the window-control
// cluster. Full-screen points can still land elsewhere in a window's title
// strip, so the same calibrated geometry is applied here against each window's
// own bounds and the point is refused instead of returned as a target.
// ---------------------------------------------------------------------------

type WindowBounds = {
  x: number
  y: number
  width: number
  height: number
  title?: string
}

type TitleStripViolation = {
  point: { x: number; y: number }
  window: WindowBounds
  strip: number
}

function titleStripViolation(
  points: readonly { x: number; y: number }[],
  windows: readonly WindowBounds[],
  platform: ComputerUsePlatform,
): TitleStripViolation | undefined {
  for (const point of points) {
    for (const window of windows) {
      if (point.x < window.x || point.x >= window.x + window.width) continue
      const strip = titleBarThresholds({ width: window.width, height: window.height }, platform).yThreshold
      if (point.y >= window.y && point.y < window.y + strip) return { point, window, strip }
    }
  }
  return undefined
}

type WindowElement = {
  role?: string
  name?: string
  bounds?: { x: number; y: number; width: number; height: number }
}

type ObservationBody = {
  ok: boolean
  observation: { id: string; elements?: readonly WindowElement[] }
}

const WindowElementShape = Schema.Struct({
  role: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  bounds: Schema.optional(
    Schema.Struct({ x: Schema.Number, y: Schema.Number, width: Schema.Number, height: Schema.Number }),
  ),
})

const ObservationShape = Schema.Struct({
  ok: Schema.Boolean,
  observation: Schema.Struct({
    id: Schema.String,
    elements: Schema.optional(Schema.Array(WindowElementShape)),
  }),
})

/** Live window geometry for the title-strip ban; undefined when it cannot be read. */
function windowsFor(
  http: HttpClient.HttpClient,
  config: OmniaServerConfig,
  computer: string,
  sessionID: SessionID,
): Effect.Effect<readonly WindowBounds[] | undefined> {
  return request<ObservationBody>(
    http,
    config,
    "POST",
    `/v1/computers/${computer}/observe`,
    {
      approve: true,
      approvedBy: `session:${sessionID}`,
      approvedScopes: ["UI_READ"],
      sessionId: sessionID,
    },
    { validate: Schema.is(ObservationShape) },
  ).pipe(
    Effect.map((body) =>
      (body.observation.elements ?? []).flatMap((element) =>
        element.role?.toLowerCase() === "window" && element.bounds !== undefined && element.bounds.width > 0 && element.bounds.height > 0
          ? [{ ...element.bounds, ...(element.name === undefined ? {} : { title: element.name }) }]
          : [],
      ),
    ),
    // An unreadable interface costs the ban its geometry, never the action: the
    // caller reports that the check could not run instead of skipping silently.
    Effect.catchCause(() => Effect.succeed(undefined)),
  )
}

function platformOf(response: VisualResponse): ComputerUsePlatform {
  const platform = response.analysis?.context?.platform
  return platform === "macos" || platform === "windows" ? platform : "linux"
}

/** Every point this action would land on, including drag legs. */
function actionPoints(action: VisualAction | undefined): { x: number; y: number }[] {
  const target = action?.target
  return [
    ...(typeof target?.x === "number" &&
    typeof target?.y === "number" &&
    Number.isFinite(target.x) &&
    Number.isFinite(target.y)
      ? [{ x: target.x, y: target.y }]
      : []),
    ...(action?.path ?? []).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y)),
  ]
}

/**
 * The aim a vision result carries. The strategy names where the point came
 * from, so the audit trail keeps a model guess apart from a control resolved
 * through the accessibility tree.
 */
function visionAim(action: VisualAction | undefined): { x: number; y: number; strategy: "vision-ground" } | undefined {
  const target = action?.target
  if (typeof target?.x !== "number" || typeof target?.y !== "number") return undefined
  if (!Number.isFinite(target.x) || !Number.isFinite(target.y)) return undefined
  return { x: target.x, y: target.y, strategy: "vision-ground" }
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
          const execution = result?.action === undefined ? undefined : response.execution
          const verdict = verificationVerdict(execution)
          const aim = visionAim(result?.action)
          const points = actionPoints(result?.action)
          const windows = points.length === 0 ? undefined : yield* windowsFor(http, config, id, ctx.sessionID)
          const violation =
            windows === undefined ? undefined : titleStripViolation(points, windows, platformOf(response))
          if (violation !== undefined) {
            const title = `Refused visual ${params.operation} (title_bar_ban)`
            const windowLabel = violation.window.title === undefined ? "a window" : `window "${violation.window.title}"`
            const bounds = violation.window
            const message =
              `Refusing to ground onto a window title bar: the vision point (${violation.point.x}, ${violation.point.y}) ` +
              `lands in the top ${violation.strip}px strip of ${windowLabel} ` +
              `(${bounds.x},${bounds.y} ${bounds.width}x${bounds.height}). Full-screen vision clicks on window controls are banned ` +
              `(P0): Minimize and Close sit 9px apart inside ±10px vision jitter. Re-observe with computer_observe and act on the ` +
              `control by ref, or ground with a screenshot cropped around the control.`
            const lines = [
              message,
              execution === undefined
                ? "The runtime was not asked to execute this action, so no click landed."
                : execution.outcome.result.success
                  ? `The runtime already executed the action at that point (${clip(execution.outcome.result.message ?? "done", CAPS.visualText)}); re-observe with computer_observe and check what that click changed before continuing.`
                  : `The runtime's execution at that point failed: ${clip(execution.outcome.result.error?.message ?? execution.outcome.result.message ?? "unknown error", CAPS.visualText)}.`,
            ]
            yield* ctx.metadata({ title, metadata: {} })
            return {
              title,
              output: lines.join("\n"),
              metadata: {
                operation: params.operation,
                success: false,
                refused: true,
                verification: "refused",
                verified: false,
                confidence: result?.confidence,
                ...(execution === undefined ? {} : { executed: execution.outcome.result.success }),
                titleBar: {
                  point: violation.point,
                  window: bounds.title ?? "unnamed",
                  strip: violation.strip,
                },
                error: { code: "title_bar_ban", message },
              },
            }
          }
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
              if (aim !== undefined)
                lines.push(
                  `aim: ${aim.x},${aim.y} (${aim.strategy}) — the model guessed this pixel; it is not a resolved control, so treat the point as unverified until an observation confirms the effect.`,
                )
              lines.push(coordinateLine(coordinateReport(response, result)))
              if (windows === undefined)
                lines.push(
                  "The title-strip check could not run: the current observation could not be read, so no window geometry was available to refuse against.",
                )
              if (execution !== undefined) {
                const outcome = execution.outcome.result
                lines.push(
                  outcome.success
                    ? `Executed: ${clip(outcome.message ?? "done", CAPS.visualText)}.`
                    : `Execution failed: ${clip(outcome.error?.message ?? outcome.message ?? "unknown error", CAPS.visualText)}.`,
                )
                lines.push(
                  verdict.verified
                    ? `Verified by post-action observation (${verdict.method}): ${describeConfirmation(execution.confirmation)}.`
                    : `Not verified (${verdict.method}${verdict.reason === undefined ? "" : `: ${verdict.reason}`}): a vision click is a guess until an observation confirms it. Re-observe with computer_observe and confirm the state delta before continuing.`,
                )
              } else if (params.execute === false) {
                lines.push("Proposal only. Call computer_act with these coordinates, or retry with execute enabled.")
              } else {
                lines.push("The runtime reported no execution for this action, so nothing was acted on.")
              }
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
              verified: verdict.verified,
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
              ...(aim === undefined ? {} : { aim }),
              ...(result?.action === undefined ? {} : { coordinate: coordinateReport(response, result) }),
              verified: verdict.verified,
              verification: verdict.verified ? "verified" : "not_verified",
              verificationMethod: verdict.method,
              ...(execution === undefined ? {} : { executed: execution.outcome.result.success }),
              fallbacks: fallbacks ?? 0,
            },
          }
        }),
    }
  }),
)
