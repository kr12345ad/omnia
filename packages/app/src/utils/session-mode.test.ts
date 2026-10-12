import { describe, expect, test } from "bun:test"
import {
  DEFAULT_SESSION_MODE,
  knownSessionMode,
  resolveSessionMode,
  sessionModeControl,
  sessionModeFromMetadata,
  sessionModeMetadata,
} from "./session-mode"

describe("session mode", () => {
  test("stamps the mode under the shared metadata key", () => {
    expect(sessionModeMetadata("work")).toEqual({ mode: "work" })
    expect(sessionModeMetadata("chat")).toEqual({ mode: "chat" })
  })

  test("reads only known modes back from metadata", () => {
    expect(sessionModeFromMetadata(sessionModeMetadata("chat"))).toBe("chat")
    expect(sessionModeFromMetadata({ mode: "unexpected" })).toBeUndefined()
    expect(sessionModeFromMetadata({})).toBeUndefined()
    expect(sessionModeFromMetadata(undefined)).toBeUndefined()
  })

  test("reads the retired code mode as chat so old sessions and drafts still open", () => {
    expect(knownSessionMode("code")).toBe("chat")
    expect(sessionModeFromMetadata({ mode: "code" })).toBe("chat")
    expect(resolveSessionMode({ metadata: { mode: "code" } })).toBe("chat")
  })

  test("immutability: the recorded mode wins over the next-session selection", () => {
    const session = { metadata: sessionModeMetadata("work") }
    expect(resolveSessionMode({ stored: "chat", metadata: session.metadata })).toBe("work")
    expect(resolveSessionMode({ metadata: session.metadata, fallback: "chat" })).toBe("work")
  })

  test("falls back stored and default modes in order", () => {
    expect(resolveSessionMode({ stored: "chat" })).toBe("chat")
    expect(resolveSessionMode({ fallback: "chat" })).toBe("chat")
    expect(resolveSessionMode({})).toBe(DEFAULT_SESSION_MODE)
  })

  test("immutability: a viewed session keeps its mode when the selection changes", () => {
    expect(sessionModeControl({ session: "work", selected: "work" })).toEqual({ mode: "work", fixed: true })
    expect(sessionModeControl({ session: "work", selected: "chat" })).toEqual({ mode: "work", fixed: true })
    expect(sessionModeControl({ session: "chat", selected: "work" })).toEqual({ mode: "chat", fixed: true })
    expect(sessionModeControl({ selected: "chat" })).toEqual({ mode: "chat", fixed: false })
  })
})
