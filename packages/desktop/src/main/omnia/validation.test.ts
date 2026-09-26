import { describe, expect, test } from "bun:test"
import {
  assertOmniaPayloadSize,
  OMNIA_MAX_PAYLOAD_BYTES,
  parseOmniaEvent,
  parseOmniaExecuteRequest,
  parseOmniaFindRequest,
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
      "Invalid Omnia payload",
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

  test("requires a non-empty normalized find query", () => {
    expect(parseOmniaFindRequest({ query: "  Save  ", limit: 10 })).toEqual({
      query: "Save",
      role: undefined,
      name: undefined,
      source: undefined,
      backend: undefined,
      limit: 10,
      includeOffscreen: false,
      observationId: undefined,
    })
    expect(() => parseOmniaFindRequest({ query: "   " })).toThrow("Invalid Omnia payload")
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
