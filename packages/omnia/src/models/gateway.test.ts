import { describe, expect, test } from "bun:test"
import {
  BudgetExceededError,
  CapabilityNegotiationError,
  ModelGateway,
  ModelNotFoundError,
  ModelTimeoutError,
  ProviderRegistry,
  capabilityRequestFromRequest,
  createCredentialReference,
  createModelProvider,
  negotiateCapabilities,
  normalizeModelDescriptor,
  normalizeModelEvent,
  normalizeModelRequest,
  serializeModelRequest,
  toProtocolModelEvent,
} from "./index"
import type { ModelDescriptorInput } from "./model"

const descriptor = (overrides: Partial<ModelDescriptorInput> = {}) =>
  normalizeModelDescriptor({
    id: "small",
    providerId: "acme",
    capabilities: { tools: true, reasoning: { efforts: ["low", "high"], maxTokens: 100 } },
    limits: { output: 32 },
    ...overrides,
  })

const provider = (events: readonly unknown[]) =>
  createModelProvider({
    id: "acme",
    endpoint: "https://models.example.test/v1",
    models: [descriptor()],
    stream: (_request, context) => {
      return (async function* () {
        for (const event of events) {
          if (context.signal.aborted) throw new Error("aborted")
          yield event
        }
      })()
    },
  })

const pendingStream = (onReturn: () => void = () => undefined): AsyncIterable<unknown> => {
  const iterator: AsyncIterator<unknown, undefined> & AsyncIterable<unknown> = {
    next: () => new Promise<IteratorResult<unknown, undefined>>(() => undefined),
    return: async () => {
      onReturn()
      return { done: true, value: undefined }
    },
    [Symbol.asyncIterator]() {
      return this
    },
  }
  return iterator
}

describe("model contracts", () => {
  test("adapts stream events to the shared protocol model event contract", () => {
    const event = toProtocolModelEvent(
      { type: "tool-call", callId: "call", name: "lookup", input: { q: "x" } },
      {
        id: "event-1",
        timestamp: 1,
      },
    )

    expect(event).toMatchObject({ id: "event-1", type: "model.tool-call", callId: "call" })
  })

  test("normalizes provider-neutral request aliases into a serializable value", () => {
    const request = normalizeModelRequest({
      model: "acme/small",
      system: "be concise",
      prompt: "hello",
      tools: [{ name: "lookup", parameters: { type: "object" } }],
      maxTokens: 12,
      reasoningEffort: "low",
      metadata: { trace: "one" },
    })

    expect(request.model).toEqual({ providerId: "acme", modelId: "small" })
    expect(request.system).toEqual([{ type: "text", text: "be concise" }])
    expect(request.messages[0]?.content).toEqual([{ type: "text", text: "hello" }])
    expect(request.tools[0]?.inputSchema).toEqual({ type: "object" })
    expect(request.generation?.maxOutputTokens).toBe(12)
    expect(request.reasoning?.effort).toBe("low")
    expect(serializeModelRequest(request)).not.toContain("undefined")
  })

  test("keeps credentials as references and excludes them from persisted manifests", () => {
    const reference = createCredentialReference({ source: "env", id: "ACME_API_KEY", providerId: "acme" })
    const runtimeProvider = createModelProvider({
      id: "acme",
      credential: reference,
      models: [descriptor()],
      stream: () => [],
    })
    const registry = new ProviderRegistry().register(runtimeProvider)
    const persisted = JSON.stringify(registry.snapshot())

    expect(persisted).toContain("ACME_API_KEY")
    expect(persisted).not.toContain("secret")
    expect(registry.toJSON()).not.toHaveProperty("providers.0.stream")
    expect(() => createCredentialReference({ source: "env", id: "key", value: "plaintext" } as never)).toThrow()
  })

  test("resolves credentials only at the provider boundary", async () => {
    let resolved: string | undefined
    const reference = createCredentialReference({ source: "env", id: "ACME_KEY" })
    const runtimeProvider = createModelProvider({
      id: "acme",
      credential: reference,
      models: [descriptor()],
      stream: (_request, context) => {
        resolved = context.resolveCredential() as string | undefined
        return [{ type: "finish", reason: "stop" }]
      },
    })
    const gateway = new ModelGateway(new ProviderRegistry().register(runtimeProvider), {
      credentialResolver: () => "ephemeral-value",
    })
    const response = await gateway.generate({ model: "acme/small", prompt: "hello" })
    expect(resolved).toBe("ephemeral-value")
    expect(JSON.stringify(response)).not.toContain("ephemeral-value")
  })

  test("negotiates tools and reasoning without provider-specific assumptions", () => {
    const request = capabilityRequestFromRequest({
      tools: [descriptor()],
      toolChoice: { type: "tool", name: "lookup" },
      reasoning: { effort: "high", maxTokens: 200 },
    })
    const negotiated = negotiateCapabilities(
      { tools: true, reasoning: { efforts: ["low", "high"], maxTokens: 100 } },
      { tools: true, reasoning: { efforts: ["low", "high"], maxTokens: 100 } },
      request,
    )

    expect(negotiated.tool.enabled).toBe(true)
    expect(negotiated.reasoningRequest.effort).toBe("high")
    expect(negotiated.reasoningRequest.maxTokens).toBe(100)
    expect(() => negotiateCapabilities({ tools: false }, { tools: false }, request, { strict: true })).toThrow(
      CapabilityNegotiationError,
    )
  })
})

describe("provider registry and gateway", () => {
  test("resolves arbitrary providers and normalizes their event union", async () => {
    const registry = new ProviderRegistry().register(
      provider([
        { type: "text_delta", text: "hi" },
        { type: "usage", inputTokens: 2, outputTokens: 1 },
        { type: "done", reason: "stop" },
      ]),
    )
    const gateway = new ModelGateway(registry)
    const response = await gateway.generate({ model: "acme/small", prompt: "hello" })

    expect(response.text).toBe("hi")
    expect(response.finishReason).toBe("stop")
    expect(response.usage?.totalTokens).toBe(3)
    expect(registry.getModel("acme/small")?.id).toBe("small")
  })

  test("supports custom endpoints with models outside a catalog", async () => {
    const custom = createModelProvider({
      id: "custom",
      endpoint: { url: "https://gateway.example.test/models" },
      models: [],
      stream: () => [
        { type: "text-delta", text: "custom" },
        { type: "finish", reason: "stop" },
      ],
    })
    const gateway = new ModelGateway({ providers: [custom] })
    const response = await gateway.generate({ model: "custom", prompt: "hello" })
    expect(response.text).toBe("custom")
  })

  test("rejects missing models and enforces token and tool-call budgets", async () => {
    const registry = new ProviderRegistry().register(
      provider([
        { type: "tool-call", callId: "a", name: "one", input: {} },
        { type: "tool-call", callId: "b", name: "two", input: {} },
        { type: "finish", reason: "tool_calls" },
      ]),
    )
    const gateway = new ModelGateway(registry)
    const request = {
      model: "acme/small",
      prompt: "hello",
      tools: [{ name: "one", inputSchema: { type: "object" } }],
      limits: { maxToolCalls: 1 },
    }

    const stream = gateway.stream(request)
    await expect(stream.next()).resolves.toMatchObject({ done: false })
    await expect(stream.next()).rejects.toBeInstanceOf(BudgetExceededError)
    await expect(gateway.generate({ model: "acme/unknown", prompt: "hello" })).rejects.toBeInstanceOf(
      ModelNotFoundError,
    )
    const tokenRegistry = new ProviderRegistry().register(
      provider([
        { type: "usage", outputTokens: 2 },
        { type: "finish", reason: "stop" },
      ]),
    )
    await expect(
      new ModelGateway(tokenRegistry).generate({ model: "acme/small", prompt: "hello", maxTokens: 1 }),
    ).rejects.toBeInstanceOf(BudgetExceededError)
  })

  test("propagates cancellation to the provider and closes its iterator", async () => {
    let providerSignal: AbortSignal | undefined
    let returned = false
    const pendingProvider = createModelProvider({
      id: "acme",
      models: [descriptor()],
      stream: (_request, context) => {
        providerSignal = context.signal
        return pendingStream(() => {
          returned = true
        })
      },
    })
    const gateway = new ModelGateway(new ProviderRegistry().register(pendingProvider))
    const controller = new AbortController()
    const iterator = gateway.stream({ model: "acme/small", prompt: "hello" }, { signal: controller.signal })
    const pending = iterator.next()
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: "cancelled" })
    expect(providerSignal?.aborted).toBe(true)
    expect(returned).toBe(true)
  })

  test("aborts a pending provider on a time limit", async () => {
    let providerSignal: AbortSignal | undefined
    const slowProvider = createModelProvider({
      id: "acme",
      models: [descriptor()],
      stream: (_request, context) => {
        providerSignal = context.signal
        return pendingStream()
      },
    })
    const gateway = new ModelGateway(new ProviderRegistry().register(slowProvider))
    const iterator = gateway.stream({ model: "acme/small", prompt: "hello", limits: { maxDurationMs: 10 } })
    await expect(iterator.next()).rejects.toBeInstanceOf(ModelTimeoutError)
    expect(providerSignal?.aborted).toBe(true)
  })
})

test("normalizes unknown provider events without leaking transport shapes", () => {
  expect(normalizeModelEvent({ type: "custom", value: 1 })).toEqual({
    type: "provider-event",
    data: { type: "custom", value: 1 },
  })
})
