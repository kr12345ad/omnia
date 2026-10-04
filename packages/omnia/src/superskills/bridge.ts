import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import type { Superskill, SuperskillMethod } from "./types"

const DEFAULT_TIMEOUT_MS = 30000
// Frames are newline-delimited JSON-RPC responses. A child that streams
// without a newline must not grow the server's heap without bound.
const MAX_BUFFER_BYTES = 4 * 1024 * 1024

export function splitBridgeCommand(input: string): string[] {
  const tokens: string[] = []
  let current = ""
  let quote: '"' | "'" | undefined
  let started = false
  let escaped = false
  for (const char of input.trim()) {
    if (escaped) {
      current += char
      escaped = false
      started = true
      continue
    }
    // Single quotes are literal in POSIX shells; double quotes and bare
    // tokens support backslash escaping.
    if (char === "\\" && quote !== "'") {
      escaped = true
      started = true
      continue
    }
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      // An empty quoted argument ("") is a real argument and must be kept.
      started = true
      continue
    }
    if (char === " " || char === "\t") {
      if (started) {
        tokens.push(current)
        current = ""
        started = false
      }
      continue
    }
    current += char
    started = true
  }
  if (escaped) current += "\\"
  if (started) tokens.push(current)
  return tokens
}

export type SuperskillAuthorizer = (
  skill: Superskill,
  method: string,
  params: unknown,
) => boolean | Promise<boolean>

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

class StdioBridge {
  private child: ChildProcessWithoutNullStreams | undefined
  private buffer = ""
  private sequence = 0
  private readonly pending = new Map<number, PendingCall>()

  constructor(private readonly skill: Superskill) {}

  private ensure(): ChildProcessWithoutNullStreams {
    if (this.child !== undefined && this.child.exitCode === null) return this.child
    const tokens = splitBridgeCommand(this.skill.bridge.command ?? "")
    const command = tokens[0]
    if (command === undefined || command.length === 0) throw new Error("The superskill bridge command is empty.")
    const child = spawn(command, tokens.slice(1), {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(this.skill.bridge.env ?? {}) },
    })
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => this.consume(chunk))
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", () => undefined)
    child.once("exit", () => {
      // Ignore late exit events from a child that was already replaced or
      // killed; otherwise a stale child's exit would fail a newer call.
      if (this.child !== child) return
      this.fail(new Error("The superskill bridge exited before answering."))
    })
    child.once("error", (error) => {
      if (this.child !== child) return
      this.fail(error)
    })
    // EPIPE (writing after the child closed stdin) must reject the pending
    // call, never surface as an uncaught exception on the server.
    child.stdin.on("error", (error) => {
      if (this.child !== child) return
      this.fail(error instanceof Error ? error : new Error("The superskill bridge stdin failed."))
    })
    this.child = child
    return child
  }

  private rejectPending(error: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
  }

  private fail(error: Error): void {
    this.rejectPending(error)
    this.child = undefined
  }

  private kill(): void {
    const child = this.child
    this.child = undefined
    try {
      child?.kill("SIGKILL")
    } catch {
      // already gone
    }
  }

  private consume(chunk: string): void {
    this.buffer += chunk
    if (this.buffer.length > MAX_BUFFER_BYTES) {
      this.buffer = ""
      this.kill()
      this.fail(new Error("The superskill bridge produced an oversized frame without a newline."))
      return
    }
    let index = this.buffer.indexOf("\n")
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (line.length > 0) this.handleLine(line)
      index = this.buffer.indexOf("\n")
    }
  }

  private handleLine(line: string): void {
    let parsed: { id?: unknown; result?: unknown; error?: { message?: string } }
    try {
      parsed = JSON.parse(line) as typeof parsed
    } catch {
      return
    }
    if (typeof parsed.id !== "number") return
    const entry = this.pending.get(parsed.id)
    if (entry === undefined) return
    this.pending.delete(parsed.id)
    clearTimeout(entry.timer)
    if (parsed.error !== undefined) {
      entry.reject(new Error(parsed.error.message ?? "The superskill bridge returned an error."))
      return
    }
    entry.resolve(parsed.result)
  }

  call(method: string, params: unknown): Promise<unknown> {
    const child = this.ensure()
    const id = ++this.sequence
    const timeoutMs = this.skill.bridge.timeoutMs ?? DEFAULT_TIMEOUT_MS
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        // A child that did not answer within the timeout is hung; kill it so
        // the next call spawns a fresh bridge instead of reusing a stuck one.
        this.kill()
        // Any other in-flight calls share the killed child and cannot answer.
        this.rejectPending(new Error("The superskill bridge was killed after a timeout."))
        reject(new Error(`The superskill bridge did not answer ${method} within ${timeoutMs}ms.`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
          if (error === null || error === undefined) return
          const entry = this.pending.get(id)
          if (entry === undefined) return
          this.pending.delete(id)
          clearTimeout(entry.timer)
          entry.reject(error instanceof Error ? error : new Error("The superskill bridge stdin write failed."))
        })
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error("The superskill bridge stdin write failed."))
      }
    })
  }

  close(): void {
    const child = this.child
    this.child = undefined
    try {
      child?.kill()
    } catch {
      // already gone
    }
    this.fail(new Error("The superskill bridge was closed."))
  }
}

// Declared parameters are enforced before a call leaves the process: unknown
// keys are rejected and `required: true` parameters must be present. This is
// intentionally shallow — parameters are JSON schemas owned by the skill.
function validateMethodParams(method: SuperskillMethod, params: unknown): void {
  const declared = method.parameters
  if (declared === undefined || Object.keys(declared).length === 0) return
  if (params === undefined || params === null) {
    const required = Object.entries(declared).filter(([, value]) => isRequired(value)).map(([key]) => key)
    if (required.length > 0) throw new Error(`The ${method.name} method requires: ${required.join(", ")}.`)
    return
  }
  if (typeof params !== "object" || Array.isArray(params)) {
    throw new Error(`The ${method.name} method expects an object of named parameters.`)
  }
  const provided = params as Record<string, unknown>
  const unknown = Object.keys(provided).filter((key) => !Object.hasOwn(declared, key))
  if (unknown.length > 0) throw new Error(`The ${method.name} method does not declare: ${unknown.join(", ")}.`)
  const missing = Object.entries(declared)
    .filter(([, value]) => isRequired(value))
    .map(([key]) => key)
    .filter((key) => !Object.hasOwn(provided, key))
  if (missing.length > 0) throw new Error(`The ${method.name} method requires: ${missing.join(", ")}.`)
}

function isRequired(value: unknown): boolean {
  if (typeof value === "boolean") return value
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  return (value as Record<string, unknown>).required === true
}

export class SuperskillBridges {
  private readonly clients = new Map<string, StdioBridge>()
  private readonly authorize: SuperskillAuthorizer | undefined

  constructor(authorize?: SuperskillAuthorizer) {
    this.authorize = authorize
  }

  async call(skill: Superskill, method: string, params: unknown): Promise<unknown> {
    const definition = skill.methods.find((entry) => entry.name === method)
    if (definition === undefined) throw new Error(`Superskill ${skill.id} has no method ${method}.`)
    validateMethodParams(definition, params)
    // Direct library callers must pass the same authorization as the HTTP
    // route; without a callback this is a no-op for trusted in-process calls.
    if (this.authorize !== undefined && !(await this.authorize(skill, method, params))) {
      throw new Error(`The superskill bridge call ${skill.id}.${method} was not authorized.`)
    }
    if (skill.bridge.type === "http") {
      const response = await fetch(skill.bridge.url ?? "", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(skill.bridge.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      })
      if (!response.ok) throw new Error(`The superskill bridge answered HTTP ${response.status}.`)
      const body = (await response.json()) as { result?: unknown; error?: { message?: string } }
      if (body.error !== undefined) throw new Error(body.error.message ?? "The superskill bridge returned an error.")
      return body.result
    }
    const client = this.clients.get(skill.id) ?? new StdioBridge(skill)
    this.clients.set(skill.id, client)
    try {
      return await client.call(method, params)
    } catch (error) {
      if (error instanceof Error && error.message.includes("exited")) {
        this.clients.delete(skill.id)
      }
      throw error
    }
  }

  close(id?: string): void {
    if (id === undefined) {
      for (const client of this.clients.values()) client.close()
      this.clients.clear()
      return
    }
    this.clients.get(id)?.close()
    this.clients.delete(id)
  }
}
