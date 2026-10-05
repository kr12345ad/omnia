import type { CommandRequest, ComputerAction, ElementReference, FindRequest, ObservationRequest } from "../protocol"
import type { PlanId } from "../billing/plans"
import type { HostDriver } from "../daemon/host-driver"
import type { RemoteCommand, RemoteResultMessage } from "../server/remote"
import { REMOTE_SESSION_LIMIT_CODE, remoteSessionLimit, type RemoteSessionLimit } from "./entitlement"
import { loadOrCreateRemoteKeyPair, type RemoteKeyPair, type RemoteKeyStorage } from "./keys"
import { remoteAuthHeaders } from "./signing"

/**
 * How the last session ended.
 *
 * `resumable` is the distinction that matters to the host: a session-limit end
 * leaves the pairing and its token intact, so starting the agent again continues
 * the same computer with a fresh window.
 */
export interface RemoteSessionEnd {
  readonly code: string
  readonly reason: string
  readonly minutes: number
  readonly resumable: boolean
}

export interface RemoteBrowserCommand {
  readonly operation: string
  readonly params?: unknown
}

export type RemoteBrowserHandler = (command: RemoteBrowserCommand) => Promise<unknown>

export interface RemoteAgentOptions {
  readonly serverUrl: string
  readonly computerId: string
  readonly token: string
  readonly driver: HostDriver
  readonly browser?: RemoteBrowserHandler
  readonly fetch?: typeof fetch
  readonly waitMs?: number
  readonly log?: (message: string) => void
  readonly keys?: RemoteKeyPair
  readonly keyStorage?: RemoteKeyStorage
  readonly now?: () => number
  /**
   * The plan the computer's owner is on, which sets this session's ceiling
   * (`remote_computer` is included on every plan; only its sessionMinutes
   * differs). Omit it when the plan could not be confirmed and the free ceiling
   * applies - a bounded session that resumes, rather than an unbounded one.
   */
  readonly plan?: PlanId
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === "string" && code.length > 0 ? code : undefined
}

function unavailable(id: string, method: string): RemoteResultMessage {
  return { id, ok: false, error: `This computer cannot handle ${method}.` }
}

export class RemoteAgent {
  private stopped = false
  private readonly abort = new AbortController()
  private readonly serverUrl: string
  private readonly computerId: string
  private readonly token: string
  private readonly driver: HostDriver
  private readonly browser: RemoteBrowserHandler | undefined
  private readonly http: typeof fetch
  private readonly waitMs: number
  private readonly log: (message: string) => void
  private readonly keyPair: RemoteKeyPair | undefined
  private readonly keyStorage: RemoteKeyStorage | undefined
  private readonly now: () => number
  private readonly plan: PlanId | undefined
  private resolvedKeys: RemoteKeyPair | undefined
  private keyFailure: unknown
  private lastTimestampMs = 0
  private sessionStartedAt = 0
  private ended: RemoteSessionEnd | undefined

  constructor(options: RemoteAgentOptions) {
    this.serverUrl = options.serverUrl.replace(/\/+$/, "")
    this.computerId = options.computerId
    this.token = options.token
    this.driver = options.driver
    this.browser = options.browser
    this.http = options.fetch ?? fetch
    this.waitMs = options.waitMs ?? 25000
    this.log = options.log ?? (() => {})
    this.keyPair = options.keys
    this.keyStorage = options.keyStorage
    this.now = options.now ?? Date.now
    this.plan = options.plan
    this.sessionStartedAt = this.now()
  }

  start(): void {
    // A session-limit end is resumable, so it only closes the loop and leaves
    // the controller alone; start() then begins a fresh window. stop() aborts
    // the controller, so after that this agent is finished for good.
    if (this.abort.signal.aborted) return
    this.stopped = false
    this.ended = undefined
    this.sessionStartedAt = this.now()
    void this.loop()
  }

  // Aborting the controller tears down the long-poll in flight, so a command
  // cannot arrive, and then execute on this machine, after stop().
  stop(): void {
    this.stopped = true
    this.abort.abort()
  }

  get running(): boolean {
    return !this.stopped
  }

  /** Why the last session ended, and whether starting again resumes it. */
  get sessionEnd(): RemoteSessionEnd | undefined {
    return this.ended
  }

  private url(path: string): string {
    return `${this.serverUrl}/v1/computers/${encodeURIComponent(this.computerId)}/remote/${path}`
  }

  private async signingKeys(): Promise<RemoteKeyPair | undefined> {
    if (this.keyPair !== undefined) return this.keyPair
    if (this.keyStorage === undefined) return undefined
    if (this.keyFailure !== undefined) throw this.keyFailure
    try {
      this.resolvedKeys ??= await loadOrCreateRemoteKeyPair(this.keyStorage)
    } catch (error) {
      // A key file that cannot be read is permanent, and silently rotating it
      // would strand every paired server: latch the failure instead of retrying.
      this.keyFailure = error
      throw error
    }
    return this.resolvedKeys
  }

  private async headers(method: string, url: string, body?: string): Promise<Record<string, string>> {
    const keys = await this.signingKeys()
    if (keys === undefined) return { authorization: `Bearer ${this.token}` }
    return remoteAuthHeaders({
      token: this.token,
      computerId: this.computerId,
      method,
      url,
      baseUrl: this.serverUrl,
      // The server refuses a timestamp this computer already spent, so two
      // requests inside one millisecond must not repeat it: the signing clock
      // only ever moves forward.
      timestampMs: this.issueTimestamp(),
      keys: keys.privateKey,
      ...(body === undefined ? {} : { body }),
    })
  }

  private issueTimestamp(): number {
    const next = Math.max(this.now(), this.lastTimestampMs + 1)
    this.lastTimestampMs = next
    return next
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      const limit = this.sessionLimit()
      if (limit !== undefined) {
        this.endSession(limit.minutes, limit.reason)
        return
      }
      try {
        const commandUrl = `${this.url("commands")}?wait=${this.waitMs}`
        const response = await this.http(commandUrl, {
          method: "GET",
          headers: await this.headers("GET", commandUrl),
          signal: this.abort.signal,
        })
        if (response.status === 401 || response.status === 404) {
          this.log("The pairing was revoked or expired; stopping the remote agent.")
          this.stopped = true
          return
        }
        if (!response.ok) {
          await this.pause(2000)
          continue
        }
        const body = (await response.json()) as { command?: RemoteCommand | null }
        const command = body.command
        if (command === undefined || command === null) continue
        // A command delivered after stop() must not reach this machine.
        if (this.stopped) return
        await this.handle(command)
      } catch (error) {
        if (this.stopped) return
        this.log(`Remote agent connection error: ${errorMessage(error)}`)
        await this.pause(2000)
      }
    }
  }

  // Waiting between attempts must not outlive stop(), or a stopped agent keeps
  // its loop alive for the rest of the backoff.
  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (this.stopped) {
        resolve()
        return
      }
      const onAbort = () => {
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        this.abort.signal.removeEventListener("abort", onAbort)
        resolve()
      }, ms)
      this.abort.signal.addEventListener("abort", onAbort, { once: true })
    })
  }

  private async handle(command: RemoteCommand): Promise<void> {
    if (this.stopped) return
    // A command dequeued after the ceiling is answered with the reason and a
    // typed code rather than run or silently dropped: the server's pending call
    // settles immediately instead of waiting out its timeout, and the session
    // ends with the reason in the log instead of a socket that just went quiet.
    const limit = this.sessionLimit()
    if (limit !== undefined) {
      await this.report({ id: command.id, ok: false, error: limit.reason, code: REMOTE_SESSION_LIMIT_CODE }, command.method)
      this.endSession(limit.minutes, limit.reason)
      return
    }
    const message = await this.dispatch(command)
    // A command that finished after stop() is already running here; its result
    // is not reported, since the agent is no longer attached to the pairing.
    if (this.stopped) return
    await this.report(message, command.method)
  }

  private async report(message: RemoteResultMessage, method: string): Promise<void> {
    const resultsUrl = this.url("results")
    const body = JSON.stringify(message)
    await this.http(resultsUrl, {
      method: "POST",
      headers: {
        ...(await this.headers("POST", resultsUrl, body)),
        "content-type": "application/json",
      },
      body,
      signal: this.abort.signal,
    }).catch((error: unknown) => {
      if (this.stopped) return
      this.log(`Reporting the result for ${method} failed: ${errorMessage(error)}`)
    })
  }

  // undefined while the session is inside the plan's ceiling, or when the plan
  // does not bound sessions at all.
  private sessionLimit(): RemoteSessionLimit | undefined {
    return remoteSessionLimit({
      ...(this.plan === undefined ? {} : { plan: this.plan }),
      startedAt: this.sessionStartedAt,
      now: this.now(),
    })
  }

  // Ending a session at the ceiling is not stopping the agent: the pairing, its
  // token and its key all stay valid, so the host can start() again and the
  // operator resumes where they left off.
  private endSession(minutes: number, reason: string): void {
    this.stopped = true
    this.ended = { code: REMOTE_SESSION_LIMIT_CODE, reason, minutes, resumable: true }
    this.log(reason)
  }

  private async dispatch(command: RemoteCommand): Promise<RemoteResultMessage> {
    try {
      switch (command.method) {
        case "observe":
          return { id: command.id, ok: true, result: await this.driver.observe(command.params as ObservationRequest | undefined) }
        case "find":
          return { id: command.id, ok: true, result: await this.driver.find(command.params as FindRequest) }
        case "execute":
          return { id: command.id, ok: true, result: await this.driver.execute(command.params as ComputerAction) }
        case "browser": {
          if (this.browser === undefined) return unavailable(command.id, "browser control")
          const params = (command.params ?? {}) as { operation?: unknown; params?: unknown }
          if (typeof params.operation !== "string" || params.operation.length === 0) {
            return { id: command.id, ok: false, error: "The browser command needs an operation." }
          }
          return {
            id: command.id,
            ok: true,
            result: await this.browser({
              operation: params.operation,
              ...(params.params === undefined ? {} : { params: params.params }),
            }),
          }
        }
        case "runCommand": {
          if (this.driver.runCommand === undefined) return unavailable(command.id, "shell commands")
          return { id: command.id, ok: true, result: await this.driver.runCommand(command.params as CommandRequest) }
        }
        case "readText": {
          if (this.driver.readText === undefined) return unavailable(command.id, "reading text")
          return {
            id: command.id,
            ok: true,
            result: await this.driver.readText(command.params as { elementId?: string; application?: string; limit?: number }),
          }
        }
        case "readClipboard": {
          if (this.driver.readClipboard === undefined) return unavailable(command.id, "reading the clipboard")
          return { id: command.id, ok: true, result: await this.driver.readClipboard() }
        }
        case "writeClipboard": {
          if (this.driver.writeClipboard === undefined) return unavailable(command.id, "writing the clipboard")
          const params = (command.params ?? {}) as { text?: unknown }
          return {
            id: command.id,
            ok: true,
            result: await this.driver.writeClipboard(typeof params.text === "string" ? params.text : ""),
          }
        }
        case "pointerPosition": {
          if (this.driver.pointerPosition === undefined) return unavailable(command.id, "reading the pointer")
          return { id: command.id, ok: true, result: await this.driver.pointerPosition() }
        }
        case "hoverPointer": {
          if (this.driver.hoverPointer === undefined) return unavailable(command.id, "hovering the pointer")
          const params = (command.params ?? {}) as { x?: unknown; y?: unknown; holdMs?: unknown }
          return {
            id: command.id,
            ok: true,
            result: await this.driver.hoverPointer(
              typeof params.x === "number" ? params.x : 0,
              typeof params.y === "number" ? params.y : 0,
              typeof params.holdMs === "number" ? params.holdMs : undefined,
            ),
          }
        }
        case "mouseDown": {
          if (this.driver.mouseDown === undefined) return unavailable(command.id, "pressing mouse buttons")
          const params = (command.params ?? {}) as { button?: unknown }
          return {
            id: command.id,
            ok: true,
            result: await this.driver.mouseDown(typeof params.button === "number" ? params.button : undefined),
          }
        }
        case "mouseUp": {
          if (this.driver.mouseUp === undefined) return unavailable(command.id, "releasing mouse buttons")
          const params = (command.params ?? {}) as { button?: unknown }
          return {
            id: command.id,
            ok: true,
            result: await this.driver.mouseUp(typeof params.button === "number" ? params.button : undefined),
          }
        }
        case "releaseStuckKeys": {
          if (this.driver.releaseStuckKeys === undefined) return unavailable(command.id, "releasing keys")
          return { id: command.id, ok: true, result: await this.driver.releaseStuckKeys() }
        }
        case "revalidateTarget": {
          const params = (command.params ?? {}) as ElementReference
          return { id: command.id, ok: true, result: await this.driver.revalidateTarget(params) }
        }
        default:
          return { id: command.id, ok: false, error: `Unsupported remote method ${command.method}.` }
      }
    } catch (error) {
      const code = errorCode(error)
      return { id: command.id, ok: false, error: errorMessage(error), ...(code === undefined ? {} : { code }) }
    }
  }
}
