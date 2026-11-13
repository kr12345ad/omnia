export * as HandoffPacket from "./packet"

import { Schema, Option } from "effect"
import path from "path"
import { appendFile, mkdir, rename, rm } from "fs/promises"

/**
 * Durable handoff state lives inside the project so a dormant agent can be
 * hydrated by a process that only knows the workspace root and session id.
 * `.omnia/.gitignore` keeps the state out of version control; `agents/` stays
 * committable because it is configuration, not runtime state.
 */
export const ROOT = ".omnia"
export const SESSIONS = "sessions"
export const PACKET_FILE = "handoff.json"
export const LOG_FILE = "last_test_run.log"
export const INBOX_FILE = "inbox.jsonl"
export const MAX_LOG_BYTES = 512 * 1024

export const Trigger = Schema.Struct({
  kind: Schema.Literals(["test-failure", "manual", "message"]),
  command: Schema.optional(Schema.String),
  pattern: Schema.optional(Schema.String),
})
export type Trigger = Schema.Schema.Type<typeof Trigger>

export const Command = Schema.Struct({
  text: Schema.String,
  shell: Schema.String,
  cwd: Schema.String,
  exitCode: Schema.NullOr(Schema.Finite),
  timeout: Schema.optional(Schema.Finite),
})
export type Command = Schema.Schema.Type<typeof Command>

export const Git = Schema.Struct({
  branch: Schema.optional(Schema.String),
  head: Schema.optional(Schema.String),
  dirty: Schema.Boolean,
  files: Schema.Array(Schema.String),
})
export type Git = Schema.Schema.Type<typeof Git>

export const Tokens = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  reasoning: Schema.Finite,
  cacheRead: Schema.Finite,
  cacheWrite: Schema.Finite,
  total: Schema.Finite,
})
export type Tokens = Schema.Schema.Type<typeof Tokens>

export const Message = Schema.Struct({
  at: Schema.String,
  role: Schema.Literals(["agent", "user", "supervisor"]),
  sessionID: Schema.optional(Schema.String),
  text: Schema.String,
})
export type Message = Schema.Schema.Type<typeof Message>

export const Packet = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String,
  sessionID: Schema.String,
  parentSessionID: Schema.optional(Schema.String),
  taskID: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  status: Schema.Literals(["pending", "running", "completed", "failed"]),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  trigger: Trigger,
  command: Schema.optional(Command),
  git: Schema.optional(Git),
  tokens: Schema.optional(Tokens),
  targets: Schema.Array(Schema.String),
  log: Schema.optional(Schema.String),
  summary: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  next: Schema.Array(Schema.String),
  messages: Schema.Array(Message),
})
export type Packet = Schema.Schema.Type<typeof Packet>

export function sessionDirectory(root: string, sessionID: string) {
  return path.join(root, ROOT, SESSIONS, sessionID)
}

export function packetPath(root: string, sessionID: string) {
  return path.join(sessionDirectory(root, sessionID), PACKET_FILE)
}

export function logPath(root: string, sessionID: string) {
  return path.join(sessionDirectory(root, sessionID), LOG_FILE)
}

export function inboxPath(root: string, sessionID: string) {
  return path.join(sessionDirectory(root, sessionID), INBOX_FILE)
}

export async function ensureRoot(root: string) {
  await mkdir(path.join(root, ROOT, SESSIONS), { recursive: true })
  const ignore = path.join(root, ROOT, ".gitignore")
  if (!(await Bun.file(ignore).exists())) {
    await Bun.write(ignore, [SESSIONS + "/", "tasks/", ""].join("\n"))
  }
}

async function writeAtomic(file: string, text: string) {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${crypto.randomUUID()}.tmp`
  await Bun.write(temporary, text)
  await rename(temporary, file).catch(async (error) => {
    await rm(temporary, { force: true })
    throw error
  })
}

export async function write(root: string, packet: Packet) {
  const value = Schema.decodeUnknownSync(Packet)(packet)
  await ensureRoot(root)
  await writeAtomic(packetPath(root, packet.sessionID), JSON.stringify(value, null, 2) + "\n")
  return value
}

export async function read(root: string, sessionID: string): Promise<Packet | undefined> {
  const text = await Bun.file(packetPath(root, sessionID))
    .text()
    .catch(() => undefined)
  if (text === undefined) return undefined
  const json = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(text)
  if (Option.isNone(json)) return undefined
  return Option.getOrUndefined(Schema.decodeUnknownOption(Packet)(json.value))
}

export async function appendInbox(
  root: string,
  sessionID: string,
  entry: Omit<Message, "at"> & { at?: string },
) {
  await ensureRoot(root)
  const file = inboxPath(root, sessionID)
  // send_message can target a session that never failed a test, so the
  // per-session directory does not necessarily exist yet.
  await mkdir(path.dirname(file), { recursive: true })
  const line = JSON.stringify({ ...entry, at: entry.at ?? new Date().toISOString() }) + "\n"
  // O_APPEND keeps concurrent deliveries from overwriting each other's line.
  await appendFile(file, line)
}

/**
 * The hook writes the captured output verbatim so a later process sees the same
 * bytes the shell produced. Oversized runs keep the tail: compilers put the
 * actionable assertion or stack trace at the end.
 */
export async function writeLog(root: string, sessionID: string, text: string) {
  await ensureRoot(root)
  const limited = truncateBytes(text, MAX_LOG_BYTES)
  await writeAtomic(logPath(root, sessionID), limited)
  return path.relative(sessionDirectory(root, sessionID), logPath(root, sessionID))
}

export function truncateBytes(text: string, maxBytes: number) {
  const bytes = Buffer.from(text, "utf8")
  if (bytes.byteLength <= maxBytes) return text
  return "...[earlier output truncated]...\n" + bytes.subarray(bytes.byteLength - maxBytes).toString("utf8")
}

export function collectGit(root: string): Git | undefined {
  const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"])
  if (branch === undefined) return undefined
  const head = git(root, ["rev-parse", "--short", "HEAD"])
  const status = git(root, ["status", "--porcelain=v1"]) ?? ""
  const files = status
    .split("\n")
    .filter((line) => line.length > 3)
    .map((line) => line.slice(3))
    .slice(0, 50)
  return {
    branch: branch === "HEAD" ? undefined : branch,
    head,
    dirty: files.length > 0,
    files,
  }
}

function git(root: string, args: string[]) {
  // This is an external-binary boundary: git may be absent, or the workspace
  // may not be a repository. Both are normal and must not fail the handoff.
  const result = (() => {
    try {
      return Bun.spawnSync(["git", ...args], {
        cwd: root,
        stdout: "pipe",
        stderr: "ignore",
      })
    } catch {
      return undefined
    }
  })()
  if (!result || result.exitCode !== 0) return undefined
  const text = result.stdout.toString().trim()
  return text.length > 0 ? text : undefined
}
