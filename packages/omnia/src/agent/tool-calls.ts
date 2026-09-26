import type { JsonValue } from "../protocol"
import type { ToolCall, ToolCallRequest, ToolCallStatus } from "./contracts"
import { deepFreeze, ImmutableEventEmitter, type EventListener } from "./events"

export type ToolEventType = "tool.started" | "tool.completed" | "tool.failed" | "tool.cancelled"

export interface ToolEvent {
  readonly type: ToolEventType
  readonly call: ToolCall
  readonly timestamp: number
}

export class ToolCallError extends Error {
  readonly code: "duplicate" | "not-active" | "busy" | "limit" | "invalid"

  constructor(code: ToolCallError["code"], message: string) {
    super(message)
    this.name = "ToolCallError"
    this.code = code
  }
}

export class ToolCallSequencer {
  private readonly emitter = new ImmutableEventEmitter<ToolEvent>()
  private readonly calls: ToolCall[] = []
  private active: ToolCall | undefined
  private sequence = 0

  constructor(
    private readonly options: {
      readonly maxCalls: number
      readonly now?: () => number
      readonly idFactory?: (sequence: number) => string
    },
  ) {
    if (!Number.isInteger(options.maxCalls) || options.maxCalls < 0) {
      throw new RangeError("maxCalls must be a non-negative integer")
    }
  }

  subscribe(listener: EventListener<ToolEvent>): () => void {
    return this.emitter.subscribe(listener)
  }

  start(request: ToolCallRequest): ToolCall {
    if (this.active) throw new ToolCallError("busy", "a tool call is already active")
    if (this.calls.length >= this.options.maxCalls) throw new ToolCallError("limit", "tool call limit reached")
    if (request.tool.trim().length === 0) throw new ToolCallError("invalid", "tool must not be empty")
    const id = request.id ?? this.options.idFactory?.(this.sequence + 1) ?? `tool_${this.sequence + 1}`
    if (id.trim().length === 0) throw new ToolCallError("invalid", "tool call ID must not be empty")
    if (this.calls.some((call) => call.id === id)) throw new ToolCallError("duplicate", "tool call ID already exists")
    this.sequence += 1
    const now = this.options.now?.() ?? Date.now()
    const call = deepFreeze({
      id,
      sequence: this.sequence,
      tool: request.tool,
      input: { ...request.input },
      status: "running" as const satisfies ToolCallStatus,
      startedAt: now,
    })
    this.calls.push(call)
    this.active = call
    this.emitter.emit({ type: "tool.started", call, timestamp: now })
    return call
  }

  complete(id: string, result?: JsonValue): ToolCall {
    return this.settle(id, "completed", result)
  }

  fail(id: string, error: unknown): ToolCall {
    return this.settle(id, "failed", undefined, error instanceof Error ? error.message : String(error))
  }

  cancel(id: string, reason = "cancelled"): ToolCall {
    const call = this.requireActive(id)
    const completedAt = this.options.now?.() ?? Date.now()
    const completed = deepFreeze({
      ...call,
      status: "cancelled" as const satisfies ToolCallStatus,
      completedAt,
      cancellationReason: reason,
    })
    this.replaceActive(completed)
    this.emitter.emit({ type: "tool.cancelled", call: completed, timestamp: completedAt })
    return completed
  }

  cancelActive(reason = "cancelled"): ToolCall | undefined {
    if (!this.active) return undefined
    return this.cancel(this.active.id, reason)
  }

  activeCall(): ToolCall | undefined {
    return this.active
  }

  history(): readonly ToolCall[] {
    return Object.freeze([...this.calls])
  }

  private settle(id: string, status: "completed" | "failed", result?: JsonValue, error?: string): ToolCall {
    const call = this.requireActive(id)
    const completedAt = this.options.now?.() ?? Date.now()
    const completed: ToolCall = deepFreeze({
      ...call,
      status,
      completedAt,
      ...(status === "completed" ? { result: deepFreeze(result) } : {}),
      ...(status === "failed" ? { error: error ?? "tool call failed" } : {}),
    })
    this.replaceActive(completed)
    this.emitter.emit({
      type: status === "completed" ? "tool.completed" : "tool.failed",
      call: completed,
      timestamp: completedAt,
    })
    return completed
  }

  private requireActive(id: string): ToolCall {
    if (!this.active || this.active.id !== id) throw new ToolCallError("not-active", "tool call is not active")
    return this.active
  }

  private replaceActive(call: ToolCall): void {
    const index = this.calls.findIndex((item) => item.id === call.id)
    if (index < 0) throw new ToolCallError("not-active", "tool call is not recorded")
    this.calls[index] = call
    this.active = undefined
  }
}
