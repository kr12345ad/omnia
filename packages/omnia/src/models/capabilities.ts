import { CapabilityNegotiationError } from "./errors"
import { assertJsonValue, type JsonObject, type JsonValue } from "./json"

export const reasoningEfforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const
export type ReasoningEffort = (typeof reasoningEfforts)[number]

export const toolChoiceModes = ["auto", "none", "required", "named"] as const
export type ToolChoiceMode = (typeof toolChoiceModes)[number]

export type ToolChoice =
  | "auto"
  | "none"
  | "required"
  | "any"
  | { readonly type: "tool"; readonly name: string }
  | { readonly type: "named"; readonly name: string }

export type ToolChoiceInput = ToolChoice | { readonly type: "function"; readonly function: { readonly name: string } }

export interface ToolCapabilitiesInput {
  readonly enabled?: boolean
  readonly choice?: ToolChoiceMode | readonly ToolChoiceMode[]
  readonly choices?: readonly ToolChoiceMode[]
  readonly parallel?: boolean
  readonly streaming?: boolean
  readonly providerExecuted?: boolean
  readonly supportsParallelCalls?: boolean
}

export interface ReasoningCapabilitiesInput {
  readonly enabled?: boolean
  readonly efforts?: readonly ReasoningEffort[] | ReasoningEffort
  readonly maxTokens?: number
  readonly maxOutputTokens?: number
  readonly visible?: boolean
}

export interface CapabilityDeclaration {
  readonly tools?: boolean | ToolCapabilitiesInput
  readonly reasoning?: boolean | ReasoningCapabilitiesInput
  readonly streaming?: boolean
  readonly input?: readonly string[]
  readonly output?: readonly string[]
}

export interface ToolCapabilities {
  readonly enabled: boolean
  readonly choices: readonly ToolChoiceMode[]
  readonly parallel: boolean
  readonly streaming: boolean
  readonly providerExecuted: boolean
}

export interface ReasoningCapabilities {
  readonly enabled: boolean
  readonly efforts: readonly ReasoningEffort[]
  readonly maxTokens?: number
  readonly visible: boolean
}

export interface ModelCapabilities {
  readonly tools: ToolCapabilities
  readonly reasoning: ReasoningCapabilities
  readonly streaming: boolean
  readonly input: readonly string[]
  readonly output: readonly string[]
}

export interface ToolCapabilityRequest {
  readonly enabled?: boolean
  readonly required?: boolean
  readonly choice?: ToolChoice
  readonly parallel?: boolean
}

export interface ReasoningCapabilityRequest {
  readonly enabled?: boolean
  readonly required?: boolean
  readonly effort?: ReasoningEffort
  readonly maxTokens?: number
  readonly maxOutputTokens?: number
}

export interface CapabilityRequest {
  readonly tools?: boolean | ToolCapabilityRequest
  readonly reasoning?: boolean | ReasoningCapabilityRequest
}

export interface ToolCapabilityNegotiation {
  readonly requested: boolean
  readonly supported: boolean
  readonly enabled: boolean
  readonly choice?: ToolChoice
  readonly parallel: boolean
  readonly streaming: boolean
  readonly providerExecuted: boolean
  readonly dropped: boolean
}

export interface ReasoningCapabilityNegotiation {
  readonly requested: boolean
  readonly supported: boolean
  readonly enabled: boolean
  readonly efforts: readonly ReasoningEffort[]
  readonly effort?: ReasoningEffort
  readonly maxTokens?: number
  readonly visible: boolean
  readonly dropped: boolean
}

export interface NegotiatedCapabilities extends ModelCapabilities {
  readonly tools: ToolCapabilities
  readonly reasoning: ReasoningCapabilities
  readonly tool: ToolCapabilityNegotiation
  readonly reasoningRequest: ReasoningCapabilityNegotiation
  readonly dropped: readonly string[]
  readonly unsupported: readonly string[]
}

export interface NegotiationOptions {
  readonly strict?: boolean
}

const asArray = <T>(value: T | readonly T[] | undefined): readonly T[] => {
  if (value === undefined) return []
  return Array.isArray(value) ? (value as readonly T[]) : [value as T]
}

const unique = <T>(values: readonly T[]) => [...new Set(values)]

const toolInput = (value: boolean | ToolCapabilitiesInput | undefined): ToolCapabilitiesInput => {
  if (value === undefined) return {}
  return typeof value === "boolean" ? { enabled: value } : value
}

const reasoningInput = (value: boolean | ReasoningCapabilitiesInput | undefined): ReasoningCapabilitiesInput => {
  if (value === undefined) return {}
  return typeof value === "boolean" ? { enabled: value } : value
}

const validateNonNegative = (value: number | undefined, field: string) => {
  if (value === undefined) return
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${field} must be a finite non-negative number`)
}

export function normalizeToolCapabilities(value: boolean | ToolCapabilitiesInput | undefined): ToolCapabilities {
  const input = toolInput(value)
  const choices = unique([...asArray(input.choice), ...(input.choices ?? [])])
  choices.forEach((choice) => {
    if (!toolChoiceModes.includes(choice)) throw new TypeError(`Unsupported tool choice capability: ${choice}`)
  })
  return {
    enabled: input.enabled ?? true,
    choices,
    parallel: input.parallel ?? input.supportsParallelCalls ?? true,
    streaming: input.streaming ?? true,
    providerExecuted: input.providerExecuted ?? false,
  }
}

export function normalizeReasoningCapabilities(
  value: boolean | ReasoningCapabilitiesInput | undefined,
): ReasoningCapabilities {
  const input = reasoningInput(value)
  const efforts = unique(asArray(input.efforts))
  efforts.forEach((effort) => {
    if (!reasoningEfforts.includes(effort)) throw new TypeError(`Unsupported reasoning effort: ${effort}`)
  })
  const maxTokens = input.maxTokens ?? input.maxOutputTokens
  validateNonNegative(maxTokens, "reasoning.maxTokens")
  return {
    enabled: input.enabled ?? true,
    efforts,
    ...(maxTokens === undefined ? {} : { maxTokens }),
    visible: input.visible ?? true,
  }
}

export function normalizeCapabilities(value: CapabilityDeclaration | undefined): ModelCapabilities {
  const input = value ?? {}
  const inputModalities = unique(input.input ?? [])
  const outputModalities = unique(input.output ?? [])
  return {
    tools: normalizeToolCapabilities(input.tools),
    reasoning: normalizeReasoningCapabilities(input.reasoning),
    streaming: input.streaming ?? true,
    input: inputModalities,
    output: outputModalities,
  }
}

const intersect = <T>(left: readonly T[], right: readonly T[]) => left.filter((item) => right.includes(item))

const intersectChoices = (left: readonly ToolChoiceMode[], right: readonly ToolChoiceMode[]) =>
  left.length === 0 ? right : right.length === 0 ? left : intersect(left, right)

const toolSupport = (
  provider: ModelCapabilities,
  model: ModelCapabilities | undefined,
  providerDeclared: boolean,
  modelDeclared: boolean,
) => {
  if (!providerDeclared) return model?.tools ?? provider.tools
  if (!modelDeclared || !model) return provider.tools
  return {
    enabled: provider.tools.enabled && model.tools.enabled,
    choices: intersectChoices(provider.tools.choices, model.tools.choices),
    parallel: provider.tools.parallel && model.tools.parallel,
    streaming: provider.tools.streaming && model.tools.streaming,
    providerExecuted: provider.tools.providerExecuted || model.tools.providerExecuted,
  }
}

const reasoningSupport = (
  provider: ModelCapabilities,
  model: ModelCapabilities | undefined,
  providerDeclared: boolean,
  modelDeclared: boolean,
) => {
  if (!providerDeclared) return model?.reasoning ?? provider.reasoning
  if (!modelDeclared || !model) return provider.reasoning
  const efforts =
    provider.reasoning.efforts.length === 0
      ? model.reasoning.efforts
      : model.reasoning.efforts.length === 0
        ? provider.reasoning.efforts
        : intersect(provider.reasoning.efforts, model.reasoning.efforts)
  const maxTokens = [provider.reasoning.maxTokens, model.reasoning.maxTokens]
    .filter((value): value is number => value !== undefined)
    .reduce<
      number | undefined
    >((current, value) => (current === undefined ? value : Math.min(current, value)), undefined)
  return {
    enabled: provider.reasoning.enabled && model.reasoning.enabled,
    efforts,
    ...(maxTokens === undefined ? {} : { maxTokens }),
    visible: provider.reasoning.visible && model.reasoning.visible,
  }
}

const requestedTools = (value: CapabilityRequest["tools"]): ToolCapabilityRequest => {
  if (value === undefined) return {}
  return typeof value === "boolean" ? { enabled: value } : value
}

const requestedReasoning = (value: CapabilityRequest["reasoning"]): ReasoningCapabilityRequest => {
  if (value === undefined) return {}
  return typeof value === "boolean" ? { enabled: value } : value
}

const effortRank = (effort: ReasoningEffort) => reasoningEfforts.indexOf(effort)

const nearestEffort = (requested: ReasoningEffort, supported: readonly ReasoningEffort[]) => {
  if (supported.length === 0) return requested
  if (supported.includes(requested)) return requested
  return (
    supported
      .filter((effort) => effortRank(effort) <= effortRank(requested))
      .sort((left, right) => effortRank(right) - effortRank(left))[0] ?? supported[0]
  )
}

const toolChoiceSupported = (choice: ToolChoice | undefined, capabilities: ToolCapabilities) => {
  if (choice === undefined) return true
  if (typeof choice === "object") return capabilities.choices.length === 0 || capabilities.choices.includes("named")
  if (choice === "any") return capabilities.choices.length === 0 || capabilities.choices.includes("required")
  return capabilities.choices.length === 0 || capabilities.choices.includes(choice)
}

const normalizeChoice = (choice: ToolChoice | undefined): ToolChoice | undefined => {
  if (choice === undefined || typeof choice === "string") return choice === "any" ? "required" : choice
  if (choice.type === "named") return { type: "tool", name: choice.name }
  return choice
}

const requestNeedsTools = (request: ToolCapabilityRequest, toolCount: number) =>
  request.enabled === true || request.required === true || request.choice !== undefined || toolCount > 0

const requestNeedsReasoning = (request: ReasoningCapabilityRequest) =>
  request.enabled === true ||
  request.required === true ||
  request.effort !== undefined ||
  request.maxTokens !== undefined ||
  request.maxOutputTokens !== undefined

export function negotiateCapabilities(
  providerDeclaration: CapabilityDeclaration | undefined,
  modelDeclaration: CapabilityDeclaration | undefined,
  request: CapabilityRequest = {},
  options: NegotiationOptions = {},
): NegotiatedCapabilities {
  const provider = normalizeCapabilities(providerDeclaration)
  const model = modelDeclaration === undefined ? undefined : normalizeCapabilities(modelDeclaration)
  const tools = toolSupport(provider, model, providerDeclaration !== undefined, modelDeclaration !== undefined)
  const reasoning = reasoningSupport(provider, model, providerDeclaration !== undefined, modelDeclaration !== undefined)
  const toolRequest = requestedTools(request.tools)
  const reasoningRequest = requestedReasoning(request.reasoning)
  const wantsTools = requestNeedsTools(toolRequest, 0)
  const wantsReasoning = requestNeedsReasoning(reasoningRequest)
  const unsupported: string[] = []
  const dropped: string[] = []
  const toolEnabled = wantsTools && tools.enabled
  if (wantsTools && !tools.enabled) {
    unsupported.push("tools")
    dropped.push("tools")
  }
  const choice = normalizeChoice(toolRequest.choice)
  if (wantsTools && !toolChoiceSupported(choice, tools)) {
    unsupported.push("tool-choice")
    dropped.push("tool-choice")
  }
  const toolNegotiation: ToolCapabilityNegotiation = {
    requested: wantsTools,
    supported: tools.enabled && toolChoiceSupported(choice, tools),
    enabled: toolEnabled && toolChoiceSupported(choice, tools),
    ...(choice === undefined ? {} : { choice }),
    parallel: tools.parallel,
    streaming: tools.streaming,
    providerExecuted: tools.providerExecuted,
    dropped: dropped.includes("tools") || dropped.includes("tool-choice"),
  }
  const reasoningEnabled = wantsReasoning && reasoning.enabled
  if (wantsReasoning && !reasoning.enabled) {
    unsupported.push("reasoning")
    dropped.push("reasoning")
  }
  const effort = reasoningRequest.effort
  const selectedEffort = effort === undefined ? undefined : nearestEffort(effort, reasoning.efforts)
  if (effort !== undefined && !reasoning.efforts.includes(effort) && reasoning.efforts.length > 0) {
    if (options.strict) unsupported.push("reasoning-effort")
    else dropped.push("reasoning-effort")
  }
  const requestedReasoningTokens = reasoningRequest.maxTokens ?? reasoningRequest.maxOutputTokens
  const maxReasoningTokens =
    requestedReasoningTokens === undefined
      ? reasoning.maxTokens
      : reasoning.maxTokens === undefined
        ? requestedReasoningTokens
        : Math.min(requestedReasoningTokens, reasoning.maxTokens)
  if (
    requestedReasoningTokens !== undefined &&
    reasoning.maxTokens !== undefined &&
    requestedReasoningTokens > reasoning.maxTokens
  ) {
    if (options.strict) unsupported.push("reasoning-max-tokens")
    else dropped.push("reasoning-max-tokens")
  }
  const reasoningNegotiation: ReasoningCapabilityNegotiation = {
    requested: wantsReasoning,
    supported:
      reasoning.enabled &&
      (effort === undefined || reasoning.efforts.length === 0 || reasoning.efforts.includes(effort)) &&
      (requestedReasoningTokens === undefined ||
        reasoning.maxTokens === undefined ||
        requestedReasoningTokens <= reasoning.maxTokens),
    enabled: reasoningEnabled && (effort === undefined || selectedEffort !== undefined),
    efforts: reasoning.efforts,
    ...(selectedEffort === undefined ? {} : { effort: selectedEffort }),
    ...(maxReasoningTokens === undefined ? {} : { maxTokens: maxReasoningTokens }),
    visible: reasoning.visible,
    dropped:
      dropped.includes("reasoning") || dropped.includes("reasoning-effort") || dropped.includes("reasoning-max-tokens"),
  }
  const modelInput = model?.input ?? []
  const modelOutput = model?.output ?? []
  const negotiatedInput =
    providerDeclaration === undefined
      ? modelInput.length === 0
        ? provider.input
        : modelInput
      : modelDeclaration === undefined
        ? provider.input
        : provider.input.length === 0
          ? modelInput
          : modelInput.length === 0
            ? provider.input
            : intersect(provider.input, modelInput)
  const negotiatedOutput =
    providerDeclaration === undefined
      ? modelOutput.length === 0
        ? provider.output
        : modelOutput
      : modelDeclaration === undefined
        ? provider.output
        : provider.output.length === 0
          ? modelOutput
          : modelOutput.length === 0
            ? provider.output
            : intersect(provider.output, modelOutput)
  const negotiated: NegotiatedCapabilities = {
    tools: {
      ...tools,
      ...(toolNegotiation.enabled ? {} : { enabled: false }),
    },
    reasoning: {
      ...reasoning,
      ...(reasoningNegotiation.enabled ? {} : { enabled: false }),
      ...(selectedEffort === undefined ? {} : { efforts: [selectedEffort] }),
    },
    streaming: provider.streaming && (model?.streaming ?? true),
    input: negotiatedInput,
    output: negotiatedOutput,
    tool: toolNegotiation,
    reasoningRequest: reasoningNegotiation,
    dropped,
    unsupported: [...new Set(unsupported)],
  }
  if (options.strict && negotiated.unsupported.length > 0) throw new CapabilityNegotiationError(negotiated.unsupported)
  return negotiated
}

export type CapabilityNegotiation = NegotiatedCapabilities
export const negotiateModelCapabilities = negotiateCapabilities
export const negotiate = negotiateCapabilities

export function capabilityRequestFromRequest(input: {
  readonly tools?: readonly unknown[]
  readonly toolChoice?: ToolChoice
  readonly reasoning?: { readonly enabled?: boolean; readonly effort?: ReasoningEffort; readonly maxTokens?: number }
}): CapabilityRequest {
  const reasoning = input.reasoning
  return {
    tools:
      input.tools === undefined
        ? undefined
        : {
            enabled: input.tools.length > 0,
            ...(input.toolChoice === undefined ? {} : { choice: input.toolChoice }),
          },
    reasoning:
      reasoning === undefined
        ? undefined
        : {
            enabled: reasoning.enabled ?? (reasoning.effort !== undefined || reasoning.maxTokens !== undefined),
            ...(reasoning.effort === undefined ? {} : { effort: reasoning.effort }),
            ...(reasoning.maxTokens === undefined ? {} : { maxTokens: reasoning.maxTokens }),
          },
  }
}

export const capabilitiesJson = (capabilities: ModelCapabilities): JsonObject => ({
  tools: {
    enabled: capabilities.tools.enabled,
    choices: [...capabilities.tools.choices],
    parallel: capabilities.tools.parallel,
    streaming: capabilities.tools.streaming,
    providerExecuted: capabilities.tools.providerExecuted,
  },
  reasoning: {
    enabled: capabilities.reasoning.enabled,
    efforts: [...capabilities.reasoning.efforts],
    ...(capabilities.reasoning.maxTokens === undefined ? {} : { maxTokens: capabilities.reasoning.maxTokens }),
    visible: capabilities.reasoning.visible,
  },
  streaming: capabilities.streaming,
  input: [...capabilities.input],
  output: [...capabilities.output],
})

export const assertCapabilityJson = (value: unknown): asserts value is JsonValue => assertJsonValue(value)
