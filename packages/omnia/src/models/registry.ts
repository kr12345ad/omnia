import { InvalidModelRequestError, ModelNotFoundError, ProviderNotFoundError } from "./errors"
import {
  normalizeModelDescriptor,
  normalizeModelReference,
  type ModelDescriptor,
  type ModelDescriptorInput,
  type ModelReferenceInput,
} from "./model"
import { assertNoPlaintextSecrets, assertCredentialReference } from "./credentials"
import {
  normalizeProvider,
  providerManifest,
  providerDescriptorJson,
  normalizeProviderDescriptor,
  type ModelProvider,
  type ModelProviderInput,
  type ProviderManifest,
  type ProviderManifestInput,
} from "./provider"
import { assertJsonValue, type JsonObject } from "./json"

export interface ProviderRegistryOptions {
  readonly replace?: boolean
}

export interface ResolvedModel {
  readonly provider: ModelProvider
  readonly descriptor?: ModelDescriptor
}

export interface ProviderRegistrySnapshot {
  readonly providers: readonly ProviderManifest[]
}

const manifestInput = (manifest: ProviderManifest | ProviderManifestInput): ProviderManifest => {
  if (!manifest || typeof manifest.id !== "string" || manifest.id.length === 0) {
    throw new InvalidModelRequestError("Provider manifest requires an id")
  }
  assertNoPlaintextSecrets(manifest, "provider")
  const descriptor = normalizeProviderDescriptor(manifest)
  if (manifest.metadata !== undefined) assertJsonValue(manifest.metadata, "provider.metadata")
  if (manifest.credential !== undefined) assertCredentialReference(manifest.credential)
  return {
    ...descriptor,
    models: (manifest.models ?? []).map((model) => normalizeModelDescriptor(model, descriptor.id)),
  }
}

export class ProviderRegistry {
  private readonly providers = new Map<string, ModelProvider>()
  private readonly manifests = new Map<string, ProviderManifest>()

  constructor(providers: Iterable<ModelProvider | ModelProviderInput> = []) {
    for (const provider of providers) this.register(provider)
  }

  register(provider: ModelProvider | ModelProviderInput, options: ProviderRegistryOptions = {}): this {
    const normalized = normalizeProvider(provider)
    if ((this.providers.has(normalized.id) || this.manifests.has(normalized.id)) && !options.replace) {
      throw new InvalidModelRequestError(`Provider already registered: ${normalized.id}`)
    }
    this.providers.set(normalized.id, normalized)
    this.manifests.set(normalized.id, manifestInput(providerManifestFromProvider(normalized)))
    return this
  }

  registerProvider(provider: ModelProvider | ModelProviderInput, options: ProviderRegistryOptions = {}): this {
    return this.register(provider, options)
  }

  registerProviderById(providerId: string, provider: ModelProviderInput, options: ProviderRegistryOptions = {}): this {
    return this.register({ ...provider, id: providerId }, options)
  }

  registerModel(providerId: string, model: ModelDescriptorInput, _options: ProviderRegistryOptions = {}): this {
    const provider = this.require(providerId)
    const descriptor = normalizeModelDescriptor(model, providerId)
    const models = [...provider.models.filter((candidate) => candidate.id !== descriptor.id), descriptor]
    const updated = { ...provider, models }
    this.providers.set(providerId, updated)
    this.manifests.set(providerId, manifestInput(providerManifestFromProvider(updated)))
    return this
  }

  removeModel(providerId: string, modelId: string): boolean {
    const provider = this.get(providerId)
    if (!provider) return false
    const models = provider.models.filter((model) => model.id !== modelId)
    if (models.length === provider.models.length) return false
    const updated = { ...provider, models }
    this.providers.set(providerId, updated)
    this.manifests.set(providerId, manifestInput(providerManifestFromProvider(updated)))
    return true
  }

  registerManifest(manifest: ProviderManifest | ProviderManifestInput, options: ProviderRegistryOptions = {}): this {
    const normalized = manifestInput(manifest)
    if (this.manifests.has(normalized.id) && !options.replace) {
      throw new InvalidModelRequestError(`Provider already registered: ${normalized.id}`)
    }
    if (options.replace) this.providers.delete(normalized.id)
    this.manifests.set(normalized.id, normalized)
    return this
  }

  unregister(providerId: string): boolean {
    const removedProvider = this.providers.delete(providerId)
    const removedManifest = this.manifests.delete(providerId)
    return removedProvider || removedManifest
  }

  removeProvider(providerId: string): boolean {
    return this.unregister(providerId)
  }

  has(providerId: string): boolean {
    return this.providers.has(providerId)
  }

  get(providerId: string): ModelProvider | undefined {
    return this.providers.get(providerId)
  }

  getProvider(providerId: string): ModelProvider | undefined {
    return this.get(providerId)
  }

  getManifest(providerId: string): ProviderManifest | undefined {
    return this.manifests.get(providerId)
  }

  require(providerId: string): ModelProvider {
    const provider = this.get(providerId)
    if (!provider) throw new ProviderNotFoundError(providerId)
    return provider
  }

  list(): readonly ModelProvider[] {
    return [...this.providers.values()]
  }

  listProviders(): readonly ModelProvider[] {
    return this.list()
  }

  listManifests(): readonly ProviderManifest[] {
    return [...this.manifests.values()].map((manifest) => ({
      ...manifest,
      models: manifest.models.map((model) => ({ ...model })),
    }))
  }

  models(providerId?: string): readonly ModelDescriptor[] {
    if (providerId !== undefined) {
      const provider = this.get(providerId)
      if (provider) return provider.models.map((model) => ({ ...model }))
      const manifest = this.manifests.get(providerId)
      if (!manifest) throw new ProviderNotFoundError(providerId)
      return manifest.models.map((model) => ({ ...model }))
    }
    return this.listManifests().flatMap((manifest) => manifest.models.map((model) => ({ ...model })))
  }

  getModel(reference: string | ModelReferenceInput, providerId?: string): ModelDescriptor | undefined {
    const normalized = normalizeModelReference(reference, providerId)
    if (!this.providers.has(normalized.providerId) && !this.manifests.has(normalized.providerId)) return undefined
    return this.models(normalized.providerId).find((model) => model.id === normalized.modelId)
  }

  findModel(reference: string | ModelReferenceInput, providerId?: string): ModelDescriptor | undefined {
    return this.getModel(reference, providerId)
  }

  resolve(reference: string | ModelReferenceInput, providerId?: string): ResolvedModel {
    const normalized = normalizeModelReference(reference, providerId)
    const provider = this.require(normalized.providerId)
    return { provider, descriptor: provider.models.find((model) => model.id === normalized.modelId) }
  }

  requireModel(reference: string | ModelReferenceInput, providerId?: string): ModelDescriptor {
    const normalized = normalizeModelReference(reference, providerId)
    if (!this.providers.has(normalized.providerId) && !this.manifests.has(normalized.providerId)) {
      throw new ProviderNotFoundError(normalized.providerId)
    }
    const descriptor = this.getModel(normalized)
    if (!descriptor) throw new ModelNotFoundError(normalized.providerId, normalized.modelId)
    return descriptor
  }

  snapshot(): ProviderRegistrySnapshot {
    return { providers: this.listManifests() }
  }

  toJSON(): JsonObject {
    return {
      providers: this.listManifests().map((manifest) => providerDescriptorJson(manifest, manifest.models)),
    }
  }
}

export const createProviderRegistry = (providers: Iterable<ModelProvider | ModelProviderInput> = []) =>
  new ProviderRegistry(providers)

const providerManifestFromProvider = (provider: ModelProvider): ProviderManifest => providerManifest(provider)

export const providerRegistrySnapshot = (registry: ProviderRegistry) => registry.snapshot()
