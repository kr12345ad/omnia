import { createServer } from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { randomBytes, timingSafeEqual } from "node:crypto"
import { EventBus } from "./events"
import { SuperskillRegistry, summarizeSuperskill } from "../superskills/registry"
import { MemoryStore } from "../memory/store"
import { SuperskillBridges } from "../superskills/bridge"
import { ComputerManager, type BrowserController, type ServerComputerDriver } from "./computers"
import { PermissionManager, type ApprovalPolicy, type OmniaScope, type PermissionState } from "./permissions"
import {
  handleRequest,
  isAuthorized,
  json,
  OMNIA_API_PREFIX,
  OMNIA_API_VERSION,
  OMNIA_PROTOCOL_VERSION,
  OMNIA_SSE_HEARTBEAT_MS,
  writeEvent,
  type ApiContext,
  type ServerCatalog,
  type ServerHealth,
  type ServerSession,
  type ServerHealthState,
  type SubsystemHealth,
} from "./api"

export const OMNIA_SERVER_VERSION = "0.1.0"

export interface OmniaServerOptions {
  readonly drivers?: readonly ServerComputerDriver[]
  readonly superskillFile?: string
  readonly memoryFile?: string
  readonly browser?: BrowserController
  readonly token?: string
  readonly now?: () => number
  readonly platform?: string
  readonly version?: string
  readonly approvalPolicy?: ApprovalPolicy
  readonly permissions?: Partial<Record<OmniaScope, PermissionState>>
}

export interface OmniaServerHandle {
  readonly url: string
  readonly token: string
  readonly serverId: string
  readonly protocol: number
  readonly api: string
  readonly startedAt: number
  readonly events: EventBus
  readonly computers: ComputerManager
  readonly permissions: PermissionManager
  register: (driver: ServerComputerDriver) => () => void
  setCatalog: (catalog: Partial<ServerCatalog>) => void
  health: () => ServerHealth
  stop: () => Promise<void>
}

function createServerId(): string {
  return `omnia_${randomBytes(8).toString("hex")}`
}

export async function startOmniaServer(options: OmniaServerOptions = {}): Promise<OmniaServerHandle> {
  const now = options.now ?? Date.now
  const serverId = createServerId()
  const startedAt = now()
  const token = options.token ?? randomBytes(32).toString("hex")
  const events = new EventBus({ serverId, now })
  const superskills = new SuperskillRegistry(
    options.superskillFile === undefined ? {} : { file: options.superskillFile },
  )
  const superskillBridges = new SuperskillBridges()
  const memories = new MemoryStore(options.memoryFile === undefined ? {} : { file: options.memoryFile })
  const capabilityWrites = new Map<string, number>()
  const permissions = new PermissionManager(options.permissions, options.approvalPolicy)
  const sessions = new Map<string, ServerSession>()
  let catalog: ServerCatalog = { agents: [], skills: [], models: [] }
  let state: ServerHealthState = "starting"
  const subsystems = new Map<string, SubsystemHealth>()

  const setSubsystem = (subsystem: SubsystemHealth) => {
    subsystems.set(subsystem.name, subsystem)
  }

  const computers = new ComputerManager({
    events,
    permissions,
    now,
    onObservation: ({ applicationId, observation }) => {
      if (applicationId === undefined || applicationId.length === 0) return
      const at = now()
      const last = capabilityWrites.get(applicationId) ?? 0
      if (at - last < 30000) return
      const elements = observation.elements ?? []
      const accessible = elements.filter((element) => element.source === "accessibility").length
      const roles = [...new Set(elements.map((element) => element.role).filter((role): role is string => typeof role === "string"))]
        .slice(0, 10)
      const text = `${applicationId}: observed ${elements.length} elements (${accessible} from accessibility); roles: ${roles.join(", ") || "none"}.`
      const record = memories.write({
        scope: "application",
        key: `application:${applicationId}:coverage`,
        application: applicationId,
        text,
        source: "system",
        confidence: accessible > 0 ? 0.85 : 0.4,
        sensitivity: "internal",
        tags: ["capability", "accessibility"],
      })
      capabilityWrites.set(applicationId, at)
      events.emit("memory.written", { computerId: "local", data: { id: record.id, scope: record.scope } })
    },
    ...(options.browser === undefined ? {} : { browser: options.browser }),
    onSessionActivity: ({ sessionId, computerId, action, at }) => {
      const existing = sessions.get(sessionId)
      sessions.set(sessionId, {
        id: sessionId,
        computerId,
        actions: (existing?.actions ?? 0) + (action === "observe" || action === "find" ? 0 : 1),
        lastActionAt: at,
      })
      events.emit("session.attached", { sessionId, computerId, data: { action } })
    },
  })

  const health = (): ServerHealth => {
    const list = [...subsystems.values()]
    const failed = list.filter((entry) => entry.status === "failed" || entry.status === "unavailable")
    return {
      status: state === "ready" && failed.length > 0 ? "degraded" : state,
      version: options.version ?? OMNIA_SERVER_VERSION,
      protocol: OMNIA_PROTOCOL_VERSION,
      api: OMNIA_API_PREFIX,
      serverId,
      uptimeMs: now() - startedAt,
      activeSessions: sessions.size,
      connectedComputers: computers.ids().length,
      subsystems: list,
      startedAt,
    }
  }
  const subscribers = new Map<ServerResponse, () => void>()

  const subscribe = (response: ServerResponse): (() => void) => {
    const sinceHeader = response.req.headers["last-event-id"]
    const since = typeof sinceHeader === "string" ? Number(sinceHeader) : undefined
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "access-control-allow-origin": "*",
    })
    response.write(": connected\n\n")
    if (since !== undefined && Number.isFinite(since)) {
      for (const event of events.since(since)) writeEvent(response, event)
    }
    response.write(
      `event: server.snapshot\ndata: ${JSON.stringify({ type: "server.snapshot", health: health() })}\n\n`,
    )
    const unsubscribe = events.subscribe((event) => {
      if (response.writableEnded || response.destroyed) return
      writeEvent(response, event)
    })
    subscribers.set(response, unsubscribe)
    const heartbeat = setInterval(() => {
      if (response.writableEnded || response.destroyed) return
      response.write(": heartbeat\n\n")
    }, OMNIA_SSE_HEARTBEAT_MS)
    heartbeat.unref?.()
    const cleanup = () => {
      clearInterval(heartbeat)
      subscribers.delete(response)
      unsubscribe()
    }
    response.on("close", cleanup)
    return cleanup
  }

  const context: ApiContext = {
    descriptor: {
      serverId,
      version: options.version ?? OMNIA_SERVER_VERSION,
      startedAt,
      platform: options.platform ?? process.platform,
    },
    events,
    computers,
    permissions,
    catalog: () => catalog,
    memories: (query) => memories.search(query),
    memoryStats: () => memories.stats(),
    writeMemory: (input) => {
      const record = memories.write(input)
      events.emit("memory.written", { data: { id: record.id, scope: record.scope } })
      return record
    },
    removeMemory: (id) => {
      const removed = memories.remove(id)
      if (removed) events.emit("memory.forgotten", { data: { id } })
      return removed
    },
    forgetMemories: (query) => {
      const removed = memories.forget(query)
      if (removed > 0) events.emit("memory.forgotten", { data: { removed, ...query } })
      return removed
    },
    superskills: () => superskills.list().map((skill) => summarizeSuperskill(skill)),
    superskill: (id) => superskills.get(id),
    saveSuperskill: (input) => superskills.save(input),
    removeSuperskill: (id) => {
      superskillBridges.close(id)
      return superskills.remove(id)
    },
    callSuperskill: (id, method, params) => {
      const skill = superskills.get(id)
      if (skill === undefined) throw new Error(`Unknown superskill ${id}.`)
      return superskillBridges.call(skill, method, params)
    },
    registerModels: (models) => {
      const incoming = new Set(models.map((model) => model.id))
      catalog = { ...catalog, models: [...catalog.models.filter((model) => !incoming.has(model.id)), ...models] }
    },
    sessions: () => [...sessions.values()],
    health,
    subscribe,
    now,
  }

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      if (!isAuthorized(request, token, (a, b) => timingSafeEqual(a, b))) {
        json(response, 401, { ok: false, error: "Unauthorized." })
        return
      }
      const handled = await handleRequest(context, request, response).catch((error: unknown) => {
        json(response, 500, { ok: false, error: error instanceof Error ? error.message : "Omnia Server request failed." })
        return true
      })
      if (!handled && !response.headersSent) {
        json(response, 404, { ok: false, error: "Unknown route." })
      }
    })()
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })
  const address = server.address() as AddressInfo
  const url = `http://127.0.0.1:${address.port}`

  const unregister: Array<() => void> = []
  for (const driver of options.drivers ?? []) unregister.push(computers.register(driver))

  setSubsystem({ name: "api", status: "ready" })
  setSubsystem({ name: "events", status: "ready" })
  setSubsystem({
    name: "computers",
    status: computers.ids().length > 0 ? "ready" : "degraded",
    ...(computers.ids().length > 0 ? {} : { reason: "No computer runtime is connected." }),
  })

  state = "ready"
  events.emit("server.ready", { data: { url, protocol: OMNIA_PROTOCOL_VERSION } })
  const degradations = health().subsystems.filter((entry) => entry.status !== "ready")
  if (degradations.length > 0) {
    events.emit("server.degraded", {
      data: { subsystems: degradations.map((entry) => `${entry.name}:${entry.status}`) },
    })
  }

  return {
    url,
    token,
    serverId,
    protocol: OMNIA_PROTOCOL_VERSION,
    api: OMNIA_API_VERSION,
    startedAt,
    events,
    computers,
    permissions,
    register: (driver) => {
      const remove = computers.register(driver)
      setSubsystem({ name: "computers", status: "ready" })
      unregister.push(remove)
      return () => {
        remove()
        if (computers.ids().length === 0) {
          setSubsystem({ name: "computers", status: "degraded", reason: "No computer runtime is connected." })
        }
      }
    },
    setCatalog: (next) => {
      catalog = { ...catalog, ...next }
    },
    health,
    stop: async () => {
      state = "stopping"
      superskillBridges.close()
      for (const [responder, unsubscribe] of subscribers) {
        unsubscribe()
        responder.end()
      }
      subscribers.clear()
      events.emit("server.stopping", {})
      for (const remove of unregister.splice(0)) remove()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      state = "stopped"
      events.emit("server.stopped", {})
    },
  }
}
