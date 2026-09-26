import { describe, expect, test } from "bun:test"
import { createRunContext } from "./run-context"
import { constrainScope, createDelegation, DelegationError, type DelegationScope } from "./delegation"
import type { Environment } from "./contracts"

const environment: Environment = {
  cwd: "/workspace/project",
  platform: "linux",
  ci: false,
  tools: ["read", "write"],
  variables: {},
}

const parentScope: DelegationScope = {
  tools: ["read", "write"],
  roots: ["/workspace/project"],
  memoryScopes: ["run", "session"],
  maxSteps: 10,
  maxToolCalls: 8,
  maxRetries: 2,
  maxDurationMs: 10_000,
  maxSubagents: 2,
  maxSensitivity: "internal",
  permissions: ["read", "write"],
}

describe("subagent delegation", () => {
  test("intersects tools, roots, memory, and limits with the parent", () => {
    const scope = constrainScope(parentScope, {
      ...parentScope,
      tools: ["read", "delete"],
      roots: ["/workspace/project/src", "/etc", "/workspace/project/../etc"],
      memoryScopes: ["session", "global"],
      maxSteps: 100,
      maxToolCalls: 100,
      maxSensitivity: "sensitive",
    })
    expect(scope.tools).toEqual(["read"])
    expect(scope.roots).toEqual(["/workspace/project/src"])
    expect(scope.memoryScopes).toEqual(["session"])
    expect(scope.maxSteps).toBe(10)
    expect(scope.maxToolCalls).toBe(8)
    expect(scope.maxSensitivity).toBe("internal")
  })

  test("creates a constrained child contract", () => {
    const parent = createRunContext({ runID: "parent", agentID: "build", environment, createdAt: 1 })
    const contract = createDelegation({
      parent,
      childAgentID: "explore",
      task: "inspect source",
      parentScope,
      scope: { ...parentScope, tools: ["read"], roots: ["/workspace/project/src"] },
    })
    expect(contract.parentRunID).toBe("parent")
    expect(contract.childRunID).toBe("parent:subagent:explore")
    expect(Object.isFrozen(contract)).toBe(true)
    expect(Object.isFrozen(contract.scope)).toBe(true)
  })

  test("rejects a scope with no allowed capabilities", () => {
    const parent = createRunContext({ runID: "parent", agentID: "build", environment, createdAt: 1 })
    expect(() =>
      createDelegation({
        parent,
        childAgentID: "explore",
        task: "inspect source",
        parentScope,
        scope: { ...parentScope, tools: ["delete"], roots: ["/workspace/project"] },
      }),
    ).toThrow(DelegationError)
  })
})
