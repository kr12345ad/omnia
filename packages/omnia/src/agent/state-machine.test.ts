import { describe, expect, test } from "bun:test"
import { createRunContext } from "./run-context"
import { AgentLimitError, AgentStateMachine, InvalidTransitionError, transitionState } from "./state-machine"
import { ToolCallError } from "./tool-calls"
import type { Environment, RunLimits } from "./contracts"

const environment: Environment = {
  cwd: "/workspace/project",
  platform: "linux",
  shell: "bash",
  ci: false,
  tools: ["read", "shell"],
  variables: { TERM: "xterm-256color", SECRET_TOKEN: "hidden" },
}

function createMachine(limits: Partial<RunLimits> = {}, start = 1_000) {
  const clock = { value: start, now: () => clock.value }
  const context = createRunContext({
    runID: "run-test",
    agentID: "build",
    environment,
    limits,
    createdAt: start,
  })
  return { machine: new AgentStateMachine({ context, now: clock.now }), clock }
}

describe("agent state transitions", () => {
  test("moves through the complete lifecycle", () => {
    const { machine } = createMachine()
    expect(machine.start().state).toBe("planning")
    expect(machine.send({ type: "plan" }).state).toBe("planning")
    expect(
      machine.send({ type: "act", call: { id: "call-1", tool: "read", input: { path: "README.md" } } }).state,
    ).toBe("acting")
    expect(machine.send({ type: "observe", toolCallID: "call-1", observation: "loaded" }).state).toBe("observing")
    expect(machine.send({ type: "verify", passed: false }).state).toBe("verifying")
    expect(machine.send({ type: "continue", reason: "more work" }).state).toBe("continue")
    expect(machine.send({ type: "plan" }).state).toBe("planning")
    expect(machine.send({ type: "act" }).state).toBe("acting")
    expect(machine.send({ type: "observe" }).state).toBe("observing")
    expect(machine.send({ type: "verify", passed: true }).state).toBe("verifying")
    expect(machine.send({ type: "complete", result: "done" }).state).toBe("complete")
    expect(machine.events().at(-1)?.type).toBe("agent.completed")
  })

  test("supports waiting, pause, resume, blocked, recovery, and retry", () => {
    const { machine } = createMachine()
    machine.start()
    expect(machine.send({ type: "wait", reason: "input" }).state).toBe("waiting")
    expect(machine.send({ type: "plan" }).state).toBe("planning")
    expect(machine.send({ type: "pause", reason: "operator" }).state).toBe("paused")
    expect(machine.snapshot().resumeState).toBe("planning")
    expect(machine.send({ type: "resume" }).state).toBe("planning")
    expect(machine.send({ type: "block", reason: "permission" }).state).toBe("blocked")
    expect(machine.send({ type: "recover" }).state).toBe("recovery")
    expect(machine.send({ type: "plan" }).state).toBe("planning")
    expect(machine.send({ type: "error", error: { message: "temporary", retryable: true } }).state).toBe("error")
    expect(machine.send({ type: "retry" }).state).toBe("planning")
  })

  test("rejects invalid transitions", () => {
    expect(() => transitionState("idle", { type: "observe" })).toThrow(InvalidTransitionError)
    expect(() => transitionState("complete", { type: "plan" })).toThrow(InvalidTransitionError)
  })
  test("emits frozen events and sequences active tool calls", () => {
    const { machine } = createMachine()
    machine.start()
    machine.send({ type: "act", tool: "read", input: { path: "README.md" } })
    expect(() => machine.sequencer.start({ tool: "shell", input: {} })).toThrow(ToolCallError)
    expect(machine.send({ type: "observe", observation: "loaded" }).state).toBe("observing")
    const event = machine.events()[1]
    if (!event) throw new Error("expected an emitted event")
    expect(Object.isFrozen(event)).toBe(true)
    expect(Object.isFrozen(event.data)).toBe(true)
    expect(machine.events()[0]?.protocolEvent?.type).toBe("agent.started")
  })
})

describe("agent cancellation and limits", () => {
  test("cancels an active tool and ignores late signals", () => {
    const { machine } = createMachine()
    machine.start()
    machine.send({ type: "act", call: { id: "call-cancel", tool: "shell", input: { command: "pwd" } } })
    expect(machine.cancel("user request").state).toBe("cancelled")
    expect(machine.sequencer.activeCall()).toBeUndefined()
    expect(machine.send({ type: "plan" }).state).toBe("cancelled")
    expect(machine.events().some((event) => event.type === "agent.tool.cancelled")).toBe(true)
  })

  test("blocks when step and retry limits are exhausted", () => {
    const { machine } = createMachine({ maxSteps: 1, maxRetries: 1 })
    machine.start()
    machine.send({ type: "plan" })
    expect(machine.send({ type: "plan" }).state).toBe("blocked")
    expect(machine.snapshot().blockedReason).toContain("steps")

    const retryMachine = createMachine({ maxRetries: 1 }).machine
    retryMachine.start()
    retryMachine.send({ type: "error", error: { message: "failure", retryable: true } })
    expect(retryMachine.send({ type: "retry" }).state).toBe("planning")
    retryMachine.send({ type: "error", error: { message: "failure", retryable: true } })
    expect(retryMachine.send({ type: "retry" }).state).toBe("blocked")
    expect(retryMachine.events().at(-1)?.data.kind).toBe("retries")
  })

  test("enforces tool-call limits", () => {
    const { machine } = createMachine({ maxToolCalls: 1 })
    machine.start()
    machine.send({ type: "act", call: { id: "first", tool: "read", input: {} } })
    machine.send({ type: "observe", toolCallID: "first" })
    expect(machine.send({ type: "act", call: { id: "second", tool: "read", input: {} } }).state).toBe("blocked")
    expect(machine.snapshot().blockedReason).toContain("toolCalls")
  })

  test("enforces duration and explicit limits", () => {
    const { machine, clock } = createMachine({ maxDurationMs: 10 })
    machine.start()
    clock.value += 11
    expect(machine.send({ type: "plan" }).state).toBe("blocked")
    expect(machine.snapshot().blockedReason).toContain("duration")

    const explicit = createMachine().machine
    explicit.start()
    expect(explicit.send({ type: "limit", kind: "toolCalls", limit: 2, observed: 3 }).state).toBe("blocked")
    expect(explicit.events().at(-1)?.type).toBe("agent.limit")

    const subagents = createMachine({ maxSubagents: 0 }).machine
    subagents.start()
    expect(subagents.send({ type: "delegate", childAgentID: "child", task: "inspect" }).state).toBe("blocked")
    expect(subagents.snapshot().blockedReason).toContain("subagents")
  })

  test("exports a typed limit error", () => {
    const error = new AgentLimitError("steps", 2, 3)
    expect(error.kind).toBe("steps")
    expect(error.message).toContain("3/2")
  })
})
