import type { CommandRequest, ComputerAction, ElementReference, FindRequest, ObservationRequest } from "../protocol"
import type { HostDriver } from "../daemon/host-driver"
import type { RemoteCommand, RemoteResultMessage } from "../server/remote"
import { loadOrCreateRemoteKeyPair, type RemoteKeyPair, type RemoteKeyStorage } from "./keys"
import { remoteAuthHeaders } from "./signing"

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
  private resolvedKeys: RemoteKeyPair | undefined
  private keyFailure: unknown
  private lastTimestampMs = 0

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
  }

  start(): void {
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
    const message = await this.dispatch(command)
    // A command that finished after stop() is already running here; its result
    // is not reported, since the agent is no longer attached to the pairing.
    if (this.stopped) return
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
      this.log(`Reporting the result for ${command.method} failed: ${errorMessage(error)}`)
    })
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
