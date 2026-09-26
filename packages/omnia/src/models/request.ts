import {
  capabilityRequestFromRequest,
  negotiateCapabilities,
  type CapabilityDeclaration,
  type CapabilityRequest,
  type NegotiatedCapabilities,
  type ReasoningEffort,
  type ToolChoice,
  type ToolChoiceInput,
} from "./capabilities"
import { assertCredentialReference, assertNoPlaintextSecrets, type CredentialReference } from "./credentials"
import { InvalidModelRequestError } from "./errors"
import { assertJsonValue, compact, isJsonValue, isRecord, serialize, type JsonObject, type JsonValue } from "./json"
import { mergeBudgets, normalizeBudget, type ModelBudget, type ModelBudgetInput } from "./limits"
import { normalizeModelReference, type ModelReference, type ModelReferenceInput } from "./model"

export interface TextPart {
  readonly type: "text"
  readonly text: string
  readonly metadata?: JsonObject
}

export interface MediaPart {
  readonly type: "media"
  readonly mediaType: string
  readonly data: string
  readonly filename?: string
  readonly metadata?: JsonObject
}

export interface ReasoningPart {
  readonly type: "reasoning"
  readonly text: string
  readonly encrypted?: string
  readonly metadata?: JsonObject
}

export interface ToolCallPart {
  readonly type: "tool-call"
  readonly id: string
  readonly name: string
  readonly input: JsonValue
  readonly providerExecuted?: boolean
  readonly metadata?: JsonObject
}

export interface ToolResultPart {
  readonly type: "tool-result"
  readonly id: string
  readonly name: string
  readonly output: JsonValue
  readonly providerExecuted?: boolean
  readonly metadata?: JsonObject
}

export interface ProviderContentPart {
  readonly type: "provider"
  readonly data: JsonValue
  readonly metadata?: JsonObject
}

export type ModelContentPart =
  | TextPart
  | MediaPart
  | ReasoningPart
  | ToolCallPart
  | ToolResultPart
  | ProviderContentPart

export type ModelRole = "system" | "user" | "assistant" | "tool" | (string & {})

export interface ModelMessage {
  readonly id?: string
  readonly role: ModelRole
  readonly content: readonly ModelContentPart[]
  readonly name?: string
  readonly metadata?: JsonObject
}

export type ModelContentInput = string | ModelContentPart | readonly ModelContentPart[]

export interface ModelMessageInput {
  readonly id?: string
  readonly role: ModelRole | "function"
  readonly content: ModelContentInput
  readonly name?: string
  readonly toolCallId?: string
  readonly metadata?: JsonObject
}

export type ModelMessageContentInput = string | ModelContentInput

export interface ToolDefinition {
  readonly name: string
  readonly description?: string
  readonly inputSchema: JsonValue
  readonly outputSchema?: JsonValue
  readonly metadata?: JsonObject
}

export interface ToolDefinitionInput {
  readonly name?: string
  readonly description?: string
  readonly inputSchema?: JsonValue
  readonly parameters?: JsonValue
  readonly schema?: JsonValue
  readonly outputSchema?: JsonValue
  readonly responseSchema?: JsonValue
  readonly metadata?: JsonObject
}

export interface GenerationOptions {
  readonly maxOutputTokens?: number
  readonly temperature?: number
  readonly topP?: number
  readonly topK?: number
  readonly frequencyPenalty?: number
  readonly presencePenalty?: number
  readonly seed?: number
  readonly stop?: readonly string[]
}

export interface GenerationOptionsInput extends Partial<GenerationOptions> {
  readonly maxTokens?: number
}

export interface ReasoningOptions {
  readonly enabled: boolean
  readonly effort?: ReasoningEffort
  readonly maxTokens?: number
}

export interface ReasoningOptionsInput {
  readonly enabled?: boolean
  readonly effort?: ReasoningEffort
  readonly reasoningEffort?: ReasoningEffort
  readonly maxTokens?: number
  readonly budget?: number
  readonly maxOutputTokens?: number
}

export type ToolCollection = readonly ToolDefinitionInput[] | Readonly<Record<string, ToolDefinitionInput>>

export interface ModelRequest {
  readonly id?: string
  readonly model: ModelReference
  readonly system: readonly TextPart[]
  readonly messages: readonly ModelMessage[]
  readonly tools: readonly ToolDefinition[]
  readonly toolChoice?: ToolChoice
  readonly generation?: GenerationOptions
  readonly reasoning?: ReasoningOptions
  readonly capabilities: CapabilityRequest
  readonly limits: ModelBudget
  readonly credential?: CredentialReference
  readonly metadata?: JsonObject
  readonly providerOptions?: JsonObject
  readonly responseFormat?: JsonValue
  readonly estimatedInputTokens?: number
}

export type NormalizedModelRequest = ModelRequest & JsonObject

export interface ModelRequestInput {
  readonly id?: string
  readonly signal?: AbortSignal
  readonly model: string | ModelReferenceInput
  readonly providerId?: string
  readonly providerID?: string
  readonly system?: string | readonly (TextPart | string)[]
  readonly messages?: readonly (string | ModelMessageInput)[]
  readonly prompt?: string | readonly (string | ModelMessageInput)[]
  readonly tools?: ToolCollection
  readonly toolChoice?: ToolChoiceInput | "any" | "function"
  readonly generation?: GenerationOptionsInput
  readonly maxTokens?: number
  readonly maxOutputTokens?: number
  readonly temperature?: number
  readonly topP?: number
  readonly topK?: number
  readonly frequencyPenalty?: number
  readonly presencePenalty?: number
  readonly seed?: number
  readonly stop?: readonly string[]
  readonly reasoning?: boolean | ReasoningOptionsInput
  readonly reasoningEffort?: ReasoningEffort
  readonly reasoningBudget?: number
  readonly capabilities?: CapabilityRequest
  readonly limits?: ModelBudgetInput
  readonly budget?: ModelBudgetInput
  readonly maxInputTokens?: number
  readonly maxTotalTokens?: number
  readonly maxDurationMs?: number
  readonly timeoutMs?: number
  readonly deadline?: number
  readonly maxToolCalls?: number
  readonly maxCostUsd?: number
  readonly maxCost?: number
  readonly credential?: CredentialReference
  readonly metadata?: JsonObject
  readonly providerOptions?: JsonObject
  readonly options?: JsonObject
  readonly responseFormat?: JsonValue
  readonly response_format?: JsonValue
  readonly estimatedInputTokens?: number
  readonly inputTokens?: number
}

export type ModelInput = ModelRequestInput
export type Request = ModelRequest

export interface NormalizeRequestOptions {
  readonly providerId?: string
  readonly capabilities?: CapabilityRequest
  readonly providerCapabilities?: CapabilityDeclaration
  readonly modelCapabilities?: CapabilityDeclaration
  readonly strictCapabilities?: boolean
  readonly defaultBudget?: ModelBudgetInput
}

const sensitiveConfigKey =
  /^(?:api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|client[-_]?secret|password|private[-_]?key|secret|token|value)$/i

const assertSafeConfig = (value: JsonObject | undefined, field: string) => {
  if (value === undefined) return
  const visit = (item: JsonValue, path: string) => {
    if (Array.isArray(item)) {
      item.forEach((child, index) => visit(child, `${path}[${index}]`))
      return
    }
    if (!isRecord(item)) return
    Object.entries(item).forEach(([key, child]) => {
      if (sensitiveConfigKey.test(key))
        throw new InvalidModelRequestError(`${field} cannot contain plaintext credential fields`)
      visit(child, `${path}.${key}`)
    })
  }
  visit(value, field)
}

const requiredString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.length === 0)
    throw new InvalidModelRequestError(`${field} must be a non-empty string`)
  return value
}

const parseInput = (value: unknown): JsonValue => {
  if (typeof value !== "string") return isJsonValue(value) ? value : {}
  try {
    const parsed: unknown = JSON.parse(value) as unknown
    return isJsonValue(parsed) ? parsed : value
  } catch {
    return value
  }
}

const normalizeMetadata = (value: JsonObject | undefined, field: string): JsonObject | undefined => {
  if (value === undefined) return undefined
  assertJsonValue(value, field)
  return value
}

const normalizeTextPart = (value: unknown, field: string): TextPart => {
  if (typeof value === "string") return { type: "text", text: value }
  if (!isRecord(value) || value.type !== "text" || typeof value.text !== "string") {
    throw new InvalidModelRequestError(`${field} must be text content`)
  }
  const metadata = normalizeMetadata(
    isJsonValue(value.metadata) && isRecord(value.metadata) ? (value.metadata as JsonObject) : undefined,
    `${field}.metadata`,
  )
  return {
    type: "text",
    text: value.text,
    ...(metadata === undefined ? {} : { metadata }),
  }
}

const normalizeContentPart = (value: unknown, field: string): ModelContentPart => {
  if (typeof value === "string") return { type: "text", text: value }
  if (!isRecord(value)) throw new InvalidModelRequestError(`${field} must be content`)
  const type = typeof value.type === "string" ? value.type.replaceAll("_", "-").toLowerCase() : ""
  const metadata = normalizeMetadata(
    isJsonValue(value.metadata) && isRecord(value.metadata) ? (value.metadata as JsonObject) : undefined,
    `${field}.metadata`,
  )
  if (type === "text" || type === "input-text" || type === "output-text") {
    return {
      type: "text",
      text: requiredString(value.text ?? value.content, `${field}.text`),
      ...(metadata === undefined ? {} : { metadata }),
    }
  }
  if (type === "reasoning" || type === "thinking") {
    return {
      type: "reasoning",
      text: requiredString(value.text ?? value.reasoning ?? value.content, `${field}.text`),
      ...(value.encrypted === undefined ? {} : { encrypted: requiredString(value.encrypted, `${field}.encrypted`) }),
      ...(metadata === undefined ? {} : { metadata }),
    }
  }
  if (type === "media" || type === "image" || type === "audio" || type === "file") {
    const mediaType = value.mediaType ?? value.mimeType ?? value.mime
    return {
      type: "media",
      mediaType: requiredString(mediaType, `${field}.mediaType`),
      data: requiredString(value.data ?? value.url ?? value.base64, `${field}.data`),
      ...(value.filename === undefined ? {} : { filename: requiredString(value.filename, `${field}.filename`) }),
      ...(metadata === undefined ? {} : { metadata }),
    }
  }
  if (type === "tool-call" || type === "toolcall" || type === "function-call") {
    return {
      type: "tool-call",
      id: requiredString(value.id ?? value.callId ?? value.toolCallId, `${field}.id`),
      name: requiredString(
        value.name ?? value.toolName ?? (isRecord(value.function) ? value.function.name : undefined),
        `${field}.name`,
      ),
      input: parseInput(
        value.input ??
          value.arguments ??
          value.args ??
          (isRecord(value.function) ? value.function.arguments : undefined),
      ),
      ...(value.providerExecuted === undefined ? {} : { providerExecuted: value.providerExecuted === true }),
      ...(metadata === undefined ? {} : { metadata }),
    }
  }
  if (type === "tool-result" || type === "toolresult" || type === "function-result") {
    return {
      type: "tool-result",
      id: requiredString(value.id ?? value.callId ?? value.toolCallId, `${field}.id`),
      name: requiredString(value.name ?? value.toolName, `${field}.name`),
      output: parseInput(value.output ?? value.result ?? value.content),
      ...(value.providerExecuted === undefined ? {} : { providerExecuted: value.providerExecuted === true }),
      ...(metadata === undefined ? {} : { metadata }),
    }
  }
  if (type === "provider") {
    const data = parseInput(value.data)
    assertNoPlaintextSecrets(data, `${field}.data`)
    return { type: "provider", data, ...(metadata === undefined ? {} : { metadata }) }
  }
  if (isJsonValue(value)) {
    assertNoPlaintextSecrets(value, `${field}.data`)
    return { type: "provider", data: value, ...(metadata === undefined ? {} : { metadata }) }
  }
  throw new InvalidModelRequestError(`${field} has unsupported content type`)
}

const normalizeSystem = (input: ModelRequestInput["system"]): readonly TextPart[] => {
  if (input === undefined) return []
  if (typeof input === "string") return [{ type: "text", text: input }]
  return input.map((part, index) => normalizeTextPart(part, `system[${index}]`))
}

const normalizeMessages = (
  input: ModelRequestInput["messages"],
  prompt: ModelRequestInput["prompt"],
): readonly ModelMessage[] => {
  const values = input ?? prompt ?? []
  const entries = typeof values === "string" ? [values] : values
  return entries.map((entry, index) => {
    if (typeof entry === "string") return { role: "user", content: [{ type: "text", text: entry }] }
    if (!isRecord(entry)) throw new InvalidModelRequestError(`messages[${index}] must be an object`)
    const role = entry.role === "function" ? "tool" : entry.role
    if (typeof role !== "string" || role.length === 0) {
      throw new InvalidModelRequestError(`messages[${index}].role is invalid`)
    }
    const normalizedRole = role as ModelRole
    const content = Array.isArray(entry.content) ? entry.content : [entry.content]
    const normalized = content.map((part, partIndex) =>
      normalizeContentPart(part, `messages[${index}].content[${partIndex}]`),
    )
    const metadata = normalizeMetadata(
      isJsonValue(entry.metadata) && isRecord(entry.metadata) ? (entry.metadata as JsonObject) : undefined,
      `messages[${index}].metadata`,
    )
    return {
      ...(entry.id === undefined ? {} : { id: requiredString(entry.id, `messages[${index}].id`) }),
      role: normalizedRole,
      content: normalized,
      ...(entry.name === undefined ? {} : { name: requiredString(entry.name, `messages[${index}].name`) }),
      ...(metadata === undefined ? {} : { metadata }),
    }
  })
}

const normalizeTools = (input: ToolCollection | undefined): readonly ToolDefinition[] => {
  const tools =
    input === undefined
      ? []
      : Array.isArray(input)
        ? input
        : Object.entries(input).map(([name, tool]) => ({ ...tool, name: tool.name ?? name }))
  return tools.map((tool, index) => {
    const schema = tool.inputSchema ?? tool.parameters ?? tool.schema ?? { type: "object" }
    if (!isJsonValue(schema)) throw new InvalidModelRequestError(`tools[${index}] schema must be JSON serializable`)
    const outputSchema = tool.outputSchema ?? tool.responseSchema
    if (outputSchema !== undefined && !isJsonValue(outputSchema))
      throw new InvalidModelRequestError(`tools[${index}].outputSchema must be JSON serializable`)
    if (tool.metadata !== undefined) {
      assertJsonValue(tool.metadata, `tools[${index}].metadata`)
      assertSafeConfig(tool.metadata, `tools[${index}].metadata`)
    }
    return {
      name: requiredString(tool.name, `tools[${index}].name`),
      ...(tool.description === undefined
        ? {}
        : { description: requiredString(tool.description, `tools[${index}].description`) }),
      inputSchema: schema,
      ...(outputSchema === undefined ? {} : { outputSchema }),
      ...(tool.metadata === undefined ? {} : { metadata: tool.metadata }),
    }
  })
}

const normalizeChoice = (input: ModelRequestInput["toolChoice"]): ToolChoice | undefined => {
  if (input === undefined) return undefined
  if (input === "any" || input === "required") return "required"
  if (input === "auto" || input === "none") return input
  if (input === "function") throw new InvalidModelRequestError("Named tool choice requires an object with a tool name")
  if (!isRecord(input)) throw new InvalidModelRequestError("toolChoice must be a string or object")
  if (input.type === "function" && isRecord(input.function)) {
    return { type: "tool", name: requiredString(input.function.name, "toolChoice.function.name") }
  }
  if (input.type !== "tool" && input.type !== "named")
    throw new InvalidModelRequestError("toolChoice.type must be tool or named")
  return { type: "tool", name: requiredString(input.name, "toolChoice.name") }
}

const normalizeGeneration = (input: ModelRequestInput): GenerationOptions | undefined => {
  const generation = input.generation ?? {}
  const values = {
    maxOutputTokens: generation.maxOutputTokens ?? generation.maxTokens ?? input.maxOutputTokens ?? input.maxTokens,
    temperature: generation.temperature ?? input.temperature,
    topP: generation.topP ?? input.topP,
    topK: generation.topK ?? input.topK,
    frequencyPenalty: generation.frequencyPenalty ?? input.frequencyPenalty,
    presencePenalty: generation.presencePenalty ?? input.presencePenalty,
    seed: generation.seed ?? input.seed,
    stop: generation.stop ?? input.stop,
  }
  Object.entries(values).forEach(([key, value]) => {
    if (key === "stop") {
      if (value !== undefined && (!Array.isArray(value) || value.some((item) => typeof item !== "string"))) {
        throw new InvalidModelRequestError("stop must be an array of strings")
      }
      return
    }
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
      throw new InvalidModelRequestError(`${key} must be a finite number`)
    }
  })
  if (
    values.maxOutputTokens !== undefined &&
    (!Number.isSafeInteger(values.maxOutputTokens) || values.maxOutputTokens < 0)
  ) {
    throw new InvalidModelRequestError("maxOutputTokens must be a non-negative safe integer")
  }
  const result = compact(values)
  return Object.keys(result).length === 0 ? undefined : (result as GenerationOptions)
}

const normalizeReasoning = (input: ModelRequestInput): ReasoningOptions | undefined => {
  if (input.reasoning === undefined && input.reasoningEffort === undefined && input.reasoningBudget === undefined)
    return undefined
  const value = typeof input.reasoning === "boolean" ? { enabled: input.reasoning } : (input.reasoning ?? {})
  const effort = value.effort ?? value.reasoningEffort ?? input.reasoningEffort
  const maxTokens = value.maxTokens ?? value.budget ?? value.maxOutputTokens ?? input.reasoningBudget
  if (effort !== undefined && !["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(effort)) {
    throw new InvalidModelRequestError("reasoning effort is invalid")
  }
  if (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || maxTokens < 0)) {
    throw new InvalidModelRequestError("reasoning maxTokens must be a non-negative safe integer")
  }
  return {
    enabled: value.enabled ?? (effort !== undefined || maxTokens !== undefined),
    ...(effort === undefined ? {} : { effort }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
  }
}

const normalizeCapabilities = (
  input: ModelRequestInput,
  override: CapabilityRequest | undefined,
): CapabilityRequest => {
  const derived = capabilityRequestFromRequest({
    tools:
      input.tools === undefined ? undefined : Array.isArray(input.tools) ? input.tools : Object.values(input.tools),
    toolChoice: normalizeChoice(input.toolChoice),
    reasoning: normalizeReasoning(input),
  })
  const tools = override?.tools ?? derived.tools
  const reasoning = override?.reasoning ?? derived.reasoning
  return {
    ...(tools === undefined || typeof tools === "boolean" ? {} : { tools: compact(tools) }),
    ...(typeof tools === "boolean" ? { tools } : {}),
    ...(reasoning === undefined || typeof reasoning === "boolean" ? {} : { reasoning: compact(reasoning) }),
    ...(typeof reasoning === "boolean" ? { reasoning } : {}),
  }
}

export function normalizeModelRequest(
  input: ModelRequestInput,
  options: NormalizeRequestOptions = {},
): NormalizedModelRequest {
  if (!isRecord(input)) throw new InvalidModelRequestError("Model request must be an object")
  if (Object.keys(input).some((key) => sensitiveConfigKey.test(key))) {
    throw new InvalidModelRequestError("Model request cannot contain plaintext credential fields")
  }
  const model = normalizeModelReference(input.model, options.providerId ?? input.providerId ?? input.providerID)
  const tools = normalizeTools(input.tools)
  const toolChoice = normalizeChoice(input.toolChoice)
  const generation = normalizeGeneration(input)
  const reasoning = normalizeReasoning(input)
  const capabilities = normalizeCapabilities(input, options.capabilities)
  const metadata = normalizeMetadata(input.metadata, "metadata")
  const providerOptions = normalizeMetadata(input.providerOptions ?? input.options, "providerOptions")
  const responseFormat = input.responseFormat ?? input.response_format
  if (responseFormat !== undefined) assertJsonValue(responseFormat, "responseFormat")
  assertSafeConfig(metadata, "metadata")
  assertSafeConfig(providerOptions, "providerOptions")
  if (input.credential !== undefined) assertCredentialReference(input.credential)
  const estimatedInputTokens = input.estimatedInputTokens ?? input.inputTokens
  if (estimatedInputTokens !== undefined && (!Number.isSafeInteger(estimatedInputTokens) || estimatedInputTokens < 0)) {
    throw new InvalidModelRequestError("estimatedInputTokens must be a non-negative safe integer")
  }
  const topLevelBudget = compact({
    ...(input.maxInputTokens === undefined ? {} : { maxInputTokens: input.maxInputTokens }),
    ...(input.maxTotalTokens === undefined ? {} : { maxTotalTokens: input.maxTotalTokens }),
    ...(input.maxDurationMs === undefined ? {} : { maxDurationMs: input.maxDurationMs }),
    ...(input.timeoutMs === undefined ? {} : { maxDurationMs: input.timeoutMs }),
    ...(input.deadline === undefined ? {} : { deadline: input.deadline }),
    ...(input.maxToolCalls === undefined ? {} : { maxToolCalls: input.maxToolCalls }),
    ...(input.maxCostUsd === undefined ? {} : { maxCostUsd: input.maxCostUsd }),
    ...(input.maxCost === undefined ? {} : { maxCost: input.maxCost }),
  })
  const request = compact({
    ...(input.id === undefined ? {} : { id: requiredString(input.id, "id") }),
    model,
    system: normalizeSystem(input.system),
    messages: normalizeMessages(input.messages, input.prompt),
    tools,
    ...(toolChoice === undefined ? {} : { toolChoice }),
    ...(generation === undefined ? {} : { generation }),
    ...(reasoning === undefined ? {} : { reasoning }),
    capabilities,
    limits: mergeBudgets(options.defaultBudget, input.budget, normalizeBudget(input.limits), topLevelBudget),
    ...(input.credential === undefined ? {} : { credential: input.credential }),
    ...(metadata === undefined ? {} : { metadata }),
    ...(providerOptions === undefined ? {} : { providerOptions }),
    ...(responseFormat === undefined ? {} : { responseFormat }),
    ...(estimatedInputTokens === undefined ? {} : { estimatedInputTokens }),
  })
  assertJsonValue(request, "request")
  const normalized = request as NormalizedModelRequest
  if (options.providerCapabilities !== undefined || options.modelCapabilities !== undefined) {
    return applyCapabilityNegotiation(
      normalized,
      negotiateCapabilities(options.providerCapabilities, options.modelCapabilities, normalized.capabilities, {
        strict: options.strictCapabilities !== false,
      }),
    )
  }
  return normalized
}

export const normalizeRequest = normalizeModelRequest

export function applyCapabilityNegotiation(
  request: NormalizedModelRequest,
  negotiation: NegotiatedCapabilities,
): NormalizedModelRequest {
  return compact({
    ...request,
    ...(negotiation.tool.enabled ? {} : { tools: [], toolChoice: undefined }),
    ...(negotiation.tool.enabled && negotiation.tool.choice !== undefined
      ? { toolChoice: negotiation.tool.choice }
      : {}),
    ...(negotiation.reasoningRequest.enabled
      ? {
          reasoning: {
            enabled: true,
            ...(negotiation.reasoningRequest.effort === undefined
              ? {}
              : { effort: negotiation.reasoningRequest.effort }),
            ...(negotiation.reasoningRequest.maxTokens === undefined
              ? {}
              : { maxTokens: negotiation.reasoningRequest.maxTokens }),
          },
        }
      : { reasoning: undefined }),
  }) as NormalizedModelRequest
}

export const modelRequestJson = (request: NormalizedModelRequest): JsonObject => request

export const serializeModelRequest = (request: NormalizedModelRequest): string => serialize(modelRequestJson(request))

export const messageText = (message: ModelMessage): string =>
  message.content
    .filter((part): part is TextPart => part.type === "text")
    .map((part) => part.text)
    .join("")
