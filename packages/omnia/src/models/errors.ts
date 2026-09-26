import type { JsonObject } from "./json"

export type ModelGatewayErrorCode =
  | "invalid-request"
  | "provider-not-found"
  | "model-not-found"
  | "capability-negotiation"
  | "budget-exceeded"
  | "cancelled"
  | "timeout"
  | "provider-error"
  | "protocol-error"

export class ModelGatewayError extends Error {
  readonly code: ModelGatewayErrorCode
  readonly details?: JsonObject

  constructor(code: ModelGatewayErrorCode, message: string, details?: JsonObject) {
    super(message)
    this.name = "ModelGatewayError"
    this.code = code
    this.details = details
  }
}

export class InvalidModelRequestError extends ModelGatewayError {
  constructor(message: string, details?: JsonObject) {
    super("invalid-request", message, details)
    this.name = "InvalidModelRequestError"
  }
}

export class ProviderNotFoundError extends ModelGatewayError {
  readonly providerId: string

  constructor(providerId: string) {
    super("provider-not-found", `Provider not found: ${providerId}`, { providerId })
    this.name = "ProviderNotFoundError"
    this.providerId = providerId
  }
}

export class ModelNotFoundError extends ModelGatewayError {
  readonly providerId: string
  readonly modelId: string

  constructor(providerId: string, modelId: string) {
    super("model-not-found", `Model not found: ${providerId}/${modelId}`, { providerId, modelId })
    this.name = "ModelNotFoundError"
    this.providerId = providerId
    this.modelId = modelId
  }
}

export class CapabilityNegotiationError extends ModelGatewayError {
  readonly unsupported: readonly string[]

  constructor(unsupported: readonly string[], message = `Unsupported model capabilities: ${unsupported.join(", ")}`) {
    super("capability-negotiation", message, { unsupported: [...unsupported] })
    this.name = "CapabilityNegotiationError"
    this.unsupported = unsupported
  }
}

export class BudgetExceededError extends ModelGatewayError {
  readonly limit: string
  readonly actual: number
  readonly allowed: number

  constructor(limit: string, actual: number, allowed: number) {
    super("budget-exceeded", `Model budget exceeded: ${limit} (${actual} > ${allowed})`, { limit, actual, allowed })
    this.name = "BudgetExceededError"
    this.limit = limit
    this.actual = actual
    this.allowed = allowed
  }
}

export class ModelCancelledError extends ModelGatewayError {
  constructor(message = "Model request was cancelled") {
    super("cancelled", message)
    this.name = "ModelCancelledError"
  }
}

export class ModelTimeoutError extends ModelGatewayError {
  readonly timeoutMs: number

  constructor(timeoutMs: number) {
    super("timeout", `Model request exceeded its time limit of ${timeoutMs}ms`, { timeoutMs })
    this.name = "ModelTimeoutError"
    this.timeoutMs = timeoutMs
  }
}

export class ModelProviderError extends ModelGatewayError {
  readonly retryable: boolean

  constructor(message: string, retryable = false, details?: JsonObject) {
    super("provider-error", message, details)
    this.name = "ModelProviderError"
    this.retryable = retryable
  }
}

export class ModelProtocolError extends ModelGatewayError {
  constructor(message: string, details?: JsonObject) {
    super("protocol-error", message, details)
    this.name = "ModelProtocolError"
  }
}

export const isModelGatewayError = (value: unknown): value is ModelGatewayError => value instanceof ModelGatewayError
