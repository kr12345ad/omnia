import {
  applyCapabilityNegotiation,
  normalizeModelRequest,
  type ModelRequestInput,
  type NormalizedModelRequest,
} from "./request"
import { negotiateCapabilities } from "./capabilities"
import { noCredentialResolver, type CredentialReference, type CredentialResolver } from "./credentials"
import {
  ModelCancelledError,
  ModelGatewayError,
  ModelNotFoundError,
  ModelProtocolError,
  ModelProviderError,
  ModelTimeoutError,
} from "./errors"
import {
  isModelEvent,
  normalizeModelEvent,
  type ModelEvent,
  type ModelFinishReason,
  type ModelToolCallEvent,
} from "./events"
import { isJsonValue, isRecord, type JsonValue } from "./json"
import { mergeBudgets, BudgetTracker, type ModelBudget, type ModelBudgetInput, type TokenUsage } from "./limits"
import { normalizeModelReference, type ModelDescriptor } from "./model"
import { ProviderRegistry } from "./registry"
import type { ModelProvider, ModelProviderInput, ProviderRequestContext, ProviderStream } from "./provider"

export interface ModelGatewayOptions {
  readonly registry?: ProviderRegistry
  readonly providers?: Iterable<ModelProvider | ModelProviderInput>
  readonly defaultProviderId?: string
  readonly defaultBudget?: ModelBudgetInput
  readonly signal?: AbortSignal
  readonly credentialResolver?: CredentialResolver
  readonly now?: () => number
  readonly allowUnknownModels?: boolean
  readonly synthesizeFinish?: boolean
}

export interface GatewayCallOptions {
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
  readonly limits?: ModelBudgetInput
  readonly providerId?: string
  readonly requestId?: string
}

export interface PreparedModelRequest {
  readonly provider: ModelProvider
  readonly descriptor?: ModelDescriptor
  readonly request: NormalizedModelRequest
  readonly budget: ModelBudget
  readonly credential?: CredentialReference
}

export interface ModelGatewayResponse {
  readonly requestId: string
  readonly providerId: string
  readonly modelId: string
  readonly events: readonly ModelEvent[]
  readonly text: string
  readonly output?: JsonValue
  readonly reasoning: string
  readonly toolCalls: readonly ModelToolCallEvent[]
  readonly usage?: TokenUsage
  readonly finishReason: ModelFinishReason
}

interface Runtime {
  readonly controller: AbortController
  readonly timedOut: () => boolean
  readonly cleanup: () => void
}

const linkAbort = (sources: ReadonlyArray<AbortSignal | undefined>, timeoutMs: number | undefined): Runtime => {
  const controller = new AbortController()
  const activeSources = sources.filter((source): source is AbortSignal => source !== undefined)
  let timedOut = false
  const abort = () => {
    const source = activeSources.find((candidate) => candidate.aborted)
    controller.abort(source?.reason)
  }
  if (activeSources.some((source) => source.aborted)) abort()
  else activeSources.forEach((source) => source.addEventListener("abort", abort, { once: true }))
  const timer =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true
          controller.abort(new ModelTimeoutError(timeoutMs))
        }, timeoutMs)
  return {
    controller,
    timedOut: () => timedOut,
    cleanup: () => {
      if (timer !== undefined) clearTimeout(timer)
      activeSources.forEach((source) => source.removeEventListener("abort", abort))
    },
  }
}

const raceAbort = <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> => {
  if (signal.aborted) return Promise.reject(signal.reason ?? new ModelCancelledError())
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      cleanup()
      reject(signal.reason ?? new ModelCancelledError())
    }
    const cleanup = () => signal.removeEventListener("abort", abort)
    signal.addEventListener("abort", abort, { once: true })
    promise.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error: unknown) => {
        cleanup()
        reject(error)
      },
    )
  })
}

const isAsyncIterable = (value: ProviderStream): value is AsyncIterable<unknown> =>
  Symbol.asyncIterator in value && typeof value[Symbol.asyncIterator] === "function"

const isPromiseLike = (value: ProviderStream | Promise<ProviderStream>): value is Promise<ProviderStream> => {
  if (typeof value !== "object" || value === null) return false
  return "then" in value && typeof value.then === "function"
}

const toAsyncIterator = (stream: ProviderStream): AsyncIterator<unknown> => {
  if (isAsyncIterable(stream)) return stream[Symbol.asyncIterator]()
  const iterator = stream[Symbol.iterator]()
  const returnMethod = iterator.return
  return {
    next: async () => iterator.next(),
    return: returnMethod === undefined ? undefined : async () => returnMethod.call(iterator),
  }
}

const closeIterator = async (iterator: AsyncIterator<unknown>) => {
  if (iterator.return) await iterator.return()
}

const requestIdFor = (request: NormalizedModelRequest, providerId: string) =>
  request.id ?? `${providerId}:${request.model.modelId}`

const providerIdFor = (
  registry: ProviderRegistry,
  input: ModelRequestInput,
  options: ModelGatewayOptions,
  callOptions: GatewayCallOptions,
) => {
  if (callOptions.providerId !== undefined) return callOptions.providerId
  if (options.defaultProviderId !== undefined) return options.defaultProviderId
  if (input.providerId !== undefined) return input.providerId
  if (input.providerID !== undefined) return input.providerID
  if (typeof input.model === "string" && !input.model.includes("/") && registry.list().length === 1)
    return registry.list()[0]?.id
  return undefined
}

const effectiveCredential = (
  request: NormalizedModelRequest,
  descriptor: ModelDescriptor | undefined,
  provider: ModelProvider,
) => request.credential ?? descriptor?.credential ?? provider.credential

const contextFor = (
  request: NormalizedModelRequest,
  signal: AbortSignal,
  requestId: string,
  credential: CredentialReference | undefined,
  resolver: CredentialResolver,
  now: () => number,
): ProviderRequestContext => {
  const resolveCredential = (reference?: CredentialReference) => {
    const target = reference ?? credential
    return target === undefined ? undefined : resolver(target)
  }
  return {
    request,
    signal,
    requestId,
    ...(credential === undefined ? {} : { credentialReference: credential }),
    credential: resolveCredential,
    resolveCredential,
    metadata: request.metadata ?? {},
    now,
  }
}

const usageFromEvent = (event: ModelEvent): TokenUsage | undefined => {
  if (event.type === "usage") return event.usage
  if (event.type === "finish") return event.usage
  return undefined
}

const toolCallLimit = (event: ModelEvent, tracker: BudgetTracker) => {
  if (event.type === "tool-call") tracker.recordToolCall()
}

const timeoutFor = (budget: ModelBudget, now: () => number) => {
  const duration = budget.maxDurationMs
  const deadline = budget.deadline === undefined ? undefined : Math.max(0, budget.deadline - now())
  if (duration === undefined) return deadline
  if (deadline === undefined) return duration
  return Math.min(duration, deadline)
}

const callLimitsFor = (options: GatewayCallOptions): ModelBudgetInput | undefined =>
  options.limits === undefined && options.timeoutMs === undefined
    ? undefined
    : {
        ...(options.limits ?? {}),
        ...(options.timeoutMs === undefined ? {} : { maxDurationMs: options.timeoutMs }),
      }

const budgetFor = (
  request: NormalizedModelRequest,
  descriptor: ModelDescriptor | undefined,
  defaults: ModelBudgetInput | undefined,
  callLimits: ModelBudgetInput | undefined,
) => {
  const modelLimits =
    descriptor === undefined
      ? {}
      : {
          ...(descriptor.limits.input !== undefined && descriptor.limits.input > 0
            ? { maxInputTokens: descriptor.limits.input }
            : {}),
          ...(descriptor.limits.output !== undefined && descriptor.limits.output > 0
            ? { maxOutputTokens: descriptor.limits.output }
            : {}),
          ...(descriptor.limits.context !== undefined && descriptor.limits.context > 0
            ? { maxTotalTokens: descriptor.limits.context }
            : {}),
        }
  const generationLimit =
    request.generation?.maxOutputTokens === undefined ? {} : { maxOutputTokens: request.generation.maxOutputTokens }
  return mergeBudgets(defaults, modelLimits, generationLimit, request.limits, callLimits)
}

const serializeNativeRequest = (value: unknown): void => {
  if (!isJsonValue(value)) throw new ModelProtocolError("Provider request must be JSON serializable")
}

const protocolFor = (provider: ModelProvider) => (typeof provider.protocol === "object" ? provider.protocol : undefined)

const normalizeFailure = (error: unknown, runtime: Runtime, tracker: BudgetTracker): never => {
  if (error instanceof ModelGatewayError) throw error
  if (runtime.controller.signal.aborted) {
    if (runtime.timedOut()) throw new ModelTimeoutError(tracker.elapsedMs)
    throw new ModelCancelledError()
  }
  if (isJsonValue(error)) throw new ModelProviderError(JSON.stringify(error) ?? "Provider request failed")
  throw new ModelProviderError(error instanceof Error ? error.message : "Provider request failed")
}

export class ModelGateway {
  readonly registry: ProviderRegistry
  private readonly options: ModelGatewayOptions

  constructor(registryOrOptions: ProviderRegistry | ModelGatewayOptions = {}, options: ModelGatewayOptions = {}) {
    if (registryOrOptions instanceof ProviderRegistry) {
      this.registry = registryOrOptions
      this.options = options
      return
    }
    this.registry = registryOrOptions.registry ?? new ProviderRegistry(registryOrOptions.providers)
    this.options = registryOrOptions
  }

  prepare(input: ModelRequestInput, callOptions: GatewayCallOptions = {}): PreparedModelRequest {
    const providerId = providerIdFor(this.registry, input, this.options, callOptions)
    const request = normalizeModelRequest(input, { ...(providerId === undefined ? {} : { providerId }) })
    const reference = normalizeModelReference(request.model, providerId)
    const provider = this.registry.require(reference.providerId)
    const descriptor = provider.models.find((model) => model.id === reference.modelId)
    const allowUnknownModels = this.options.allowUnknownModels ?? provider.models.length === 0
    if (!descriptor && !allowUnknownModels) {
      throw new ModelNotFoundError(reference.providerId, reference.modelId)
    }
    const negotiation = negotiateCapabilities(provider.capabilities, descriptor?.capabilities, request.capabilities, {
      strict: true,
    })
    const normalized = applyCapabilityNegotiation(request, negotiation)
    return {
      provider,
      ...(descriptor === undefined ? {} : { descriptor }),
      request: normalized,
      budget: budgetFor(normalized, descriptor, this.options.defaultBudget, callLimitsFor(callOptions)),
      ...(effectiveCredential(normalized, descriptor, provider) === undefined
        ? {}
        : { credential: effectiveCredential(normalized, descriptor, provider) }),
    }
  }

  async *stream(
    input: ModelRequestInput,
    callOptions: GatewayCallOptions = {},
  ): AsyncGenerator<ModelEvent, void, undefined> {
    const providerId = providerIdFor(this.registry, input, this.options, callOptions)
    const request = normalizeModelRequest(input, { ...(providerId === undefined ? {} : { providerId }) })
    const reference = normalizeModelReference(request.model, providerId)
    const provider = this.registry.require(reference.providerId)
    const descriptor = provider.models.find((model) => model.id === reference.modelId)
    const allowUnknownModels = this.options.allowUnknownModels ?? provider.models.length === 0
    if (!descriptor && !allowUnknownModels) {
      throw new ModelNotFoundError(reference.providerId, reference.modelId)
    }
    const negotiation = negotiateCapabilities(provider.capabilities, descriptor?.capabilities, request.capabilities, {
      strict: true,
    })
    const normalized = applyCapabilityNegotiation(request, negotiation)
    const budget = budgetFor(normalized, descriptor, this.options.defaultBudget, callLimitsFor(callOptions))
    const now = this.options.now ?? Date.now
    const tracker = new BudgetTracker(budget, now)
    if (normalized.estimatedInputTokens !== undefined) tracker.recordInputTokens(normalized.estimatedInputTokens)
    const runtime = linkAbort([this.options.signal, input.signal, callOptions.signal], timeoutFor(budget, now))
    const resolver = this.options.credentialResolver ?? provider.credentialResolver ?? noCredentialResolver
    const credential = effectiveCredential(normalized, descriptor, provider)
    const requestId = callOptions.requestId ?? requestIdFor(normalized, provider.id)
    const context = contextFor(normalized, runtime.controller.signal, requestId, credential, resolver, now)
    const protocol = protocolFor(provider)
    const encode = provider.normalizeRequest ?? protocol?.encodeRequest
    let iterator: AsyncIterator<unknown> | undefined
    try {
      tracker.checkTime()
      if (runtime.controller.signal.aborted) throw new ModelCancelledError()
      let nativeRequest: unknown
      try {
        nativeRequest =
          encode === undefined
            ? normalized
            : await raceAbort(Promise.resolve(encode(normalized, context)), runtime.controller.signal)
        serializeNativeRequest(nativeRequest)
      } catch (error) {
        if (runtime.controller.signal.aborted) throw error
        if (error instanceof ModelGatewayError) throw error
        throw new ModelProtocolError("Provider request normalization failed", { phase: "request" })
      }
      const provided = provider.stream(nativeRequest as JsonValue, context)
      const providerStream = isPromiseLike(provided)
        ? await (() => {
            const pending = Promise.resolve(provided)
            void pending
              .then((stream) => {
                if (runtime.controller.signal.aborted) void closeIterator(toAsyncIterator(stream))
              })
              .catch(() => undefined)
            return raceAbort(pending, runtime.controller.signal)
          })()
        : provided
      iterator = toAsyncIterator(providerStream)
      let finished = false
      while (true) {
        tracker.checkTime()
        if (runtime.controller.signal.aborted) {
          throw runtime.timedOut()
            ? new ModelTimeoutError(timeoutFor(budget, now) ?? tracker.elapsedMs)
            : new ModelCancelledError()
        }
        const next = await raceAbort(Promise.resolve(iterator.next()), runtime.controller.signal)
        if (next.done) break
        let event: ModelEvent
        try {
          event =
            protocol?.decodeEvent === undefined
              ? normalizeModelEvent(next.value)
              : normalizeModelEvent(
                  await raceAbort(Promise.resolve(protocol.decodeEvent(next.value)), runtime.controller.signal),
                )
        } catch (error) {
          if (runtime.controller.signal.aborted) throw error
          if (error instanceof ModelGatewayError) throw error
          throw new ModelProtocolError("Provider stream event normalization failed", { phase: "stream" })
        }
        if (!isModelEvent(event)) throw new ModelProtocolError("Provider stream returned an invalid event")
        toolCallLimit(event, tracker)
        const usage = usageFromEvent(event)
        if (usage) tracker.recordUsage(usage)
        yield event
        if (event.type === "finish" || event.type === "error" || event.type === "cancelled") {
          finished = true
          break
        }
      }
      if (!finished && this.options.synthesizeFinish === true) {
        yield { type: "finish", reason: "unknown" }
      }
    } catch (error) {
      if (error instanceof ModelGatewayError && !runtime.controller.signal.aborted) runtime.controller.abort(error)
      normalizeFailure(error, runtime, tracker)
    } finally {
      if (iterator) await closeIterator(iterator).catch(() => undefined)
      runtime.cleanup()
    }
  }

  async generate(input: ModelRequestInput, callOptions: GatewayCallOptions = {}): Promise<ModelGatewayResponse> {
    const events: ModelEvent[] = []
    for await (const event of this.stream(input, callOptions)) events.push(event)
    const streamedText = events
      .filter((event) => event.type === "text-delta")
      .map((event) => event.text)
      .join("")
    const finishEvent = [...events].reverse().find((event) => event.type === "finish")
    const outputObject =
      finishEvent?.output !== undefined && isRecord(finishEvent.output) ? finishEvent.output : undefined
    const outputText =
      typeof finishEvent?.output === "string"
        ? finishEvent.output
        : typeof outputObject?.text === "string"
          ? outputObject.text
          : ""
    const text = streamedText.length > 0 ? streamedText : outputText
    const reasoning = events
      .filter((event) => event.type === "reasoning-delta")
      .map((event) => event.text)
      .join("")
    const toolCalls = events.filter((event): event is ModelToolCallEvent => event.type === "tool-call")
    const usageEvent = [...events]
      .reverse()
      .find((event) => event.type === "usage" || (event.type === "finish" && event.usage !== undefined))
    const rawUsage = usageEvent?.type === "finish" || usageEvent?.type === "usage" ? usageEvent.usage : undefined
    const usage =
      rawUsage === undefined
        ? undefined
        : {
            ...rawUsage,
            totalTokens:
              rawUsage.totalTokens ??
              (rawUsage.inputTokens ?? rawUsage.promptTokens ?? 0) +
                (rawUsage.outputTokens ?? rawUsage.completionTokens ?? 0),
          }
    const errorEvent = [...events].reverse().find((event) => event.type === "error")
    const cancelledEvent = [...events].reverse().find((event) => event.type === "cancelled")
    const finishReason = finishEvent?.reason ?? (errorEvent ? "error" : cancelledEvent ? "cancelled" : "unknown")
    const providerId = providerIdFor(this.registry, input, this.options, callOptions)
    const request = normalizeModelRequest(input, { ...(providerId === undefined ? {} : { providerId }) })
    return {
      requestId: callOptions.requestId ?? requestIdFor(request, request.model.providerId),
      providerId: request.model.providerId,
      modelId: request.model.modelId,
      events,
      text,
      ...(finishEvent?.output === undefined ? {} : { output: finishEvent.output }),
      reasoning,
      toolCalls,
      ...(usage === undefined ? {} : { usage }),
      finishReason,
    }
  }

  complete(input: ModelRequestInput, callOptions: GatewayCallOptions = {}) {
    return this.generate(input, callOptions)
  }

  execute(input: ModelRequestInput, callOptions: GatewayCallOptions = {}) {
    return this.generate(input, callOptions)
  }

  request(input: ModelRequestInput, callOptions: GatewayCallOptions = {}) {
    return this.generate(input, callOptions)
  }
}

export function createModelGateway(
  registry?: ProviderRegistry,
  options?: Omit<ModelGatewayOptions, "registry">,
): ModelGateway
export function createModelGateway(options?: ModelGatewayOptions): ModelGateway
export function createModelGateway(
  registryOrOptions: ProviderRegistry | ModelGatewayOptions = {},
  options: Omit<ModelGatewayOptions, "registry"> = {},
): ModelGateway {
  return registryOrOptions instanceof ProviderRegistry
    ? new ModelGateway(registryOrOptions, options)
    : new ModelGateway(registryOrOptions)
}

export const Gateway = ModelGateway
export type Gateway = ModelGateway
export const createGateway = createModelGateway

export const modelGatewayError = (error: unknown): ModelGatewayError => {
  if (error instanceof ModelGatewayError) return error
  return new ModelProviderError(error instanceof Error ? error.message : "Model gateway failed")
}
