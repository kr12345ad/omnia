import type { IncomingMessage, ServerResponse } from "node:http"
import type { EventBus, ServerEvent } from "./events"
import type { ComputerManager, ServerActionRequest, ServerBatchStep } from "./computers"
import { OMNIA_ACTION_CATALOG } from "./catalog"
import { parseActionScript, renderAnthropicTools, renderCatalogText, renderOpenAiTools } from "./text-protocol"
import { summarizeSuperskill } from "../superskills/registry"
import type { Superskill, SuperskillSummary } from "../superskills/types"
import type { MemoryQuery, MemoryRecord, MemoryStats, MemoryWriteInput } from "../memory/types"
import { isMemoryScope } from "../memory/store"
import type { ComputerUseService } from "../computer-use/service"
import type { GitHubAuth } from "../auth/github"
import type {
  ComputerUseContext,
  ComputerUseOperation,
  ComputerUsePrivacy,
  ImageReference,
  SemanticEnvironment,
} from "../computer-use/types"
import { describePermissions, isOmniaScope, PERMISSION_STATES, type PermissionManager, type PermissionState } from "./permissions"
import { isCredentialKind, isCredentialRuleKind, summarizeCredential, type CredentialStore } from "../credentials"
import type { PairingManager } from "../pairing"
import { formatPairingCode } from "../pairing"
import type { RemoteRegistry } from "./remote"
import type { CapabilitySupport, ComputerInfo } from "../protocol"

export const OMNIA_PROTOCOL_VERSION = 1
export const OMNIA_API_VERSION = "v1"
export const OMNIA_API_PREFIX = "/v1"
export const OMNIA_BODY_LIMIT_BYTES = 16 * 1024 * 1024
export const OMNIA_SSE_HEARTBEAT_MS = 15000

export type ServerHealthState = "starting" | "ready" | "degraded" | "stopping" | "stopped" | "failed"

export interface SubsystemHealth {
  readonly name: string
  readonly status: "ready" | "degraded" | "unavailable" | "failed"
  readonly reason?: string
}

export interface ServerHealth {
  readonly status: ServerHealthState
  readonly version: string
  readonly protocol: number
  readonly api: string
  readonly serverId: string
  readonly uptimeMs: number
  readonly activeSessions: number
  readonly connectedComputers: number
  readonly subsystems: readonly SubsystemHealth[]
  readonly startedAt: number
}

export interface ServerCatalogEntry {
  readonly id: string
  readonly name?: string
  readonly description?: string
  readonly provider?: string
  readonly capabilities?: Readonly<Record<string, boolean | number>>
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface ServerCatalog {
  readonly agents: readonly ServerCatalogEntry[]
  readonly skills: readonly ServerCatalogEntry[]
  readonly models: readonly ServerCatalogEntry[]
}

export interface ServerDescriptor {
  readonly serverId: string
  readonly version: string
  readonly startedAt: number
  readonly platform: string
}

export interface ServerSession {
  readonly id: string
  readonly computerId?: string
  readonly actions: number
  readonly lastActionAt: number
}

export interface ApiContext {
  readonly descriptor: ServerDescriptor
  readonly events: EventBus
  readonly computers: ComputerManager
  readonly permissions: PermissionManager
  readonly credentials: CredentialStore
  readonly pairings: PairingManager
  readonly remote: RemoteRegistry
  readonly pairingUrl: () => string
  readonly catalog: () => ServerCatalog
  readonly registerModels: (models: readonly ServerCatalogEntry[]) => void
  readonly superskills: () => readonly SuperskillSummary[]
  readonly superskill: (id: string) => Superskill | undefined
  readonly saveSuperskill: (input: unknown) => Superskill
  readonly removeSuperskill: (id: string) => boolean
  readonly callSuperskill: (id: string, method: string, params: unknown) => Promise<unknown>
  readonly memories: (query: MemoryQuery) => readonly MemoryRecord[]
  readonly memoryStats: () => MemoryStats
  readonly writeMemory: (input: MemoryWriteInput) => MemoryRecord
  readonly removeMemory: (id: string) => boolean
  readonly forgetMemories: (query: MemoryQuery) => number
  readonly sessions: () => readonly ServerSession[]
  readonly computerUse: ComputerUseService
  readonly auth: GitHubAuth
  readonly health: () => ServerHealth
  readonly subscribe: (response: ServerResponse) => () => void
  readonly now: () => number
}

export interface ParsedRequest {
  readonly method: string
  readonly pathname: string
  readonly segments: readonly string[]
  readonly url: URL
}

export function parseRequest(request: IncomingMessage): ParsedRequest {
  const url = new URL(request.url ?? "/", "http://127.0.0.1")
  const pathname = url.pathname.replace(/\/+$/, "") || "/"
  return {
    method: request.method ?? "GET",
    pathname,
    segments: pathname.split("/").filter((segment) => segment.length > 0),
    url,
  }
}

export function isAuthorized(request: IncomingMessage, token: string, timingSafeEqual: (a: Buffer, b: Buffer) => boolean): boolean {
  const header = request.headers.authorization ?? ""
  const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : ""
  const expected = Buffer.from(token)
  const actual = Buffer.from(presented)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export function readBody(request: IncomingMessage, limit = OMNIA_BODY_LIMIT_BYTES): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    request.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error("Request body too large."))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on("end", () => {
      if (chunks.length === 0) return resolve(undefined)
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")))
      } catch {
        reject(new Error("Request body is not valid JSON."))
      }
    })
    request.on("error", reject)
  })
}

export function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "cache-control": "no-store",
  })
  response.end(body)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is string => typeof item === "string")
}

function dragEndpoint(value: unknown): ServerActionRequest["from"] {
  if (!isRecord(value)) return undefined
  const endpoint = {
    ...(typeof value.elementId === "string" ? { elementId: value.elementId } : {}),
    ...(typeof value.x === "number" ? { x: value.x } : {}),
    ...(typeof value.y === "number" ? { y: value.y } : {}),
  }
  return Object.keys(endpoint).length === 0 ? undefined : endpoint
}

function actionFields(record: Record<string, unknown>): Omit<ServerActionRequest, "action"> {
  const scopes = asStringArray(record.approvedScopes)?.filter(isOmniaScope)
  const from = dragEndpoint(record.from)
  const to = dragEndpoint(record.to)
  return {
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    ...(isRecord(record.target)
      ? {
          target: {
            kind: "element" as const,
            elementId: typeof record.target.elementId === "string" ? record.target.elementId : "",
            ...(typeof record.target.observationId === "string" ? { observationId: record.target.observationId } : {}),
          },
        }
      : {}),
    ...(typeof record.query === "string" ? { query: record.query } : {}),
    ...(typeof record.role === "string" ? { role: record.role } : {}),
    ...(typeof record.window === "string" ? { window: record.window } : {}),
    ...(typeof record.tab === "string" ? { tab: record.tab } : {}),
    ...(typeof record.text === "string" ? { text: record.text } : {}),
    ...(typeof record.start === "string" ? { start: record.start } : {}),
    ...(typeof record.stop === "string" ? { stop: record.stop } : {}),
    ...(typeof record.endKey === "string" ? { endKey: record.endKey } : {}),
    ...(typeof record.key === "string" ? { key: record.key } : {}),
    ...(asStringArray(record.keys) === undefined ? {} : { keys: asStringArray(record.keys)! }),
    ...(typeof record.app === "string" ? { app: record.app } : {}),
    ...(typeof record.url === "string" ? { url: record.url } : {}),
    ...(typeof record.path === "string" ? { path: record.path } : {}),
    ...(typeof record.direction === "string" ? { direction: record.direction } : {}),
    ...(typeof record.amount === "number" ? { amount: record.amount } : {}),
    ...(typeof record.limit === "number" ? { limit: record.limit } : {}),
    ...(typeof record.button === "string" ? { button: record.button } : {}),
    ...(typeof record.command === "string" ? { command: record.command } : {}),
    ...(typeof record.cwd === "string" ? { cwd: record.cwd } : {}),
    ...(typeof record.timeoutMs === "number" ? { timeoutMs: record.timeoutMs } : {}),
    ...(typeof record.credential === "string" ? { credential: record.credential } : {}),
    ...(typeof record.doc === "string" ? { doc: record.doc } : {}),
    ...(typeof record.sheet === "string" ? { sheet: record.sheet } : {}),
    ...(typeof record.range === "string" ? { range: record.range } : {}),
    ...(typeof record.cell === "string" ? { cell: record.cell } : {}),
    ...(typeof record.name === "string" ? { name: record.name } : {}),
    ...(typeof record.type === "string" ? { type: record.type } : {}),
    ...(typeof record.title === "string" ? { title: record.title } : {}),
    ...(typeof record.bold === "boolean" ? { bold: record.bold } : {}),
    ...(typeof record.background === "string" ? { background: record.background } : {}),
    ...(typeof record.wrap === "boolean" ? { wrap: record.wrap } : {}),
    ...(typeof record.fontSize === "number" ? { fontSize: record.fontSize } : {}),
    ...(typeof record.index === "number" ? { index: record.index } : {}),
    ...(typeof record.count === "number" ? { count: record.count } : {}),
    ...(typeof record.width === "number" ? { width: record.width } : {}),
    ...(typeof record.height === "number" ? { height: record.height } : {}),
    ...(Array.isArray(record.rows)
      ? {
          rows: record.rows
            .filter((row): row is unknown[] => Array.isArray(row))
            .map((row) => row.filter((value): value is string | number | boolean | null => value === null || ["string", "number", "boolean"].includes(typeof value))),
        }
      : {}),
    ...(Array.isArray(record.items)
      ? {
          items: record.items.flatMap((item) =>
            isRecord(item) && typeof item.text === "string"
              ? [{ text: item.text, ...(typeof item.style === "string" ? { style: item.style } : {}) }]
              : [],
          ),
        }
      : {}),
    ...(typeof record.x === "number" ? { x: record.x } : {}),
    ...(typeof record.y === "number" ? { y: record.y } : {}),
    ...(record.approve === true ? { approve: true } : {}),
    ...(typeof record.approvedBy === "string" ? { approvedBy: record.approvedBy } : {}),
    ...(scopes === undefined ? {} : { approvedScopes: scopes }),
    ...(typeof record.sessionId === "string" ? { sessionId: record.sessionId } : {}),
  }
}

function parseBatchStep(record: Record<string, unknown>): ServerBatchStep | undefined {
  if (typeof record.action !== "string") return undefined
  const expect = isRecord(record.expect)
    ? {
        ...(typeof record.expect.text === "string" ? { text: record.expect.text } : {}),
        ...(typeof record.expect.window === "string" ? { window: record.expect.window } : {}),
        ...(typeof record.expect.file === "string" ? { file: record.expect.file } : {}),
      }
    : undefined
  return {
    action: record.action,
    ...actionFields(record),
    ...(expect === undefined ? {} : { expect }),
  }
}

export async function handleRequest(context: ApiContext, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
  const parsed = parseRequest(request)
  if (parsed.method === "OPTIONS") {
    json(response, 204, {})
    return true
  }

  const segments = parsed.segments
  if (segments[0] !== "v1") return false

  if (parsed.method === "GET" && segments.length === 2 && segments[1] === "health") {
    json(response, 200, { ok: true, health: context.health() })
    return true
  }

  if (parsed.method === "GET" && segments.length === 2 && segments[1] === "capabilities") {
    const computers = await context.computers.list()
    json(response, 200, {
      ok: true,
      server: context.descriptor,
      protocol: OMNIA_PROTOCOL_VERSION,
      computers: computers.map((computer) => ({
        id: computer.id,
        platform: computer.platform,
        backend: computer.backend,
        connected: computer.connected,
        capabilities: computer.capabilities,
      })),
    })
    return true
  }

  if (parsed.method === "GET" && segments.length === 2 && segments[1] === "actions") {
    const format = parsed.url.searchParams.get("format") ?? "json"
    if (format === "text" || format === "markdown") {
      const body = renderCatalogText()
      response.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "access-control-allow-origin": "*",
        "cache-control": "no-store",
      })
      response.end(body)
      return true
    }
    if (format === "openai") {
      json(response, 200, { ok: true, protocol: OMNIA_PROTOCOL_VERSION, tools: renderOpenAiTools() })
      return true
    }
    if (format === "anthropic") {
      json(response, 200, { ok: true, protocol: OMNIA_PROTOCOL_VERSION, tools: renderAnthropicTools() })
      return true
    }
    json(response, 200, {
      ok: true,
      protocol: OMNIA_PROTOCOL_VERSION,
      actions: OMNIA_ACTION_CATALOG,
      batch: { endpoint: "POST /v1/computers/:id/do", fields: ["steps", "stopOnError", "approve", "sessionId"] },
      text: { endpoint: "POST /v1/computers/:id/text", fields: ["script", "stopOnError", "approve", "sessionId"] },
      formats: ["json", "text", "openai", "anthropic"],
    })
    return true
  }

  if (parsed.method === "GET" && segments.length === 2 && segments[1] === "computers") {
    json(response, 200, { ok: true, computers: await context.computers.list() })
    return true
  }

  if (segments.length >= 3 && segments[1] === "computers" && segments[2] === "pair") {
    if (parsed.method === "GET" && segments.length === 3) {
      json(response, 200, { ok: true, pairings: context.pairings.list(), serverUrl: context.pairingUrl() })
      return true
    }
    if (parsed.method === "POST" && segments.length === 3) {
      const body = (await readBody(request)) as Record<string, unknown> | undefined
      const offer = context.pairings.create(
        isRecord(body) && typeof body.name === "string" && body.name.trim().length > 0 ? { name: body.name.trim() } : {},
      )
      context.events.emit("computer.pairing_created", { data: { code: offer.code, expiresAt: offer.expiresAt } })
      const serverUrl = context.pairingUrl()
      json(response, 200, {
        ok: true,
        pairing: offer,
        serverUrl,
        pairingCode: formatPairingCode(serverUrl, offer.code),
      })
      return true
    }
    if (parsed.method === "DELETE" && segments.length === 4) {
      const code = decodeURIComponent(segments[3]!)
      const removed = context.pairings.cancel(code)
      if (removed) context.events.emit("computer.pairing_cancelled", { data: { code } })
      json(response, removed ? 200 : 404, {
        ok: removed,
        ...(removed ? {} : { error: `No pairing offer ${code}.` }),
      })
      return true
    }
    if (parsed.method === "POST" && segments.length === 4 && segments[3] === "claim") {
      const body = (await readBody(request)) as Record<string, unknown> | undefined
      const code = isRecord(body) && typeof body.code === "string" ? body.code : ""
      const offer = context.pairings.claim(code)
      if (offer === undefined) {
        json(response, 404, { ok: false, error: "The pairing code is unknown or has expired." })
        return true
      }
      const name =
        isRecord(body) && typeof body.name === "string" && body.name.trim().length > 0
          ? body.name.trim()
          : offer.name ?? "Remote computer"
      const platform =
        isRecord(body) && typeof body.platform === "string" && body.platform.length > 0 ? body.platform : "unknown"
      const architecture = isRecord(body) && typeof body.architecture === "string" ? body.architecture : undefined
      const info = isRecord(body) && isRecord(body.info) ? (body.info as unknown as ComputerInfo) : undefined
      const capabilities =
        isRecord(body) && Array.isArray(body.capabilities)
          ? (body.capabilities as unknown as CapabilitySupport[])
          : undefined
      const claimed = context.remote.claim({
        name,
        platform,
        ...(architecture === undefined ? {} : { architecture }),
        ...(info === undefined ? {} : { info }),
        ...(capabilities === undefined ? {} : { capabilities }),
      })
      context.events.emit("computer.pairing_claimed", {
        computerId: claimed.computerId,
        data: { code: offer.code, name },
      })
      json(response, 200, { ok: true, computerId: claimed.computerId, token: claimed.token, name })
      return true
    }
    json(response, 404, { ok: false, error: "Unknown pairing route." })
    return true
  }

  if (segments.length >= 4 && segments[1] === "computers") {
    const computerId = segments[2]!
    const action = segments[3]!
    const computer = context.computers.get(computerId)
    if (!computer) {
      json(response, 404, { ok: false, error: `Unknown computer ${computerId}.` })
      return true
    }
    if (segments.length === 5 && segments[4] === "commands" && parsed.method === "GET") {
      const waitParam = Number(parsed.url.searchParams.get("wait") ?? "25000")
      const waitMs = Number.isFinite(waitParam) ? Math.max(0, Math.min(waitParam, 50000)) : 25000
      const command = await context.remote.next(computerId, waitMs)
      json(response, 200, { ok: true, command: command ?? null })
      return true
    }
    if (segments.length === 5 && segments[4] === "results" && parsed.method === "POST") {
      const body = (await readBody(request)) as Record<string, unknown> | undefined
      const id = isRecord(body) && typeof body.id === "string" ? body.id : ""
      const accepted = context.remote.complete(computerId, {
        id,
        ok: isRecord(body) && body.ok === true,
        ...(isRecord(body) && "result" in body ? { result: body.result } : {}),
        ...(isRecord(body) && typeof body.error === "string" ? { error: body.error } : {}),
      })
      json(response, accepted ? 200 : 404, { ok: accepted })
      return true
    }
    if (segments.length === 5 && segments[4] === "bye" && parsed.method === "POST") {
      const removed = context.remote.bye(computerId)
      json(response, 200, { ok: removed })
      return true
    }
    if (parsed.method === "GET" && segments.length === 4 && action === "capabilities") {
      json(response, 200, { ok: true, capabilities: await context.computers.capabilities(computerId) })
      return true
    }
    if (parsed.method === "POST" && segments.length === 4 && action === "observe") {
      const body = (await readBody(request)) as { applicationId?: unknown; includeScreenshot?: unknown } | undefined
      const observation = await context.computers.observe(computerId, {
        ...(typeof body?.applicationId === "string" ? { applicationId: body.applicationId } : {}),
        ...(body?.includeScreenshot === true ? { includeScreenshot: true } : {}),
      })
      json(response, 200, { ok: true, observation })
      return true
    }
    if (parsed.method === "POST" && segments.length === 4 && action === "find") {
      const body = (await readBody(request)) as Record<string, unknown> | undefined
      if (!isRecord(body) || typeof body.query !== "string" || body.query.trim().length === 0) {
        json(response, 400, { ok: false, error: "Find requires a non-empty query." })
        return true
      }
      const result = await context.computers.find(computerId, {
        query: body.query,
        ...(typeof body.role === "string" ? { role: body.role } : {}),
        ...(typeof body.name === "string" ? { name: body.name } : {}),
        ...(typeof body.limit === "number" ? { limit: body.limit } : {}),
      })
      json(response, 200, { ok: true, result })
      return true
    }
    if (parsed.method === "POST" && segments.length === 4 && action === "actions") {
      const body = (await readBody(request)) as Record<string, unknown> | undefined
      if (!isRecord(body) || typeof body.action !== "string") {
        json(response, 400, { ok: false, error: "An action is required." })
        return true
      }
      const outcome = await context.computers.execute(computerId, {
        action: body.action,
        ...actionFields(body),
      })
      json(response, outcome.httpStatus, { ok: outcome.result.success, result: outcome.result })
      return true
    }
    if (parsed.method === "POST" && segments.length === 4 && action === "text") {
      const body = (await readBody(request)) as Record<string, unknown> | undefined
      if (!isRecord(body) || typeof body.script !== "string" || body.script.trim().length === 0) {
        json(response, 400, { ok: false, error: "A non-empty script is required." })
        return true
      }
      const parsedScript = parseActionScript(body.script)
      if (parsedScript.errors.length > 0) {
        json(response, 400, {
          ok: false,
          error: "The action script has invalid lines; nothing was executed.",
          errors: parsedScript.errors,
        })
        return true
      }
      if (parsedScript.steps.length === 0) {
        json(response, 400, { ok: false, error: "The action script contained no actions." })
        return true
      }
      let scriptCancelled = false
      response.on("close", () => {
        if (!response.writableEnded) scriptCancelled = true
      })
      const outcome = await context.computers.executeBatch(computerId, {
        steps: parsedScript.steps,
        shouldStop: () => scriptCancelled,
        ...(typeof body.stopOnError === "boolean" ? { stopOnError: body.stopOnError } : {}),
        ...(body.approve === true ? { approve: true } : {}),
        ...(typeof body.approvedBy === "string" ? { approvedBy: body.approvedBy } : {}),
        ...(asStringArray(body.approvedScopes) === undefined
          ? {}
          : { approvedScopes: asStringArray(body.approvedScopes)!.filter(isOmniaScope) }),
        ...(typeof body.sessionId === "string" ? { sessionId: body.sessionId } : {}),
      })
      json(response, outcome.httpStatus, { ok: outcome.result.success, result: outcome.result })
      return true
    }

    if (parsed.method === "POST" && segments.length === 4 && action === "do") {
      const body = (await readBody(request)) as Record<string, unknown> | undefined
      if (!isRecord(body) || !Array.isArray(body.steps)) {
        json(response, 400, { ok: false, error: "A steps array is required." })
        return true
      }
      const steps = body.steps.flatMap((step): ServerBatchStep[] => {
        if (!isRecord(step)) return []
        const parsedStep = parseBatchStep(step)
        return parsedStep === undefined ? [] : [parsedStep]
      })
      let batchCancelled = false
      response.on("close", () => {
        if (!response.writableEnded) batchCancelled = true
      })
      const outcome = await context.computers.executeBatch(computerId, {
        steps,
        shouldStop: () => batchCancelled,
        ...(typeof body.stopOnError === "boolean" ? { stopOnError: body.stopOnError } : {}),
        ...(body.approve === true ? { approve: true } : {}),
        ...(typeof body.approvedBy === "string" ? { approvedBy: body.approvedBy } : {}),
        ...(asStringArray(body.approvedScopes) === undefined
          ? {}
          : { approvedScopes: asStringArray(body.approvedScopes)!.filter(isOmniaScope) }),
        ...(typeof body.sessionId === "string" ? { sessionId: body.sessionId } : {}),
      })
      json(response, outcome.httpStatus, { ok: outcome.result.success, result: outcome.result })
      return true
    }
    if (parsed.method === "POST" && segments.length === 4 && action === "connect") {
      const outcome = await context.computers.connect(computerId)
      json(response, outcome.httpStatus, { ok: outcome.result.success, result: outcome.result })
      return true
    }
    if (parsed.method === "POST" && segments.length === 4 && action === "disconnect") {
      const outcome = await context.computers.disconnect(computerId)
      json(response, outcome.httpStatus, { ok: outcome.result.success, result: outcome.result })
      return true
    }
    if (parsed.method === "POST" && segments.length === 4 && action === "stop") {
      const body = (await readBody(request)) as Record<string, unknown> | undefined
      const outcome = await context.computers.stop(computerId, {
        ...(isRecord(body) && typeof body.reason === "string" ? { reason: body.reason } : {}),
        ...(isRecord(body) && typeof body.sessionId === "string" ? { sessionId: body.sessionId } : {}),
      })
      json(response, outcome.httpStatus, { ok: outcome.result.success, result: outcome.result })
      return true
    }
    if (action === "credentials") {
      if (parsed.method === "GET" && segments.length === 4) {
        json(response, 200, { ok: true, credentials: context.credentials.summaries(computerId) })
        return true
      }
      if (parsed.method === "POST" && segments.length === 4) {
        const body = (await readBody(request)) as Record<string, unknown> | undefined
        if (!isRecord(body) || typeof body.name !== "string" || body.name.trim().length === 0) {
          json(response, 400, { ok: false, error: "A credential name is required." })
          return true
        }
        const rules = Array.isArray(body.rules)
          ? body.rules.flatMap((rule) =>
              isRecord(rule) && isCredentialRuleKind(rule.kind) && typeof rule.match === "string"
                ? [{ kind: rule.kind, match: rule.match }]
                : [],
            )
          : []
        const existing = typeof body.id === "string" ? context.credentials.get(body.id) : undefined
        const saved = context.credentials.save({
          ...(typeof body.id === "string" ? { id: body.id } : {}),
          computerId: typeof body.computerId === "string" && body.computerId.length > 0 ? body.computerId : computerId,
          name: body.name,
          ...(isCredentialKind(body.kind) ? { kind: body.kind } : {}),
          ...(typeof body.username === "string" ? { username: body.username } : {}),
          ...(typeof body.secret === "string" ? { secret: body.secret } : {}),
          rules,
          ...(typeof body.description === "string" ? { description: body.description } : {}),
          ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
        })
        context.events.emit(existing === undefined ? "credential.created" : "credential.updated", {
          computerId,
          data: { id: saved.id, name: saved.name },
        })
        json(response, 200, { ok: true, credential: summarizeCredential(saved) })
        return true
      }
      if (parsed.method === "DELETE" && segments.length === 5) {
        const credentialId = segments[4]!
        const removed = context.credentials.remove(credentialId)
        if (removed) {
          context.events.emit("credential.removed", { computerId, data: { id: credentialId } })
        }
        json(response, removed ? 200 : 404, {
          ok: removed,
          ...(removed ? {} : { error: `No credential ${credentialId} is stored for ${computerId}.` }),
        })
        return true
      }
    }
    json(response, 404, { ok: false, error: "Unknown computer route." })
    return true
  }

  if (parsed.method === "GET" && segments.length === 3 && segments[1] === "computers") {
    const summary = await context.computers.summary(segments[2]!)
    if (!summary) {
      json(response, 404, { ok: false, error: `Unknown computer ${segments[2]}.` })
      return true
    }
    json(response, 200, { ok: true, computer: summary })
    return true
  }

  if (segments.length >= 2 && segments[1] === "memories") {
    if (parsed.method === "GET" && segments.length === 3 && segments[2] === "stats") {
      json(response, 200, { ok: true, stats: context.memoryStats() })
      return true
    }
    if (parsed.method === "GET" && segments.length === 2) {
      const query = parsed.url.searchParams.get("query") ?? undefined
      const scope = parsed.url.searchParams.get("scope") ?? undefined
      const application = parsed.url.searchParams.get("application") ?? undefined
      const key = parsed.url.searchParams.get("key") ?? undefined
      const limit = Number(parsed.url.searchParams.get("limit") ?? "50")
      const includeExpired = parsed.url.searchParams.get("includeExpired") === "true"
      const tags = (parsed.url.searchParams.get("tags") ?? "")
        .split(",")
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0)
      const records = context.memories({
        ...(query === undefined || query.length === 0 ? {} : { query }),
        ...(scope === undefined || scope.length === 0 ? {} : { scope: scope as MemoryQuery["scope"] }),
        ...(application === undefined ? {} : { application }),
        ...(key === undefined ? {} : { key }),
        ...(tags.length === 0 ? {} : { tags }),
        limit: Number.isFinite(limit) ? limit : 50,
        includeExpired,
      })
      json(response, 200, { ok: true, memories: records, total: records.length })
      return true
    }
    if (parsed.method === "POST" && segments.length === 3 && segments[2] === "forget") {
      const body = (await readBody(request)) as Record<string, unknown> | undefined
      if (!isRecord(body)) {
        json(response, 400, { ok: false, error: "A JSON body is required." })
        return true
      }
      const denied = memoryPermission(context, body, "FILES_WRITE")
      if (denied !== undefined) {
        json(response, denied.status, { ok: false, result: denied.result })
        return true
      }
      const removed = context.forgetMemories({
        ...(typeof body.query === "string" ? { query: body.query } : {}),
        ...(typeof body.key === "string" ? { key: body.key } : {}),
        ...(isMemoryScope(body.scope) ? { scope: body.scope } : {}),
        ...(typeof body.application === "string" ? { application: body.application } : {}),
        limit: 100,
      })
      json(response, 200, { ok: true, removed })
      return true
    }
    if (parsed.method === "POST" && segments.length === 2) {
      const body = (await readBody(request)) as Record<string, unknown> | undefined
      if (!isRecord(body) || typeof body.text !== "string" || typeof body.scope !== "string") {
        json(response, 400, { ok: false, error: "scope and text are required." })
        return true
      }
      const denied = memoryPermission(context, body, "FILES_WRITE")
      if (denied !== undefined) {
        json(response, denied.status, { ok: false, result: denied.result })
        return true
      }
      try {
        const record = context.writeMemory({
          scope: body.scope as MemoryWriteInput["scope"],
          text: body.text,
          ...(typeof body.key === "string" ? { key: body.key } : {}),
          ...(asStringArray(body.tags) === undefined ? {} : { tags: asStringArray(body.tags)! }),
          ...(typeof body.application === "string" ? { application: body.application } : {}),
          ...(typeof body.sessionId === "string" ? { sessionId: body.sessionId } : {}),
          ...(typeof body.workspace === "string" ? { workspace: body.workspace } : {}),
          ...(body.source === "agent" || body.source === "system" || body.source === "user" ? { source: body.source } : {}),
          ...(typeof body.confidence === "number" ? { confidence: body.confidence } : {}),
          ...(body.sensitivity === "public" || body.sensitivity === "internal" || body.sensitivity === "private"
            ? { sensitivity: body.sensitivity }
            : {}),
          ...(typeof body.expiresInDays === "number" ? { expiresInDays: body.expiresInDays } : {}),
        })
        json(response, 200, { ok: true, memory: { ...record } })
      } catch (error) {
        json(response, 400, { ok: false, error: error instanceof Error ? error.message : "Invalid memory." })
      }
      return true
    }
    const id = segments[2]
    if (id !== undefined && parsed.method === "DELETE" && segments.length === 3) {
      json(response, 200, { ok: true, removed: context.removeMemory(id) })
      return true
    }
    json(response, 404, { ok: false, error: "Unknown memory route." })
    return true
  }

  if (segments.length >= 2 && segments[1] === "superskills") {
    if (parsed.method === "GET" && segments.length === 2) {
      json(response, 200, { ok: true, superskills: context.superskills() })
      return true
    }
    if (parsed.method === "POST" && segments.length === 2) {
      const body = await readBody(request)
      try {
        const skill = context.saveSuperskill(body)
        json(response, 200, { ok: true, superskill: { ...skill } })
      } catch (error) {
        json(response, 400, { ok: false, error: error instanceof Error ? error.message : "Invalid superskill." })
      }
      return true
    }
    const id = segments[2]
    if (id !== undefined && parsed.method === "GET" && segments.length === 3) {
      const skill = context.superskill(id)
      if (skill === undefined) {
        json(response, 404, { ok: false, error: `Unknown superskill ${id}.` })
        return true
      }
      json(response, 200, { ok: true, superskill: { ...skill } })
      return true
    }
    if (id !== undefined && parsed.method === "DELETE" && segments.length === 3) {
      json(response, 200, { ok: true, removed: context.removeSuperskill(id) })
      return true
    }
    if (id !== undefined && parsed.method === "POST" && segments.length === 4 && segments[3] === "call") {
      const body = (await readBody(request)) as Record<string, unknown> | undefined
      if (!isRecord(body) || typeof body.method !== "string" || body.method.length === 0) {
        json(response, 400, { ok: false, error: "A method is required." })
        return true
      }
      const skill = context.superskill(id)
      if (skill === undefined) {
        json(response, 404, { ok: false, error: `Unknown superskill ${id}.` })
        return true
      }
      const method = skill.methods.find((entry) => entry.name === body.method)
      if (method === undefined) {
        json(response, 400, {
          ok: false,
          error: `Superskill ${id} has no method ${body.method}.`,
          methods: skill.methods.map((entry) => entry.name),
        })
        return true
      }
      const required = method.scopes ?? skill.scopes ?? (skill.bridge.type === "stdio" ? ["PROCESS_EXECUTE"] : ["NETWORK"])
      const decision = context.permissions.evaluate(required, {
        sessionId: typeof body.sessionId === "string" ? body.sessionId : undefined,
        approval: {
          approved: body.approve === true,
          ...(typeof body.approvedBy === "string" ? { approvedBy: body.approvedBy } : {}),
          ...(asStringArray(body.approvedScopes) === undefined
            ? {}
            : { scopes: asStringArray(body.approvedScopes)!.filter(isOmniaScope) }),
        },
      })
      if (!decision.allowed) {
        json(response, decision.status === "denied" ? 403 : 428, {
          ok: false,
          result: {
            success: false,
            status: "rejected",
            message: decision.reason ?? "Permission required.",
            error: {
              code: decision.status === "denied" ? "permission_denied" : "permission_required",
              message: decision.reason ?? "Permission required.",
              retryable: decision.status !== "denied",
              details: { missing: decision.missing },
            },
          },
        })
        return true
      }
      context.events.emit("superskill.called", {
        ...(typeof body.sessionId === "string" ? { sessionId: body.sessionId } : {}),
        data: { superskill: id, method: body.method },
      })
      try {
        const result = await context.callSuperskill(id, body.method, body.params)
        json(response, 200, { ok: true, result })
      } catch (error) {
        json(response, 500, {
          ok: false,
          error: error instanceof Error ? error.message : "The superskill call failed.",
        })
      }
      return true
    }
    json(response, 404, { ok: false, error: "Unknown superskill route." })
    return true
  }

  if (parsed.method === "GET" && segments.length === 2 && segments[1] === "permissions") {
    json(response, 200, {
      ok: true,
      approvalPolicy: context.permissions.approvalPolicy,
      scopes: describePermissions(context.permissions.snapshot()),
    })
    return true
  }

  if (parsed.method === "POST" && segments.length === 2 && segments[1] === "permissions") {
    const body = (await readBody(request)) as Record<string, unknown> | undefined
    if (!isRecord(body) || typeof body.scope !== "string" || !isOmniaScope(body.scope)) {
      json(response, 400, { ok: false, error: "A valid permission scope is required." })
      return true
    }
    const state = body.state
    if (typeof state !== "string" || !(PERMISSION_STATES as readonly string[]).includes(state)) {
      json(response, 400, { ok: false, error: "A valid permission state is required." })
      return true
    }
    context.permissions.set(body.scope, state as PermissionState)
    json(response, 200, { ok: true, scopes: describePermissions(context.permissions.snapshot()) })
    return true
  }

  if (parsed.method === "GET" && segments.length === 2 && segments[1] === "events") {
    const stream = context.subscribe(response)
    return stream !== undefined
  }

  if (segments.length === 3 && segments[1] === "input") {
    if (parsed.method === "GET" && segments[2] === "state") {
      const state = await context.computers.inputState(parsed.url.searchParams.get("computerId") ?? undefined)
      json(response, 200, {
        ok: true,
        frozen: state.frozen,
        supported: state.supported,
        ...(state.reason === undefined ? {} : { reason: state.reason }),
      })
      return true
    }
    if (parsed.method === "POST" && (segments[2] === "freeze" || segments[2] === "release")) {
      const raw = await readBody(request)
      const body = isRecord(raw) ? raw : {}
      const denied = inputControlPermission(context, body)
      if (denied !== undefined) {
        json(response, denied.status, { ok: false, error: denied.error })
        return true
      }
      const computerId = typeof body.computerId === "string" ? body.computerId : undefined
      if (segments[2] === "freeze") {
        const reason = typeof body.reason === "string" ? body.reason : undefined
        const outcome = await context.computers.freezeInput(computerId, reason)
        if (outcome.frozen) {
          json(response, 200, { ok: true, frozen: true, mode: outcome.mode ?? "x11" })
          return true
        }
        json(response, 200, {
          ok: false,
          error: outcome.error ?? "Freezing physical input is not available on this computer.",
          supported: outcome.supported,
        })
        return true
      }
      const outcome = await context.computers.releaseInput(computerId)
      if (outcome.error !== undefined) {
        json(response, 500, { ok: false, error: outcome.error, supported: outcome.supported })
        return true
      }
      json(response, 200, { ok: true, frozen: false, releasedBy: outcome.releasedBy })
      return true
    }
    json(response, 404, { ok: false, error: "Unknown input route." })
    return true
  }

  if (parsed.method === "GET" && segments.length === 2 && segments[1] === "sessions") {
    json(response, 200, { ok: true, sessions: context.sessions() })
    return true
  }

  if (parsed.method === "GET" && segments.length === 2 && [ "agents", "skills", "models" ].includes(segments[1]!)) {
    const catalog = context.catalog()
    const key = segments[1] as "agents" | "skills" | "models"
    json(response, 200, {
      ok: true,
      [key]: catalog[key],
      ...(key === "models" ? { note: "Models are registered by the connected agent runtime; capabilities describe tool calling, vision, and context." } : {}),
    })
    return true
  }

  if (parsed.method === "POST" && segments.length === 2 && segments[1] === "models") {
    const body = (await readBody(request)) as Record<string, unknown> | undefined
    if (!isRecord(body) || !Array.isArray(body.models)) {
      json(response, 400, { ok: false, error: "A models array is required." })
      return true
    }
    const models = body.models.flatMap((entry): ServerCatalogEntry[] => {
      if (!isRecord(entry) || typeof entry.id !== "string" || entry.id.length === 0) return []
      const capabilities = isRecord(entry.capabilities)
        ? Object.fromEntries(
            Object.entries(entry.capabilities).filter(
              (pair): pair is [string, boolean | number] =>
                typeof pair[1] === "boolean" || typeof pair[1] === "number",
            ),
          )
        : undefined
      return [
        {
          id: entry.id,
          ...(typeof entry.name === "string" ? { name: entry.name } : {}),
          ...(typeof entry.description === "string" ? { description: entry.description } : {}),
          ...(typeof entry.provider === "string" ? { provider: entry.provider } : {}),
          ...(capabilities === undefined ? {} : { capabilities }),
        },
      ]
    })
    context.registerModels(models)
    json(response, 200, { ok: true, models: context.catalog().models })
    return true
  }

  if (segments.length >= 2 && segments[1] === "computer-use") {
    if (parsed.method === "GET" && segments.length === 3 && segments[2] === "models") {
      json(response, 200, { ok: true, models: await context.computerUse.models() })
      return true
    }
    if (parsed.method === "GET" && segments.length === 3 && segments[2] === "runtimes") {
      json(response, 200, { ok: true, runtimes: context.computerUse.runtimes() })
      return true
    }
    if (parsed.method === "GET" && segments.length === 3 && segments[2] === "providers") {
      json(response, 200, { ok: true, providers: await context.computerUse.providers() })
      return true
    }
    if (parsed.method === "GET" && segments.length === 3 && segments[2] === "status") {
      json(response, 200, { ok: true, status: await context.computerUse.status() })
      return true
    }
    if (parsed.method === "GET" && segments.length === 3 && segments[2] === "settings") {
      json(response, 200, { ok: true, settings: context.computerUse.settings() })
      return true
    }
    if (parsed.method === "GET" && segments.length === 3 && segments[2] === "diagnostics") {
      json(response, 200, { ok: true, diagnostics: context.computerUse.diagnostics() })
      return true
    }
    if (parsed.method === "POST" && segments.length === 3 && segments[2] === "settings") {
      const body = await readBody(request)
      json(response, 200, { ok: true, settings: context.computerUse.updateSettings(body) })
      return true
    }
    if (parsed.method === "POST" && segments.length === 3 && segments[2] === "route") {
      const body = (await readBody(request)) as Record<string, unknown> | undefined
      if (!isRecord(body)) {
        json(response, 400, { ok: false, error: "A JSON body is required." })
        return true
      }
      const decision = await context.computerUse.route(computerUseContext(body))
      json(response, 200, { ok: true, decision })
      return true
    }
    if (parsed.method === "POST" && segments.length === 3 && segments[2] === "analyze") {
      const body = (await readBody(request)) as Record<string, unknown> | undefined
      if (!isRecord(body)) {
        json(response, 400, { ok: false, error: "A JSON body is required." })
        return true
      }
      const input = {
        computerId: typeof body.computerId === "string" ? body.computerId : context.computers.ids()[0] ?? "local",
        operation: computerUseOperation(body.requestedOperation),
        ...(typeof body.targetDescription === "string" ? { targetDescription: body.targetDescription } : {}),
        ...(typeof body.taskContext === "string" ? { taskContext: body.taskContext } : {}),
        ...(typeof body.question === "string" ? { question: body.question } : {}),
        ...(typeof body.timeoutMs === "number" ? { timeoutMs: body.timeoutMs } : {}),
        ...(typeof body.sessionId === "string" ? { sessionId: body.sessionId } : {}),
        ...(body.approve === true ? { approve: true } : {}),
        ...(typeof body.approvedBy === "string" ? { approvedBy: body.approvedBy } : {}),
        ...(asStringArray(body.approvedScopes) === undefined
          ? {}
          : { approvedScopes: asStringArray(body.approvedScopes)!.filter(isOmniaScope) }),
        execute: body.execute !== false,
      }
      const outcome = await context.computerUse.perform(input)
      json(response, 200, {
        ok: outcome.analysis.result.success,
        ...outcome,
        decision: outcome.analysis.decision,
        result: outcome.analysis.result,
        fallbacks: outcome.analysis.fallbacks,
        ...(outcome.analysis.errorCode === undefined ? {} : { errorCode: outcome.analysis.errorCode }),
        ...(outcome.analysis.result.success
          ? {}
          : { error: outcome.analysis.result.reasoning ?? "Computer-use analysis failed." }),
      })
      return true
    }
    if (segments.length === 5 && segments[2] === "runtimes" && parsed.method === "POST") {
      const id = segments[3]!
      const action = segments[4]!
      if (action === "download") {
        const settings = context.computerUse.settings()
        if (!settings.allowDownloads) {
          json(response, 400, { ok: false, error: "Model downloads are disabled in computer-use settings." })
          return true
        }
        if (!context.computerUse.runtimes().some((entry) => entry.runtime.id === id)) {
          json(response, 404, { ok: false, error: `Unknown computer-use runtime ${id}.` })
          return true
        }
        void context.computerUse.downloadRuntime(id).catch(() => undefined)
        json(response, 200, { ok: true, started: true })
        return true
      }
      json(response, 404, { ok: false, error: `Unknown runtime action ${action}.` })
      return true
    }
    if (segments.length === 4 && segments[2] === "runtimes" && parsed.method === "DELETE") {
      json(response, 200, { ok: true, removed: await context.computerUse.removeRuntime(segments[3]!) })
      return true
    }
    if (segments.length === 5 && segments[2] === "models" && parsed.method === "POST") {
      const id = segments[3]!
      const action = segments[4]!
      if (action === "load") {
        try {
          json(response, 200, { ok: true, model: await context.computerUse.loadModel(id) })
        } catch (error) {
          json(response, 400, { ok: false, error: error instanceof Error ? error.message : "Load failed." })
        }
        return true
      }
      if (action === "unload") {
        json(response, 200, { ok: true, unloaded: await context.computerUse.unloadModel(id) })
        return true
      }
      if (action === "download") {
        const settings = context.computerUse.settings()
        if (!settings.allowDownloads) {
          json(response, 400, { ok: false, error: "Model downloads are disabled in computer-use settings." })
          return true
        }
        if (!(await context.computerUse.models()).some((entry) => entry.model.id === id)) {
          json(response, 404, { ok: false, error: `Unknown computer-use model ${id}.` })
          return true
        }
        // Downloads are large and long-running; start them in the background
        // and let the client follow progress through the models list.
        void context.computerUse.downloadModel(id).catch(() => undefined)
        json(response, 200, { ok: true, started: true })
        return true
      }
      json(response, 404, { ok: false, error: `Unknown model action ${action}.` })
      return true
    }
    if (segments.length === 4 && segments[2] === "models" && parsed.method === "DELETE") {
      json(response, 200, { ok: true, removed: await context.computerUse.removeModel(segments[3]!) })
      return true
    }
    json(response, 404, { ok: false, error: "Unknown computer-use route." })
    return true
  }

  if (segments.length >= 3 && segments[1] === "auth" && segments[2] === "github") {
    if (parsed.method === "GET" && segments.length === 4 && segments[3] === "status") {
      await context.auth.refreshGhAvailability()
      json(response, 200, { ok: true, status: context.auth.status() })
      return true
    }
    if (parsed.method === "POST" && segments.length === 4 && segments[3] === "start") {
      const body = (await readBody(request)) as Record<string, unknown> | undefined
      const method =
        isRecord(body) && body.method === "gh"
          ? "gh"
          : isRecord(body) && body.method === "device"
            ? "device"
            : isRecord(body) && body.method === "loopback"
              ? "loopback"
              : "browser"
      try {
        const result = await context.auth.start(method)
        json(response, 200, { ok: true, ...result })
      } catch (error) {
        json(response, 400, { ok: false, error: error instanceof Error ? error.message : "GitHub sign-in failed." })
      }
      return true
    }
    if (parsed.method === "POST" && segments.length === 4 && segments[3] === "client") {
      const body = (await readBody(request)) as Record<string, unknown> | undefined
      if (!isRecord(body) || typeof body.clientId !== "string") {
        json(response, 400, { ok: false, error: "A clientId is required." })
        return true
      }
      try {
        const status = context.auth.saveOAuthClient(
          body.clientId,
          typeof body.clientSecret === "string" ? body.clientSecret : undefined,
        )
        json(response, 200, { ok: true, status })
      } catch (error) {
        json(response, 400, { ok: false, error: error instanceof Error ? error.message : "Invalid OAuth client." })
      }
      return true
    }
    if (parsed.method === "POST" && segments.length === 4 && segments[3] === "logout") {
      await context.auth.logout()
      json(response, 200, { ok: true, status: context.auth.status() })
      return true
    }
    json(response, 404, { ok: false, error: "Unknown auth route." })
    return true
  }

  json(response, 404, { ok: false, error: "Unknown route." })
  return true
}

function computerUseOperation(value: unknown): ComputerUseOperation {
  return value === "ground" ||
    value === "click" ||
    value === "type" ||
    value === "scroll" ||
    value === "drag" ||
    value === "resize" ||
    value === "inspect" ||
    value === "general"
    ? value
    : "general"
}

function computerUseContext(body: Record<string, unknown>): ComputerUseContext {
  const semantic = isRecord(body.semanticContext)
    ? (body.semanticContext as unknown as SemanticEnvironment)
    : undefined
  const image = isRecord(body.image) ? (body.image as unknown as ImageReference) : undefined
  const privacy: ComputerUsePrivacy | undefined = isRecord(body.privacy)
    ? {
        allowRemoteScreen: body.privacy.allowRemoteScreen === true,
        mode:
          body.privacy.mode === "local_only" || body.privacy.mode === "hosted_only" || body.privacy.mode === "ask"
            ? body.privacy.mode
            : "automatic",
      }
    : undefined
  return {
    computerId: typeof body.computerId === "string" ? body.computerId : "local",
    requestedOperation: computerUseOperation(body.requestedOperation),
    ...(typeof body.targetDescription === "string" ? { targetDescription: body.targetDescription } : {}),
    ...(semantic === undefined ? {} : { semanticContext: semantic }),
    ...(image === undefined ? {} : { image }),
    ...(privacy === undefined ? {} : { privacy }),
  }
}

// Freezing physical input is a system-level action. Agent-originated calls
// carry a sessionId and pass the UI_CONTROL boundary; desktop-originated calls
// have no session because the UI itself is the approver.
function inputControlPermission(
  context: ApiContext,
  body: Record<string, unknown>,
): { status: number; error: string } | undefined {
  if (typeof body.sessionId !== "string" || body.sessionId.length === 0) return undefined
  const decision = context.permissions.evaluate(["UI_CONTROL"], {
    sessionId: body.sessionId,
    approval: {
      approved: body.approve === true,
      ...(typeof body.approvedBy === "string" ? { approvedBy: body.approvedBy } : {}),
      ...(asStringArray(body.approvedScopes) === undefined
        ? {}
        : { scopes: asStringArray(body.approvedScopes)!.filter(isOmniaScope) }),
    },
  })
  if (decision.allowed) return undefined
  return { status: decision.status === "denied" ? 403 : 428, error: decision.reason ?? "Permission required." }
}

// Agent-originated memory traffic carries a sessionId and must pass the same
// permission boundary as any other action; user-originated settings traffic
// does not carry one.
function memoryPermission(
  context: ApiContext,
  body: Record<string, unknown>,
  scope: "FILES_READ" | "FILES_WRITE",
): { status: number; result: Record<string, unknown> } | undefined {
  if (typeof body.sessionId !== "string" || body.sessionId.length === 0) return undefined
  const decision = context.permissions.evaluate([scope], {
    sessionId: body.sessionId,
    approval: {
      approved: body.approve === true,
      ...(typeof body.approvedBy === "string" ? { approvedBy: body.approvedBy } : {}),
      ...(asStringArray(body.approvedScopes) === undefined
        ? {}
        : { scopes: asStringArray(body.approvedScopes)!.filter(isOmniaScope) }),
    },
  })
  if (decision.allowed) return undefined
  return {
    status: decision.status === "denied" ? 403 : 428,
    result: {
      success: false,
      status: "rejected",
      message: decision.reason ?? "Permission required.",
      error: {
        code: decision.status === "denied" ? "permission_denied" : "permission_required",
        message: decision.reason ?? "Permission required.",
        retryable: decision.status !== "denied",
        details: { missing: decision.missing },
      },
    },
  }
}

export function writeEvent(response: ServerResponse, event: ServerEvent): void {
  response.write(`event: ${event.type}\n`)
  response.write(`id: ${event.seq}\n`)
  response.write(`data: ${JSON.stringify(event)}\n\n`)
}
