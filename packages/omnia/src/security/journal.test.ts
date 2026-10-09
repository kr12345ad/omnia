import { describe, expect, test } from "bun:test"
import { closeSync, ftruncateSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MAX_SECURITY_JOURNAL_BYTES, SecurityJournal } from "./journal"

describe("security journal", () => {
  test("authenticates records across restarts, uses private files, and redacts secrets", () => {
    const dir = mkdtempSync(join(tmpdir(), "omnia-journal-"))
    const file = join(dir, "audit.jsonl")
    try {
      const journal = new SecurityJournal(file)
      const head = journal.append({ type: "auth.failed", at: 1, serverId: "test", route: "/password=do-not-store" })
      journal.close()
      expect(statSync(file).mode & 0o777).toBe(0o600)
      expect(statSync(`${file}.key`).mode & 0o777).toBe(0o600)
      expect(readFileSync(file, "utf8")).not.toContain("do-not-store")
      const reopened = new SecurityJournal(file)
      reopened.append({ type: "request.completed", at: 2, serverId: "test", status: 403 })
      reopened.close()
      const rows = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line))
      expect(rows).toHaveLength(2)
      expect(rows[1].sequence).toBe(2)
      expect(rows[1].previous).toBe(head)
      rows[0].record.status = 200
      writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`)
      expect(() => new SecurityJournal(file)).toThrow("integrity")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("rejects concurrent writers and a symlink journal without modifying its target", () => {
    const dir = mkdtempSync(join(tmpdir(), "omnia-journal-"))
    const file = join(dir, "audit.jsonl")
    try {
      const journal = new SecurityJournal(file)
      expect(() => new SecurityJournal(file)).toThrow()
      journal.close()
      rmSync(file)
      const target = join(dir, "victim")
      writeFileSync(target, "untouched", { mode: 0o600 })
      symlinkSync(target, file)
      expect(() => new SecurityJournal(file)).toThrow()
      expect(readFileSync(target, "utf8")).toBe("untouched")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("record and journal capacity limits refuse writes without unbounded storage", () => {
    const dir = mkdtempSync(join(tmpdir(), "omnia-journal-"))
    const file = join(dir, "audit.jsonl")
    const journal = new SecurityJournal(file)
    try {
      expect(() => journal.append({ type: "x".repeat(9000), at: 1, serverId: "test" })).toThrow("capacity")
      expect(statSync(file).size).toBe(0)
      const fd = openSync(file, "r+")
      try {
        // A sparse file exercises the byte budget without allocating 64 MiB.
        ftruncateSync(fd, MAX_SECURITY_JOURNAL_BYTES)
      } finally {
        closeSync(fd)
      }
      expect(() => journal.append({ type: "request", at: 2, serverId: "test" })).toThrow("capacity")
      expect(statSync(file).size).toBe(MAX_SECURITY_JOURNAL_BYTES)
    } finally {
      journal.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
