import { assertJsonValue, isJsonValue, isRecord, type JsonObject, type JsonValue } from "./json"
import type { TokenUsage } from "./limits"

export type ModelFinishReason =
  | "stop"
  | "length"
  | "tool_calls"
  | "content_filter"
  | "cancelled"
  | "error"
  | "unknown"
  | (string & {})

export interface ModelStartEvent {
  readonly type: "start"
  readonly responseId?: string
  readonly model?: string
  readonly metadata?: JsonObject
}

export interface ModelTextDeltaEvent {
  readonly type: "text-delta"
  readonly text: string
  readonly blockId?: string
  readonly metadata?: JsonObject
}

export interface ModelReasoningDeltaEvent {
  readonly type: "reasoning-delta"
  readonly text: string
  readonly blockId?: string
  readonly metadata?: JsonObject
}

export interface ModelToolCallDeltaEvent {
  readonly type: "tool-call-delta"
  readonly callId: string
  readonly name?: string
  readonly argumentsDelta?: string
  readonly metadata?: JsonObject
}

export interface ModelToolCallEvent {
  readonly type: "tool-call"
  readonly callId: string
  readonly name: string
  readonly input: JsonValue
  readonly providerExecuted?: boolean
  readonly metadata?: JsonObject
}

export interface ModelToolResultEvent {
  readonly type: "tool-result"
  readonly callId: string
  readonly name?: string
  readonly output: JsonValue
  readonly providerExecuted?: boolean
  readonly metadata?: JsonObject
}

export interface ModelUsageEvent {
  readonly type: "usage"
  readonly usage: TokenUsage & { readonly metadata?: JsonObject }
}

export interface ModelFinishEvent {
  readonly type: "finish"
  readonly reason: ModelFinishReason
  readonly output?: JsonValue
  readonly usage?: TokenUsage & { readonly metadata?: JsonObject }
  readonly metadata?: JsonObject
}

export interface ModelErrorPayload {
  readonly code?: string
  readonly message: string
  readonly retryable?: boolean
  readonly details?: JsonValue
}

export interface ModelErrorEvent {
  readonly type: "error"
  readonly error: ModelErrorPayload
  readonly metadata?: JsonObject
}

export interface ModelCancelledEvent {
  readonly type: "cancelled"
  readonly reason?: string
  readonly metadata?: JsonObject
}

export interface ModelProviderEvent {
  readonly type: "provider-event"
  readonly data: JsonValue
  readonly metadata?: JsonObject
}

export type ModelEvent =
  | ModelStartEvent
  | ModelTextDeltaEvent
  | ModelReasoningDeltaEvent
  | ModelToolCallDeltaEvent
  | ModelToolCallEvent
  | ModelToolResultEvent
  | ModelUsageEvent
  | ModelFinishEvent
  | ModelErrorEvent
  | ModelCancelledEvent
  | ModelProviderEvent

export type ModelStreamEvent = ModelEvent
export type StreamEvent = ModelEvent

const stringValue = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)

const numberValue = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined

const booleanValue = (value: unknown): boolean | undefined => (typeof value === "boolean" ? value : undefined)

const providerExecutedValue = (value: Record<string, unknown>) =>
  booleanValue(value.providerExecuted) ?? booleanValue(value.provider_executed)

const jsonObject = (value: unknown): JsonObject | undefined =>
  isJsonValue(value) && isRecord(value) ? (value as JsonObject) : undefined

const jsonValue = (value: unknown, fallback: JsonValue): JsonValue => (isJsonValue(value) ? value : fallback)

const jsonValueOrUndefined = (value: unknown): JsonValue | undefined => (isJsonValue(value) ? value : undefined)

const firstNumber = (...values: readonly unknown[]) =>
  values.map((value) => numberValue(value)).find((value) => value !== undefined)

const parseJson = (value: unknown): JsonValue => {
  if (typeof value !== "string") return jsonValue(value, null)
  try {
    const parsed: unknown = JSON.parse(value) as unknown
    return isJsonValue(parsed) ? parsed : value
  } catch {
    return value
  }
}

const usageValue = (value: unknown): TokenUsage & { readonly metadata?: JsonObject } => {
  if (!isRecord(value)) return {}
  const metadata = jsonObject(value.metadata)
  const inputTokens = firstNumber(value.inputTokens, value.promptTokens, value.input_tokens, value.prompt_tokens)
  const outputTokens = firstNumber(
    value.outputTokens,
    value.completionTokens,
    value.output_tokens,
    value.completion_tokens,
  )
  const totalTokens = firstNumber(value.totalTokens, value.total_tokens)
  const reasoningTokens = firstNumber(value.reasoningTokens, value.reasoning_tokens)
  const costUsd = firstNumber(value.costUsd, value.cost_usd)
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(costUsd === undefined ? {} : { costUsd }),
    ...(metadata === undefined ? {} : { metadata }),
  }
}

const errorValue = (value: unknown): ModelErrorPayload => {
  if (typeof value === "string") return { message: value }
  if (!isRecord(value)) return { message: "Provider returned an unknown error" }
  const nested = isRecord(value.error) ? value.error : value
  const message = stringValue(nested.message) ?? stringValue(value.message) ?? "Provider returned an unknown error"
  const code = stringValue(nested.code) ?? stringValue(value.code)
  const retryable = booleanValue(nested.retryable) ?? booleanValue(value.retryable)
  const details = jsonValueOrUndefined(nested.details) ?? jsonValueOrUndefined(value.details)
  return {
    ...(code === undefined ? {} : { code }),
    message,
    ...(retryable === undefined ? {} : { retryable }),
    ...(details === undefined ? {} : { details }),
  }
}

const eventType = (value: unknown): string => {
  if (!isRecord(value) || typeof value.type !== "string") return ""
  return value.type.replaceAll("_", "-").toLowerCase()
}

const callIdValue = (value: Record<string, unknown>) =>
  stringValue(value.callId) ?? stringValue(value.call_id) ?? stringValue(value.toolCallId) ?? stringValue(value.id)

const normalizeCanonical = (value: Record<string, unknown>): ModelEvent | undefined => {
  const type = eventType(value)
  const metadata = jsonObject(value.metadata)
  if (type === "model.requested") {
    const model = stringValue(value.model)
    return {
      type: "start",
      ...(model === undefined ? {} : { model }),
      ...(metadata === undefined ? {} : { metadata }),
    }
  }
  if (type === "model.started") {
    const model = stringValue(value.model) ?? stringValue(value.model_id)
    return {
      type: "start",
      ...(model === undefined ? {} : { model }),
      ...(metadata === undefined ? {} : { metadata }),
    }
  }
  if (type === "model.message") {
    const content = value.content
    const text = typeof content === "string" ? content : isRecord(content) ? stringValue(content.text) : undefined
    if (text === undefined) return undefined
    return { type: "text-delta", text, ...(metadata === undefined ? {} : { metadata }) }
  }
  if (type === "model.tool-call") {
    const callId = callIdValue(value)
    const name = stringValue(value.name)
    if (callId === undefined || name === undefined) return undefined
    return {
      type: "tool-call",
      callId,
      name,
      input: jsonValue(value.input, null),
      ...(metadata === undefined ? {} : { metadata }),
    }
  }
  if (type === "model.completed" || type === "model.response") {
    const output = jsonValueOrUndefined(value.output)
    return {
      type: "finish",
      reason: stringValue(value.finishReason) ?? "stop",
      ...(output === undefined ? {} : { output }),
      ...(metadata === undefined ? {} : { metadata }),
    }
  }
  if (type === "model.failed") {
    return { type: "error", error: errorValue(value.error), ...(metadata === undefined ? {} : { metadata }) }
  }
  if (type === "model.cancelled") {
    return {
      type: "cancelled",
      ...(stringValue(value.reason) === undefined ? {} : { reason: stringValue(value.reason) }),
      ...(metadata === undefined ? {} : { metadata }),
    }
  }
  if (type === "start" || type === "response-start" || type === "message-start") {
    const responseId = stringValue(value.responseId) ?? stringValue(value.response_id)
    const model = stringValue(value.model) ?? stringValue(value.model_id)
    return {
      type: "start",
      ...(responseId === undefined ? {} : { responseId }),
      ...(model === undefined ? {} : { model }),
      ...(metadata === undefined ? {} : { metadata }),
    }
  }
  if (type === "text-delta" || type === "text" || type === "content-delta") {
    const text = stringValue(value.text) ?? stringValue(value.delta) ?? stringValue(value.content)
    if (text === undefined) return undefined
    return {
      type: "text-delta",
      text,
      ...(stringValue(value.blockId) === undefined ? {} : { blockId: stringValue(value.blockId) }),
      ...(metadata === undefined ? {} : { metadata }),
    }
  }
  if (type === "reasoning-delta" || type === "reasoning" || type === "thinking-delta") {
    const text = stringValue(value.text) ?? stringValue(value.delta) ?? stringValue(value.reasoning)
    if (text === undefined) return undefined
    return {
      type: "reasoning-delta",
      text,
      ...(stringValue(value.blockId) === undefined ? {} : { blockId: stringValue(value.blockId) }),
      ...(metadata === undefined ? {} : { metadata }),
    }
  }
  if (type === "tool-call-delta" || type === "tool-input-delta" || type === "tool-arguments-delta") {
    const callId = callIdValue(value)
    if (callId === undefined) return undefined
    const name = stringValue(value.name) ?? stringValue(value.toolName)
    const argumentsDelta =
      stringValue(value.argumentsDelta) ?? stringValue(value.arguments_delta) ?? stringValue(value.arguments)
    return {
      type: "tool-call-delta",
      callId,
      ...(name === undefined ? {} : { name }),
      ...(argumentsDelta === undefined ? {} : { argumentsDelta }),
      ...(metadata === undefined ? {} : { metadata }),
    }
  }
  if (type === "tool-call" || type === "tool-call-complete" || type === "function-call") {
    const callId = callIdValue(value)
    const name =
      stringValue(value.name) ??
      stringValue(value.toolName) ??
      stringValue(value.function && isRecord(value.function) ? value.function.name : undefined)
    if (callId === undefined || name === undefined) return undefined
    const rawInput =
      value.input ?? value.arguments ?? value.args ?? (isRecord(value.function) ? value.function.arguments : undefined)
    const providerExecuted = providerExecutedValue(value)
    return {
      type: "tool-call",
      callId,
      name,
      input: parseJson(rawInput),
      ...(providerExecuted === undefined ? {} : { providerExecuted }),
      ...(metadata === undefined ? {} : { metadata }),
    }
  }
  if (type === "tool-result" || type === "tool-output" || type === "function-result") {
    const callId = callIdValue(value)
    if (callId === undefined) return undefined
    const providerExecuted = providerExecutedValue(value)
    return {
      type: "tool-result",
      callId,
      ...(stringValue(value.name) === undefined ? {} : { name: stringValue(value.name) }),
      output: parseJson(value.output ?? value.result ?? value.content),
      ...(providerExecuted === undefined ? {} : { providerExecuted }),
      ...(metadata === undefined ? {} : { metadata }),
    }
  }
  if (type === "usage" || type === "token-usage") {
    return { type: "usage", usage: usageValue(value.usage ?? value) }
  }
  if (type === "finish" || type === "complete" || type === "done" || type === "response-complete") {
    const reason =
      stringValue(value.reason) ?? stringValue(value.finishReason) ?? stringValue(value.finish_reason) ?? "unknown"
    const usage = value.usage === undefined ? undefined : usageValue(value.usage)
    const output = jsonValueOrUndefined(value.output)
    return {
      type: "finish",
      reason,
      ...(output === undefined ? {} : { output }),
      ...(usage === undefined ? {} : { usage }),
      ...(metadata === undefined ? {} : { metadata }),
    }
  }
  if (type === "error" || type === "provider-error" || type === "failure") {
    return {
      type: "error",
      error: errorValue(value.error ?? value),
      ...(metadata === undefined ? {} : { metadata }),
    }
  }
  if (type === "cancelled" || type === "canceled" || type === "abort") {
    return {
      type: "cancelled",
      ...(stringValue(value.reason) === undefined ? {} : { reason: stringValue(value.reason) }),
      ...(metadata === undefined ? {} : { metadata }),
    }
  }
  return undefined
}

export function normalizeModelEvent(value: unknown): ModelEvent {
  if (isRecord(value)) {
    const normalized = normalizeCanonical(value)
    if (normalized) return normalized
    return { type: "provider-event", data: jsonValue(value, null) }
  }
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value) as unknown
      if (isRecord(parsed)) return normalizeModelEvent(parsed)
    } catch {
      return { type: "text-delta", text: value }
    }
    return { type: "text-delta", text: value }
  }
  return { type: "provider-event", data: jsonValue(value, null) }
}

export const normalizeStreamingEvent = normalizeModelEvent

export const isModelEvent = (value: unknown): value is ModelEvent => {
  if (!isRecord(value) || typeof value.type !== "string") return false
  if (value.type === "start") return value.responseId === undefined || typeof value.responseId === "string"
  if (value.type === "text-delta" || value.type === "reasoning-delta") return typeof value.text === "string"
  if (value.type === "tool-call-delta") return typeof value.callId === "string"
  if (value.type === "tool-call")
    return typeof value.callId === "string" && typeof value.name === "string" && isJsonValue(value.input)
  if (value.type === "tool-result") return typeof value.callId === "string" && isJsonValue(value.output)
  if (value.type === "usage") return isRecord(value.usage)
  if (value.type === "finish")
    return typeof value.reason === "string" && (value.usage === undefined || isRecord(value.usage))
  if (value.type === "error") return isRecord(value.error) && typeof value.error.message === "string"
  if (value.type === "cancelled") return value.reason === undefined || typeof value.reason === "string"
  if (value.type === "provider-event") return isJsonValue(value.data)
  return false
}

export const ModelEvent = {
  start: (input: Omit<ModelStartEvent, "type"> = {}): ModelStartEvent => ({ type: "start", ...input }),
  textDelta: (input: Omit<ModelTextDeltaEvent, "type">): ModelTextDeltaEvent => ({ type: "text-delta", ...input }),
  reasoningDelta: (input: Omit<ModelReasoningDeltaEvent, "type">): ModelReasoningDeltaEvent => ({
    type: "reasoning-delta",
    ...input,
  }),
  toolCallDelta: (input: Omit<ModelToolCallDeltaEvent, "type">): ModelToolCallDeltaEvent => ({
    type: "tool-call-delta",
    ...input,
  }),
  toolCall: (input: Omit<ModelToolCallEvent, "type">): ModelToolCallEvent => ({ type: "tool-call", ...input }),
  toolResult: (input: Omit<ModelToolResultEvent, "type">): ModelToolResultEvent => ({ type: "tool-result", ...input }),
  usage: (input: Omit<ModelUsageEvent, "type">): ModelUsageEvent => ({ type: "usage", ...input }),
  finish: (input: Omit<ModelFinishEvent, "type">): ModelFinishEvent => ({ type: "finish", ...input }),
  error: (input: Omit<ModelErrorEvent, "type"> | ModelErrorPayload): ModelErrorEvent => ({
    type: "error",
    error: "error" in input ? input.error : input,
  }),
  cancelled: (input: Omit<ModelCancelledEvent, "type"> = {}): ModelCancelledEvent => ({ type: "cancelled", ...input }),
  providerEvent: (input: Omit<ModelProviderEvent, "type">): ModelProviderEvent => ({
    type: "provider-event",
    ...input,
  }),
} as const

export const modelEventJson = (event: ModelEvent): JsonValue => {
  assertJsonValue(event)
  return event
}
