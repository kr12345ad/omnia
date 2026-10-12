import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import type { DatabaseSync, SQLInputValue } from "node:sqlite"

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

interface DestColumns {
  readonly session: Set<string>
  readonly message: Set<string>
  readonly part: Set<string>
  readonly project: Set<string>
}

function destColumns(db: DatabaseSync): DestColumns {
  const columns = (table: string): Set<string> => {
    try {
      return new Set(
        db
          .prepare(`PRAGMA table_info("${table.replaceAll('"', '""')}")`)
          .all()
          .map((row) => String((row as { name: unknown }).name)),
      )
    } catch {
      return new Set()
    }
  }
  return { session: columns("session"), message: columns("message"), part: columns("part"), project: columns("project") }
}

function existingIds(db: DatabaseSync, table: string): Set<string> {
  try {
    return new Set(
      db
        .prepare(`SELECT id FROM "${table}"`)
        .all()
        .map((row) => String((row as { id: unknown }).id)),
    )
  } catch {
    return new Set()
  }
}

export async function importOpencodeDb(
  destDbPath: string,
  sourcePath: string,
  userDataPath: string,
): Promise<ImportReport> {
  const errors: string[] = []
  const { DatabaseSync } = await import("node:sqlite")
  if (!existsSync(destDbPath)) throw new Error(`Omnia database not found: ${destDbPath}`)
  const dest = new DatabaseSync(destDbPath)
  const source = new DatabaseSync(sourcePath, { readOnly: true })
  let importedSessions = 0
  let importedMessages = 0
  let importedParts = 0
  let skippedSessions = 0
  try {
    const columns = destColumns(dest)
    const haveSessions = existingIds(dest, "session")
    const haveMessages = existingIds(dest, "message")
    const haveParts = existingIds(dest, "part")
    const haveProjects = existingIds(dest, "project")
    const sessions = source.prepare("SELECT * FROM session").all() as Record<string, unknown>[]
    // Prepared statements are hoisted out of the loops: preparing per row was
    // the dominant cost on large histories. Shapes are cached by column list
    // in case a row is missing columns.
    const inserts = new Map<string, { run: (...params: SQLInputValue[]) => unknown }>()
    const insertInto = (table: "session" | "message" | "part" | "project", names: string[]) => {
      const key = `${table}:${names.join(",")}`
      let statement = inserts.get(key)
      if (statement === undefined) {
        statement = dest.prepare(
          `INSERT OR IGNORE INTO ${table} (${names.map((n) => `"${n}"`).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
        )
        inserts.set(key, statement)
      }
      return statement
    }
    const sessionNames = [...columns.session].filter((c) => c !== "rowid")
    const sessionInsert = columns.session.has("id") ? insertInto("session", sessionNames) : undefined
    const placeholders = (count: number): string => new Array(count).fill("?").join(", ")
    dest.exec("BEGIN IMMEDIATE")
    try {
      const projects = new Map<string, Record<string, unknown>>()
      const projectIds = new Set<string>()
      for (const session of sessions) {
        if (typeof session.project_id === "string") projectIds.add(session.project_id)
      }
      for (const projectId of projectIds) {
        if (haveProjects.has(projectId)) continue
        try {
          const row = source.prepare("SELECT * FROM project WHERE id = ?").get(projectId) as Record<string, unknown> | undefined
          if (row !== undefined) projects.set(projectId, row)
        } catch (error) {
          errors.push(`project ${projectId}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      for (const [projectId, row] of projects) {
        const names = [...columns.project].filter((name) => name in row)
        if (names.length === 0) continue
        insertInto("project", names).run(...names.map((name) => toSql(row[name])))
        haveProjects.add(projectId)
      }
      // New sessions only; chunks bound memory and keep each bulk read small.
      // Sessions already held still get their messages re-checked: opencode
      // appends to sessions over time, so a rerun must pick up new messages
      // in old sessions rather than assuming a held session is complete.
      const fresh = sessions.filter(
        (session): session is Record<string, unknown> & { id: string } =>
          typeof session.id === "string" && !haveSessions.has(session.id),
      )
      skippedSessions = sessions.length - fresh.length - sessions.filter((s) => typeof s.id !== "string").length
      const CHUNK = 200
      const freshIds = new Set(fresh.map((session) => session.id))
      for (let start = 0; start < sessions.length; start += CHUNK) {
        const chunk = sessions
          .filter((session): session is Record<string, unknown> & { id: string } => typeof session.id === "string")
          .slice(start, start + CHUNK)
        const ids = chunk.map((session) => session.id as string)
        for (const session of chunk) {
          if (!freshIds.has(session.id as string)) continue
          sessionInsert?.run(...sessionNames.map((name) => toSql(name in session ? session[name] : null)))
          haveSessions.add(session.id as string)
          importedSessions += 1
        }
        const messages = source
          .prepare(`SELECT * FROM message WHERE session_id IN (${placeholders(ids.length)})`)
          .all(...ids) as Record<string, unknown>[]
        const bySession = new Map<string, Record<string, unknown>[]>()
        for (const message of messages) {
          if (typeof message.session_id !== "string") continue
          const list = bySession.get(message.session_id) ?? []
          list.push(message)
          bySession.set(message.session_id, list)
        }
        const freshMessageIds: string[] = []
        for (const session of chunk) {
          for (const message of bySession.get(session.id) ?? []) {
            const messageId = message.id
            if (typeof messageId !== "string" || haveMessages.has(messageId)) continue
            const names = [...columns.message].filter((name) => name in message)
            if (names.length === 0) continue
            insertInto("message", names).run(...names.map((name) => toSql(message[name])))
            haveMessages.add(messageId)
            freshMessageIds.push(messageId)
            importedMessages += 1
          }
        }
        for (let offset = 0; offset < freshMessageIds.length; offset += 500) {
          const batch = freshMessageIds.slice(offset, offset + 500)
          const parts = source
            .prepare(`SELECT * FROM part WHERE message_id IN (${placeholders(batch.length)})`)
            .all(...batch) as Record<string, unknown>[]
          for (const part of parts) {
            const partId = part.id
            if (typeof partId !== "string" || haveParts.has(partId)) continue
            const partNames = [...columns.part].filter((name) => name in part)
            if (partNames.length === 0) continue
            insertInto("part", partNames).run(...partNames.map((name) => toSql(part[name])))
            haveParts.add(partId)
            importedParts += 1
          }
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
  return { source: sourcePath, kind: "opencode", importedSessions, importedMessages, importedParts, skippedSessions, errors }
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
    const columns = destColumns(dest)
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
      if (columns.project.has("id")) {
        const names = ["id", "worktree", "time_created", "time_updated", "sandboxes"].filter((name) => columns.project.has(name))
        dest
          .prepare(`INSERT OR IGNORE INTO project (${names.map((n) => `"${n}"`).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`)
          .run(...names.map((name) => toSql(name === "id" ? resolvedProject : name === "worktree" ? cwd : name === "sandboxes" ? "[]" : now)))
      }
    }
    const firstUser = parsed.messages.find((message) => message.role === "user" && message.text.length > 0)?.text
    const created = parsed.messages[0]?.time ?? now
    const updated = parsed.messages[parsed.messages.length - 1]?.time ?? created
    const sessionRow: Record<string, unknown> = {
      id: sessionId,
      project_id: resolvedProject,
      slug: `codex-${basename(filePath, ".jsonl").slice(-12)}`,
      directory: cwd,
      title: titleOf(firstUser, `Codex session ${new Date(created).toLocaleDateString()}`),
      version: "1",
      metadata: JSON.stringify({ mode: "code", importedFrom: "codex", sourceFile: filePath, codexId: parsed.id ?? null }),
      cost: 0,
      tokens_input: 0,
      tokens_output: 0,
      tokens_reasoning: 0,
      tokens_cache_read: 0,
      tokens_cache_write: 0,
      agent: "build",
      model: parsed.model ?? null,
      time_created: created,
      time_updated: updated,
    }
    const sessionNames = [...columns.session].filter((name) => name in sessionRow)
    dest.exec("BEGIN IMMEDIATE")
    try {
      dest
        .prepare(`INSERT OR IGNORE INTO session (${sessionNames.map((n) => `"${n}"`).join(", ")}) VALUES (${sessionNames.map(() => "?").join(", ")})`)
        .run(...sessionNames.map((name) => toSql(sessionRow[name])))
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
          data: JSON.stringify({
            role: message.role,
            ...(parentId === undefined ? {} : { parentID: parentId }),
            ...(isUser ? {} : { agent: "build", ...(parsed.model === undefined ? {} : { modelID: parsed.model }) }),
            time: { created: clock },
          }),
        }
        const messageNames = [...columns.message].filter((name) => name in messageRow)
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
            state: { status: "completed", input: call.args, output: call.result },
          })
        }
        for (const part of parts) {
          const partId = mintId("prt")
          const partNames = ["id", "message_id", "session_id", "time_created", "time_updated", "data"].filter((name) =>
            columns.part.has(name),
          )
          const values: Record<string, unknown> = {
            id: partId,
            message_id: messageId,
            session_id: sessionId,
            time_created: clock,
            time_updated: clock,
            data: JSON.stringify(part),
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
