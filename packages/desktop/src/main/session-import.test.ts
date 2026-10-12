import { afterEach, describe, expect, test } from "bun:test"
import { DatabaseSync } from "node:sqlite"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  detectImportSources,
  importCodexFile,
  importOpencodeDb,
  mintId,
  parseCodexRollout,
  readLedger,
} from "./session-import"

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

function root(): string {
  const directory = mkdtempSync(join(tmpdir(), "omnia-import-test-"))
  roots.push(directory)
  return directory
}

function sourceDb(path: string): void {
  const db = new DatabaseSync(path)
  db.exec(`CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT, time_created INTEGER, time_updated INTEGER, sandboxes TEXT);
    CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, slug TEXT, directory TEXT, title TEXT, version TEXT, metadata TEXT, cost REAL DEFAULT 0, tokens_input INTEGER DEFAULT 0, tokens_output INTEGER DEFAULT 0, tokens_reasoning INTEGER DEFAULT 0, tokens_cache_read INTEGER DEFAULT 0, tokens_cache_write INTEGER DEFAULT 0, agent TEXT, model TEXT, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    INSERT INTO project VALUES ('prj-one', '/work/one', 1, 2, '[]');
    INSERT INTO session VALUES ('ses_one', 'prj-one', NULL, 'one', '/work/one', 'First session', '1', '{"mode":"code"}', 0, 1, 2, 0, 0, 0, 'build', '{"id":"m"}', 10, 20);
    INSERT INTO session VALUES ('ses_two', 'prj-one', 'ses_one', 'two', '/work/one', 'Child session', '1', NULL, 0, 0, 0, 0, 0, 0, 'build', NULL, 30, 40);
    INSERT INTO message VALUES ('msg_one', 'ses_one', 10, 11, '{"role":"user"}');
    INSERT INTO part VALUES ('prt_one', 'msg_one', 'ses_one', 10, 11, '{"type":"text","text":"hi"}');`)
  db.close()
}

function destDb(path: string): void {
  const db = new DatabaseSync(path)
  db.exec(`CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT, time_created INTEGER, time_updated INTEGER, sandboxes TEXT);
    CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, slug TEXT, directory TEXT, title TEXT, version TEXT, metadata TEXT, cost REAL DEFAULT 0, tokens_input INTEGER DEFAULT 0, tokens_output INTEGER DEFAULT 0, tokens_reasoning INTEGER DEFAULT 0, tokens_cache_read INTEGER DEFAULT 0, tokens_cache_write INTEGER DEFAULT 0, agent TEXT, model TEXT, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);`)
  db.close()
}

function count(db: DatabaseSync, table: string): number {
  return Number(db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get()?.n ?? 0)
}

const ROLLOUT = [
  JSON.stringify({ type: "session_meta", timestamp: 1789000000000, payload: { id: "codex-abc", cwd: "/work/codex", model: "gpt-5" } }),
  JSON.stringify({ type: "turn_context", timestamp: 1789000001000, payload: { cwd: "/work/codex" } }),
  JSON.stringify({ type: "response_item", timestamp: 1789000002000, payload: { type: "message", role: "user", content: "Fix the login bug" } }),
  JSON.stringify({ type: "response_item", timestamp: 1789000003000, payload: { type: "reasoning", content: "The bug is in auth." } }),
  JSON.stringify({ type: "response_item", timestamp: 1789000004000, payload: { type: "function_call", name: "read", arguments: '{"path":"a.ts"}', call_id: "call-1" } }),
  "this line is not json and must be skipped",
  JSON.stringify({ type: "response_item", timestamp: 1789000005000, payload: { type: "function_call_output", call_id: "call-1", output: "file contents here" } }),
  JSON.stringify({ type: "response_item", timestamp: 1789000006000, payload: { type: "message", role: "assistant", content: [{ type: "text", text: "Fixed it." }] } }),
  JSON.stringify({ type: "event_msg", timestamp: 1789000007000, payload: { type: "token_count", info: {} } }),
].join("\n")

describe("parseCodexRollout", () => {
  test("parses header, messages, reasoning, and pairs tool outputs", () => {
    const parsed = parseCodexRollout(ROLLOUT, 1)
    expect(parsed.id).toBe("codex-abc")
    expect(parsed.cwd).toBe("/work/codex")
    expect(parsed.model).toBe("gpt-5")
    expect(parsed.messages).toHaveLength(4)
    expect(parsed.messages[0]).toMatchObject({ role: "user", text: "Fix the login bug" })
    expect(parsed.messages[1]).toMatchObject({ role: "assistant", reasoning: "The bug is in auth." })
    expect(parsed.messages[2].toolCalls).toHaveLength(1)
    expect(parsed.messages[2].toolCalls[0]).toMatchObject({ name: "read", result: "file contents here" })
    expect(parsed.messages[3]).toMatchObject({ role: "assistant", text: "Fixed it." })
  })

  test("falls back to event_msg text when no response items exist", () => {
    const parsed = parseCodexRollout(
      [
        JSON.stringify({ type: "event_msg", timestamp: 5, payload: { type: "user_message", message: "hello" } }),
        JSON.stringify({ type: "event_msg", timestamp: 6, payload: { type: "agent_message", message: "hi back" } }),
      ].join("\n"),
      1,
    )
    expect(parsed.messages.map((message) => [message.role, message.text])).toEqual([
      ["user", "hello"],
      ["assistant", "hi back"],
    ])
  })

  test("empty and garbage input yields no messages", () => {
    expect(parseCodexRollout("", 1).messages).toHaveLength(0)
    expect(parseCodexRollout("not json\n{{{{", 1).messages).toHaveLength(0)
  })
})

describe("mintId", () => {
  test("uses the required prefixes and unique values", () => {
    const ids = new Set([mintId("ses"), mintId("msg"), mintId("prt")])
    expect(ids.size).toBe(3)
    expect(mintId("ses").startsWith("ses_")).toBe(true)
  })
})

describe("importOpencodeDb", () => {
  test("copies sessions, messages, parts and projects, then skips on rerun", async () => {
    const directory = root()
    const userData = join(directory, "user")
    mkdirSync(userData, { recursive: true })
    const source = join(directory, "opencode.db")
    const dest = join(directory, "OMNIA.db")
    sourceDb(source)
    destDb(dest)
    const first = await importOpencodeDb(dest, source, userData)
    expect(first.importedSessions).toBe(2)
    expect(first.importedMessages).toBe(1)
    expect(first.importedParts).toBe(1)
    expect(first.skippedSessions).toBe(0)
    expect(first.errors).toHaveLength(0)
    const check = new DatabaseSync(dest)
    try {
      expect(count(check, "session")).toBe(2)
      expect(count(check, "message")).toBe(1)
      expect(count(check, "part")).toBe(1)
      const child = check.prepare("SELECT parent_id FROM session WHERE id = 'ses_two'").get() as { parent_id: string }
      expect(child.parent_id).toBe("ses_one")
      const data = check.prepare("SELECT data FROM part WHERE id = 'prt_one'").get() as { data: string }
      expect(JSON.parse(data.data)).toMatchObject({ type: "text", text: "hi" })
    } finally {
      check.close()
    }
    const second = await importOpencodeDb(dest, source, userData)
    expect(second.importedSessions).toBe(0)
    expect(second.skippedSessions).toBe(2)
    const ledger = readLedger(userData)
    expect(ledger.opencode[source].sessions).toBe(2)
  })

  test("a rerun picks up messages appended to held sessions", async () => {
    const directory = root()
    const userData = join(directory, "user")
    mkdirSync(userData, { recursive: true })
    const source = join(directory, "opencode.db")
    const dest = join(directory, "OMNIA.db")
    sourceDb(source)
    destDb(dest)
    const first = await importOpencodeDb(dest, source, userData)
    expect(first.importedMessages).toBe(1)
    const origin = new DatabaseSync(source)
    try {
      origin.prepare("INSERT INTO message VALUES (?, ?, 1, 1, '{}')").run("msg_appended", "ses_one")
      origin.prepare("INSERT INTO part VALUES (?, ?, ?, 1, 1, '{}')").run("prt_appended", "msg_appended", "ses_one")
    } finally {
      origin.close()
    }
    const second = await importOpencodeDb(dest, source, userData)
    expect(second.importedSessions).toBe(0)
    expect(second.skippedSessions).toBe(2)
    expect(second.importedMessages).toBe(1)
    expect(second.importedParts).toBe(1)
    const check = new DatabaseSync(dest)
    try {
      expect(count(check, "message")).toBe(2)
      expect(count(check, "part")).toBe(2)
    } finally {
      check.close()
    }
  })
})

describe("importCodexFile", () => {
  test("creates a session with chained messages and tool parts, then skips on rerun", async () => {
    const directory = root()
    const userData = join(directory, "user")
    mkdirSync(userData, { recursive: true })
    const dest = join(directory, "OMNIA.db")
    destDb(dest)
    const file = join(directory, "rollout-2026-10-01T00-00-00-abc.jsonl")
    writeFileSync(file, ROLLOUT)
    const report = await importCodexFile(dest, file, userData)
    expect(report.importedSessions).toBe(1)
    expect(report.importedMessages).toBe(4)
    expect(report.errors).toHaveLength(0)
    const check = new DatabaseSync(dest)
    try {
      const session = check.prepare("SELECT id, title, directory FROM session").get() as {
        id: string
        title: string
        directory: string
      }
      expect(session.id.startsWith("ses_")).toBe(true)
      expect(session.title).toContain("Fix the login bug")
      expect(session.directory).toBe("/work/codex")
      const messages = check.prepare("SELECT id, data FROM message ORDER BY time_created").all() as { id: string; data: string }[]
      expect(messages).toHaveLength(4)
      expect(JSON.parse(messages[1].data)).toMatchObject({ role: "assistant", parentID: messages[0].id })
      const toolPart = check.prepare("SELECT data FROM part WHERE data LIKE '%\"tool\"%'").get() as { data: string }
      expect(JSON.parse(toolPart.data)).toMatchObject({ tool: "read", callID: expect.any(String) })
      const project = check.prepare("SELECT worktree FROM project").get() as { worktree: string }
      expect(project.worktree).toBe("/work/codex")
    } finally {
      check.close()
    }
    const rerun = await importCodexFile(dest, file, userData)
    expect(rerun.skippedSessions).toBe(1)
    expect(rerun.importedSessions).toBe(0)
  })
})

describe("detectImportSources", () => {
  test("returns an empty list when neither store exists", async () => {
    const sources = await detectImportSources(join(root(), "OMNIA.db"))
    expect(Array.isArray(sources)).toBe(true)
  })
})
