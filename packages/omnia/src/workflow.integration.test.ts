import { describe, expect, test } from "bun:test"
import { executeAction } from "./actions"
import { createRunContext, createStateMachine } from "./agent"
import type { ActionResult, Observation } from "./protocol"

const windowObservation: Observation = {
  id: "observation-window",
  source: "accessibility",
  backend: "windows.uia",
  elements: [
    { id: "supplier-window", role: "window", name: "Suppliers.xlsx", states: ["focused"] },
    {
      id: "export-button",
      parentId: "supplier-window",
      role: "button",
      name: "Export",
      reference: { kind: "element", elementId: "export-button", observationId: "observation-window", generation: 1 },
    },
  ],
}

const exportDialogObservation: Observation = {
  id: "observation-dialog",
  source: "accessibility",
  backend: "windows.uia",
  elements: [
    { id: "export-dialog", role: "dialog", name: "Export workbook", states: ["focused", "modal"] },
    {
      id: "csv-option",
      parentId: "export-dialog",
      role: "menuitem",
      name: "CSV",
      reference: { kind: "element", elementId: "csv-option", observationId: "observation-dialog", generation: 1 },
    },
  ],
}

const saveDialogObservation: Observation = {
  id: "observation-save",
  source: "accessibility",
  backend: "windows.uia",
  elements: [
    { id: "save-dialog", role: "dialog", name: "Save export", states: ["focused", "modal"] },
    {
      id: "filename",
      parentId: "save-dialog",
      role: "textbox",
      name: "File name",
      reference: { kind: "element", elementId: "filename", observationId: "observation-save", generation: 1 },
    },
  ],
}

const completedObservation: Observation = {
  id: "observation-complete",
  source: "accessibility",
  backend: "windows.uia",
  text: "Saved report.csv",
  metadata: { file: "/home/user/Documents/Suppliers/report.csv", windowId: "save-dialog" },
}

const successfulBackend = (next: Observation, message: string) => ({
  id: "windows-uia",
  backend: "windows.uia",
  available: true,
  quality: 0.98,
  supports: ["click", "type"],
  execute: async (): Promise<ActionResult> => ({ success: true, status: "success", message, observation: next }),
})

describe("hard cross-surface workflow", () => {
  test("finishes export, recovers from a stale target, verifies the artifact, and completes the agent run", async () => {
    const stale = await executeAction(
      { type: "click", target: { query: "Export", role: "button" } },
      {
        observation: windowObservation,
        revalidate: () => false,
        backends: [successfulBackend(exportDialogObservation, "export opened")],
      },
    )
    expect(stale.success).toBe(false)
    expect(stale.result.error).toMatchObject({ code: "target_stale" })

    const exportResult = await executeAction(
      { type: "click", target: { query: "Export", role: "button" } },
      {
        observation: windowObservation,
        revalidate: (target) => target,
        backends: [successfulBackend(exportDialogObservation, "export opened")],
      },
    )
    expect(exportResult.success).toBe(true)
    expect(exportResult.result.observation?.id).toBe("observation-dialog")

    const formatResult = await executeAction(
      { type: "click", target: { query: "CSV", role: "menuitem" } },
      {
        observation: exportDialogObservation,
        revalidate: (target) => target,
        backends: [successfulBackend(saveDialogObservation, "CSV selected")],
      },
    )
    expect(formatResult.success).toBe(true)
    expect(formatResult.result.observation?.id).toBe("observation-save")

    const filenameResult = await executeAction(
      { type: "type", target: { query: "File name", role: "textbox" }, text: "report.csv" },
      {
        observation: saveDialogObservation,
        revalidate: (target) => target,
        backends: [successfulBackend(completedObservation, "file saved")],
        verification: { kind: "file", expected: "/home/user/Documents/Suppliers/report.csv" },
        verify: true,
      },
    )
    expect(filenameResult.success).toBe(true)
    expect(filenameResult.result.verification?.status).toBe("passed")

    const machine = createStateMachine(
      createRunContext({
        runID: "run-hard-workflow",
        agentID: "workflow-agent",
        environment: {
          cwd: "/home/user/Documents/Suppliers",
          platform: "windows",
          ci: false,
          tools: ["uia", "keyboard"],
          variables: {},
        },
        limits: { maxSteps: 8, maxToolCalls: 8, maxRetries: 1, maxDurationMs: 60_000, maxSubagents: 1 },
        createdAt: 1,
      }),
      { now: () => 2, idFactory: () => "event-hard-workflow" },
    )
    machine.start()
    machine.dispatch({ type: "plan", objective: "Export the supplier workbook as CSV" })
    machine.dispatch({ type: "act", tool: "computer.execute", input: { action: "export" } })
    const call = machine.sequencer.activeCall()
    if (!call) throw new Error("expected active tool call")
    machine.dispatch({ type: "observe", observation: "Export dialog appeared", toolCallID: call.id })
    machine.dispatch({ type: "verify", passed: true, result: "Artifact exists" })
    machine.dispatch({ type: "continue", reason: "All steps verified" })
    machine.dispatch({ type: "complete", result: "report.csv" })
    expect(machine.currentState).toBe("complete")
    expect(machine.events().some((event) => event.type === "agent.tool.completed")).toBe(true)
    expect(machine.events().some((event) => event.type === "agent.completed")).toBe(true)
  })
})
