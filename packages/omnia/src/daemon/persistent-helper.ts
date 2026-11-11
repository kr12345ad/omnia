import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { StringDecoder } from "node:string_decoder"
import { terminateProcessTree } from "./process"

export interface PersistentHelperLine {
  id?: string
  ready?: boolean
  ok: boolean
  error?: string
  payload: Record<string, unknown>
}

export interface PersistentHelper {
  readonly ready: Promise<PersistentHelperLine>
  // True once the child process has exited, failed to spawn, or was disposed.
  // Callers can reject immediately instead of queueing a request that can
  // never complete.
  readonly exited: boolean
  request(command: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<PersistentHelperLine>
  dispose(): Promise<void>
}

export interface PersistentHelperOptions {
  readonly script: string
  readonly label: string
  readonly interpreter?: string
  readonly display?: string
  readonly env?: Readonly<Record<string, string>>
  readonly timeoutMs?: number
  readonly maxOutputBytes?: number
}

interface PendingRequest {
  resolve: (line: PersistentHelperLine) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const DEFAULT_TIMEOUT_MS = 15000
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const KILL_GRACE_MS = 500

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function parsePersistentHelperLine(line: string): PersistentHelperLine | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  return {
    ...(typeof parsed.id === "string" ? { id: parsed.id } : {}),
    ...(typeof parsed.ready === "boolean" ? { ready: parsed.ready } : {}),
    ok: parsed.ok === true,
    ...(typeof parsed.error === "string" ? { error: parsed.error } : {}),
    payload: parsed,
  }
}

// Spawns a python JSON-line helper once and multiplexes requests over its
// stdin/stdout. Responses are matched by request id; unknown or malformed
// lines are ignored so stray diagnostics cannot wedge the protocol. A helper
// that exits fails every pending request immediately, and dispose() is
// idempotent and escalates to SIGKILL.
export function createJsonLineHelper(options: PersistentHelperOptions): PersistentHelper {
  const child: ChildProcessWithoutNullStreams = spawn(
    options.interpreter ?? "python3",
    ["-c", options.script],
    {
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        ...(options.env ?? {}),
        ...(options.display === undefined ? {} : { DISPLAY: options.display }),
      },
    },
  )
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  const decoder = new StringDecoder("utf8")
  let buffer = ""
  let stderr = ""
  let disposed = false
  let exited = false
  let counter = 0
  let readySettled = false
  let settleReady!: (line: PersistentHelperLine) => void
  const ready = new Promise<PersistentHelperLine>((resolve) => {
    settleReady = resolve
  })
  const pending = new Map<string, PendingRequest>()

  const settle = (line: PersistentHelperLine) => {
    if (readySettled) return
    readySettled = true
    clearTimeout(startupTimer)
    settleReady(line)
  }
  const failPending = (error: Error) => {
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    pending.clear()
  }

  // A timed-out input may still be queued inside a blocked helper. Retire the
  // whole process so it cannot deliver delayed clicks/typing after recovery.
  const stop = (error: Error) => {
    exited = true
    settle({ ok: false, error: error.message, payload: {} })
    failPending(error)
    buffer = ""
    terminateProcessTree(child, "SIGKILL")
  }
  const startupTimer = setTimeout(() => stop(new Error(`${options.label} timed out starting.`)), timeoutMs)
  startupTimer.unref?.()

  child.stdout.on("data", (chunk: Buffer) => {
    if (exited || disposed) return
    buffer += decoder.write(chunk)
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    if (Buffer.byteLength(buffer, "utf8") > maxOutputBytes || lines.some((line) => Buffer.byteLength(line, "utf8") > maxOutputBytes)) {
      stop(new Error(`${options.label} produced an oversized response.`))
      return
    }
    for (const raw of lines) {
      const line = raw.trim()
      if (line.length === 0) continue
      const parsed = parsePersistentHelperLine(line)
      if (parsed === undefined) continue
      if (parsed.ready === true) {
        settle(parsed)
        continue
      }
      if (parsed.id === undefined) continue
      const request = pending.get(parsed.id)
      if (request === undefined) continue
      pending.delete(parsed.id)
      clearTimeout(request.timer)
      request.resolve(parsed)
    }
  })
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-4000)
  })
  // EPIPE means the child closed stdin; its exit handler rejects pending
  // requests, so the stream error itself must not crash the parent.
  child.stdin.on("error", () => undefined)
  child.once("error", (error) => {
    exited = true
    settle({ ok: false, error: `${options.label} could not start: ${error.message}`, payload: {} })
    failPending(new Error(`${options.label} is not running.`))
  })
  child.once("exit", (code) => {
    exited = true
    if (!readySettled) {
      settle({ ok: false, error: `${options.label} exited (code ${code ?? "unknown"}).`, payload: {} })
    }
    failPending(
      new Error(`${options.label} is not running${stderr.length === 0 ? "." : `: ${stderr.trim()}`}`),
    )
  })

  return {
    ready,
    get exited() {
      return exited || disposed
    },
    request(command, params = {}, requestTimeoutMs = timeoutMs) {
      if (disposed) return Promise.reject(new Error(`${options.label} was disposed.`))
      if (exited) return Promise.reject(new Error(`${options.label} is not running.`))
      counter += 1
      const id = String(counter)
      return new Promise<PersistentHelperLine>((resolve, reject) => {
        const timer = setTimeout(() => {
          stop(new Error(`${options.label} timed out running ${command}.`))
        }, requestTimeoutMs)
        timer.unref?.()
        pending.set(id, { resolve, reject, timer })
        try {
          child.stdin.write(`${JSON.stringify({ id, command, params })}\n`)
        } catch (error) {
          pending.delete(id)
          clearTimeout(timer)
          reject(error)
        }
      })
    },
    async dispose() {
      if (disposed) return
      disposed = true
      settle({ ok: false, error: `${options.label} was disposed.`, payload: {} })
      try {
        child.stdin.write(`${JSON.stringify({ id: "quit", command: "quit", params: {} })}\n`)
      } catch {
        // The helper may already be gone; the kills below are best effort.
      }
      terminateProcessTree(child, "SIGTERM")
      const killTimer = setTimeout(() => terminateProcessTree(child, "SIGKILL"), KILL_GRACE_MS)
      child.once("exit", () => clearTimeout(killTimer))
      failPending(new Error(`${options.label} was disposed.`))
    },
  }
}
