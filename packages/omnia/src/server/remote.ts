import { createPublicKey, randomBytes, randomUUID } from "node:crypto"
import type { JsonWebKey, KeyObject } from "node:crypto"
import { REMOTE_REPLAY_WINDOW_MS, verifyRemoteSignature } from "../remote/signing"
import type { RemoteSignatureProof } from "../remote/signing"
import type {
  ActionResult,
  CapabilitySupport,
  CommandRequest,
  CommandResult,
  ComputerAction,
  ComputerInfo,
  ElementReference,
  FindRequest,
  FindResult,
  Observation,
  ObservationRequest,
} from "../protocol"
import type { EventBus } from "./events"
import type {
  BrowserController,
  BrowserDialogSummary,
  BrowserElementSummary,
  BrowserImageSave,
  BrowserImageSummary,
  BrowserPageSummary,
  BrowserStatusSummary,
  BrowserTabSummary,
  Revalidation,
  ServerComputerDriver,
} from "./computers"

export const REMOTE_REAP_INTERVAL_MS = 15000

export interface RemoteCommand {
  readonly id: string
  readonly method: string
  readonly params?: unknown
}

export interface RemoteResultMessage {
  readonly id: string
  readonly ok: boolean
  readonly result?: unknown
  readonly error?: string
  readonly code?: string
}

interface PendingCall {
  readonly command: RemoteCommand
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

const MAX_QUEUED_COMMANDS = 64
// A computer long-polls once per command; only one poll can be parked at a
// time in normal operation, so a handful of extras already means a duplicated
// or malicious client. The cap bounds that parked set (and its timers) instead
// of letting long-polls grow without limit.
const MAX_POLL_WAITERS = 8

const REMOTE_TIMEOUTS: Record<string, number> = {
  observe: 60000,
  find: 60000,
  execute: 120000,
  runCommand: 300000,
  browser: 60000,
  default: 60000,
}

// The slowest command decides how long a computer may be silent. The window
// must outlive it: a command is still running while the agent is not polling,
// and a shorter window would dispose the driver mid-flight, 404 the result
// the agent is about to POST, and end its polling for good.
export const REMOTE_MAX_COMMAND_MS = Math.max(...Object.values(REMOTE_TIMEOUTS))
export const REMOTE_STALE_MS = REMOTE_MAX_COMMAND_MS * 2

// Refused once a computer exceeds MAX_POLL_WAITERS concurrent command polls.
// Carries the status the HTTP layer should answer with.
export class RemotePollLimitError extends Error {
  readonly status = 429

  constructor(message: string) {
    super(message)
    this.name = "RemotePollLimitError"
  }
}

export interface RemoteDriverInput {
  readonly id: string
  readonly name: string
  readonly platform: string
  readonly architecture?: string
  readonly info?: ComputerInfo
  readonly capabilities?: readonly CapabilitySupport[]
  readonly now?: () => number
  // Per-method timeout overrides, so an embedding host (or a test) can change
  // how long a command may run without touching the shipped table.
  readonly timeouts?: Readonly<Record<string, number>>
}

export class RemoteComputerDriver implements ServerComputerDriver {
  readonly id: string
  readonly backend = "remote"
  // Browser calls travel as one browser command carrying an operation name and
  // its params; the desktop agent dispatches them to the embedded runtime.
  // currentTab stays omitted because it is synchronous and the server already
  // treats an unknown active tab as undefined.
  readonly browser: BrowserController = {
    status: () => this.browserCall<BrowserStatusSummary>("status", {}),
    open: (url) => this.browserCall<BrowserTabSummary>("open", { url }),
    tabs: () => this.browserCall<BrowserTabSummary[]>("tabs", {}),
    activate: (tabId) => this.browserCall<void>("activate", { tabId }),
    closeTab: (tabId) => this.browserCall<void>("closeTab", { tabId }),
    navigate: (url, tabId, sessionId) => this.browserCall<BrowserTabSummary>("navigate", { url, tabId, sessionId }),
    read: (tabId, options) => this.browserCall<BrowserPageSummary>("read", { tabId, options }),
    find: (query, options) => this.browserCall<BrowserElementSummary[]>("find", { query, options }),
    images: (tabId, options) => this.browserCall<BrowserImageSummary[]>("images", { tabId, options }),
    saveImage: (target) => this.browserCall<BrowserImageSave>("saveImage", { target }),
    click: (target) => this.browserCall<Awaited<ReturnType<BrowserController["click"]>>>("click", { target }),
    type: (target) => this.browserCall<Awaited<ReturnType<BrowserController["type"]>>>("type", { target }),
    hover: (target) =>
      this.browserCall<Awaited<ReturnType<NonNullable<BrowserController["hover"]>>>>("hover", { target }),
    select: (target, value, text) =>
      this.browserCall<Awaited<ReturnType<NonNullable<BrowserController["select"]>>>>("select", { target, value, text }),
    drag: (from, to) => this.browserCall<Awaited<ReturnType<NonNullable<BrowserController["drag"]>>>>("drag", { from, to }),
    readValue: (target) =>
      this.browserCall<Awaited<ReturnType<NonNullable<BrowserController["readValue"]>>>>("readValue", { target }),
    key: (key, tabId, sessionId) => this.browserCall<void>("key", { key, tabId, sessionId }),
    back: (tabId, sessionId) => this.browserCall<void>("back", { tabId, sessionId }),
    forward: (tabId, sessionId) => this.browserCall<void>("forward", { tabId, sessionId }),
    reload: (tabId, sessionId) => this.browserCall<void>("reload", { tabId, sessionId }),
    pendingDialog: (tabId, sessionId) =>
      this.browserCall<BrowserDialogSummary | null>("pendingDialog", { tabId, sessionId }),
    handleDialog: (input) => this.browserCall<{ handled: boolean }>("handleDialog", input),
    downloads: () => this.browserCall<Awaited<ReturnType<NonNullable<BrowserController["downloads"]>>>>("downloads", {}),
    authRequired: () =>
      this.browserCall<Awaited<ReturnType<NonNullable<BrowserController["authRequired"]>>>>("authRequired", {}),
    answerAuth: (input) => this.browserCall<{ answered: boolean }>("answerAuth", input),
    upload: (files, tabId, sessionId) =>
      this.browserCall<{ files: string[] }>("upload", { files: [...files], tabId, sessionId }),
  }
  lastSeenAt: number
  private readonly name: string
  private readonly platform: string
  private readonly architecture: string | undefined
  private readonly info: ComputerInfo
  private readonly capabilityList: readonly CapabilitySupport[]
  private readonly now: () => number
  private readonly timeouts: Readonly<Record<string, number>>
  private readonly queue: RemoteCommand[] = []
  private readonly waiters: Array<(command: RemoteCommand | undefined) => void> = []
  private readonly pending = new Map<string, PendingCall>()
  // Command ids handed to the agent but not yet answered. A computer with one
  // of these in flight is alive even if its polls went quiet.
  private readonly inFlight = new Set<string>()

  constructor(input: RemoteDriverInput) {
    this.id = input.id
    this.name = input.name
    this.platform = input.platform
    this.architecture = input.architecture
    this.now = input.now ?? Date.now
    this.timeouts = { ...REMOTE_TIMEOUTS, ...input.timeouts }
    this.lastSeenAt = this.now()
    this.info = input.info ?? {
      id: input.id,
      name: input.name,
      platform: input.platform,
      ...(input.architecture === undefined ? {} : { architecture: input.architecture }),
      backend: "remote",
      connected: true,
    }
    this.capabilityList = input.capabilities ?? []
  }

  touch(): void {
    this.lastSeenAt = this.now()
  }

  get inFlightCount(): number {
    return this.inFlight.size
  }

  private call<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    const id = randomUUID()
    const command: RemoteCommand = { id, method, ...(params === undefined ? {} : { params }) }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        // A timed-out command is dead: it must leave the queue too, or a stale
        // click or clipboard write executes minutes later, out of order.
        this.dropQueued(id)
        this.inFlight.delete(id)
        this.pending.delete(id)
        reject(new Error(`The remote computer did not answer ${method} in time.`))
      }, timeoutMs ?? this.timeouts[method] ?? this.timeouts.default)
      timer.unref?.()
      this.pending.set(id, {
        command,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      })
      const waiter = this.waiters.shift()
      if (waiter !== undefined) {
        this.inFlight.add(id)
        waiter(command)
        return
      }
      if (this.queue.length >= MAX_QUEUED_COMMANDS) {
        // A remote that stopped polling must not grow the server's memory.
        this.pending.delete(id)
        clearTimeout(timer)
        reject(new Error("The remote computer has too many queued commands; it is not polling."))
        return
      }
      this.queue.push(command)
    })
  }

  private browserCall<T>(operation: string, params: unknown): Promise<T> {
    return this.call<T>("browser", { operation, params })
  }

  private dropQueued(id: string): void {
    const index = this.queue.findIndex((queued) => queued.id === id)
    if (index >= 0) this.queue.splice(index, 1)
  }

  // Commands whose call already settled (timed out, disconnected) are never
  // handed out: the remote would run them out of order long after the caller
  // gave up on them.
  private takeQueued(): RemoteCommand | undefined {
    for (;;) {
      const command = this.queue.shift()
      if (command === undefined) return undefined
      if (!this.pending.has(command.id)) continue
      this.inFlight.add(command.id)
      return command
    }
  }

  nextCommand(timeoutMs: number): Promise<RemoteCommand | undefined> {
    this.touch()
    const queued = this.takeQueued()
    if (queued !== undefined) return Promise.resolve(queued)
    if (this.waiters.length >= MAX_POLL_WAITERS) {
      return Promise.reject(
        new RemotePollLimitError(
          `This computer already has ${this.waiters.length} command polls waiting; retry after one returns.`,
        ),
      )
    }
    return new Promise((resolve) => {
      const waiter = (command: RemoteCommand | undefined) => {
        clearTimeout(timer)
        if (command !== undefined) this.inFlight.add(command.id)
        resolve(command)
      }
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter)
        if (index >= 0) this.waiters.splice(index, 1)
        resolve(undefined)
      }, timeoutMs)
      timer.unref?.()
      this.waiters.push(waiter)
    })
  }

  complete(message: RemoteResultMessage): boolean {
    const pending = this.pending.get(message.id)
    // Only an accepted result counts as a heartbeat. Touching first would let
    // any authenticated computer stay alive forever by posting junk ids, and
    // reaping would never fire.
    if (pending === undefined) return false
    this.touch()
    clearTimeout(pending.timer)
    this.pending.delete(message.id)
    this.inFlight.delete(message.id)
    if (message.ok) pending.resolve(message.result)
    else {
      // Typed runtime codes survive the remote boundary so the server can map
      // them through the browser error taxonomy instead of flattening every
      // remote failure into an untyped error.
      const error = new Error(message.error ?? "The remote computer reported an error.")
      if (message.code !== undefined) Object.assign(error, { code: message.code })
      pending.reject(error)
    }
    return true
  }

  getInfo(): Promise<ComputerInfo> {
    return Promise.resolve(this.info)
  }

  capabilities(): readonly CapabilitySupport[] {
    return this.capabilityList
  }

  async observe(request?: ObservationRequest): Promise<Observation> {
    return this.call<Observation>("observe", request)
  }

  async find(request: FindRequest): Promise<FindResult> {
    return this.call<FindResult>("find", request)
  }

  async execute(action: ComputerAction): Promise<ActionResult> {
    return this.call<ActionResult>("execute", action)
  }

  async runCommand(request: CommandRequest): Promise<ActionResult & { command?: CommandResult }> {
    return this.call<ActionResult & { command?: CommandResult }>("runCommand", request)
  }

  async readText(input: { elementId?: string; application?: string; limit?: number }): Promise<
    ActionResult & { text?: string; length?: number; hash?: string }
  > {
    return this.call("readText", input)
  }

  async readClipboard(): Promise<ActionResult & { text?: string; length?: number; hash?: string }> {
    return this.call("readClipboard")
  }

  async writeClipboard(text: string): Promise<ActionResult> {
    return this.call<ActionResult>("writeClipboard", { text })
  }

  async pointerPosition(): Promise<ActionResult & { x?: number; y?: number; held?: boolean }> {
    return this.call("pointerPosition")
  }

  async hoverPointer(x: number, y: number, holdMs?: number): Promise<ActionResult> {
    return this.call<ActionResult>("hoverPointer", { x, y, holdMs })
  }

  async mouseDown(button?: number): Promise<ActionResult> {
    return this.call<ActionResult>("mouseDown", { button })
  }

  async mouseUp(button?: number): Promise<ActionResult> {
    return this.call<ActionResult>("mouseUp", { button })
  }

  async releaseStuckKeys(): Promise<ActionResult> {
    return this.call<ActionResult>("releaseStuckKeys")
  }

  async revalidateTarget(reference: ElementReference): Promise<Revalidation> {
    return this.call<Revalidation>("revalidateTarget", reference)
  }

  dispose(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error("The remote computer was disconnected."))
    }
    this.pending.clear()
    this.inFlight.clear()
    this.queue.length = 0
    for (const waiter of this.waiters.splice(0)) waiter(undefined)
  }
}

export interface RemoteRegistryOptions {
  readonly events: EventBus
  readonly registerDriver: (driver: ServerComputerDriver) => () => void
  readonly now?: () => number
  readonly staleMs?: number
  readonly reapIntervalMs?: number
  readonly randomToken?: () => string
  readonly randomComputerId?: () => string
  readonly allowUnsigned?: boolean
}

export interface RemoteClaimInput {
  readonly name: string
  readonly platform: string
  readonly architecture?: string
  readonly info?: ComputerInfo
  readonly capabilities?: readonly CapabilitySupport[]
  readonly publicKey?: KeyObject
  // A thin client that re-registers on every launch reuses its computer id so
  // the deployment does not accumulate stale entries. Reuse requires the same
  // Ed25519 key (or no key on the existing entry).
  readonly reuseId?: string
}

export interface RemoteClaimResult {
  readonly computerId: string
  readonly token: string
  readonly driver: RemoteComputerDriver
}

interface RemoteEntry {
  readonly driver: RemoteComputerDriver
  readonly token: string
  readonly publicKey?: KeyObject
  readonly unregister: () => void
}

// A pairing runtime proves key possession with an Ed25519 signature. The claim
// may carry a JWK or a base64-encoded raw 32-byte public key; either form is
// normalized to the same KeyObject before it is stored with the pairing.
export function parseRemotePublicKey(value: unknown): KeyObject | undefined {
  if (typeof value === "string") return parseRawEd25519PublicKey(value)
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const jwk = value as JsonWebKey
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") return undefined
  try {
    return createPublicKey({ key: jwk, format: "jwk" })
  } catch {
    return undefined
  }
}

function parseRawEd25519PublicKey(value: string): KeyObject | undefined {
  const encoded = value.startsWith("base64:") ? value.slice("base64:".length) : value
  const raw = Buffer.from(encoded, "base64")
  if (raw.length !== 32) return undefined
  try {
    // Ed25519 SPKI DER is a fixed 12-byte prefix followed by the raw key.
    return createPublicKey({
      key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]),
      format: "der",
      type: "spki",
    })
  } catch {
    return undefined
  }
}

export class RemoteRegistry {
  private readonly entries = new Map<string, RemoteEntry>()
  private readonly events: EventBus
  private readonly registerDriver: RemoteRegistryOptions["registerDriver"]
  private readonly now: () => number
  private readonly staleMs: number
  private readonly randomToken: () => string
  private readonly randomComputerId: () => string
  private readonly allowUnsigned: boolean
  // Highest timestamp already accepted per computer. The replay window alone
  // still allows a captured request to be resent for its whole lifetime.
  private readonly lastAcceptedAt = new Map<string, number>()
  private readonly reaper: ReturnType<typeof setInterval>

  constructor(options: RemoteRegistryOptions) {
    this.events = options.events
    this.registerDriver = options.registerDriver
    this.now = options.now ?? Date.now
    this.staleMs = options.staleMs ?? REMOTE_STALE_MS
    this.randomToken = options.randomToken ?? (() => randomBytes(32).toString("hex"))
    this.randomComputerId = options.randomComputerId ?? (() => `remote-${randomBytes(4).toString("hex")}`)
    this.allowUnsigned = options.allowUnsigned ?? false
    this.reaper = setInterval(() => this.reap(), options.reapIntervalMs ?? REMOTE_REAP_INTERVAL_MS)
    this.reaper.unref?.()
  }

  claim(input: RemoteClaimInput): RemoteClaimResult {
    // A requested id is honored only inside the remote namespace, so a client
    // cannot shadow another computer. Reusing a keyed registration requires
    // that same key: accepting a missing key would let anyone holding a
    // pairing code take over a known computerId and downgrade it to unsigned.
    // An unkeyed entry (migration mode) stays replaceable.
    const requested =
      input.reuseId !== undefined && /^remote-[0-9a-f]{8}$/.test(input.reuseId) ? input.reuseId : undefined
    const existing = requested === undefined ? undefined : this.entries.get(requested)
    const keyOk =
      existing === undefined ||
      existing.publicKey === undefined ||
      (input.publicKey !== undefined && existing.publicKey.equals(input.publicKey))
    const canReuse = requested !== undefined && keyOk
    const computerId = canReuse ? requested : this.randomComputerId()
    if (canReuse && existing !== undefined) {
      existing.unregister()
      this.entries.delete(computerId)
    }
    const token = this.randomToken()
    const driver = new RemoteComputerDriver({
      id: computerId,
      name: input.name,
      platform: input.platform,
      ...(input.architecture === undefined ? {} : { architecture: input.architecture }),
      ...(input.info === undefined ? {} : { info: input.info }),
      ...(input.capabilities === undefined ? {} : { capabilities: input.capabilities }),
      now: this.now,
    })
    const unregister = this.registerDriver(driver)
    this.entries.set(computerId, {
      driver,
      token,
      unregister,
      ...(input.publicKey === undefined ? {} : { publicKey: input.publicKey }),
    })
    this.events.emit("computer.paired", {
      computerId,
      data: { name: input.name, platform: input.platform, backend: driver.backend },
    })
    return { computerId, token, driver }
  }

  tokenFor(id: string): string | undefined {
    return this.entries.get(id)?.token
  }

  // Request authentication is the Ed25519 signature over the canonical digest
  // plus a timestamp inside the replay window. A computer claimed without a
  // public key is only accepted when migration mode explicitly allows it.
  verifyRequest(id: string, proof: RemoteSignatureProof): boolean {
    const entry = this.entries.get(id)
    if (entry === undefined) return false
    if (entry.publicKey === undefined) return this.allowUnsigned
    if (!Number.isFinite(proof.timestampMs)) return false
    if (Math.abs(this.now() - proof.timestampMs) > REMOTE_REPLAY_WINDOW_MS) return false
    // Verified before the replay memory is read or written, so a forged
    // signature can neither replay nor push a computer's clock backwards.
    if (!verifyRemoteSignature(entry.publicKey, proof)) return false
    // Each computer must also move forward: a captured request replayed inside
    // the window carries a timestamp that was already spent.
    const last = this.lastAcceptedAt.get(id)
    if (last !== undefined && proof.timestampMs <= last) return false
    this.lastAcceptedAt.set(id, proof.timestampMs)
    return true
  }

  authorize(id: string, token: string | undefined): boolean {
    const expected = this.entries.get(id)?.token
    if (expected === undefined || token === undefined || token.length !== expected.length) return false
    let diff = 0
    for (let index = 0; index < expected.length; index += 1) {
      diff |= expected.charCodeAt(index) ^ token.charCodeAt(index)
    }
    return diff === 0
  }

  next(id: string, timeoutMs: number): Promise<RemoteCommand | undefined> {
    const entry = this.entries.get(id)
    if (entry === undefined) return Promise.resolve(undefined)
    return entry.driver.nextCommand(timeoutMs)
  }

  complete(id: string, message: RemoteResultMessage): boolean {
    const entry = this.entries.get(id)
    if (entry === undefined) return false
    return entry.driver.complete(message)
  }

  bye(id: string): boolean {
    const entry = this.entries.get(id)
    if (entry === undefined) return false
    this.entries.delete(id)
    this.lastAcceptedAt.delete(id)
    entry.unregister()
    return true
  }

  ids(): string[] {
    return [...this.entries.keys()]
  }

  close(): void {
    clearInterval(this.reaper)
    this.lastAcceptedAt.clear()
    for (const [id, entry] of [...this.entries]) {
      this.entries.delete(id)
      entry.unregister()
    }
  }

  // A computer is reaped only when it is both silent past the stale window and
  // idle. Reaping mid-command would dispose the driver, so the result POST 404s
  // and the agent stops polling forever.
  private reap(): void {
    const now = this.now()
    for (const [id, entry] of [...this.entries]) {
      if (entry.driver.inFlightCount > 0) continue
      if (now - entry.driver.lastSeenAt <= this.staleMs) continue
      this.entries.delete(id)
      this.lastAcceptedAt.delete(id)
      entry.unregister()
    }
  }
}
