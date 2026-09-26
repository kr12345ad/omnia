// Minimal WebDriver BiDi client. Firefox exposes BiDi at ws://127.0.0.1:<port>/session
// once remote debugging is enabled; every command is a JSON message with an id.

export interface BidiResult {
  readonly type: "success" | "error"
  readonly id?: number
  readonly result?: unknown
  readonly error?: string
  readonly message?: string
}

export interface BidiClientOptions {
  readonly url: string
  readonly timeoutMs?: number
  readonly onClose?: () => void
}

export class BidiError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = "BidiError"
    this.code = code
  }
}

export class BidiClient {
  private socket: WebSocket | undefined
  private sequence = 0
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  private closed = false

  constructor(private readonly options: BidiClientOptions) {}

  async connect(): Promise<void> {
    const socket = new WebSocket(this.options.url)
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true })
      socket.addEventListener("error", () => reject(new BidiError("connection_failed", "Could not connect to the browser.")), {
        once: true,
      })
    })
    socket.addEventListener("message", (event) => this.handleMessage(String(event.data)))
    socket.addEventListener("close", () => {
      this.closed = true
      for (const entry of this.pending.values()) {
        entry.reject(new BidiError("connection_closed", "The browser connection closed."))
      }
      this.pending.clear()
      this.options.onClose?.()
    })
    this.socket = socket
  }

  private handleMessage(raw: string): void {
    let parsed: BidiResult
    try {
      parsed = JSON.parse(raw) as BidiResult
    } catch {
      return
    }
    if (parsed.id === undefined) return
    const entry = this.pending.get(parsed.id)
    if (entry === undefined) return
    this.pending.delete(parsed.id)
    if (parsed.type === "success") {
      entry.resolve(parsed.result)
      return
    }
    entry.reject(new BidiError(parsed.error ?? "bidi_error", parsed.message ?? "The browser command failed."))
  }

  async send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.socket === undefined || this.closed) {
      throw new BidiError("not_connected", "The browser is not connected.")
    }
    const id = ++this.sequence
    const timeoutMs = this.options.timeoutMs ?? 30000
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new BidiError("timeout", `The browser did not answer ${method} in time.`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value as T)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      this.socket!.send(JSON.stringify({ id, method, params }))
    })
  }

  get connected(): boolean {
    return this.socket !== undefined && !this.closed
  }

  close(): void {
    this.closed = true
    try {
      this.socket?.close()
    } catch {
      // already closed
    }
    this.socket = undefined
  }
}
