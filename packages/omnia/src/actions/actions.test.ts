import { describe, expect, test } from "bun:test"
import type { ComputerAction, Observation } from "../protocol"
import {
  executeAction,
  rankActionBackends,
  resolveAction,
  verifyControl,
  verifyFile,
  verifyState,
  verifyText,
  verifyUrl,
  verifyValue,
  verifyWindow,
} from "./index"

const observation: Observation = {
  id: "observation-1",
  elements: [
    { id: "window-1", role: "window", name: "Editor", states: ["focused"] },
    {
      id: "save",
      parentId: "window-1",
      role: "button",
      name: "Save changes",
      reference: {
        kind: "element",
        elementId: "save",
        observationId: "observation-1",
        generation: 1,
      },
    },
  ],
}

describe("universal action resolution", () => {
  test("resolves a semantic target into a canonical action", () => {
    const resolution = resolveAction(
      { type: "click", target: { query: "Save", role: "button" } },
      { observation },
    )

    expect(resolution.success).toBe(true)
    expect(resolution.resolutionStatus).toBe("resolved")
    expect(resolution.action?.type).toBe("click")
    expect(resolution.target?.kind).toBe("element")
    expect(resolution.result.status).toBe("success")
    expect(resolution.confidence).toBeGreaterThan(0.5)
  })

  test("returns a structured rejection for ambiguous targets", () => {
    const ambiguous = {
      ...observation,
      elements: [
        ...(observation.elements ?? []),
        { id: "cancel", parentId: "window-1", role: "button", name: "Cancel" },
      ],
    }
    const resolution = resolveAction({ type: "click", target: { query: "button" } }, { observation: ambiguous })

    expect(resolution.success).toBe(false)
    expect(resolution.resolutionStatus).toBe("ambiguous")
    expect(resolution.result.success).toBe(false)
    expect(resolution.result.status).toBe("rejected")
    expect(resolution.error).toMatchObject({ code: "ambiguous_target" })
  })

  test("ranks eligible backends deterministically", () => {
    const ranked = rankActionBackends(
      [
        { id: "native", backend: "native", available: true, quality: 0.7 },
        { id: "browser", backend: "browser", available: true, quality: 0.9, supports: ["click"] },
        { id: "disabled", backend: "virtual", available: false, quality: 1 },
      ],
      "click",
      { preferredBackendIds: ["native"] },
    )

    expect(ranked.map((entry) => entry.backend)).toEqual(["browser", "native", "virtual"])
    expect(ranked[0]?.eligible).toBe(true)
    expect(ranked[2]?.eligible).toBe(false)
  })
})

describe("target revalidation and structured execution", () => {
  test("revalidates before invoking an injected executor", async () => {
    let invoked = false
    let revalidations = 0
    const resolution = await executeAction(
      { type: "click", target: { query: "Save" } },
      {
        observation,
        revalidate: () => {
          revalidations += 1
          return false
        },
        execute: () => {
          invoked = true
          return { success: true, status: "success" }
        },
      },
    )

    expect(invoked).toBe(false)
    expect(revalidations).toBe(1)
    expect(resolution.success).toBe(false)
    expect(resolution.result.status).toBe("rejected")
    expect(resolution.result.error).toMatchObject({ code: "target_stale" })
  })

  test("returns a normalized ActionResult from an executor", async () => {
    let action: ComputerAction | undefined
    const resolution = await executeAction(
      { type: "click", target: { query: "Save" } },
      {
        observation,
        revalidate: (target) => target.kind === "element"
          ? { ...target, reference: { kind: "element", elementId: target.elementId, observationId: "observation-1", generation: 2 } }
          : false,
        execute: (value) => {
          action = value
          return { success: true, message: "done" }
        },
      },
    )

    if (action?.type !== "click") throw new Error("expected click action")
    if (action.target?.kind !== "element") throw new Error("expected element target")
    expect(action.target.kind).toBe("element")
    expect(action.target.reference?.generation).toBe(2)
    expect(resolution.result.success).toBe(true)
    expect(resolution.result.status).toBe("success")
    expect(resolution.result.message).toBe("done")
  })
})

describe("verification strategies", () => {
  test("verifies text, value, window, file, control, url, and state evidence", () => {
    expect(verifyText("Save changes", "save changes").status).toBe("passed")
    expect(verifyValue({ count: 2 }, { count: 2 }).status).toBe("passed")
    expect(verifyWindow({ id: "window-1", focused: true }, { id: "window-1", focused: true }).status).toBe("passed")
    expect(verifyFile({ path: "/tmp/report", exists: true }, { path: "/tmp/report", exists: true }).status).toBe("passed")
    expect(verifyControl({ id: "save", role: "button" }, { id: "save", role: "button" }).status).toBe("passed")
    expect(verifyUrl("https://example.test/path/", "https://EXAMPLE.test/path").status).toBe("passed")
    expect(verifyState("checked", { checked: true }).status).toBe("passed")
  })

  test("marks failed and inconclusive evidence explicitly", () => {
    expect(verifyValue("ready", "busy").status).toBe("failed")
    expect(verifyFile({ path: "/tmp/report" }, undefined).status).toBe("inconclusive")
  })
})
