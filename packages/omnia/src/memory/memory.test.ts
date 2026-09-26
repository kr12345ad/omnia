import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MemoryStore, redactMemoryText } from "./store"

function store(now?: () => number) {
  const dir = mkdtempSync(join(tmpdir(), "omnia-memory-"))
  return new MemoryStore({ file: join(dir, "memories.json"), ...(now === undefined ? {} : { now }) })
}

describe("memory store", () => {
  test("writes, searches, and ranks memories", () => {
    const memory = store()
    memory.write({ scope: "application", text: "soffice exposes menus and dialogs through accessibility.", application: "soffice", tags: ["capability"] })
    memory.write({ scope: "user", text: "The user prefers CSV exports named with the date." })
    memory.write({ scope: "task", text: "Supplier research: compare at least 20 suppliers by price." })

    const found = memory.search({ query: "supplier" })
    expect(found).toHaveLength(1)
    expect(found[0]?.scope).toBe("task")

    const byTag = memory.search({ query: "accessibility", tags: ["capability"] })
    expect(byTag[0]?.application).toBe("soffice")

    const byApplication = memory.search({ application: "soffice" })
    expect(byApplication).toHaveLength(1)

    expect(memory.search({ query: "nothing matches this" })).toHaveLength(0)
  })

  test("upserts by scope and key", () => {
    const memory = store()
    const first = memory.write({ scope: "application", key: "application:calc:coverage", text: "calc: 100 elements." })
    const second = memory.write({ scope: "application", key: "application:calc:coverage", text: "calc: 500 elements." })
    expect(second.id).toBe(first.id)
    expect(second.createdAt).toBe(first.createdAt)
    expect(memory.list()).toHaveLength(1)
    expect(memory.search({ key: "application:calc:coverage" })[0]?.text).toBe("calc: 500 elements.")
  })

  test("expires memories and reports stats", () => {
    let now = 1_000_000
    const memory = store(() => now)
    memory.write({ scope: "session", text: "temporary note", expiresInDays: 1 })
    memory.write({ scope: "user", text: "durable preference" })
    expect(memory.list()).toHaveLength(2)
    now += 2 * 86400000
    expect(memory.list()).toHaveLength(1)
    expect(memory.stats().byScope.user).toBe(1)
    expect(memory.stats().total).toBe(2)
  })

  test("forgets by query and removes by id", () => {
    const memory = store()
    const record = memory.write({ scope: "task", text: "obsolete plan" })
    expect(memory.remove(record.id)).toBe(true)
    expect(memory.remove(record.id)).toBe(false)
    memory.write({ scope: "task", text: "old supplier note" })
    memory.write({ scope: "task", text: "another supplier note" })
    expect(memory.forget({ query: "supplier" })).toBe(2)
    expect(memory.list()).toHaveLength(0)
  })

  test("redacts secrets before storing", () => {
    const memory = store()
    const record = memory.write({ scope: "user", text: "api_key = sk-abcdefghijklmnop123456" })
    expect(record.text).not.toContain("sk-abcdefghijklmnop123456")
    expect(record.text).toContain("[redacted]")
    expect(record.sensitivity).toBe("private")
    expect(redactMemoryText("password: hunter2").redacted).toBe(true)
    expect(redactMemoryText("plain note").redacted).toBe(false)
  })

  test("persists across instances", () => {
    const dir = mkdtempSync(join(tmpdir(), "omnia-memory-"))
    const file = join(dir, "memories.json")
    new MemoryStore({ file }).write({ scope: "workspace", text: "uses bun for scripts" })
    const reopened = new MemoryStore({ file })
    expect(reopened.search({ query: "bun" })[0]?.text).toBe("uses bun for scripts")
  })
})
