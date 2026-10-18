// The bridge from a chat message to a real agent turn. It reuses the headless
// run that /v1/runs uses, and it gives each conversation - a Discord channel,
// DM or thread - one session that later messages continue.
//
// Commands are answered here rather than by the agent: /new, /session and
// /resume are conversation management, and spending a model turn on them would
// be slow and billable for no answer.

import {
  listModels,
  listSessions,
  openCodeRunnerFromEnv,
  type ModelSummary,
  type OpenCodeRunnerConfig,
  type SessionSummary,
} from "../agent-run/client"
import { runHeadless, type HeadlessRunInput } from "../agent-run/runner"
import { readAttachments, type ChatFiles } from "./attachments"
import type { AgentRunner, ChatMessage, ChatTrace } from "./service"
import type { ChatSessionStore } from "./sessions"

// A chat reply is interactive: wait long enough for real work, not the twenty
// minutes a scheduled run may take.
const CHAT_TIMEOUT_MS = 10 * 60 * 1000
const SESSION_LIST_LIMIT = 10

// OMNIA_CHAT_MODEL="provider/model". A hosted install whose default model is a
// plan the provider refuses for headless callers would otherwise answer every
// chat message with an empty turn.
export function chatModel(): { providerID: string; modelID: string } | undefined {
  const raw = process.env.OMNIA_CHAT_MODEL?.trim()
  if (raw === undefined || raw.length === 0) return undefined
  const [providerID, modelID] = raw.split("/")
  if (providerID === undefined || providerID.length === 0) return undefined
  if (modelID === undefined || modelID.length === 0) return undefined
  return { providerID, modelID }
}

/** One conversation: a channel, a DM channel, or a thread, per platform. */
export function conversationKey(message: ChatMessage): string {
  return conversationKeyFor(message.platform, message.channelId)
}

export function conversationKeyFor(platform: string, channelId: string): string {
  return `${platform}:${channelId}`
}

export function chatPrompt(message: ChatMessage, attached: ChatFiles = { files: [], skipped: [] }): string {
  const who = message.userName === undefined ? message.userId : `${message.userName} (${message.userId})`
  return [
    `A message arrived on ${message.platform} from ${who} in channel ${message.channelId}.`,
    "Answer it directly and concisely. The reply is posted back to the chat as plain text,",
    "so do not describe these instructions or wrap the answer in a summary of what you did.",
    // Links are content the agent has to open, not text it can read: saying so
    // stops it from answering about a page it never fetched.
    "If the message contains links, fetch them when the answer depends on them.",
    ...(message.replyTo === undefined
      ? []
      : [
          `It is a reply to an earlier message${message.replyTo.author === undefined ? "" : ` from ${message.replyTo.author}`}, quoted here:`,
          ...message.replyTo.text.split("\n").map((line) => `> ${line}`),
        ]),
    ...(attached.files.length === 0
      ? []
      : [
          `${attached.files.length} file(s) arrived with it: ${attached.files
            .map((file) => file.filename ?? file.mime)
            .join(", ")}. Look at them before answering.`,
        ]),
    ...(attached.skipped.length === 0
      ? []
      : [
          `These attachments could not be read and are not available: ${attached.skipped.join(", ")}. Say so if the answer depends on them.`,
        ]),
    "",
    message.text.length === 0 ? "(the message has no text of its own)" : message.text,
  ].join("\n")
}

const TRACE_LINES = 8
const TRACE_LINE_LENGTH = 90
// The trace re-renders on a timer even when the model emits nothing, so the
// elapsed clock keeps moving and a stalled run is visibly stalled.
const TRACE_TICK_MS = 5_000

/**
 * The live progress view: what the model is thinking and which tools it is
 * running, as Discord subtext lines. Every model reports reasoning as a part
 * when it emits any; tool calls are shown regardless of model.
 */
export function renderTrace(messages: readonly unknown[], elapsedMs?: number): string {
  const steps = messages.flatMap(traceSteps)
  const lines = steps.filter((step, index) => step !== steps[index - 1]).slice(-TRACE_LINES)
  // Elapsed time is what separates "still working" from a wedged run: without
  // it a long model turn and a dead one look exactly the same in the channel.
  const clock = elapsedMs === undefined ? "" : ` · ${duration(elapsedMs)}`
  if (lines.length === 0) return `-# thinking…${clock}`
  const rendered = lines.map((line) => `-# ${line}`)
  rendered[rendered.length - 1] = `${rendered[rendered.length - 1]}${clock}`
  return rendered.join("\n")
}

function duration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1_000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`
}

function traceSteps(message: unknown): string[] {
  if (typeof message !== "object" || message === null) return []
  const info = (message as { info?: unknown }).info
  if (typeof info !== "object" || info === null || (info as { role?: unknown }).role !== "assistant") return []
  const parts = (message as { parts?: unknown }).parts
  if (!Array.isArray(parts)) return []
  return parts.flatMap(traceStep)
}

function traceStep(part: unknown): string[] {
  if (typeof part !== "object" || part === null) return []
  const type = (part as { type?: unknown }).type
  if (type === "reasoning") {
    const text = (part as { text?: unknown }).text
    const line = typeof text === "string" ? oneLine(text) : ""
    return line.length === 0 ? [] : [`🧠 ${line}`]
  }
  if (type !== "tool") return []
  const tool = (part as { tool?: unknown }).tool
  const state = (part as { state?: unknown }).state
  const record = typeof state === "object" && state !== null ? (state as Record<string, unknown>) : {}
  const status = record.status
  const icon = status === "error" ? "✗" : status === "completed" ? "✓" : "…"
  const name = typeof tool === "string" && tool.length > 0 ? tool : "tool"
  const title = typeof record.title === "string" && record.title.length > 0 ? record.title : toolDetail(record.input)
  return [`${icon} ${name}${title.length === 0 ? "" : ` · ${truncate(title, TRACE_LINE_LENGTH - name.length - 6)}`}`]
}

function toolDetail(input: unknown): string {
  if (typeof input !== "object" || input === null) return ""
  const record = input as Record<string, unknown>
  for (const key of ["description", "command", "filePath", "path", "pattern", "query", "url"]) {
    const value = record[key]
    if (typeof value === "string" && value.trim().length > 0) return oneLine(value)
  }
  return ""
}

function oneLine(text: string): string {
  return text.split("\n")[0].replace(/\s+/g, " ").trim()
}

function truncate(text: string, length: number): string {
  const line = oneLine(text)
  return line.length > length ? `${line.slice(0, Math.max(length - 1, 8))}…` : line
}

export interface ChatAgentRunnerOptions {
  readonly sessions: ChatSessionStore
  readonly run?: typeof runHeadless
  readonly resolve?: () => OpenCodeRunnerConfig | undefined
  readonly list?: typeof listSessions
  readonly models?: typeof listModels
  readonly model?: () => { providerID: string; modelID: string } | undefined
}

interface ActiveTurn {
  readonly controller: AbortController
}

export function createChatAgentRunner(options: ChatAgentRunnerOptions): AgentRunner {
  const run = options.run ?? runHeadless
  const resolve = options.resolve ?? openCodeRunnerFromEnv
  const list = options.list ?? listSessions
  const find = options.models ?? listModels
  const model = options.model ?? chatModel
  // Turns in flight, per conversation. A platform delivers a message without
  // waiting for the previous answer, so !stop arrives while the turn it means
  // is still running and has to find it here.
  const active = new Map<string, Set<ActiveTurn>>()

  const track = (key: string, turn: ActiveTurn): void => {
    const turns = active.get(key) ?? new Set<ActiveTurn>()
    turns.add(turn)
    active.set(key, turns)
  }

  const untrack = (key: string, turn: ActiveTurn): void => {
    const turns = active.get(key)
    if (turns === undefined) return
    turns.delete(turn)
    if (turns.size === 0) active.delete(key)
  }

  /** Aborting the turn ends the provider request, not just this poll loop. */
  const stop = (key: string): string => {
    const turns = [...(active.get(key) ?? [])]
    if (turns.length === 0) return "Nothing is running in this channel right now."
    turns.forEach((turn) => turn.controller.abort())
    return turns.length === 1
      ? "Stopping the turn running in this channel."
      : `Stopping ${turns.length} turns running in this channel.`
  }

  const request = (
    message: ChatMessage,
    sessionId: string | undefined,
    key: string,
    attached: ChatFiles,
  ): HeadlessRunInput => {
    // A model chosen with /models wins over the environment default: it is this
    // conversation's own answer to "use this one instead".
    const chosen = options.sessions.getModel(key) ?? model()
    return {
      prompt: chatPrompt(message, attached),
      ...(attached.files.length === 0 ? {} : { files: attached.files }),
      timeoutMs: CHAT_TIMEOUT_MS,
      ...(sessionId === undefined
        ? { title: `Chat · ${message.platform} · ${message.channelId}`.slice(0, 120) }
        : { sessionId }),
      ...(chosen === undefined ? {} : { model: chosen }),
    }
  }

  const reply = (result: Awaited<ReturnType<typeof runHeadless>>): string => {
    if (!result.ok) {
      if (result.interrupted === true) return "Stopped."
      if (result.timedOut) return "That took longer than Omnia's chat budget, so the run was stopped."
      return `Omnia could not answer that one right now: ${result.error}`.slice(0, 300)
    }
    const text = result.text.trim()
    return text.length === 0 ? "Omnia finished without a written answer." : text
  }

  return async (message, trace) => {
    const key = conversationKey(message)
    const command = parseCommand(message.text)
    if (command !== undefined)
      return runCommand(command, key, { sessions: options.sessions, resolve, list, find, stop })

    const config = resolve()
    if (config === undefined) {
      return "Omnia is connected, but this control plane has no headless executor configured, so there is no agent to answer with."
    }
    // Downloads happen here, before the turn exists: a file that cannot be
    // read is named in the prompt rather than failing the answer.
    const attached = await readAttachments(message.attachments)
    const bound = options.sessions.get(key)
    const turn: ActiveTurn = { controller: new AbortController() }
    track(key, turn)
    const started = Date.now()
    let latest: readonly unknown[] = []
    // Progress is scaffolding: a platform whose trace edit fails must never
    // fail the answer.
    const publish = (messages: readonly unknown[] = latest) => {
      latest = messages
      if (trace === undefined) return
      try {
        trace.update(renderTrace(messages, Date.now() - started))
      } catch {
        // ignored on purpose
      }
    }
    const onProgress = trace === undefined ? undefined : publish
    const ticker = trace === undefined ? undefined : setInterval(() => publish(), TRACE_TICK_MS)

    const live = {
      signal: turn.controller.signal,
      ...(onProgress === undefined ? {} : { onProgress }),
    }
    let result: Awaited<ReturnType<typeof runHeadless>>
    try {
      result = await run(config, { ...request(message, bound, key, attached), ...live })
    } catch (error) {
      // A bound session that was deleted or archived answers 404. The binding is
      // stale, not the channel: forget it and open a fresh session once.
      if (bound !== undefined && isMissingSession(error)) {
        options.sessions.clear(key)
        const retry = await run(config, { ...request(message, undefined, key, attached), ...live })
        if (retry.ok) options.sessions.bind(key, retry.sessionId)
        return reply(retry)
      }
      return `Omnia could not answer that one right now: ${error instanceof Error ? error.message : String(error)}`.slice(
        0,
        300,
      )
    } finally {
      if (ticker !== undefined) clearInterval(ticker)
      untrack(key, turn)
    }
    // An interrupted turn still has a session worth continuing: the next
    // message resumes there rather than starting over from nothing.
    if (result.ok || result.interrupted === true) options.sessions.bind(key, result.sessionId)
    return reply(result)
  }
}

const HELP = [
  "/stop — interrupt the turn running in this channel (!stop also works)",
  "/new — start a fresh session in this channel",
  "/session — show which session this channel continues",
  "/sessions — list the most recent sessions",
  "/resume <id> — continue an existing session here",
  "!model — list models, or switch this channel's model (/models also works)",
  "!model search <text> [--free|--paid] — find models by id or name",
].join("\n")

const MODEL_LIST_LIMIT = 20
const MODEL_SEARCH_LIMIT = 25

interface Command {
  readonly name: string
  readonly argument?: string
}

function parseCommand(text: string): Command | undefined {
  const trimmed = text.trim()
  // Discord's composer treats a leading slash as its own command picker, so a
  // command can also be typed as !models when that gets in the way.
  if (!trimmed.startsWith("/") && !trimmed.startsWith("!")) return undefined
  const [head, ...rest] = trimmed.split(/\s+/)
  const name = head?.slice(1).toLowerCase()
  // "/etc/passwd is broken" is a message, not a command.
  if (name === undefined || !/^[a-z][a-z-]*$/.test(name)) return undefined
  const argument = rest.join(" ").trim()
  return { name, ...(argument.length === 0 ? {} : { argument }) }
}

async function runCommand(
  command: Command,
  key: string,
  tools: {
    sessions: ChatSessionStore
    resolve: () => OpenCodeRunnerConfig | undefined
    list: typeof listSessions
    find: typeof listModels
    stop: (key: string) => string
  },
): Promise<string> {
  if (command.name === "help") return HELP
  // Stopping is conversation state too: it must answer while another turn in
  // this channel is still running, which is exactly when a model turn would not.
  if (command.name === "stop" || command.name === "abort" || command.name === "cancel") return tools.stop(key)
  // Switching models is conversation state, not a question: answering it spends
  // no turn and takes effect on the next message.
  if (command.name === "models" || command.name === "model") return runModels(command, key, tools)
  if (command.name === "new") {
    tools.sessions.clear(key)
    return "Started a fresh session: the next message begins with no earlier context."
  }
  if (command.name === "session") {
    const bound = tools.sessions.get(key)
    return bound === undefined
      ? "This channel has no session yet; the next message starts one."
      : `This channel continues session ${bound}.`
  }
  if (command.name !== "sessions" && command.name !== "resume") {
    return `Unknown command /${command.name}.\n${HELP}`
  }

  const config = tools.resolve()
  if (config === undefined)
    return "This control plane has no headless executor configured, so there are no sessions to list."

  if (command.argument === undefined) {
    const listed = await tools.list(config).catch(() => [] as SessionSummary[])
    if (listed.length === 0) return "No sessions yet: the next message starts one."
    return [
      "Recent sessions:",
      ...listed.slice(0, SESSION_LIST_LIMIT).map((session) => `${session.id} — ${session.title ?? "untitled"}`),
      "",
      "Use /resume <id> to continue one here.",
    ].join("\n")
  }

  const wanted = command.argument.trim()
  const listed = await tools.list(config).catch(() => [] as SessionSummary[])
  if (!listed.some((session) => session.id === wanted)) {
    return `No session ${wanted} on this server. /sessions lists the recent ones.`
  }
  tools.sessions.bind(key, wanted)
  return `This channel now continues session ${wanted}.`
}

/**
 * `/models` lists what the server offers and which one this channel uses;
 * `/models 3`, `/models provider/model` switch, `/models default` goes back to
 * the server's own choice.
 */
async function runModels(
  command: Command,
  key: string,
  tools: {
    sessions: ChatSessionStore
    resolve: () => OpenCodeRunnerConfig | undefined
    find: typeof listModels
  },
): Promise<string> {
  const config = tools.resolve()
  if (config === undefined)
    return "This control plane has no headless executor configured, so there are no models to offer."
  // Paid models are numbered first and free ones last, and the SAME order is
  // used for /model <n>, so a number means one model.
  const listed = orderModels(await tools.find(config).catch(() => [] as ModelSummary[]))
  if (listed.length === 0) return "The paired opencode server reported no configured models."
  const chosen = tools.sessions.getModel(key)
  const argument = command.argument?.trim().toLowerCase()
  if (argument === undefined || argument === "list" || argument === "ls") return describeModels(listed, chosen)
  // Search runs before the id and index forms: "search" is neither a number nor
  // a model id, and a query may contain words the matcher would otherwise read
  // as an exact id.
  const search = parseModelSearch(command.argument)
  if (search !== undefined) return describeModelSearch(listed, search, chosen)
  if (argument === "default" || argument === "auto" || argument === "reset") {
    return tools.sessions.clearModel(key)
      ? "This channel follows the server's default model again."
      : "No model was chosen here, so this channel already follows the server's default."
  }

  const index = /^\d+$/.test(argument) ? Number(argument) : undefined
  if (index !== undefined) {
    const picked = listed[index - 1]
    if (picked === undefined) return `There is no model ${index}; /models lists ${listed.length}.`
    return choose(tools.sessions, key, picked)
  }

  const matches = listed.filter(
    (model) =>
      `${model.providerID}/${model.modelID}`.toLowerCase() === argument || model.modelID.toLowerCase() === argument,
  )
  if (matches.length === 0) return `No model matches "${command.argument}". /models lists what this server offers.`
  if (matches.length > 1) {
    const providers = [...new Set(matches.map((model) => model.providerID))].join(", ")
    return `"${command.argument}" is offered by ${providers}. Use /models provider/model to pick one.`
  }
  return choose(tools.sessions, key, matches[0]!)
}

function choose(sessions: ChatSessionStore, key: string, model: ModelSummary): string {
  sessions.setModel(key, { providerID: model.providerID, modelID: model.modelID })
  const warning =
    model.free === true
      ? " Free models are rate-limited: a busy moment can throttle or refuse the turn. !model default goes back to the server default."
      : ""
  return `This channel now answers with ${label(model)}${marker(model)}. The next message uses it.${warning}`
}

/** Paid first, free last: the numbering a reply shows is the numbering a pick uses. */
function orderModels(listed: readonly ModelSummary[]): ModelSummary[] {
  return [...listed.filter((model) => model.free !== true), ...listed.filter((model) => model.free === true)]
}

function describeModels(
  listed: readonly ModelSummary[],
  chosen: { providerID: string; modelID: string } | undefined,
): string {
  const position = (model: ModelSummary) => listed.indexOf(model) + 1
  const line = (model: ModelSummary) => {
    const current = chosen !== undefined && chosen.providerID === model.providerID && chosen.modelID === model.modelID
    return `${position(model)}. ${label(model, current)}${marker(model)}${current ? " ← current" : ""}`
  }
  const paid = listed.filter((model) => model.free !== true)
  const free = listed.filter((model) => model.free === true)
  return [
    `Current model: ${chosen === undefined ? "this server's default" : label(chosen)}`,
    ...paid.slice(0, MODEL_LIST_LIMIT).map(line),
    ...(paid.length > MODEL_LIST_LIMIT
      ? [`…and ${paid.length - MODEL_LIST_LIMIT} more paid models (use !model provider/model).`]
      : []),
    ...(free.length === 0 ? [] : ["", "Free models (rate limited):", ...free.map(line)]),
    "",
    ...(free.length === 0
      ? []
      : ["Free models cost nothing but are throttled when they are busy: a turn can be delayed or refused."]),
    "Switch with !model <number> or !model <provider/model>; !model default goes back to the server default.",
  ].join("\n")
}

interface ModelSearch {
  readonly query: string
  /** Restrict to one price class; absent lists both. */
  readonly filter?: "free" | "paid"
  /** Set when the flags cannot be honoured, explained instead of searched. */
  readonly problem?: string
}

/**
 * `!model search <text> [--free|--paid]`. The query may be quoted so an id with
 * spaces survives, and the flags may come before or after the words. Anything
 * that is not the `search` subcommand is left to the switch and list forms.
 */
function parseModelSearch(argument: string | undefined): ModelSearch | undefined {
  if (argument === undefined) return undefined
  const words = argument.match(/"[^"]*"|'[^']*'|\S+/g) ?? []
  if ((words[0] ?? "").toLowerCase() !== "search") return undefined
  const rest = words.slice(1)
  const flags = rest.filter((word) => word.startsWith("--")).map((word) => word.slice(2).toLowerCase())
  const unknown = flags.find((flag) => flag !== "free" && flag !== "paid")
  if (unknown !== undefined) return { query: "", problem: `Unknown flag --${unknown}. Use --free or --paid.` }
  if (flags.includes("free") && flags.includes("paid")) {
    return { query: "", problem: "Choose one of --free or --paid, not both." }
  }
  const query = rest
    .filter((word) => !word.startsWith("--"))
    .map((word) => word.replace(/^["']|["']$/g, ""))
    .join(" ")
    .trim()
  return {
    query,
    ...(flags.includes("free")
      ? { filter: "free" as const }
      : flags.includes("paid")
        ? { filter: "paid" as const }
        : {}),
  }
}

function describeModelSearch(
  listed: readonly ModelSummary[],
  search: ModelSearch,
  chosen: { providerID: string; modelID: string } | undefined,
): string {
  if (search.problem !== undefined) return search.problem
  const wanted = search.query.toLowerCase()
  const matches = listed.filter((model) => {
    if (search.filter === "free" && model.free !== true) return false
    if (search.filter === "paid" && model.free === true) return false
    if (wanted.length === 0) return true
    const name = model.name?.toLowerCase() ?? ""
    return `${model.providerID}/${model.modelID}`.toLowerCase().includes(wanted) || name.includes(wanted)
  })
  const scope = search.filter === undefined ? "" : `${search.filter} `
  const subject = search.query.length === 0 ? "" : ` matching "${search.query}"`
  if (matches.length === 0) {
    return `No ${scope}model matches${subject}. !model lists everything this server offers.`
  }
  // The number is the position in the same ordered list !model <number> picks
  // from, so a search result can be selected exactly as it is printed.
  const position = (model: ModelSummary) => listed.indexOf(model) + 1
  return [
    `${matches.length} ${scope}model${matches.length === 1 ? "" : "s"}${subject}:`,
    ...matches.slice(0, MODEL_SEARCH_LIMIT).map((model) => {
      const current = chosen !== undefined && chosen.providerID === model.providerID && chosen.modelID === model.modelID
      return `${position(model)}. ${label(model, current)} · ${model.free === true ? "free" : "paid"}${current ? " ← current" : ""}`
    }),
    ...(matches.length > MODEL_SEARCH_LIMIT
      ? [`…and ${matches.length - MODEL_SEARCH_LIMIT} more. Narrow the search.`]
      : []),
    "",
    "Switch with !model <number> or !model <provider/model>.",
  ].join("\n")
}

/**
 * `**id**` is bold in Discord and in Chat's Markdown mode, and Slack's
 * mrkdwn rewrite turns it into `*id*`. Bolding the id -- not the descriptive
 * name -- is what makes the model a channel already answers with stand out in
 * a list of near-identical ids.
 */
function label(model: { providerID: string; modelID: string; name?: string }, bold = false): string {
  const id = `${model.providerID}/${model.modelID}`
  const text = bold ? `**${id}**` : id
  return model.name === undefined ? text : `${text} — ${model.name}`
}

function marker(model: ModelSummary): string {
  return model.free === true ? " · free (rate limited)" : ""
}

function isMissingSession(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error)
  return /HTTP 404/.test(text) || /not found/i.test(text)
}
