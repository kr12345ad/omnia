import { createServer } from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { networkInterfaces } from "node:os"
import { dirname, join } from "node:path"
import { randomBytes, timingSafeEqual } from "node:crypto"
import { EventBus } from "./events"
import { SuperskillRegistry, summarizeSuperskill } from "../superskills/registry"
import { MemoryStore } from "../memory/store"
import { SpecialistStore } from "../specialists/store"
import { ScheduledRunStore } from "../agent-run/store"
import { RunScheduler } from "../agent-run/scheduler"
import { openCodeRunnerFromEnv } from "../agent-run/client"
import { check as billingCheck, readBillingState, billingStateReadable, writeBillingState } from "../billing/store"
import { failsClosed } from "../billing/plans"
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
import { createDiscordTransport } from "../chat/discord"
import { checkGChatApp, createGChatTransport } from "../chat/gchat"
import { createSlackTransport } from "../chat/slack"
import { conversationKeyFor, createChatAgentRunner } from "../chat/runner"
import { ChatChannelsRuntime } from "../chat/service"
import { ChatSessionStore } from "../chat/sessions"
import { ComputerManager, type BrowserController, type ExecuteOutcome, type ServerActionRequest, type ServerComputerDriver } from "./computers"
import { PermissionManager, requiredScopesForAction, type ApprovalPolicy, type OmniaScope, type PermissionState } from "./permissions"
import { ApprovalRegistry } from "../security/approval"
import { EnterpriseRuntime, type EnterpriseRuntimeOptions } from "../enterprise/runtime"
import {
  SecurityJournal,
  appendComputerUseRecord,
  readComputerUseTrail,
  type ComputerUseExecutionInput,
  type ComputerUseTrailFilter,
} from "../security/journal"
import { redactError } from "../security/redaction"
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
  readonly runsFile?: string
  readonly credentialsFile?: string
  readonly computerUseFile?: string
  readonly pairingsFile?: string
  readonly chatChannelsFile?: string
  readonly chatSessionsFile?: string
  readonly authFile?: string
  readonly auditFile?: string
  readonly computerUseAuditFile?: string
  readonly githubClientId?: string
  readonly githubClientSecret?: string
  readonly githubRedirectUri?: string
  readonly googleClientId?: string
  readonly googleClientSecret?: string
  readonly googleRedirectUri?: string
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
  readonly corsOrigins?: readonly string[]
  readonly now?: () => number
  readonly platform?: string
  readonly version?: string
  readonly approvalPolicy?: ApprovalPolicy
  readonly permissions?: Partial<Record<OmniaScope, PermissionState>>
  /** Self-hosted enterprise control plane, mounted at /admin and /v1/enterprise. */
  readonly enterprise?: EnterpriseServerOptions
}

export interface EnterpriseServerOptions extends Omit<EnterpriseRuntimeOptions, "version"> {
  /**
   * Binding beyond loopback is only legal for the enterprise control plane,
   * which has its own login. The ordinary computer-control server must stay on
   * loopback: its bearer is a root credential.
   */
  readonly allowRemote?: boolean
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
  readonly chatChannels: ChatChannelsRuntime
  readonly computerUse: ComputerUseService
  readonly auth: GitHubAuth
  readonly enterprise?: EnterpriseRuntime
  register: (driver: ServerComputerDriver) => () => void
  setCatalog: (catalog: Partial<ServerCatalog>) => void
  health: () => ServerHealth
  stop: () => Promise<void>
}

function createServerId(): string {
  return `omnia_${randomBytes(8).toString("hex")}`
}

// Journal every computer-use action at the manager boundary.
//
// Wrapping the instance rather than a call site is what makes the trail
// complete: the action routes (POST /v1/computers/:id/actions, /do, /text) and
// the semantic computer-use service both reach the manager through this
// wrapper, and a batch step is journaled by executeBatch's own per-step execute
// call, so no path double counts and no path is missed. The Cua route is the one
// path that does not come through here - it reaches its engine driver directly -
// so it journals through the same writer via journalComputerUseAction below.
//
// The record is built by the journal from the request, the observations either
// side of the action, and the execution's own verification, so the aim strategy
// (including a bounds-center guess) and the verified/not_verified verdict are
// the ones the execution actually produced. A journal failure marks the audit
// storage failed, which fails the server closed exactly as the event
// subscriber above does; it never changes the action's result.
function journalComputerUseActions(
  manager: ComputerManager,
  options: {
    readonly journal: SecurityJournal
    readonly serverId: string
    readonly now: () => number
    readonly onFailure: () => void
  },
): ComputerManager {
  const execute = manager.execute.bind(manager)
  const audited = Object.create(manager) as ComputerManager
  audited.execute = async (id: string, request: ServerActionRequest): Promise<ExecuteOutcome> => {
    const before = manager.get(id)?.lastObservation
    const outcome = await execute(id, request)
    const target = request.target
    const ref = target?.elementId ?? target?.id
    const written = appendComputerUseRecord(options.journal, {
      computerId: id,
      serverId: options.serverId,
      at: options.now(),
      request: {
        action: request.action,
        ...(ref === undefined ? {} : { ref }),
        ...(request.query === undefined ? {} : { query: request.query }),
        // A window action reaches the manager as a title, so the trail records
        // the title the request named even before anything is resolved.
        ...(request.window === undefined ? {} : { window: request.window }),
        ...(target?.observationId === undefined ? {} : { observationId: target.observationId }),
        ...(request.observationId === undefined ? {} : { observationId: request.observationId }),
        ...(target?.generation === undefined ? {} : { generation: target.generation }),
        ...(request.x === undefined ? {} : { x: request.x }),
        ...(request.y === undefined ? {} : { y: request.y }),
        ...(request.approvedBy === undefined ? {} : { approvedBy: request.approvedBy }),
        ...(request.origin === undefined ? {} : { origin: request.origin }),
        ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
      },
      outcome: outcome.result,
      scopes: requiredScopesForAction(request.action),
      ...(before === undefined ? {} : { before }),
      after: manager.get(id)?.lastObservation,
    })
    if (!written) options.onFailure()
    return outcome
  }
  return audited
}

export async function startOmniaServer(options: OmniaServerOptions = {}): Promise<OmniaServerHandle> {
  if (
    !["127.0.0.1", "localhost", "::1"].includes(options.host ?? "127.0.0.1") &&
    options.enterprise?.allowRemote !== true
  ) {
    throw new Error("Omnia Server must bind to loopback. Use an authenticated HTTPS proxy or tunnel for remote access.")
  }
  if (
    options.enterprise !== undefined &&
    options.enterprise.publicUrl.trim().length === 0 &&
    options.enterprise.mode !== "lan"
  ) {
    throw new Error(
      "Enterprise mode requires a public URL, or mode \"lan\" to answer from the address each request arrived on.",
    )
  }
  const now = options.now ?? Date.now
  const serverId = createServerId()
  const startedAt = now()
  const token = options.token ?? randomBytes(32).toString("hex")
  if (token.trim().length === 0) throw new Error("Omnia Server requires a non-empty bearer token.")
  const publicOrigin =
    options.publicUrl === undefined || options.publicUrl.trim().length === 0 ? undefined : new URL(options.publicUrl).origin
  const corsOrigins = new Set([
    ...(options.corsOrigins ?? ["oc://renderer", ...(publicOrigin === undefined ? [] : [publicOrigin])]),
    ...(options.enterprise?.devOrigins ?? []),
  ])
  if (corsOrigins.has("*") || corsOrigins.has("null")) throw new Error("CORS origins must be explicit origins.")
  const enterprise =
    options.enterprise === undefined
      ? undefined
      : new EnterpriseRuntime({
          ...options.enterprise,
          version: options.version ?? OMNIA_SERVER_VERSION,
        })
  const events = new EventBus({ serverId, now })
  const auditFile = options.auditFile ?? process.env.OMNIA_AUDIT_FILE ??
    join(dirname(options.authFile ?? defaultGitHubAuthFile()), "audit", `${serverId}.jsonl`)
  const audit = new SecurityJournal(auditFile)
  // The computer-use trail is a second journal, not more records in the one
  // above. That journal is documented as security metadata only - admission,
  // status and privileged events, never request bodies, page contents or query
  // strings - and a regression test enforces it. A computer-use record has to
  // carry the element ref, the aim point and the verification the reliability
  // contract asks for (docs/computer-use-reliability.md), which is payload by
  // that policy. So the trail gets its own private file, its own key and its
  // own HMAC chain, and the security journal keeps its write path untouched.
  const computerUseAudit = new SecurityJournal(
    options.computerUseAuditFile ?? `${auditFile.replace(/\.jsonl$/, "")}.computer-use.jsonl`,
  )
  let auditFailed = false
  const failAudit = () => {
    auditFailed = true
  }
  const unsubscribeAudit = events.subscribe((event) => {
    if (!/^(server\.|action\.|permission\.|credential\.|auth\.|computer\.pair|browser\.action)/.test(event.type)) return
    try {
      // Event payloads may include observations, commands or page contents.
      // Persist only security metadata, never the payload itself.
      audit.append({ type: event.type, at: event.at, serverId,
        ...(event.computerId === undefined ? {} : { computerId: event.computerId }),
        ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
      })
    } catch {
      auditFailed = true
    }
  })
  const superskills = new SuperskillRegistry(
    options.superskillFile === undefined ? {} : { file: options.superskillFile },
  )
  const superskillBridges = new SuperskillBridges()
  const memories = new MemoryStore({
    ...(options.memoryFile === undefined ? {} : { file: options.memoryFile }),
    now,
  })
  const specialists = new SpecialistStore(options.specialistsFile === undefined ? {} : { file: options.specialistsFile })
  const runs = new ScheduledRunStore(options.runsFile === undefined ? {} : { file: options.runsFile })
  let scheduler: RunScheduler | undefined
  try {
    const runnerConfig = openCodeRunnerFromEnv()
    if (runnerConfig !== undefined) {
      scheduler = new RunScheduler({
        config: runnerConfig,
        store: runs,
        gate: async (run) => {
          // Every execution is billed on its own, against the CURRENT store:
          // a lapsed plan stops firing even when the entry predates the lapse,
          // and a hard allowance cannot be honored while the counter is unknown.
          const file = process.env.OMNIA_BILLING_FILE
          if (file === undefined || !billingStateReadable(file)) {
            return failsClosed("scheduled_runs", "free")
              ? { allowed: false, reason: "Billing is not configured, so scheduled runs are refused." }
              : { allowed: true }
          }
          const state = readBillingState(file)
          // Each queued run stays bound to its creator, even when the control
          // plane hosts several profiles. Never charge or authorize the first
          // subscription in the store for somebody else's unattended work.
          const result = billingCheck(state, run.profileId, "scheduled_runs")
          if (!result.decision.allowed) {
            return { allowed: false, reason: result.decision.reason ?? "Scheduled runs are not included in this plan." }
          }
          if (result.consumed) {
            try {
              writeBillingState(file, result.state)
            } catch {
              return { allowed: false, reason: "Scheduled run usage could not be stored, so the run was not started." }
            }
          }
          return { allowed: true }
        },
      })
      scheduler.start()
    }
  } catch {
    // A malformed runner config must never stop the control plane itself.
  }
  const credentials = new CredentialStore(
    options.credentialsFile === undefined ? {} : { file: options.credentialsFile },
  )
  const pairings = new PairingManager({
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.pairingsFile === undefined ? {} : { file: options.pairingsFile }),
  })
  // Chat channels answer on messaging platforms. The runtime owns the
  // connection table and the webhook receiver; a platform that has to be
  // dialled out to gets a transport only once an operator connects it.
  const chatChannels = new ChatChannelsRuntime({
    ...(options.chatChannelsFile === undefined ? {} : { file: options.chatChannelsFile }),
    // The channel binding is signed with the server's own token, so editing the
    // channel file to point at another account is refused instead of obeyed.
    secret: token,
  })
  // One agent session per conversation, remembered across restarts so a
  // channel keeps its context when the control plane comes back.
  const chatSessions = new ChatSessionStore(
    options.chatSessionsFile === undefined ? {} : { file: options.chatSessionsFile },
  )
  chatChannels.setAgentRunner(createChatAgentRunner({ sessions: chatSessions }))
  // A channel that already has a session is a conversation: plain messages
  // there belong to Omnia. Anywhere else the bot waits to be mentioned.
  chatChannels.setConversationCheck(
    (platform, channelId) => chatSessions.get(conversationKeyFor(platform, channelId)) !== undefined,
  )
  chatChannels.setTransportFactory(({ platform, credentials, onMessage, onError, isConversation }) => {
    // Google Chat delivers each interaction to the webhook route; this side is
    // what replies, traces and chunks, authenticated by the service account.
    if (platform === "gchat") {
      const serviceAccount = credentials.credentials
      if (serviceAccount === undefined || serviceAccount.length === 0) return undefined
      return createGChatTransport({
        credentials: serviceAccount,
        onMessage,
        onError,
        log: (line) => console.log(`[chat:gchat] ${line}`),
      })
    }
    // Slack posts each mention and DM to the webhook route; this side is the
    // reply half, authenticated by the bot token of the installed app.
    if (platform === "slack") {
      const botToken = credentials.botToken
      if (botToken === undefined || botToken.length === 0) return undefined
      return createSlackTransport({
        token: botToken,
        onMessage,
        onError,
        log: (line) => console.log(`[chat:slack] ${line}`),
      })
    }
    if (platform !== "discord") return undefined
    const token = credentials.botToken
    if (token === undefined || token.length === 0) return undefined
    return createDiscordTransport({
      token,
      onMessage,
      onError,
      isConversation,
      log: (line) => console.log(`[chat:discord] ${line}`),
    })
  })
  // A Google Chat app exists only after it is configured in the console, and
  // until then Google answers every call with "Chat app not found" and never
  // delivers anything. Asking its API is the difference between a channel that
  // is switched on and one that will actually answer.
  chatChannels.setChannelCheck((platform, credentials) =>
    platform === "gchat" ? checkGChatApp({ credentials: credentials.credentials ?? "" }) : Promise.resolve(undefined),
  )
  const calibration = new CalibrationManager(options.now === undefined ? {} : { now: options.now })
  const auth = new GitHubAuth({
    events,
    file: options.authFile ?? defaultGitHubAuthFile(),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.githubClientId === undefined ? {} : { clientId: options.githubClientId }),
    ...(options.githubClientSecret === undefined ? {} : { clientSecret: options.githubClientSecret }),
    ...(options.githubRedirectUri === undefined ? {} : { redirectUri: options.githubRedirectUri }),
    ...(options.googleClientId === undefined ? {} : { googleClientId: options.googleClientId }),
    ...(options.googleClientSecret === undefined ? {} : { googleClientSecret: options.googleClientSecret }),
    ...(options.googleRedirectUri === undefined ? {} : { googleRedirectUri: options.googleRedirectUri }),
    ...(options.publicUrl === undefined ? {} : { publicUrl: options.publicUrl }),
    ...(options.githubFetch === undefined ? {} : { fetchImpl: options.githubFetch }),
  })
  // Channels answer as the account that connected them. A later sign-in with a
  // different account pauses every channel instead of running under it.
  chatChannels.setIdentity(() => auth.status().profile)
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

  const computerManager = new ComputerManager({
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

  // One journaled boundary for every computer-use action, shared by the action
  // routes and the semantic computer-use service.
  const computers = journalComputerUseActions(computerManager, {
    journal: computerUseAudit,
    serverId,
    now,
    onFailure: failAudit,
  })

  // The Cua routes (POST /v1/computers/:id/cua/act) reach the engine driver
  // directly, so they never pass through the wrapper above and would otherwise
  // land actions on a real desktop with nothing in the trail. They journal
  // through the same writer, fed with what the route parsed out of its own
  // request: one implementation, so a Cua action carries the same fields as
  // every other computer-use action.
  const journalComputerUseAction = (input: ComputerUseExecutionInput) => {
    if (!appendComputerUseRecord(computerUseAudit, input)) failAudit()
  }

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
    auditPublicAuthentication: (request) => {
      if (auditFailed) return false
      try {
        audit.append({ type: "public.authentication_verified", at: now(), serverId, method: request.method,
          route: new URL(request.url ?? "/", "http://127.0.0.1").pathname.slice(0, 256),
          address: request.socket.remoteAddress,
        })
        return true
      } catch {
        auditFailed = true
        return false
      }
    },
    events,
    computers,
    // Read-only: the journal is re-opened per request and never locked against
    // the writer, so a running server keeps appending while the trail is read.
    computerUseTrail: (filter) => readComputerUseTrail(computerUseAudit.file, filter),
    journalComputerUse: journalComputerUseAction,
    permissions,
    credentials,
    pairings,
    chatChannels,
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
    runs: () => runs.list(),
    saveRun: (input) => runs.save(input),
    updateRun: (id, patch) => runs.update(id, patch),
    removeRun: (id) => runs.remove(id),
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
  // Bound failed online authentication attempts. Valid credentials are checked
  // first so shared proxies/loopback cannot be locked out by another caller.
  const authFailures = new Map<string, { count: number; windowResetAt: number; lockedUntil: number }>()
  const AUTH_FAILURE_LIMIT = 10
  const AUTH_FAILURE_WINDOW_MS = 60_000
  const AUTH_LOCKOUT_MS = 300_000
  const authLockedOut = (address: string): boolean => {
    const entry = authFailures.get(address)
    return entry !== undefined && entry.lockedUntil > now()
  }
  const recordAuthFailure = (address: string): void => {
    const at = now()
    let entry = authFailures.get(address)
    if (entry === undefined || entry.windowResetAt <= at) {
      if (authFailures.size >= 1000) {
        const oldest = authFailures.keys().next().value
        if (oldest !== undefined) authFailures.delete(oldest)
      }
      entry = { count: 0, windowResetAt: at + AUTH_FAILURE_WINDOW_MS, lockedUntil: 0 }
      authFailures.set(address, entry)
    }
    entry.count += 1
    if (entry.count >= AUTH_FAILURE_LIMIT) entry.lockedUntil = at + AUTH_LOCKOUT_MS
  }
  const claimAttempts = new Map<string, { count: number; resetAt: number }>()
  const CLAIM_ATTEMPT_LIMIT = 10
  const CLAIM_ATTEMPT_WINDOW_MS = 60_000
  // Per-IP limits alone fall to rotation; a global ceiling keeps a distributed
  // pairing-code grind from getting unlimited aggregate guesses.
  let claimGlobalCount = 0
  let claimGlobalResetAt = 0
  const CLAIM_GLOBAL_LIMIT = 50
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

  // Pre-auth traffic has a bounded durable-write budget. Rejected floods must
  // not turn the journal into an unauthenticated disk/event-loop exhaustion
  // primitive. Authorized operations still require durable admission records.
  let rejectionWrites = 0
  let rejectionResetAt = 0
  const logRejected = (request: IncomingMessage, status: number, type = "request.rejected"): void => {
    const at = now()
    if (rejectionResetAt <= at) {
      rejectionWrites = 0
      rejectionResetAt = at + 60_000
    }
    if (rejectionWrites >= 40 || auditFailed) return
    rejectionWrites += 1
    try {
      audit.append({ type, at, serverId, method: request.method,
        status, address: request.socket.remoteAddress,
      })
    } catch {
      auditFailed = true
    }
  }

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const route = new URL(request.url ?? "/", "http://127.0.0.1").pathname
      if (auditFailed) {
        json(response, 503, { ok: false, error: "Security audit storage is unavailable." })
        return
      }
      // The enterprise control plane owns its own credentials, audit trail and
      // static console. It is matched before the bearer gate because a console
      // session is a cookie, not the server token, and a login page must be
      // reachable before anyone is signed in.
      if (
        enterprise !== undefined &&
        (route === "/admin" ||
          route.startsWith("/admin/") ||
          route === `${OMNIA_API_PREFIX}/enterprise` ||
          route.startsWith(`${OMNIA_API_PREFIX}/enterprise/`))
      ) {
        await enterprise.handle(request, response)
        return
      }
      // Browsers preflight without credentials. Only explicit origins may
      // preflight; the subsequent real request still takes the bearer path.
      const origin = request.headers.origin
      response.setHeader("vary", "Origin")
      if (origin !== undefined) {
        if (!corsOrigins.has(origin)) {
          logRejected(request, 403)
          json(response, 403, { ok: false, error: "Origin is not allowed." })
          return
        }
        response.setHeader("access-control-allow-origin", origin)
        if (enterprise !== undefined) response.setHeader("access-control-allow-credentials", "true")
        if (request.method === "OPTIONS") {
          response.setHeader("access-control-allow-headers", "authorization, content-type, x-omnia-origin, x-omnia-session, x-omnia-session-proof, x-omnia-key-id, x-omnia-timestamp, x-omnia-signature")
          response.setHeader("access-control-allow-methods", "GET, POST, PATCH, DELETE, OPTIONS")
          response.writeHead(204)
          response.end()
          return
        }
      }
      const address = request.socket.remoteAddress ?? "unknown"
      let authenticated = isAuthorized(
        request,
        token,
        (a, b) => timingSafeEqual(a, b),
        auth,
        (presented) => enterprise?.isClientToken(presented) === true,
      )
      const authorization = ((): "ok" | "unauthorized" | "bad_request" => {
        if (authenticated) return "ok"
        const url = new URL(request.url ?? "/", "http://127.0.0.1")
        if (isPublicApiRoute(request.method ?? "", url.pathname)) return "ok"
        if (request.method === "POST" && url.pathname === `${OMNIA_API_PREFIX}/computers/pair/claim`) {
          const at = now()
          if (claimGlobalResetAt <= at) {
            claimGlobalCount = 0
            claimGlobalResetAt = at + CLAIM_ATTEMPT_WINDOW_MS
          }
          claimGlobalCount += 1
          if (claimGlobalCount > CLAIM_GLOBAL_LIMIT) return "unauthorized"
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
          authenticated = remote.authorize(computerId, bearer)
          return authenticated ? "ok" : "unauthorized"
        }
        return "unauthorized"
      })()
      if (authorization === "bad_request") {
        logRejected(request, 400)
        json(response, 400, { ok: false, error: "The computer id in the request path is not valid percent-encoding." })
        return
      }
      if (authorization !== "ok") {
        if (authLockedOut(address)) {
          logRejected(request, 429)
          response.setHeader("retry-after", String(Math.ceil((authFailures.get(address)!.lockedUntil - now()) / 1000)))
          json(response, 429, { ok: false, error: "Too many failed attempts; try again shortly." })
          return
        }
        const url = new URL(request.url ?? "/", "http://127.0.0.1")
        const rateLimited =
          request.method === "POST" && url.pathname === `${OMNIA_API_PREFIX}/computers/pair/claim`
        if (!rateLimited) recordAuthFailure(address)
        logRejected(request, rateLimited ? 429 : 401)
        json(response, rateLimited ? 429 : 401, {
          ok: false,
          error: rateLimited ? "Too many pairing attempts; try again shortly." : "Unauthorized.",
        })
        return
      }
      if (!authenticated) {
        // Anonymous status requests must not consume an admission quota shared
        // with independently authenticated callbacks/webhooks. Budget only the
        // generic pre-auth log writes; verified mutations log after validation.
        response.once("finish", () => logRejected(request, response.statusCode, "request.public.completed"))
      } else {
        // Limit caller-controlled pathname size; query strings never enter logs.
        const bearer = request.headers.authorization?.replace(/^Bearer /, "")
        const profile = bearer === undefined ? undefined : auth.clientTokenProfile(bearer)
        const actor =
          profile !== undefined
            ? `${profile.provider ?? "github"}:${profile.id}`
            : bearer === token
              ? "deployment-operator"
              : "remote-runtime"
        const admission = { at: now(), serverId, method: request.method, route: route.slice(0, 256), address, actor }
        try {
          audit.append({ ...admission, type: "request.received" })
        } catch {
          auditFailed = true
          json(response, 503, { ok: false, error: "Security audit storage is unavailable." })
          return
        }
        response.once("finish", () => {
          try {
            audit.append({ ...admission, at: now(), type: "request.completed", status: response.statusCode })
          } catch {
            auditFailed = true
          }
        })
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
        console.error("omnia server request failed", redactError(error instanceof Error ? error : new Error(String(error))))
        json(response, 500, { ok: false, error: "Omnia Server request failed." })
        return true
      })
      if (!handled && !response.headersSent) {
        json(response, 404, { ok: false, error: "Unknown route." })
      }
    })().catch((error: unknown) => {
      console.error("omnia server request failed", redactError(error instanceof Error ? error : new Error(String(error))))
      json(response, 500, { ok: false, error: "Omnia Server request failed." })
    })
  })

  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => {
      unsubscribeAudit()
      audit.close()
      computerUseAudit.close()
      reject(error)
    }
    server.once("error", failed)
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => {
      server.off("error", failed)
      resolve()
    })
  })
  const address = server.address() as AddressInfo
  const url = `http://127.0.0.1:${address.port}`
  // Hosted deployments gate pairing centrally and never advertise on the LAN;
  // loopback-only embedded servers must not broadcast either.
  const pairingDiscovery =
    options.discovery !== true
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
    chatChannels,
    computerUse: computerUseService,
    auth,
    ...(enterprise === undefined ? {} : { enterprise }),
    register: (driver) => registerComputer(driver),
    setCatalog: (next) => {
      catalog = { ...catalog, ...next }
    },
    health,
    stop: async () => {
      state = "stopping"
      await localModels.unload()
      scheduler?.stop()
      superskillBridges.close()
      chatChannels.stop()
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
      unsubscribeAudit()
      audit.close()
      computerUseAudit.close()
    },
  }
}
