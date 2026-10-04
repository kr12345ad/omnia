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
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"

describe("memory store hardening", () => {
  test("deep-redacts metadata secrets", () => {
    const memory = store()
    const record = memory.write({
      scope: "user",
      text: "note",
      metadata: {
        nested: { token: "Bearer abcdefghijklmnop" },
        list: ["sk-abcdefghijklmnop123456"],
        plain: "ok",
      },
    })
    expect(JSON.stringify(record.metadata)).not.toContain("Bearer abcdefghijklmnop")
    expect(JSON.stringify(record.metadata)).not.toContain("sk-abcdefghijklmnop123456")
    expect(JSON.stringify(record.metadata)).toContain("[redacted]")
    expect(record.metadata?.redacted).toBe(true)
  })

  test("persists with owner-only permissions", () => {
    const dir = mkdtempSync(join(tmpdir(), "omnia-memory-"))
    const file = join(dir, "memories.json")
    new MemoryStore({ file }).write({ scope: "user", text: "private" })
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  test("upsert inherits the existing expiry when expiresInDays is omitted", () => {
    const memory = store()
    const first = memory.write({ scope: "session", key: "k", text: "one", expiresInDays: 2 })
    const second = memory.write({ scope: "session", key: "k", text: "two" })
    expect(second.id).toBe(first.id)
    expect(second.expiresAt).toBe(first.expiresAt)
  })

  test("deletes expired records on write and persists the purge", () => {
    const dir = mkdtempSync(join(tmpdir(), "omnia-memory-"))
    const file = join(dir, "memories.json")
    let now = 1_000_000
    const memory = new MemoryStore({ file, now: () => now })
    memory.write({ scope: "session", text: "temporary note", expiresInDays: 1 })
    now += 2 * 86400000
    memory.write({ scope: "user", text: "durable preference" })
    const persisted = JSON.parse(readFileSync(file, "utf8")) as { memories: Array<{ text: string }> }
    expect(persisted.memories.map((record) => record.text)).toEqual(["durable preference"])
    expect(memory.list(50, true).map((record) => record.text)).toEqual(["durable preference"])
    expect(new MemoryStore({ file }).list()).toHaveLength(1)
  })

  test("enforces maxRecords by evicting the lowest-confidence records", () => {
    const dir = mkdtempSync(join(tmpdir(), "omnia-memory-"))
    const file = join(dir, "memories.json")
    const memory = new MemoryStore({ file, maxRecords: 3 })
    memory.write({ scope: "user", text: "high value", confidence: 0.9 })
    for (let index = 0; index < 4; index += 1) {
      memory.write({ scope: "task", text: `low value ${index}`, confidence: index / 10 })
    }
    const live = memory.list(50, true).map((record) => record.text)
    expect(live).toHaveLength(3)
    expect(live).toContain("high value")
    expect(live).not.toContain("low value 0")
    const persisted = JSON.parse(readFileSync(file, "utf8")) as { memories: Array<{ text: string }> }
    expect(persisted.memories).toHaveLength(3)
    expect(memory.stats().total).toBe(3)
  })

  test("normalizes malformed persisted records instead of breaking", () => {
    const dir = mkdtempSync(join(tmpdir(), "omnia-memory-"))
    const file = join(dir, "memories.json")
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        memories: [
          { id: "good", scope: "user", text: "fine" },
          { id: "bad-confidence", scope: "user", text: "nan-ish", confidence: "high", updatedAt: null, tags: [1, 2] },
          { id: 5, scope: "user", text: "bad id" },
          { id: "bad-scope", scope: "nope", text: "bad scope" },
        ],
      }),
    )
    const memory = new MemoryStore({ file })
    expect(memory.get("good")?.text).toBe("fine")
    const normalized = memory.get("bad-confidence")
    expect(normalized?.confidence).toBe(0.8)
    expect(normalized?.tags).toBeUndefined()
    expect(Number.isFinite(normalized?.updatedAt ?? Number.NaN)).toBe(true)
    expect(memory.get("bad-scope")).toBeUndefined()
    expect(memory.list()).toHaveLength(2)
  })

  test("redacts bearer tokens, token assignments, JWTs, and AWS secret keys", () => {
    expect(redactMemoryText("Bearer abcdefghijklmnop").redacted).toBe(true)
    expect(redactMemoryText("token: abcdefghijkl").redacted).toBe(true)
    expect(redactMemoryText("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature123").redacted).toBe(true)
    expect(redactMemoryText("aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY").redacted).toBe(true)
  })

  test("forget removes every matching record, not just the first 100", () => {
    const memory = store()
    for (let index = 0; index < 150; index += 1) {
      memory.write({ scope: "task", text: `supplier note ${index}` })
    }
    expect(memory.forget({ query: "supplier" })).toBe(150)
    expect(memory.list()).toHaveLength(0)
  })

  test("tag filtering is case-insensitive", () => {
    const memory = store()
    memory.write({ scope: "user", text: "prefers CSV", tags: ["Capability"] })
    expect(memory.search({ tags: ["capability"] })).toHaveLength(1)
  })

  test("re-upserting a lapsed memory stores it instead of returning it dropped", () => {
    const dir = mkdtempSync(join(tmpdir(), "omnia-memory-"))
    const file = join(dir, "memories.json")
    let now = 1_000_000
    const memory = new MemoryStore({ file, now: () => now })
    memory.write({ scope: "session", key: "k", text: "one", expiresInDays: 1 })
    now += 2 * 86400000
    const revived = memory.write({ scope: "session", key: "k", text: "two" })
    expect(revived.expiresAt).toBeUndefined()
    expect(memory.get(revived.id)?.text).toBe("two")
    expect(memory.list()).toHaveLength(1)
    expect(new MemoryStore({ file, now: () => now }).list()).toHaveLength(1)
  })

  test("maxRecords never evicts the record a write just returned", () => {
    const dir = mkdtempSync(join(tmpdir(), "omnia-memory-"))
    const file = join(dir, "memories.json")
    const memory = new MemoryStore({ file, maxRecords: 2 })
    memory.write({ scope: "user", text: "high value", confidence: 0.9 })
    memory.write({ scope: "user", text: "also high", confidence: 0.8 })
    const low = memory.write({ scope: "task", text: "low value", confidence: 0 })
    expect(memory.get(low.id)?.text).toBe("low value")
    expect(memory.list()).toHaveLength(2)
    expect(new MemoryStore({ file, maxRecords: 2 }).get(low.id)?.text).toBe("low value")
  })

  test("a non-finite confidence cannot make a memory unfindable", () => {
    const memory = store()
    const record = memory.write({ scope: "user", text: "prefers CSV exports", confidence: Number.NaN })
    expect(Number.isFinite(record.confidence)).toBe(true)
    expect(memory.search({ query: "csv" })).toHaveLength(1)
  })
})

describe("memory store durability", () => {
  test("refuses to start from an unreadable file instead of discarding it", () => {
    const dir = mkdtempSync(join(tmpdir(), "omnia-memory-"))
    const file = join(dir, "memories.json")
    // A torn write: the shape a crash mid-save leaves behind.
    writeFileSync(file, '{"version": 1, "memories": [{"id": "kept", "scope": "user", "text": "pri')

    expect(() => new MemoryStore({ file })).toThrow("memories.json.corrupt")
    expect(existsSync(file)).toBe(false)
    expect(readFileSync(`${file}.corrupt`, "utf8")).toContain('"id": "kept"')
  })

  test("refuses to start from a file that is not an object", () => {
    const dir = mkdtempSync(join(tmpdir(), "omnia-memory-"))
    const file = join(dir, "memories.json")
    // Valid JSON, wrong shape: reading `.memories` off it used to throw a raw
    // TypeError and skip the .corrupt preservation entirely.
    writeFileSync(file, "null")

    expect(() => new MemoryStore({ file })).toThrow("memories.json.corrupt")
    expect(readFileSync(`${file}.corrupt`, "utf8")).toBe("null")
  })

  test("leaves no temp file behind when saving", () => {
    const dir = mkdtempSync(join(tmpdir(), "omnia-memory-"))
    const file = join(dir, "memories.json")
    const memory = new MemoryStore({ file })
    memory.write({ scope: "user", text: "private" })
    memory.write({ scope: "user", text: "another" })
    expect(readdirSync(dir)).toEqual(["memories.json"])
  })
})
