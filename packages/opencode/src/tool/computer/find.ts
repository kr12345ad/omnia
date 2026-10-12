import { Effect, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import { computeAim, isCenterGuess, type Aim } from "@opencode-ai/omnia/computer-use/aim"
import { MATCH_THRESHOLD } from "@opencode-ai/omnia/computer-use/match-score"
import * as Tool from "../tool"
import DESCRIPTION from "./find.txt"
import { configFromEnv, computerId, request } from "./client"
import { observationRefusal, recordObservation } from "./switch"

export const Parameters = Schema.Struct({
  query: Schema.String.annotate({ description: "What to look for, for example Export button." }),
  role: Schema.optional(Schema.String).annotate({
    description: "Control kind filter: button, textbox, menuitem, link, checkbox, window, dialog.",
  }),
  window: Schema.optional(Schema.String).annotate({
    description: "Window title or application fragment; restricts matches to that window.",
  }),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))).annotate({
    description: "Maximum candidates to return. Defaults to 5.",
  }),
})

type Element = {
  id?: string
  ref?: string
  role?: string
  name?: string
  text?: string
  description?: string
  value?: unknown
  states?: string[]
  actions?: string[]
  bounds?: { x: number; y: number; width: number; height: number }
  focusPoint?: unknown
  aimHint?: unknown
  metadata?: Record<string, unknown>
}

type Candidate = {
  element: Element
  reference?: { elementId?: string; observationId?: string }
  score: number
  reason?: string
}

type FindResponse = {
  ok: true
  result: {
    query?: string
    matches?: Candidate[]
    results?: Candidate[]
    observation?: { id?: string }
    truncated?: boolean
  }
}

function elementRef(candidate: Candidate): string {
  return candidate.reference?.elementId ?? candidate.element.id ?? candidate.element.ref ?? "?"
}

function pointOf(raw: unknown): { x: number; y: number } | undefined {
  if (typeof raw !== "object" || raw === null) return undefined
  const x = (raw as { x?: unknown }).x
  const y = (raw as { y?: unknown }).y
  if (typeof x !== "number" || !Number.isFinite(x) || typeof y !== "number" || !Number.isFinite(y)) return undefined
  return { x, y }
}

function hintPointOf(element: Element): { x: number; y: number } | undefined {
  return pointOf(element.aimHint) ?? pointOf(element.metadata?.aimHint)
}

function focusPointOf(element: Element): { x: number; y: number } | undefined {
  return pointOf(element.focusPoint) ?? pointOf(element.metadata?.focusPoint)
}

// The point the runtime aims at, resolved from the control's own metadata. A
// bounds-center result is a recorded guess: the control exposes no focus point,
// no provider hint, and no role-specific point, so the caller must label it
// instead of letting it read like a precise coordinate (rule 2).
function aimOf(element: Element): Aim | undefined {
  if (element.bounds === undefined) return undefined
  return computeAim({
    bounds: element.bounds,
    role: element.role,
    focusPoint: focusPointOf(element),
    aimHint: hintPointOf(element),
  })
}

function isGuessedAim(element: Element): boolean {
  const aim = aimOf(element)
  return aim !== undefined && isCenterGuess(aim)
}

function plural(count: number): string {
  return count === 1 ? "" : "s"
}

function describe(candidate: Candidate): string {
  const element = candidate.element
  const label = element.name ?? element.text ?? element.id ?? "element"
  const aim = aimOf(element)
  const aimText =
    aim === undefined
      ? ""
      : ` aim=${aim.x},${aim.y} strategy=${aim.strategy}${isCenterGuess(aim) ? " (guess)" : ""}`
  const value =
    element.value === undefined
      ? ""
      : ` value="${(typeof element.value === "string" ? element.value : JSON.stringify(element.value)).slice(0, 40)}"`
  const states = element.states === undefined || element.states.length === 0 ? "" : ` [${element.states.join(", ")}]`
  const actions =
    element.actions === undefined || element.actions.length === 0 ? "" : ` actions=${element.actions.join(",")}`
  const description = element.description === undefined ? "" : ` — ${element.description.slice(0, 80)}`
  const observation =
    candidate.reference?.observationId === undefined ? "" : ` observation=${candidate.reference.observationId}`
  return `${element.role ?? "unknown"} "${label}" id=${elementRef(candidate)}${aimText}${value}${states}${actions} confidence=${candidate.score.toFixed(2)}${observation}${description}`
}

export const ComputerFindTool = Tool.define<typeof Parameters, Record<string, unknown>, HttpClient.HttpClient>(
  "computer_find",
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
            patterns: [`find:${params.query}`],
            always: ["find:*"],
            metadata: { operation: "find", query: params.query, role: params.role ?? "any" },
          })
          const id = yield* computerId(http, config, ctx.sessionID)
          const result = yield* request<FindResponse>(http, config, "POST", `/v1/computers/${id}/find`, {
            query: params.query,
            ...(params.role === undefined ? {} : { role: params.role }),
            ...(params.window === undefined ? {} : { window: params.window }),
            limit: params.limit ?? 5,
          })
          const matches = result.result.matches ?? result.result.results ?? []
          const observationId = result.result.observation?.id
          const withObservation = observationId === undefined ? {} : { observationId }
          // Find hands out refs, and every ref is bound to the observation it was
          // read from, so a tree answered for another computer is refused instead
          // of handed over: acting on one of those refs would act on a different
          // machine's control (docs/computer-use-reliability.md rule 4).
          const foreign = [observationId, ...matches.map((match) => match.reference?.observationId)]
            .map((candidate) => observationRefusal(id, { observationId: candidate }))
            .find((message) => message !== undefined)
          if (foreign !== undefined) {
            const title = `Refused find: the tree answered for "${params.query}" is not this computer's`
            yield* ctx.metadata({ title, metadata: {} })
            return {
              title,
              output: `${foreign}\nNo candidates were returned.`,
              metadata: {
                query: params.query,
                matches: 0,
                refused: true,
                error: { code: "identity_not_for_this_computer", message: foreign },
              },
            }
          }
          if (observationId !== undefined) {
            recordObservation(id, observationId, matches.map((match) => match.element))
          }
          // One floor, shared with the router: a candidate that cannot reach
          // MATCH_THRESHOLD is not a target, so it is refused here and counted
          // rather than ranked as if it were actionable.
          const accepted = matches.filter((match) => match.score >= MATCH_THRESHOLD)
          const rejected = matches.length - accepted.length
          if (accepted.length === 0) {
            const title = `No confident match for ${params.query}`
            yield* ctx.metadata({ title, metadata: {} })
            return {
              title,
              output: [
                `No interface control matched "${params.query}" at the ${MATCH_THRESHOLD} confidence floor.`,
                ...(rejected === 0
                  ? []
                  : [
                      `${rejected} candidate${plural(rejected)} ${rejected === 1 ? "was" : "were"} rejected for scoring below the floor.`,
                    ]),
                `That is a miss, not a wording problem: narrow with role or window, observe again with computer_observe, computer_inspect a near-miss, or ground with computer_visual when the accessibility tree cannot see the control.`,
              ].join("\n"),
              metadata: { query: params.query, matches: 0, rejected, ...withObservation },
            }
          }
          const lines = accepted.map((match, index) => `${index + 1}. ${describe(match)}`)
          if (result.result.truncated) lines.push("… more candidates omitted; narrow the query or role.")
          // A centre-of-bounds aim carries no evidence about where the control
          // actually is, so the line says so instead of presenting a guess as
          // an exact point.
          if (accepted.some((match) => isGuessedAim(match.element))) {
            lines.push(
              'strategy "bounds-center" on a candidate means the control exposes no focus point, no provider hint, and no role-specific point: do not trust that point — re-resolve by ref, or computer_inspect the control for a better target.',
            )
          }
          if (rejected > 0) {
            lines.push(
              `${rejected} candidate${plural(rejected)} rejected for scoring below the ${MATCH_THRESHOLD} confidence floor; a weak match is not a target.`,
            )
          }
          if (observationId !== undefined) {
            lines.push(`observation ${observationId}: pass it as observationId with the target to detect staleness.`)
          }
          const best = accepted[0]
          const bestLabel = best.element.name ?? best.element.text ?? best.element.id ?? "element"
          const bestAim = aimOf(best.element)
          const title = `Found ${bestLabel}`
          yield* ctx.metadata({ title, metadata: {} })
          return {
            title,
            output: lines.join("\n"),
            metadata: {
              query: params.query,
              matches: accepted.length,
              rejected,
              ...withObservation,
              best: {
                id: elementRef(best),
                role: best.element.role,
                name: bestLabel,
                score: best.score,
                ...(bestAim === undefined ? {} : { aim: bestAim }),
                ...(best.reference?.observationId === undefined ? {} : { observationId: best.reference.observationId }),
              },
            },
          }
        }),
    }
  }),
)
