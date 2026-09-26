import {
  assertNoPlaintextSecrets,
  assertCredentialReference,
  credentialReferenceJson,
  type CredentialReference,
  type CredentialResolver,
} from "./credentials"
import { capabilitiesJson, normalizeCapabilities, type CapabilityDeclaration } from "./capabilities"
import { assertJsonValue, compact, isRecord, type JsonObject, type JsonValue, type ModelEndpoint } from "./json"
import { InvalidModelRequestError } from "./errors"
import { modelDescriptorJson, normalizeModelDescriptor, type ModelDescriptor, type ModelDescriptorInput } from "./model"
import type { ModelEvent as ProtocolModelEvent } from "../protocol"
import type { ModelEvent } from "./events"
import type { NormalizedModelRequest } from "./request"

export interface ProviderDescriptor {
  readonly id: string
  readonly name?: string
  readonly endpoint?: ModelEndpoint
  readonly protocol?: string
  readonly protocolId?: string
  readonly capabilities?: CapabilityDeclaration
  readonly credential?: CredentialReference
  readonly metadata?: JsonObject
}

export interface ProviderDescriptorInput {
  readonly id?: string
  readonly name?: string
  readonly endpoint?: ModelEndpoint
  readonly url?: string
  readonly baseURL?: string
  readonly protocol?: string
  readonly capabilities?: CapabilityDeclaration
  readonly credential?: CredentialReference
  readonly metadata?: JsonObject
}

export interface ProviderRequestContext {
  readonly request: NormalizedModelRequest
  readonly signal: AbortSignal
  readonly requestId: string
  readonly credentialReference?: CredentialReference
  readonly credential: (reference?: CredentialReference) => string | undefined | Promise<string | undefined>
  readonly resolveCredential: (reference?: CredentialReference) => string | undefined | Promise<string | undefined>
  readonly metadata: JsonObject
  readonly now: () => number
}

export type ProviderStream = AsyncIterable<unknown> | Iterable<unknown>

export interface ModelProtocol<NativeRequest = JsonValue> {
  readonly id?: string
  readonly encodeRequest?: (
    request: NormalizedModelRequest,
    context: ProviderRequestContext,
  ) => NativeRequest | Promise<NativeRequest>
  readonly decodeEvent: (event: unknown) => ModelEvent | ProtocolModelEvent | Promise<ModelEvent | ProtocolModelEvent>
}

export interface ModelProvider<NativeRequest = JsonValue> {
  readonly id: string
  readonly name?: string
  readonly endpoint?: ModelEndpoint
  readonly url?: string
  readonly baseURL?: string
  readonly protocol?: string | ModelProtocol<NativeRequest>
  readonly protocolId?: string
  readonly capabilities?: CapabilityDeclaration
  readonly credential?: CredentialReference
  readonly credentialResolver?: CredentialResolver
  readonly metadata?: JsonObject
  readonly models: readonly ModelDescriptor[]
  readonly listModels?: () => readonly ModelDescriptor[] | Promise<readonly ModelDescriptor[]>
  readonly normalizeRequest?: (
    request: NormalizedModelRequest,
    context: ProviderRequestContext,
  ) => NativeRequest | Promise<NativeRequest>
  readonly stream: (request: NativeRequest, context: ProviderRequestContext) => ProviderStream | Promise<ProviderStream>
}

export interface ProviderManifest {
  readonly id: string
  readonly name?: string
  readonly endpoint?: ModelEndpoint
  readonly protocol?: string
  readonly protocolId?: string
  readonly capabilities?: CapabilityDeclaration
  readonly credential?: CredentialReference
  readonly metadata?: JsonObject
  readonly models: readonly ModelDescriptor[]
}

export type ProviderManifestInput = ProviderDescriptorInput & {
  readonly models: readonly ModelDescriptorInput[]
}

const nonEmpty = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.length === 0)
    throw new InvalidModelRequestError(`${field} must be a non-empty string`)
  return value
}

export function normalizeProviderDescriptor(input: ProviderDescriptorInput): ProviderDescriptor {
  if (!isRecord(input)) throw new InvalidModelRequestError("Provider descriptor must be an object")
  const value = input as unknown as ProviderDescriptorInput
  assertNoPlaintextSecrets(value, "provider")
  if (value.credential !== undefined) assertCredentialReference(value.credential)
  const endpoint = value.endpoint ?? value.url ?? value.baseURL
  if (endpoint !== undefined) {
    if (typeof endpoint !== "string") {
      assertJsonValue(endpoint, "provider.endpoint")
      assertNoPlaintextSecrets(endpoint, "provider.endpoint")
    } else nonEmpty(endpoint, "provider.endpoint")
  }
  if (value.metadata !== undefined) {
    assertJsonValue(value.metadata, "provider.metadata")
    assertNoPlaintextSecrets(value.metadata, "provider.metadata")
  }
  return compact({
    id: nonEmpty(value.id, "provider.id"),
    ...(value.name === undefined ? {} : { name: nonEmpty(value.name, "provider.name") }),
    ...(endpoint === undefined ? {} : { endpoint }),
    ...(value.protocol === undefined ? {} : { protocol: nonEmpty(value.protocol, "provider.protocol") }),
    ...(value.capabilities === undefined ? {} : { capabilities: normalizeCapabilities(value.capabilities) }),
    ...(value.credential === undefined ? {} : { credential: value.credential }),
    ...(value.metadata === undefined ? {} : { metadata: value.metadata }),
  })
}

export function normalizeProvider<NativeRequest = JsonValue>(
  provider: ModelProvider<NativeRequest> | ModelProviderInput<NativeRequest>,
): ModelProvider<NativeRequest> {
  if (!isRecord(provider)) throw new InvalidModelRequestError("Provider must be an object")
  const value = provider as ModelProvider<NativeRequest>
  const id = nonEmpty(value.id, "provider.id")
  const sourceModels = value.models ?? (value.listModels === undefined ? [] : value.listModels())
  if (sourceModels instanceof Promise)
    throw new InvalidModelRequestError(`Provider ${id} model discovery must be synchronous`)
  if (!Array.isArray(sourceModels)) throw new InvalidModelRequestError(`Provider ${id} must expose a models array`)
  const models = sourceModels.map((model) => normalizeModelDescriptor(model, id))
  if (value.credential !== undefined) assertCredentialReference(value.credential)
  const metadata = value.metadata
  if (metadata !== undefined) {
    assertJsonValue(metadata, "provider.metadata")
    assertNoPlaintextSecrets(metadata, "provider.metadata")
  }
  assertNoPlaintextSecrets(value, "provider")
  const endpoint = value.endpoint ?? value.url ?? value.baseURL
  if (endpoint !== undefined) {
    if (typeof endpoint !== "string") {
      assertJsonValue(endpoint, "provider.endpoint")
      assertNoPlaintextSecrets(endpoint, "provider.endpoint")
    } else nonEmpty(endpoint, "provider.endpoint")
  }
  return {
    ...value,
    id,
    ...(endpoint === undefined ? {} : { endpoint }),
    models,
  } as unknown as ModelProvider<NativeRequest>
}

export const isModelProvider = (value: unknown): value is ModelProvider => {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0 || typeof value.stream !== "function")
    return false
  if (value.models !== undefined && !Array.isArray(value.models)) return false
  return value.models === undefined || typeof value.listModels === "function"
}

export function createModelProvider<NativeRequest = JsonValue>(
  provider: ModelProviderInput<NativeRequest>,
): ModelProvider<NativeRequest> {
  return normalizeProvider(provider)
}

export function providerManifest(provider: ModelProvider | ModelProviderInput): ProviderManifest {
  const normalized = normalizeProvider(provider)
  const descriptor: ProviderDescriptor = compact({
    id: normalized.id,
    ...(normalized.name === undefined ? {} : { name: normalized.name }),
    ...(normalized.endpoint === undefined ? {} : { endpoint: normalized.endpoint }),
    ...(normalized.protocol === undefined
      ? {}
      : { protocol: typeof normalized.protocol === "string" ? normalized.protocol : normalized.protocol.id }),
    ...(normalized.protocolId === undefined ? {} : { protocolId: normalized.protocolId }),
    ...(normalized.capabilities === undefined ? {} : { capabilities: normalizeCapabilities(normalized.capabilities) }),
    ...(normalized.credential === undefined ? {} : { credential: normalized.credential }),
    ...(normalized.metadata === undefined ? {} : { metadata: normalized.metadata }),
  })
  return {
    ...descriptor,
    models: normalized.models.map((model) => ({ ...model })),
  }
}

export const providerDescriptorJson = (
  descriptor: ProviderDescriptor,
  models: readonly ModelDescriptor[] = [],
): JsonObject => ({
  id: descriptor.id,
  ...(descriptor.name === undefined ? {} : { name: descriptor.name }),
  ...(descriptor.endpoint === undefined ? {} : { endpoint: descriptor.endpoint }),
  ...(descriptor.protocol === undefined ? {} : { protocol: descriptor.protocol }),
  ...(descriptor.protocolId === undefined ? {} : { protocolId: descriptor.protocolId }),
  ...(descriptor.capabilities === undefined
    ? {}
    : { capabilities: capabilitiesJson(normalizeCapabilities(descriptor.capabilities)) }),
  ...(descriptor.credential === undefined ? {} : { credential: credentialReferenceJson(descriptor.credential) }),
  ...(descriptor.metadata === undefined ? {} : { metadata: descriptor.metadata }),
  models: models.map((model) => modelDescriptorJson(model)),
})

export type ModelProviderInput<NativeRequest = JsonValue> = Omit<ModelProvider<NativeRequest>, "models"> & {
  readonly models?: readonly ModelDescriptorInput[]
}
export type ModelProviderStream = ProviderStream
export type ModelProviderProtocol<NativeRequest = JsonValue> = ModelProtocol<NativeRequest>
