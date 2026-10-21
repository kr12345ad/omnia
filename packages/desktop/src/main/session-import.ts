import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import type { DatabaseSync, SQLInputValue } from "node:sqlite"

// Brings session history from another install into this one. Two sources are
// read, never written: an OpenCode database (`opencode*.db`) and Codex CLI
// rollout transcripts (`~/.codex/sessions/**/rollout-*.jsonl`). Everything is
// inserted into the Omnia database with `INSERT OR IGNORE`, so importing twice
// adds only what is missing and an interrupted import resumes on the next run.
// See docs/session-import.md for the user-facing description.

export interface OpencodeSource {
  readonly kind: "opencode"
  readonly path: string
  readonly bytes: number
  readonly sessions: number
  readonly messages: number
  readonly oldest: number | null
  readonly newest: number | null
}

export interface CodexSource {
  readonly kind: "codex"
  readonly path: string
  readonly bytes: number
  readonly sessions: number
  readonly messages: number
  readonly oldest: number | null
  readonly newest: number | null
}

export type ImportSource = OpencodeSource | CodexSource

export interface ImportReport {
  readonly source: string
  readonly kind: "opencode" | "codex"
  readonly importedSessions: number
  readonly importedMessages: number
  readonly importedParts: number
  readonly skippedSessions: number
  readonly errors: string[]
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

function randomBase62(length: number): string {
  let result = ""
  while (result.length < length) {
    for (const byte of randomBytes(length - result.length)) {
      if (byte < 248) result += BASE62[byte % 62]
      if (result.length === length) break
    }
  }
  return result
}

export function mintId(prefix: "ses" | "msg" | "prt" | "prj"): string {
  return `${prefix}_${randomBase62(26)}`
}

function toSql(value: unknown): SQLInputValue {
  if (value === null || value === undefined) return null
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") return value
  if (typeof value === "boolean") return value ? 1 : 0
  if (value instanceof Uint8Array || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return value as SQLInputValue
  }
  return JSON.stringify(value)
}

function opencodeDbDir(): string {
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode")
}

function codexSessionsDir(): string {
  return join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions")
}

function listOpencodeDbs(): string[] {
  const data = opencodeDbDir()
  if (!existsSync(data)) return []
  try {
    return readdirSync(data)
      .filter((name) => /^opencode(?:-[\w.-]+)?\.db$/.test(name))
      .map((name) => join(data, name))
  } catch {
    return []
  }
}

async function previewOpencodeDb(path: string): Promise<OpencodeSource | undefined> {
  const { DatabaseSync } = await import("node:sqlite")
  let db
  try {
    db = new DatabaseSync(path, { readOnly: true })
  } catch {
    return undefined
  }
  try {
    const tables = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => String(row.name)),
    )
    if (!tables.has("session") || !tables.has("message")) return undefined
    const sessions = Number(db.prepare("SELECT COUNT(*) AS n FROM session").get()?.n ?? 0)
    const messages = Number(db.prepare("SELECT COUNT(*) AS n FROM message").get()?.n ?? 0)
    let oldest: number | null = null
    let newest: number | null = null
    try {
      const range = db.prepare("SELECT MIN(time_created) AS lo, MAX(time_created) AS hi FROM session").get() as
        | { lo: number | null; hi: number | null }
        | undefined
      oldest = typeof range?.lo === "number" ? range.lo : null
      newest = typeof range?.hi === "number" ? range.hi : null
    } catch {
      oldest = null
      newest = null
    }
    return { kind: "opencode", path, bytes: statSync(path).size, sessions, messages, oldest, newest }
  } catch {
    return undefined
  } finally {
    db.close()
  }
}

export interface CodexMessage {
  readonly role: "user" | "assistant"
  readonly text: string
  readonly reasoning: string
  readonly toolCalls: { readonly name: string; readonly args: string; readonly result: string }[]
  readonly time: number
}

export interface ParsedCodexRollout {
  readonly id: string | undefined
  readonly cwd: string | undefined
  readonly model: string | undefined
  readonly messages: CodexMessage[]
}

function toEpochMs(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e12 ? Math.round(value * 1000) : Math.round(value)
  if (typeof value === "string" && value.length > 0) {
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return parsed
  }
  return fallback
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((entry) => {
        if (typeof entry === "string") return entry
        if (typeof entry === "object" && entry !== null) {
          const text = (entry as { text?: unknown }).text
          return typeof text === "string" ? text : ""
        }
        return ""
      })
      .join("")
  }
  return ""
}

// Codex CLI rollout transcripts: one JSON object per line, {type, timestamp,
// payload}. Tolerates unknown shapes and version skew: only session_meta,
// response_item (message/reasoning/function_call[_output]) and event_msg
// (user_message/agent_message) are read, everything else is skipped.
export function parseCodexRollout(text: string, fallbackTime: number): ParsedCodexRollout {
  let id: string | undefined
  let cwd: string | undefined
  let model: string | undefined
  const outputs = new Map<string, string>()
  const messages: CodexMessage[] = []
  let sawResponseItems = false
  const eventFallback: CodexMessage[] = []
  const lines = text.split("\n")
  // First pass: header fields and tool outputs (outputs routinely arrive far
  // from their calls, so pairing needs the full file, not streaming order).
  for (const line of lines) {
    if (line.trim().length === 0 || line.length > 1024 * 1024) continue
    let record: { type?: unknown; payload?: unknown }
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof record !== "object" || record === null) continue
    const payload = (typeof record.payload === "object" && record.payload !== null ? record.payload : {}) as Record<
      string,
      unknown
    >
    if (record.type === "session_meta") {
      if (typeof payload.id === "string") id = payload.id
      if (typeof payload.cwd === "string") cwd = payload.cwd
      if (typeof payload.model === "string") model = payload.model
    } else if (record.type === "turn_context") {
      if (cwd === undefined && typeof payload.cwd === "string") cwd = payload.cwd
    } else if (record.type === "response_item") {
      sawResponseItems = true
      const kind = payload.type
      if (kind === "function_call_output" || kind === "custom_tool_call_output") {
        const callId = typeof payload.call_id === "string" ? payload.call_id : ""
        if (callId.length > 0) outputs.set(callId, textOf(payload.output ?? payload.result ?? ""))
      }
    }
  }
  // Second pass: messages in file order, with outputs already paired.
  for (const line of lines) {
    if (line.trim().length === 0 || line.length > 1024 * 1024) continue
    let record: { type?: unknown; timestamp?: unknown; payload?: unknown }
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof record !== "object" || record === null) continue
    const time = toEpochMs(record.timestamp, fallbackTime)
    const payload = (typeof record.payload === "object" && record.payload !== null ? record.payload : {}) as Record<
      string,
      unknown
    >
    switch (record.type) {
      case "response_item": {
        const kind = payload.type
        if (kind === "message") {
          const role = payload.role === "assistant" ? "assistant" : "user"
          const text = textOf(payload.content)
          if (text.length > 0) messages.push({ role, text, reasoning: "", toolCalls: [], time })
        } else if (kind === "reasoning") {
          const text = textOf(payload.content ?? payload.summary ?? payload.text)
          if (text.length > 0) messages.push({ role: "assistant", text: "", reasoning: text, toolCalls: [], time })
        } else if (kind === "function_call" || kind === "custom_tool_call") {
          const name = typeof payload.name === "string" ? payload.name : "tool"
          const callId = typeof payload.call_id === "string" ? payload.call_id : typeof payload.id === "string" ? payload.id : ""
          const args = payload.arguments ?? payload.input ?? ""
          messages.push({
            role: "assistant",
            text: "",
            reasoning: "",
            toolCalls: [{ name, args: typeof args === "string" ? args : JSON.stringify(args), result: outputs.get(callId) ?? "" }],
            time,
          })
        }
        break
      }
      case "event_msg": {
        const kind = payload.type
        if (kind === "user_message" || kind === "agent_message") {
          const text = typeof payload.message === "string" ? payload.message : textOf(payload.message)
          if (text.length > 0) {
            eventFallback.push({ role: kind === "user_message" ? "user" : "assistant", text, reasoning: "", toolCalls: [], time })
          }
        }
        break
      }
      default:
        break
    }
  }
  return { id, cwd, model, messages: sawResponseItems ? messages : eventFallback }
}

function listRolloutFiles(root: string, out: string[] = []): string[] {
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(root, entry.name)
    if (entry.isDirectory()) listRolloutFiles(full, out)
    else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) out.push(full)
  }
  return out
}

const MAX_ROLLOUT_BYTES = 50 * 1024 * 1024

async function previewCodexFile(path: string): Promise<CodexSource | undefined> {
  let stat
  try {
    stat = statSync(path)
  } catch {
    return undefined
  }
  if (stat.size > MAX_ROLLOUT_BYTES) {
    return { kind: "codex", path, bytes: stat.size, sessions: 1, messages: 0, oldest: null, newest: null }
  }
  let text
  try {
    text = readFileSync(path, "utf8")
  } catch {
    return undefined
  }
  const parsed = parseCodexRollout(text, Math.round(stat.mtimeMs))
  const times = parsed.messages.map((message) => message.time)
  return {
    kind: "codex",
    path,
    bytes: stat.size,
    sessions: 1,
    messages: parsed.messages.filter((message) => message.text.length > 0).length,
    oldest: times.length > 0 ? Math.min(...times) : null,
    newest: times.length > 0 ? Math.max(...times) : null,
  }
}

export async function detectImportSources(omniaDbPath?: string): Promise<ImportSource[]> {
  const sources: ImportSource[] = []
  for (const path of listOpencodeDbs()) {
    if (omniaDbPath !== undefined && resolve(path) === resolve(omniaDbPath)) continue
    const preview = await previewOpencodeDb(path)
    if (preview !== undefined && preview.sessions > 0) sources.push(preview)
  }
  const root = codexSessionsDir()
  for (const path of listRolloutFiles(root)) {
    const preview = await previewCodexFile(path)
    if (preview !== undefined && preview.messages > 0) sources.push(preview)
  }
  return sources.sort((a, b) => (b.newest ?? 0) - (a.newest ?? 0))
}

export interface ImportLedger {
  readonly version: 1
  readonly opencode: Record<string, { importedAt: number; sessions: number; messages: number }>
  readonly codex: Record<string, { sessionId: string; importedAt: number; messages: number }>
}

const LEDGER_NAME = "session-import.json"

export function ledgerPath(userDataPath: string): string {
  return join(userDataPath, LEDGER_NAME)
}

export function readLedger(userDataPath: string): ImportLedger {
  try {
    const parsed = JSON.parse(readFileSync(ledgerPath(userDataPath), "utf8"))
    if (typeof parsed === "object" && parsed !== null) {
      return {
        version: 1,
        opencode: typeof parsed.opencode === "object" && parsed.opencode !== null ? parsed.opencode : {},
        codex: typeof parsed.codex === "object" && parsed.codex !== null ? parsed.codex : {},
      }
    }
  } catch {
    // Missing or corrupt ledger imports everything the ids do not already cover.
  }
  return { version: 1, opencode: {}, codex: {} }
}

function writeLedger(userDataPath: string, ledger: ImportLedger): void {
  mkdirSync(userDataPath, { recursive: true })
  writeFileSync(ledgerPath(userDataPath), JSON.stringify(ledger, null, 2), { mode: 0o600 })
}

const SESSION_CHUNK = 50
const PAGE_ROWS = 2000
// Session history this installer knows how to carry over. `message` and `part`
// feed the timeline, `session_message` is the durable V2 history a continued
// session is resumed from, and `todo`/`session_share` carry state the session
// view reads back. Any other table with a `session_id` column is copied too, so
// a newer source schema does not silently lose a table this file predates.
const IMPORTED_SESSION_TABLES = ["message", "session_message", "todo", "part", "session_share"]
// `session_input` holds prompts an installation has admitted but not run yet.
// Importing another installation's pending prompts would re-run its unfinished
// work here, so it is deliberately not history.

function tableNames(db: DatabaseSync): Set<string> {
  return new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => String((row as { name: unknown }).name)),
  )
}

function columnNames(db: DatabaseSync, table: string): string[] {
  try {
    return db
      .prepare(`PRAGMA table_info("${table.replaceAll('"', '""')}")`)
      .all()
      .map((row) => String((row as { name: unknown }).name))
  } catch {
    return []
  }
}

// Copies an OpenCode database into the Omnia database. Every insert is
// `INSERT OR IGNORE` on a primary key, so a rerun only adds what is missing and
// an interrupted import can be started again without duplicating history.
// Source rows are read through column intersection and copied verbatim; the
// source database is opened read-only and never modified.
export async function importOpencodeDb(
  destDbPath: string,
  sourcePath: string,
  userDataPath: string,
): Promise<ImportReport> {
  const { DatabaseSync } = await import("node:sqlite")
  if (!existsSync(destDbPath)) throw new Error(`Omnia database not found: ${destDbPath}`)
  if (resolve(destDbPath) === resolve(sourcePath)) throw new Error("Source and destination are the same database")
  const dest = new DatabaseSync(destDbPath)
  const source = new DatabaseSync(sourcePath, { readOnly: true })
  let importedSessions = 0
  let importedMessages = 0
  let importedParts = 0
  let skippedSessions = 0
  try {
    // The app keeps its own connection to this database while an import runs,
    // so wait for its writer instead of failing the whole import with SQLITE_BUSY.
    dest.exec("PRAGMA busy_timeout = 5000")
    const destinationTables = tableNames(dest)
    const sourceTables = tableNames(source)
    const sourceColumns = new Map<string, Set<string>>()
    const columnsIn = (table: string) => {
      const cached = sourceColumns.get(table)
      if (cached !== undefined) return cached
      const columns = new Set(columnNames(source, table))
      sourceColumns.set(table, columns)
      return columns
    }
    // Shapes are cached by column list, so every row of a table reuses one
    // prepared statement: preparing per row was the dominant cost on large histories.
    const statements = new Map<string, { run: (...params: SQLInputValue[]) => { changes: number | bigint } }>()
    const insertRow = (table: string, names: string[], values: Record<string, unknown>) => {
      const key = `${table}:${names.join(",")}`
      let statement = statements.get(key)
      if (statement === undefined) {
        statement = dest.prepare(
          `INSERT OR IGNORE INTO "${table}" (${names.map((name) => `"${name}"`).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
        )
        statements.set(key, statement)
      }
      return Number(statement.run(...names.map((name) => toSql(values[name]))).changes) > 0
    }
    const sharedColumns = (table: string) => {
      if (!sourceTables.has(table) || !destinationTables.has(table)) return []
      const sourceNames = columnsIn(table)
      return columnNames(dest, table).filter((name) => sourceNames.has(name) && name !== "rowid")
    }
    const sessions = (source.prepare("SELECT * FROM session").all() as Record<string, unknown>[]).filter(
      (row): row is Record<string, unknown> & { id: string } => typeof row.id === "string",
    )

    // Projects and their directories come first: sessions reference them, and a
    // session whose source project row is gone still needs a row to stay reachable.
    dest.exec("BEGIN IMMEDIATE")
    try {
      const projectIds = new Set(
        sessions.flatMap((session) => (typeof session.project_id === "string" ? [session.project_id] : [])),
      )
      const projectColumns = sharedColumns("project")
      const directoryColumns = sharedColumns("project_directory")
      for (const projectId of projectIds) {
        if (projectColumns.length > 0) {
          const row = sourceTables.has("project")
            ? (source.prepare("SELECT * FROM project WHERE id = ?").get(projectId) as
                | Record<string, unknown>
                | undefined)
            : undefined
          insertRow("project", projectColumns, row ?? placeholderProject(projectId, sessions))
        }
        if (directoryColumns.length === 0) continue
        for (const row of source
          .prepare("SELECT * FROM project_directory WHERE project_id = ?")
          .all(projectId) as Record<string, unknown>[]) {
          insertRow("project_directory", directoryColumns, row)
        }
      }
      dest.exec("COMMIT")
    } catch (error) {
      try {
        dest.exec("ROLLBACK")
      } catch {
        // Already rolled back or never began; the error below carries the cause.
      }
      throw error
    }

    // Databases created before the `session_v2` → `session` rename can keep a
    // foreign key from `session_message` to the old `session_v2` table. Mirror
    // each imported session there when the constraint still points at it, so a
    // session's durable history can be inserted instead of failing every row.
    const messageParent = (() => {
      try {
        const link = dest
          .prepare("PRAGMA foreign_key_list(session_message)")
          .all()
          .find((entry) => String((entry as { from: unknown }).from) === "session_id")
        return link === undefined ? "session" : String((link as { table: unknown }).table)
      } catch {
        return "session"
      }
    })()
    const mirrorColumns =
      messageParent !== "session" && destinationTables.has(messageParent)
        ? columnNames(dest, messageParent).filter((name) => name !== "rowid")
        : []

    // History tables beyond the three this file names explicitly, so a newer
    // source schema loses nothing just because a table was added there first.
    const historyTables = [
      ...IMPORTED_SESSION_TABLES,
      ...[...destinationTables]
        .filter(
          (table) =>
            table !== "session_input" &&
            !IMPORTED_SESSION_TABLES.includes(table) &&
            ["session", "project", "project_directory"].indexOf(table) === -1 &&
            columnNames(dest, table).includes("session_id") &&
            columnsIn(table).has("session_id"),
        )
        .sort(),
    ].filter((table) => sharedColumns(table).length > 0)

    // Sessions commit in bounded chunks: a two-gigabyte source would otherwise
    // hold one enormous write transaction (and its WAL) open for minutes, and a
    // failure partway through would throw away every chunk that had succeeded.
    for (let start = 0; start < sessions.length; start += SESSION_CHUNK) {
      const chunk = sessions.slice(start, start + SESSION_CHUNK)
      const ids = chunk.map((session) => session.id)
      dest.exec("BEGIN IMMEDIATE")
      try {
        const sessionColumns = sharedColumns("session")
        const heldSession = dest.prepare("SELECT 1 AS present FROM session WHERE id = ?")
        for (const session of chunk) {
          if (insertRow("session", sessionColumns, session)) {
            importedSessions += 1
            continue
          }
          // `INSERT OR IGNORE` also swallows a NOT NULL violation, which would
          // otherwise surface much later as a foreign key error on a child row.
          if (heldSession.get(session.id) === undefined) {
            throw new Error(`session ${session.id} has no value for a required column`)
          }
        }
        if (mirrorColumns.length > 0) {
          for (const session of chunk) {
            const names = mirrorColumns.filter((name) => name in session)
            if (names.length > 0) insertRow(messageParent, names, session)
          }
        }
        const placeholders = new Array(ids.length).fill("?").join(", ")
        for (const table of historyTables) {
          const names = sharedColumns(table)
          // Pages are read by rowid rather than in one result: a chunk of
          // sessions can own a gigabyte of tool output, and materializing all of
          // it at once peaked the import over a gigabyte of memory.
          const page = source.prepare(
            `SELECT rowid AS import_rowid, ${names.map((name) => `"${name}"`).join(", ")} FROM "${table}" WHERE session_id IN (${placeholders}) AND rowid > ? ORDER BY rowid LIMIT ${PAGE_ROWS}`,
          )
          // A table naming its own failure is the difference between "the
          // import failed" and "the import failed on session_message".
          try {
            let cursor = 0
            while (true) {
              const rows = page.all(...ids, cursor) as Record<string, unknown>[]
              if (rows.length === 0) break
              for (const row of rows) {
                cursor = Number(row.import_rowid)
                try {
                  if (!insertRow(table, names, row)) continue
                } catch (error) {
                  throw new Error(
                    `${table} row ${String(row.id ?? row.message_id ?? row.session_id ?? "?")}: ${error instanceof Error ? error.message : String(error)}`,
                  )
                }
                if (table === "message") importedMessages += 1
                else if (table === "part") importedParts += 1
              }
              if (rows.length < PAGE_ROWS) break
            }
          } catch (error) {
            throw new Error(
              `${error instanceof Error ? error.message : String(error)} (${table}, sessions ${start}-${start + chunk.length})`,
            )
          }
        }
        dest.exec("COMMIT")
      } catch (error) {
        try {
          dest.exec("ROLLBACK")
        } catch {
          // Already rolled back or never began; the error below carries the cause.
        }
        // Rows committed by earlier chunks stay: they are valid history and a
        // rerun continues from the first missing row.
        throw error
      }
    }
    skippedSessions = sessions.length - importedSessions
    // A large import writes everything through the WAL; fold it back so the next
    // launch does not begin behind a multi-hundred-megabyte journal. A reader
    // holding the database (the app itself) only makes this a no-op.
    try {
      dest.exec("PRAGMA wal_checkpoint(TRUNCATE)")
    } catch {
      // Not fatal: the next checkpoint finishes the same work.
    }
  } finally {
    source.close()
    dest.close()
  }
  const ledger = readLedger(userDataPath)
  const previous = ledger.opencode[sourcePath]
  writeLedger(userDataPath, {
    ...ledger,
    opencode: {
      ...ledger.opencode,
      [sourcePath]: {
        importedAt: Date.now(),
        sessions: (previous?.sessions ?? 0) + importedSessions,
        messages: (previous?.messages ?? 0) + importedMessages,
      },
    },
  })
  return { source: sourcePath, kind: "opencode", importedSessions, importedMessages, importedParts, skippedSessions, errors: [] }
}

// A project row built from the session that points at it, used when the source
// database no longer holds the project record itself.
function placeholderProject(id: string, sessions: (Record<string, unknown> & { id: string })[]) {
  const directory = sessions.find(
    (session) => session.project_id === id && typeof session.directory === "string",
  )?.directory
  const now = Date.now()
  return {
    id,
    worktree: typeof directory === "string" && directory.length > 0 ? directory : homedir(),
    vcs: null,
    name: null,
    sandboxes: "[]",
    time_created: now,
    time_updated: now,
  }
}

// Codex stores tool arguments as a JSON string. Decode them when possible and
// fall back to keeping the raw text under one key, so the part still renders.
function toolInput(args: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(args)
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return { arguments: parsed }
  } catch {
    return { arguments: args }
  }
}

function titleOf(firstUserText: string | undefined, fallback: string): string {
  if (firstUserText === undefined) return fallback
  const line = firstUserText.split("\n", 1)[0].trim()
  if (line.length === 0) return fallback
  return line.length > 80 ? `${line.slice(0, 77)}…` : line
}

export async function importCodexFile(
  destDbPath: string,
  filePath: string,
  userDataPath: string,
  projectId?: string,
): Promise<ImportReport> {
  const errors: string[] = []
  const ledger = readLedger(userDataPath)
  if (ledger.codex[filePath] !== undefined) {
    return { source: filePath, kind: "codex", importedSessions: 0, importedMessages: 0, importedParts: 0, skippedSessions: 1, errors }
  }
  let stat
  try {
    stat = statSync(filePath)
  } catch {
    return { source: filePath, kind: "codex", importedSessions: 0, importedMessages: 0, importedParts: 0, skippedSessions: 0, errors: [`cannot read ${filePath}`] }
  }
  if (stat.size > MAX_ROLLOUT_BYTES) {
    return { source: filePath, kind: "codex", importedSessions: 0, importedMessages: 0, importedParts: 0, skippedSessions: 0, errors: [`${filePath} is larger than 50 MB; split it before importing`] }
  }
  const parsed = parseCodexRollout(readFileSync(filePath, "utf8"), Math.round(stat.mtimeMs))
  if (parsed.messages.length === 0) {
    return { source: filePath, kind: "codex", importedSessions: 0, importedMessages: 0, importedParts: 0, skippedSessions: 1, errors: [`no importable messages in ${filePath}`] }
  }
  const { DatabaseSync } = await import("node:sqlite")
  if (!existsSync(destDbPath)) throw new Error(`Omnia database not found: ${destDbPath}`)
  const dest = new DatabaseSync(destDbPath)
  const sessionId = mintId("ses")
  let importedMessages = 0
  let importedParts = 0
  try {
    dest.exec("PRAGMA busy_timeout = 5000")
    const sessionColumns = columnNames(dest, "session")
    const messageColumns = columnNames(dest, "message")
    const partColumns = columnNames(dest, "part")
    const cwd = parsed.cwd ?? dirname(filePath)
    let resolvedProject = projectId
    if (resolvedProject === undefined) {
      try {
        const match = dest.prepare("SELECT id FROM project WHERE worktree = ? LIMIT 1").get(cwd) as { id: string } | undefined
        resolvedProject = match?.id
      } catch {
        resolvedProject = undefined
      }
    }
    const now = Date.now()
    if (resolvedProject === undefined) {
      resolvedProject = mintId("prj")
      if (sessionColumns.includes("project_id")) {
        const names = ["id", "worktree", "time_created", "time_updated", "sandboxes"].filter((name) =>
          columnNames(dest, "project").includes(name),
        )
        dest
          .prepare(`INSERT OR IGNORE INTO project (${names.map((n) => `"${n}"`).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`)
          .run(
            ...names.map((name) =>
              toSql(name === "id" ? resolvedProject : name === "worktree" ? cwd : name === "sandboxes" ? "[]" : now),
            ),
          )
      }
    }
    const firstUser = parsed.messages.find((message) => message.role === "user" && message.text.length > 0)?.text
    const created = parsed.messages[0]?.time ?? now
    const updated = parsed.messages[parsed.messages.length - 1]?.time ?? created
    // `session.model` is a JSON column holding the selected model, not a plain
    // model id: writing a bare string there makes the session list undecodable.
    const model = { id: parsed.model ?? "codex", providerID: "codex" }
    const sessionRow: Record<string, unknown> = {
      id: sessionId,
      project_id: resolvedProject,
      slug: `codex-${basename(filePath, ".jsonl").slice(-12)}`,
      directory: cwd,
      title: titleOf(firstUser, `Codex session ${new Date(created).toLocaleDateString()}`),
      version: "1",
      metadata: { mode: "code", importedFrom: "codex", sourceFile: filePath, codexId: parsed.id ?? null },
      cost: 0,
      tokens_input: 0,
      tokens_output: 0,
      tokens_reasoning: 0,
      tokens_cache_read: 0,
      tokens_cache_write: 0,
      agent: "build",
      model,
      time_created: created,
      time_updated: updated,
    }
    const sessionNames = sessionColumns.filter((name) => name in sessionRow)
    dest.exec("BEGIN IMMEDIATE")
    try {
      dest
        .prepare(`INSERT OR IGNORE INTO session (${sessionNames.map((n) => `"${n}"`).join(", ")}) VALUES (${sessionNames.map(() => "?").join(", ")})`)
        .run(...sessionNames.map((name) => toSql(sessionRow[name])))
      // Message rows must decode as `SessionV1.Info`: a user message needs an
      // agent and model, an assistant message needs its parent, model, mode,
      // path, cost and tokens. Rows missing those fields render as broken turns.
      let parentId: string | undefined
      let clock = created
      for (const message of parsed.messages) {
        clock = Math.max(clock + 1, message.time)
        const messageId = mintId("msg")
        const isUser = message.role === "user"
        const messageRow: Record<string, unknown> = {
          id: messageId,
          session_id: sessionId,
          time_created: clock,
          time_updated: clock,
          data: {
            role: message.role,
            ...(isUser
              ? { agent: "build", model: { providerID: model.providerID, modelID: model.id } }
              : {
                  parentID: parentId ?? messageId,
                  mode: "code",
                  agent: "build",
                  modelID: model.id,
                  providerID: model.providerID,
                  path: { cwd, root: cwd },
                  cost: 0,
                  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                }),
            time: { created: clock, ...(isUser ? {} : { completed: clock }) },
          },
        }
        const messageNames = messageColumns.filter((name) => name in messageRow)
        dest
          .prepare(`INSERT OR IGNORE INTO message (${messageNames.map((n) => `"${n}"`).join(", ")}) VALUES (${messageNames.map(() => "?").join(", ")})`)
          .run(...messageNames.map((name) => toSql(messageRow[name])))
        parentId = messageId
        importedMessages += 1
        const parts: Record<string, unknown>[] = []
        if (message.reasoning.length > 0) {
          parts.push({ type: "reasoning", text: message.reasoning, time: { start: clock, end: clock } })
        }
        if (message.text.length > 0) {
          parts.push({ type: "text", text: message.text, time: { start: clock, end: clock } })
        }
        for (const call of message.toolCalls) {
          parts.push({
            type: "tool",
            tool: call.name,
            callID: mintId("prt").replace("prt_", "call_"),
            // A completed tool part carries a record input, a title, metadata
            // and a start/end time; a bare argument string fails to decode.
            state: {
              status: "completed",
              input: toolInput(call.args),
              output: call.result,
              title: call.name,
              metadata: {},
              time: { start: clock, end: clock },
            },
          })
        }
        for (const part of parts) {
          const partId = mintId("prt")
          const partNames = ["id", "message_id", "session_id", "time_created", "time_updated", "data"].filter((name) =>
            partColumns.includes(name),
          )
          const values: Record<string, unknown> = {
            id: partId,
            message_id: messageId,
            session_id: sessionId,
            time_created: clock,
            time_updated: clock,
            data: part,
          }
          dest
            .prepare(`INSERT OR IGNORE INTO part (${partNames.map((n) => `"${n}"`).join(", ")}) VALUES (${partNames.map(() => "?").join(", ")})`)
            .run(...partNames.map((name) => toSql(values[name])))
          importedParts += 1
        }
      }
      dest.exec("COMMIT")
    } catch (error) {
      try {
        dest.exec("ROLLBACK")
      } catch {
        // Already rolled back; the error below carries the cause.
      }
      throw error
    }
  } finally {
    dest.close()
  }
  writeLedger(userDataPath, {
    ...ledger,
    codex: { ...ledger.codex, [filePath]: { sessionId, importedAt: Date.now(), messages: importedMessages } },
  })
  return { source: filePath, kind: "codex", importedSessions: 1, importedMessages, importedParts, skippedSessions: 0, errors }
}
