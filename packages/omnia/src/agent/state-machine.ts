import type {
  AgentError,
  AgentEvent,
  AgentEventType,
  AgentSignal,
  AgentState,
  LimitKind,
  MachineSnapshot,
  RunContext,
  ToolCallRequest,
} from "./contracts"
import { TERMINAL_AGENT_STATES } from "./contracts"
import {
  createIdFactory,
  deepFreeze,
  freezeClone,
  ImmutableEventEmitter,
  toProtocolEvent,
  type EventListener,
} from "./events"
import { ToolCallError, ToolCallSequencer, type ToolEvent } from "./tool-calls"
import type { MemoryRecord, MemoryScope, MemoryStore, MemoryWrite } from "./memory"

export class InvalidTransitionError extends Error {
  readonly code = "invalid-transition" as const

  constructor(
    readonly state: AgentState,
    readonly signal: AgentSignal["type"],
  ) {
    super(`cannot apply ${signal} while agent is ${state}`)
    this.name = "InvalidTransitionError"
  }
}

export class AgentLimitError extends Error {
  constructor(
    readonly kind: LimitKind,
    readonly limit: number,
    readonly observed: number,
  ) {
    super(`agent ${kind} limit reached: ${observed}/${limit}`)
    this.name = "AgentLimitError"
  }
}

export interface StateMachineOptions {
  readonly context: RunContext
  readonly now?: () => number
  readonly idFactory?: () => string
  readonly memory?: MemoryStore
  readonly tools?: ToolCallSequencer
}

export class AgentStateMachine {
  private state: AgentState = "idle"
  private steps = 0
  private retries = 0
  private subagents = 0
  private eventSequence = 0
  private updatedAt: number
  private resumeState: AgentState | undefined
  private objective: string | undefined
  private lastObservation: string | undefined
  private verification: string | undefined
  private lastError: AgentError | undefined
  private blockedReason: string | undefined
  private waitUntil: number | undefined
  private readonly emitter = new ImmutableEventEmitter<AgentEvent>()
  private readonly now: () => number
  private readonly idFactory: () => string
  private readonly tools: ToolCallSequencer

  constructor(private readonly options: StateMachineOptions) {
    this.now = options.now ?? Date.now
    this.idFactory = options.idFactory ?? createIdFactory("evt")
    this.updatedAt = options.context.createdAt
    this.tools =
      options.tools ??
      new ToolCallSequencer({
        maxCalls: options.context.limits.maxToolCalls,
        now: this.now,
      })
    this.tools.subscribe((event) => this.emitToolEvent(event))
  }

  get context(): RunContext {
    return this.options.context
  }

  get sequencer(): ToolCallSequencer {
    return this.tools
  }

  get memory(): MemoryStore | undefined {
    return this.options.memory
  }

  remember(input: Omit<MemoryWrite, "scope"> & { readonly scope?: MemoryScope }): MemoryRecord {
    if (!this.options.memory) throw new Error("memory store is not configured")
    return this.options.memory.write({ ...input, scope: input.scope ?? "run" })
  }

  recall(scope: MemoryScope, key: string): MemoryRecord | undefined {
    return this.options.memory?.get(scope, key)
  }

  get currentState(): AgentState {
    return this.state
  }

  subscribe(listener: EventListener<AgentEvent>): () => void {
    return this.emitter.subscribe(listener)
  }

  events(): readonly AgentEvent[] {
    return this.emitter.history()
  }

  snapshot(): MachineSnapshot {
    return deepFreeze({
      state: this.state,
      run: this.options.context,
      steps: this.steps,
      toolCalls: this.tools.history().length,
      retries: this.retries,
      subagents: this.subagents,
      eventSequence: this.eventSequence,
      startedAt: this.options.context.createdAt,
      updatedAt: this.updatedAt,
      resumeState: this.resumeState,
      objective: this.objective,
      lastObservation: this.lastObservation,
      verification: this.verification,
      lastError: this.lastError,
      blockedReason: this.blockedReason,
      waitUntil: this.waitUntil,
    })
  }

  dispatch(signal: AgentSignal): MachineSnapshot {
    if (this.state === "cancelled" && signal.type !== "cancel") return this.snapshot()
    if (this.state === "complete" && signal.type !== "cancel") return this.snapshot()
    if (signal.type === "cancel") return this.cancel(signal.reason)
    const now = this.now()
    if (this.elapsed(now) >= this.options.context.limits.maxDurationMs && this.state !== "idle") {
      return this.applyLimit("duration", this.options.context.limits.maxDurationMs, this.elapsed(now))
    }
    if (signal.type === "limit") {
      if (!Number.isFinite(signal.limit) || signal.limit < 0)
        throw new RangeError("limit must be a non-negative finite number")
      return this.applyLimit(signal.kind, signal.limit, signal.observed ?? signal.limit)
    }
    if (signal.type === "retry") return this.retry(signal.delayMs)
    if (signal.type === "delegate") return this.delegate(signal.childAgentID, signal.task, now)
    const toolRequest =
      signal.type === "act"
        ? (signal.call ?? (signal.tool === undefined ? undefined : { tool: signal.tool, input: signal.input ?? {} }))
        : undefined
    if (signal.type === "plan" && this.steps >= this.options.context.limits.maxSteps) {
      return this.applyLimit("steps", this.options.context.limits.maxSteps, this.steps + 1)
    }
    if (signal.type === "act" && this.steps >= this.options.context.limits.maxSteps) {
      return this.applyLimit("steps", this.options.context.limits.maxSteps, this.steps + 1)
    }
    if (
      signal.type === "act" &&
      toolRequest &&
      this.tools.history().length >= this.options.context.limits.maxToolCalls
    ) {
      return this.applyLimit("toolCalls", this.options.context.limits.maxToolCalls, this.tools.history().length + 1)
    }
    if (signal.type === "resume") transitionState(this.state, signal)
    const next = signal.type === "resume" ? (this.resumeState ?? "planning") : transitionState(this.state, signal)
    if (signal.type === "plan") {
      this.steps += 1
      this.objective = signal.objective
    }
    if (signal.type === "act" && toolRequest && !this.startTool(toolRequest)) return this.snapshot()
    if (signal.type === "observe") {
      const active = this.tools.activeCall()
      if (active && signal.toolCallID && active.id !== signal.toolCallID) {
        throw new InvalidTransitionError(this.state, "observe")
      }
      if (!active && signal.toolCallID) throw new InvalidTransitionError(this.state, "observe")
      this.lastObservation = signal.observation
      if (active) this.tools.complete(active.id, { observation: signal.observation ?? "", observedAt: now })
    }
    if (signal.type === "verify") this.verification = signal.passed ? "passed" : "failed"
    if (signal.type === "wait") this.waitUntil = signal.until
    if (signal.type !== "wait" && signal.type !== "resume") this.waitUntil = undefined
    if (signal.type === "block") this.blockedReason = signal.reason
    if (signal.type === "error") this.lastError = this.normalizeError(signal.error)
    if (signal.type === "recover") this.blockedReason = undefined
    if (signal.type === "pause" && this.state !== "paused") this.resumeState = this.state
    if (signal.type === "resume") this.resumeState = undefined
    this.commit(next, signal, now)
    return this.snapshot()
  }

  start(): MachineSnapshot {
    return this.dispatch({ type: "start" })
  }

  send(signal: AgentSignal): MachineSnapshot {
    return this.dispatch(signal)
  }

  cancel(reason = "cancelled"): MachineSnapshot {
    if (this.state === "cancelled" || this.state === "complete") return this.snapshot()
    this.tools.cancelActive(reason)
    const now = this.now()
    const from = this.state
    this.state = "cancelled"
    this.updatedAt = now
    this.resumeState = undefined
    this.blockedReason = undefined
    this.emit({
      type: "agent.cancelled",
      from,
      to: "cancelled",
      timestamp: now,
      data: { reason },
    })
    return this.snapshot()
  }

  private retry(delayMs?: number): MachineSnapshot {
    if (this.state !== "error" && this.state !== "recovery" && this.state !== "blocked") {
      throw new InvalidTransitionError(this.state, "retry")
    }
    if (this.lastError?.retryable === false) {
      const now = this.now()
      const from = this.state
      this.blockedReason = "error is not retryable"
      this.state = "blocked"
      this.updatedAt = now
      this.emit({
        type: "agent.blocked",
        from,
        to: "blocked",
        timestamp: now,
        data: { reason: this.blockedReason },
      })
      return this.snapshot()
    }
    if (this.retries >= this.options.context.limits.maxRetries) {
      return this.applyLimit("retries", this.options.context.limits.maxRetries, this.retries + 1)
    }
    this.retries += 1
    this.lastError = undefined
    this.blockedReason = undefined
    const now = this.now()
    const from = this.state
    this.state = "planning"
    this.updatedAt = now
    this.emit({
      type: "agent.state.changed",
      from,
      to: "planning",
      timestamp: now,
      data: { signal: "retry", attempt: this.retries, delayMs },
    })
    return this.snapshot()
  }

  private delegate(childAgentID: string, task: string, now: number): MachineSnapshot {
    transitionState(this.state, { type: "delegate", childAgentID, task })
    if (this.subagents >= this.options.context.limits.maxSubagents) {
      return this.applyLimit("subagents", this.options.context.limits.maxSubagents, this.subagents + 1)
    }
    if (childAgentID.trim().length === 0 || task.trim().length === 0) {
      throw new InvalidTransitionError(this.state, "delegate")
    }
    this.subagents += 1
    this.updatedAt = now
    this.emit({
      type: "agent.delegated",
      from: this.state,
      to: this.state,
      timestamp: now,
      data: { childAgentID, task },
    })
    return this.snapshot()
  }

  private startTool(call: ToolCallRequest): boolean {
    try {
      this.tools.start(call)
      return true
    } catch (error) {
      if (error instanceof ToolCallError && error.code === "limit") {
        this.applyLimit("toolCalls", this.options.context.limits.maxToolCalls, this.tools.history().length + 1)
        return false
      }
      throw error
    }
  }

  private applyLimit(kind: LimitKind, limit: number, observed: number): MachineSnapshot {
    if (this.state === "cancelled" || this.state === "complete") return this.snapshot()
    const now = this.now()
    const from = this.state
    const reason = `${kind} limit reached: ${observed}/${limit}`
    this.tools.cancelActive(reason)
    this.blockedReason = reason
    this.state = "blocked"
    this.updatedAt = now
    this.emit({
      type: "agent.limit",
      from,
      to: "blocked",
      timestamp: now,
      data: { kind, limit, observed, reason },
    })
    return this.snapshot()
  }

  private commit(next: AgentState, signal: AgentSignal, now: number): void {
    const from = this.state
    this.state = next
    this.updatedAt = now
    this.emit({
      type: eventType(signal, next),
      from,
      to: next,
      timestamp: now,
      data: signalData(signal),
    })
  }

  private emit(input: Omit<AgentEvent, "id" | "sequence" | "runID">): void {
    this.eventSequence += 1
    const event = {
      ...input,
      ...(this.options.context.location === undefined ? {} : { location: this.options.context.location }),
      id: this.idFactory(),
      sequence: this.eventSequence,
      runID: this.options.context.runID,
    } satisfies AgentEvent
    const protocolEvent = toProtocolEvent(event)
    this.emitter.emit({
      ...event,
      ...(protocolEvent === undefined ? {} : { protocolEvent }),
    })
  }

  private emitToolEvent(event: ToolEvent): void {
    const type: AgentEventType =
      event.type === "tool.started"
        ? "agent.tool.started"
        : event.type === "tool.completed"
          ? "agent.tool.completed"
          : event.type === "tool.failed"
            ? "agent.tool.failed"
            : "agent.tool.cancelled"
    this.emit({
      type,
      from: this.state,
      to: this.state,
      timestamp: event.timestamp,
      data: {
        callID: event.call.id,
        tool: event.call.tool,
        sequence: event.call.sequence,
        status: event.call.status,
      },
    })
  }

  private normalizeError(error: AgentError): AgentError {
    return deepFreeze({
      message: error.message,
      retryable: error.retryable,
      code: error.code,
      cause: freezeClone(error.cause),
    })
  }

  private elapsed(now: number): number {
    return Math.max(0, now - this.options.context.createdAt)
  }
}

export function createStateMachine(
  context: RunContext,
  options: Omit<StateMachineOptions, "context"> = {},
): AgentStateMachine {
  return new AgentStateMachine({ ...options, context })
}

export { AgentStateMachine as AgentMachine }

export function transitionState(state: AgentState, signal: AgentSignal): AgentState {
  if (signal.type === "cancel") return state === "complete" ? "complete" : "cancelled"
  if (TERMINAL_AGENT_STATES.includes(state as (typeof TERMINAL_AGENT_STATES)[number])) {
    throw new InvalidTransitionError(state, signal.type)
  }
  if (signal.type === "start") {
    if (state !== "idle") throw new InvalidTransitionError(state, signal.type)
    return "planning"
  }
  if (signal.type === "pause") return "paused"
  if (signal.type === "resume") {
    if (state !== "paused") throw new InvalidTransitionError(state, signal.type)
    return "planning"
  }
  if (signal.type === "plan") {
    if (state !== "planning" && state !== "continue" && state !== "waiting" && state !== "recovery") {
      throw new InvalidTransitionError(state, signal.type)
    }
    return "planning"
  }
  if (signal.type === "act") {
    if (state !== "planning" && state !== "acting" && state !== "waiting" && state !== "recovery") {
      throw new InvalidTransitionError(state, signal.type)
    }
    return "acting"
  }
  if (signal.type === "observe") {
    if (state !== "acting") throw new InvalidTransitionError(state, signal.type)
    return "observing"
  }
  if (signal.type === "verify") {
    if (state !== "observing") throw new InvalidTransitionError(state, signal.type)
    return "verifying"
  }
  if (signal.type === "continue") {
    if (state !== "verifying") throw new InvalidTransitionError(state, signal.type)
    return "continue"
  }
  if (signal.type === "complete") {
    if (state !== "verifying" && state !== "continue") throw new InvalidTransitionError(state, signal.type)
    return "complete"
  }
  if (signal.type === "wait") {
    if (state === "error" || state === "blocked" || state === "recovery") {
      throw new InvalidTransitionError(state, signal.type)
    }
    return "waiting"
  }
  if (signal.type === "block") return "blocked"
  if (signal.type === "error") {
    if (state === "blocked" || state === "error") {
      throw new InvalidTransitionError(state, signal.type)
    }
    return "error"
  }
  if (signal.type === "recover") {
    if (state !== "error" && state !== "blocked") throw new InvalidTransitionError(state, signal.type)
    return "recovery"
  }
  if (signal.type === "retry") {
    if (state !== "error" && state !== "blocked" && state !== "recovery") {
      throw new InvalidTransitionError(state, signal.type)
    }
    return "planning"
  }
  if (signal.type === "limit") return "blocked"
  if (signal.type === "delegate") {
    if (state === "idle" || state === "paused" || state === "waiting") {
      throw new InvalidTransitionError(state, signal.type)
    }
    return state
  }
  throw new Error("unsupported agent signal")
}

function eventType(signal: AgentSignal, next: AgentState): AgentEventType {
  if (signal.type === "start") return "agent.started"
  if (signal.type === "wait") return "agent.waiting"
  if (signal.type === "block") return "agent.blocked"
  if (signal.type === "error") return "agent.error"
  if (signal.type === "recover") return "agent.recovery"
  if (signal.type === "pause") return "agent.paused"
  if (signal.type === "resume") return "agent.resumed"
  if (signal.type === "complete") return "agent.completed"
  if (signal.type === "delegate") return "agent.delegated"
  if (next === "blocked") return "agent.blocked"
  return "agent.state.changed"
}

function signalData(signal: AgentSignal): Readonly<Record<string, unknown>> {
  if (signal.type === "plan") return { signal: signal.type, objective: signal.objective }
  if (signal.type === "act")
    return { signal: signal.type, callID: signal.call?.id, tool: signal.call?.tool ?? signal.tool }
  if (signal.type === "observe")
    return { signal: signal.type, observation: signal.observation, toolCallID: signal.toolCallID }
  if (signal.type === "verify") return { signal: signal.type, passed: signal.passed, result: signal.result }
  if (signal.type === "continue") return { signal: signal.type, reason: signal.reason }
  if (signal.type === "complete") return { signal: signal.type, result: signal.result }
  if (signal.type === "wait") return { signal: signal.type, reason: signal.reason, until: signal.until }
  if (signal.type === "block") return { signal: signal.type, reason: signal.reason }
  if (signal.type === "error")
    return {
      signal: signal.type,
      error: {
        message: signal.error.message,
        retryable: signal.error.retryable,
        ...(signal.error.code === undefined ? {} : { code: signal.error.code }),
      },
    }
  if (signal.type === "recover") return { signal: signal.type, strategy: signal.strategy }
  if (signal.type === "pause") return { signal: signal.type, reason: signal.reason }
  if (signal.type === "resume" || signal.type === "start") return { signal: signal.type }
  if (signal.type === "cancel") return { signal: signal.type, reason: signal.reason }
  if (signal.type === "retry") return { signal: signal.type, delayMs: signal.delayMs }
  if (signal.type === "limit")
    return { signal: signal.type, kind: signal.kind, limit: signal.limit, observed: signal.observed }
  return { signal: signal.type }
}
