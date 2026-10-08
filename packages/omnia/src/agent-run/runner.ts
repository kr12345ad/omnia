// The headless run: create a session, prompt it, and wait for the model to go
// idle or error, all without any app window. Timeout aborts the session so a
// scheduled run can never burn the account silently forever.
//
// "Idle" is the session status contract: opencode reports each session's
// status through GET /session/status; absent, "idle" or "completed" means the
// drain finished, "busy"/"retry" means still working, "error" means it died.

import {
  abortSession,
  createSession,
  promptAsync,
  sessionMessages,
  sessionStatus,
  type OpenCodeRunnerConfig,
} from "./client.js"

export interface HeadlessRunInput {
  readonly prompt: string
  readonly title?: string
  readonly timeoutMs?: number
  readonly pollMs?: number
  readonly now?: () => number
}

export type HeadlessRunResult =
  | {
      readonly ok: true
      readonly sessionId: string
      readonly text: string
      readonly elapsedMs: number
    }
  | {
      readonly ok: false
      readonly sessionId: string
      readonly error: string
      readonly timedOut: boolean
      readonly elapsedMs: number
    }

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000
const DEFAULT_POLL_MS = 2_000
const MAX_TIMEOUT_MS = 60 * 60 * 1000

export async function runHeadless(
  config: OpenCodeRunnerConfig,
  input: HeadlessRunInput,
): Promise<HeadlessRunResult> {
  const now = input.now ?? Date.now
  const prompt = input.prompt.trim()
  if (prompt.length === 0) throw new Error("A headless run needs a prompt.")
  const timeoutMs = Math.max(5_000, Math.min(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS))
  const pollMs = Math.max(500, Math.min(input.pollMs ?? DEFAULT_POLL_MS, 10_000))
  const started = now()
  const session = await createSession(config, input.title?.trim() || `Headless run ${new Date(started).toISOString()}`)
  await promptAsync(config, session.id, [{ type: "text", text: prompt }])
  for (;;) {
    const status = await sessionStatus(config)
    const current = status[session.id]?.type
    if (current === "error") {
      return { ok: false, sessionId: session.id, error: "The session reported an error.", timedOut: false, elapsedMs: now() - started }
    }
    if (current === undefined || current === "idle" || current === "completed") {
      return { ok: true, sessionId: session.id, text: await lastAssistantText(config, session.id), elapsedMs: now() - started }
    }
    if (now() - started >= timeoutMs) {
      await abortSession(config, session.id)
      return {
        ok: false,
        sessionId: session.id,
        error: `The run exceeded its ${Math.round(timeoutMs / 60_000)} minute budget and was aborted.`,
        timedOut: true,
        elapsedMs: now() - started,
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

// The last assistant text in the session transcript. Page content is untrusted
// by construction; callers render it through the untrusted envelope, never as
// instructions.
async function lastAssistantText(config: OpenCodeRunnerConfig, sessionId: string): Promise<string> {
  const messages = await sessionMessages(config, sessionId).catch(() => [] as unknown[])
  for (const message of [...messages].reverse()) {
    if (typeof message !== "object" || message === null) continue
    const info = (message as { info?: unknown }).info
    if (typeof info !== "object" || info === null || (info as { role?: unknown }).role !== "assistant") continue
    const parts = (message as { parts?: unknown }).parts
    if (!Array.isArray(parts)) continue
    const texts = parts.flatMap((part) => {
      if (typeof part !== "object" || part === null) return []
      if ((part as { type?: unknown }).type !== "text") return []
      const text = (part as { text?: unknown }).text
      return typeof text === "string" && text.trim().length > 0 ? [text.trim()] : []
    })
    if (texts.length > 0) return texts.at(-1)!
  }
  return ""
}
