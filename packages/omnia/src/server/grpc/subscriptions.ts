import type { ServerDuplexStream } from "@grpc/grpc-js"
import { status as GrpcStatus } from "@grpc/grpc-js"
import type { EventBus, ServerEvent } from "../events"
import { authorizePath, type GrpcPrincipal } from "./auth"
import {
  formatModelPath,
  isKnownPath,
  isPathPrefix,
  modelPathString,
  parseModelPath,
  parseModelPathString,
  pathKind,
  pathsOverlap,
  type ModelPath,
} from "./paths"
import { resolvePath, type GnmiAccess, type GnmiDataType, type GnmiStateSource } from "./state"
import type {
  ProtoNotification,
  ProtoSubscribeRequest,
  ProtoSubscribeResponse,
  ProtoSubscription,
  ProtoSubscriptionList,
  ProtoTypedValue,
} from "./types"

type Call = ServerDuplexStream<ProtoSubscribeRequest, ProtoSubscribeResponse>

interface SubscribedPath {
  readonly path: ModelPath
  readonly mode: "ON_CHANGE" | "SAMPLE"
  readonly sampleIntervalNs: number
  readonly heartbeatIntervalNs: number
  readonly suppressRedundant: boolean
}

interface SubscriptionOptions {
  readonly events: EventBus
  readonly source: GnmiStateSource
  readonly now: () => number
  readonly authorized: (principal: GrpcPrincipal) => boolean
  readonly chatCapability: (principal: GrpcPrincipal) => Promise<{ readonly status: number } | undefined>
}

const MIN_SAMPLE_NS = 100_000_000
const MAX_SAMPLE_NS = 3_600_000_000_000
const MAX_PENDING_PATHS = 512
const MAX_SUBSCRIPTIONS = 512
const MAX_BUFFERED_EVENTS = 1024
const SUPPORTED_MODEL = "omnia"

export class SubscriptionManager {
  private readonly sessions = new Set<SubscriptionSession>()

  constructor(private readonly options: SubscriptionOptions) {}

  get size(): number {
    return this.sessions.size
  }

  open(call: Call, principal: GrpcPrincipal, access: GnmiAccess): void {
    const session = new SubscriptionSession(call, principal, access, this.options, () => {
      this.sessions.delete(session)
    })
    this.sessions.add(session)
    session.start()
  }

  async closeAll(): Promise<void> {
    for (const session of [...this.sessions]) session.close(GrpcStatus.UNAVAILABLE, "Omnia is shutting down.")
    this.sessions.clear()
  }
}

class SubscriptionSession {
  private readonly call: Call
  private readonly principal: GrpcPrincipal
  private readonly access: GnmiAccess
  private readonly events: EventBus
  private readonly source: GnmiStateSource
  private readonly now: () => number
  private readonly authorized: (principal: GrpcPrincipal) => boolean
  private readonly chatCapabilityCheck: (principal: GrpcPrincipal) => Promise<{ readonly status: number } | undefined>
  private readonly onClosed: () => void
  private readonly dirty = new Set<string>()
  private readonly force = new Set<string>()
  private readonly lastSent = new Map<string, string>()
  private readonly lastSentAt = new Map<string, number>()
  private readonly timers: ReturnType<typeof setInterval>[] = []
  private unsubscribe: (() => void) | undefined
  private paths: SubscribedPath[] = []
  private readAccess: GnmiAccess
  private prefix: ModelPath | undefined
  private mode: "STREAM" | "ONCE" | "POLL" = "STREAM"
  private updatesOnly = false
  private closed = false
  private flushing = false
  private saturated = false
  private queue = Promise.resolve()

  constructor(
    call: Call,
    principal: GrpcPrincipal,
    access: GnmiAccess,
    options: SubscriptionOptions,
    onClosed: () => void,
  ) {
    this.call = call
    this.principal = principal
    this.access = access
    this.events = options.events
    this.source = options.source
    this.now = options.now
    this.authorized = options.authorized
    this.chatCapabilityCheck = options.chatCapability
    this.readAccess = access
    this.onClosed = onClosed
  }

  start(): void {
    this.call.on("data", (request: ProtoSubscribeRequest) => {
      this.queue = this.queue.then(() => this.handle(request)).catch((error: unknown) => {
        this.fail(GrpcStatus.INVALID_ARGUMENT, error instanceof Error ? error.message : "Invalid subscription request.")
      })
    })
    this.call.on("end", () => {
      // A client half-closing a POLL/ONCE stream has nothing else to ask for.
      // STREAM stays open because the target still owns the update direction.
      if (this.mode !== "STREAM") this.cleanup()
    })
    this.call.on("cancelled", () => this.cleanup())
    this.call.on("close", () => this.cleanup())
    this.call.on("error", () => this.cleanup())
    this.call.on("drain", () => {
      this.saturated = false
      void this.flush()
    })
  }

  close(code: GrpcStatus, message: string): void {
    if (this.closed) return
    this.sendError(code, message)
    this.cleanup()
  }

  private async handle(request: ProtoSubscribeRequest): Promise<void> {
    if (this.closed) return
    if (!this.authorized(this.principal)) {
      this.fail(GrpcStatus.UNAUTHENTICATED, "The credential was revoked.")
      return
    }
    if (request.poll !== undefined) {
      if (this.mode !== "POLL") {
        this.fail(GrpcStatus.INVALID_ARGUMENT, "A poll request is only valid for a POLL subscription.")
        return
      }
      await this.sendSnapshot(false)
      return
    }
    if (request.subscribe === undefined) {
      this.fail(GrpcStatus.INVALID_ARGUMENT, "The first SubscribeRequest must contain a subscription list.")
      return
    }
    await this.startList(request.subscribe)
  }

  private async startList(list: ProtoSubscriptionList): Promise<void> {
    // Omnia advertises JSON_IETF. Treat an omitted encoding as the server's
    // advertised default so a standard client that relies on the capability
    // response is not rejected for leaving the field at its proto default.
    const encoding = list.encoding ?? "JSON_IETF"
    if (encoding !== "JSON_IETF") {
      this.fail(GrpcStatus.INVALID_ARGUMENT, `Unsupported gNMI encoding ${encoding}. Omnia advertises JSON_IETF.`)
      return
    }
    if (list.allow_aggregation === true) {
      this.fail(GrpcStatus.UNIMPLEMENTED, "Subscription aggregation is not modeled by Omnia.")
      return
    }
    if (!this.modelsSupported(list.use_models)) {
      this.fail(GrpcStatus.INVALID_ARGUMENT, `Unsupported model in use_models. Omnia publishes ${SUPPORTED_MODEL}.`)
      return
    }
    const requested = list.subscription ?? []
    if (requested.length === 0) {
      this.fail(GrpcStatus.INVALID_ARGUMENT, "At least one subscription path is required.")
      return
    }
    if (requested.length > MAX_SUBSCRIPTIONS) {
      this.fail(GrpcStatus.RESOURCE_EXHAUSTED, "The subscription list exceeded its bound.")
      return
    }
    const mode = list.mode ?? "STREAM"
    if (mode !== "STREAM" && mode !== "ONCE" && mode !== "POLL") {
      this.fail(GrpcStatus.INVALID_ARGUMENT, `Unsupported subscription mode ${mode}.`)
      return
    }
    const prefix = list.prefix === undefined ? undefined : parseModelPath(undefined, list.prefix)
    const paths: SubscribedPath[] = []
    for (const subscription of requested) {
      const parsed = this.readSubscription(subscription, prefix, mode)
      if (parsed === undefined) return
      paths.push(parsed)
    }

    // Chat channels are paid. A concrete chat subscription is refused before
    // any snapshot is written; a root subscription hides the chat subtree so
    // the other readable leaves still synchronize.
    const chat = await this.chatCapability(paths.map((path) => path.path))
    if (chat !== undefined && paths.some((path) => pathKind(path.path) === "chat")) {
      if (chat.status === 402) {
        this.fail(GrpcStatus.PERMISSION_DENIED, "The chat_channels capability is not enabled for this account.")
      } else {
        this.fail(
          GrpcStatus.UNAVAILABLE,
          "The chat_channels entitlement could not be confirmed, so chat state was not served.",
        )
      }
      return
    }
    this.readAccess = chat === undefined ? this.access : { ...this.access, chat: false }

    this.stopTimers()
    this.unsubscribe?.()
    this.paths = paths
    this.prefix = prefix
    this.mode = mode
    this.updatesOnly = list.updates_only === true
    this.dirty.clear()
    this.force.clear()
    this.lastSent.clear()
    for (const path of paths) this.dirty.add(modelPathString(path.path))

    // Only STREAM needs live updates. POLL answers a fresh snapshot per poll
    // request, and ONCE ends after its snapshot, so both would otherwise
    // accumulate dirty paths that no flush ever consumes.
    const buffered: ServerEvent[] = []
    let snapshotting = mode === "STREAM"
    let bufferedOverflow = false
    if (snapshotting) {
      this.unsubscribe = this.events.subscribe((event) => {
        if (!snapshotting) {
          this.observe(event)
          return
        }
        if (buffered.length >= MAX_BUFFERED_EVENTS) {
          bufferedOverflow = true
          return
        }
        buffered.push(event)
      })
    }

    await this.sendSnapshot(this.updatesOnly)
    snapshotting = false
    if (this.closed) return
    if (bufferedOverflow) {
      this.fail(GrpcStatus.RESOURCE_EXHAUSTED, "The subscription backlog exceeded its bound.")
      return
    }
    // The snapshot already delivered these paths. Only events that arrived
    // while it was being assembled should wake a post-snapshot update.
    this.dirty.clear()
    for (const event of buffered) this.observe(event)

    if (mode === "ONCE") {
      this.call.end()
      this.cleanup()
      return
    }
    if (mode === "STREAM") this.startTimers(paths)
  }

  private readSubscription(
    subscription: ProtoSubscription,
    prefix: ModelPath | undefined,
    listMode: string,
  ): SubscribedPath | undefined {
    if (subscription.path === undefined) {
      this.fail(GrpcStatus.INVALID_ARGUMENT, "Every subscription needs a path.")
      return undefined
    }
    let path: ModelPath
    try {
      path = parseModelPath(prefix === undefined ? undefined : formatModelPath(prefix), subscription.path)
    } catch (error) {
      this.fail(GrpcStatus.INVALID_ARGUMENT, error instanceof Error ? error.message : "Invalid subscription path.")
      return undefined
    }
    if (!isKnownPath(path)) {
      this.fail(GrpcStatus.INVALID_ARGUMENT, `Unknown Omnia model path ${modelPathString(path)}.`)
      return undefined
    }
    if (!authorizePath(path, this.access, this.source)) {
      this.fail(GrpcStatus.PERMISSION_DENIED, `Not authorized to subscribe to ${modelPathString(path)}.`)
      return undefined
    }
    if (listMode !== "STREAM") {
      return {
        path,
        mode: "ON_CHANGE",
        sampleIntervalNs: 0,
        heartbeatIntervalNs: 0,
        suppressRedundant: false,
      }
    }
    const mode = subscription.mode ?? "TARGET_DEFINED"
    if (mode !== "TARGET_DEFINED" && mode !== "ON_CHANGE" && mode !== "SAMPLE") {
      this.fail(GrpcStatus.INVALID_ARGUMENT, `Unsupported subscription mode ${mode}.`)
      return undefined
    }
    const sampleIntervalNs = Number(subscription.sample_interval ?? 0)
    const heartbeatIntervalNs = Number(subscription.heartbeat_interval ?? 0)
    if (!Number.isFinite(sampleIntervalNs) || sampleIntervalNs < 0 || !Number.isFinite(heartbeatIntervalNs) || heartbeatIntervalNs < 0) {
      this.fail(GrpcStatus.INVALID_ARGUMENT, "Sample and heartbeat intervals must be non-negative nanoseconds.")
      return undefined
    }
    if (mode === "SAMPLE" && sampleIntervalNs === 0) {
      this.fail(GrpcStatus.INVALID_ARGUMENT, "SAMPLE subscriptions require a non-zero sample_interval.")
      return undefined
    }
    if (mode === "SAMPLE" && (sampleIntervalNs < MIN_SAMPLE_NS || sampleIntervalNs > MAX_SAMPLE_NS)) {
      this.fail(GrpcStatus.INVALID_ARGUMENT, "The requested sample interval is outside Omnia's supported range.")
      return undefined
    }
    if (heartbeatIntervalNs > 0 && (heartbeatIntervalNs < MIN_SAMPLE_NS || heartbeatIntervalNs > MAX_SAMPLE_NS)) {
      this.fail(GrpcStatus.INVALID_ARGUMENT, "The requested heartbeat interval is outside Omnia's supported range.")
      return undefined
    }
    return {
      path,
      mode: mode === "SAMPLE" ? "SAMPLE" : "ON_CHANGE",
      sampleIntervalNs,
      heartbeatIntervalNs,
      suppressRedundant: subscription.suppress_redundant === true,
    }
  }

  private modelsSupported(models: readonly unknown[] | undefined): boolean {
    if (models === undefined || models.length === 0) return true
    return models.every((model) => {
      if (typeof model !== "object" || model === null) return false
      const name = (model as { name?: unknown }).name
      return name === undefined || name === SUPPORTED_MODEL
    })
  }

  private startTimers(paths: readonly SubscribedPath[]): void {
    if (this.closed) return
    for (const path of paths) {
      if (path.mode === "SAMPLE") {
        this.timers.push(
          setInterval(() => {
            this.dirty.add(modelPathString(path.path))
            void this.flush()
          }, Math.max(MIN_SAMPLE_NS, path.sampleIntervalNs) / 1_000_000),
        )
      }
      if (path.heartbeatIntervalNs > 0) {
        this.timers.push(
          setInterval(() => {
            const key = modelPathString(path.path)
            const sent = this.lastSentAt.get(key) ?? 0
            if (this.now() - sent >= path.heartbeatIntervalNs / 1_000_000) {
              // A heartbeat is an unconditional update, so it must bypass
              // suppress_redundant; otherwise a healthy but unchanged sample
              // subscription would never produce one.
              this.dirty.add(key)
              this.force.add(key)
              void this.flush()
            }
          }, Math.max(MIN_SAMPLE_NS, path.heartbeatIntervalNs) / 1_000_000),
        )
      }
    }
    for (const timer of this.timers) timer.unref?.()
  }

  private stopTimers(): void {
    for (const timer of this.timers.splice(0)) clearInterval(timer)
  }

  private observe(event: ServerEvent): void {
    if (this.closed || this.mode !== "STREAM") return
    for (const path of this.paths) {
      if (this.eventAffects(path.path, event)) this.dirty.add(modelPathString(path.path))
    }
    if (this.dirty.size > MAX_PENDING_PATHS) {
      this.fail(GrpcStatus.RESOURCE_EXHAUSTED, "The subscription backlog exceeded its bound.")
      return
    }
    void this.flush()
  }

  private eventAffects(path: ModelPath, event: ServerEvent): boolean {
    const server = parseModelPathString("/omnia/server")
    const computers = parseModelPathString("/omnia/computers")
    const sessions = parseModelPathString("/omnia/sessions")
    const chat = parseModelPathString("/omnia/chat")
    const permissions = parseModelPathString("/omnia/config/permissions")
    const execution = parseModelPathString("/omnia/server/execution")
    const type = event.type
    // Signing out revokes every client token. No path-specific projection is
    // needed: waking every path makes the next flush recheck authorization.
    if (type === "auth.signed_out") return true
    if (type === "computer_use.executed") {
      return pathsOverlap(path, execution) || isPathPrefix(computers, path) || isPathPrefix(sessions, path)
    }
    if (type.startsWith("server.")) return pathsOverlap(path, server)
    if (type.startsWith("computer.")) {
      if (!pathsOverlap(path, computers) && !isPathPrefix(sessions, path)) return false
      const computerId = event.computerId
      if (computerId === undefined || !isPathPrefix(computers, path)) return true
      // Build the list entry directly rather than interpolating an id into a
      // path string; ids may contain characters that would make it invalid.
      const concrete: ModelPath = {
        elements: [
          { name: "omnia", keys: {} },
          { name: "computers", keys: {} },
          { name: "computer", keys: { id: computerId } },
        ],
      }
      return pathsOverlap(path, concrete)
    }
    if (type === "session.attached" || type.startsWith("action.")) {
      return pathsOverlap(path, sessions) || isPathPrefix(computers, path)
    }
    if (type.startsWith("chat.")) return pathsOverlap(path, chat)
    if (type.startsWith("permission.")) return pathsOverlap(path, permissions)
    return false
  }

  private async sendSnapshot(updatesOnly: boolean): Promise<void> {
    if (!this.authorized(this.principal)) {
      this.fail(GrpcStatus.UNAUTHENTICATED, "The credential was revoked.")
      return
    }
    const notification: ProtoNotification = {
      timestamp: String(this.now() * 1_000_000),
      update: [],
    }
    const updates: NonNullable<ProtoNotification["update"]>[number][] = []
    for (const path of this.paths) {
      if (!this.authorized(this.principal)) {
        this.fail(GrpcStatus.UNAUTHENTICATED, "The credential was revoked.")
        return
      }
      if (!authorizePath(path.path, this.access, this.source)) {
        this.sendError(GrpcStatus.PERMISSION_DENIED, `Not authorized to read ${modelPathString(path.path)}.`)
        this.cleanup()
        return
      }
      // updates_only suppresses the initial values, so resolving them would
      // read state the client never receives and would seed lastSent with a
      // value that was never delivered to suppress_redundant later.
      if (updatesOnly) continue
      const value = await this.resolve(path.path, "ALL")
      if (this.closed) return
      if (!this.authorized(this.principal)) {
        this.fail(GrpcStatus.UNAUTHENTICATED, "The credential was revoked.")
        return
      }
      if (!authorizePath(path.path, this.access, this.source)) {
        this.sendError(GrpcStatus.PERMISSION_DENIED, `Not authorized to read ${modelPathString(path.path)}.`)
        this.cleanup()
        return
      }
      if (value === undefined) continue
      const key = modelPathString(path.path)
      const encoded = JSON.stringify(value)
      this.lastSent.set(key, encoded)
      this.lastSentAt.set(key, this.now())
      updates.push({
        path: formatModelPath(path.path),
        val: jsonValue(value),
      })
    }
    if (!updatesOnly && updates.length > 0) {
      // A false return means gRPC accepted the frame but its internal buffer is
      // above the high-water mark. The data is still queued, so the synchronization
      // marker must be sent as well; dropping it would strand a standard client.
      this.write({ update: { ...notification, update: updates } })
    }
    this.write({ sync_response: true })
  }

  private async flush(): Promise<void> {
    if (this.closed || this.flushing || this.saturated || this.mode !== "STREAM") return
    this.flushing = true
    try {
      while (!this.closed && !this.saturated && this.dirty.size > 0) {
        if (!this.authorized(this.principal)) {
          this.fail(GrpcStatus.UNAUTHENTICATED, "The credential was revoked.")
          return
        }
        const key = this.dirty.values().next().value
        if (key === undefined) return
        this.dirty.delete(key)
        const path = this.paths.find((entry) => modelPathString(entry.path) === key)?.path
        if (path === undefined) continue
        if (!authorizePath(path, this.access, this.source)) {
          this.sendError(GrpcStatus.PERMISSION_DENIED, `Not authorized to read ${modelPathString(path)}.`)
          this.cleanup()
          return
        }
        const value = await this.resolve(path, this.typeFor(path))
        if (this.closed) return
        if (!this.authorized(this.principal)) {
          this.fail(GrpcStatus.UNAUTHENTICATED, "The credential was revoked.")
          return
        }
        if (!authorizePath(path, this.access, this.source)) {
          this.sendError(GrpcStatus.PERMISSION_DENIED, `Not authorized to read ${modelPathString(path)}.`)
          this.cleanup()
          return
        }
        if (value === undefined) continue
        const encoded = JSON.stringify(value)
        const subscription = this.paths.find((entry) => modelPathString(entry.path) === key)
        const forced = this.force.delete(key)
        if (!forced && subscription?.suppressRedundant === true && this.lastSent.get(key) === encoded) continue
        this.lastSent.set(key, encoded)
        this.lastSentAt.set(key, this.now())
        if (
          !this.write({
            update: {
              timestamp: String(this.now() * 1_000_000),
              update: [{ path: formatModelPath(path), val: jsonValue(value) }],
            },
          })
        ) {
          return
        }
      }
    } catch (error) {
      // flush runs from EventBus and timer callbacks, so a rejected resolve must
      // be contained here rather than becoming an unhandled rejection.
      this.fail(GrpcStatus.INTERNAL, error instanceof Error ? error.message : "The subscription update failed.")
    } finally {
      this.flushing = false
    }
  }

  private typeFor(path: ModelPath): GnmiDataType {
    return path.elements[1]?.name === "config" ? "CONFIG" : "STATE"
  }

  private async chatCapability(paths: readonly ModelPath[]): Promise<{ readonly status: number } | undefined> {
    if (!this.access.chat) return undefined
    if (!paths.some((path) => pathKind(path) === "root" || pathKind(path) === "chat")) return undefined
    return this.chatCapabilityCheck(this.principal)
  }

  private async resolve(path: ModelPath, type: GnmiDataType): Promise<unknown | undefined> {
    return resolvePath(path, this.source, this.readAccess, type)
  }

  private write(response: ProtoSubscribeResponse): boolean {
    if (this.closed) return false
    try {
      const accepted = this.call.write(response)
      if (!accepted) this.saturated = true
      return accepted
    } catch {
      this.cleanup()
      return false
    }
  }

  private sendError(code: GrpcStatus, message: string): void {
    if (this.closed) return
    try {
      this.call.write({ error: { code, message } })
    } catch {
      // The call is already gone; cleanup below is all that remains.
    }
  }

  private fail(code: GrpcStatus, message: string): void {
    this.sendError(code, message)
    this.cleanup()
  }

  private cleanup(): void {
    if (this.closed) return
    this.closed = true
    this.stopTimers()
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.onClosed()
    try {
      this.call.end()
    } catch {
      // A cancelled call is already ended.
    }
  }
}

function jsonValue(value: unknown): ProtoTypedValue {
  return { json_ietf_val: Buffer.from(JSON.stringify(value)) }
}
