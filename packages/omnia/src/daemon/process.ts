import { execFile, spawn, type ChildProcess } from "node:child_process"
import type { ActionResult, CommandRequest, CommandResult } from "../protocol"

export interface ProcessResult {
  readonly stdout: string
  readonly stderr: string
  readonly code: number | null
  readonly truncated?: boolean
  readonly timedOut?: boolean
}

const SIGKILL_ESCALATION_MS = 2000

// POSIX children are spawned in their own group so descendants cannot retain
// output pipes after the shell is terminated. Windows uses taskkill's tree mode.
export function terminateProcessTree(child: ChildProcess, signal: "SIGTERM" | "SIGKILL"): void {
  if (child.pid === undefined) return
  if (process.platform === "win32") {
    if (child.exitCode !== null || child.signalCode !== null) return
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 2000 })
    killer.on("error", () => child.kill(signal))
    killer.unref()
    return
  }
  try {
    process.kill(-child.pid, signal)
  } catch {
    child.kill(signal)
  }
}

export function runProcess(
  file: string,
  args: readonly string[],
  timeoutMs: number,
  env?: Record<string, string>,
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true, env: { ...process.env, ...env } },
      (error, stdout, stderr) => {
        const code =
          error !== null && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "number"
            ? (error as { code: number }).code
            : error === null
              ? 0
              : null
        resolve({ stdout: String(stdout), stderr: String(stderr), code })
      },
    )
  })
}

export interface ShellSpec {
  readonly file: string
  readonly args: (command: string) => readonly string[]
}

export function runProcessWithInput(
  file: string,
  args: readonly string[],
  input: string,
  timeoutMs: number,
  maxOutputBytes = 1024 * 1024,
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(file, [...args], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" })
    let stdout = ""
    let stderr = ""
    let truncated = false
    let timedOut = false
    let settled = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const append = (current: string, chunk: Buffer): string => {
      if (current.length >= maxOutputBytes) {
        truncated = true
        return current
      }
      const next = current + chunk.toString("utf8")
      if (next.length > maxOutputBytes) {
        truncated = true
        return next.slice(0, maxOutputBytes)
      }
      return next
    }
    const finish = (code: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killTimer !== undefined) clearTimeout(killTimer)
      if (timedOut) terminateProcessTree(child, "SIGKILL")
      resolve({ stdout, stderr, code, truncated, timedOut })
    }
    const timer = setTimeout(() => {
      timedOut = true
      terminateProcessTree(child, "SIGTERM")
      killTimer = setTimeout(() => {
        terminateProcessTree(child, "SIGKILL")
        child.stdin.destroy()
        child.stdout.destroy()
        child.stderr.destroy()
        finish(null)
      }, SIGKILL_ESCALATION_MS)
    }, timeoutMs)
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk)
    })
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk)
    })
    child.once("error", () => finish(null))
    child.once("close", (code) => finish(code))
    // A closed stdin (the child exited early) emits EPIPE; without a listener
    // the unhandled stream error would take down the daemon.
    child.stdin.on("error", () => undefined)
    child.stdin.end(input)
  })
}

export async function executeShellCommand(
  request: CommandRequest,
  shell: ShellSpec,
): Promise<ActionResult & { command?: CommandResult }> {
  const timeoutMs = Math.max(1000, Math.min(request.timeoutMs ?? 120000, 600000))
  const maxOutputBytes = Math.max(4096, Math.min(request.maxOutputBytes ?? 262144, 1024 * 1024))
  const startedAt = Date.now()
  return new Promise((resolve) => {
    const child = spawn(shell.file, [...shell.args(request.command)], {
      detached: process.platform !== "win32",
      cwd: request.cwd,
      env: { ...process.env, ...(request.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    let truncated = false
    let timedOut = false
    let settled = false
    let stdinError: string | undefined
    const append = (current: string, chunk: Buffer): string => {
      if (current.length >= maxOutputBytes) {
        truncated = true
        return current
      }
      const next = current + chunk.toString("utf8")
      if (next.length > maxOutputBytes) {
        truncated = true
        return next.slice(0, maxOutputBytes)
      }
      return next
    }
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk)
    })
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk)
    })
    const timer = setTimeout(() => {
      timedOut = true
      terminateProcessTree(child, "SIGTERM")
      killTimer = setTimeout(() => {
        terminateProcessTree(child, "SIGKILL")
        child.stdin.destroy()
        child.stdout.destroy()
        child.stderr.destroy()
        finish(null)
      }, SIGKILL_ESCALATION_MS)
    }, timeoutMs)
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const finish = (exitCode: number | null, error?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killTimer !== undefined) clearTimeout(killTimer)
      if (timedOut) terminateProcessTree(child, "SIGKILL")
      const command: CommandResult = {
        exitCode,
        stdout,
        stderr,
        truncated,
        timedOut,
        durationMs: Date.now() - startedAt,
        ...(stdinError === undefined ? {} : { stdinError }),
      }
      const success = error === undefined && !timedOut && exitCode === 0
      resolve({
        success,
        status: success ? "success" : "failed",
        message:
          error ??
          (timedOut ? `Command timed out after ${timeoutMs}ms.` : `Command exited with code ${exitCode ?? "unknown"}.`),
        command,
        ...(error === undefined ? {} : { error: { code: "command_failed", message: error, retryable: false } }),
      })
    }
    child.once("error", (error) => finish(null, error.message))
    child.once("close", (code) => finish(code))
    // A command that exits before reading stdin must not crash the daemon with
    // an unhandled EPIPE; the error is recorded so a swallowed write is visible
    // to callers.
    child.stdin.on("error", (error: Error) => {
      stdinError = stdinError ?? error.message
    })
    if (request.stdin !== undefined) child.stdin.write(request.stdin)
    child.stdin.end()
  })
}
