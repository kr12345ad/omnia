import {
  normalizeCapabilities,
  type CapabilityDeclaration,
  type ModelCapabilities,
  capabilitiesJson,
} from "./capabilities"
import {
  assertCredentialReference,
  assertNoPlaintextSecrets,
  credentialReferenceJson,
  type CredentialReference,
} from "./credentials"
import { assertJsonValue, compact, isRecord, type JsonObject, type ModelEndpoint } from "./json"
import { InvalidModelRequestError } from "./errors"

export interface ModelReference {
  readonly providerId: string
  readonly modelId: string
  readonly variant?: string
}

export interface ModelReferenceInput {
  readonly providerId?: string
  readonly providerID?: string
  readonly modelId?: string
  readonly modelID?: string
  readonly provider?: string
  readonly model?: string
  readonly id?: string
  readonly variant?: string
}

export interface ModelLimits {
  readonly context?: number
  readonly contextWindow?: number
  readonly input?: number
  readonly output?: number
  readonly maxInputTokens?: number
  readonly maxOutputTokens?: number
}

export interface ModelDescriptor {
  readonly id: string
  readonly providerId: string
  readonly name?: string
  readonly description?: string
  readonly protocol?: string
  readonly endpoint?: ModelEndpoint
  readonly capabilities: ModelCapabilities
  readonly limits: ModelLimits
  readonly credential?: CredentialReference
  readonly metadata?: JsonObject
}

export type ModelInfo = ModelDescriptor
export type ModelRef = ModelReference

export interface ModelDescriptorInput {
  readonly id?: string
  readonly modelId?: string
  readonly modelID?: string
  readonly providerId?: string
  readonly providerID?: string
  readonly name?: string
  readonly description?: string
  readonly protocol?: string
  readonly endpoint?: ModelEndpoint
  readonly url?: string
  readonly baseURL?: string
  readonly capabilities?: CapabilityDeclaration
  readonly limits?: ModelLimits
  readonly credential?: CredentialReference
  readonly metadata?: JsonObject
}

const nonEmpty = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.length === 0)
    throw new InvalidModelRequestError(`${field} must be a non-empty string`)
  return value
}

const validateLimit = (value: number | undefined, field: string) => {
  if (value === undefined) return
  if (!Number.isSafeInteger(value) || value < 0)
    throw new InvalidModelRequestError(`${field} must be a non-negative safe integer`)
}

export function normalizeModelReference(input: string | ModelReferenceInput, providerId?: string): ModelReference {
  if (typeof input === "string") {
    const resolvedProvider = providerId ?? (input.includes("/") ? input.slice(0, input.indexOf("/")) : undefined)
    const modelId = input.includes("/") ? input.slice(input.indexOf("/") + 1) : input
    if (resolvedProvider === undefined || modelId.length === 0) {
      throw new InvalidModelRequestError("A model string requires a provider id or a provider/model reference")
    }
    return { providerId: resolvedProvider, modelId }
  }
  if (!isRecord(input)) throw new InvalidModelRequestError("Model reference must be an object or string")
  const resolvedProvider = input.providerId ?? input.providerID ?? input.provider ?? providerId
  const resolvedModel = input.modelId ?? input.modelID ?? input.model ?? input.id
  if (resolvedProvider === undefined || resolvedModel === undefined) {
    throw new InvalidModelRequestError("Model reference requires provider and model ids")
  }
  return {
    providerId: nonEmpty(resolvedProvider, "providerId"),
    modelId: nonEmpty(resolvedModel, "modelId"),
    ...(input.variant === undefined ? {} : { variant: nonEmpty(input.variant, "variant") }),
  }
}

export function normalizeModelDescriptor(input: ModelDescriptorInput, providerIdHint?: string): ModelDescriptor {
  if (!isRecord(input)) throw new InvalidModelRequestError("Model descriptor must be an object")
  const value = input as unknown as ModelDescriptorInput
  assertNoPlaintextSecrets(value, "model")
  const id = value.id ?? value.modelId ?? value.modelID
  const providerId = value.providerId ?? value.providerID ?? providerIdHint
  if (id === undefined || providerId === undefined)
    throw new InvalidModelRequestError("Model descriptor requires id and providerId")
  const limits: ModelLimits = value.limits ?? {}
  const context = limits.context ?? limits.contextWindow
  const inputLimit = limits.input ?? limits.maxInputTokens
  const outputLimit = limits.output ?? limits.maxOutputTokens
  const endpoint = value.endpoint ?? value.url ?? value.baseURL
  if (endpoint !== undefined) {
    if (typeof endpoint !== "string") {
      assertJsonValue(endpoint, "model.endpoint")
      assertNoPlaintextSecrets(endpoint, "model.endpoint")
    } else nonEmpty(endpoint, "model.endpoint")
  }
  validateLimit(context, "limits.context")
  validateLimit(inputLimit, "limits.input")
  validateLimit(outputLimit, "limits.output")
  if (value.metadata !== undefined) {
    assertJsonValue(value.metadata, "model.metadata")
    assertNoPlaintextSecrets(value.metadata, "model.metadata")
  }
  if (value.credential !== undefined) assertCredentialReference(value.credential)
  return compact({
    id: nonEmpty(id, "model.id"),
    providerId: nonEmpty(providerId, "model.providerId"),
    ...(value.name === undefined ? {} : { name: nonEmpty(value.name, "model.name") }),
    ...(value.description === undefined ? {} : { description: value.description }),
    ...(value.protocol === undefined ? {} : { protocol: value.protocol }),
    ...(endpoint === undefined ? {} : { endpoint }),
    capabilities: normalizeCapabilities(value.capabilities),
    limits: compact({
      ...(context === undefined ? {} : { context }),
      ...(inputLimit === undefined ? {} : { input: inputLimit }),
      ...(outputLimit === undefined ? {} : { output: outputLimit }),
    }),
    ...(value.credential === undefined ? {} : { credential: value.credential }),
    ...(value.metadata === undefined ? {} : { metadata: value.metadata }),
  })
}

export const modelReferenceKey = (reference: ModelReference) => `${reference.providerId}:${reference.modelId}`

export const isModelReference = (value: unknown): value is ModelReference => {
  if (!isRecord(value)) return false
  try {
    const reference = normalizeModelReference(value as unknown as ModelReferenceInput)
    return reference.providerId.length > 0 && reference.modelId.length > 0
  } catch {
    return false
  }
}

export const isModelDescriptor = (value: unknown): value is ModelDescriptor => {
  if (!isRecord(value)) return false
  try {
    normalizeModelDescriptor(value as unknown as ModelDescriptorInput)
    return true
  } catch {
    return false
  }
}

export const ModelDescriptor = {
  make: normalizeModelDescriptor,
  is: isModelDescriptor,
} as const

export const ModelReference = {
  make: normalizeModelReference,
  is: isModelReference,
} as const

export const modelDescriptorJson = (descriptor: ModelDescriptor): JsonObject => ({
  id: descriptor.id,
  providerId: descriptor.providerId,
  ...(descriptor.name === undefined ? {} : { name: descriptor.name }),
  ...(descriptor.description === undefined ? {} : { description: descriptor.description }),
  ...(descriptor.protocol === undefined ? {} : { protocol: descriptor.protocol }),
  ...(descriptor.endpoint === undefined ? {} : { endpoint: descriptor.endpoint }),
  capabilities: capabilitiesJson(descriptor.capabilities),
  limits: Object.fromEntries(Object.entries(descriptor.limits).filter((entry) => entry[1] !== undefined)),
  ...(descriptor.credential === undefined ? {} : { credential: credentialReferenceJson(descriptor.credential) }),
  ...(descriptor.metadata === undefined ? {} : { metadata: descriptor.metadata }),
})
