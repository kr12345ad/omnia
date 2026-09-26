import type { ModelEvent as ProtocolModelEvent, Metadata } from "../protocol"
import { normalizeModelEvent } from "./events"

export type { ModelEvent as ProtocolModelEvent, ProtocolEvent } from "../protocol"
import type { JsonValue } from "./json"
import type { ModelEvent } from "./events"

export interface ProtocolModelEventOptions {
  readonly id: string
  readonly timestamp: number
  readonly runId?: string
  readonly requestId?: string
  readonly metadata?: Metadata
  readonly output?: JsonValue
}

const base = (options: ProtocolModelEventOptions) => ({
  id: options.id,
  timestamp: options.timestamp,
  ...(options.runId === undefined ? {} : { runId: options.runId }),
  ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
  ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
})

export function toProtocolModelEvent(
  event: ModelEvent,
  options: ProtocolModelEventOptions,
): ProtocolModelEvent | undefined {
  const common = base(options)
  if (event.type === "start") {
    return { ...common, type: "model.started", ...(event.model === undefined ? {} : { model: event.model }) }
  }
  if (event.type === "text-delta") {
    return { ...common, type: "model.message", role: "assistant", content: { type: "text", text: event.text } }
  }
  if (event.type === "reasoning-delta") {
    return { ...common, type: "model.message", role: "assistant", content: { type: "reasoning", text: event.text } }
  }
  if (event.type === "tool-call") {
    return { ...common, type: "model.tool-call", callId: event.callId, name: event.name, input: event.input }
  }
  if (event.type === "finish") {
    const output = options.output ?? event.output
    return { ...common, type: "model.completed", ...(output === undefined ? {} : { output }) }
  }
  if (event.type === "error") {
    return {
      ...common,
      type: "model.failed",
      error: {
        message: event.error.message,
        ...(event.error.code === undefined ? {} : { code: event.error.code }),
        ...(event.error.retryable === undefined ? {} : { retryable: event.error.retryable }),
        ...(event.error.details === undefined ? {} : { details: event.error.details }),
      },
    }
  }
  if (event.type === "cancelled") {
    return { ...common, type: "model.cancelled", ...(event.reason === undefined ? {} : { reason: event.reason }) }
  }
  return undefined
}

export const modelEventToProtocol = toProtocolModelEvent

export const fromProtocolModelEvent = (event: ProtocolModelEvent) => normalizeModelEvent(event)
