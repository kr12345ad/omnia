import { createServer } from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { networkInterfaces } from "node:os"
import { randomBytes, timingSafeEqual } from "node:crypto"
import { EventBus } from "./events"
import { SuperskillRegistry, summarizeSuperskill } from "../superskills/registry"
import { MemoryStore } from "../memory/store"
import { SpecialistStore } from "../specialists/store"
import { CredentialStore } from "../credentials"
import { PairingManager, startPairingDiscovery } from "../pairing"
import { CalibrationManager } from "../computer-use/calibration"
import { RemoteRegistry } from "./remote"
import { SuperskillBridges } from "../superskills/bridge"
import {
  ComputerUseService,
  DEFAULT_COMPUTER_USE_SETTINGS,
  DefaultComputerUseRouter,
  LocalModelManager,
  createComputerUseCatalog,
  createProviders,
  type RoutingWeights,
} from "../computer-use"
import { GitHubAuth, defaultGitHubAuthFile } from "../auth/github"
import { ComputerManager, type BrowserController, type ServerComputerDriver } from "./computers"
import { PermissionManager, type ApprovalPolicy, type OmniaScope, type PermissionState } from "./permissions"
import { ApprovalRegistry } from "../security/approval"
import { pairingCodeHash } from "../pairing/discovery"
import {
  eventFrame,
  handleRequest,
  InvalidJsonBodyError,
  isAuthorized,
  isPublicApiRoute,
  json,
  OMNIA_API_PREFIX,
  OMNIA_API_VERSION,
  OMNIA_PROTOCOL_VERSION,
  OMNIA_SSE_HEARTBEAT_MS,
  RequestBodyTooLargeError,
  SessionMismatchError,
  SessionUnboundError,
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
  readonly specialistsFile?: string
  readonly credentialsFile?: string
  readonly computerUseFile?: string
  readonly pairingsFile?: string
  readonly authFile?: string
  readonly githubClientId?: string
  readonly githubClientSecret?: string
  readonly githubRedirectUri?: string
  readonly githubFetch?: typeof fetch
  readonly modelsDir?: string
  readonly modelDirs?: readonly string[]
  readonly llamaDirs?: readonly string[]
  readonly routingWeights?: Partial<RoutingWeights>
  readonly browser?: BrowserController
  readonly token?: string
  readonly host?: string
  readonly port?: number
  readonly publicUrl?: string
  readonly discovery?: boolean
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
  readonly credentials: CredentialStore
  readonly pairings: PairingManager
  readonly computerUse: ComputerUseService
  readonly auth: GitHubAuth
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
  const memories = new MemoryStore({
    ...(options.memoryFile === undefined ? {} : { file: options.memoryFile }),
    now,
  })
  const specialists = new SpecialistStore(options.specialistsFile === undefined ? {} : { file: options.specialistsFile })
  const credentials = new CredentialStore(
    options.credentialsFile === undefined ? {} : { file: options.credentialsFile },
  )
  const pairings = new PairingManager({
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.pairingsFile === undefined ? {} : { file: options.pairingsFile }),
  })
  const calibration = new CalibrationManager(options.now === undefined ? {} : { now: options.now })
  const auth = new GitHubAuth({
    events,
    file: options.authFile ?? defaultGitHubAuthFile(),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.githubClientId === undefined ? {} : { clientId: options.githubClientId }),
    ...(options.githubClientSecret === undefined ? {} : { clientSecret: options.githubClientSecret }),
    ...(options.githubRedirectUri === undefined ? {} : { redirectUri: options.githubRedirectUri }),
    ...(options.publicUrl === undefined ? {} : { publicUrl: options.publicUrl }),
    ...(options.githubFetch === undefined ? {} : { fetchImpl: options.githubFetch }),
  })
  const computerUseCatalog = createComputerUseCatalog()
  const localModels = new LocalModelManager({
    catalog: computerUseCatalog,
    events,
    ...(options.modelsDir === undefined ? {} : { modelsDir: options.modelsDir }),
    ...(options.modelDirs === undefined ? {} : { modelDirs: options.modelDirs }),
    ...(options.llamaDirs === undefined ? {} : { runtimeDirs: options.llamaDirs }),
  })
  let computerUseService: ComputerUseService
  const capabilityWrites = new Map<string, number>()
  const approvals = new ApprovalRegistry()
  const permissions = new PermissionManager(options.permissions, options.approvalPolicy, {
    now,
    approvals,
  })
  const sessions = new Map<string, ServerSession>()
  const MAX_TRACKED_SESSIONS = 500
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
    calibration,
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
      if (capabilityWrites.size >= 1000) {
        const oldest = capabilityWrites.keys().next().value
        if (oldest !== undefined) capabilityWrites.delete(oldest)
      }
      capabilityWrites.set(applicationId, at)
      events.emit("memory.written", { computerId: "local", data: { id: record.id, scope: record.scope } })
    },
    ...(options.browser === undefined ? {} : { browser: options.browser }),
    credentials,
    onSessionActivity: ({ sessionId, computerId, action, at }) => {
      const existing = sessions.get(sessionId)
      if (existing === undefined && sessions.size >= MAX_TRACKED_SESSIONS) {
        const oldest = sessions.keys().next().value
        if (oldest !== undefined) sessions.delete(oldest)
      }
      sessions.delete(sessionId)
      sessions.set(sessionId, {
        id: sessionId,
        computerId,
        actions: (existing?.actions ?? 0) + (action === "observe" || action === "find" ? 0 : 1),
        lastActionAt: at,
      })
      // Attach is a state change, not a per-action heartbeat.
      if (existing === undefined || existing.computerId !== computerId) {
        events.emit("session.attached", { sessionId, computerId, data: { action } })
      }
    },
  })

  const unregister: Array<() => void> = []
  const registerComputer = (driver: ServerComputerDriver): (() => void) => {
    const remove = computers.register(driver)
    setSubsystem({ name: "computers", status: "ready" })
    unregister.push(remove)
    return () => {
      remove()
      if (computers.ids().length === 0) {
        setSubsystem({ name: "computers", status: "degraded", reason: "No computer runtime is connected." })
      }
    }
  }
  const remote = new RemoteRegistry({
    events,
    registerDriver: (driver) => registerComputer(driver),
    now,
  })

  const computerUseSettings = () => computerUseService?.settings() ?? DEFAULT_COMPUTER_USE_SETTINGS
  const computerUseProviders = createProviders({
    catalog: computerUseCatalog,
    local: localModels,
    settings: computerUseSettings,
  })
  const computerUseRouter = new DefaultComputerUseRouter({
    providers: computerUseProviders,
    local: localModels,
    settings: computerUseSettings,
    ...(options.routingWeights === undefined ? {} : { weights: options.routingWeights }),
  })
  computerUseService = new ComputerUseService({
    manager: computers,
    local: localModels,
    router: computerUseRouter,
    providers: computerUseProviders,
    catalog: computerUseCatalog,
    events,
    calibration,
    ...(options.computerUseFile === undefined ? {} : { settingsFile: options.computerUseFile }),
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

  // SSE frames are queued while the socket is saturated. A subscriber that
  // stays saturated past the queue cap is dropped: keeping unbounded frames
  // for a dead reader would grow memory without bound.
  const MAX_SSE_PENDING_FRAMES = 256

  const subscribe = (response: ServerResponse): (() => void) => {
    const sinceHeader = response.req.headers["last-event-id"]
    const since = typeof sinceHeader === "string" ? Number(sinceHeader) : undefined
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "access-control-allow-origin": "*",
    })
    let unsubscribe: () => void = () => {}
    let heartbeat: ReturnType<typeof setInterval> | undefined
    let closed = false
    const cleanup = () => {
      if (closed) return
      closed = true
      if (heartbeat !== undefined) clearInterval(heartbeat)
      response.off("drain", flush)
      subscribers.delete(response)
      unsubscribe()
    }
    let saturated = false
    const pending: string[] = []
    const flush = () => {
      saturated = false
      while (pending.length > 0 && !saturated) {
        const frame = pending.shift()
        if (frame === undefined) return
        if (response.writableEnded || response.destroyed) return
        if (!response.write(frame)) saturated = true
      }
    }
    const send = (frame: string) => {
      if (response.writableEnded || response.destroyed) return
      if (saturated || pending.length > 0) {
        if (pending.length >= MAX_SSE_PENDING_FRAMES) {
          cleanup()
          response.destroy()
          return
        }
        pending.push(frame)
        return
      }
      if (!response.write(frame)) saturated = true
    }
    response.on("drain", flush)
    send(": connected\n\n")
    if (since !== undefined && Number.isFinite(since)) {
      for (const event of events.since(since)) send(eventFrame(event))
    }
    send(
      `event: server.snapshot\ndata: ${JSON.stringify({ type: "server.snapshot", health: health() })}\n\n`,
    )
    // A reader that stayed saturated through the backlog was already torn down
    // by send(); subscribing and arming the heartbeat for it would leave a
    // listener on the event bus and an interval that nothing ever clears.
    if (closed) return cleanup
    unsubscribe = events.subscribe((event) => send(eventFrame(event)))
    subscribers.set(response, unsubscribe)
    heartbeat = setInterval(() => send(": heartbeat\n\n"), OMNIA_SSE_HEARTBEAT_MS)
    heartbeat.unref?.()
    response.on("close", cleanup)
    return cleanup
  }

  // Resolved lazily: the bound port and LAN address only exist after listen.
  const pairingUrl = () => {
    if (options.publicUrl !== undefined && options.publicUrl.length > 0) {
      return options.publicUrl.replace(/\/+$/, "")
    }
    const bound = server.address() as AddressInfo | null
    const port = bound === null ? 0 : bound.port
    const host = options.host
    if (host !== undefined && host !== "127.0.0.1" && host !== "localhost") {
      const lan = Object.values(networkInterfaces())
        .flat()
        .find((entry) => entry !== undefined && entry.family === "IPv4" && entry.internal === false)
      if (lan !== undefined) return `http://${lan.address}:${port}`
    }
    return `http://127.0.0.1:${port}`
  }

  const context: ApiContext = {
    descriptor: {
      serverId,
      version: options.version ?? OMNIA_SERVER_VERSION,
      startedAt,
      platform: options.platform ?? process.platform,
    },
    token,
    events,
    computers,
    permissions,
    credentials,
    pairings,
    remote,
    pairingUrl,
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
    specialists: () => specialists.load(),
    saveSpecialists: (input) => specialists.save(input),
    resetSpecialists: () => specialists.reset(),
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
    computerUse: computerUseService,
    calibration,
    approvals,
    auth,
    health,
    subscribe,
    now,
  }

  // Pairing codes are 40 bits; an unauthenticated claim endpoint needs a
  // per-address attempt limit so the code space cannot be brute-forced.
  const claimAttempts = new Map<string, { count: number; resetAt: number }>()
  const CLAIM_ATTEMPT_LIMIT = 10
  const CLAIM_ATTEMPT_WINDOW_MS = 60_000
  const claimRateLimited = (address: string): boolean => {
    const at = now()
    const entry = claimAttempts.get(address)
    if (entry === undefined || entry.resetAt <= at) {
      if (claimAttempts.size >= 1000) {
        const oldest = claimAttempts.keys().next().value
        if (oldest !== undefined) claimAttempts.delete(oldest)
      }
      claimAttempts.set(address, { count: 1, resetAt: at + CLAIM_ATTEMPT_WINDOW_MS })
      return false
    }
    entry.count += 1
    return entry.count > CLAIM_ATTEMPT_LIMIT
  }

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      // CORS preflight must succeed before any bearer check or browsers can
      // never reach the authenticated handlers.
      if (request.method === "OPTIONS") {
        json(response, 204, {})
        return
      }
      const authorization = ((): "ok" | "unauthorized" | "bad_request" => {
        if (isAuthorized(request, token, (a, b) => timingSafeEqual(a, b), auth)) return "ok"
        const url = new URL(request.url ?? "/", "http://127.0.0.1")
        if (isPublicApiRoute(request.method ?? "", url.pathname)) return "ok"
        if (request.method === "POST" && url.pathname === `${OMNIA_API_PREFIX}/computers/pair/claim`) {
          const address = request.socket.remoteAddress ?? "unknown"
          return claimRateLimited(address) ? "unauthorized" : "ok"
        }
        const match = url.pathname.match(/^\/v1\/computers\/([^/]+)\/remote\//)
        if (match?.[1] !== undefined) {
          let computerId: string
          try {
            computerId = decodeURIComponent(match[1])
          } catch {
            return "bad_request"
          }
          const bearer = request.headers.authorization?.replace(/^Bearer\s+/i, "")
          return remote.authorize(computerId, bearer) ? "ok" : "unauthorized"
        }
        return "unauthorized"
      })()
      if (authorization === "bad_request") {
        json(response, 400, { ok: false, error: "The computer id in the request path is not valid percent-encoding." })
        return
      }
      if (authorization !== "ok") {
        const url = new URL(request.url ?? "/", "http://127.0.0.1")
        const rateLimited =
          request.method === "POST" && url.pathname === `${OMNIA_API_PREFIX}/computers/pair/claim`
        json(response, rateLimited ? 429 : 401, {
          ok: false,
          error: rateLimited ? "Too many pairing attempts; try again shortly." : "Unauthorized.",
        })
        return
      }
      const handled = await handleRequest(context, request, response).catch((error: unknown) => {
        if (error instanceof RequestBodyTooLargeError) {
          // The rest of the oversized body is still in flight; close the
          // connection after answering so it cannot be read as a next request.
          if (!response.headersSent) response.setHeader("connection", "close")
          json(response, error.status, { ok: false, error: error.message })
          request.resume()
          response.once("finish", () => request.destroy())
          return true
        }
        if (error instanceof InvalidJsonBodyError) {
          json(response, error.status, { ok: false, error: error.message })
          return true
        }
        if (error instanceof SessionUnboundError) {
          json(response, error.status, { ok: false, error: error.code, message: error.message })
          return true
        }
        if (error instanceof SessionMismatchError) {
          json(response, error.status, { ok: false, error: error.code, message: error.message })
          return true
        }
        // Never leak internal error messages to clients.
        console.error("omnia server request failed", error)
        json(response, 500, { ok: false, error: "Omnia Server request failed." })
        return true
      })
      if (!handled && !response.headersSent) {
        json(response, 404, { ok: false, error: "Unknown route." })
      }
    })()
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })
  const address = server.address() as AddressInfo
  const url = `http://127.0.0.1:${address.port}`
  // Hosted deployments gate pairing centrally and never advertise on the LAN;
  // loopback-only embedded servers must not broadcast either.
  const pairingDiscovery =
    options.discovery === false
      ? undefined
      : startPairingDiscovery({
          lookup: (codeHash) => {
            const offer = pairings.list().find((entry) => pairingCodeHash(entry.code) === codeHash)
            return offer === undefined ? undefined : { code: offer.code, url: pairingUrl() }
          },
        })

  for (const driver of options.drivers ?? []) registerComputer(driver)

  setSubsystem({ name: "api", status: "ready" })
  setSubsystem({ name: "events", status: "ready" })
  setSubsystem({
    name: "computers",
    status: computers.ids().length > 0 ? "ready" : "degraded",
    ...(computers.ids().length > 0 ? {} : { reason: "No computer runtime is connected." }),
  })

  void localModels
    .verifyAll()
    .then(() => localModels.runtime())
    .then((runtime) => {
      setSubsystem({
        name: "computer-use",
        status: runtime.available ? "ready" : "degraded",
        ...(runtime.available
          ? {}
          : { reason: runtime.reason ?? "No local llama.cpp runtime is available; semantic interaction still works." }),
      })
      events.emit("computer_use.ready", {
        data: { runtime: runtime.available, backend: runtime.backend, models: localModels.list().filter((entry) => entry.installed).length },
      })
    })
    // Verification and runtime probing touch the filesystem and spawn
    // processes; a rejection here must not become an unhandled rejection that
    // takes the process down, and health must still report the subsystem.
    .catch((error: unknown) => {
      console.error("omnia server computer-use probe failed", error)
      setSubsystem({
        name: "computer-use",
        status: "degraded",
        reason: `The local model probe failed: ${error instanceof Error ? error.message : "unknown error"}`,
      })
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
    credentials,
    pairings,
    computerUse: computerUseService,
    auth,
    register: (driver) => registerComputer(driver),
    setCatalog: (next) => {
      catalog = { ...catalog, ...next }
    },
    health,
    stop: async () => {
      state = "stopping"
      await localModels.unload()
      superskillBridges.close()
      remote.close()
      pairingDiscovery?.close()
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
