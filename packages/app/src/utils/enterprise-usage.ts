// One assistant turn -> one usage event for the organization's control plane.
//
// The renderer is the only place that sees a finished turn with its token
// counts, so this is where the report starts. Everything durable happens in the
// main process (dedupe by message id, disk outbox, retry), which is why calling
// this for an event we have already seen is harmless.
//
// Outside a managed build there is no bridge and this is inert: the public app
// reports nothing to anybody.

import type { EnterpriseUsageEvent } from "@/context/platform"

type UsageBridge = { reportUsage(event: EnterpriseUsageEvent): Promise<unknown> }

function bridge(): UsageBridge | undefined {
  if (typeof window === "undefined") return undefined
  const enterprise = (window as unknown as { api?: { auth?: { enterprise?: Partial<UsageBridge> } } }).api?.auth
    ?.enterprise
  const reportUsage = enterprise?.reportUsage
  return typeof reportUsage === "function" ? { reportUsage } : undefined
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

/**
 * The cached-read and cached-write tokens are input the provider charged for, and
 * reasoning tokens are output it generated, so each is folded into the side of
 * the ledger it belongs to rather than dropped.
 */
export function reportAssistantUsage(message: unknown): void {
  if (!record(message) || message.role !== "assistant") return
  const completed = record(message.time) ? num(message.time.completed) : undefined
  if (completed === undefined) return
  const report = bridge()
  if (report === undefined) return
  const id = text(message.id)
  const model = text(message.modelID)
  if (id === undefined || model === undefined) return
  const tokens = record(message.tokens) ? message.tokens : undefined
  const cache = tokens !== undefined && record(tokens.cache) ? tokens.cache : undefined
  const input = (num(tokens?.input) ?? 0) + (num(cache?.read) ?? 0) + (num(cache?.write) ?? 0)
  const output = (num(tokens?.output) ?? 0) + (num(tokens?.reasoning) ?? 0)
  const created = record(message.time) ? num(message.time.created) : undefined
  void report
    .reportUsage({
      key: id,
      model,
      ...(text(message.providerID) === undefined ? {} : { provider: text(message.providerID)! }),
      inputTokens: input,
      outputTokens: output,
      ...(num(message.cost) === undefined ? {} : { costUsd: num(message.cost)! }),
      ...(created === undefined ? {} : { durationMs: Math.max(0, Math.round(completed - created)) }),
      ...(text(message.sessionID) === undefined ? {} : { sessionId: text(message.sessionID)! }),
    })
    .catch(() => undefined)
}
