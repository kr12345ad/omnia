import { Cause, Effect, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { createHash, createHmac } from "node:crypto"
import { Session } from "@/session/session"
import type { SessionID } from "@/session/schema"
import { clip } from "./output"

export interface OmniaServerConfig {
  url: string
  token: string
  computerId?: string
}

export const COMPUTER_SELECTION_METADATA_KEY = "omniaComputer"

export function controlPlaneKey(config: OmniaServerConfig): string {
  return createHash("sha256").update(config.url).digest("hex")
}

/** A session's explicit target wins over the environment and automatic discovery. */
export function selectionFromMetadata(
  metadata: Record<string, unknown> | undefined,
  config: OmniaServerConfig,
): string | undefined {
  const selection = metadata?.[COMPUTER_SELECTION_METADATA_KEY]
  if (selection === undefined) return undefined
  if (typeof selection !== "object" || selection === null || Array.isArray(selection)) {
    throw new Error("The session's saved computer target is invalid; use switch_computer to choose it again.")
  }
  const value = selection as { id?: unknown; server?: unknown }
  if (typeof value.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value.id)) {
    throw new Error("The session's saved computer target is invalid; use switch_computer to choose it again.")
  }
  if (value.server !== controlPlaneKey(config)) {
    throw new Error(
      "The session's target belongs to a different control plane; use switch_computer before controlling a computer.",
    )
  }
  return value.id
}

export function configFromEnv(): Effect.Effect<OmniaServerConfig> {
  return Effect.try({
    try: () => {
      const url = process.env.OMNIA_SERVER_URL?.trim()
      const token = process.env.OMNIA_SERVER_TOKEN?.trim()
      if (!url || !token) {
        throw new Error(
          "Computer control is unavailable: the Omnia Server is not running. " +
            "Open Omnia Desktop on this computer so the server starts, then retry.",
        )
      }
      const parsed = new URL(url)
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("OMNIA_SERVER_URL must be an http:// or https:// URL.")
      }
      const computerId = process.env.OMNIA_COMPUTER_ID?.trim()
      return {
        url: url.replace(/\/+$/, ""),
        token,
        ...(computerId === undefined || computerId.length === 0 ? {} : { computerId }),
      }
    },
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  }).pipe(Effect.orDie)
}

const LONG_PATHS = ["/do"]

export interface RequestOptions {
  readonly validate?: (value: unknown) => boolean
}

const SESSION_PROOF_CACHE_LIMIT = 256
const sessionProofCache = new Map<string, string>()

function sessionProof(token: string, sessionId: string): string {
  const cacheKey = `${token}\n${sessionId}`
  const cached = sessionProofCache.get(cacheKey)
  if (cached !== undefined) return cached
  const proof = createHmac("sha256", token).update(sessionId).digest("hex")
  if (sessionProofCache.size >= SESSION_PROOF_CACHE_LIMIT) sessionProofCache.clear()
  sessionProofCache.set(cacheKey, proof)
  return proof
}

function bodySessionId(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined
  const value = (body as { sessionId?: unknown }).sessionId
  return typeof value === "string" && value.length > 0 ? value : undefined
}

export const ActionEnvelope = Schema.Struct({
  ok: Schema.Boolean,
  result: Schema.Struct({ success: Schema.Boolean }),
})

export const BatchEnvelope = Schema.Struct({
  ok: Schema.Boolean,
  result: Schema.Struct({ success: Schema.Boolean, steps: Schema.Array(Schema.Unknown) }),
})

export const ObservationEnvelope = Schema.Struct({
  ok: Schema.Boolean,
  observation: Schema.Struct({ id: Schema.String }),
})

export function request<Response>(
  http: HttpClient.HttpClient,
  config: OmniaServerConfig,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
  options?: RequestOptions,
): Effect.Effect<Response> {
  const longRunning =
    LONG_PATHS.some((suffix) => path.endsWith(suffix)) ||
    (typeof body === "object" && body !== null && (body as { action?: unknown }).action === "run_command")
  const timeoutMs = longRunning ? 600000 : 120000
  return Effect.gen(function* () {
    const base = HttpClientRequest.make(method)(`${config.url}${path}`).pipe(
      HttpClientRequest.bearerToken(config.token),
      HttpClientRequest.acceptJson,
    )
    const sessionId = bodySessionId(body)
    // The desktop UI and the agent runtime share one bearer token, so the
    // session id travels with a proof that only a client holding the token can
    // produce. The token itself never appears in the header.
    const authenticated =
      sessionId === undefined
        ? base
        : HttpClientRequest.setHeader(base, "x-omnia-session-proof", sessionProof(config.token, sessionId))
    const request = body === undefined ? authenticated : HttpClientRequest.bodyJsonUnsafe(authenticated, body)
    const response = yield* http.execute(request).pipe(
      Effect.timeoutOrElse({
        duration: timeoutMs,
        orElse: () => Effect.die(new Error(`Omnia Server request timed out after ${Math.round(timeoutMs / 1000)}s.`)),
      }),
      Effect.catchCause((cause) => {
        const error = Cause.squash(cause)
        return Effect.die(
          new Error(`Omnia Server request failed: ${error instanceof Error ? error.message : String(error)}`, {
            cause: error,
          }),
        )
      }),
    )
    const bodyText = yield* response.text.pipe(
      Effect.catchCause((cause) =>
        Effect.die(
          new Error(`Omnia Server response could not be read (HTTP ${response.status}).`, {
            cause: Cause.squash(cause),
          }),
        ),
      ),
    )
    const decoded = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(bodyText)
    if (Option.isNone(decoded) || typeof decoded.value !== "object" || decoded.value === null) {
      throw new Error(`Omnia Server returned invalid JSON (HTTP ${response.status}, ${bodyText.length} characters).`)
    }
    const json = decoded.value as { ok?: unknown; error?: unknown; result?: unknown; analysis?: unknown } & Record<
      string,
      unknown
    >
    if (options?.validate !== undefined && json.ok === true && !options.validate(json)) {
      throw new Error(`Omnia Server returned an unexpected response for ${path} (HTTP ${response.status}).`)
    }
    // The server reports operation outcomes through ok:false with a structured
    // result/analysis. Only a body without any structured payload is a
    // transport failure; otherwise let the caller inspect result.success.
    if (json.ok !== true && json.result === undefined && json.analysis === undefined) {
      throw new Error(describeFailure(json, response.status))
    }
    return json as Response
  })
}

function describeFailure(json: { error?: unknown; result?: unknown }, status: number): string {
  const described = describeError(json.error) ?? describeResultFailure(json.result)
  const hint = authHint(status)
  if (described !== undefined) return hint === undefined ? described : `${described} — ${hint}`
  if (hint !== undefined) return `Omnia Server rejected the request (HTTP ${status}): ${hint}.`
  return `Omnia Server reported failure (HTTP ${status}).`
}

function describeResultFailure(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null) return undefined
  const fromResult = describeError((result as { error?: unknown }).error)
  if (fromResult !== undefined) return fromResult
  const message = (result as { message?: unknown }).message
  return typeof message === "string" && message.length > 0 ? message : undefined
}

function authHint(status: number): string | undefined {
  if (status === 401) {
    return "the Omnia Server token is missing, expired, or invalid; restart Omnia Desktop on the server computer to refresh it"
  }
  if (status === 403) {
    return "the request was denied; approve the action or check the required permissions in Omnia Settings > Computer"
  }
  return undefined
}

function describeError(error: unknown): string | undefined {
  if (typeof error === "string" && error.length > 0) return error
  if (typeof error !== "object" || error === null) return undefined
  const record = error as { message?: unknown; code?: unknown; details?: unknown }
  const message = typeof record.message === "string" && record.message.length > 0 ? record.message : undefined
  const code = typeof record.code === "string" && record.code.length > 0 ? `[${record.code}]` : undefined
  const details = record.details === undefined ? undefined : `details=${clip(JSON.stringify(record.details), 400)}`
  if (message === undefined && code === undefined && details === undefined) return undefined
  return [message ?? "request failed", code, details].filter((part): part is string => part !== undefined).join(" ")
}

const COMPUTER_CACHE_TTL_MS = 30_000
const computerCache = new Map<string, { id: string; expiresAt: number }>()

/**
 * One observed tree, cached by computerId + generation. Diff snapshots read
 * their baseline out of here, and a full read that names a generation the
 * caller already holds is served from here instead of observing again — paging
 * through one tree must never mix pages from two observations.
 */
export interface ObservationRecord {
  readonly computerId: string
  readonly generation: number
  readonly observationId: string
  readonly scope: string
  readonly warnings: readonly string[]
  readonly elements: readonly unknown[]
}

const OBSERVATION_LIMIT = 8
const observationCache = new Map<string, ObservationRecord>()
const observationGenerations = new Map<string, number>()

export function rememberObservation(
  computer: string,
  scope: string,
  observationId: string,
  warnings: readonly string[],
  elements: readonly unknown[],
): ObservationRecord {
  const generation = (observationGenerations.get(computer) ?? 0) + 1
  observationGenerations.set(computer, generation)
  const record: ObservationRecord = { computerId: computer, generation, observationId, scope, warnings, elements }
  observationCache.set(`${computer}\n${generation}`, record)
  const oldest = observationCache.keys().next()
  if (observationCache.size > OBSERVATION_LIMIT && !oldest.done) observationCache.delete(oldest.value)
  return record
}

export function observationFor(computer: string, generation: number): ObservationRecord | undefined {
  return observationCache.get(`${computer}\n${generation}`)
}

/** Find a tree only when this session actually cached that exact observation. */
export function observationById(computer: string, observationId: string): ObservationRecord | undefined {
  for (const record of observationCache.values()) {
    if (record.computerId === computer && record.observationId === observationId) return record
  }
  return undefined
}

/** The newest generation this session still holds for one computer and scope. */
export function latestObservation(computer: string, scope: string): ObservationRecord | undefined {
  let newest: ObservationRecord | undefined
  for (const record of observationCache.values()) {
    if (record.computerId !== computer || record.scope !== scope) continue
    if (newest === undefined || record.generation > newest.generation) newest = record
  }
  return newest
}

const ComputersResponse = Schema.Struct({
  ok: Schema.Boolean,
  computers: Schema.Array(
    Schema.Struct({
      id: Schema.optional(Schema.String),
      connected: Schema.optional(Schema.Boolean),
    }),
  ),
})

export function computerId(
  http: HttpClient.HttpClient,
  config: OmniaServerConfig,
  sessionID?: SessionID,
): Effect.Effect<string> {
  return Effect.gen(function* () {
    if (sessionID !== undefined) {
      const sessions = yield* Effect.serviceOption(Session.Service)
      if (Option.isSome(sessions)) {
        const session = yield* sessions.value.get(sessionID).pipe(Effect.orDie)
        const selected = selectionFromMetadata(session.metadata, config)
        // Never fall back to another device when an explicit target goes offline.
        // The selected driver's own request reports that failure to the caller.
        if (selected !== undefined) return selected
      }
    }
    if (config.computerId !== undefined && config.computerId.length > 0) return config.computerId
    const cacheKey = `${config.url}\n${config.token}`
    const cached = computerCache.get(cacheKey)
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.id
    const response = yield* request<{ ok: true; computers: Array<{ id?: string; connected?: boolean }> }>(
      http,
      config,
      "GET",
      "/v1/computers",
      undefined,
      { validate: Schema.is(ComputersResponse) },
    )
    const connected = response.computers.find(
      (computer) => computer.connected === true && typeof computer.id === "string",
    )
    const id = connected?.id
    if (id === undefined) {
      throw new Error(
        "No computer is connected to the Omnia Server; open Omnia Desktop on the computer you want to control.",
      )
    }
    computerCache.set(cacheKey, { id, expiresAt: Date.now() + COMPUTER_CACHE_TTL_MS })
    return id
  })
}
