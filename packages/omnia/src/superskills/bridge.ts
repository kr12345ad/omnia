import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import type { Superskill } from "./types"

const DEFAULT_TIMEOUT_MS = 30000

export function splitBridgeCommand(input: string): string[] {
  const tokens: string[] = []
  let current = ""
  let quote: '"' | "'" | undefined
  for (const char of input.trim()) {
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === " " || char === "\t") {
      if (current.length > 0) {
        tokens.push(current)
        current = ""
      }
      continue
    }
    current += char
  }
  if (current.length > 0) tokens.push(current)
  return tokens
}

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
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer)
        entry.reject(new Error("The superskill bridge exited before answering."))
      }
      this.pending.clear()
      this.child = undefined
    })
    child.once("error", (error) => {
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer)
        entry.reject(error)
      }
      this.pending.clear()
      this.child = undefined
    })
    this.child = child
    return child
  }

  private consume(chunk: string): void {
    this.buffer += chunk
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
        reject(new Error(`The superskill bridge did not answer ${method} within ${timeoutMs}ms.`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
    })
  }

  close(): void {
    try {
      this.child?.kill()
    } catch {
      // already gone
    }
    this.child = undefined
  }
}

export class SuperskillBridges {
  private readonly clients = new Map<string, StdioBridge>()

  async call(skill: Superskill, method: string, params: unknown): Promise<unknown> {
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
