import type { ProtocolEvent } from "../protocol"
import type { AgentEvent } from "./contracts"

export type EventListener<Event extends object> = (event: Event) => void
export type Unsubscribe = () => void

export class ImmutableEventEmitter<Event extends object> {
  private readonly listeners = new Set<EventListener<Event>>()
  private readonly events: Event[] = []

  subscribe(listener: EventListener<Event>): Unsubscribe {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  once(listener: EventListener<Event>): Unsubscribe {
    const unsubscribe = this.subscribe((event) => {
      unsubscribe()
      listener(event)
    })
    return unsubscribe
  }

  emit(event: Event): Event {
    const immutable = freezeClone(event) as Event
    this.events.push(immutable)
    for (const listener of this.listeners) listener(immutable)
    return immutable
  }

  history(): readonly Event[] {
    return Object.freeze([...this.events])
  }

  clear(): void {
    this.events.length = 0
  }
}

export function createIdFactory(prefix: string): () => string {
  let sequence = 0
  return () => `${prefix}_${++sequence}`
}

export function toProtocolEvent(event: AgentEvent): ProtocolEvent | undefined {
  const base = {
    id: event.id,
    timestamp: event.timestamp,
    runId: event.runID,
    metadata: { state: event.to ?? event.from ?? "idle" },
  }
  if (event.type === "agent.started") {
    const objective = event.data.objective
    return {
      ...base,
      type: "agent.started",
      ...(typeof objective === "string" ? { objective } : {}),
    }
  }
  if (event.type === "agent.completed") {
    const result = event.data.result
    return {
      ...base,
      type: "agent.completed",
      ...(typeof result === "string" || typeof result === "number" || typeof result === "boolean" || result === null
        ? { result }
        : {}),
    }
  }
  if (event.type === "agent.cancelled") {
    const reason = event.data.reason
    return {
      ...base,
      type: "agent.cancelled",
      ...(typeof reason === "string" ? { reason } : {}),
    }
  }
  if (event.type === "agent.error") {
    const error = event.data.error
    const message = errorMessage(error)
    return {
      ...base,
      type: "agent.failed",
      error: { message },
    }
  }
  return undefined
}

export function freezeClone<Value>(value: Value): Value {
  return deepFreeze(cloneValue(value, new WeakMap<object, unknown>()) as Value)
}

function cloneValue(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (value === null || typeof value !== "object") return value
  const object = value as object
  const existing = seen.get(object)
  if (existing !== undefined) return existing
  if (Array.isArray(value)) {
    const result: unknown[] = []
    seen.set(object, result)
    for (const item of value) result.push(cloneValue(item, seen))
    return result
  }
  if (value instanceof Date) return new Date(value.getTime())
  const result: Record<string, unknown> = {}
  seen.set(object, result)
  for (const [key, item] of Object.entries(value)) result[key] = cloneValue(item, seen)
  return result
}

export function deepFreeze<Value>(value: Value): Value {
  freezeValue(value, new WeakSet<object>())
  return value
}

function errorMessage(value: unknown): string {
  if (typeof value === "string") return value
  if (value !== null && typeof value === "object" && "message" in value && typeof value.message === "string") {
    return value.message
  }
  return "agent failed"
}

function freezeValue(value: unknown, seen: WeakSet<object>): void {
  if (value === null || typeof value !== "object") return
  const object = value as object
  if (seen.has(object)) return
  seen.add(object)
  Object.freeze(object)
  for (const key of Reflect.ownKeys(object)) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key)
    if (descriptor && "value" in descriptor) freezeValue(descriptor.value, seen)
  }
}
