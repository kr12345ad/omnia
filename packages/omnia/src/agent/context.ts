import type { ContextEntry, ContextRole, Environment, Sensitivity } from "./contracts"
import { deepFreeze } from "./events"

export interface ContextCompactionOptions {
  readonly maxTokens: number
  readonly environment?: Environment
  readonly now?: number
  readonly keepRecent?: number
  readonly importanceThreshold?: number
  readonly includeSensitive?: boolean
}

export interface CompactContextResult {
  readonly entries: readonly ContextEntry[]
  readonly summary?: ContextEntry
  readonly environment?: ContextEntry
  readonly estimatedTokens: number
  readonly compacted: number
}

export function estimateTokens(text: string): number {
  return text.length === 0 ? 0 : Math.ceil(Array.from(text).length / 4)
}

export function buildEnvironmentContext(environment: Environment, now = Date.now()): ContextEntry {
  const variables = Object.keys(environment.variables ?? {})
    .toSorted()
    .filter((key) => !/TOKEN|SECRET|PASSWORD|PRIVATE|CREDENTIAL|KEY|AUTH/i.test(key))
    .map((key) => `${key}=${environment.variables?.[key] ?? ""}`)
  const text = [
    `cwd=${environment.cwd}`,
    `platform=${environment.platform}`,
    `shell=${environment.shell ?? "unknown"}`,
    `ci=${environment.ci ? "true" : "false"}`,
    ...(environment.os === undefined ? [] : [`os=${environment.os}`]),
    ...(environment.locale === undefined ? [] : [`locale=${environment.locale}`]),
    ...(environment.timezone === undefined ? [] : [`timezone=${environment.timezone}`]),
    ...(environment.remote === undefined ? [] : [`remote=${environment.remote ? "true" : "false"}`]),
    ...(environment.capabilities === undefined
      ? []
      : [
          `capabilities=${Object.entries(environment.capabilities)
            .toSorted(([left], [right]) => left.localeCompare(right))
            .map(([key, value]) => `${key}:${value}`)
            .join(",")}`,
        ]),
    `tools=${environment.tools.slice().toSorted().join(",") || "none"}`,
    ...(variables.length ? [`variables=${variables.join(" ")}`] : []),
  ].join("\n")
  return deepFreeze({
    id: "environment",
    role: "system" as const satisfies ContextRole,
    text,
    tokens: estimateTokens(text),
    importance: 1,
    createdAt: now,
    sensitivity: "internal" as const satisfies Sensitivity,
  })
}

export function compactContext(
  entries: readonly ContextEntry[],
  options: ContextCompactionOptions,
): CompactContextResult {
  if (!Number.isFinite(options.maxTokens) || options.maxTokens <= 0) {
    throw new RangeError("maxTokens must be a positive finite number")
  }
  const now = options.now ?? Date.now()
  const keepRecent = Math.max(0, Math.floor(options.keepRecent ?? 4))
  const importanceThreshold = options.importanceThreshold ?? 0.75
  const environment = options.environment ? buildEnvironmentContext(options.environment, now) : undefined
  const sanitized = entries
    .map((entry) => sanitizeEntry(entry, options.includeSensitive ?? false))
    .toSorted((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))
  const recent = new Set(sanitized.slice(0, keepRecent).map((entry) => entry.id))
  const prioritized = sanitized
    .map((entry, index) => ({
      entry,
      index,
      protected: recent.has(entry.id) || entry.importance >= importanceThreshold || entry.role === "system",
    }))
    .toSorted(
      (left, right) =>
        Number(right.protected) - Number(left.protected) ||
        right.entry.importance - left.entry.importance ||
        right.entry.createdAt - left.entry.createdAt ||
        left.index - right.index,
    )
  const environmentTokens = environment?.tokens ?? 0
  let budget = Math.max(0, options.maxTokens - environmentTokens)
  const totalTokens = sanitized.reduce((total, item) => total + item.tokens, 0)
  const summaryReserve = totalTokens > budget ? Math.min(32, Math.max(1, Math.floor(budget / 3))) : 0
  let entryBudget = Math.max(0, budget - summaryReserve)
  const selected: ContextEntry[] = []
  const omitted: ContextEntry[] = []
  for (const item of prioritized) {
    if (item.entry.tokens <= entryBudget) {
      selected.push(item.entry)
      entryBudget -= item.entry.tokens
      continue
    }
    omitted.push(item.entry)
  }
  budget += entryBudget
  const summary = createSummary(omitted, now, budget)
  if (summary) budget -= summary.tokens
  const compacted = selected.concat(summary ? [summary] : []).toSorted((left, right) => {
    if (left.id === "environment") return -1
    if (right.id === "environment") return 1
    return left.createdAt - right.createdAt || left.id.localeCompare(right.id)
  })
  const limited = fitEntries(compacted, options.maxTokens, environment)
  const includedSummary = limited.find((entry) => entry.id === "summary")
  const includedEnvironment = limited.find((entry) => entry.id === "environment")
  return deepFreeze({
    entries: limited,
    ...(includedSummary === undefined ? {} : { summary: includedSummary }),
    ...(includedEnvironment === undefined ? {} : { environment: includedEnvironment }),
    estimatedTokens: limited.reduce((total, entry) => total + entry.tokens, 0),
    compacted: omitted.length,
  })
}

export const compact = compactContext
export const compactEnvironmentContext = compactContext

function sanitizeEntry(entry: ContextEntry, includeSensitive: boolean): ContextEntry {
  if (entry.sensitivity === "secret") {
    return deepFreeze({ ...entry, text: "[secret omitted]", tokens: estimateTokens("[secret omitted]") })
  }
  if (entry.sensitivity === "sensitive" && !includeSensitive) {
    return deepFreeze({ ...entry, text: "[sensitive omitted]", tokens: estimateTokens("[sensitive omitted]") })
  }
  return deepFreeze({ ...entry, tokens: Math.max(entry.tokens, estimateTokens(entry.text)) })
}

function createSummary(omitted: readonly ContextEntry[], now: number, budget: number): ContextEntry | undefined {
  if (omitted.length === 0 || budget <= 0) return undefined
  const text = `Compacted ${omitted.length} earlier context entries. ${omitted
    .slice(0, 6)
    .map((entry) => `${entry.role}: ${entry.text.slice(0, 160)}`)
    .join(" | ")}`
  const tokens = Math.min(estimateTokens(text), Math.max(1, Math.floor(budget / 3)))
  const summary = deepFreeze({
    id: "summary",
    role: "summary" as const satisfies ContextRole,
    text: truncateText(text, tokens),
    tokens,
    importance: 0.9,
    createdAt: now,
    sensitivity: omitted.some((entry) => entry.sensitivity === "sensitive" || entry.sensitivity === "secret")
      ? ("sensitive" as const satisfies Sensitivity)
      : ("internal" as const satisfies Sensitivity),
  })
  return summary
}

function fitEntries(entries: readonly ContextEntry[], maxTokens: number, environment?: ContextEntry): ContextEntry[] {
  const ordered = (
    environment ? [environment, ...entries.filter((entry) => entry.id !== "environment")] : [...entries]
  ).toSorted((left, right) => priority(left) - priority(right))
  const result: ContextEntry[] = []
  let remaining = maxTokens
  for (const entry of ordered) {
    if (entry.tokens > remaining) {
      const tokens = Math.max(0, remaining)
      if (tokens === 0) continue
      result.push(deepFreeze({ ...entry, text: truncateText(entry.text, tokens), tokens }))
      remaining = 0
      continue
    }
    result.push(entry)
    remaining -= entry.tokens
  }
  return result
}

function priority(entry: ContextEntry): number {
  if (entry.id === "environment") return 0
  if (entry.id === "summary") return 1
  return 2
}

function truncateText(text: string, tokens: number): string {
  if (tokens <= 0) return ""
  if (estimateTokens(text) <= tokens) return text
  const length = Math.max(0, tokens * 4 - 1)
  return `${text.slice(0, length)}…`
}
