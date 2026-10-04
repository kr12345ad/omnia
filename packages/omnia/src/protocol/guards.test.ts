import { describe, expect, test } from "bun:test"
import {
  isActionResult,
  isComputerAction,
  isComputerEvent,
  isComputerInfo,
  isElementReference,
  isFindResult,
  isJsonValue,
  isModelEvent,
  isObservation,
  isPermissionScope,
  isProvenance,
  isUIElement,
  isVerification,
} from "./index.js"

describe("protocol guards", () => {
  test("accepts a structured UI element and observation", () => {
    const element = {
      id: "save",
      role: "button",
      name: "Save",
      value: "draft",
      bounds: { x: 10, y: 20, width: 80, height: 30 },
      states: ["focused"],
      actions: ["click"],
      metadata: { source: "accessibility" },
    }
    const observation = {
      id: "observation-1",
      timestamp: 1,
      elements: [element],
      source: "accessibility",
      backend: "windows-uia",
    }

    expect(isUIElement(element)).toBe(true)
    expect(isObservation(observation)).toBe(true)
    expect(isJsonValue(observation)).toBe(true)
  })

  test("rejects non-cloneable metadata and malformed nested elements", () => {
    expect(isUIElement({ id: "save", role: "button", metadata: { callback: () => true } })).toBe(false)
    expect(isObservation({ id: "observation-1", timestamp: 1, elements: [{ id: "save", role: 3 }] })).toBe(false)
    expect(isJsonValue({ value: new Date() })).toBe(false)
  })

  test("rejects array payloads that structuredClone cannot copy", () => {
    const withExtraProperty = [1, 2] as number[] & { handler?: unknown }
    withExtraProperty.handler = () => true
    const withCyclicExtraProperty = [1] as number[] & { self?: unknown }
    withCyclicExtraProperty.self = withCyclicExtraProperty

    expect(isJsonValue(withExtraProperty)).toBe(false)
    expect(isJsonValue(withCyclicExtraProperty)).toBe(false)
    expect(isJsonValue([1, 2, 3])).toBe(true)
    expect(isJsonValue([{ nested: [true, null, "text"] }])).toBe(true)
  })

  test("bounds element reference counters and expiry to the documented ranges", () => {
    expect(isElementReference({ elementId: "save", expiresAt: -1 })).toBe(false)
    expect(isElementReference({ elementId: "save", generation: -1 })).toBe(false)
    expect(isElementReference({ elementId: "save", generation: 1.5 })).toBe(false)
    expect(isElementReference({ elementId: "save", generation: 2, expiresAt: 1_700_000_000_000 })).toBe(true)
  })

  test("rejects events stamped before the epoch", () => {
    expect(isComputerEvent({ id: "event-1", timestamp: -1, type: "computer.disconnected" })).toBe(false)
    expect(isComputerEvent({ id: "event-1", timestamp: 0, type: "computer.disconnected" })).toBe(true)
  })

  test("narrows discriminated actions and results", () => {
    const action = {
      type: "click",
      target: { kind: "element", elementId: "save" },
      button: "left",
    }
    const result = {
      success: true,
      status: "success",
      message: "clicked",
      verification: { status: "passed", passed: true },
    }

    expect(isComputerAction(action)).toBe(true)
    expect(isActionResult(result)).toBe(true)
    expect(isComputerAction({ type: "type", target: { kind: "element", elementId: "name" } })).toBe(false)
    expect(isComputerAction({ type: "type", text: "hello" })).toBe(true)
  })

  test("requires the key a key action declares and admits an unreported platform", () => {
    expect(isComputerAction({ type: "key", key: "ctrl+shift+s", modifiers: ["control", "shift"] })).toBe(true)
    expect(isComputerAction({ type: "key", keys: "ctrl+shift+s" })).toBe(false)
    expect(isComputerInfo({ id: "computer-1", name: "Desktop", platform: "" })).toBe(true)
    expect(isComputerInfo({ id: "computer-1", name: "Desktop" })).toBe(false)
  })

  test("does not treat undeclared browser payloads as observations or elements", () => {
    expect(isObservation({ id: "observation-1", timestamp: 1, browser: { engine: "chromium" } })).toBe(true)
    expect(isObservation({ browser: { engine: "chromium" } })).toBe(false)
    expect(isUIElement({ browser: { engine: "chromium" } })).toBe(false)
  })

  test("validates references, scopes, provenance, and find results", () => {
    const reference = { elementId: "save", observationId: "observation-1", source: "accessibility" }
    const result = {
      query: "save",
      matches: [{ element: { id: "save", role: "button" }, reference, score: 1 }],
    }
    const provenance = { source: "accessibility", trust: "trusted", authority: "none" }

    expect(isElementReference(reference)).toBe(true)
    expect(isFindResult(result)).toBe(true)
    expect(isPermissionScope({ kind: "computer", actions: ["click"] })).toBe(true)
    expect(isProvenance(provenance)).toBe(true)
    expect(isVerification({ status: "inconclusive" })).toBe(true)
  })

  test("validates model and computer event envelopes", () => {
    const model = { id: "event-1", timestamp: 1, type: "model.started", model: "test" }
    const computer = {
      id: "event-2",
      timestamp: 2,
      type: "computer.action",
      action: { type: "wait", ms: 10 },
    }

    expect(isModelEvent(model)).toBe(true)
    expect(isComputerEvent(computer)).toBe(true)
    expect(isModelEvent({ id: "event-3", timestamp: 3, type: "unknown" })).toBe(false)
  })
})
