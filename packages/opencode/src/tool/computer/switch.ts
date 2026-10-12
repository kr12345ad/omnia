import { Cause, Effect, Exit, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import { Session } from "@/session/session"
import { Tool } from "../tool"
import {
  COMPUTER_SELECTION_METADATA_KEY,
  configFromEnv,
  controlPlaneKey,
  latestObservation,
  rememberObservation,
  request,
} from "./client"
import type { OmniaServerConfig } from "./client"
import DESCRIPTION from "./switch.txt"

export const Parameters = Schema.Struct({
  computerId: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))).annotate({
    description: "Paired computer ID, exact name, or unambiguous platform (macOS, Windows, Linux). Omit to list computers and the current target without switching.",
  }),
})

const Computers = Schema.Struct({
  ok: Schema.Boolean,
  computers: Schema.Array(Schema.Struct({
    id: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/)),
    name: Schema.optional(Schema.String),
    platform: Schema.optional(Schema.String),
    connected: Schema.Boolean,
  })),
})

// ---------------------------------------------------------------------------
// Observation identity
//
// docs/computer-use-reliability.md rule 4: refs are generation-scoped, and a
// stale ref is refused rather than silently rebound. A switch adds a second
// axis to that: an observation, and every ref inside it, belongs to exactly one
// computer. The trees read off the computer left behind are invalidated here,
// so a ref minted there is never resolved against another computer's elements.
// ---------------------------------------------------------------------------

/** The scope computer_snapshot uses when no application or window is named. */
const DESKTOP_SCOPE = "*\n*"

/** One tree this session read off one computer, kept for identity only. */
interface HeldObservation {
  readonly computerId: string
  readonly observationId: string
  readonly epoch: number
  readonly refs: ReadonlySet<string>
}

const HELD_LIMIT = 64
const held: HeldObservation[] = []
const epochs = new Map<string, number>()

function epochOf(computerId: string): number {
  return epochs.get(computerId) ?? 0
}

// A switch invalidates by moving the computer's epoch, so what the session read
// before it stays known — and refusable — without staying usable.
function isLive(record: HeldObservation): boolean {
  return record.epoch === epochOf(record.computerId)
}

function refsOf(elements: readonly unknown[]): ReadonlySet<string> {
  return new Set(
    elements.flatMap((element) => {
      if (typeof element !== "object" || element === null) return []
      const entry = element as { id?: unknown; ref?: unknown; reference?: { elementId?: unknown; id?: unknown } }
      return [entry.id, entry.ref, entry.reference?.elementId, entry.reference?.id].filter(
        (value): value is string => typeof value === "string" && value.length > 0,
      )
    }),
  )
}

function hold(record: HeldObservation): void {
  held.push(record)
  if (held.length > HELD_LIMIT) held.splice(0, held.length - HELD_LIMIT)
}

/** Register a tree this session read off one computer under that computer. */
export function recordObservation(computerId: string, observationId: string, elements: readonly unknown[]): void {
  hold({ computerId, observationId, epoch: epochOf(computerId), refs: refsOf(elements) })
}

/**
 * Everything this session read off one computer stops being addressable: its
 * observations are invalidated, so a ref or observation id from there is refused
 * instead of being resolved against another computer's element list. Returns
 * how many live observations died.
 */
export function invalidateObservations(computerId: string | undefined): number {
  if (computerId === undefined) return 0
  // computer_snapshot is the session's other tree reader, and the cache it
  // writes is keyed by computer. Adopting its newest record keeps the refs it
  // handed out attributable to this computer once the computer is left behind.
  const shared = latestObservation(computerId, DESKTOP_SCOPE)
  if (shared !== undefined) {
    hold({
      computerId: shared.computerId,
      observationId: shared.observationId,
      epoch: epochOf(shared.computerId),
      refs: refsOf(shared.elements),
    })
  }
  const died = held.filter((record) => record.computerId === computerId && isLive(record)).length
  epochs.set(computerId, epochOf(computerId) + 1)
  return died
}

/** The computer a tree this session holds was read from, when it knows. */
export function observationOwner(observationId: string): string | undefined {
  return held.filter((record) => record.observationId === observationId).at(-1)?.computerId
}

/**
 * Why this identity cannot be used on this computer, or undefined when the
 * session holds nothing against it. Ownership is decided by which computer's
 * tree the identity was read from, never by its shape: an observation id the
 * session read off another computer is refused even when this computer happens
 * to expose a ref with the same string, because resolving it there would act on
 * a different machine's element. A bare ref is only refused when this computer's
 * own tree does not carry it, so an id reused by two providers stays usable.
 */
export function observationRefusal(
  computerId: string,
  identity: { observationId?: string; ref?: string },
): string | undefined {
  const observationId = identity.observationId?.trim()
  if (observationId !== undefined && observationId.length > 0) {
    const owner = held.filter((record) => record.observationId === observationId).at(-1)
    return owner === undefined ? undefined : refusalFor(computerId, owner, `observation ${observationId}`)
  }
  const ref = identity.ref?.trim()
  if (ref === undefined || ref.length === 0) return undefined
  // A bare ref is addressable inside the tree the session holds for the computer
  // it is used on; only when that computer holds no such tree does the ref belong
  // to whichever other computer's tree the session read it from.
  if (holdsRef(computerId, ref)) return undefined
  const owner = held.filter((record) => record.refs.has(ref)).at(-1)
  if (owner === undefined || owner.computerId === computerId) return undefined
  return refusalFor(computerId, owner, `ref "${ref}"`)
}

/** Whether the tree this session currently holds for a computer carries a ref. */
function holdsRef(computerId: string, ref: string): boolean {
  if (held.some((record) => record.computerId === computerId && isLive(record) && record.refs.has(ref))) return true
  return refsOf(latestObservation(computerId, DESKTOP_SCOPE)?.elements ?? []).has(ref)
}

function refusalFor(computerId: string, owner: HeldObservation, label: string): string | undefined {
  if (owner.computerId !== computerId) {
    return (
      `The ${label} was read from computer ${owner.computerId}, not computer ${computerId}: observations and refs ` +
      `never travel between computers, so it is refused instead of being resolved against ${computerId}'s element ` +
      `list. Take a fresh computer_snapshot on ${computerId} and act on the ref it returns.`
    )
  }
  if (isLive(owner)) return undefined
  return (
    `The ${label} was read from computer ${computerId} before the last switch away from it, and a switch ` +
    `invalidates every observation read off the computer left behind. Take a fresh computer_snapshot on ` +
    `${computerId}; an invalidated ref is never rebound to whatever matches now.`
  )
}

const ComputerSummary = Schema.Struct({
  ok: Schema.Boolean,
  computer: Schema.Struct({
    capabilities: Schema.optional(Schema.Array(Schema.Struct({ capability: Schema.String, status: Schema.String }))),
  }),
})

const SwitchObservation = Schema.Struct({
  ok: Schema.Boolean,
  observation: Schema.Struct({
    id: Schema.String,
    elements: Schema.optional(Schema.Array(Schema.Unknown)),
    warnings: Schema.optional(Schema.Array(Schema.String)),
  }),
})

type SwitchRead = {
  accessibility: string
  observation?: { id: string; elements: readonly unknown[]; warnings: readonly string[] }
  /** What the caller must be told when this read cannot be acted on. */
  warning?: string
}

function failureReason(exit: Exit.Exit<unknown, unknown>): string {
  if (Exit.isSuccess(exit)) return "the Omnia Server did not answer"
  const error = Cause.squash(exit.cause)
  return error instanceof Error ? error.message : String(error)
}

function accessibilityOf(summary: Exit.Exit<typeof ComputerSummary.Type>): string {
  if (Exit.isFailure(summary)) return "unknown"
  return (
    summary.value.computer.capabilities?.find((entry) => entry.capability === "accessibility")?.status ?? "unknown"
  )
}

/**
 * The new computer's own state, read once so the session holds a live tree for
 * it. A read that fails is reported rather than guessed: the switch itself
 * stands, and the caller is told that a fresh observation is required.
 */
function readComputer(
  http: HttpClient.HttpClient,
  config: OmniaServerConfig,
  computerId: string,
): Effect.Effect<SwitchRead> {
  return Effect.gen(function* () {
    const summary = yield* request<typeof ComputerSummary.Type>(
      http,
      config,
      "GET",
      `/v1/computers/${computerId}`,
      undefined,
      { validate: Schema.is(ComputerSummary) },
    ).pipe(Effect.exit)
    const observed = yield* request<typeof SwitchObservation.Type>(
      http,
      config,
      "POST",
      `/v1/computers/${computerId}/observe`,
      {},
      { validate: Schema.is(SwitchObservation) },
    ).pipe(Effect.exit)
    const accessibility = accessibilityOf(summary)
    if (Exit.isFailure(observed)) {
      return {
        accessibility,
        warning:
          `The new computer's interface could not be read (${failureReason(observed)}), so this switch left the ` +
          `session without a live observation: take a fresh computer_snapshot before acting.`,
      }
    }
    const observation = observed.value.observation
    return {
      accessibility,
      observation: { id: observation.id, elements: observation.elements ?? [], warnings: observation.warnings ?? [] },
      ...(accessibility === "available"
        ? {}
        : {
            warning:
              `Accessibility is ${accessibility}, so the tree this switch read is incomplete: confirm with ` +
              `computer_screenshot and ground with computer_visual when a control is missing.`,
          }),
    }
  })
}

export const SwitchComputerTool = Tool.define<
  typeof Parameters,
  Record<string, unknown>,
  HttpClient.HttpClient | Session.Service
>(
  "switch_computer",
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const sessions = yield* Session.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params, ctx) => Effect.gen(function* () {
        const config = yield* configFromEnv()
        const response = yield* request<typeof Computers.Type>(
          http, config, "GET", "/v1/computers", undefined, { validate: Schema.is(Computers) },
        )
        const session = yield* sessions.get(ctx.sessionID).pipe(Effect.orDie)
        // Listing still works if a previously saved control-plane binding changed;
        // an explicit successful switch below repairs that binding.
        const saved = session.metadata?.[COMPUTER_SELECTION_METADATA_KEY]
        const previousId = typeof saved === "object" && saved !== null && "id" in saved && typeof saved.id === "string"
          ? saved.id : config.computerId
        if (params.computerId === undefined) {
          const title = "Paired computers"
          const belongsHere = typeof saved === "object" && saved !== null && "server" in saved && saved.server === controlPlaneKey(config)
          const selected = belongsHere ? previousId : config.computerId
          return {
            title,
            output: JSON.stringify({
              currentComputerId: selected ?? null,
              selection: selected ? "explicit" : "automatic: first connected computer",
              ...(saved !== undefined && !belongsHere ? { warning: "The saved target belongs to another control plane. Select a device again before acting." } : {}),
              computers: response.computers,
            }, null, 2),
            metadata: { switched: false, currentComputerId: selected, computers: response.computers },
          }
        }
        const query = params.computerId.trim()
        if (!query) throw new Error("Choose a non-empty computer ID, name, or platform.")
        const normalized = query.toLowerCase()
        const aliases: Record<string, string> = { mac: "darwin", macos: "darwin", windows: "win32", linux: "linux" }
        const platform = Object.hasOwn(aliases, normalized) ? aliases[normalized] : normalized
        const exact = response.computers.find((computer) => computer.id === query)
        const byName = response.computers.filter((computer) => computer.name?.toLowerCase() === normalized)
        const candidates = exact ? [exact] : byName.length ? byName : response.computers.filter((computer) =>
          computer.platform?.toLowerCase() === platform,
        )
        if (candidates.length === 0) throw new Error(`No paired computer matches "${query}". Call switch_computer without arguments to list IDs.`)
        if (candidates.length > 1) throw new Error(`"${query}" matches several computers (${candidates.map((computer) => computer.id).join(", ")}). Choose an exact ID.`)
        const target = candidates[0]!
        if (!target.connected) throw new Error(`Computer ${target.id} is offline. Open Omnia on that device, then retry. The session target was not changed.`)
        yield* ctx.ask({
          permission: "computer",
          patterns: [`switch:${target.id}`],
          always: [`switch:${target.id}`],
          metadata: { operation: "switch_computer", computerId: target.id, computerName: target.name },
        })
        if (ctx.abort.aborted) throw new Error("Computer switch was cancelled; the session target was not changed.")
        // Re-read before writing so unrelated session metadata is preserved.
        const current = yield* sessions.get(ctx.sessionID).pipe(Effect.orDie)
        // Read the new computer before committing: a control plane that answers
        // with another computer's tree must not bind the session to it.
        const read = yield* readComputer(http, config, target.id)
        const observation = read.observation
        if (observation !== undefined) {
          const owner = observationOwner(observation.id)
          if (owner !== undefined && owner !== target.id) {
            throw new Error(
              `Computer ${target.id} answered with observation ${observation.id}, which this session read from ` +
                `computer ${owner}: an observation never travels between computers, so the switch was refused. The ` +
                `session target was not changed.`,
            )
          }
        }
        // The computer being left behind loses every observation the session
        // read off it, so nothing downstream can act on one of its refs.
        const invalidated = invalidateObservations(
          previousId ?? response.computers.find((computer) => computer.connected)?.id,
        )
        // The tree read here is the one the session holds for this computer, and
        // what computer_snapshot pages and diffs against: register it under the
        // computer it came from, before the session is bound to it.
        const generation =
          observation === undefined
            ? undefined
            : rememberObservation(
                target.id,
                DESKTOP_SCOPE,
                observation.id,
                observation.warnings,
                observation.elements,
              ).generation
        if (observation !== undefined) recordObservation(target.id, observation.id, observation.elements)
        yield* sessions.setMetadata({
          sessionID: ctx.sessionID,
          metadata: {
            ...current.metadata,
            [COMPUTER_SELECTION_METADATA_KEY]: { id: target.id, server: controlPlaneKey(config) },
          },
        })
        const title = `Switched to ${target.name ?? target.id}`
        return {
          title,
          output: JSON.stringify({
            switched: true,
            previousComputerId: previousId ?? null,
            computerId: target.id,
            name: target.name,
            platform: target.platform,
            accessibility: read.accessibility,
            freshObservationRequired: read.warning !== undefined,
            observationId: observation?.id,
            generation,
            invalidatedObservations: invalidated,
            ...(read.warning === undefined ? {} : { warning: read.warning }),
            next: "Every computer_* tool now targets this device. Refs, observation IDs, coordinates and browser tab IDs from the previous computer are invalid and refused: take a fresh computer_snapshot here before acting.",
          }, null, 2),
          metadata: {
            switched: true,
            computerId: target.id,
            previousComputerId: previousId,
            platform: target.platform,
            accessibility: read.accessibility,
            freshObservationRequired: read.warning !== undefined,
            invalidatedObservations: invalidated,
          },
        }
      }),
    }
  }),
)
