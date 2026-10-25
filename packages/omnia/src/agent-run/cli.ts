// A headless run driven through the OpenCode CLI instead of the paired server.
//
// Zen's free models are gated to the official client: the same model, host and
// headers answered with "OpenCode's free tier can only be used from within
// OpenCode" for every request a server-side executor makes, while the CLI runs
// it. So a chat that must answer on a free model runs the CLI and reads its
// JSON event stream, rather than posting a prompt to a server that cannot be
// recognised as OpenCode.
//
// The event stream is the same transcript the server reports: one object per
// line, each carrying the part the session just produced, which is exactly what
// the chat progress view renders.

import { spawn } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Readable } from "node:stream"
import type { HeadlessRunInput, HeadlessRunResult } from "./runner"

export interface CliRunnerConfig {
  /** Path to the official opencode binary. */
  readonly bin: string
}

// OMNIA_CHAT_CLI names the binary. Unset keeps chat on the paired server, so an
// install that does not carry the official client is unaffected.
export function openCodeCliRunnerFromEnv(): CliRunnerConfig | undefined {
  const bin = process.env.OMNIA_CHAT_CLI?.trim()
  if (bin === undefined || bin.length === 0) return undefined
  return { bin }
}

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000
const MAX_TIMEOUT_MS = 60 * 60 * 1000
const STDERR_TAIL = 2_000

interface Event {
  readonly type?: unknown
  readonly sessionID?: unknown
  readonly part?: unknown
  readonly error?: { readonly message?: unknown; readonly type?: unknown }
}

export async function runHeadlessCli(config: CliRunnerConfig, input: HeadlessRunInput): Promise<HeadlessRunResult> {
  const started = Date.now()
  const prompt = input.prompt.trim()
  if (prompt.length === 0) throw new Error("A headless run needs a prompt.")
  const timeoutMs = Math.max(5_000, Math.min(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS))
  const files = materialize(input.files ?? [])
  // `node:child_process` rather than `Bun.spawn`: the control plane also runs
  // inside Electron's Node main process, where the Bun global does not exist.
  const proc = spawn(
    config.bin,
    [
      "run",
      // Nobody is watching the terminal a chat turn runs in, so every permission
      // the session's rules do not deny is granted up front.
      "--auto",
      "--format",
      "json",
      ...(input.model === undefined ? [] : ["--model", `${input.model.providerID}/${input.model.modelID}`]),
      // The CLI creates the session when the id is new, which is what lets a
      // chat conversation keep one session across messages.
      ...(input.sessionId === undefined ? [] : ["--session", input.sessionId]),
      ...(input.title === undefined ? [] : ["--title", input.title]),
      ...files.paths.flatMap((path) => ["--file", path]),
      prompt,
    ],
    // The client resolves its config, credentials and state from the environment
    // it is started in, so the server's own environment is handed over rather
    // than a bare one.
    { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } },
  )
  // A binary that is missing or not executable emits `error` instead of a code,
  // so the failure is kept beside the exit and reported the same way.
  const exited = new Promise<{ code: number | null; error?: string }>((resolve) => {
    proc.once("error", (error) => resolve({ code: null, error: error.message }))
    proc.once("close", (code) => resolve({ code }))
  })

  let timedOut = false
  let interrupted = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, timeoutMs)
  const stop = () => {
    interrupted = true
    proc.kill()
  }
  input.signal?.addEventListener("abort", stop, { once: true })
  if (input.signal?.aborted) stop()

  // Parts are grouped by the assistant message that produced them, so the
  // progress view reads like the transcript the server would have returned.
  const messages = new Map<string, { info: { role: string }; parts: unknown[] }>()
  let sessionId = input.sessionId
  let text = ""
  let failure: string | undefined

  const consume = (line: string): void => {
    const trimmed = line.trim()
    if (trimmed.length === 0) return
    let event: Event
    try {
      event = JSON.parse(trimmed) as Event
    } catch {
      return
    }
    if (typeof event.sessionID === "string" && sessionId === undefined) sessionId = event.sessionID
    if (event.type === "error") {
      const message = event.error?.message
      failure = typeof message === "string" && message.length > 0 ? message : "The CLI reported an error."
      return
    }
    const part = event.part
    if (typeof part !== "object" || part === null) return
    const record = part as { type?: unknown; messageID?: unknown; text?: unknown }
    const messageID = typeof record.messageID === "string" ? record.messageID : "message"
    const message = messages.get(messageID) ?? { info: { role: "assistant" }, parts: [] }
    // The stream reports a part more than once as it advances (a tool call
    // starts, then completes), so the newest version replaces the older one.
    const id = partID(part)
    const at = message.parts.findIndex((existing) => partID(existing) === id)
    if (at === -1) message.parts.push(part)
    else message.parts[at] = part
    messages.set(messageID, message)
    if (record.type === "text" && typeof record.text === "string") text = record.text
    input.onProgress?.([...messages.values()])
  }

  try {
    const stderr: string[] = []
    const drain = async (): Promise<void> => {
      for await (const chunk of chunks(proc.stderr)) {
        stderr.push(chunk)
        while (stderr.join("").length > STDERR_TAIL * 2) stderr.shift()
      }
    }
    const read = async (): Promise<void> => {
      let pending = ""
      for await (const chunk of chunks(proc.stdout)) {
        pending += chunk
        const lines = pending.split("\n")
        pending = lines.pop() ?? ""
        lines.forEach(consume)
      }
      consume(pending)
    }
    const [, , finished] = await Promise.all([read(), drain(), exited])
    if (finished.error !== undefined) {
      return {
        ok: false,
        sessionId: sessionId ?? "",
        error: `The CLI could not be started: ${finished.error}`.slice(0, 400),
        timedOut: false,
        elapsedMs: Date.now() - started,
      }
    }
    const exit = finished.code
    // An error event does not stop the process: it reports the turn that failed
    // and the CLI then exits normally, so the event, not the code, is the verdict.
    if (failure !== undefined) {
      return {
        ok: false,
        sessionId: sessionId ?? "",
        error: failure,
        timedOut: false,
        elapsedMs: Date.now() - started,
      }
    }
    if (interrupted) {
      return {
        ok: false,
        sessionId: sessionId ?? "",
        error: "The run was interrupted.",
        timedOut: false,
        interrupted: true,
        // The caller keeps the id even when the process died before reporting
        // one; it is the strongest thing known about the turn.
        elapsedMs: Date.now() - started,
      }
    }
    if (timedOut) {
      return {
        ok: false,
        sessionId: sessionId ?? "",
        error: `The run exceeded its ${Math.round(timeoutMs / 60_000)} minute budget and was aborted.`,
        timedOut: true,
        elapsedMs: Date.now() - started,
      }
    }
    // A crash says more than a missing session id does: the CLI can die before
    // it reports anything, and the exit code is the reason it died.
    if (exit !== 0) {
      const detail = stderr.join("").trim().split("\n").at(-1) ?? ""
      return {
        ok: false,
        sessionId: sessionId ?? "",
        error: `The CLI exited with code ${exit}${detail.length === 0 ? "." : `: ${detail}`}`.slice(0, 400),
        timedOut: false,
        elapsedMs: Date.now() - started,
      }
    }
    if (sessionId === undefined) {
      return {
        ok: false,
        sessionId: "",
        error: "The CLI did not report which session it ran.",
        timedOut: false,
        elapsedMs: Date.now() - started,
      }
    }
    return { ok: true, sessionId, text, elapsedMs: Date.now() - started }
  } finally {
    clearTimeout(timer)
    input.signal?.removeEventListener("abort", stop)
    files.cleanup()
  }
}

async function* chunks(stream: Readable): AsyncGenerator<string> {
  // `stream: true` holds an incomplete UTF-8 sequence until the next chunk, so
  // a multi-byte character split across a pipe boundary is not mangled.
  const decoder = new TextDecoder()
  for await (const chunk of stream) {
    yield decoder.decode(chunk as Uint8Array, { stream: true })
  }
  const tail = decoder.decode()
  if (tail.length > 0) yield tail
}

function partID(part: unknown): string {
  if (typeof part !== "object" || part === null) return ""
  const record = part as { partID?: unknown; id?: unknown }
  if (typeof record.partID === "string") return record.partID
  return typeof record.id === "string" ? record.id : ""
}

// Attachments arrive as data: URLs because the chat platforms hand them over
// that way, and the CLI only reads files off disk.
function materialize(files: readonly { mime: string; filename?: string; url: string }[]): {
  paths: string[]
  cleanup: () => void
} {
  if (files.length === 0) return { paths: [], cleanup: () => {} }
  const dir = mkdtempSync(join(tmpdir(), "omnia-chat-cli-"))
  const paths = files.flatMap((file, index) => {
    const match = /^data:([^;,]+);base64,(.*)$/s.exec(file.url)
    if (match === null) return []
    const path = join(dir, `${index}-${file.filename ?? "attachment"}`.replace(/[^\w.-]/g, "_"))
    writeFileSync(path, Buffer.from(match[2] ?? "", "base64"))
    return [path]
  })
  return { paths, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

export * as AgentRunCli from "./cli"
