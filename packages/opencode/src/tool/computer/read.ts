import { Effect, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import { computeAim, isCenterGuess, type Aim } from "@opencode-ai/omnia/computer-use/aim"
import { MATCH_THRESHOLD } from "@opencode-ai/omnia/computer-use/match-score"
import * as Tool from "../tool"
import DESCRIPTION from "./read.txt"
import { ActionEnvelope, configFromEnv, computerId, request } from "./client"
import type { OmniaServerConfig } from "./client"
import { CAPS, clip, renderFailure } from "./output"
import { applicationOf } from "./policy"
import { observationRefusal } from "./switch"

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

type FindElement = {
  id?: string
  ref?: string
  role?: string
  name?: string
  text?: string
  bounds?: { x: number; y: number; width: number; height: number }
  parentId?: string
  focusPoint?: unknown
  aimHint?: unknown
  metadata?: Record<string, unknown>
}

type FindCandidate = {
  element: FindElement
  reference?: { elementId?: string; observationId?: string }
  score: number
}

type FindResponse = {
  ok: true
  result: {
    matches?: FindCandidate[]
    results?: FindCandidate[]
  }
}

/** The control a read resolved, described so the caller can act on it. */
type Surface = {
  ref: string
  parentRef?: string
  role?: string
  label: string
  aim?: Aim
  score: number
}

type Resolution =
  | { kind: "resolved"; target: string; surface: Surface; rejected: number }
  | { kind: "refused"; rejected: number; title: string; output: string }

// The server refuses two top candidates this close apart instead of picking
// one, so a read that resolves the query itself has to apply the same gap.
const AMBIGUITY_GAP = 0.08

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

function plural(count: number): string {
  return count === 1 ? "" : "s"
}

function pointOf(raw: unknown): { x: number; y: number } | undefined {
  if (typeof raw !== "object" || raw === null) return undefined
  const x = (raw as { x?: unknown }).x
  const y = (raw as { y?: unknown }).y
  if (typeof x !== "number" || !Number.isFinite(x) || typeof y !== "number" || !Number.isFinite(y)) return undefined
  return { x, y }
}

// The point the runtime aims at, resolved from the control's own metadata;
// bounds-center means the control offered nothing better than its box.
function aimOf(element: FindElement): Aim | undefined {
  if (element.bounds === undefined) return undefined
  return computeAim({
    bounds: element.bounds,
    role: element.role,
    focusPoint: pointOf(element.focusPoint) ?? pointOf(element.metadata?.focusPoint),
    aimHint: pointOf(element.aimHint) ?? pointOf(element.metadata?.aimHint),
  })
}

function candidateRef(candidate: FindCandidate): string | undefined {
  return candidate.reference?.elementId ?? candidate.element.id ?? candidate.element.ref
}

function surfaceOf(candidate: FindCandidate): Surface {
  const element = candidate.element
  const aim = aimOf(element)
  const parentRef = element.parentId
  return {
    ref: candidateRef(candidate) ?? "?",
    ...(parentRef === undefined ? {} : { parentRef }),
    ...(element.role === undefined ? {} : { role: element.role }),
    label: element.name ?? element.text ?? element.id ?? "surface",
    ...(aim === undefined ? {} : { aim }),
    score: candidate.score,
  }
}

function candidateLabel(candidate: FindCandidate): string {
  const label = candidate.element.name ?? candidate.element.text ?? candidateRef(candidate) ?? "?"
  return `${candidate.element.role ?? "element"} "${label}" (id=${candidateRef(candidate) ?? "?"}, confidence=${candidate.score.toFixed(2)})`
}

// A query read resolves the control the same way a click would: through the
// ranked matcher, behind the shared confidence floor, so a weak match is
// refused instead of read as if it were the requested surface.
function resolveSurface(
  http: HttpClient.HttpClient,
  config: OmniaServerConfig,
  id: string,
  query: string,
  params: ReadParams,
): Effect.Effect<Resolution> {
  return Effect.gen(function* () {
    const found = yield* request<FindResponse>(http, config, "POST", `/v1/computers/${id}/find`, {
      query,
      ...(params.role === undefined ? {} : { role: params.role }),
      ...(params.window === undefined ? {} : { window: params.window }),
      limit: 5,
    })
    const matches = found.result.matches ?? found.result.results ?? []
    const accepted = matches.filter((match) => match.score >= MATCH_THRESHOLD)
    const rejected = matches.length - accepted.length
    const best = accepted[0]
    const ref = best === undefined ? undefined : candidateRef(best)
    if (best === undefined || ref === undefined) {
      return {
        kind: "refused",
        rejected,
        title: `No confident surface for ${query}`,
        output: [
          ref === undefined
            ? `The best match for "${query}" has no stable identifier, so it cannot be read by ref.`
            : `No surface matched "${query}" at the ${MATCH_THRESHOLD} confidence floor.`,
          ...(rejected > 0
            ? [
                `${rejected} candidate${plural(rejected)} ${rejected === 1 ? "was" : "were"} rejected for scoring below the floor; a weak match is not a target.`,
              ]
            : []),
          `Re-find with computer_find, narrow with role or window, observe again with computer_observe, or ground with computer_visual when the accessibility tree cannot see the surface.`,
        ].join("\n"),
      }
    }
    const challenger = accepted[1]
    if (
      challenger !== undefined &&
      candidateRef(challenger) !== ref &&
      best.score - challenger.score < AMBIGUITY_GAP
    ) {
      const candidates = accepted.slice(0, 3).map(candidateLabel).join(", ")
      return {
        kind: "refused",
        rejected,
        title: `Read of "${query}" is ambiguous`,
        output: `"${query}" matched more than one surface: ${candidates}. Pass the target element id of the one you want, or narrow with role or window.`,
      }
    }
    return { kind: "resolved", target: ref, surface: surfaceOf(best), rejected }
  })
}

function describeSurface(surface: Surface): string {
  const aim = surface.aim
  const guess = aim !== undefined && isCenterGuess(aim) ? " — guess: do not trust this point" : ""
  return [
    `read ${surface.role ?? "surface"} "${surface.label}" ref=${surface.ref}`,
    surface.parentRef === undefined ? undefined : `parent=${surface.parentRef}`,
    aim === undefined ? undefined : `aim=${aim.x},${aim.y} strategy=${aim.strategy}${guess}`,
    `confidence=${surface.score.toFixed(2)}`,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" ")
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
          const id = yield* computerId(http, config, ctx.sessionID)
          // A ref or observation this session read off another computer, or that
          // a switch invalidated, is refused before anything is read with it:
          // resolving it here would read another machine's surface, and an
          // invalidated ref is never rebound to whatever matches now (rule 4).
          const refused = observationRefusal(id, { observationId: params.observationId, ref: params.target })
          if (refused !== undefined) {
            const title = `Refused read of ${params.target ?? params.query ?? params.window ?? app ?? "desktop"}`
            yield* ctx.metadata({ title, metadata: {} })
            return {
              title,
              output: `${refused}\nNothing was read.`,
              metadata: {
                success: false,
                refused: true,
                error: { code: "identity_not_for_this_computer", message: refused },
              },
            }
          }
          yield* ctx.ask({
            permission: "computer",
            patterns: [`read:${params.target ?? params.query ?? params.window ?? app ?? "desktop"}`],
            always: ["read:*"],
            metadata: { operation: "read_text", query: params.query, target: params.target },
          })
          const query = params.query?.trim()
          const resolution =
            params.target === undefined && query !== undefined && query.length > 0
              ? yield* resolveSurface(http, config, id, query, params)
              : undefined
          if (resolution !== undefined && resolution.kind === "refused") {
            yield* ctx.metadata({ title: resolution.title, metadata: {} })
            return {
              title: resolution.title,
              output: resolution.output,
              metadata: { success: false, rejected: resolution.rejected },
            }
          }
          const resolved = resolution?.kind === "resolved" ? resolution : undefined
          const target = params.target ?? resolved?.target
          const surface = resolved?.surface
          const rejected = resolved?.rejected ?? 0
          const result = yield* request<ReadResponse>(
            http,
            config,
            "POST",
            `/v1/computers/${id}/actions`,
            {
              action: "read_text",
              ...(target === undefined
                ? {}
                : {
                    target: {
                      elementId: target,
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
              metadata: { success: false, error: outcome.error?.code, ...(rejected > 0 ? { rejected } : {}) },
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
          const output = [
            ...(surface === undefined ? [] : [describeSurface(surface)]),
            `${clip(text, CAPS.readText)}\n\n${marker}`,
          ]
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
          if (rejected > 0) {
            output.push(
              `${rejected} candidate${plural(rejected)} scored below the ${MATCH_THRESHOLD} confidence floor and ${rejected === 1 ? "was" : "were"} not read.`,
            )
          }
          if (surface?.aim !== undefined && isCenterGuess(surface.aim)) {
            output.push(
              'aim strategy "bounds-center" is a guess: the surface exposes no focus point, no provider hint, and no role-specific point, so do not trust that point — re-resolve it by ref before acting on it.',
            )
          }
          return {
            title,
            output: output.join("\n"),
            metadata: {
              success: true,
              length: totalLength,
              offset,
              returned: text.length,
              truncated,
              hash,
              rejected,
              ...(surface === undefined
                ? {}
                : {
                    ref: surface.ref,
                    ...(surface.parentRef === undefined ? {} : { parentRef: surface.parentRef }),
                    ...(surface.aim === undefined ? {} : { aim: surface.aim }),
                  }),
            },
          }
        }),
    }
  }),
)
