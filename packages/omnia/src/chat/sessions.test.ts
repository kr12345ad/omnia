import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ChatSessionStore } from "./sessions"

function tempFile() {
  const dir = mkdtempSync(join(tmpdir(), "omnia-chat-sessions-"))
  return { file: join(dir, "sessions.json"), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

describe("the chat session store", () => {
  test("binds a conversation to a session and survives a reload", () => {
    const { file, cleanup } = tempFile()
    try {
      new ChatSessionStore({ file }).bind("discord:C1", "ses_1")
      expect(new ChatSessionStore({ file }).get("discord:C1")).toBe("ses_1")
    } finally {
      cleanup()
    }
  })

  test("each conversation is independent", () => {
    const { file, cleanup } = tempFile()
    try {
      const store = new ChatSessionStore({ file })
      store.bind("discord:C1", "ses_1")
      store.bind("discord:thread-9", "ses_2")
      expect(store.get("discord:C1")).toBe("ses_1")
      expect(store.get("discord:thread-9")).toBe("ses_2")
      expect(store.get("discord:C2")).toBeUndefined()
    } finally {
      cleanup()
    }
  })

  test("clear forgets one conversation and says whether it had one", () => {
    const { file, cleanup } = tempFile()
    try {
      const store = new ChatSessionStore({ file })
      store.bind("discord:C1", "ses_1")
      expect(store.clear("discord:C1")).toBe(true)
      expect(store.clear("discord:C1")).toBe(false)
      expect(store.get("discord:C1")).toBeUndefined()
    } finally {
      cleanup()
    }
  })

  test("a chosen model survives a reload and outlives /new", () => {
    const { file, cleanup } = tempFile()
    try {
      const store = new ChatSessionStore({ file })
      store.bind("discord:C1", "ses_1")
      store.setModel("discord:C1", { providerID: "anthropic", modelID: "claude-sonnet-4" })
      // Starting a fresh session keeps the model: it is a preference, not part
      // of the conversation being reset.
      store.clear("discord:C1")
      const reloaded = new ChatSessionStore({ file })
      expect(reloaded.get("discord:C1")).toBeUndefined()
      expect(reloaded.getModel("discord:C1")).toEqual({ providerID: "anthropic", modelID: "claude-sonnet-4" })
      expect(reloaded.clearModel("discord:C1")).toBe(true)
      expect(new ChatSessionStore({ file }).getModel("discord:C1")).toBeUndefined()
    } finally {
      cleanup()
    }
  })

  test("a file written before models existed still loads", () => {
    const { file, cleanup } = tempFile()
    try {
      writeFileSync(file, JSON.stringify({ conversations: { "discord:C1": { sessionId: "ses_1", updatedAt: 1 } } }))
      const store = new ChatSessionStore({ file })
      expect(store.get("discord:C1")).toBe("ses_1")
      expect(store.getModel("discord:C1")).toBeUndefined()
    } finally {
      cleanup()
    }
  })

  test("a corrupt file is ignored instead of breaking every channel", () => {
    const { file, cleanup } = tempFile()
    try {
      writeFileSync(file, "{ not json")
      expect(new ChatSessionStore({ file }).get("discord:C1")).toBeUndefined()
      const reloaded = new ChatSessionStore({ file })
      reloaded.bind("discord:C1", "ses_ok")
      expect(JSON.parse(readFileSync(file, "utf8")).conversations["discord:C1"].sessionId).toBe("ses_ok")
    } finally {
      cleanup()
    }
  })
})
