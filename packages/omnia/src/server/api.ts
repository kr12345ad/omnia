import type { IncomingMessage, ServerResponse } from "node:http"
import type { EventBus, ServerEvent } from "./events"
import type { ComputerManager, ServerActionRequest, ServerBatchStep } from "./computers"
import { OMNIA_ACTION_CATALOG } from "./catalog"
import { parseActionScript, renderAnthropicTools, renderCatalogText, renderOpenAiTools } from "./text-protocol"
import { summarizeSuperskill } from "../superskills/registry"
import type { Superskill, SuperskillSummary } from "../superskills/types"
import type { MemoryQuery, MemoryRecord, MemoryStats, MemoryWriteInput } from "../memory/types"
import { isMemoryScope } from "../memory/store"
import { describePermissions, isOmniaScope, PERMISSION_STATES, type PermissionManager, type PermissionState } from "./permissions"

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
    "access-control-allow-methods": "GET, POST, OPTIONS",
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

  if (segments.length >= 4 && segments[1] === "computers") {
    const computerId = segments[2]!
    const action = segments[3]!
    const computer = context.computers.get(computerId)
    if (!computer) {
      json(response, 404, { ok: false, error: `Unknown computer ${computerId}.` })
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

  json(response, 404, { ok: false, error: "Unknown route." })
  return true
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
