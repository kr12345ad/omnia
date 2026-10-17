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
  /** Continue this session instead of opening a new one. */
  readonly sessionId?: string
  readonly timeoutMs?: number
  readonly pollMs?: number
  readonly model?: { readonly providerID: string; readonly modelID: string }
  /** Called with the transcript on every poll, for a live progress view. */
  readonly onProgress?: (messages: readonly unknown[]) => void
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
  // A caller continuing a conversation names the session; only a fresh run pays
  // for creating one.
  const session =
    input.sessionId === undefined
      ? await createSession(config, input.title?.trim() || `Headless run ${new Date(started).toISOString()}`)
      : { id: input.sessionId }
  // A continued session already holds its previous answers. Only messages past
  // this point belong to this run, or the run would "finish" instantly with the
  // answer to the previous message and report the old reasoning as progress.
  const baseline =
    input.sessionId === undefined
      ? 0
      : (await sessionMessages(config, input.sessionId).catch(() => [] as unknown[])).length
  await promptAsync(config, session.id, [{ type: "text", text: prompt }], input.model)
  // A session that has just been prompted is not in the status map yet, and an
  // absent entry does NOT mean finished: reading it as done returned an empty
  // answer while the turn was still starting. Wait until the session has been
  // seen running, or until it has produced an assistant message.
  let seenRunning = false
  // A provider failure is recorded on the assistant message, not in the status
  // map: the session looks idle and its text is empty. Treating that as a
  // finished run reported "no written answer" and hid the provider's reason.
  const finish = (answer: Awaited<ReturnType<typeof readAnswer>>): HeadlessRunResult =>
    answer.error === undefined
      ? { ok: true, sessionId: session.id, text: answer.text, elapsedMs: now() - started }
      : { ok: false, sessionId: session.id, error: answer.error, timedOut: false, elapsedMs: now() - started }
  for (;;) {
    // One transcript read per poll, shared by the progress view and the answer.
    // It must not outlive the iteration: a run is only visible because each
    // read sees more than the last one.
    let transcript: unknown[] | undefined
    const load = async (): Promise<unknown[]> => {
      transcript ??= await sessionMessages(config, session.id).catch(() => [] as unknown[])
      return transcript
    }
    const status = await sessionStatus(config)
    const current = status[session.id]?.type
    if (current === "error") {
      return { ok: false, sessionId: session.id, error: "The session reported an error.", timedOut: false, elapsedMs: now() - started }
    }
    if (current === "busy" || current === "retry") seenRunning = true
    const fresh = (await load()).slice(baseline)
    if (input.onProgress !== undefined) input.onProgress(fresh)
    // An explicit idle/completed entry is authoritative. A missing entry is not:
    // the session is between being prompted and being registered as running.
    if (current === "idle" || current === "completed") {
      return finish(readAnswer(fresh))
    }
    if (current === undefined) {
      const answer = readAnswer(fresh)
      if (seenRunning || answer.answered) return finish(answer)
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

// The last assistant text in the session transcript, and whether the agent has
// answered at all. Page content is untrusted by construction; callers render it
// through the untrusted envelope, never as instructions.
function readAnswer(messages: readonly unknown[]): { answered: boolean; text: string; error?: string } {
  const last = messages.filter(isAssistantMessage).at(-1)
  if (last === undefined) return { answered: false, text: "" }
  const error = messageError(last)
  return { answered: true, text: messageText(last), ...(error === undefined ? {} : { error }) }
}

function isAssistantMessage(message: unknown): message is { info: { role: string; error?: unknown }; parts?: unknown } {
  if (typeof message !== "object" || message === null) return false
  const info = (message as { info?: unknown }).info
  return typeof info === "object" && info !== null && (info as { role?: unknown }).role === "assistant"
}

function messageError(message: { info: { error?: unknown } }): string | undefined {
  const error = message.info.error
  if (typeof error !== "object" || error === null) return undefined
  const data = (error as { data?: unknown }).data
  if (typeof data === "object" && data !== null) {
    const detail = (data as { message?: unknown }).message
    if (typeof detail === "string" && detail.length > 0) return detail
  }
  const name = (error as { name?: unknown }).name
  return typeof name === "string" && name.length > 0 ? name : "The session reported an error."
}

function messageText(message: { parts?: unknown }): string {
  const parts = message.parts
  if (!Array.isArray(parts)) return ""
  return (
    parts
      .flatMap((part) => {
        if (typeof part !== "object" || part === null) return []
        if ((part as { type?: unknown }).type !== "text") return []
        const text = (part as { text?: unknown }).text
        return typeof text === "string" && text.trim().length > 0 ? [text.trim()] : []
      })
      .at(-1) ?? ""
  )
}
