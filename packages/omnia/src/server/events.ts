export const SERVER_EVENT_TYPES = [
  "server.starting",
  "server.ready",
  "server.degraded",
  "server.stopping",
  "server.stopped",
  "server.failed",
  "computer.connected",
  "computer.disconnected",
  "computer.capabilities",
  "computer.stopped",
  "chat.channel_connected",
  "chat.channel_disconnected",
  "chat.message_received",
  "chat.reply_sent",
  "computer.paired",
  "computer.pairing_created",
  "computer.pairing_claimed",
  "computer.pairing_cancelled",
  "observation.created",
  "action.requested",
  "action.started",
  "action.completed",
  "action.verified",
  "action.failed",
  "action.cancelled",
  "permission.requested",
  "permission.decided",
  "permission.changed",
  "input.frozen",
  "input.released",
  "credential.created",
  "credential.updated",
  "credential.removed",
  "credential.used",
  "session.attached",
  "environment.changed",
  "browser.action",
  "superskill.called",
  "memory.written",
  "memory.forgotten",
  "browser.launched",
  "browser.navigated",
  "computer_use.ready",
  "computer_use.model",
  "computer_use.runtime",
  "computer_use.routed",
  "computer_use.analyzed",
  "computer_use.executed",
  "computer_use.settings",
  "auth.signed_in",
  "auth.signed_out",
  "auth.device_failed",
  "auth.oauth_client_saved",
] as const

export type ServerEventType = (typeof SERVER_EVENT_TYPES)[number]

export const SERVER_EVENT_LIMIT = 512

export interface ServerEvent {
  readonly seq: number
  readonly type: ServerEventType
  readonly at: number
  readonly serverId: string
  readonly computerId?: string
  readonly sessionId?: string
  readonly data?: Readonly<Record<string, unknown>>
}

export type ServerEventListener = (event: ServerEvent) => void

export interface EventBusOptions {
  readonly serverId: string
  readonly now?: () => number
  readonly limit?: number
}

export class EventBus {
  private sequence = 0
  private readonly listeners = new Set<ServerEventListener>()
  private readonly history: ServerEvent[] = []
  private readonly now: () => number
  private readonly limit: number

  constructor(private readonly options: EventBusOptions) {
    this.now = options.now ?? Date.now
    this.limit = options.limit ?? SERVER_EVENT_LIMIT
  }

  emit(
    type: ServerEventType,
    payload: { computerId?: string; sessionId?: string; data?: Record<string, unknown> } = {},
  ): ServerEvent {
    this.sequence += 1
    const event: ServerEvent = {
      seq: this.sequence,
      type,
      at: this.now(),
      serverId: this.options.serverId,
      ...(payload.computerId === undefined ? {} : { computerId: payload.computerId }),
      ...(payload.sessionId === undefined ? {} : { sessionId: payload.sessionId }),
      ...(payload.data === undefined ? {} : { data: payload.data }),
    }
    this.history.push(event)
    if (this.history.length > this.limit) this.history.splice(0, this.history.length - this.limit)
    for (const listener of this.listeners) {
      // A misbehaving subscriber must not abort the other listeners or the
      // action that emitted the event.
      try {
        listener(event)
      } catch {
        this.listeners.delete(listener)
      }
    }
    return event
  }

  subscribe(listener: ServerEventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  since(seq: number): ServerEvent[] {
    return this.history.filter((event) => event.seq > seq)
  }

  get lastSeq(): number {
    return this.sequence
  }
}
