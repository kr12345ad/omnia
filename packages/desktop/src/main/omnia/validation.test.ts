import { describe, expect, test } from "bun:test"
import {
  assertOmniaPayloadSize,
  OMNIA_MAX_PAYLOAD_BYTES,
  OmniaSizeLimitError,
  parseOmniaEvent,
  parseOmniaExecuteRequest,
  parseOmniaFindRequest,
  parseOmniaObservation,
} from "./validation"

const target = { elementId: "button-save", generation: 4, observationId: "observation-1" }

describe("Omnia payload validation", () => {
  test("accepts only the bounded computer-control action schema", () => {
    expect(
      parseOmniaExecuteRequest({
        target,
        action: { type: "click", button: "left", count: 1 },
      }),
    ).toEqual({
      target,
      action: { type: "click", button: "left", count: 1, modifiers: undefined },
    })
    expect(() =>
      parseOmniaExecuteRequest({
        target,
        action: { type: "click" },
        command: "rm -rf /",
      }),
    ).toThrow("Invalid Omnia payload")
    expect(() =>
      parseOmniaExecuteRequest({
        target,
        action: { type: "shell", command: "echo unsafe" },
      }),
    ).toThrow("Invalid Omnia payload")
    expect(() =>
      parseOmniaExecuteRequest({
        target,
        action: { type: "paste", text: "unsafe" },
      }),
    ).toThrow("Invalid Omnia payload")
  })

  test("rejects oversized and accessor-backed payloads without reading accessors", () => {
    expect(() => assertOmniaPayloadSize({ value: "x".repeat(OMNIA_MAX_PAYLOAD_BYTES) })).toThrow(
      "Omnia payload exceeds size limits",
    )
    let read = false
    const payload = {}
    Object.defineProperty(payload, "query", {
      enumerable: true,
      get() {
        read = true
        return "Save"
      },
    })
    expect(() => parseOmniaFindRequest(payload)).toThrow("Invalid Omnia payload")
    expect(read).toBe(false)
  })

  test("carries a driver element reference and every declared action field through execute", () => {
    const reference = {
      kind: "element",
      elementId: "button-save",
      generation: 4,
      observationId: "observation-1",
      source: "accessibility",
      backend: "linux-uia",
      role: "button",
      locator: { path: [1, 2] },
      expiresAt: 1_700_000_000_000,
      metadata: { backendRef: "12" },
    }
    expect(
      parseOmniaExecuteRequest({
        target: reference,
        action: { type: "key", key: "ctrl+shift+s", keys: "ctrl+c", modifiers: ["control", "shift"] },
      }),
    ).toEqual({
      target: reference,
      action: { type: "key", key: "ctrl+shift+s", keys: "ctrl+c", modifiers: ["control", "shift"] },
    })
    expect(parseOmniaExecuteRequest({ target, action: { type: "scroll", direction: "down", amount: 3 } })).toEqual({
      target,
      action: { type: "scroll", direction: "down", deltaX: undefined, deltaY: undefined, amount: 3 },
    })
    expect(() => parseOmniaExecuteRequest({ target, action: { type: "scroll", direction: "sideways" } })).toThrow(
      "Invalid Omnia payload",
    )
    expect(() => parseOmniaExecuteRequest({ target, action: { type: "key", key: "ctrl+c; rm -rf /" } })).toThrow(
      "Invalid Omnia payload",
    )
    expect(() =>
      parseOmniaExecuteRequest({ target: { ...target, locator: { ref: () => "save" } }, action: { type: "focus" } }),
    ).toThrow("Invalid Omnia payload")
  })

  test("separates traversal overflow from a malformed result", () => {
    const deep: Record<string, unknown> = { id: "observation-1", timestamp: 1 }
    let cursor = deep
    for (let index = 0; index < 40; index++) {
      const child: Record<string, unknown> = {}
      cursor.child = child
      cursor = child
    }
    expect(() => parseOmniaObservation(deep)).toThrow(OmniaSizeLimitError)
    expect(() => parseOmniaObservation({ id: "observation-1", timestamp: 1, elements: [{ role: 3 }] })).toThrow(
      "Invalid Omnia result",
    )
  })

  test("requires a non-empty normalized find query", () => {
    expect(parseOmniaFindRequest({ query: "  Save  ", limit: 10 })).toEqual({
      query: "Save",
      role: undefined,
      name: undefined,
      window: undefined,
      source: undefined,
      backend: undefined,
      limit: 10,
      includeOffscreen: false,
      observationId: undefined,
    })
    expect(() => parseOmniaFindRequest({ query: "   " })).toThrow("Invalid Omnia payload")
  })

  test("carries the declared find window filter to the driver", () => {
    expect(parseOmniaFindRequest({ query: "Save", window: "Editor" }).window).toBe("Editor")
    expect(() => parseOmniaFindRequest({ query: "Save", window: "w".repeat(513) })).toThrow("Invalid Omnia payload")
  })

  test("projects native events to a bounded machine summary", () => {
    expect(
      parseOmniaEvent({
        id: "event-1",
        timestamp: 1,
        type: "computer.connected",
        computer: { id: "computer-1", name: "Desktop", platform: "linux" },
        shell: "unsafe",
      }),
    ).toEqual({ id: "event-1", timestamp: 1, type: "computer.connected", computerId: undefined, code: undefined })
    expect(parseOmniaEvent({ id: "event-1", timestamp: 1, type: "unknown.event" })).toBe(null)
    expect(
      parseOmniaEvent({
        id: "event-1",
        timestamp: 1,
        type: "computer.disconnected",
        computerId: "computer-1",
        code: "driver-closed",
      }),
    ).toEqual({
      id: "event-1",
      timestamp: 1,
      type: "computer.disconnected",
      computerId: "computer-1",
      code: "driver-closed",
    })
  })
})
