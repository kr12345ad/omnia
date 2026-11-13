import { contextWindowPercent, contextWindowTokens, promptTokens } from "@opencode-ai/core/session/usage"
import type { AssistantMessage, Message } from "@opencode-ai/sdk/v2/client"

type Provider = {
  id: string
  name?: string
  models: Record<string, Model | undefined>
}

type Model = {
  name?: string
  limit: {
    context: number
  }
}

type Context = {
  message: AssistantMessage
  provider?: Provider
  model?: Model
  providerLabel: string
  modelLabel: string
  limit: number | undefined
  /**
   * The prompt the last turn sent: uncached input plus cache reads and writes.
   *
   * `tokens.input` is the NON-cached count. On a cached conversation it is the
   * small delta while the cache is most of the prompt, so reading it alone made
   * the context counter under-report exactly when caching was working.
   */
  input: number
  /** The cache read/write tokens already inside `input`. */
  cached: number
  output: number
  reasoning: number
  /** What the conversation occupies now: the prompt plus the turn's output. */
  total: number
  usage: number | null
}

const lastAssistantWithTokens = (messages: Message[]) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== "assistant") continue
    if (contextWindowTokens(msg.tokens) <= 0) continue
    return msg
  }
}

const build = (messages: Message[] = [], providers: Provider[] = []): Context | undefined => {
  const message = lastAssistantWithTokens(messages)
  if (!message) return undefined

  const provider = providers.find((item) => item.id === message.providerID)
  const model = provider?.models[message.modelID]
  const limit = model?.limit.context
  const input = promptTokens(message.tokens)
  const total = contextWindowTokens(message.tokens)

  return {
    message,
    provider,
    model,
    providerLabel: provider?.name ?? message.providerID,
    modelLabel: model?.name ?? message.modelID,
    limit,
    input,
    cached: message.tokens.cache.read + message.tokens.cache.write,
    output: message.tokens.output,
    reasoning: message.tokens.reasoning,
    total,
    usage: contextWindowPercent(message.tokens, limit) ?? null,
  }
}

export function getSessionContext(messages: Message[] = [], providers: Provider[] = []) {
  return build(messages, providers)
}

type LivePart = {
  type: string
  text?: unknown
  state?: unknown
}

const visibleCharacters = (parts: readonly LivePart[] | undefined, tool = true) => {
  let characters = 0
  for (const part of parts ?? []) {
    if (part.type !== "reasoning" && typeof part.text === "string") characters += part.text.length
    if (!tool) continue
    // Tool results are part of the next prompt. Reading the already-built
    // output string is cheap; serializing the input on every delta is not.
    if (typeof part.state !== "object" || part.state === null) continue
    if ("output" in part.state && typeof part.state.output === "string") characters += part.state.output.length
  }
  return characters
}

/**
 * The token meter should move while a turn is still streaming, not only when
 * its usage arrives. A multi-step turn reports tokens at each step finish but
 * keeps streaming into the same assistant message, so counting only messages
 * *after* the token-bearing one froze the readout for most of a turn.
 *
 * The estimate is deliberately coarse (about four visible characters per
 * token). It adds only content the last report cannot already include: the
 * current assistant message's text beyond its reported output, and messages
 * that arrived after it. A whole-conversation maximum barely moves on a long
 * conversation, because the reported window is already most of the estimate.
 */
export function getLiveSessionContext(
  messages: Message[] = [],
  parts: Record<string, readonly LivePart[] | undefined> = {},
  providers: Provider[] = [],
  working = false,
) {
  const current = build(messages, providers)
  if (!current) {
    if (!working) return undefined
    // The first turn has no usage report yet. Show a coarse count from the
    // visible prompt so the meter exists from the first streamed character;
    // the first provider report replaces it.
    const characters = messages.reduce(
      (total, message) => total + visibleCharacters(parts[message.id]),
      0,
    )
    if (characters === 0) return undefined
    return { total: Math.ceil(characters / 4), usage: null }
  }
  if (!working) return current
  const index = messages.findIndex((message) => message.id === current.message.id)
  if (index < 0) return current

  // Text in the token-bearing message may already be inside `output`; count
  // only the overflow so each streamed delta can move the meter. Reasoning is
  // not fed back into the next prompt, so it is excluded.
  const streaming = Math.max(
    0,
    Math.ceil(visibleCharacters(parts[current.message.id], false) / 4) - current.output,
  )
  // Messages after the reported turn are new context in full.
  const pending = messages
    .slice(index + 1)
    .reduce((characters, message) => characters + visibleCharacters(parts[message.id]), 0)
  const total = current.total + streaming + Math.ceil(pending / 4)
  if (total <= current.total) return current

  return {
    ...current,
    total,
    usage:
      current.limit === undefined || current.limit <= 0
        ? current.usage
        : Math.min(100, Math.max(0, Math.round((total / current.limit) * 100))),
  }
}
