import { BudgetExceededError } from "./errors"
import type { JsonObject } from "./json"

export interface TokenUsage {
  readonly inputTokens?: number
  readonly promptTokens?: number
  readonly outputTokens?: number
  readonly completionTokens?: number
  readonly totalTokens?: number
  readonly reasoningTokens?: number
  readonly costUsd?: number
}

export interface ModelBudgetInput {
  readonly maxTokens?: number
  readonly maxOutputTokens?: number
  readonly maxInputTokens?: number
  readonly maxTotalTokens?: number
  readonly maxDurationMs?: number
  readonly deadline?: number
  readonly maxToolCalls?: number
  readonly maxCostUsd?: number
  readonly maxCost?: number
}

export interface ModelBudget {
  readonly maxTokens?: number
  readonly maxOutputTokens?: number
  readonly maxInputTokens?: number
  readonly maxTotalTokens?: number
  readonly maxDurationMs?: number
  readonly deadline?: number
  readonly maxToolCalls?: number
  readonly maxCostUsd?: number
  readonly maxCost?: number
}

export interface BudgetSnapshot {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens: number
  readonly reasoningTokens: number
  readonly costUsd: number
  readonly toolCalls: number
  readonly elapsedMs: number
}

const finiteNonNegative = (value: number | undefined, field: string) => {
  if (value === undefined) return
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${field} must be a finite non-negative number`)
}

const finiteInteger = (value: number | undefined, field: string) => {
  if (value === undefined) return
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${field} must be a non-negative safe integer`)
}

export function normalizeBudget(input: ModelBudgetInput | undefined): ModelBudget {
  if (input === undefined) return {}
  finiteNonNegative(input.maxTokens, "maxTokens")
  finiteNonNegative(input.maxOutputTokens, "maxOutputTokens")
  finiteNonNegative(input.maxInputTokens, "maxInputTokens")
  finiteNonNegative(input.maxTotalTokens, "maxTotalTokens")
  finiteNonNegative(input.maxDurationMs, "maxDurationMs")
  finiteNonNegative(input.deadline, "deadline")
  finiteInteger(input.maxToolCalls, "maxToolCalls")
  finiteNonNegative(input.maxCostUsd, "maxCostUsd")
  finiteNonNegative(input.maxCost, "maxCost")
  const maxOutputTokens =
    input.maxOutputTokens === undefined
      ? input.maxTokens
      : input.maxTokens === undefined
        ? input.maxOutputTokens
        : Math.min(input.maxOutputTokens, input.maxTokens)
  return {
    ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(input.maxInputTokens === undefined ? {} : { maxInputTokens: input.maxInputTokens }),
    ...(input.maxTotalTokens === undefined ? {} : { maxTotalTokens: input.maxTotalTokens }),
    ...(input.maxDurationMs === undefined ? {} : { maxDurationMs: input.maxDurationMs }),
    ...(input.deadline === undefined ? {} : { deadline: input.deadline }),
    ...(input.maxToolCalls === undefined ? {} : { maxToolCalls: input.maxToolCalls }),
    ...(input.maxCostUsd === undefined ? {} : { maxCostUsd: input.maxCostUsd }),
    ...(input.maxCost === undefined ? {} : { maxCost: input.maxCost }),
  }
}

export function mergeBudgets(...inputs: ReadonlyArray<ModelBudgetInput | undefined>): ModelBudget {
  const defined = inputs.filter((input): input is ModelBudgetInput => input !== undefined)
  const latest = <Key extends keyof ModelBudgetInput>(key: Key) =>
    defined
      .slice()
      .reverse()
      .find((input) => input[key] !== undefined)?.[key]
  return normalizeBudget({
    ...(latest("maxTokens") === undefined ? {} : { maxTokens: latest("maxTokens") }),
    ...(latest("maxOutputTokens") === undefined ? {} : { maxOutputTokens: latest("maxOutputTokens") }),
    ...(latest("maxInputTokens") === undefined ? {} : { maxInputTokens: latest("maxInputTokens") }),
    ...(latest("maxTotalTokens") === undefined ? {} : { maxTotalTokens: latest("maxTotalTokens") }),
    ...(latest("maxDurationMs") === undefined ? {} : { maxDurationMs: latest("maxDurationMs") }),
    ...(latest("deadline") === undefined ? {} : { deadline: latest("deadline") }),
    ...(latest("maxToolCalls") === undefined ? {} : { maxToolCalls: latest("maxToolCalls") }),
    ...(latest("maxCostUsd") === undefined ? {} : { maxCostUsd: latest("maxCostUsd") }),
    ...(latest("maxCost") === undefined ? {} : { maxCost: latest("maxCost") }),
  })
}

export class BudgetTracker {
  private readonly budget: ModelBudget
  private readonly now: () => number
  private readonly startedAt: number
  private inputTokens = 0
  private outputTokens = 0
  private reasoningTokens = 0
  private totalTokens = 0
  private costUsd = 0
  private toolCalls = 0

  constructor(budget: ModelBudget, now: () => number = Date.now) {
    this.budget = budget
    this.now = now
    this.startedAt = now()
    this.checkTime()
  }

  get elapsedMs() {
    return Math.max(0, this.now() - this.startedAt)
  }

  get startedAtMs() {
    return this.startedAt
  }

  checkTime() {
    const elapsed = this.elapsedMs
    if (this.budget.maxDurationMs !== undefined && elapsed >= this.budget.maxDurationMs) {
      throw new BudgetExceededError("maxDurationMs", elapsed, this.budget.maxDurationMs)
    }
    if (this.budget.deadline !== undefined && this.now() >= this.budget.deadline) {
      throw new BudgetExceededError("deadline", this.now(), this.budget.deadline)
    }
  }

  check() {
    this.checkTime()
  }

  recordInputTokens(tokens: number) {
    if (!Number.isFinite(tokens) || tokens < 0) throw new TypeError("inputTokens must be a finite non-negative number")
    this.inputTokens = Math.max(this.inputTokens, tokens)
    this.checkTokenLimits()
  }

  recordUsage(usage: TokenUsage) {
    const inputTokens = usage.inputTokens ?? usage.promptTokens
    const outputTokens = usage.outputTokens ?? usage.completionTokens
    if (inputTokens !== undefined) this.inputTokens = Math.max(this.inputTokens, inputTokens)
    if (outputTokens !== undefined) this.outputTokens = Math.max(this.outputTokens, outputTokens)
    if (usage.reasoningTokens !== undefined)
      this.reasoningTokens = Math.max(this.reasoningTokens, usage.reasoningTokens)
    if (usage.costUsd !== undefined) this.costUsd = Math.max(this.costUsd, usage.costUsd)
    const total = usage.totalTokens ?? this.inputTokens + this.outputTokens
    this.totalTokens = Math.max(this.totalTokens, total)
    this.checkTokenLimits()
  }

  recordToolCall() {
    this.toolCalls += 1
    if (this.budget.maxToolCalls !== undefined && this.toolCalls > this.budget.maxToolCalls) {
      throw new BudgetExceededError("maxToolCalls", this.toolCalls, this.budget.maxToolCalls)
    }
  }

  snapshot(): BudgetSnapshot {
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      totalTokens: this.totalTokens,
      reasoningTokens: this.reasoningTokens,
      costUsd: this.costUsd,
      toolCalls: this.toolCalls,
      elapsedMs: this.elapsedMs,
    }
  }

  private checkTokenLimits() {
    if (this.budget.maxInputTokens !== undefined && this.inputTokens > this.budget.maxInputTokens) {
      throw new BudgetExceededError("maxInputTokens", this.inputTokens, this.budget.maxInputTokens)
    }
    const outputLimit = this.budget.maxOutputTokens ?? this.budget.maxTokens
    if (outputLimit !== undefined && this.outputTokens > outputLimit) {
      throw new BudgetExceededError("maxOutputTokens", this.outputTokens, outputLimit)
    }
    if (this.budget.maxTotalTokens !== undefined && this.totalTokens > this.budget.maxTotalTokens) {
      throw new BudgetExceededError("maxTotalTokens", this.totalTokens, this.budget.maxTotalTokens)
    }
    const costLimit =
      this.budget.maxCostUsd === undefined
        ? this.budget.maxCost
        : this.budget.maxCost === undefined
          ? this.budget.maxCostUsd
          : Math.min(this.budget.maxCostUsd, this.budget.maxCost)
    if (costLimit !== undefined && this.costUsd > costLimit) {
      throw new BudgetExceededError("maxCostUsd", this.costUsd, costLimit)
    }
  }
}

export const budgetJson = (budget: ModelBudget): JsonObject => ({
  ...(budget.maxTokens === undefined ? {} : { maxTokens: budget.maxTokens }),
  ...(budget.maxOutputTokens === undefined ? {} : { maxOutputTokens: budget.maxOutputTokens }),
  ...(budget.maxInputTokens === undefined ? {} : { maxInputTokens: budget.maxInputTokens }),
  ...(budget.maxTotalTokens === undefined ? {} : { maxTotalTokens: budget.maxTotalTokens }),
  ...(budget.maxDurationMs === undefined ? {} : { maxDurationMs: budget.maxDurationMs }),
  ...(budget.deadline === undefined ? {} : { deadline: budget.deadline }),
  ...(budget.maxToolCalls === undefined ? {} : { maxToolCalls: budget.maxToolCalls }),
  ...(budget.maxCostUsd === undefined ? {} : { maxCostUsd: budget.maxCostUsd }),
  ...(budget.maxCost === undefined ? {} : { maxCost: budget.maxCost }),
})

export type Budget = ModelBudget
export type Limits = ModelBudget
export type BudgetLimits = ModelBudgetInput
export type BudgetObservation = TokenUsage & { readonly toolCall?: boolean }
