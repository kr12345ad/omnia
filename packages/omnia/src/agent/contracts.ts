import type {
  Environment as ProtocolEnvironment,
  JsonValue,
  ProtocolEvent as TransportProtocolEvent,
} from "../protocol"

export type ProtocolEvent = TransportProtocolEvent

export interface ProtocolLocation {
  readonly directory: string
  readonly workspaceID?: string
}

export const AGENT_STATES = [
  "idle",
  "planning",
  "acting",
  "observing",
  "verifying",
  "continue",
  "complete",
  "waiting",
  "blocked",
  "error",
  "recovery",
  "paused",
  "cancelled",
] as const

export type AgentState = (typeof AGENT_STATES)[number]

export const TERMINAL_AGENT_STATES = ["complete", "cancelled"] as const
export type TerminalAgentState = (typeof TERMINAL_AGENT_STATES)[number]

export const DEFAULT_RUN_LIMITS = Object.freeze({
  maxSteps: 32,
  maxToolCalls: 64,
  maxRetries: 3,
  maxDurationMs: 15 * 60 * 1000,
  maxSubagents: 4,
})

export interface RunLimits {
  readonly maxSteps: number
  readonly maxToolCalls: number
  readonly maxRetries: number
  readonly maxDurationMs: number
  readonly maxSubagents: number
}

export interface Environment extends ProtocolEnvironment {
  readonly cwd: string
  readonly platform: string
  readonly shell?: string
  readonly ci: boolean
  readonly tools: readonly string[]
  readonly variables: Readonly<Record<string, string>>
}

export interface RunContext {
  readonly runID: string
  readonly agentID: string
  readonly parentRunID?: string
  readonly sessionID?: string
  readonly location?: ProtocolLocation
  readonly environment: Environment
  readonly limits: RunLimits
  readonly createdAt: number
  readonly metadata: Readonly<Record<string, string>>
}

export type ContextRole = "system" | "user" | "assistant" | "tool" | "observation" | "summary"

export type Sensitivity = "public" | "internal" | "sensitive" | "secret"

export interface ContextEntry {
  readonly id: string
  readonly role: ContextRole
  readonly text: string
  readonly tokens: number
  readonly importance: number
  readonly createdAt: number
  readonly sensitivity: Sensitivity
}

export interface ToolCallRequest {
  readonly id?: string
  readonly tool: string
  readonly input: Readonly<Record<string, JsonValue>>
}

export type ToolCallStatus = "running" | "completed" | "failed" | "cancelled"

export interface ToolCall {
  readonly id: string
  readonly sequence: number
  readonly tool: string
  readonly input: Readonly<Record<string, JsonValue>>
  readonly status: ToolCallStatus
  readonly startedAt: number
  readonly completedAt?: number
  readonly result?: JsonValue
  readonly error?: string
  readonly cancellationReason?: string
}

export interface AgentError {
  readonly message: string
  readonly retryable: boolean
  readonly code?: string
  readonly cause?: unknown
}

export type AgentSignal =
  | { readonly type: "start" }
  | { readonly type: "plan"; readonly objective?: string }
  | {
      readonly type: "act"
      readonly call?: ToolCallRequest
      readonly tool?: string
      readonly input?: Readonly<Record<string, JsonValue>>
    }
  | { readonly type: "observe"; readonly observation?: string; readonly toolCallID?: string }
  | { readonly type: "verify"; readonly passed: boolean; readonly result?: string }
  | { readonly type: "continue"; readonly reason?: string }
  | { readonly type: "complete"; readonly result?: string }
  | { readonly type: "wait"; readonly reason?: string; readonly until?: number }
  | { readonly type: "block"; readonly reason: string }
  | { readonly type: "error"; readonly error: AgentError }
  | { readonly type: "recover"; readonly strategy?: string }
  | { readonly type: "pause"; readonly reason?: string }
  | { readonly type: "resume" }
  | { readonly type: "cancel"; readonly reason?: string }
  | { readonly type: "retry"; readonly delayMs?: number }
  | { readonly type: "limit"; readonly kind: LimitKind; readonly limit: number; readonly observed?: number }
  | { readonly type: "delegate"; readonly childAgentID: string; readonly task: string }

export type AgentSignalType = AgentSignal["type"]

export type LimitKind = "steps" | "toolCalls" | "retries" | "duration" | "subagents"

export type AgentEventType =
  | "agent.started"
  | "agent.state.changed"
  | "agent.tool.started"
  | "agent.tool.completed"
  | "agent.tool.failed"
  | "agent.tool.cancelled"
  | "agent.waiting"
  | "agent.blocked"
  | "agent.error"
  | "agent.recovery"
  | "agent.paused"
  | "agent.resumed"
  | "agent.cancelled"
  | "agent.completed"
  | "agent.limit"
  | "agent.delegated"

export interface AgentEvent {
  readonly id: string
  readonly sequence: number
  readonly runID: string
  readonly type: AgentEventType
  readonly from?: AgentState
  readonly to?: AgentState
  readonly timestamp: number
  readonly data: Readonly<Record<string, unknown>>
  readonly protocolEvent?: ProtocolEvent
  readonly location?: ProtocolLocation
}

export type AgentStateEvent = AgentEvent

export interface MachineSnapshot {
  readonly state: AgentState
  readonly run: RunContext
  readonly steps: number
  readonly toolCalls: number
  readonly retries: number
  readonly subagents: number
  readonly eventSequence: number
  readonly startedAt: number
  readonly updatedAt: number
  readonly resumeState?: AgentState
  readonly objective?: string
  readonly lastObservation?: string
  readonly verification?: string
  readonly lastError?: AgentError
  readonly blockedReason?: string
  readonly waitUntil?: number
}
