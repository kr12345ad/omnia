import { describe, expect, test } from "bun:test"
import {
  DEFAULT_SESSION_MODE,
  resolveSessionMode,
  sessionModeControl,
  sessionModeFromMetadata,
  sessionModeMetadata,
} from "./session-mode"

describe("session mode", () => {
  test("stamps the mode under the shared metadata key", () => {
    expect(sessionModeMetadata("work")).toEqual({ mode: "work" })
    expect(sessionModeMetadata("code")).toEqual({ mode: "code" })
  })

  test("reads only known modes back from metadata", () => {
    expect(sessionModeFromMetadata(sessionModeMetadata("code"))).toBe("code")
    expect(sessionModeFromMetadata({ mode: "unexpected" })).toBeUndefined()
    expect(sessionModeFromMetadata({})).toBeUndefined()
    expect(sessionModeFromMetadata(undefined)).toBeUndefined()
  })

  test("immutability: the recorded mode wins over the next-session selection", () => {
    const session = { metadata: sessionModeMetadata("work") }
    expect(resolveSessionMode({ stored: "code", metadata: session.metadata })).toBe("work")
    expect(resolveSessionMode({ metadata: session.metadata, fallback: "code" })).toBe("work")
  })

  test("falls back stored and default modes in order", () => {
    expect(resolveSessionMode({ stored: "code" })).toBe("code")
    expect(resolveSessionMode({ fallback: "code" })).toBe("code")
    expect(resolveSessionMode({})).toBe(DEFAULT_SESSION_MODE)
  })

  test("immutability: a viewed session keeps its mode when the selection changes", () => {
    expect(sessionModeControl({ session: "work", selected: "work" })).toEqual({ mode: "work", fixed: true })
    expect(sessionModeControl({ session: "work", selected: "code" })).toEqual({ mode: "work", fixed: true })
    expect(sessionModeControl({ session: "code", selected: "work" })).toEqual({ mode: "code", fixed: true })
    expect(sessionModeControl({ selected: "code" })).toEqual({ mode: "code", fixed: false })
  })
})
