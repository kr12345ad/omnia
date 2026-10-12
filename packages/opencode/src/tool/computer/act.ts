import { Effect, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import { computeAim } from "@opencode-ai/omnia/computer-use/aim"
import { MATCH_THRESHOLD, scoreMatch } from "@opencode-ai/omnia/computer-use/match-score"
import * as Tool from "../tool"
import DESCRIPTION from "./act.txt"
import { ActionEnvelope, configFromEnv, computerId, request } from "./client"
import type { OmniaServerConfig } from "./client"
import { UI_ACTIONS } from "./actions"
import { observationRefusal, recordObservation } from "./switch"
import {
  TILE_POSITIONS,
  actPermissionPattern,
  alwaysPatternsForAct,
  permissionText,
  scopesForAct,
  shortenCommand,
  validateAction,
} from "./policy"
import { CAPS, clip, renderFailure } from "./output"
import type { SessionID } from "@/session/schema"

export const ACTIONS = UI_ACTIONS

const Endpoint = Schema.Struct({
  elementId: Schema.optional(Schema.String),
  x: Schema.optional(Schema.Int),
  y: Schema.optional(Schema.Int),
}).annotate({ description: "A drag endpoint: either an element ID or explicit x,y coordinates." })

export const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({
    description: "The interface action to perform.",
  }),
  target: Schema.optional(Schema.String).annotate({
    description:
      "Stable element ID from computer_find, computer_observe, or computer_snapshot, for example cua:window/kitty/OC | Quick hello/3/button/Minimize/1 or atspi:3.5. It is resolved against a live observation and refused when it is no longer there, so always pair it with observationId. One of target or query is required for click, double_click, right_click, middle_click, hover, type, focus, move, scroll, and set_value.",
  }),
  query: Schema.optional(Schema.String).annotate({
    description:
      "Control to act on by meaning, for example 'Export button'. Resolved locally against the current observation with the shared 0.6 match floor: below it nothing is clicked.",
  }),
  role: Schema.optional(Schema.String).annotate({ description: "Optional role filter for query, for example button." }),
  window: Schema.optional(Schema.String).annotate({
    description:
      "Window title fragment. For focus_window it selects the window; for type, key, hotkey, and paste it focuses that window first.",
  }),
  observationId: Schema.optional(Schema.String).annotate({
    description:
      "Observation the target came from, from computer_snapshot or computer_observe. Pass it with every target: a ref that is not in that observation is refused as stale instead of being rebound to whatever matches now. Defaults to the newest observation for the computer.",
  }),
  text: Schema.optional(Schema.String).annotate({ description: "Text for the type and set_value actions." }),
  start: Schema.optional(Schema.String).annotate({
    description: "Optional marker for type: skip everything before it. The runtime refuses to type if it is absent.",
  }),
  stop: Schema.optional(Schema.String).annotate({
    description: "Optional marker for type: stop immediately after it. The runtime refuses to type if it is absent.",
  }),
  endKey: Schema.optional(Schema.String).annotate({
    description: "Optional key pressed after typing finishes, for example Return.",
  }),
  key: Schema.optional(Schema.String).annotate({
    description: "Key for the key action: a character or Return, Tab, Escape, BackSpace, Delete, arrows, F1-F12.",
  }),
  keys: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Key combination for hotkey, for example ['ctrl','shift','t'].",
  }),
  app: Schema.optional(Schema.String).annotate({
    description: "Application name or command for launch_app, activate_app, and close_app.",
  }),
  url: Schema.optional(Schema.String).annotate({ description: "http:// or https:// URL for open_url." }),
  path: Schema.optional(Schema.String).annotate({ description: "Filesystem path for open_file." }),
  direction: Schema.optional(Schema.Literals(["up", "down", "left", "right"])).annotate({
    description: "Scroll direction for the scroll action.",
  }),
  amount: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))).annotate({
    description:
      "Scroll steps, wait milliseconds, hover hold milliseconds, or pointer travel milliseconds for click/move/drag. Defaults depend on the action.",
  }),
  button: Schema.optional(Schema.Literals(["left", "middle", "right"])).annotate({
    description: "Mouse button for mouse_down and mouse_up. Defaults to left.",
  }),
  rows: Schema.optional(
    Schema.Array(Schema.Array(Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null]))),
  ).annotate({
    description: "2D array for paste_table; fills the target range in one paste.",
  }),
  x: Schema.optional(Schema.Int).annotate({
    description:
      "Screen x coordinate for pointer actions. Only honoured on a declared canvas surface (surface) or with allowCoordinates when no accessible control resolves there; a pixel that lands on a control is refused.",
  }),
  y: Schema.optional(Schema.Int).annotate({
    description: "Screen y coordinate for pointer actions. See x for when raw pixels are accepted at all.",
  }),
  surface: Schema.optional(Schema.Union([Schema.Literals(["canvas"]), Schema.Boolean])).annotate({
    description:
      'Declares that the surface being addressed has no accessible controls: true or "canvas". This is the only unconditional permission to use x/y, because a canvas cannot be addressed by ref.',
  }),
  allowCoordinates: Schema.optional(Schema.Boolean).annotate({
    description:
      "Allow x/y pixels for this pointer action when no accessible control resolves under the point. The runtime refuses the pixels when a control is there, so the point is never a blind guess inside a real button.",
  }),
  from: Schema.optional(Endpoint).annotate({ description: "Start of a drag action." }),
  to: Schema.optional(Endpoint).annotate({ description: "End of a drag action, for example an image resize handle." }),
  position: Schema.optional(Schema.Literals(TILE_POSITIONS)).annotate({
    description: "Window position for window_tile.",
  }),
  point: Schema.optional(Schema.String).annotate({
    description: "Calibration point id returned by calibration_start, for calibration_measure.",
  }),
  command: Schema.optional(Schema.String).annotate({
    description:
      "Shell command for run_command, for example 'ls -la' or 'sudo systemctl restart nginx'. Runs on the connected computer and returns exit code, stdout, and stderr.",
  }),
  cwd: Schema.optional(Schema.String).annotate({ description: "Working directory for run_command." }),
  timeoutMs: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 600000 }))).annotate({
    description: "Timeout in milliseconds for run_command. Defaults to 120000 and is capped at 600000.",
  }),
  credential: Schema.optional(Schema.String).annotate({
    description:
      "Credential selection for run_command and type: 'auto' uses a stored credential whose rules match, 'none' disables stored credentials, or a credential id or name. With a credential, type ignores text and enters the stored value instead. Stored credentials are managed in Settings > Computer > Computers; their secrets are never shown to the model.",
  }),
  field: Schema.optional(Schema.Literals(["username", "secret"])).annotate({
    description:
      'Which part of the stored credential to type: "secret" (default) or "username". Only used when credential is set.',
  }),
})

// ---------------------------------------------------------------------------
// Targeting
//
// docs/computer-use-reliability.md: an action that lands on a control resolves
// before the runtime is asked to perform it. The tool reads the current
// observation and refuses anything it cannot resolve honestly — a ref from an
// older generation, a semantic query under the shared match floor, or raw
// pixels over a real control. A refusal never falls back to another targeting
// mode, and it never prompts for approval of an action that will not run.
// ---------------------------------------------------------------------------

/** Actions that address one control and therefore must resolve a target. */
const ELEMENT_ACTIONS: ReadonlySet<string> = new Set([
  "click",
  "double_click",
  "right_click",
  "middle_click",
  "hover",
  "move",
  "mouse_down",
  "mouse_up",
  "type",
  "focus",
  "set_value",
  "select",
  "toggle",
  "expand",
  "collapse",
  "increment",
  "decrement",
  "scroll_into_view",
  "scroll",
  "menu",
  "drag",
])

// A ref is either the cua: form ("cua:window/kitty/OC | Quick hello/3/button/Minimize/1")
// or a provider id such as "atspi:3.5". A description never carries a colon
// before its first space, so the shape separates a ref from a name.
const REF_PATTERN = /^[a-z][a-z0-9+.-]{0,15}:\S/

function isElementRef(target: string): boolean {
  return REF_PATTERN.test(target)
}

function isCanvasSurface(surface: boolean | "canvas" | undefined): boolean {
  return surface === true || surface === "canvas"
}

const ElementShape = Schema.Struct({
  id: Schema.optional(Schema.String),
  ref: Schema.optional(Schema.String),
  reference: Schema.optional(
    Schema.Struct({ elementId: Schema.optional(Schema.String), id: Schema.optional(Schema.String) }),
  ),
  role: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  states: Schema.optional(Schema.Array(Schema.String)),
  actions: Schema.optional(Schema.Array(Schema.String)),
  bounds: Schema.optional(
    Schema.Struct({ x: Schema.Number, y: Schema.Number, width: Schema.Number, height: Schema.Number }),
  ),
  aim: Schema.optional(Schema.Struct({ x: Schema.Number, y: Schema.Number, strategy: Schema.optional(Schema.String) })),
  focusPoint: Schema.optional(Schema.Unknown),
  aimHint: Schema.optional(Schema.Unknown),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})

const ObservationShape = Schema.Struct({
  ok: Schema.Boolean,
  observation: Schema.Struct({
    id: Schema.String,
    elements: Schema.optional(Schema.Array(ElementShape)),
  }),
})

type Element = Schema.Schema.Type<typeof ElementShape>
type ObservationBody = Schema.Schema.Type<typeof ObservationShape>
type Observation = { id: string; elements: readonly Element[] }

type Aim = { x: number; y: number; strategy: string }

interface TargetingInput {
  action: string
  target?: string
  query?: string
  role?: string
  window?: string
  observationId?: string
  surface?: boolean | "canvas"
  allowCoordinates?: boolean
  x?: number
  y?: number
  from?: { elementId?: string; x?: number; y?: number }
  to?: { elementId?: string; x?: number; y?: number }
}

type Targeting =
  | { kind: "skipped" }
  | { kind: "resolved"; element: Element; aim?: Aim; confidence: number }
  | { kind: "coordinates"; aim: Aim }
  | { kind: "refused"; code: string; message: string }

function refOf(element: Element): string | undefined {
  return element.id ?? element.ref ?? element.reference?.elementId ?? element.reference?.id
}

function pointOf(value: unknown): { x: number; y: number } | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const x = (value as { x?: unknown }).x
  const y = (value as { y?: unknown }).y
  if (typeof x !== "number" || !Number.isFinite(x) || typeof y !== "number" || !Number.isFinite(y)) return undefined
  return { x, y }
}

/**
 * The point this action is aimed at. Element metadata decides it — a provider
 * hint, a focus point, a role-specific point, or the control centre — and only
 * a role that says nothing about where it is actionable falls back to the
 * centre of the bounds, which is reported as a guess.
 */
function aimOf(element: Element): Aim | undefined {
  const explicit = element.aim
  if (explicit !== undefined) return { x: explicit.x, y: explicit.y, strategy: explicit.strategy ?? "provider-hint" }
  const bounds = element.bounds
  if (bounds === undefined) return undefined
  const computed = computeAim({
    bounds,
    role: element.role,
    focusPoint: pointOf(element.focusPoint ?? element.metadata?.focusPoint),
    aimHint: pointOf(element.aimHint ?? element.metadata?.aimHint),
  })
  return { x: computed.x, y: computed.y, strategy: computed.strategy }
}

function describeElement(element: Element): string {
  const label = element.name ?? element.text ?? refOf(element) ?? "unnamed control"
  const ref = refOf(element)
  return `${element.role ?? "control"} "${label}"${ref === undefined ? "" : ` ref=${ref}`}`
}

function containsPoint(bounds: Element["bounds"], x: number, y: number): boolean {
  if (bounds === undefined) return false
  return x >= bounds.x && x <= bounds.x + bounds.width && y >= bounds.y && y <= bounds.y + bounds.height
}

function areaOf(bounds: Element["bounds"]): number {
  return bounds === undefined ? Number.MAX_SAFE_INTEGER : bounds.width * bounds.height
}

/**
 * The smallest control that contains the point. Windows and applications are
 * skipped: they contain every point on the screen, so they would make every
 * pixel look like it addresses a control.
 */
function elementAtPoint(elements: readonly Element[], x: number, y: number): Element | undefined {
  const roles = new Set(["window", "application"])
  return elements
    .filter((element) => !roles.has((element.role ?? "").toLowerCase()) && containsPoint(element.bounds, x, y))
    .sort((left, right) => areaOf(left.bounds) - areaOf(right.bounds))[0]
}

function searchedIn(observation: Observation | undefined, observationId: string | undefined): string {
  const id = observationId ?? observation?.id
  return id === undefined ? "the current observation" : `observation ${id}`
}

function snapshotAdvice(observationId: string | undefined): string {
  const id = observationId === undefined ? "" : ` ${observationId}`
  return (
    `Take a fresh snapshot with computer_snapshot (or computer_find), then act on the ref and observationId it returns.` +
    (id.length === 0 ? "" : ` The failed target claimed observation${id}.`)
  )
}

/** The observation the runtime resolves against: newest first, then unscoped. */
function observeForAct(
  http: HttpClient.HttpClient,
  config: OmniaServerConfig,
  computer: string,
  sessionID: SessionID,
  window: string | undefined,
): Effect.Effect<Observation | undefined> {
  return Effect.gen(function* () {
    const scoped = yield* readObservation(http, config, computer, sessionID, window)
    if (scoped !== undefined || window === undefined) return scoped
    // A window fragment that no longer matches must not cost the action its
    // target: re-read the whole desktop rather than acting blind.
    return yield* readObservation(http, config, computer, sessionID, undefined)
  })
}

function readObservation(
  http: HttpClient.HttpClient,
  config: OmniaServerConfig,
  computer: string,
  sessionID: SessionID,
  window: string | undefined,
): Effect.Effect<Observation | undefined> {
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
      ...(window === undefined ? {} : { window }),
    },
    { validate: Schema.is(ObservationShape) },
  ).pipe(
    Effect.map((body) => ({ id: body.observation.id, elements: body.observation.elements ?? [] })),
    // An unreadable interface is never a reason to act: the caller refuses.
    Effect.catchCause(() => Effect.succeed(undefined)),
  )
}

function needsObservation(input: TargetingInput): boolean {
  if (!ELEMENT_ACTIONS.has(input.action)) return false
  if (input.target !== undefined || input.query !== undefined) return true
  return coordinatePoints(input).length > 0 && !isCanvasSurface(input.surface)
}

/** The pixels this action would land on, whether top-level or a drag endpoint. */
function coordinatePoints(input: TargetingInput): { x: number; y: number; label: string }[] {
  if (input.x !== undefined && input.y !== undefined) return [{ x: input.x, y: input.y, label: "the requested pixel" }]
  if (input.action !== "drag") return []
  return [input.from, input.to].flatMap((endpoint, index) =>
    endpoint !== undefined &&
    endpoint.elementId === undefined &&
    typeof endpoint.x === "number" &&
    typeof endpoint.y === "number"
      ? [{ x: endpoint.x, y: endpoint.y, label: index === 0 ? "the drag start" : "the drag end" }]
      : [],
  )
}

function resolveElementTarget(input: TargetingInput, observation: Observation | undefined): Targeting {
  const target = input.target?.trim() ?? ""
  const label = isElementRef(target) ? `ref "${target}"` : `element id "${target}"`
  if (observation === undefined) {
    return {
      kind: "refused",
      code: "observation_unavailable",
      message:
        `The current interface could not be read, so the ${label} cannot be resolved and nothing was acted on. ` +
        snapshotAdvice(input.observationId),
    }
  }
  const element = observation.elements.find((entry) => refOf(entry) === target)
  if (element === undefined) {
    return {
      kind: "refused",
      code: "target_stale",
      message: isElementRef(target)
        ? `The ref "${target}" is not in ${searchedIn(observation, input.observationId)} (` +
          `${observation.elements.length} elements were read), so it belongs to an older state of the interface and is never ` +
          `rebound to whatever matches now. ${snapshotAdvice(input.observationId)}`
        : `No element with the id "${target}" is in ${searchedIn(observation, input.observationId)} (` +
          `${observation.elements.length} elements were read), so there is nothing to act on and no guess was made. ` +
          snapshotAdvice(input.observationId),
    }
  }
  return { kind: "resolved", element, aim: aimOf(element), confidence: 1 }
}

function resolveQueryTarget(input: TargetingInput, observation: Observation | undefined): Targeting {
  const query = input.query?.trim() ?? ""
  if (observation === undefined) {
    return {
      kind: "refused",
      code: "observation_unavailable",
      message:
        `The current interface could not be read, so the query "${query}" cannot be resolved and nothing was acted on. ` +
        snapshotAdvice(input.observationId),
    }
  }
  const role = input.role?.trim().toLowerCase()
  const window = input.window?.trim()
  const candidates =
    role === undefined || role.length === 0
      ? observation.elements
      : observation.elements.filter((element) => (element.role ?? "").toLowerCase().includes(role))
  const searched =
    `searched "${query}"` +
    (role === undefined || role.length === 0 ? "" : ` with role "${role}"`) +
    (window === undefined || window.length === 0 ? "" : ` in window "${window}"`) +
    ` against ${candidates.length} elements in ${searchedIn(observation, input.observationId)}`
  const scored = candidates.map((element) => ({
    element,
    score: scoreMatch(query, { name: element.name, role: element.role, text: element.text }),
  }))
  const closest = scored.reduce<{ element: Element; score: number } | undefined>(
    (highest, entry) => (highest === undefined || entry.score > highest.score ? entry : highest),
    undefined,
  )
  const floor = scored.filter((entry) => entry.score >= MATCH_THRESHOLD)
  if (floor.length === 0) {
    return {
      kind: "refused",
      code: "target_not_found",
      message:
        `No control matched the query: ${searched}; the closest candidate was ` +
        `${closest === undefined ? "nothing" : `${describeElement(closest.element)} at ${closest.score.toFixed(2)}`}, ` +
        `below the ${MATCH_THRESHOLD} floor. Refusing to ${input.action} instead of guessing. Take a fresh snapshot ` +
        `with computer_snapshot (or computer_find) and act on a ref, or name the control more precisely.`,
    }
  }
  const top = floor.reduce((highest, entry) => Math.max(highest, entry.score), 0)
  const winners = floor.filter((entry) => entry.score === top)
  const distinct = new Set(
    winners.flatMap((entry) => (refOf(entry.element) === undefined ? [] : [refOf(entry.element)])),
  )
  if (distinct.size > 1) {
    return {
      kind: "refused",
      code: "ambiguous_target",
      message:
        `The query is ambiguous: ${distinct.size} controls tie at ${top.toFixed(2)} in ${searchedIn(observation, input.observationId)} ` +
        `(${winners.map((entry) => describeElement(entry.element)).join(", ")}). Refusing to ${input.action} instead of picking one. ` +
        `Narrow with role or window, or act on a ref from a fresh snapshot.`,
    }
  }
  return { kind: "resolved", element: winners[0].element, aim: aimOf(winners[0].element), confidence: top }
}

function resolveCoordinate(
  input: TargetingInput,
  observation: Observation | undefined,
  point: { x: number; y: number; label: string },
): Targeting {
  if (isCanvasSurface(input.surface)) {
    return { kind: "coordinates", aim: { x: point.x, y: point.y, strategy: "explicit-coordinate" } }
  }
  if (input.allowCoordinates !== true) {
    return {
      kind: "refused",
      code: "coordinates_required",
      message:
        `Refusing to act on ${point.label} (${point.x},${point.y}): raw pixels are only accepted on a declared canvas surface ` +
        `(surface: "canvas") or with allowCoordinates: true when no accessible control resolves there. Resolve the control ` +
        `instead with computer_find, computer_snapshot, or a query, and use the aim point it reports.`,
    }
  }
  if (observation === undefined) {
    return {
      kind: "refused",
      code: "observation_unavailable",
      message:
        `The current interface could not be read, so nothing can prove that ${point.label} (${point.x},${point.y}) is empty ` +
        `canvas. ${snapshotAdvice(input.observationId)}`,
    }
  }
  const element = elementAtPoint(observation.elements, point.x, point.y)
  if (element !== undefined) {
    return {
      kind: "refused",
      code: "coordinate_on_control",
      message:
        `Refusing to act on ${point.label} (${point.x},${point.y}): ${describeElement(element)} sits there, so the pixel would ` +
        `be a guess inside a real control. Act on that control with its ref or a query, or declare surface: "canvas" only if ` +
        `the surface truly exposes no controls.`,
    }
  }
  return { kind: "coordinates", aim: { x: point.x, y: point.y, strategy: "explicit-coordinate" } }
}

function resolveTargeting(input: TargetingInput, observation: Observation | undefined): Targeting {
  if (!ELEMENT_ACTIONS.has(input.action)) return { kind: "skipped" }
  // A ref or a query always decides the target; pixels are only consulted when
  // neither is present, so they can never override a resolvable control.
  if (input.target !== undefined && input.target.trim().length > 0) return resolveElementTarget(input, observation)
  if (input.query !== undefined && input.query.trim().length > 0) return resolveQueryTarget(input, observation)
  const points = coordinatePoints(input)
  if (points.length === 0) return { kind: "skipped" }
  const aims = points.map((point) => resolveCoordinate(input, observation, point))
  const refusal = aims.find((aiming) => aiming.kind === "refused")
  if (refusal !== undefined) return refusal
  return aims[0]
}

/**
 * A caller-supplied identity this session read off another computer, or that a
 * switch invalidated, is refused before it is resolved against this computer's
 * tree: a ref never travels between computers, and an invalidated ref is never
 * rebound to whatever matches now (docs/computer-use-reliability.md rule 4).
 */
function identityRefusal(computer: string, input: TargetingInput): Targeting | undefined {
  const message = observationRefusal(computer, { observationId: input.observationId, ref: input.target })
  if (message === undefined) return undefined
  return { kind: "refused", code: "identity_not_for_this_computer", message }
}

type ActResponse = {
  ok: true
  result: {
    success: boolean
    status?: string
    message?: string
    text?: string
    length?: number
    hash?: string
    observation?: { id: string; text?: string; metadata?: Record<string, unknown> }
    verification?: { status?: string; message?: string }
    command?: {
      exitCode: number | null
      stdout: string
      stderr: string
      truncated?: boolean
      timedOut?: boolean
      durationMs?: number
    }
    metadata?: {
      target?: { role?: string; name?: string }
      stateDelta?: { summary?: string; hasChanges?: boolean; highlights?: readonly string[] }
      context?: readonly string[]
      value?: unknown
      credentials?: readonly {
        id?: string
        name?: string
        kind?: string
        username?: string
        enabled?: boolean
        rules?: readonly { kind?: string; match?: string }[]
      }[]
      credential?: { id?: string; name?: string }
      exitCode?: number | null
      preview?: string
      length?: number
      hash?: string
    }
    error?: {
      code?: string
      message: string
      details?: { missing?: readonly string[]; credential?: { name?: string } }
    }
  }
}

const ACTION_LABEL: Record<string, string> = {
  click: "Clicked",
  double_click: "Double-clicked",
  right_click: "Right-clicked",
  type: "Typed into",
  key: "Pressed key",
  hotkey: "Sent shortcut",
  focus: "Focused",
  focus_window: "Focused window",
  scroll: "Scrolled",
  move: "Moved pointer",
  launch_app: "Launched",
  activate_app: "Activated",
  close_app: "Closed",
  open_file: "Opened",
  open_url: "Opened",
  drag: "Dragged",
  copy: "Copied",
  paste: "Pasted",
  paste_table: "Pasted table",
  wait: "Waited",
  read_text: "Read text",
  get_focus: "Checked focus",
  release_keys: "Released keys",
  read_clipboard: "Read clipboard",
  write_clipboard: "Wrote clipboard",
  dismiss: "Dismissed",
  middle_click: "Middle-clicked",
  hover: "Hovered",
  mouse_down: "Held mouse button",
  mouse_up: "Released mouse button",
  get_cursor: "Read pointer position",
  menu: "Selected menu",
  set_value: "Set value of",
  select: "Selected",
  toggle: "Toggled",
  expand: "Expanded",
  collapse: "Collapsed",
  increment: "Incremented",
  decrement: "Decremented",
  scroll_into_view: "Scrolled into view",
  read_value: "Read value",
  run_command: "Ran command",
  credentials: "Listed credentials",
}

export const ComputerActTool = Tool.define<typeof Parameters, Record<string, unknown>, HttpClient.HttpClient>(
  "computer_act",
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params, ctx) =>
        Effect.gen(function* () {
          validateAction(params)
          const config = yield* configFromEnv()
          const id = yield* computerId(http, config, ctx.sessionID)
          // Resolve before asking: a target that cannot be resolved must never
          // prompt for an action that will not run.
          const observation = needsObservation(params)
            ? yield* observeForAct(http, config, id, ctx.sessionID, params.window?.trim() || undefined)
            : undefined
          // The tree just read is the one the session holds for this computer,
          // and it is what makes a bare ref addressable here: a ref this tree
          // carries belongs to this computer whatever string another computer's
          // tree uses, so it is registered before an identity is judged.
          if (observation !== undefined) recordObservation(id, observation.id, observation.elements)
          const refused = identityRefusal(id, params)
          const targeting = refused ?? resolveTargeting(params, observation)
          if (targeting.kind === "refused") {
            const title = `Refused ${params.action} ${params.target ?? params.query ?? "target"} (${targeting.code})`
            yield* ctx.metadata({ title, metadata: {} })
            return {
              title,
              output: [targeting.message, "No action was performed."].join("\n"),
              metadata: {
                action: params.action,
                target: params.target,
                targetName: params.target ?? params.query ?? "target",
                success: false,
                verification: "refused",
                observationId: params.observationId ?? observation?.id,
                refused: true,
                error: { code: targeting.code, message: targeting.message },
              },
            }
          }
          yield* ctx.ask({
            permission: "computer",
            patterns: [actPermissionPattern(params)],
            always: alwaysPatternsForAct(params.action),
            metadata: {
              operation: "act",
              action: params.action,
              ...(params.target === undefined ? {} : { target: params.target }),
              ...(params.query === undefined ? {} : { query: params.query }),
              ...(params.app === undefined ? {} : { app: params.app }),
              ...(params.text === undefined ? {} : { text: permissionText(params.action, params.text) }),
              ...(params.key === undefined ? {} : { key: params.key }),
              ...(params.command === undefined ? {} : { command: shortenCommand(params.command) }),
              ...(params.credential === undefined ? {} : { credential: params.credential }),
            },
          })
          const result = yield* request<ActResponse>(
            http,
            config,
            "POST",
            `/v1/computers/${id}/actions`,
            {
              action: params.action,
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
              ...(params.text === undefined && params.position === undefined && params.point === undefined
                ? {}
                : { text: params.text ?? params.position ?? params.point }),
              ...(params.start === undefined ? {} : { start: params.start }),
              ...(params.stop === undefined ? {} : { stop: params.stop }),
              ...(params.endKey === undefined ? {} : { endKey: params.endKey }),
              ...(params.key === undefined ? {} : { key: params.key }),
              ...(params.keys === undefined ? {} : { keys: [...params.keys] }),
              ...(params.app === undefined ? {} : { app: params.app }),
              ...(params.url === undefined ? {} : { url: params.url }),
              ...(params.path === undefined ? {} : { path: params.path }),
              ...(params.direction === undefined ? {} : { direction: params.direction }),
              ...(params.amount === undefined ? {} : { amount: params.amount }),
              ...(params.button === undefined ? {} : { button: params.button }),
              ...(params.rows === undefined ? {} : { rows: params.rows }),
              ...(params.x === undefined || targeting.kind === "resolved" ? {} : { x: params.x }),
              ...(params.y === undefined || targeting.kind === "resolved" ? {} : { y: params.y }),
              ...(params.from === undefined ? {} : { from: params.from }),
              ...(params.to === undefined ? {} : { to: params.to }),
              ...(params.command === undefined ? {} : { command: params.command }),
              ...(params.cwd === undefined ? {} : { cwd: params.cwd }),
              ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
              ...(params.credential === undefined ? {} : { credential: params.credential }),
              ...(params.field === undefined ? {} : { field: params.field }),
              approve: true,
              approvedBy: `session:${ctx.sessionID}`,
              approvedScopes: scopesForAct(params),
              sessionId: ctx.sessionID,
            },
            { validate: Schema.is(ActionEnvelope) },
          )
          const outcome = result.result
          const resolved = targeting.kind === "resolved" ? targeting : undefined
          const resolvedElement = resolved?.element
          const targetName =
            typeof outcome.metadata?.target?.name === "string" && outcome.metadata.target.name.length > 0
              ? outcome.metadata.target.name
              : resolvedElement !== undefined
                ? (resolvedElement.name ?? resolvedElement.text ?? refOf(resolvedElement) ?? "control")
                : (params.target ??
                  params.query ??
                  params.app ??
                  params.url ??
                  params.path ??
                  shortenCommand(params.command) ??
                  "desktop")
          const verification = outcome.verification?.status ?? (outcome.success ? "unverified" : "failed")
          const statusLabel = !outcome.success ? (outcome.error?.code ?? outcome.status ?? "failed") : verification
          const title = `${ACTION_LABEL[params.action] ?? params.action} ${targetName} (${statusLabel})`
          yield* ctx.metadata({ title, metadata: {} })
          const lines = [outcome.message ?? `${params.action} ${outcome.success ? "completed" : "did not complete"}.`]
          // How the point was chosen: the resolved element's own aim, or the
          // caller's pixel on a declared surface.
          const aim = "aim" in targeting ? targeting.aim : undefined
          if (resolvedElement !== undefined) lines.push(`resolved: ${describeElement(resolvedElement)}`)
          if (aim !== undefined) {
            lines.push(`aim: ${aim.x},${aim.y} (${aim.strategy})`)
            if (aim.strategy === "bounds-center") {
              lines.push(
                "warning: that aim is the centre of the reported bounds because the element exposes no focus point, no aim hint, and no role that identifies an actionable region; treat it as a guess.",
              )
            }
          }
          if (outcome.metadata?.stateDelta?.summary)
            lines.push(`observed change: ${outcome.metadata.stateDelta.summary}`)
          if (outcome.command) {
            lines.push(`exit code: ${outcome.command.exitCode ?? "unknown"}`)
            if (outcome.command.stdout.trim().length > 0)
              lines.push(`stdout:\n${clip(outcome.command.stdout, CAPS.actText)}`)
            if (outcome.command.stderr.trim().length > 0)
              lines.push(`stderr:\n${clip(outcome.command.stderr, CAPS.actText)}`)
            if (outcome.command.truncated === true)
              lines.push("output was truncated; redirect to a file if you need all of it.")
          }
          if (params.action === "read_value" && outcome.metadata?.value !== undefined) {
            lines.push(`value: ${clip(JSON.stringify(outcome.metadata.value), CAPS.actText)}`)
          }
          if (params.action === "read_clipboard" && outcome.success) {
            const clipboard = outcome.text ?? outcome.metadata?.preview
            if (clipboard !== undefined && clipboard.length > 0) {
              lines.push(`clipboard:\n${clip(clipboard, CAPS.actText)}`)
            }
            const length = outcome.length ?? outcome.metadata?.length
            const hash = outcome.hash ?? outcome.metadata?.hash
            if (length !== undefined) lines.push(`[length=${length}${hash === undefined ? "" : ` hash=${hash}`}]`)
          }
          const storedCredentials = outcome.metadata?.credentials
          if (storedCredentials !== undefined) {
            if (storedCredentials.length === 0) lines.push("no stored credentials for this computer.")
            else {
              lines.push("stored credentials:")
              for (const entry of storedCredentials.slice(0, CAPS.credentialEntries)) {
                const rules = (entry.rules ?? []).map((rule) => `${rule.kind ?? "rule"}:${rule.match ?? ""}`).join(", ")
                lines.push(
                  `- ${entry.name ?? entry.id ?? "credential"} (${entry.kind ?? "password"})${entry.username === undefined ? "" : ` username ${entry.username}`}${rules.length === 0 ? "" : `; use for ${rules}`}${entry.enabled === false ? " [disabled]" : ""}`,
                )
              }
              if (storedCredentials.length > CAPS.credentialEntries) {
                lines.push(
                  `… [truncated: ${storedCredentials.length - CAPS.credentialEntries} of ${storedCredentials.length} credentials omitted]`,
                )
              }
              lines.push(
                'pass credential: "auto" to run_command to use the matching credential; the secret stays hidden.',
              )
            }
          }
          if (!outcome.success && outcome.error?.details?.credential?.name) {
            lines.push(
              `a stored credential "${outcome.error.details.credential.name}" matches this command; retry with credential: "auto" to use it.`,
            )
          }
          if (!outcome.success && Array.isArray(outcome.metadata?.context) && outcome.metadata.context.length > 0) {
            lines.push("current interface context:")
            for (const entry of outcome.metadata.context.slice(0, CAPS.actContextEntries)) lines.push(`- ${entry}`)
          }
          if (outcome.verification !== undefined) {
            const message = outcome.verification.message
            lines.push(
              message !== undefined && message !== outcome.metadata?.stateDelta?.summary
                ? `verification: ${verification} — ${message}`
                : `verification: ${verification}`,
            )
          }
          if (outcome.observation) {
            lines.push(
              `fresh observation ${outcome.observation.id}: re-read it with computer_observe or computer_find before the next action.`,
            )
          }
          if (outcome.error && !outcome.success)
            lines.push(`error: ${renderFailure(outcome.error, "The action failed.")}`)
          return {
            title,
            output: lines.join("\n"),
            metadata: {
              action: params.action,
              target: params.target,
              targetName,
              success: outcome.success,
              verification,
              observationId: outcome.observation?.id,
              ...(resolved === undefined
                ? {}
                : {
                    resolved: {
                      ref: refOf(resolved.element),
                      role: resolved.element.role,
                      name: resolved.element.name ?? resolved.element.text,
                      confidence: resolved.confidence,
                    },
                  }),
              ...(aim === undefined ? {} : { aim }),
            },
          }
        }),
    }
  }),
)
